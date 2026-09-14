// 委外 agent 时间线：stream-json 帧写入时格式化为 `时间|kind|内容` 行，落到 external-exec.timeline.log。
// 原始 external-exec.log 一字不动（保真/审计/续读）；本文件只做"格式化的只读镜像"，写失败静默（不拖垮执行）。
import { appendFileSync } from "node:fs";

const MAX_TEXT = 500, MAX_TOOL = 200;

// 二期 E2：写入完整日期时间（跨天任务可溯源）；前端展示层自行截断为时分秒，旧文件无日期前缀按旧格式解析
const stamp = () => {
    const d = new Date(), p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};
const oneLine = (text, max) => String(text ?? "").replace(/\s*\n\s*/g, " / ").slice(0, max);

function inputSummary(input) {
    if (input == null) return "";
    if (typeof input === "string") return oneLine(input, MAX_TOOL);
    if (typeof input !== "object") return oneLine(String(input), MAX_TOOL);
    const key = ["file_path", "path", "command", "pattern", "url", "query"].find((k) => typeof input[k] === "string" && input[k].trim());
    if (key) return (key === "file_path" || key === "path" ? "" : key + ": ") + oneLine(input[key], MAX_TOOL);
    return oneLine(JSON.stringify(input), MAX_TOOL);
}

// stream-json 帧 → 时间线条目；无法识别的帧透传为 raw
export function frameToEntries(frame, { includeToolResults = false } = {}) {
    if (!frame || typeof frame !== "object") return [{ kind: "raw", text: oneLine(frame, MAX_TEXT) }];
    if (frame.type === "system") {
        // 纯遥测帧（thinking_tokens 等计数心跳）不进时间线；init 保留
        if (frame.subtype && frame.subtype !== "init") return [];
        return [{ kind: "init", text: oneLine("会话初始化" + (frame.model ? " · 模型 " + frame.model : ""), MAX_TEXT) }];
    }
    if (frame.type === "assistant") {
        const blocks = Array.isArray(frame.message?.content) ? frame.message.content : [];
        return blocks.map((block, blockIndex) => {
            if (block?.type === "thinking") return { kind: "think", text: oneLine(block.thinking, MAX_TEXT), blockIndex };
            if (block?.type === "text") return { kind: "text", text: oneLine(block.text, MAX_TEXT), blockIndex };
            if (block?.type === "tool_use") return { kind: "tool", text: oneLine(`${block.name || "工具"} ${inputSummary(block.input)}`.trim(), MAX_TOOL), blockIndex,
                ...(typeof block.id === "string" ? { toolUseId: block.id } : {}), relation: "call" };
            return null;
        }).filter(Boolean);
    }
    if (frame.type === "user") {
        if (!includeToolResults) return []; // 旧文本镜像保持原有精简口径
        const blocks = Array.isArray(frame.message?.content) ? frame.message.content : [];
        return blocks.map((block, blockIndex) => {
            if (block?.type !== "tool_result") return null;
            const content = typeof block.content === "string" ? block.content : JSON.stringify(block.content ?? "");
            return { kind: block.is_error ? "error" : "tool_result", text: oneLine(content, MAX_TEXT), blockIndex,
                ...(typeof block.tool_use_id === "string" ? { toolUseId: block.tool_use_id } : {}), relation: "result" };
        }).filter(Boolean);
    }
    if (frame.type === "result") {
        const parts = [oneLine(frame.result || frame.resultText || "", MAX_TEXT)];
        if (Number.isFinite(frame.num_turns)) parts.push(`${frame.num_turns} 轮`);
        return [{ kind: "result", text: parts.filter(Boolean).join(" · ") }];
    }
    return [{ kind: "raw", text: oneLine(JSON.stringify(frame), MAX_TEXT) }];
}

