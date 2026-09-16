// 原始 Agent 消息只读查询：索引定位完整 JSON，不把摘要重新包装成“原始消息”。
// TASK-10：索引与原始消息支持轮转分片（external-exec.events.000002.jsonl …）；
// 旧格式（无分片、索引条目无 source.file）按旧形态读取，互不迁移。
import { open, readFile, readdir, realpath } from "node:fs/promises";
import { join, relative, isAbsolute } from "node:path";
import { createHash } from "node:crypto";
import { frameToEntries, dshEventToEntries } from "./executors/agent-timeline.js";

export const AGENT_MESSAGE_LIMIT = 5 * 1024 * 1024;
const INDEX_LIMIT = 64 * 1024;
const BASE = "06-implementation/";
const EVENTS_PREFIX = "external-exec.events";
const MESSAGES = BASE + "external-exec.messages.jsonl";
const TIMELINE = BASE + "external-exec.timeline.log";
const LEGACY = BASE + "external-exec.log";
const ID = /^([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}):([0-9]{1,12}):([0-9]{1,8})$/i;
// 分片命名：首片沿用既有文件名，之后 <prefix>.NNNNNN.jsonl（读取顺序按序号）
const EVENTS_FILE_RE = /^external-exec\.events(?:\.\d{6})?\.jsonl$/;
const MESSAGES_FILE_RE = /^external-exec\.messages(?:\.\d{6})?\.jsonl$/;
const shardNo = (name) => Number(/\.(\d{6})\.jsonl$/.exec(name)?.[1] || 1);
const unavailable = (reason, extra = {}) => ({ ok: true, status: "unavailable", reason, related: [], ...extra });
const ambiguous = (reason, extra = {}) => ({ ok: true, status: "ambiguous", reason, related: [], ...extra });

export function validateAgentEventQuery(query) {
    const { id, legacyLine } = query || {};
    if ((id == null) === (legacyLine == null)) throw new Error("必须且只能指定 id 或 legacyLine");
    if (id != null && (typeof id !== "string" || !ID.test(id))) throw new Error("非法 Agent 事件 ID");
    if (legacyLine != null && (typeof legacyLine !== "string" || Buffer.byteLength(legacyLine) > 4096
        || !/^(?:\d{4}-\d{2}-\d{2} )?\d{2}:\d{2}:\d{2}\|[^|\r\n]+\|[^\r\n]*$/.test(legacyLine))) {
        throw new Error("非法历史时间线记录");
    }
}

async function openSource(runDir, sourcePath) {
    // 固定文件名之外仍核验 realpath，拒绝目录/文件软链接逃出当前任务。
    const base = await realpath(runDir), resolved = await realpath(join(runDir, sourcePath));
    const rel = relative(base, resolved);
    if (!rel || rel === ".." || rel.startsWith("../") || rel.startsWith("..\\") || isAbsolute(rel)) {
        throw new Error("来源文件不在当前任务目录内");
    }
    const file = await open(resolved, "r");
    if (!(await file.stat()).isFile()) { await file.close(); throw new Error("来源不是普通文件"); }
    return file;
}

// 按快照长度、分块扫描；超长行不会积累整个文件，末尾行由调用者验证完整性。
async function* lines(file, maxBytes, includeFinal = false) {
    const size = (await file.stat()).size, chunk = Buffer.alloc(64 * 1024);
    let position = 0, parts = [], bytes = 0, overflow = false, lineOffset = 0;
    while (position < size) {
        const { bytesRead } = await file.read(chunk, 0, Math.min(chunk.length, size - position), position);
        if (!bytesRead) break;
        for (let start = 0; start < bytesRead;) {
            let end = chunk.indexOf(10, start);
            if (end < 0 || end >= bytesRead) end = bytesRead;
            const length = end - start;
            bytes += length;
            if (bytes > maxBytes) { overflow = true; parts = []; }
            else if (!overflow && length) parts.push(Buffer.from(chunk.subarray(start, end)));
            if (end < bytesRead) {
                let value = overflow ? null : Buffer.concat(parts, bytes).toString("utf8");
                if (value?.endsWith("\r")) value = value.slice(0, -1);
                yield { text: value, offset: lineOffset, bytes, overflow };
                lineOffset = position + end + 1;
                parts = []; bytes = 0; overflow = false;
            }
            start = end + 1;
        }
        position += bytesRead;
    }
    if (includeFinal && bytes) {
        let value = overflow ? null : Buffer.concat(parts, bytes).toString("utf8");
        if (value?.endsWith("\r")) value = value.slice(0, -1);
        yield { text: value, offset: lineOffset, bytes, overflow };
    }
}

