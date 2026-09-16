// lib/delegate/executors/dsh-agent.js — DSH 原生智能体执行器（进程内，零外部依赖）
// 经宿主核心注册表 ctx.agents.create() 起一个带完整工具链（bash/pwsh/fs/editor，宿主全局层）
// 的智能体跑任务包：无外部进程、无外部 CLI 认证（模型走宿主路由，如 zai-coding-cn/glm-5.2），
// 彻底免疫出口 IP 漂移类 403，兼作 claude CLI 不可用时的兜底执行器。
// 驱动范式复刻官方 @deepseek-ai/dsh-headless：loader.await → create → whenIdle → followup →
// whenIdle → sessions.flush → 折叠 session.events 取末条 assistant 文本与 turn 结果。
// 宿主服务经 ctx.get() 惰性获取（不改插件 inject 面，旧宿主缺服务时给出可操作报错而非加载失败）。
import { randomUUID } from "node:crypto";import { appendAgentTimelineLine, dshEventToEntries } from "./agent-timeline.js";
import { agentRecordPaths, createAgentRecordWriter } from "./agent-records.js";
import { createJournal } from "../../infra/journal.js";
import { dirname, join, relative } from "node:path";

import { tmpdir } from "node:os";

export const id = "dsh-agent";
export const label = "DSH 原生智能体";
export const kind = "dsh";
export const DSH_POLL_INTERVAL_MS = 200;

// 实时采集（修复清单 20260916-001 TASK-09）：宿主对原生会话只暴露 session.events 轮询面
// （无流式回调），驱动等待期间以 DSH_POLL_INTERVAL_MS 周期 drain 新事件——执行尚未结束时
// 事件已持续落盘（journal + events.jsonl 同步写）；finally 只补齐最后一批并写结束状态，
// seq 去重保证不重复。宿主未暴露的内容（内部 system prompt、上下文压缩、平台内部模型
// 重试、流式增量）在 journal 的 observability 记录中明确标记 unavailable，不推测不补造。
const UNOBSERVABLE = ["internal-system-prompt", "context-compaction", "platform-internal-model-retries", "streaming-deltas"];

const activeAgents = new Map(); // runDir → { cancel, dispose }

// 零依赖复刻 @deepseek-ai/dsh-llm createUserMessage：运行时为冻结普通对象（id=uuid, role=user）
function userMessage(text) {
    return Object.freeze({
        id: randomUUID(),
        role: "user",
        content: [{ type: "text", text }],
        source: { kind: "user" },
    });
}

// 复刻 dsh-headless summarize：firstSeq 之后的末条非空 assistant 文本 + turn/end 结果 + 工具调用摘要
function summarize(events, firstSeq) {
    let started = false;
    let text = "";
    let reason;
    let turns = 0;
    const toolCalls = [];
    for (const ev of events) {
        if (ev.seq < firstSeq) continue;
        if (ev.type === "turn/start") { started = true; turns += 1; continue; }
        if (!started) continue;
        if (ev.type === "assistant/message") {
            const joined = (ev.data?.message?.content || []).filter((b) => b.type === "text").map((b) => b.text || "").join("");
            if (joined !== "") text = joined;
        }
        if (ev.type === "tool/call" && ev.data?.name) toolCalls.push(String(ev.data.name));
        if (ev.type === "turn/end") reason = ev.data?.reason;
    }
    return { text, reason, turns, toolCalls };
}

function stopAgent(runDir) {
    const entry = activeAgents.get(runDir);
    if (!entry) return false;
    try { entry.cancel(); } catch { /* 已结束 */ }
    return true;
}

async function disposeHandle(handle) {
    try { await handle.dispose(); } catch { /* 尽力回收 */ }
}

async function disposeHandleBounded(handle, timeoutMs) {
    let timer = null;
    try {
        await Promise.race([
            disposeHandle(handle),
            new Promise((resolve) => { timer = setTimeout(resolve, timeoutMs); }),
        ]);
    } finally {
        if (timer) clearTimeout(timer);
    }
}

