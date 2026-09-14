// P6 Claude Code 活动快照：计数心跳单独聚合，不改变原始消息或 run.json。
import { mkdirSync, writeFileSync, renameSync, unlinkSync, realpathSync } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { dirname, join, relative, isAbsolute, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

export const AGENT_ACTIVITY_PATH = "06-implementation/external-exec.activity.json";
export const AGENT_ACTIVITY_THRESHOLDS = Object.freeze({ quietMs: 60_000, staleMs: 180_000 });
const MAX_TOOLS = 32, MAX_TASKS = 16, MAX_BYTES = 256 * 1024;
const owners = new Map();
const active = status => ["running", "submitted", "unknown"].includes(status);
const validAt = value => typeof value === "string" && Number.isFinite(Date.parse(value));
const clean = (value, limit = 1000) => typeof value === "string" ? value.slice(0, limit) : "";
const validId = value => typeof value === "string" && value.length > 0 && value.length <= 128;
const contained = (base, path) => {
    const rel = relative(base, path);
    return rel && rel !== ".." && !rel.startsWith("../") && !rel.startsWith("..\\") && !isAbsolute(rel);
};
const resultSummary = value => {
    if (typeof value === "string") return clean(value, 1600);
    if (!Array.isArray(value)) return "";
    let text = "";
    for (const block of value) {
        if (typeof block?.text === "string") text += (text ? "\n" : "") + block.text.slice(0, 1600 - text.length);
        if (text.length >= 1600) break;
    }
    return text;
};
const exitCodeOf = value => {
    const explicit = value?.exit_code ?? value?.exitCode;
    if (Number.isSafeInteger(explicit)) return explicit;
    // 只解析协议通知的退出描述；普通工具输出中的相似文本不当作退出码。
    const match = typeof value?.summary === "string" && /\(exit code (-?\d+)\)\s*$/.exec(value.summary);
    return match && Number.isSafeInteger(Number(match[1])) ? Number(match[1]) : null;
};

export function createAgentActivityWriter({ runDir, captureId, stageStartedAt, now = Date.now, flushMs = 1000 } = {}) {
    const path = runDir ? resolve(runDir, AGENT_ACTIVITY_PATH) : null, owner = Symbol("activity");
    const enabled = path && validId(captureId) && validAt(stageStartedAt);
    const time = () => new Date(now()).toISOString();
    const state = {
        version: 1, status: "available", executor: "claude-code", stageId: "P6", stageStartedAt, captureId,
        startedAt: time(), updatedAt: null, finishedAt: null, phase: "starting",
        lastSignalAt: null, lastSignalKind: null, lastAction: null,
        thinking: { estimatedTokens: null, signals: 0 }, tools: [], backgroundTasks: [],
        thresholds: { ...AGENT_ACTIVITY_THRESHOLDS },
    };
    const tools = new Map(), tasks = new Map();
    let timer = null, dirty = true, disposed = false, finished = false, finalizing = false, failedFlushes = 0;
    const interval = Number.isFinite(Number(flushMs)) ? Math.max(1, Number(flushMs) || 1000) : 1000;
    if (enabled) owners.set(path, owner);
    const snapshot = () => JSON.parse(JSON.stringify({ ...state, tools: [...tools.values()], backgroundTasks: [...tasks.values()] }));
    const schedule = (delay = interval) => {
        if (timer || !enabled || disposed || finalizing || !dirty || owners.get(path) !== owner) return;
        timer = setTimeout(flush, delay);
        timer.unref?.();
    };
    const flush = () => {
        if (timer) { clearTimeout(timer); timer = null; }
        if (!enabled || disposed || !dirty || owners.get(path) !== owner) return false;
        const temporary = path + "." + randomUUID() + ".tmp";
        try {
            mkdirSync(dirname(path), { recursive: true });
            if (!contained(realpathSync(runDir), realpathSync(dirname(path)))) return false;
            writeFileSync(temporary, JSON.stringify(snapshot()) + "\n", { flag: "wx" });
            renameSync(temporary, path);
            dirty = false; failedFlushes = 0;
            return true;
        } catch {
            // Windows 读取句柄/杀毒扫描可能暂时阻止 rename。没有后续帧时也必须重试，
            // 否则运行中的快照会永久停在旧状态。退避有上限，且不会阻塞执行器。
            failedFlushes = Math.min(failedFlushes + 1, 7);
            schedule(Math.min(5000, Math.max(100, interval) * (2 ** (failedFlushes - 1))));
            return false;
        }
        finally { try { unlinkSync(temporary); } catch { /* 原子替换成功或临时文件未创建 */ } }
    };
    const changed = at => {
        state.updatedAt = at; dirty = true;
        schedule();
    };
    const signal = (kind, at, phase) => {
        state.lastSignalAt = at; state.lastSignalKind = kind;
        if (phase) state.phase = phase;
        changed(at);
    };
    const action = (kind, name, summary, at, phase) => {
        state.lastAction = { at, kind, name: clean(name, 200), summary: clean(summary, 500) };
        signal(kind, at, phase);
    };
    const bounded = (map, key, value, limit) => {
        if (!map.has(key) && map.size >= limit) {
            const ended = [...map.entries()].find(([, item]) => !active(item.status));
            map.delete(ended ? ended[0] : map.keys().next().value);
        }
        map.set(key, value);
    };
    const taskFor = (frame, at) => {
        if (!validId(frame.task_id)) return null;
        let task = tasks.get(frame.task_id);
        if (!task) {
            task = { id: frame.task_id, captureId, name: "后台任务", description: "", command: "",
                startedAt: at, finishedAt: null, status: "running", exitCode: null, summary: "" };
            bounded(tasks, frame.task_id, task, MAX_TASKS);
        }
        if (validId(frame.tool_use_id)) task.toolUseId = frame.tool_use_id;
        const candidate = tools.get(task.toolUseId), tool = candidate?.ambiguous ? null : candidate;
        task.description = clean(frame.description || task.description || tool?.description, 300);
        task.name = task.description || clean(frame.task_type, 100) || task.name;
        task.command = clean(frame.command || task.command || tool?.command);
        if (typeof frame.is_backgrounded === "boolean") task.isBackgrounded = frame.is_backgrounded;
        if (tool && !tool.ambiguous) task.startedAt = tool.startedAt;
        return task;
    };
    const applyToolResult = (block, frame, at) => {
        const tool = tools.get(block.tool_use_id), summary = resultSummary(block.content);
        if (!tool || tool.ambiguous) {
            action("tool_result", "工具结果", summary, at, "waiting");
            return;
        }
        const details = frame.tool_use_result;
        const taskId = validId(details?.backgroundTaskId) ? details.backgroundTaskId : null;
        let task = taskId ? taskFor({ task_id: taskId, tool_use_id: tool.id, is_backgrounded: true }, at)
            : [...tasks.values()].find(item => item.toolUseId === tool.id);
        if (taskId) tool.backgroundTaskId = taskId;
        tool.summary = summary;
        const code = exitCodeOf({ exit_code: details?.exit_code ?? details?.exitCode });
        if (code !== null) tool.exitCode = code;
        if (!block.is_error && ((task && active(task.status)) || (!task && tool.isBackgrounded))) {
            // Bash 的 tool_result 可能只确认提交；只有 task_notification 确认后台结束。
            tool.status = "submitted";
        } else {
            tool.status = block.is_error ? "failed" : task?.status || "completed";
            tool.finishedAt = at;
        }
        action("tool_result", tool.name, summary, at, "waiting");
    };
    const observe = frame => {
        if (!enabled || disposed || finished || !frame || typeof frame !== "object" || Array.isArray(frame)) return false;
        try {
            const at = time();
            if (frame.type === "system") {
                if (frame.subtype === "thinking_tokens") {
                    const total = frame.estimated_tokens, delta = frame.estimated_tokens_delta;
                    if (!(Number.isFinite(delta) && delta > 0)
                        && !(Number.isFinite(total) && total > (state.thinking.estimatedTokens ?? 0))) return false;
                    if (Number.isFinite(total) && total >= 0) state.thinking.estimatedTokens = total;
                    state.thinking.signals = Math.min(Number.MAX_SAFE_INTEGER, state.thinking.signals + 1);
                    signal("thinking", at, "thinking");
                } else if (frame.subtype === "init") signal("initialized", at, "starting");
                else if (["task_started", "task_notification"].includes(frame.subtype)) {
                    const task = taskFor(frame, at);
                    if (!task) return false;
                    if (frame.subtype === "task_notification") {
                        const statuses = { completed: "completed", failed: "failed", stopped: "stopped", cancelled: "stopped" };
                        if (statuses[frame.status]) {
                            task.status = statuses[frame.status]; task.finishedAt = at;
                            task.summary = clean(frame.summary, 1600); task.exitCode = exitCodeOf(frame);
                            const tool = tools.get(task.toolUseId);
                            if (tool && !tool.ambiguous) Object.assign(tool, { status: task.status, finishedAt: at, exitCode: task.exitCode });
                        }
                    }
                    action("background_task", task.name, task.summary || task.description, at);
                } else if (frame.subtype === "background_tasks_changed" && Array.isArray(frame.tasks)) {
                    const listed = frame.tasks.slice(0, MAX_TASKS), ids = new Set(listed.map(task => task?.task_id).filter(validId));
                    let updated = false;
                    for (const item of listed) {
                        if (!item || !validId(item.task_id)) continue;
                        const previous = tasks.get(item.task_id), wasMissing = !previous || previous.status === "unknown";
                        const task = taskFor(item, at);
                        task.isBackgrounded = true;
                        if (wasMissing) { task.status = "running"; updated = true; }
                    }
                    for (const task of tasks.values()) if (frame.tasks.length <= MAX_TASKS && task.isBackgrounded && task.status === "running" && !ids.has(task.id)) {
                        task.status = "unknown"; updated = true; // 列表消失不等于成功结束。
                    }
                    if (!updated) return false;
                    signal("background_task", at);
                } else return false;
            } else if (["assistant", "user"].includes(frame.type)) {
                let observed = false;
                for (const block of Array.isArray(frame.message?.content) ? frame.message.content : []) {
                    if (frame.type === "assistant" && block?.type === "thinking" && block.thinking) {
                        signal("thinking", at, "thinking"); observed = true;
                    } else if (frame.type === "assistant" && block?.type === "text" && typeof block.text === "string" && block.text) {
                        action("text", "Agent 回复", block.text, at, "responding"); observed = true;
                    } else if (frame.type === "assistant" && block?.type === "tool_use") {
                        const input = block.input || {}, name = clean(block.name, 200) || "工具";
                        if (validId(block.id)) {
                            if (tools.has(block.id)) tools.get(block.id).ambiguous = true;
                            else bounded(tools, block.id, { id: block.id, captureId, toolUseId: block.id, name,
                                description: clean(input.description, 300), command: clean(input.command), isBackgrounded: input.run_in_background === true,
                                startedAt: at, finishedAt: null, status: "running", exitCode: null, summary: "" }, MAX_TOOLS);
                        }
                        action("tool_call", name, input.description || input.command || input.file_path || input.path || input.pattern || "", at, "tool");
                        observed = true;
                    } else if (frame.type === "user" && block?.type === "tool_result") {
                        applyToolResult(block, frame, at); observed = true;
                    }
                }
                if (!observed) return false;
            } else if (frame.type === "result") {
                action("result", "Agent 执行结果", frame.result || frame.resultText || "", at, "waiting");
            } else return false;
            return true;
        } catch { return false; }
    };
    const finish = async (outcome = {}) => {
        if (disposed || finished) return false;
        try {
            finished = true; finalizing = true;
            const at = time();
            state.finishedAt = at;
            state.phase = outcome.timeout ? "timeout" : outcome.stopped ? "stopped"
                : outcome.failure || outcome.error || outcome.resultIsError || outcome.code !== 0 ? "failed" : "completed";
            state.outcome = { code: Number.isSafeInteger(outcome.code) ? outcome.code : null,
                status: state.phase, message: clean(outcome.failure?.message || outcome.error, 500) };
            for (const item of [...tools.values(), ...tasks.values()]) if (active(item.status)) item.status = "unknown";
            changed(at);
            // 调用者 await finish() 后即可 dispose。收尾失败也有有限重试机会，
            // 避免 dispose 立即取消定时器而永久留下“运行中”的旧快照。
            for (let attempt = 0; attempt < 3; attempt++) {
                if (attempt) await delay(attempt * 100);
                if (!enabled || disposed || owners.get(path) !== owner) return false;
                if (flush()) return true;
            }
            return false;
        } catch { return false; }
        finally { finalizing = false; }
    };
    const dispose = () => {
        flush(); disposed = true;
        if (timer) { clearTimeout(timer); timer = null; }
        if (owners.get(path) === owner) owners.delete(path);
    };
    flush();
    return { captureId, observe, snapshot, flush, finish, dispose };
}

async function openInside(runDir, source) {
    const base = await realpath(runDir), path = await realpath(join(runDir, source));
    if (!contained(base, path)) throw new Error("活动来源不在当前任务目录内");
    const file = await open(path, "r");
    if (!(await file.stat()).isFile()) { await file.close(); throw new Error("活动来源不是普通文件"); }
    return file;
}

// 只返回 UI 所需的白名单字段。合法 JSON 也可能已损坏，不能把 null 条目或对象文本传给前端。
function validatedSnapshot(value) {
    const phases = ["starting", "thinking", "tool", "responding", "waiting", "completed", "failed", "stopped", "timeout"];
    const kinds = ["thinking", "tool_call", "tool_result", "background_task", "text", "initialized", "result"];
    const statuses = ["running", "submitted", "unknown", "completed", "failed", "stopped"];
    const object = item => item && typeof item === "object" && !Array.isArray(item);
    const expect = condition => { if (!condition) throw new Error("活动快照结构无效"); };
    const text = (item, limit) => { expect(typeof item === "string" && item.length <= limit); return item; };
    const timestamp = item => { expect(item === null || (validAt(item) && item.length <= 40)); return item; };
    expect(object(value) && phases.includes(value.phase) && validAt(value.startedAt));
    expect(value.lastSignalKind === null || kinds.includes(value.lastSignalKind));
    expect(object(value.thinking) && Number.isSafeInteger(value.thinking.signals) && value.thinking.signals >= 0);
    expect(value.thinking.estimatedTokens === null || (Number.isFinite(value.thinking.estimatedTokens) && value.thinking.estimatedTokens >= 0));
    let lastAction = null;
    if (value.lastAction !== null) {
        expect(object(value.lastAction) && kinds.includes(value.lastAction.kind) && validAt(value.lastAction.at));
        lastAction = { at: timestamp(value.lastAction.at), kind: value.lastAction.kind,
            name: text(value.lastAction.name, 200), summary: text(value.lastAction.summary, 500) };
    }
    const entries = (items, limit) => {
        expect(Array.isArray(items) && items.length <= limit);
        return items.map(item => {
            expect(object(item) && validId(item.id) && item.captureId === value.captureId && statuses.includes(item.status) && validAt(item.startedAt));
            expect(item.exitCode === null || Number.isSafeInteger(item.exitCode));
            const result = { id: item.id, captureId: item.captureId, status: item.status, name: text(item.name, 300),
                description: text(item.description, 300), command: text(item.command, 1000), summary: text(item.summary, 1600),
                startedAt: timestamp(item.startedAt), finishedAt: timestamp(item.finishedAt), exitCode: item.exitCode };
            for (const key of ["toolUseId", "backgroundTaskId"]) if (item[key] !== undefined) { expect(validId(item[key])); result[key] = item[key]; }
            for (const key of ["isBackgrounded", "ambiguous"]) if (item[key] !== undefined) { expect(typeof item[key] === "boolean"); result[key] = item[key]; }
            return result;
        });
    };
    const result = {
        version: 1, status: "available", stageId: "P6", executor: "claude-code", captureId: value.captureId, stageStartedAt: value.stageStartedAt,
        phase: value.phase, startedAt: timestamp(value.startedAt), updatedAt: timestamp(value.updatedAt), finishedAt: timestamp(value.finishedAt),
        lastSignalAt: timestamp(value.lastSignalAt), lastSignalKind: value.lastSignalKind, lastAction,
        thinking: { estimatedTokens: value.thinking.estimatedTokens, signals: value.thinking.signals },
        tools: entries(value.tools, MAX_TOOLS), backgroundTasks: entries(value.backgroundTasks, MAX_TASKS), thresholds: { ...AGENT_ACTIVITY_THRESHOLDS },
    };
    if (value.outcome !== undefined) {
        expect(object(value.outcome) && ["completed", "failed", "stopped", "timeout"].includes(value.outcome.status)
            && (value.outcome.code === null || Number.isSafeInteger(value.outcome.code)));
        result.outcome = { status: value.outcome.status, code: value.outcome.code, message: text(value.outcome.message, 500) };
    }
    return result;
}

export async function readAgentActivity(runDir, run) {
    const unavailable = reason => ({ status: "unavailable", reason, thresholds: { ...AGENT_ACTIVITY_THRESHOLDS } });
    const stageStartedAt = run?.stages?.P6?.startedAt, execution = run?.externalExec;
    if (execution?.executor !== "claude-code" || !validAt(stageStartedAt)) return unavailable("本轮没有 Claude Code 活动采集");
    let file;
    try {
        if (execution.captureId) {
            if (!validId(execution.captureId) || execution.stageStartedAt !== stageStartedAt) return unavailable("执行身份与本轮 P6 不匹配");
            file = await openInside(runDir, AGENT_ACTIVITY_PATH);
            if ((await file.stat()).size > MAX_BYTES) return unavailable("活动快照超过读取上限");
            const buffer = Buffer.alloc(MAX_BYTES + 1);
            const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
            if (bytesRead > MAX_BYTES) return unavailable("活动快照超过读取上限");
            const value = JSON.parse(buffer.subarray(0, bytesRead).toString("utf8"));
            if (value.version !== 1 || value.executor !== "claude-code" || value.stageId !== "P6"
                || value.stageStartedAt !== stageStartedAt || value.captureId !== execution.captureId) {
                return unavailable("活动快照属于其他执行轮次");
            }
            if (!Array.isArray(value.tools) || value.tools.length > MAX_TOOLS
                || !Array.isArray(value.backgroundTasks) || value.backgroundTasks.length > MAX_TASKS
                || !validAt(value.startedAt) || (value.lastSignalAt !== null && !validAt(value.lastSignalAt))) {
                return unavailable("活动快照结构无效");
            }
            return validatedSnapshot(value);
        }
        // 历史任务只读取固定日志的 mtime，不扫描日志，也不据此猜测推理/工具/进程状态。
        if (!validAt(execution.startedAt) || Date.parse(execution.startedAt) < Date.parse(stageStartedAt)) {
            return unavailable("历史执行时间与本轮 P6 不匹配");
        }
        file = await openInside(runDir, "06-implementation/external-exec.log");
        const info = await file.stat();
        if (info.mtimeMs < Date.parse(execution.startedAt)) return unavailable("日志早于本轮执行");
        return { status: "legacy", stageId: "P6", stageStartedAt, executor: "claude-code", lastLogUpdateAt: info.mtime.toISOString(),
            reason: "旧执行未采集活动快照，仅能确认日志最近更新时间", thresholds: { ...AGENT_ACTIVITY_THRESHOLDS } };
    } catch (error) {
        return unavailable(error.code === "ENOENT" ? "本轮活动快照或日志尚未生成" : "活动来源暂不可读");
    } finally { try { await file?.close(); } catch { /* 只读观测不影响执行 */ } }
}
