// tests/unit/executors-claude-code.test.js — claude-code 执行器：归一化/失败分类/权限档/日志/token 不落盘
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import executor, { PERMISSION_MODES, killTree, normalizeOutcome, authHintOf } from "../../lib/delegate/executors/claude-code.js";

const RELAY = { preset: "glm", token: "sk-secret-token" };

test("normalizeOutcome：旧形态成功输出 → stats 归一 + failure=null + sessionId", () => {
    const out = normalizeOutcome({ code: 0, stdout: '{"num_turns":3,"total_cost_usd":0.1,"duration_ms":5000,"result":"ok","session_id":"sess-9","is_error":false}', stderr: "" }, null);
    assert.equal(out.sessionId, "sess-9");
    assert.equal(out.stats.turns, 3);
    assert.equal(out.failure, null);
});

test("normalizeOutcome：stream-json 的 result.is_error → failure=result-error，relay 时 hint 指向 token", () => {
    const stdout = [
        JSON.stringify({ type: "system", subtype: "init", session_id: "sess-e" }),
        JSON.stringify({ type: "result", is_error: true, result: "API Error: 403 ...", usage: { input_tokens: 0, output_tokens: 0 } }),
    ].join("\n");
    const plain = normalizeOutcome({ code: 0, stdout, stderr: "" }, null);
    assert.equal(plain.failure.kind, "result-error");
    assert.match(plain.failure.message, /403/);
    assert.match(plain.failure.hint, /Anthropic Console/); // 未中转：指向白名单
    const relay = normalizeOutcome({ code: 0, stdout, stderr: "" }, RELAY);
    assert.match(relay.failure.hint, /中转认证/); // 中转生效：指向 token
});

test("normalizeOutcome：非零退出码 + not logged in → kind=exit + 登录提示（不再误报普通 api key 字样）", () => {
    const out = normalizeOutcome({ code: 1, stdout: "", stderr: "boom: not logged in" }, null);
    assert.equal(out.failure.kind, "exit");
    assert.match(out.failure.message, /boom/);
    assert.match(out.failure.hint, /登录/);
    // 正常输出里出现 "api key" 字样不再触发认证误报（旧正则的误报源）
    const noise = normalizeOutcome({ code: 1, stdout: "we discussed api key rotation", stderr: "exit due to max turns" }, null);
    assert.equal(noise.failure.hint, "");
});

test("normalizeOutcome：spawn 错误 → kind=spawn；0-token 空结果 → kind=empty", () => {
    assert.equal(normalizeOutcome({ code: -1, stdout: "", stderr: "", error: "spawn claude ENOENT" }, null).failure.kind, "spawn");
    const emptyRun = normalizeOutcome({ code: 0, stdout: JSON.stringify({ type: "result", is_error: false, result: "", usage: { input_tokens: 0, output_tokens: 0 } }), stderr: "" }, null);
    assert.equal(emptyRun.failure.kind, "empty");
});

test("normalizeOutcome：超时 → kind=timeout（进程树由 runClaude 超时分支负责杀）", () => {
    assert.equal(normalizeOutcome({ code: -2, stdout: "", stderr: "", timeout: true }, null).failure.kind, "timeout");
});

test("PERMISSION_MODES：默认 acceptEdits 白名单档；bypass 保留旧 flag；dontAsk 最严", () => {
    assert.ok(PERMISSION_MODES.acceptEdits.args.includes("--permission-mode"));
    assert.ok(PERMISSION_MODES.acceptEdits.args.includes("acceptEdits"));
    assert.ok(PERMISSION_MODES.bypass.args.includes("--dangerously-skip-permissions"));
    assert.ok(PERMISSION_MODES.dontAsk.args.includes("dontAsk"));
    // 白名单 token 一律不含空格（shell:true 拼接约束）
    for (const mode of Object.values(PERMISSION_MODES)) {
        for (const a of mode.args) assert.ok(!/\s/.test(a), "参数含空格: " + a);
    }
});