// 真实驱动路径。返回统一 Outcome：{ code, sessionId, stats, resultText, toolCalls, model, error, timeout, stopReason }
async function runDshAgent({ rcx, repoDir, runDir, prompt, timeoutMs, params, onNativeEvent, journal = null }) {
    const hostCtx = rcx.hostCtx;
    const agents = hostCtx && typeof hostCtx.get === "function" ? hostCtx.get("agents") : null;
    if (!agents || typeof agents.create !== "function") {
        return { code: -1, error: "宿主 agents 服务不可用（本 DSH 版本未提供 ctx.agents；完全重启 DSH 后仍无效请换 claude-code 执行器）" };
    }
    await hostCtx.get("loader")?.await?.(); // 等 agent-loop 注册完 factory，否则 create 报 no factory
    const stageConfig = rcx.stageCfgOf?.();
    const selection = stageConfig?.provider && stageConfig?.model
        ? stageConfig
        : rcx.run?.executionConfig?.defaultRoute || hostCtx.get("agentDefaultModel")?.currentSelection?.() || null;
    let handle;
    try {
        handle = await agents.create({
            sessionId: "session-" + randomUUID(), // SessionId 运行时为恒等函数，普通字符串即可
            meta: { cwd: repoDir },
            ...(selection ? { agentOptions: { provider: selection.provider, model: selection.model } } : {}),
        });
    } catch (e) {
        return { code: -1, error: "宿主智能体创建失败: " + String((e && e.message) || e).slice(0, 300) };
    }
    const agent = handle.agent;
    activeAgents.set(runDir, { cancel: () => agent.cancel({ kind: "parent" }), dispose: () => disposeHandle(handle) });
    const t0 = Date.now();
    let timedOut = false;
    let timer = null;
    // 采集边界：create 时刻的 session.seq——此后宿主暴露的新事件（含初始静默期的 setup 事件）
    // 都属于本轮可观察范围；followup 前的历史属于别的执行，不纳入。初始静默等待超时也能从
    // 这个边界恢复采集，不再出现 firstSeq 未赋值导致整段丢弃（修复清单 TASK-09 评审项）。
    const boundarySeq = Number.isFinite(agent.session?.seq) ? agent.session.seq : -Infinity;
    let lastSavedSeq = boundarySeq;
    let journalDead = false; // journal 写失败后停止再试，留档故障不影响智能体执行
    const iso = (v) => (Number.isFinite(v) ? new Date(v).toISOString() : new Date().toISOString());
    // drain：seq 去重增量采集，同一事件实时喂给 journal 与 records（onNativeEvent），不重复
    const drainEvents = () => {
        const events = agent.session?.events;
        if (!Array.isArray(events)) return;
        for (const event of events) {
            const seq = event?.seq;
            if (!Number.isFinite(seq) || seq <= lastSavedSeq || seq < boundarySeq) continue;
            lastSavedSeq = seq;
            if (journal && !journalDead) {
                try { journal.appendRecord({ kind: "native-event", at: iso(event.time), seq, event }); }
                catch { journalDead = true; /* 留档失败不影响执行与事件回调 */ }
            }
            try { onNativeEvent?.(event); } catch { /* 单条坏事件不阻断其余记录 */ }
        }
    };
    try {
        journal?.appendRecord({ kind: "agent-config", at: new Date().toISOString(),
            sessionId: String(agent.id), route: selection ? { ...selection } : null, cwd: repoDir,
            pollIntervalMs: DSH_POLL_INTERVAL_MS });
    } catch { journalDead = true; }
    // 轮询等待：与 whenIdle/timeout 三方 race，每个 tick drain 一轮——事件在执行期间持续落盘
    const awaitIdleDraining = async () => {
        let idleError = null;
        const idleP = agent.whenIdle().then(() => {}, (e) => { idleError = e; });
        for (;;) {
            let sleepTimer = null;
            const tick = new Promise((resolve) => { sleepTimer = setTimeout(resolve, DSH_POLL_INTERVAL_MS); });
            const winner = await Promise.race([
                idleP.then(() => "idle"),
                timeoutP.then(() => "timeout"),
                tick.then(() => "tick"),
            ]);
            drainEvents();
            if (winner !== "tick") { clearTimeout(sleepTimer); return idleError; }
        }
    };
    const timeoutP = new Promise((resolve) => {
        timer = setTimeout(() => {
            timedOut = true;
            try { agent.cancel({ kind: "parent" }); } catch { /* 已结束 */ }
            resolve();
        }, timeoutMs);
    });
    const timeoutOutcome = () => ({
        code: 1,
        sessionId: String(agent.id),
        stats: { turns: 0, durationMs: Date.now() - t0, result: "" },
        resultText: "",
        toolCalls: [],
        model: selection ? (selection.provider + "/" + selection.model) : "",
        stopReason: "aborted",
        timeout: true,
    });
    try {
        let idleError = await awaitIdleDraining(); // 初始静默（官方范式：followup 前必须等 factory 侧 setup 完成）
        if (idleError) throw idleError;
        if (timedOut) return timeoutOutcome();
        const firstSeq = agent.session.seq; // 归一 summarize 边界（不含 setup 事件），语义与旧实现一致
        agent.followup(userMessage(prompt));
        idleError = await awaitIdleDraining(); // 驱动到静默（turn 完成）
        if (idleError) throw idleError;
        if (timedOut) return timeoutOutcome();
        try { await hostCtx.get("sessions")?.flush?.(agent.session); } catch { /* best-effort 持久化 */ }
        const outcome = summarize(agent.session.events, firstSeq);
        return {
            code: outcome.reason?.kind === "completed" ? 0 : 1,
            sessionId: String(agent.id),
            stats: { turns: outcome.turns, durationMs: Date.now() - t0, result: (outcome.text || "").slice(0, 1000) },
            resultText: outcome.text || "",
            toolCalls: outcome.toolCalls,
            model: selection ? (selection.provider + "/" + selection.model) : "",
            stopReason: outcome.reason?.kind || "",
            ...(timedOut ? { timeout: true } : {}),
        };
    } catch (e) {
        return { code: -1, error: "宿主智能体驱动异常: " + String((e && e.message) || e).slice(0, 300), sessionId: String(agent.id) };
    } finally {
        clearTimeout(timer);
        activeAgents.delete(runDir);
        // 收尾只补齐最后一批（超时/异常路径的关键增量），seq 去重保证不重复写入已实时保存的事件；
        // 不把归一 Outcome 伪装成原始消息。
        drainEvents();
        if (timedOut) await disposeHandleBounded(handle, Math.min(timeoutMs, 1000));
        else await disposeHandle(handle); // 消费者必须 dispose（官方所有权契约）
    }
}