async function* indexEntries(file, state = {}) {
    for await (const line of lines(file, INDEX_LIMIT, true)) {
        if (line.overflow) { state.invalid = true; continue; }
        if (!line.text?.trim()) continue;
        let event;
        try { event = JSON.parse(line.text); } catch { state.invalid = true; continue; }
        if (!event || typeof event !== "object" || Array.isArray(event)) { state.invalid = true; continue; }
        yield event;
    }
}

function projectedEntries(event, message) {
    if (event.executor === "claude-code") return frameToEntries(message, { includeToolResults: true });
    if (event.executor === "dsh-agent") return dshEventToEntries(message);
    return [];
}

// 分片枚举（TASK-10）：按文件名序号升序列出全部索引分片；无分片 = 旧格式未采集。
async function listShards(runDir, re) {
    let names;
    try { names = await readdir(join(runDir, BASE)); }
    catch (error) { if (error.code === "ENOENT") return []; throw error; }
    return names.filter((name) => re.test(name)).sort((a, b) => shardNo(a) - shardNo(b) || a.localeCompare(b));
}

// 分片清单核对：清单存在时必须可解析且登记的分片都在盘（缺失 = 留档不完整，
// 明确报错，不静默降级）；清单缺失按旧格式处理（文件名顺序枚举兜底）。
async function checkShardManifest(runDir, files, prefix) {
    let text;
    try { text = await readFile(join(runDir, BASE, prefix + ".manifest.json"), "utf8"); }
    catch (error) { if (error.code === "ENOENT") return null; throw error; }
    let manifest;
    try { manifest = JSON.parse(text); } catch { throw new Error(prefix + " 分片清单不是有效 JSON（manifest 损坏，无法核对留档完整性）"); }
    if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) throw new Error(prefix + " 分片清单不是 JSON 对象");
    if (!Array.isArray(manifest.files)) throw new Error(prefix + " 分片清单缺少 files 数组");
    const onDisk = new Set(files);
    for (const entry of manifest.files) {
        const name = entry && entry.file;
        if (typeof name !== "string" || name.includes("/") || name.includes("\\")) throw new Error(prefix + " 分片清单含非法文件名");
        if (!onDisk.has(name)) throw new Error(prefix + " 分片清单登记的分片缺失: " + name);
    }
    return manifest;
}

// 事件 → 原始消息所在 messages 分片的 run 内相对路径。source.file 是 TASK-10
// 新增字段；旧条目无 file 时落在首片（即既有固定文件名）。
function messageSourcePath(event) {
    const file = event.source?.file;
    if (file === undefined || file === null) return MESSAGES;
    if (typeof file !== "string" || !MESSAGES_FILE_RE.test(file)) throw new Error("原始消息分片名非法: " + String(file));
    return BASE + file;
}

