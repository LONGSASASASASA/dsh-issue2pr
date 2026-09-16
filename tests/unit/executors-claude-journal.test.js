// tests/unit/executors-claude-journal.test.js — claude-code 委外全过程留档（修复清单 20260916-001 TASK-08）
// 覆盖验收：启动快照（prompt/任务包/参数/模型，token 不落盘）、stderr 流式写盘、
// 退出判定读盘（脱离 2MB 内存上限）、超时/强制终止/执行器异常后的内容可恢复与完整性、
// 留档写失败降级（执行不受影响但如实标记 write_failed）。
// 故障注入用真实 FS 手段（manifest 置只读 → 原子写 rename 失败），不因难以构造而跳过。
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import executor from "../../lib/delegate/executors/claude-code.js";
import { readJournal } from "../../lib/infra/journal.js";

const RELAY = { preset: "glm", token: "sk-secret-token" };
const newRoot = () => mkdtempSync(join(tmpdir(), "i2p-claude-journal-"));
// journal 流分片按清单顺序拼接还原完整流（与执行器内 readJournalStream 同口径）
const streamText = (dir) => {
    const j = readJournal(dir);
    const streams = Array.isArray(j.manifest.streams) ? j.manifest.streams : [];
    return Buffer.concat(streams.map((s) => readFileSync(join(dir, s.file)))).toString("utf8");
};
const recordsOf = (dir) => readFileSync(join(dir, readJournal(dir).shards[0].file), "utf8").trim().split("\n").map(JSON.parse);

test("启动快照与身份关联：prompt 全文、任务包引用、参数与模型进 records journal，token 不落盘", async () => {
    const root = newRoot(), logPath = join(root, "external-exec.log");
    const taskContent = "# 任务包\n修复登录超时问题\n";
    mkdirSync(join(root, "06-implementation"), { recursive: true });
    writeFileSync(join(root, "06-implementation", "session-task.md"), taskContent);
    const rcx = {
        run: { id: "run-j1", stages: { P6: { startedAt: new Date().toISOString(), stageExecutionId: "P6-20260916-120000-abcdef123456" } } },
        spawnExternal: async () => ({ code: 0, stdout: '{"type":"result","result":"ok","usage":{"input_tokens":3}}', stderr: "" }),
    };
    const out = await executor.run({ rcx, bin: "claude", repoDir: root, runDir: root, prompt: "包装后的完整任务 prompt", timeoutMs: 12345, params: { claudePermission: "acceptEdits" }, auth: RELAY, logPath });
    assert.equal(out.failure, null);
    const dir = join(root, "external-exec.records.journal");
    const meta = readJournal(dir).manifest.meta;
    assert.equal(meta.executor, "claude-code");
    assert.equal(meta.stream, "records");
    assert.equal(meta.runId, "run-j1");
    assert.equal(meta.stage, "P6");
    assert.equal(meta.stageExecutionId, "P6-20260916-120000-abcdef123456");
    assert.ok(meta.captureId, "captureId 必须随 meta 落盘");
    const lines = recordsOf(dir);
    const start = lines.find((l) => l.kind === "start"), exit = lines.find((l) => l.kind === "exit");
    assert.equal(start.prompt, "包装后的完整任务 prompt");
    assert.equal(start.permission, "acceptEdits");
    assert.equal(start.timeoutMs, 12345);
    assert.equal(start.authPreset, "glm");
    assert.equal(start.model, "glm-5.3", "glm 中转的实际模型映射来自 --settings");
    assert.equal(start.settingsUsed, true);
    assert.ok(start.spawnArgs.some((a) => a === "--settings"), "中转生效时 spawn 参数含 --settings");
    assert.deepEqual(Object.keys(start.taskPackage), ["path", "bytes", "sha256"]);
    assert.equal(start.taskPackage.bytes, Buffer.byteLength(taskContent, "utf8"));
    assert.equal(exit.code, 0);
    assert.equal(exit.cancelled, false);
    assert.equal(exit.timeout, false);
    assert.equal(start.captureId, exit.captureId, "start/exit 记录同 captureId");
    assert.equal(start.stageExecutionId, meta.stageExecutionId, "记录级身份与 manifest meta 一致");
    assert.ok(!JSON.stringify(lines).includes("sk-secret-token"), "留档不得出现 token 明文");
    // 补全①：outcome 暴露 journal 目录（runDir 相对、/ 分隔）与各流封存完整性——失败时贯通 st.errorInfo.logRefs
    assert.equal(out.journal.dirs.records, "external-exec.records.journal");
    assert.equal(out.journal.dirs.stdout, "external-exec.stdout.journal");
    assert.equal(out.journal.dirs.stderr, "external-exec.stderr.journal");
    assert.equal(out.journal.records, "complete");
    assert.equal(out.journal.stdout, "complete");
});

