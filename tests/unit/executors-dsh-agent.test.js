// tests/unit/executors-dsh-agent.test.js — DSH 原生智能体执行器：驱动/归一/失败分类/超时/服务缺失
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import executor from "../../lib/delegate/executors/dsh-agent.js";
import { readJournal } from "../../lib/infra/journal.js";

// 定位本次执行留下的 journal 目录（dsh-journal-<captureId>），不存在返回 null
function findJournalDir(root) {
    const name = readdirSync(root).find((n) => n.startsWith("dsh-journal-"));
    return name ? join(root, name) : null;
}
// 直接读 journal 分片内的记录（单测侧便利读取；端到端读取走 readJournalRef）
function journalRecords(jdir) {
    const files = readdirSync(jdir).filter((n) => /^shard-\d{6}\.jsonl$/.test(n)).sort();
    return files.flatMap((f) => readFileSync(join(jdir, f), "utf8").split("\n").filter(Boolean).map(JSON.parse));
}

// 构造 fake 宿主：agents.create 返回可控 fake agent（事件由用例注入，whenIdle 即时静默；
// hangAfterFollowup=true 时 followup 之后的 whenIdle 悬挂，直到 cancel 放行闸门——模拟超时取消；
// hangBeforeFollowup=true 时初始 whenIdle 永悬挂并在悬挂前写入事件——模拟初始静默期宿主
// 已产生事件但 setup 永不完成；onCancel 在超时取消时刻回调，用于窥探执行中留档状态）
function fakeHost({ events = [], createError = null, hangAfterFollowup = false, hangBeforeFollowup = false, cancelReleases = true, driveError = null, onDispose = () => {}, onCancel = () => {} } = {}) {
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
            onCancel();
            if (cancelReleases) releaseGate();
            if (!events.some((e) => e.type === "turn/end")) events.push({ seq: 99, type: "turn/end", data: { reason: { kind: "aborted" } } });
        },
        whenIdle: async () => {
            if (!followed && hangBeforeFollowup) {
                events.push({ seq: 4, time: 1700000000004, type: "assistant/message", data: { message: { content: [{ type: "text", text: "初始静默期已观察到的输出" }] } } });
                await new Promise(() => {}); // setup 永不完成，只能等超时取消
            }
            if (followed && driveError) throw driveError;
            if (hangAfterFollowup && followed) await gate;
        },
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