test("executor.run：注入 spawnExternal → 归一结果 + 日志落盘 + --settings 临时文件用后即删", async () => {
    const root = mkdtempSync(join(tmpdir(), "i2p-exec-"));
    const logPath = join(root, "external-exec.log");
    let seenSettingsPath = "";
    const rcx = {
        spawnExternal: async (opts) => {
            assert.equal(opts.env.ANTHROPIC_BASE_URL, "https://open.bigmodel.cn/api/anthropic"); // 认证 env 注入到真实 spawn 参数
            assert.equal(opts.env.ANTHROPIC_AUTH_TOKEN, "sk-secret-token");
            assert.equal(opts.env.ANTHROPIC_API_KEY, "");
            assert.ok(opts.settingsPath, "中转生效时应传 --settings 临时文件路径");
            seenSettingsPath = opts.settingsPath;
            const relaySettings = JSON.parse(readFileSync(opts.settingsPath, "utf8"));
            assert.equal(relaySettings.env.ANTHROPIC_AUTH_TOKEN, "sk-secret-token");
            assert.equal(relaySettings.env.ANTHROPIC_MODEL, "glm-5.3"); // 模型映射一并覆盖
            return { code: 0, stdout: '{"num_turns":2,"total_cost_usd":0.05,"duration_ms":8000,"result":"done","session_id":"sess-r","is_error":false}', stderr: "" };
        },
    };
    const out = await executor.run({ rcx, bin: "claude", repoDir: root, runDir: root, prompt: "p", timeoutMs: 60000, params: { claudePermission: "acceptEdits" }, auth: RELAY, logPath });
    assert.equal(out.sessionId, "sess-r");
    assert.equal(out.stats.turns, 2);
    assert.equal(existsSync(seenSettingsPath), false); // 临时文件（含 token）跑完即删
    assert.ok(existsSync(logPath));
    const log = readFileSync(logPath, "utf8");
    assert.match(log, /auth=glm/); // 只记 preset 名
    assert.ok(!log.includes("sk-secret-token"), "日志不得出现 token 明文");
    assert.match(log, /--- exit=0 ---/);
});