test("stderr 流式写盘：跨 UTF-8 字节分片拼接还原，旧日志尾部兼容保留", async () => {
    const root = newRoot(), logPath = join(root, "external-exec.log");
    const text = "警告：某个依赖缺失 😀 继续重试\n".repeat(80);
    const bytes = Buffer.from(text);
    const rcx = { spawnExternal: async ({ onStdoutChunk, onStderrChunk }) => {
        onStdoutChunk('{"type":"result","result":"done","usage":{"input_tokens":1}}\n');
        for (let i = 0; i < bytes.length; i += 5) onStderrChunk(bytes.subarray(i, i + 5)); // 故意在多字节字符中间切
        return { code: 0, stdout: "", stderr: text.slice(0, 120) }; // 内存版仅剩残段
    } };
    const out = await executor.run({ rcx, bin: "claude", repoDir: root, runDir: root, prompt: "p", timeoutMs: 1000, logPath });
    assert.equal(out.failure, null);
    assert.equal(streamText(join(root, "external-exec.stderr.journal")), text, "stderr 完整历史在盘，不受内存截断影响");
    assert.match(readFileSync(logPath, "utf8"), /--- stderr ---/, "旧读取端依赖的尾部标记保留");
});

test("退出判定读盘：内存 stdout 只剩残段时，完整折叠解析来自 journal 分片", async () => {
    const root = newRoot(), logPath = join(root, "external-exec.log");
    const full = JSON.stringify({ type: "system", subtype: "init", session_id: "disk-session" }) + "\n"
        + JSON.stringify({ type: "result", result: "完整结论", num_turns: 9, usage: { input_tokens: 42, output_tokens: 7 } }) + "\n";
    const bytes = Buffer.from(full);
    const rcx = { spawnExternal: async ({ onStdoutChunk }) => {
        for (let i = 0; i < bytes.length; i += 3) onStdoutChunk(bytes.subarray(i, i + 3));
        return { code: 0, stdout: full.slice(0, 40), stderr: "" }; // 模拟 2MB 上限下内存累积丢失
    } };
    const out = await executor.run({ rcx, bin: "claude", repoDir: root, runDir: root, prompt: "p", timeoutMs: 1000, logPath });
    assert.equal(out.journal.stdoutSource, "disk");
    assert.equal(out.sessionId, "disk-session");
    assert.equal(out.resultText, "完整结论");
    assert.equal(out.stats.turns, 9);
    assert.equal(out.failure, null);
    assert.equal(out.journal.stdout, "complete");
    assert.equal(out.journal.records, "complete");
});

test("注入路径整段 stdout：未流式返回也补进 journal，盘仍是完整来源", async () => {
    const root = newRoot(), logPath = join(root, "external-exec.log");
    const stdout = '{"type":"result","result":"整段注入","usage":{"input_tokens":2}}';
    const rcx = { spawnExternal: async () => ({ code: 0, stdout, stderr: "整段 stderr" }) };
    const out = await executor.run({ rcx, bin: "claude", repoDir: root, runDir: root, prompt: "p", timeoutMs: 1000, logPath });
    assert.equal(out.journal.stdoutSource, "disk");
    assert.equal(out.resultText, "整段注入");
    assert.equal(streamText(join(root, "external-exec.stderr.journal")), "整段 stderr");
});