// 失败分类（成功返回 null）：与 claude-code 同一语义集合，p6 阶段层统一消费
function classifyDshFailure(r) {
    if (r.error) return { kind: "spawn", message: r.error, hint: "" };
    if (r.timeout) return { kind: "timeout", message: "超时被终止（智能体已取消回收）", hint: "" };
    if (r.code !== 0) {
        return { kind: "agent", message: "智能体异常结束（" + (r.stopReason || "退出码 " + r.code) + "）" + (r.resultText ? "：" + String(r.resultText).slice(0, 300) : ""), hint: "" };
    }
    return null;
}

function normalizeOutcome(r) {
    return { ...r, failure: classifyDshFailure(r) };
}

// rcx.spawnExternal 仍是测试注入口（返回形态与真实路径一致即可）
async function run(runCtx) {
    const runner = runCtx.rcx.spawnExternal || runDshAgent;
    const records = createAgentRecordWriter({ ...agentRecordPaths(runCtx.logPath || runCtx.timelinePath), executor: id });
    // captureId 先于执行回写（与 claude-code 同约定）：留档身份与本轮 P6 执行在 run.json 关联
    try { runCtx.onCapture?.(records.captureId); } catch { /* 身份回写失败不影响执行 */ }
    records.appendPlatform("init", "收到任务包（session-task.md）· DSH 原生智能体执行");
    // journal 留档（TASK-09）：目录按 captureId 划分（单写者），meta 关联 runId/stage/stageExecutionId。
    // 建立失败不阻断执行（与既有留档约定一致），仅放弃 journal 通道。
    const baseDir = runCtx.timelinePath || runCtx.logPath ? dirname(runCtx.timelinePath || runCtx.logPath) : null;
    let journal = null;
    let journalDirRel = null; // runDir 相对路径（失败时随结构化错误贯通，P10/UI 可回溯）
    if (baseDir) {
        try {
            const journalDir = join(baseDir, "dsh-journal-" + records.captureId);
            journal = createJournal({
                dir: journalDir,
                meta: { executor: id, captureId: records.captureId,
                    runId: runCtx.rcx?.run?.id || null, stage: "P6",
                    stageExecutionId: runCtx.rcx?.run?.stages?.P6?.stageExecutionId || null },
            });
            journalDirRel = relative(runCtx.runDir, journalDir).split(/[\\/]/).join("/");
            // 请求快照：实际发送的任务包全文、工作目录、超时与参数（不可序列化参数如实标记）
            let params;
            try { params = JSON.parse(JSON.stringify(runCtx.params ?? null)); }
            catch { params = { unserializable: true }; }
            journal.appendRecord({ kind: "request", at: new Date().toISOString(),
                prompt: runCtx.prompt, repoDir: runCtx.repoDir, timeoutMs: runCtx.timeoutMs, params });
            journal.appendRecord({ kind: "observability", at: new Date().toISOString(),
                unavailable: UNOBSERVABLE,
                note: "宿主仅暴露 session.events 轮询面；轮询间隔 " + DSH_POLL_INTERVAL_MS + "ms，间隔内新事件延迟落盘" });
        } catch { journal = null; }
    }
    let nativeCount = 0, savedCount = 0;
    let r;
    try {
        r = await runner({ ...runCtx, journal, onNativeEvent: (event) => {
            nativeCount += 1;
            const time = Number.isFinite(event.time) ? new Date(event.time) : null;
            if (records.appendFrame(event, { entries: dshEventToEntries(event),
                ...(time && Number.isFinite(time.valueOf()) ? { at: time.toISOString() } : {}) })) savedCount += 1;
        } });
    } catch (e) {
        r = { code: -1, error: String((e && e.message) || e) };
    }
    // 结束状态与封存：outcome 是摘要（原文在 native-event 记录里）；seal 不抛，两类错误互不覆盖
    let sealedIntegrity = null;
    if (journal) {
        try {
            journal.appendRecord({ kind: "outcome", at: new Date().toISOString(),
                code: r.code ?? null, stopReason: r.stopReason || null, timeout: !!r.timeout,
                error: r.error || null, turns: r.stats?.turns ?? null, durationMs: r.stats?.durationMs ?? null,
                resultPreview: String(r.resultText || "").slice(0, 300),
                nativeEvents: nativeCount, savedFrames: savedCount });
        } catch { /* 尽力 */ }
        try { sealedIntegrity = journal.seal({ status: r.code === 0 ? "completed" : "failed", reason: "executor-run-finished" })?.integrity || null; }
        catch { /* seal 不抛；此处兜底 */ }
    }
    if (runCtx.timelinePath) {
        // 事后时间线：DSH 原生智能体走宿主内会话（无 stdout 流），完成后按结果写一次
        try {
            appendAgentTimelineLine(runCtx.timelinePath, "init", "收到任务包（session-task.md）· DSH 原生智能体执行");
            for (const call of Array.isArray(r.toolCalls) ? r.toolCalls : []) appendAgentTimelineLine(runCtx.timelinePath, "tool", String(call));
            if (r.resultText) appendAgentTimelineLine(runCtx.timelinePath, "result", String(r.resultText));
            appendAgentTimelineLine(runCtx.timelinePath, "exit", "执行结束，退出码 " + (r.code ?? "?"));
        } catch { /* 时间线写失败不影响执行 */ }
    }
    if (!nativeCount) records.appendPlatform("notice", "本次执行未采集到原生会话事件，无法提供原始 JSON");
    else if (savedCount < nativeCount) records.appendPlatform("notice", "部分原生会话事件留存失败，对应原始 JSON 不可用");
    records.appendPlatform("exit", "执行结束，退出码 " + (r.code ?? "?") + (r.timeout ? "（超时回收）" : ""));
    // 补全①：journal 目录与封存完整性随 outcome 暴露（journal 未建立时 dir=null，不虚构）
    return Object.assign(normalizeOutcome(r), { journal: { dir: journalDirRel, integrity: sealedIntegrity } });
}