async function originalMessage(runDir, event) {
    const identity = ID.exec(event.id || "");
    if (!identity || identity[1] !== event.captureId || event.origin !== "agent") throw new Error("事件来源标识无效");
    const { offset, bytes, sha256 } = event.source || {};
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(bytes) || bytes < 1
        || !/^[a-f0-9]{64}$/i.test(sha256 || "")) throw new Error("原始消息索引无效");
    if (bytes > AGENT_MESSAGE_LIMIT) throw new Error("单条原始消息超过 5MB 读取上限，未截断返回");
    const file = await openSource(runDir, messageSourcePath(event));
    try {
        const size = (await file.stat()).size;
        if (!Number.isSafeInteger(offset + bytes) || offset + bytes >= size) throw new Error("原始消息尚未写完整或来源文件已变化");
        const boundary = Buffer.alloc(1);
        if (offset) {
            await file.read(boundary, 0, 1, offset - 1);
            if (boundary[0] !== 10) throw new Error("原始消息起点不在行边界");
        }
        await file.read(boundary, 0, 1, offset + bytes);
        if (boundary[0] !== 10) throw new Error("原始消息终点不在行边界");
        const buffer = Buffer.alloc(bytes);
        let read = 0;
        while (read < bytes) {
            const result = await file.read(buffer, read, bytes - read, offset + read);
            if (!result.bytesRead) throw new Error("原始消息读取不完整");
            read += result.bytesRead;
        }
        if (createHash("sha256").update(buffer).digest("hex") !== sha256) throw new Error("原始消息校验失败，来源文件可能已替换");
        if (buffer.includes(10) || buffer.includes(13)) throw new Error("原始消息跨越多行，索引无效");
        let message;
        try { message = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer)); }
        catch { throw new Error("原始消息不是完整有效的 JSON"); }
        if (!message || typeof message !== "object" || Array.isArray(message)) throw new Error("原始消息不是 JSON 对象");
        const projection = projectedEntries(event, message);
        const matches = projection.some((entry, i) => String(entry.blockIndex ?? i) === identity[3]
            && ["kind", "text", "blockIndex", "toolUseId", "relation"].every(key => entry[key] === event[key]));
        if (!matches) throw new Error("事件摘要与原始消息不匹配，无法可靠关联");
        return message;
    } finally {
        await file.close();
    }
}

async function indexedMessage(runDir, id) {
    const handles = [];
    try {
        const shards = await listShards(runDir, EVENTS_FILE_RE);
        await checkShardManifest(runDir, shards, EVENTS_PREFIX);
        if (!shards.length) return unavailable("未采集原始消息，或来源文件已不存在");
        for (const name of shards) handles.push(await openSource(runDir, BASE + name));
        let event;
        const indexState = {};
        for (const index of handles) {
            for await (const candidate of indexEntries(index, indexState)) {
                if (candidate.id !== id) continue;
                if (event) return ambiguous("同一事件 ID 对应多条索引，无法唯一定位");
                event = candidate;
            }
        }
        if (!event) return unavailable(indexState.invalid ? "部分事件索引已损坏，无法定位该事件" : "未找到该事件的原始消息索引");
        if (!event.source || event.origin === "platform") return unavailable("这是平台执行事件，没有对应的 Agent 原始 JSON", { event });
        const message = await originalMessage(runDir, event);
        const result = { ok: true, status: "available", event, message, related: [], sourcePath: messageSourcePath(event) };
        if (!event.toolUseId || !["call", "result"].includes(event.relation)) return result;
        if (indexState.invalid) {
            result.relatedReason = "部分事件索引已损坏，无法可靠关联工具调用与结果";
            return result;
        }
        const group = [], relatedState = {};
        for (const index of handles) {
            for await (const candidate of indexEntries(index, relatedState)) {
                if (candidate.captureId === event.captureId && candidate.executor === event.executor
                    && candidate.toolUseId === event.toolUseId && ["call", "result"].includes(candidate.relation)) group.push(candidate);
            }
        }
        if (relatedState.invalid) {
            result.relatedReason = "部分事件索引已损坏，无法可靠关联工具调用与结果";
            return result;
        }
        // 同一执行内出现重复调用 ID 时也不能猜哪一次调用属于这些结果。
        const calls = new Set(group.filter(item => item.relation === "call").map(item => `${item.source?.file || ""}:${item.source?.offset}:${item.blockIndex ?? ""}`));
        if (calls.size !== 1) { result.relatedReason = "工具调用标识无法唯一关联，未关联调用与结果"; return result; }
        const counts = new Map();
        for (const candidate of group) counts.set(candidate.id, (counts.get(candidate.id) || 0) + 1);
        const seen = new Set();
        for (const candidate of group) {
            if (candidate.relation === event.relation || seen.has(candidate.id)) continue;
            seen.add(candidate.id);
            if (counts.get(candidate.id) > 1) { result.relatedReason = "工具关联事件 ID 重复，无法唯一定位该记录"; continue; }
            try { result.related.push({ event: candidate, message: await originalMessage(runDir, candidate) }); }
            catch { result.relatedReason = "部分工具关联记录未通过来源校验，未展示该记录"; }
        }
        return result;
    } catch (error) {
        return unavailable(error.code === "ENOENT" ? "未采集原始消息，或来源文件已不存在" : error.message);
    } finally {
        for (const handle of handles) await handle.close().catch(() => { /* 尽力关闭 */ });
    }
}