test("超时回收：exit 记录 timeout，journal 封存完整，异常退出前已收内容仍可恢复", async () => {
    const root = newRoot(), logPath = join(root, "external-exec.log");
    const partial = '{"type":"assistant","message":{"content":[{"type":"text","text":"超时前的半截输出"}]}}\n';
    const rcx = { spawnExternal: async ({ onStdoutChunk }) => {
        onStdoutChunk(partial);
        return { code: -2, timeout: true, signal: null, stdout: "", stderr: "" };
    } };
    const out = await executor.run({ rcx, bin: "claude", repoDir: root, runDir: root, prompt: "p", timeoutMs: 1000, logPath });
    assert.equal(out.failure.kind, "timeout");
    assert.ok(streamText(join(root, "external-exec.stdout.journal")).includes("超时前的半截输出"), "已写盘内容可恢复");
    const exit = recordsOf(join(root, "external-exec.records.journal")).find((l) => l.kind === "exit");
    assert.equal(exit.timeout, true);
    assert.equal(exit.code, -2);
    assert.equal(readJournal(join(root, "external-exec.stdout.journal")).status, "sealed");
});

test("外部终止痕迹：signal 与退出码进入 exit 记录，cancelled 默认 false", async () => {
    const root = newRoot(), logPath = join(root, "external-exec.log");
    const rcx = { spawnExternal: async () => ({ code: -1, signal: "SIGKILL", stdout: "", stderr: "" }) };
    const out = await executor.run({ rcx, bin: "claude", repoDir: root, runDir: root, prompt: "p", timeoutMs: 1000, logPath });
    assert.equal(out.failure.kind, "exit");
    assert.equal(out.signal, "SIGKILL");
    const exit = recordsOf(join(root, "external-exec.records.journal")).find((l) => l.kind === "exit");
    assert.equal(exit.signal, "SIGKILL");
    assert.equal(exit.cancelled, false);
});

test("执行器异常退出：run 抛出原异常，journal 已封存 failed 态且已写内容保留", async () => {
    const root = newRoot(), logPath = join(root, "external-exec.log");
    const rcx = { spawnExternal: async ({ onStdoutChunk }) => { onStdoutChunk("崩溃前的半截"); throw new Error("注入崩溃"); } };
    await assert.rejects(
        executor.run({ rcx, bin: "claude", repoDir: root, runDir: root, prompt: "p", timeoutMs: 1000, logPath }),
        /注入崩溃/);
    const j = readJournal(join(root, "external-exec.records.journal"));
    assert.equal(j.status, "sealed");
    assert.equal(j.manifest.closedStatus, "failed");
    assert.ok(streamText(join(root, "external-exec.stdout.journal")).includes("崩溃前的半截"));
});

test("留档写失败降级：manifest 置只读 → 清单更新失败，seal 如实标记 write_failed，执行结果不受影响", async () => {
    const root = newRoot(), logPath = join(root, "external-exec.log");
    const rcx = { spawnExternal: async ({ onStdoutChunk }) => {
        // start 记录已落盘；此后原子写清单（rename 覆盖只读目标）失败，等价模拟留档写入故障
        chmodSync(join(root, "external-exec.records.journal", "manifest.json"), 0o444);
        onStdoutChunk('{"type":"result","result":"业务正常","usage":{"input_tokens":5}}\n');
        return { code: 0, stdout: "", stderr: "" };
    } };
    const out = await executor.run({ rcx, bin: "claude", repoDir: root, runDir: root, prompt: "p", timeoutMs: 1000, logPath });
    assert.equal(out.failure, null, "留档故障不得伪装成业务失败");
    assert.equal(out.resultText, "业务正常");
    assert.equal(out.journal.records, "write_failed", "留档自身故障如实标记");
    assert.equal(out.journal.stdout, "complete", "stdout 流未受清单故障影响");
    chmodSync(join(root, "external-exec.records.journal", "manifest.json"), 0o666); // 恢复写位便于清理
});

test("无 logPath：journal 缺席时判定回退内存形态，unavailable 如实报告", async () => {
    const root = newRoot();
    const rcx = { spawnExternal: async () => ({ code: 0, stdout: '{"type":"result","result":"mem","usage":{"input_tokens":2}}', stderr: "" }) };
    const out = await executor.run({ rcx, bin: "claude", repoDir: root, runDir: root, prompt: "p", timeoutMs: 1000 });
    assert.equal(out.resultText, "mem");
    assert.equal(out.journal.stdoutSource, "memory");
    assert.equal(out.journal.stdout, "unavailable");
    assert.equal(out.journal.records, "unavailable");
});
