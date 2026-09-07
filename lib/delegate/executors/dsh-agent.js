// lib/delegate/executors/dsh-agent.js — DSH 原生智能体执行器（进程内，零外部依赖）
// 经宿主核心注册表 ctx.agents.create() 起一个带完整工具链（bash/pwsh/fs/editor，宿主全局层）
// 的智能体跑任务包：无外部进程、无外部 CLI 认证（模型走宿主路由，如 zai-coding-cn/glm-5.2），
// 彻底免疫出口 IP 漂移类 403，兼作 claude CLI 不可用时的兜底执行器。
// 驱动范式复刻官方 @deepseek-ai/dsh-headless：loader.await → create → whenIdle → followup →
// whenIdle → sessions.flush → 折叠 session.events 取末条 assistant 文本与 turn 结果。
// 宿主服务经 ctx.get() 惰性获取（不改插件 inject 面，旧宿主缺服务时给出可操作报错而非加载失败）。
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";

export const id = "dsh-agent";
export const label = "DSH 原生智能体";
export const kind = "dsh";

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
async function runDshAgent({ rcx, repoDir, runDir, prompt, timeoutMs, params }) {
    const hostCtx = rcx.hostCtx;
    const agents = hostCtx && typeof hostCtx.get === "function" ? hostCtx.get("agents") : null;
    if (!agents || typeof agents.create !== "function") {
        return { code: -1, error: "宿主 agents 服务不可用（本 DSH 版本未提供 ctx.agents；完全重启 DSH 后仍无效请换 claude-code 执行器）" };
    }
    await hostCtx.get("loader")?.await?.(); // 等 agent-loop 注册完 factory，否则 create 报 no factory
    const selection = hostCtx.get("agentDefaultModel")?.currentSelection?.() || null;
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
        await Promise.race([agent.whenIdle(), timeoutP]); // 初始静默（官方范式：followup 前必须等 factory 侧 setup 完成）
        if (timedOut) return timeoutOutcome();
        const firstSeq = agent.session.seq;
        agent.followup(userMessage(prompt));
        await Promise.race([agent.whenIdle(), timeoutP]); // 驱动到静默（turn 完成）
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
    let r;
    try {
        r = await runner(runCtx);
    } catch (e) {
        r = { code: -1, error: String((e && e.message) || e) };
    }
    return normalizeOutcome(r);
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