async function legacyMessage(runDir, legacyLine) {
    let timeline, raw;
    const extra = { legacy: true, sourcePath: LEGACY };
    try {
        timeline = await openSource(runDir, TIMELINE);
        let exists = false;
        for await (const line of lines(timeline, 4096, true)) if (line.text === legacyLine) { exists = true; break; }
        if (!exists) return unavailable("该记录不是当前任务时间线中的原始行", extra);
        const first = legacyLine.indexOf("|"), second = legacyLine.indexOf("|", first + 1);
        const kind = legacyLine.slice(first + 1, second), text = legacyLine.slice(second + 1);
        raw = await openSource(runDir, LEGACY);
        let inClaude = false, inStdout = false, candidate = null, incomplete = "";
        for await (const line of lines(raw, AGENT_MESSAGE_LIMIT, true)) {
            if (line.text?.startsWith("=== ")) { inClaude = /^=== claude-code /.test(line.text); inStdout = false; continue; }
            if (line.text === "--- stdout ---") { inStdout = inClaude; continue; }
            if (line.text === "--- stderr ---" || line.text?.startsWith("--- exit=")) { inStdout = false; continue; }
            if (!inStdout) continue;
            if (line.overflow) { incomplete = "历史日志存在超过 5MB 的原始消息，无法完成唯一性校验"; continue; }
            let message;
            try { message = JSON.parse(line.text); }
            catch {
                if (line.text?.trimStart().startsWith("{")) incomplete ||= "历史日志存在截断或损坏的 JSON，无法完成唯一性校验";
                continue;
            }
            if (!message || typeof message !== "object" || Array.isArray(message)) continue;
            const matches = frameToEntries(message).filter(entry => entry.kind === kind && entry.text === text);
            if (!matches.length) continue;
            if (candidate) return ambiguous("历史摘要匹配到多条原始消息，无法唯一定位", extra);
            candidate = { message, entry: matches.length === 1 ? matches[0] : { kind, text } };
        }
        // 跳过的超限帧也可能有同样摘要，不能宣称其他候选是唯一原文。
        if (incomplete) return unavailable(incomplete, extra);
        if (!candidate) return unavailable("无法从历史日志可靠定位原始消息；旧执行可能未采集完整 JSON", extra);
        return { ok: true, status: "available", ...extra,
            event: { at: legacyLine.slice(0, first), ...candidate.entry, executor: "claude-code", origin: "agent" },
            message: candidate.message, related: [] };
    } catch (error) {
        return unavailable(error.code === "ENOENT" ? "历史执行未采集可用的原始消息" : error.message, extra);
    } finally {
        await timeline?.close(); await raw?.close();
    }
}

export async function readAgentEvent(runDir, query) {
    validateAgentEventQuery(query);
    return query.id != null ? indexedMessage(runDir, query.id) : legacyMessage(runDir, query.legacyLine);
}
