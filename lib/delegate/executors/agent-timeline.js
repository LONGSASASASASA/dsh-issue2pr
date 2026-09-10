// 委外 agent 时间线：stream-json 帧写入时格式化为 `时间|kind|内容` 行，落到 external-exec.timeline.log。
// 原始 external-exec.log 一字不动（保真/审计/续读）；本文件只做"格式化的只读镜像"，写失败静默（不拖垮执行）。
import { appendFileSync } from "node:fs";

const MAX_TEXT = 500, MAX_TOOL = 200;

const stamp = () => {
    const d = new Date(), p = (n) => String(n).padStart(2, "0");
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
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
function frameToEntries(frame) {
    if (!frame || typeof frame !== "object") return [{ kind: "raw", text: oneLine(frame, MAX_TEXT) }];
    if (frame.type === "system") {
        // 纯遥测帧（thinking_tokens 等计数心跳）不进时间线；init 保留
        if (frame.subtype && frame.subtype !== "init") return [];
        return [{ kind: "init", text: oneLine("会话初始化" + (frame.model ? " · 模型 " + frame.model : ""), MAX_TEXT) }];
    }
    if (frame.type === "assistant") {
        const blocks = Array.isArray(frame.message?.content) ? frame.message.content : [];
        return blocks.map((block) => {
            if (block?.type === "thinking") return { kind: "think", text: oneLine(block.thinking, MAX_TEXT) };
            if (block?.type === "text") return { kind: "text", text: oneLine(block.text, MAX_TEXT) };
            if (block?.type === "tool_use") return { kind: "tool", text: oneLine(`${block.name || "工具"} ${inputSummary(block.input)}`.trim(), MAX_TOOL) };
            return null;
        }).filter(Boolean);
    }
    if (frame.type === "user") return []; // tool_result 噪音，不进时间线
    if (frame.type === "result") {
        const parts = [oneLine(frame.result || frame.resultText || "", MAX_TEXT)];
        if (Number.isFinite(frame.num_turns)) parts.push(`${frame.num_turns} 轮`);
        return [{ kind: "result", text: parts.filter(Boolean).join(" · ") }];
    }
    return [{ kind: "raw", text: oneLine(JSON.stringify(frame), MAX_TEXT) }];
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
