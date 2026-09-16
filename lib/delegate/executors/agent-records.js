// 原始 Agent JSON 与摘要分开存储。摘要只保存字节位置和校验值，不改写原始消息。
// TASK-10：messages / events 超过阈值后轮转新分片（历史不删不改）——首片沿用既有
// 文件名（旧读取端兼容），之后 <prefix>.000002.jsonl …；分片清单 <prefix>.manifest.json
// 原子落盘，索引条目的 source 增加 file 字段指向实际分片（旧条目无 file = 首片，兼容）。
import { appendFileSync, closeSync, fstatSync, openSync, readSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync, rmSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { basename, dirname, join } from "node:path";
import { frameToEntries } from "./agent-timeline.js";

export const AGENT_RECORD_ROTATE_BYTES = 8 * 1024 * 1024;

function appendJsonLine(path, bytes) {
    const fd = openSync(path, "a+");
    try {
        let offset = fstatSync(fd).size;
        // 上次进程中断可能留下不完整末行；保留它并换行，不破坏后续完整消息或索引。
        if (offset) {
            const last = Buffer.alloc(1);
            readSync(fd, last, 0, 1, offset - 1);
            if (last[0] !== 10) { appendFileSync(fd, "\n"); offset += 1; }
        }
        appendFileSync(fd, Buffer.concat([bytes, Buffer.from("\n")]));
        return offset;
    } finally { try { closeSync(fd); } catch { /* best-effort */ } }
}

// 分片行追加器：单写者（同一时刻一个执行器进程）；跨执行（重跑）从盘上现存
// 分片续写。清单写失败不阻断执行（读取端按文件名顺序枚举兜底）。
function createShardedLineAppender({ dir, base, rotateBytes = AGENT_RECORD_ROTATE_BYTES }) {
    const prefix = base.replace(/\.jsonl$/, "");
    const shardRe = new RegExp("^" + prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\.(\\d{6})\\.jsonl$");
    const manifestPath = join(dir, prefix + ".manifest.json");
    const nameOf = (n) => n <= 1 ? base : `${prefix}.${String(n).padStart(6, "0")}.jsonl`;
    let index = 1, bytes = 0;
    const files = new Map();
    try {
        for (const name of readdirSync(dir)) {
            const numbered = shardRe.exec(name);
            if (name !== base && !numbered) continue;
            const size = statSync(join(dir, name)).size;
            files.set(name, size);
            if (name === base) index = Math.max(index, 1);
            else index = Math.max(index, Number(numbered[1]));
        }
        bytes = files.get(nameOf(index)) || 0;
    } catch { /* 目录不可读时从首片开始（appendJsonLine 自行建目录外文件） */ }
    const persistManifest = () => {
        const tmp = manifestPath + ".tmp-" + randomUUID();
        try {
            writeFileSync(tmp, JSON.stringify({
                schemaVersion: 1, kind: "agent-record-shards", base, status: "open",
                files: [...files.entries()].map(([file, size]) => ({ file, bytes: size })),
                updatedAt: new Date().toISOString(),
            }, null, 2));
            renameSync(tmp, manifestPath);
        } catch {
            try { rmSync(tmp, { force: true }); } catch { /* 尽力清理 */ }
            /* 清单失败不阻断执行；读取端按文件名顺序枚举兜底 */
        }
    };
    let persistedIndex = -1; // 清单只在首写与轮转（分片集合变化）时原子落盘：
    // 分片文件本身按行即时在盘，读取端按文件名顺序枚举可兜底，无需每行重写清单
    return {
        appendLine(payload) {
            const line = Buffer.concat([payload, Buffer.from("\n")]);
            if (bytes > 0 && bytes + line.length > rotateBytes) { index += 1; bytes = 0; }
            const file = nameOf(index);
            const offset = appendJsonLine(join(dir, file), payload);
            bytes = offset + line.length;
            files.set(file, bytes);
            if (persistedIndex !== index) { persistedIndex = index; persistManifest(); }
            return { file, offset };
        },
    };
}

export function agentRecordPaths(logPath) {
    if (!logPath) return {};
    return {
        messagesPath: join(dirname(logPath), "external-exec.messages.jsonl"),
        eventsPath: join(dirname(logPath), "external-exec.events.jsonl"),
    };
}

// 每次执行独立 captureId；同一条消息拆出的多个摘要共用 source，不靠文本/时间猜关联。
// source.file（TASK-10）= 该条消息实际所在的 messages 分片；旧条目无 file = 首片（兼容）。
export function createAgentRecordWriter({ messagesPath, eventsPath, executor, captureId = randomUUID(), rotateBytes, onLine } = {}) {
    let seq = 0, pending = "", closed = false;
    const decoder = new StringDecoder("utf8");
    const messagesAppender = messagesPath
        ? createShardedLineAppender({ dir: dirname(messagesPath), base: basename(messagesPath), ...(rotateBytes ? { rotateBytes } : {}) })
        : null;
    const eventsAppender = eventsPath
        ? createShardedLineAppender({ dir: dirname(eventsPath), base: basename(eventsPath), ...(rotateBytes ? { rotateBytes } : {}) })
        : null;
    const writeEntries = (entries, source, at, origin) => {
        const frameSeq = ++seq;
        for (const [index, entry] of entries.entries()) {
            const event = {
                id: `${captureId}:${frameSeq}:${entry.blockIndex ?? index}`,
                captureId, executor, at, kind: entry.kind, text: entry.text, source, origin,
                ...(Number.isInteger(entry.blockIndex) ? { blockIndex: entry.blockIndex } : {}),
                ...(typeof entry.toolUseId === "string" ? { toolUseId: entry.toolUseId } : {}),
                ...(entry.relation ? { relation: entry.relation } : {}),
            };
            try { eventsAppender?.appendLine(Buffer.from(JSON.stringify(event))); } catch { /* 留档失败不影响任务 */ }
        }
    };
    const appendFrame = (frame, { at = new Date().toISOString(), entries, json } = {}) => {
        if (!messagesAppender || !eventsAppender || !frame || typeof frame !== "object" || Array.isArray(frame)) return false;
        try {
            const value = json ?? JSON.stringify(frame);
            const bytes = Buffer.from(value, "utf8");
            const { file, offset } = messagesAppender.appendLine(bytes);
            const source = { file, offset, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
            writeEntries(entries ?? frameToEntries(frame, { includeToolResults: true }), source, at, "agent");
            return true;
        } catch { return false; }
    };
    const appendPlatform = (kind, text, { at = new Date().toISOString() } = {}) => {
        writeEntries([{ kind, text }], null, at, "platform");
    };
    const consume = (line) => {
        if (!line.trim()) return;
        try { onLine?.(line); } catch { /* 旧镜像失败不影响完整消息采集 */ }
        try { appendFrame(JSON.parse(line), { json: line }); } catch { /* 非 JSON 仍保留在原始 stdout 日志 */ }
    };
    const drain = () => {
        let end;
        while ((end = pending.indexOf("\n")) >= 0) {
            const line = pending.slice(0, end).replace(/\r$/, "");
            pending = pending.slice(end + 1);
            consume(line);
        }
    };
    const push = (chunk) => {
        if (closed || chunk == null) return;
        pending += typeof chunk === "string" ? chunk : decoder.write(chunk);
        drain();
    };
    const flush = () => {
        if (closed) return;
        closed = true;
        pending += decoder.end();
        drain();
        if (pending) consume(pending.replace(/\r$/, ""));
        pending = "";
    };
    return { captureId, appendFrame, appendPlatform, push, flush };
}
