// tests/unit/claude-stream.test.js — claude CLI 输出折叠解析（stream-json 帧 + 旧 JSON 兜底）
import { test } from "node:test";
import assert from "node:assert/strict";
import { foldClaudeOutput } from "../../lib/delegate/executors/claude-stream.js";

test("foldClaudeOutput：stream-json 正常帧流 → session_id/末条 assistant 文本/stats", () => {
    const ndjson = [
        JSON.stringify({ type: "system", subtype: "init", session_id: "sess-1", tools: ["Bash"] }),
        JSON.stringify({ type: "assistant", session_id: "sess-1", message: { content: [{ type: "text", text: "正在分析任务包" }] } }),
        JSON.stringify({ type: "assistant", session_id: "sess-1", message: { content: [{ type: "tool_use", id: "t1" }, { type: "text", text: "开始写补丁" }] } }),
        JSON.stringify({ type: "result", subtype: "success", session_id: "sess-1", is_error: false, result: "已全部完成",
            duration_ms: 63000, num_turns: 5, total_cost_usd: 0.42,
            usage: { input_tokens: 1200, output_tokens: 300 } }),
    ].join("\n");
    const out = foldClaudeOutput(ndjson);
    assert.equal(out.sessionId, "sess-1");
    assert.equal(out.lastAssistantText, "开始写补丁"); // 只取 text block，跳过 tool_use
    assert.equal(out.resultIsError, false);
    assert.equal(out.resultText, "已全部完成");
    assert.equal(out.zeroUsage, false);
    assert.deepEqual(out.stats, { turns: 5, costUsd: 0.42, durationMs: 63000, result: "已全部完成" });
});

test("foldClaudeOutput：result.is_error + 0 token（403 类 API 级失败特征）→ 双双识别", () => {
    // 用户实测形态：is_error=true、usage 全零、stop_reason 异常
    const ndjson = [
        JSON.stringify({ type: "system", subtype: "init", session_id: "sess-2" }),
        JSON.stringify({ type: "result", subtype: "error_during_execution", session_id: "sess-2", is_error: true,
            result: "API Error: 403 IP access denied by API-Key restrictions", duration_api_ms: 0,
            usage: { input_tokens: 0, output_tokens: 0 } }),
    ].join("\n");
    const out = foldClaudeOutput(ndjson);
    assert.equal(out.resultIsError, true);
    assert.equal(out.zeroUsage, true);
    assert.match(out.resultText, /403/);
    assert.equal(out.stats, null); // 无 num_turns/cost/duration 字段 → 无统计
});

test("foldClaudeOutput：旧版单 JSON 输出（--output-format json）兜底解析", () => {
    const out = foldClaudeOutput('{"num_turns":5,"total_cost_usd":0.42,"duration_ms":63000,"result":"已全部完成","session_id":"sess-3","is_error":false}');
    assert.equal(out.sessionId, "sess-3");
    assert.equal(out.stats.turns, 5);
    assert.equal(out.stats.costUsd, 0.42);
    assert.equal(out.resultIsError, false);
});

test("foldClaudeOutput：usage 缺失视为未知而非 0（zeroUsage=false）", () => {
    const out = foldClaudeOutput('{"result":"done","is_error":false}');
    assert.equal(out.zeroUsage, false);
});

test("foldClaudeOutput：不可解析输出 → 字段全空不抛错；垃圾行混在帧流中被跳过", () => {
    const empty = foldClaudeOutput("");
    assert.equal(empty.sessionId, "");
    assert.equal(empty.stats, null);
    const mixed = foldClaudeOutput([
        "not-json-prefix-line",
        JSON.stringify({ type: "result", is_error: false, result: "ok", num_turns: 1, usage: { input_tokens: 5, output_tokens: 5 } }),
    ].join("\n"));
    assert.equal(mixed.resultText, "ok");
    assert.equal(mixed.stats.turns, 1);
    const garbage = foldClaudeOutput("随机输出没有 JSON");
    assert.equal(garbage.stats, null);
    assert.equal(garbage.resultIsError, false);
});