// DSH 原生事件摘要。只读取实际事件字段；原始事件完整留存由 agent-records 负责。
export function dshEventToEntries(event) {
    const data = event?.data || {};
    const argumentsSummary = (value) => {
        if (typeof value === "string") { try { return inputSummary(JSON.parse(value)); } catch { /* 保留非法参数原文 */ } }
        return inputSummary(value);
    };
    const resultEntry = (block, blockIndex) => ({
        kind: block.isError || data.error ? "error" : "tool_result",
        text: oneLine(Array.isArray(block.content) ? block.content.map((part) => part?.text ?? JSON.stringify(part)).join(" / ") : String(block.content ?? ""), MAX_TEXT),
        blockIndex, ...(typeof block.toolCallId === "string" ? { toolUseId: block.toolCallId } : {}), relation: "result",
    });
    if (event?.type === "assistant/message") {
        const blocks = Array.isArray(data.message?.content) ? data.message.content : [];
        const entries = blocks.map((block, blockIndex) => {
            if (block?.type === "reasoning") return { kind: "think", text: oneLine(block.text, MAX_TEXT), blockIndex };
            // assistant 中的模型请求与后续 tool/call 属于同一次调用；关联以实际 tool/call 为准，避免重复配对。
            if (block?.type === "tool-call") return { kind: "tool", text: oneLine(`${block.name || "工具"} ${argumentsSummary(block.arguments)}`.trim(), MAX_TOOL),
                blockIndex, ...(typeof block.id === "string" ? { toolUseId: block.id } : {}) };
            if (block?.type === "tool-result") return resultEntry(block, blockIndex);
            // 兼容历史测试/旧适配器的 Claude 风格 content 块；真正原生消息仍原样留存。
            return frameToEntries({ type: "assistant", message: { content: [block] } }).map((entry) => ({ ...entry, blockIndex }))[0];
        }).filter(Boolean);
        if (entries.length) return entries;
    }
    if (event?.type === "tool/call") {
        const toolUseId = data.callId ?? data.id ?? data.toolCallId ?? data.tool_use_id;
        return [{ kind: "tool", text: oneLine(`${data.name || "工具"} ${argumentsSummary(data.arguments ?? data.input)}`.trim(), MAX_TOOL),
            ...(typeof toolUseId === "string" ? { toolUseId } : {}), relation: "call" }];
    }
    if (event?.type === "tool/result") {
        const blocks = Array.isArray(data.message?.content) ? data.message.content : [];
        const entries = blocks.map((block, index) => block?.type === "tool-result" ? resultEntry(block, index) : null).filter(Boolean);
        if (entries.length) return entries;
        const toolUseId = data.toolCallId ?? data.tool_use_id ?? data.id;
        return [{ kind: data.is_error || data.isError ? "error" : "tool_result", text: oneLine(JSON.stringify(data.result ?? data.content ?? data), MAX_TEXT),
            ...(typeof toolUseId === "string" ? { toolUseId } : {}), relation: "result" }];
    }
    if (event?.type === "turn/start") return [{ kind: "init", text: "开始执行" }];
    if (event?.type === "turn/end") return [{ kind: "result", text: oneLine("执行结束" + (data.reason?.kind ? " · " + data.reason.kind : ""), MAX_TEXT) }];
    return [{ kind: "raw", text: oneLine(JSON.stringify(event), MAX_TEXT) }];
}

// chunk 可能是多行文本；逐行尝试解析，坏行透传 raw
export function appendAgentTimeline(path, chunk) {
    if (!path) return;
    for (const line of String(chunk ?? "").split("\n")) {
        const t = line.trim();
        if (!t) continue;
        let entries;
        try { entries = frameToEntries(JSON.parse(t)); } catch { entries = [{ kind: "raw", text: oneLine(t, MAX_TEXT) }]; }
        for (const entry of entries) {
            try { appendFileSync(path, `${stamp()}|${entry.kind}|${entry.text}\n`); } catch { /* 时间线写失败不影响原始日志 */ }
        }
    }
}

// 显式行（初始化头/退出行等）
export function appendAgentTimelineLine(path, kind, text) {
    if (!path) return;
    try { appendFileSync(path, `${stamp()}|${kind}|${oneLine(text, MAX_TEXT)}\n`); } catch { /* 同上 */ }
}
