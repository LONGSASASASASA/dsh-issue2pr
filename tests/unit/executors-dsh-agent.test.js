// tests/unit/executors-dsh-agent.test.js — DSH 原生智能体执行器：驱动/归一/失败分类/超时/服务缺失
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import executor from "../../lib/delegate/executors/dsh-agent.js";

// 构造 fake 宿主：agents.create 返回可控 fake agent（事件由用例注入，whenIdle 即时静默；
// hangAfterFollowup=true 时 followup 之后的 whenIdle 悬挂，直到 cancel 放行闸门——模拟超时取消）
function fakeHost({ events = [], createError = null, hangAfterFollowup = false, cancelReleases = true, driveError = null, onDispose = () => {} } = {}) {
    const disposals = [], creations = [];
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
        whenIdle: async () => { if (followed && driveError) throw driveError; if (hangAfterFollowup && followed) await gate; },
    };
    const scripted = [];
    const hostCtx = {
        get: (key) => {
            if (key === "agents") return { create: async (options) => {
                creations.push(options);
                if (createError) throw createError;
                return { agent, dispose: async () => { onDispose(); disposals.push("dispose"); } };
            } };
            if (key === "loader") return { await: async () => {} };
            if (key === "agentDefaultModel") return { currentSelection: () => ({ provider: "zai-coding-cn", model: "glm-5.2" }) };
            if (key === "sessions") return { flush: async () => {} };
            return undefined;
        },
    };
    return { hostCtx, agent, scripted, disposals, creations };
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

test("run：DSH 智能体采用任务快照，阶段模型覆盖优先于默认快照", async () => {
    const host = fakeHost(); host.scripted.push(...completedEvents("done"));
    const rcx = { hostCtx: host.hostCtx, run: { executionConfig: { defaultRoute: { provider: "saved", model: "snapshot" } } } };
    await executor.run({ rcx, repoDir: "r", runDir: "snapshot-run", prompt: "p", timeoutMs: 1000 });
    assert.deepEqual(host.creations[0].agentOptions, { provider: "saved", model: "snapshot" });
    rcx.stageCfgOf = () => ({ provider: "stage", model: "override" });
    await executor.run({ rcx, repoDir: "r", runDir: "override-run", prompt: "p", timeoutMs: 1000 });
    assert.deepEqual(host.creations[1].agentOptions, { provider: "stage", model: "override" });
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

test("DSH 原生留档：仅采集 firstSeq 后事件，未知字段和全部消息内容在 dispose 前完整保存", async () => {
    const root = mkdtempSync(join(tmpdir(), "i2p-dsh-json-"));
    const timelinePath = join(root, "external-exec.timeline.log"), messagesPath = join(root, "external-exec.messages.jsonl");
    const previous = { seq: 1, type: "assistant/message", data: { message: { content: [{ type: "text", text: "上次执行" }] } } };
    const host = fakeHost({ events: [previous], onDispose: () => {
        assert.ok(existsSync(messagesPath), "dispose 前已经保存，宿主回收事件也不丢失");
        host.agent.session.events.length = 0;
    } });
    const current = { seq: 12, time: 1700000000012, type: "assistant/message", extra: { all: [1, null, true] }, data: { message: { id: "native-message", usage: { input: 50 }, content: [
        { type: "reasoning", text: "完整思考正文" }, { type: "text", text: "完整正文".repeat(300) },
    ] }, custom: "unknown kept" } };
    host.scripted.push(current, { seq: 13, type: "turn/end", data: { reason: { kind: "completed" } } });
    const out = await executor.run({ rcx: { hostCtx: host.hostCtx }, repoDir: root, runDir: root, prompt: "p", timeoutMs: 1000, timelinePath });
    assert.equal(out.failure, null);
    const saved = readFileSync(messagesPath, "utf8").trim().split("\n").map(JSON.parse);
    assert.equal(saved.length, 3); assert.ok(!saved.some((e) => e.seq === 1));
    assert.deepEqual(saved.find((e) => e.seq === 12), current);
    const events = readFileSync(join(root, "external-exec.events.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
    const blocks = events.filter((e) => ["think", "text"].includes(e.kind));
    assert.equal(blocks.length, 2); assert.deepEqual(blocks[0].source, blocks[1].source);
    assert.equal(blocks[0].at, new Date(current.time).toISOString(), "展示原生事件发生时间，而非事后采集时间");
    assert.deepEqual(blocks.map((e) => e.blockIndex), [0, 1]);
    assert.ok(events.filter((e) => e.source).every((e) => e.executor === "dsh-agent" && e.origin === "agent"));
});

test("DSH 超时和驱动异常仍保存已发生的原生事件，随后正常回收", async () => {
    for (const options of [{ hangAfterFollowup: true, cancelReleases: false }, { driveError: new Error("驱动中断") }]) {
        const root = mkdtempSync(join(tmpdir(), "i2p-dsh-json-error-")), host = fakeHost(options);
        const native = { seq: 11, type: "tool/call", data: { callId: "call-native", name: "Read", arguments: '{"path":"actual-file"}', untouched: true } };
        host.scripted.push(native);
        const out = await executor.run({ rcx: { hostCtx: host.hostCtx }, repoDir: root, runDir: root, prompt: "p", timeoutMs: 30, timelinePath: join(root, "external-exec.timeline.log") });
        assert.equal(out.failure.kind, options.driveError ? "spawn" : "timeout");
        const saved = readFileSync(join(root, "external-exec.messages.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
        assert.deepEqual(saved.find((e) => e.seq === 11), native);
        assert.deepEqual(host.disposals, ["dispose"]);
    }
});

test("DSH 注入结果没有原生 events 时明确未采集，不把归一 Outcome 伪装成原始消息", async () => {
    const root = mkdtempSync(join(tmpdir(), "i2p-dsh-no-json-"));
    const out = await executor.run({
        rcx: { spawnExternal: async () => ({ code: 0, resultText: "仅有归一结果", toolCalls: ["Read"] }) },
        repoDir: root, runDir: root, prompt: "p", timeoutMs: 1000, timelinePath: join(root, "external-exec.timeline.log"),
    });
    assert.equal(out.failure, null);
    assert.equal(existsSync(join(root, "external-exec.messages.jsonl")), false);
    const events = readFileSync(join(root, "external-exec.events.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
    assert.ok(events.every((e) => e.source === null && e.origin === "platform"));
    assert.match(events.find((e) => e.kind === "notice").text, /未采集/);
    assert.ok(!events.some((e) => e.kind === "result"), "归一结果只可留在旧摘要，不代表实际原生消息");
});
