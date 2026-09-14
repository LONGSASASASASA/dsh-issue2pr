// 原始 Agent JSON 与摘要分开存储。摘要只保存字节位置和校验值，不改写原始消息。
import { appendFileSync, closeSync, fstatSync, openSync, readSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { dirname, join } from "node:path";
import { frameToEntries } from "./agent-timeline.js";

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

export function agentRecordPaths(logPath) {
    if (!logPath) return {};
    return {
        messagesPath: join(dirname(logPath), "external-exec.messages.jsonl"),
        eventsPath: join(dirname(logPath), "external-exec.events.jsonl"),
    };
}

// 每次执行独立 captureId；同一条消息拆出的多个摘要共用 source，不靠文本/时间猜关联。
export function createAgentRecordWriter({ messagesPath, eventsPath, executor, captureId = randomUUID(), onLine } = {}) {
    let seq = 0, pending = "", closed = false;
    const decoder = new StringDecoder("utf8");
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
            try { if (eventsPath) appendJsonLine(eventsPath, Buffer.from(JSON.stringify(event))); } catch { /* 留档失败不影响任务 */ }
        }
    };
    const appendFrame = (frame, { at = new Date().toISOString(), entries, json } = {}) => {
        if (!messagesPath || !eventsPath || !frame || typeof frame !== "object" || Array.isArray(frame)) return false;
        try {
            const value = json ?? JSON.stringify(frame);
            const bytes = Buffer.from(value, "utf8");
            const offset = appendJsonLine(messagesPath, bytes);
            const source = { offset, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
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