test("executor.run：时间线文件 —— stream-json 帧写入时格式化为 时间|kind|内容，原始日志不动", async () => {
    const root = mkdtempSync(join(tmpdir(), "i2p-timeline-"));
    const logPath = join(root, "external-exec.log");
    const timelinePath = join(root, "external-exec.timeline.log");
    const frames = [
        '{"type":"system","subtype":"init","model":"claude-x"}',
        '{"type":"assistant","message":{"content":[{"type":"thinking","thinking":"先看代码"}]}}',
        '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Read","input":{"file_path":"src/index.js"}}]}}',
        '{"type":"assistant","message":{"content":[{"type":"text","text":"找到了符号选择分支"}]}}',
        'not-json garbage',
        '{"type":"result","subtype":"success","num_turns":3,"result":"全部完成"}',
    ].join("\n") + "\n";
    const rcx = { spawnExternal: async (opts) => { opts.onStdoutChunk(frames); return { code: 0, stdout: frames, stderr: "" }; } };
    const out = await executor.run({ rcx, bin: "claude", repoDir: root, runDir: root, prompt: "p", timeoutMs: 60000, params: { claudePermission: "acceptEdits" }, auth: null, logPath, timelinePath });
    const raw = readFileSync(logPath, "utf8");
    assert.match(raw, /{"type":"system"/, "原始日志保真");
    const timeline = readFileSync(timelinePath, "utf8").split("\n").filter(Boolean);
    const kinds = timeline.map((l) => l.split("|")[1]);
    assert.deepEqual(kinds, ["init", "init", "think", "tool", "text", "raw", "result", "exit"],
      "任务包 init + 帧序列 + 退出行");
    assert.match(timeline[3], /tool\|Read src\/index\.js/);
    assert.match(timeline[6], /result|全部完成 · 3 轮/);
    for (const l of timeline) assert.match(l, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\|/, "每行 完整时间|kind|内容（二期 E2 写入含日期）");
});

test("executor.run：无中转 → 不产生 settings 临时文件（用户 settings 全量生效）", async () => {
    const root = mkdtempSync(join(tmpdir(), "i2p-exec-"));
    let seenSettingsPath = "__unset__";
    const rcx = { spawnExternal: async (opts) => { seenSettingsPath = opts.settingsPath || ""; return { code: 0, stdout: "", stderr: "" }; } };
    await executor.run({ rcx, bin: "claude", repoDir: root, runDir: root, prompt: "p", timeoutMs: 1000, auth: null });
    assert.equal(seenSettingsPath, "");
});

test("killTree：已退出/缺进程时不动作（不误杀无关 pid）", () => {
    assert.equal(killTree(null), false);
    assert.equal(killTree({ pid: 123, exitCode: 0, signalCode: null }), false);
    assert.equal(killTree({ pid: 123, exitCode: null, signalCode: "SIGTERM" }), false);
});

test("authHintOf：relay 感知——403 在中转下指向 token，非中转下指向 IP 白名单", () => {
    assert.match(authHintOf("403 forbidden", true), /中转/);
    assert.match(authHintOf("403 ip access denied by API-Key restrictions", false), /IP 白名单|IP 访问限制/);
    assert.equal(authHintOf("一切正常", false), "");
});

test("executor.run：分片 stdout 的完整 JSON 落盘，跨 UTF-8 字节与无换行尾帧均可回读", async () => {
    const root = mkdtempSync(join(tmpdir(), "i2p-raw-stream-")), logPath = join(root, "external-exec.log");
    const frames = [
        { type: "assistant", session_id: "raw-session", extra: { preserved: true }, message: { id: "m", content: [
            { type: "tool_use", id: "tool-a", name: "Read", input: { file_path: "中文😀.js", all: "z".repeat(1000) } },
            { type: "text", text: "接着检查" },
        ] } },
        { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tool-a", content: "文件完整结果", is_error: false }] } },
        { type: "result", result: "完成", num_turns: 1, usage: { input_tokens: 20 } },
    ];
    const stdout = frames.map(JSON.stringify).join("\n"), bytes = Buffer.from(stdout);
    const rcx = { spawnExternal: async ({ onStdoutChunk }) => {
        for (let i = 0; i < bytes.length; i += 2) onStdoutChunk(bytes.subarray(i, i + 2));
        return { code: 0, stdout, stderr: "" };
    } };
    const out = await executor.run({ rcx, bin: "claude", repoDir: root, runDir: root, prompt: "p", timeoutMs: 1000, logPath });
    assert.equal(out.failure, null);
    const saved = readFileSync(join(root, "external-exec.messages.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
    assert.deepEqual(saved, frames, "原生未知字段、完整工具参数和工具结果全部保留");
    assert.ok(readFileSync(logPath, "utf8").includes(stdout), "原始 stdout 字节保真");
    const timeline = readFileSync(join(root, "external-exec.timeline.log"), "utf8");
    assert.match(timeline, /Read 中文😀\.js/);
    assert.ok(!timeline.includes("|raw|"), "合法 JSON 不因 stdout 分片变成坏行");
    const events = readFileSync(join(root, "external-exec.events.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
    assert.equal(events.filter((e) => e.source).length, 4);
    assert.deepEqual(events.filter((e) => e.toolUseId).map((e) => [e.toolUseId, e.relation]), [["tool-a", "call"], ["tool-a", "result"]]);
    assert.deepEqual(events[1].source, events[2].source);
});

test("executor.run：异常退出前的完整尾帧仍留存，不把 stderr 包装成 Agent JSON", async () => {
    const root = mkdtempSync(join(tmpdir(), "i2p-raw-failed-")), logPath = join(root, "external-exec.log");
    const frame = { type: "assistant", message: { content: [{ type: "text", text: "故障前的完整消息" }] } };
    const rcx = { spawnExternal: async ({ onStdoutChunk }) => {
        onStdoutChunk(JSON.stringify(frame));
        return { code: -2, timeout: true, stdout: JSON.stringify(frame), stderr: "network timeout" };
    } };
    const out = await executor.run({ rcx, bin: "claude", repoDir: root, runDir: root, prompt: "p", timeoutMs: 1000, logPath });
    assert.equal(out.failure.kind, "timeout");
    assert.deepEqual(readFileSync(join(root, "external-exec.messages.jsonl"), "utf8").trim().split("\n").map(JSON.parse), [frame]);
    assert.match(readFileSync(logPath, "utf8"), /network timeout/);
    const events = readFileSync(join(root, "external-exec.events.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
    assert.equal(events.at(-1).source, null); assert.match(events.at(-1).text, /超时/);
});

test("executor.run：观测目录写失败不改变正常执行结果，也不会等待失败日志流而悬挂", { timeout: 2000 }, async () => {
    const root = mkdtempSync(join(tmpdir(), "i2p-unwritable-log-"));
    const rcx = { spawnExternal: async () => ({ code: 0, stdout: '{"type":"result","result":"done"}', stderr: "" }) };
    const out = await executor.run({ rcx, bin: "claude", repoDir: root, runDir: root, prompt: "p", timeoutMs: 1000,
        logPath: join(root, "missing-directory", "external-exec.log") });
    assert.equal(out.failure, null);
    assert.equal(out.resultText, "done");
});