const executor = { id, label, kind, run, stop: stopAgent };
export default executor;

// —— 测试门禁：智能体服务可用 → 模型路由解析 → 一次极小真实调用（与 P6 执行同一条路径） ——
// 与 claude 门禁同约定：ok=false 也回 200，steps 供 UI 分步展示。
export async function testDshGate({ hostCtx, timeoutMs = 120000 } = {}) {
    const t0 = Date.now();
    const steps = [];
    const fail = (message) => ({ ok: false, executor: id, steps, message, ms: Date.now() - t0 });
    {
        const t1 = Date.now();
        const agents = hostCtx && typeof hostCtx.get === "function" ? hostCtx.get("agents") : null;
        const ok = !!(agents && typeof agents.create === "function");
        steps.push({ name: "智能体服务", ok, detail: ok ? "ctx.agents 可用" : "宿主未提供 ctx.agents——完全重启 DSH 后重试，或改用 claude-code 执行器", ms: Date.now() - t1 });
        if (!ok) return fail(steps[0].detail);
    }
    let selection = null;
    {
        const t1 = Date.now();
        selection = hostCtx.get("agentDefaultModel")?.currentSelection?.() || null;
        const ok = !!selection;
        steps.push({ name: "模型路由", ok, detail: ok ? selection.provider + "/" + selection.model + (selection.reasoningEffort ? " · " + selection.reasoningEffort : "") : "无法解析宿主默认模型路由", ms: Date.now() - t1 });
        if (!ok) return fail("宿主默认模型路由不可用：检查 DSH 的 Models 页 / settings.yaml 的 agent-default-model 及对应 API Key");
    }
    {
        const t1 = Date.now();
        const out = await run({ rcx: { hostCtx }, repoDir: tmpdir(), runDir: tmpdir(), prompt: "Reply with exactly: OK", timeoutMs });
        const ok = !out.failure && /OK/i.test(out.resultText || "");
        steps.push({
            name: "微任务",
            ok,
            detail: ok
                ? "模型回执: " + (out.resultText || "").slice(0, 80) + (out.model ? " · " + out.model : "")
                : ((out.failure && out.failure.message) || out.resultText || "无输出").slice(0, 300),
            ms: Date.now() - t1,
        });
        if (!ok) return fail("DSH 智能体调用未通过: " + steps[steps.length - 1].detail);
        return { ok: true, executor: id, steps, message: "门禁通过（" + (out.model || selection.provider + "/" + selection.model) + " · 真实调用成功）", ms: Date.now() - t0 };
    }
}
