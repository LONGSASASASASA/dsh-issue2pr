// tests/unit/executors-dsh-agent.test.js — DSH 原生智能体执行器：驱动/归一/失败分类/超时/服务缺失
import { test } from "node:test";
import assert from "node:assert/strict";
import executor from "../../lib/delegate/executors/dsh-agent.js";

// 构造 fake 宿主：agents.create 返回可控 fake agent（事件由用例注入，whenIdle 即时静默；
// hangAfterFollowup=true 时 followup 之后的 whenIdle 悬挂，直到 cancel 放行闸门——模拟超时取消）
function fakeHost({ events = [], createError = null, hangAfterFollowup = false, cancelReleases = true } = {}) {
    const disposals = [];
    let followed = false;
    let releaseGate = () => {};
    let gate = Promise.resolve();
    const agent = {
        id: "session-fake-1",
        session: { seq: 3, events },
        followup: () => {
            followed = true;
            if (hangAfterFollowup) gate = new Promise((res) => { releaseGate = res; });
            events.push({ seq: events.length + 10, type: "turn/start", data: {} });
            for (const ev of scripted) events.push(ev);
        },
        cancel: () => {
            if (cancelReleases) releaseGate();
            if (!events.some((e) => e.type === "turn/end")) events.push({ seq: 99, type: "turn/end", data: { reason: { kind: "aborted" } } });
        },
        whenIdle: async () => { if (hangAfterFollowup && followed) await gate; },
    };
    const scripted = [];
    const hostCtx = {
        get: (key) => {
            if (key === "agents") return { create: async () => {
                if (createError) throw createError;
                return { agent, dispose: async () => { disposals.push("dispose"); } };
            } };
            if (key === "loader") return { await: async () => {} };
            if (key === "agentDefaultModel") return { currentSelection: () => ({ provider: "zai-coding-cn", model: "glm-5.2" }) };
            if (key === "sessions") return { flush: async () => {} };
            return undefined;
        },
    };
    return { hostCtx, agent, scripted, disposals };
}

function completedEvents(text, toolNames = []) {
    const evs = [];
    let seq = 10;
    for (const name of toolNames) evs.push({ seq: seq++, type: "tool/call", data: { name } });
    evs.push({ seq: seq++, type: "assistant/message", data: { message: { content: [{ type: "text", text }] } } });
    evs.push({ seq: seq++, type: "turn/end", data: { reason: { kind: "completed" } } });
    return evs;
}

test("run：正常驱动 → code 0/stats/sessionId/工具摘要，failure=null，dispose 必被调用", async () => {
    const { hostCtx, scripted, disposals } = fakeHost();
    scripted.push(...completedEvents("已全部完成", ["write", "bash"]));
    const out = await executor.run({ rcx: { hostCtx }, repoDir: "C:/repo", runDir: "C:/run", prompt: "p", timeoutMs: 30000 });
    assert.equal(out.code, 0);
    assert.equal(out.failure, null);
    assert.equal(out.sessionId, "session-fake-1");
    assert.equal(out.stats.turns, 1);
    assert.equal(out.resultText, "已全部完成");
    assert.deepEqual(out.toolCalls, ["write", "bash"]);
    assert.equal(out.model, "zai-coding-cn/glm-5.2");
    assert.ok(disposals.includes("dispose"), "消费者必须 dispose（官方所有权契约）");
});

test("run：宿主无 agents 服务 / hostCtx 缺失 → 可操作失败（kind=spawn）", async () => {
    const noCtx = await executor.run({ rcx: {}, repoDir: "r", runDir: "rd", prompt: "p", timeoutMs: 1000 });
    assert.equal(noCtx.failure.kind, "spawn");
    assert.match(noCtx.failure.message, /agents 服务不可用/);
    const noAgents = await executor.run({ rcx: { hostCtx: { get: () => undefined } }, repoDir: "r", runDir: "rd", prompt: "p", timeoutMs: 1000 });
    assert.equal(noAgents.failure.kind, "spawn");
});

test("run：create 抛错（如 no factory）→ spawn 失败带原因；turn 非正常结束 → kind=agent", async () => {
    const { hostCtx } = fakeHost({ createError: new Error("no agent factory registered") });
    const createFail = await executor.run({ rcx: { hostCtx }, repoDir: "r", runDir: "rd", prompt: "p", timeoutMs: 1000 });
    assert.equal(createFail.failure.kind, "spawn");
    assert.match(createFail.failure.message, /no agent factory/);

    const bad = fakeHost();
    bad.scripted.push({ seq: 11, type: "assistant/message", data: { message: { content: [{ type: "text", text: "工具被拒" }] } } });
    bad.scripted.push({ seq: 12, type: "turn/end", data: { reason: { kind: "blocked" } } });
    const out = await executor.run({ rcx: { hostCtx: bad.hostCtx }, repoDir: "r", runDir: "rd", prompt: "p", timeoutMs: 1000 });
    assert.equal(out.failure.kind, "agent");
    assert.match(out.failure.message, /blocked/);
    assert.match(out.failure.message, /工具被拒/);
});

test("run：超时 → cancel 放行闸门后判 timeout（不悬挂整个 Run）", async () => {
    const host = fakeHost({ hangAfterFollowup: true });
    const out = await executor.run({ rcx: { hostCtx: host.hostCtx }, repoDir: "r", runDir: "rd", prompt: "p", timeoutMs: 150 });
    assert.equal(out.failure.kind, "timeout");
    assert.match(out.failure.message, /超时/);
});

test("run：超时后 whenIdle 不响应 cancel 也会按时返回", async () => {
    const host = fakeHost({ hangAfterFollowup: true, cancelReleases: false });
    const startedAt = Date.now();
    const out = await executor.run({ rcx: { hostCtx: host.hostCtx }, repoDir: "r", runDir: "rd", prompt: "p", timeoutMs: 50 });

    assert.equal(out.failure.kind, "timeout");
    assert.ok(Date.now() - startedAt < 500, "超时后不应继续等待未完成的 whenIdle");
});

test("run：rcx.spawnExternal 注入口生效（阶段层单测不依赖宿主）", async () => {
    const out = await executor.run({
        rcx: { spawnExternal: async () => ({ code: 0, sessionId: "inj", stats: { turns: 2 }, resultText: "ok", toolCalls: ["write"] }) },
        repoDir: "r", runDir: "rd", prompt: "p", timeoutMs: 1000,
    });
    assert.equal(out.sessionId, "inj");
    assert.equal(out.stats.turns, 2);
    assert.equal(out.failure, null);
});

test("stop：无活跃智能体返回 false（幂等）", () => {
    assert.equal(executor.stop("no-such-rundir"), false);
});