test("run：onCapture 在执行前回写 captureId（TASK-01 身份关联，与 claude-code 同约定）", async () => {
    const { hostCtx, scripted } = fakeHost();
    scripted.push(...completedEvents("完成"));
    const seen = [];
    const out = await executor.run({ rcx: { hostCtx }, repoDir: "C:/repo", runDir: "C:/run", prompt: "p", timeoutMs: 30000,
        onCapture: (id) => seen.push(id) });
    assert.equal(seen.length, 1, "captureId 恰好回写一次");
    assert.match(seen[0], /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, "UUID 形态");
    assert.equal(out.code, 0);
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
    // 补全①：outcome 暴露 journal 目录（runDir 相对、/ 分隔）与封存完整性——失败时贯通 st.errorInfo.logRefs
    assert.match(out.journal.dir, /^dsh-journal-[0-9a-f-]+$/, "journal 目录为 runDir 相对路径");
    assert.equal(out.journal.integrity, "complete");
    assert.ok(existsSync(join(root, out.journal.dir)), "引用的 journal 目录实际存在，不虚构");
    const events = readFileSync(join(root, "external-exec.events.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
    assert.ok(events.every((e) => e.source === null && e.origin === "platform"));
    assert.match(events.find((e) => e.kind === "notice").text, /未采集/);
    assert.ok(!events.some((e) => e.kind === "result"), "归一结果只可留在旧摘要，不代表实际原生消息");
});

// —— 实时采集（修复清单 20260916-001 TASK-09）——

test("实时落盘：执行尚未结束时事件已在 journal 与原始消息文件中，收尾不重复", async () => {
    const root = mkdtempSync(join(tmpdir(), "i2p-dsh-live-"));
    const timelinePath = join(root, "external-exec.timeline.log");
    // 超时时刻（cancel 触发、执行尚未返回）窥探留档：此刻事件必须已经落盘
    let midRunJournal = null, midRunMessages = null;
    const host = fakeHost({ hangAfterFollowup: true, cancelReleases: true, onCancel: () => {
        const jdir = findJournalDir(root);
        midRunJournal = jdir ? { state: readJournal(jdir), records: journalRecords(jdir) } : null;
        const messagesPath = join(root, "external-exec.messages.jsonl");
        midRunMessages = existsSync(messagesPath) ? readFileSync(messagesPath, "utf8").trim().split("\n").map(JSON.parse) : [];
    } });
    host.scripted.push({ seq: 11, time: 1700000000011, type: "assistant/message", data: { message: { content: [{ type: "text", text: "执行中的输出" }] } } });
    const out = await executor.run({ rcx: { hostCtx: host.hostCtx }, repoDir: root, runDir: root, prompt: "任务包正文", timeoutMs: 600, timelinePath });
    assert.equal(out.failure.kind, "timeout");
    // 执行尚未结束（run 未返回时）的留档状态：journal 运行中（open），事件已持续落盘
    assert.ok(midRunJournal, "cancel 时刻 journal 已存在");
    assert.equal(midRunJournal.state.status, "open", "执行中 journal 应为运行态");
    const midEvents = midRunJournal.records.filter((r) => r.kind === "native-event");
    assert.ok(midEvents.some((r) => r.seq === 11), "执行未结束事件已实时进 journal（轮询间隔内落盘）");
    assert.ok(midRunMessages.some((e) => e.seq === 11), "执行未结束事件已实时进原始消息文件");
    // 收尾：封存完整、无重复事件（seq 各一次）
    const jdir = findJournalDir(root);
    const finalState = readJournal(jdir);
    assert.equal(finalState.status, "sealed");
    assert.equal(finalState.integrity, "complete");
    const seqs = journalRecords(jdir).filter((r) => r.kind === "native-event").map((r) => r.seq).sort((a, b) => a - b);
    assert.deepEqual(seqs, [...new Set(seqs)], "journal 事件 seq 不得重复");
    const messageSeqs = readFileSync(join(root, "external-exec.messages.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l).seq);
    assert.deepEqual(messageSeqs, [...new Set(messageSeqs)], "原始消息文件不得重复（finally 不重写已保存事件）");
    // 结束状态记录存在且如实反映超时
    const outcome = journalRecords(jdir).find((r) => r.kind === "outcome");
    assert.equal(outcome.timeout, true);
    assert.equal(outcome.code, 1);
});

test("正常结束：journal 事件与 session 一一对应，请求快照/模型配置/不可观测标记齐全", async () => {
    const root = mkdtempSync(join(tmpdir(), "i2p-dsh-normal-"));
    const timelinePath = join(root, "external-exec.timeline.log");
    const host = fakeHost();
    host.scripted.push(...completedEvents("正常完成", ["write"]));
    const rcx = { hostCtx: host.hostCtx, run: { id: "run-20260916-x", stages: { P6: { stageExecutionId: "P6-20260916-120000-abcdef012345" } } } };
    const out = await executor.run({ rcx, repoDir: root, runDir: root, prompt: "完整任务包正文", timeoutMs: 1000, timelinePath });
    assert.equal(out.failure, null);
    const jdir = findJournalDir(root);
    const state = readJournal(jdir);
    assert.equal(state.integrity, "complete");
    // 身份：manifest.meta 关联 captureId 与本轮阶段执行（runId/stage/stageExecutionId）
    assert.equal(state.manifest.meta.executor, "dsh-agent");
    assert.equal(state.manifest.meta.runId, "run-20260916-x");
    assert.equal(state.manifest.meta.stage, "P6");
    assert.equal(state.manifest.meta.stageExecutionId, "P6-20260916-120000-abcdef012345");
    assert.match(state.manifest.meta.captureId, /^[0-9a-f-]{36}$/);
    const records = journalRecords(jdir);
    // 请求快照：任务包全文 + 工作目录 + 超时
    const request = records.find((r) => r.kind === "request");
    assert.equal(request.prompt, "完整任务包正文");
    assert.equal(request.repoDir, root);
    assert.equal(request.timeoutMs, 1000);
    // 模型配置：实际生效路由与会话身份
    const config = records.find((r) => r.kind === "agent-config");
    assert.equal(config.sessionId, "session-fake-1");
    assert.deepEqual(config.route, { provider: "zai-coding-cn", model: "glm-5.2" });
    // 不可观测内容明确标记，不补造
    const observability = records.find((r) => r.kind === "observability");
    for (const key of ["internal-system-prompt", "context-compaction", "platform-internal-model-retries", "streaming-deltas"])
        assert.ok(observability.unavailable.includes(key), "缺少不可观测标记: " + key);
    // 事件一一对应：本轮 seq（>3）全部保存（fake 的 scripted seq 与 turn/start 撞号时按宿主
    // 唯一 seq 语义断言集合一致，每个 seq 恰好一次）
    const native = records.filter((r) => r.kind === "native-event");
    const expectedSeqs = [...new Set(host.agent.session.events.filter((e) => e.seq > 3).map((e) => e.seq))].sort((a, b) => a - b);
    assert.deepEqual(native.map((r) => r.seq).sort((a, b) => a - b), expectedSeqs);
    const outcome = records.find((r) => r.kind === "outcome");
    assert.equal(outcome.code, 0);
    assert.equal(outcome.timeout, false);
    assert.match(outcome.resultPreview, /正常完成/);
});

test("初始静默等待超时：已观察到的事件不再整段丢弃（firstSeq 边界修复）", async () => {
    const root = mkdtempSync(join(tmpdir(), "i2p-dsh-initial-"));
    const timelinePath = join(root, "external-exec.timeline.log");
    // 初始 whenIdle 永悬挂：旧实现 firstSeq 未赋值 → finally 整段采集被跳过；实时采集后边界取
    // create 时刻 seq，初始静默期宿主已暴露的事件（seq=4）照常留档
    const host = fakeHost({ hangBeforeFollowup: true });
    const out = await executor.run({ rcx: { hostCtx: host.hostCtx }, repoDir: root, runDir: root, prompt: "p", timeoutMs: 80, timelinePath });
    assert.equal(out.failure.kind, "timeout");
    const jdir = findJournalDir(root);
    assert.ok(jdir, "超时也留下 journal");
    const records = journalRecords(jdir);
    const native = records.filter((r) => r.kind === "native-event");
    // seq=4 是初始静默期已观察到的事件（旧实现整段丢弃）；seq=99 是超时取消后宿主写入的
    // aborted turn/end——实时采集同样保留。两者都必须留档且无重复。
    const seqs = native.map((r) => r.seq).sort((a, b) => a - b);
    assert.deepEqual(seqs, [...new Set(seqs)], "事件 seq 不得重复");
    assert.ok(seqs.includes(4), "初始静默期已观察到的事件必须保留，不得整段丢弃");
    const observed = native.find((r) => r.seq === 4);
    assert.equal(observed.event.data.message.content[0].text, "初始静默期已观察到的输出");
    assert.equal(readJournal(jdir).integrity, "complete");
    const messages = readFileSync(join(root, "external-exec.messages.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
    assert.ok(messages.some((e) => e.seq === 4), "原始消息文件同样保留该事件");
    // 旧执行边界仍有效：seq=1 的历史事件不混入
    assert.ok(!messages.some((e) => e.seq === 1));
});

test("journal 建立失败不阻断执行：智能体照常运行，原始消息留档通道不受影响", async () => {
    const root = mkdtempSync(join(tmpdir(), "i2p-dsh-nojournal-"));
    const timelinePath = join(root, "external-exec.timeline.log");
    // 预占 journal 目录（manifest 损坏）→ createJournal 抛错 → run() 放弃 journal 通道
    const jdir = join(root, "dsh-journal-blocked");
    mkdirSync(jdir, { recursive: true });
    writeFileSync(join(jdir, "manifest.json"), "{ 损坏");
    const host = fakeHost();
    host.scripted.push(...completedEvents("照常完成"));
    const out = await executor.run({ rcx: { hostCtx: host.hostCtx }, repoDir: root, runDir: root, prompt: "p", timeoutMs: 1000, timelinePath });
    assert.equal(out.failure, null);
    assert.equal(out.resultText, "照常完成");
    const messages = readFileSync(join(root, "external-exec.messages.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
    assert.ok(messages.length >= 2, "原始消息留档不受 journal 失败影响");
});
