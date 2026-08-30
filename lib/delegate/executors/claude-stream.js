// lib/delegate/executors/claude-stream.js — claude CLI 输出折叠解析
// 输入：-p --output-format stream-json 的 NDJSON 帧（system/init、assistant、result），
// 或旧版 --output-format json 的单个 result 对象（注入测试/老版本 CLI 兜底）。
// 版本容错：无法解析的行直接跳过；一个可解析帧都没有时退回整体单 JSON 解析。
// 只做纯解析不做 IO，便于单测覆盖各分支。

function textOfContent(content) {
    if (typeof content === "string") return content;
    if (Array.isArray(content)) return content.filter((b) => b && b.type === "text").map((b) => b.text || "").join("");
    return "";
}

// result 帧/对象 → 摘要字段（stats 字段名与 p6 的 externalExec.stats 对齐）
function applyResult(out, j) {
    out.resultIsError = Boolean(j.is_error);
    out.resultText = j.result === undefined || j.result === null ? "" : String(j.result);
    if (j.session_id) out.sessionId = String(j.session_id);
    const usage = (j.usage && typeof j.usage === "object") ? j.usage : null;
    const inTok = Number(usage?.input_tokens) || 0;
    const outTok = Number(usage?.output_tokens) || 0;
    // 0 token 是 API 级失败的强特征（认证/网络错误时 usage 全零）；usage 缺失视为未知而非 0
    out.zeroUsage = usage !== null && inTok + outTok === 0;
    if (j.num_turns !== undefined || j.total_cost_usd !== undefined || j.duration_ms !== undefined) {
        out.stats = {
            turns: j.num_turns,
            costUsd: j.total_cost_usd,
            durationMs: j.duration_ms,
            result: out.resultText.slice(0, 1000),
        };
    }
}

/**
 * 折叠 claude CLI 的原始 stdout。
 *
 * @param {string} rawText - stdout 原文（NDJSON 帧流或单个 JSON 对象）
 * @returns {{ sessionId: string, lastAssistantText: string, resultText: string,
 *             resultIsError: boolean, zeroUsage: boolean,
 *             stats: { turns: number, costUsd: number, durationMs: number, result: string } | null }}
 */
export function foldClaudeOutput(rawText) {
    const out = { sessionId: "", lastAssistantText: "", resultText: "", resultIsError: false, zeroUsage: false, stats: null };
    const text = String(rawText || "");
    let frames = 0;
    for (const line of text.split(/\r?\n/)) {
        const t = line.trim();
        if (!t) continue;
        let j;
        try { j = JSON.parse(t); } catch { continue; }
        // 只认流协议对象（必有 type）；旧版单 JSON（num_turns/result 等字段、无 type）
        // 不能计入帧数，否则兜底分支被跳过、字段全空
        if (!j || typeof j !== "object" || j.type === undefined) continue;
        frames += 1;
        if (j.type === "system" && j.subtype === "init" && j.session_id) out.sessionId = String(j.session_id);
        if (j.type === "assistant" && j.message) {
            const t2 = textOfContent(j.message.content);
            if (t2) out.lastAssistantText = t2;
            if (j.session_id) out.sessionId = String(j.session_id);
        }
        if (j.type === "result") applyResult(out, j);
    }
    if (!frames) {
        // 兜底：整个 stdout 是单个 result 对象（旧 --output-format json）
        try {
            const j = JSON.parse(text.trim());
            if (j && typeof j === "object" && (j.type === "result" || j.result !== undefined || j.is_error !== undefined)) {
                applyResult(out, j);
            }
        } catch { /* 输出不可解析：字段全空，失败分类交给退出码/stderr */ }
    }
    return out;
}
