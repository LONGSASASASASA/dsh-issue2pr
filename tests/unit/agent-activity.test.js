import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, utimesSync, symlinkSync, unlinkSync, rmdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { createAgentActivityWriter, readAgentActivity, AGENT_ACTIVITY_PATH } from "../../lib/delegate/agentActivity.js";

const CAPTURE = "11111111-1111-4111-8111-111111111111", OTHER = "22222222-2222-4222-8222-222222222222";
const START = "2026-09-14T08:42:14.027Z";
const call = (id, input = {}) => ({ type: "assistant", message: { content: [{ type: "tool_use", id, name: "Bash", input }] } });
const result = (id, content, details = {}) => ({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content, is_error: false }] }, tool_use_result: details });
const system = (subtype, extra = {}) => ({ type: "system", subtype, ...extra });
const runFor = (captureId = CAPTURE) => ({ stages: { P6: { status: "running", startedAt: START } },
    externalExec: { executor: "claude-code", captureId, stageStartedAt: START, startedAt: START, status: "running" } });
function fixture(t, options = {}) {
    const runDir = mkdtempSync(join(tmpdir(), "i2p-activity-"));
    let ms = Date.parse(START);
    const writer = createAgentActivityWriter({ runDir, captureId: CAPTURE, stageStartedAt: START, now: () => ms, flushMs: 60_000, ...options });
    t.after(() => { writer.dispose(); rmSync(runDir, { recursive: true, force: true }); });
    return { runDir, writer, run: runFor(), advance: delta => { ms += delta; },
        disk: () => JSON.parse(readFileSync(join(runDir, AGENT_ACTIVITY_PATH), "utf8")) };
}

test("活动：推理心跳独立更新，计数和未知系统帧不冒充可见动作", t => {
    const f = fixture(t), w = f.writer;
    w.observe(call("read", { command: "cat package.json" }));
    const lastAction = w.snapshot().lastAction;
    f.advance(5000);
    assert.equal(w.observe(system("thinking_tokens", { estimated_tokens: 9, estimated_tokens_delta: 9 })), true);
    const s = w.snapshot();
    assert.equal(s.phase, "thinking"); assert.deepEqual(s.lastAction, lastAction);
    assert.equal(Date.parse(s.lastSignalAt) - Date.parse(lastAction.at), 5000);
    assert.deepEqual(s.thinking, { estimatedTokens: 9, signals: 1 });
    f.advance(5000);
    assert.equal(w.observe(system("thinking_tokens", { estimated_tokens: 9, estimated_tokens_delta: 0 })), false);
    assert.equal(w.observe(system("rate_limit_event", { status: "allowed" })), false);
    assert.equal(w.observe({ type: "keep_alive" }), false);
    assert.equal(w.snapshot().lastSignalAt, s.lastSignalAt);
    assert.equal("percent" in w.snapshot(), false);
});

test("活动：安装在后台提交后继续运行，与推理并存，完成通知才确认退出", t => {
    const { writer: w, advance } = fixture(t);
    w.observe(call("npm-call", { command: "npm install", description: "安装依赖", run_in_background: true }));
    advance(10);
    w.observe(system("background_tasks_changed", { tasks: [{ task_id: "npm-task", description: "安装依赖", task_type: "local_bash" }] }));
    w.observe(system("task_started", { task_id: "npm-task", tool_use_id: "npm-call", description: "安装依赖", is_backgrounded: true }));
    w.observe(result("npm-call", "Command running in background", { backgroundTaskId: "npm-task", stdout: "" }));
    assert.equal(w.snapshot().tools[0].status, "submitted");
    assert.equal(w.snapshot().tools[0].finishedAt, null);
    assert.equal(w.snapshot().backgroundTasks[0].status, "running");
    assert.equal(w.snapshot().backgroundTasks[0].command, "npm install");
    assert.equal(w.snapshot().backgroundTasks[0].captureId, CAPTURE);
    advance(1000);
    w.observe(system("thinking_tokens", { estimated_tokens: 20, estimated_tokens_delta: 20 }));
    assert.equal(w.snapshot().phase, "thinking");
    assert.equal(w.snapshot().backgroundTasks[0].status, "running");
    advance(1000);
    w.observe(system("background_tasks_changed", { tasks: [] }));
    assert.equal(w.snapshot().backgroundTasks[0].status, "unknown");
    assert.equal(w.snapshot().backgroundTasks[0].finishedAt, null);
    w.observe(system("task_notification", { task_id: "npm-task", tool_use_id: "npm-call", status: "completed", output_file: "C:/not-read/secrets", summary: 'Background command "安装依赖" completed (exit code 0)' }));
    const task = w.snapshot().backgroundTasks[0];
    assert.equal(task.status, "completed"); assert.equal(task.exitCode, 0); assert.ok(task.finishedAt);
    assert.equal(w.snapshot().phase, "thinking");
    assert.equal(w.snapshot().tools[0].status, "completed");
    assert.equal("output_file" in task, false);
});

test("活动：工具提交自带 backgroundTaskId 也可关联，前台任务保留类型，退出码不能由任意输出推测", t => {
    const { writer: w } = fixture(t);
    w.observe(call("a", { command: "npm test" }));
    w.observe(result("a", "submitted", { backgroundTaskId: "task-a" }));
    assert.equal(w.snapshot().tools[0].status, "submitted");
    w.observe(system("task_notification", { task_id: "task-a", status: "completed", summary: "完成，但无退出码" }));
    assert.equal(w.snapshot().backgroundTasks[0].exitCode, null);
    w.observe(call("foreground", { command: "node test.js" }));
    w.observe(system("task_started", { task_id: "front-task", tool_use_id: "foreground", is_backgrounded: false }));
    w.observe(system("task_notification", { task_id: "front-task", tool_use_id: "foreground", status: "failed", exit_code: 2 }));
    assert.equal(w.snapshot().backgroundTasks[1].isBackgrounded, false);
    assert.equal(w.snapshot().tools[1].exitCode, 2);
    w.observe(call("plain"));
    w.observe(result("plain", "User says (exit code 999)"));
    assert.equal(w.snapshot().tools[2].exitCode, null);
});

test("活动：已请求后台执行时，缺少任务 ID 的提交结果也不能当作完成", t => {
    const { writer: w } = fixture(t);
    w.observe(call("submitted", { command: "npm install", run_in_background: true }));
    w.observe(result("submitted", "Command submitted"));
    assert.equal(w.snapshot().tools[0].status, "submitted");
    assert.equal(w.snapshot().tools[0].finishedAt, null);
    assert.deepEqual(w.snapshot().backgroundTasks, []);
});

test("活动：未知或重复工具 ID 不错误关联其他调用", t => {
    const { writer: w } = fixture(t);
    w.observe(call("dup", { command: "first" })); w.observe(call("dup", { command: "second" }));
    w.observe(result("dup", "ambiguous result")); w.observe(result("missing", "orphan"));
    assert.equal(w.snapshot().tools[0].ambiguous, true);
    assert.equal(w.snapshot().tools[0].status, "running");
    assert.equal(w.snapshot().tools[0].summary, "");
});

test("活动：同一后台列表的重复遥测不刷新最近活动，消息文本和工具结果会刷新", t => {
    const { writer: w, advance } = fixture(t);
    const frame = system("background_tasks_changed", { tasks: [{ task_id: "task-a", description: "安装" }] });
    w.observe(frame); const first = w.snapshot().lastSignalAt;
    advance(1000); assert.equal(w.observe(frame), false); assert.equal(w.snapshot().lastSignalAt, first);
    w.observe({ type: "assistant", message: { content: [{ type: "text", text: "接下来运行测试" }] } });
    assert.equal(w.snapshot().phase, "responding");
    assert.equal(w.snapshot().lastAction.summary, "接下来运行测试");
});

test("活动：心跳批次节流，显式 flush 产生可读的原子快照", async t => {
    const f = fixture(t, { flushMs: 20 }), initial = readFileSync(join(f.runDir, AGENT_ACTIVITY_PATH), "utf8");
    for (let i = 1; i <= 100; i++) f.writer.observe(system("thinking_tokens", { estimated_tokens: i, estimated_tokens_delta: 1 }));
    assert.equal(readFileSync(join(f.runDir, AGENT_ACTIVITY_PATH), "utf8"), initial);
    await delay(60);
    const actual = await readAgentActivity(f.runDir, f.run);
    assert.equal(actual.status, "available"); assert.equal(actual.thinking.signals, 100);
    assert.equal(actual.thinking.estimatedTokens, 100);
    f.writer.observe(call("last")); f.writer.flush(); assert.equal(f.disk().tools[0].id, "last");
});

test("活动：原子替换暂时失败后，无新消息也会重试追上最新快照", async t => {
    const f = fixture(t, { flushMs: 20 }), path = join(f.runDir, AGENT_ACTIVITY_PATH), initial = readFileSync(path, "utf8");
    // 目标暂时不可替换：这会在 Windows/POSIX 上稳定触发 rename 失败。
    unlinkSync(path); mkdirSync(path);
    f.writer.observe(system("thinking_tokens", { estimated_tokens: 37, estimated_tokens_delta: 37 }));
    assert.equal(f.writer.flush(), false);
    assert.deepEqual(readdirSync(join(f.runDir, "06-implementation")), ["external-exec.activity.json"], "失败不遗留临时快照");
    rmdirSync(path); writeFileSync(path, initial);
    // 不发送下一帧，不调用 flush；只观察重试是否独立完成。
    let value;
    const deadline = Date.now() + 1500;
    do { await delay(25); value = await readAgentActivity(f.runDir, f.run); }
    while (value.phase !== "thinking" && Date.now() < deadline);
    assert.equal(value.phase, "thinking"); assert.equal(value.thinking.estimatedTokens, 37);
});

test("活动：dispose 清理失败后的重试定时器，不在释放后补写旧快照", async t => {
    const f = fixture(t, { flushMs: 20 }), path = join(f.runDir, AGENT_ACTIVITY_PATH), initial = readFileSync(path, "utf8");
    unlinkSync(path); mkdirSync(path);
    f.writer.observe(system("thinking_tokens", { estimated_tokens: 37, estimated_tokens_delta: 37 }));
    assert.equal(f.writer.flush(), false);
    f.writer.dispose();
    rmdirSync(path); writeFileSync(path, initial);
    await delay(300);
    assert.equal(readFileSync(path, "utf8"), initial);
    assert.equal(f.writer.observe(call("after-dispose")), false);
});

test("活动：结束快照在暂时不能替换时有界重试，await finish 后 dispose 仍保留终态", async t => {
    const f = fixture(t), path = join(f.runDir, AGENT_ACTIVITY_PATH), initial = readFileSync(path, "utf8");
    unlinkSync(path); mkdirSync(path);
    const finished = f.writer.finish({ code: -2, timeout: true });
    assert.equal(f.writer.snapshot().phase, "timeout", "内存终态立即更新");
    await delay(25);
    rmdirSync(path); writeFileSync(path, initial);
    assert.equal(await finished, true);
    f.writer.dispose();
    assert.equal(f.disk().phase, "timeout"); assert.ok(f.disk().finishedAt);
});

test("活动：结束快照永久无法写入时有限返回，dispose 后不会继续重试", async t => {
    const f = fixture(t), path = join(f.runDir, AGENT_ACTIVITY_PATH), initial = readFileSync(path, "utf8");
    unlinkSync(path); mkdirSync(path);
    const started = Date.now();
    assert.equal(await f.writer.finish({ code: 0 }), false);
    assert.ok(Date.now() - started < 2000, "收尾只等待有限写入尝试");
    f.writer.dispose();
    rmdirSync(path); writeFileSync(path, initial);
    await delay(150);
    assert.equal(readFileSync(path, "utf8"), initial);
});

test("活动：finish 固定结束状态但不编造后台完成，随后信号不能复活任务", async t => {
    const f = fixture(t), w = f.writer;
    w.observe(call("pending"));
    w.observe(system("task_started", { task_id: "pending-task", tool_use_id: "pending", is_backgrounded: true }));
    f.advance(10_000); w.finish({ code: -2, timeout: true });
    const value = await readAgentActivity(f.runDir, f.run);
    assert.equal(value.phase, "timeout"); assert.ok(value.finishedAt);
    assert.equal(value.backgroundTasks[0].status, "unknown"); assert.equal(value.backgroundTasks[0].finishedAt, null);
    assert.equal(w.observe(system("thinking_tokens", { estimated_tokens: 200 })), false);
    assert.equal(w.snapshot().phase, "timeout");
});

test("活动：成功、API 失败及用户停止分别保留准确结束状态", t => {
    for (const [outcome, phase] of [[{ code: 0 }, "completed"], [{ code: 0, failure: { message: "API error" } }, "failed"], [{ code: -1, stopped: true }, "stopped"]]) {
        const { writer } = fixture(t); writer.finish(outcome); assert.equal(writer.snapshot().phase, phase);
    }
});

test("活动：capture 和阶段起始时间均必须匹配，旧快照不得串入重跑", async t => {
    const f = fixture(t);
    assert.equal((await readAgentActivity(f.runDir, f.run)).status, "available");
    assert.equal((await readAgentActivity(f.runDir, runFor(OTHER))).status, "unavailable");
    f.run.stages.P6.startedAt = "2026-09-14T09:00:00Z";
    assert.equal((await readAgentActivity(f.runDir, f.run)).status, "unavailable");
    f.run.externalExec.stageStartedAt = f.run.stages.P6.startedAt;
    assert.equal((await readAgentActivity(f.runDir, f.run)).status, "unavailable");
});

test("活动：重跑启动后旧 writer 的延迟写入不能覆盖新快照", t => {
    const f = fixture(t), next = createAgentActivityWriter({ runDir: f.runDir, captureId: OTHER, stageStartedAt: START });
    t.after(() => next.dispose());
    f.writer.observe(call("old")); f.writer.finish({ code: 0 });
    assert.equal(f.disk().captureId, OTHER); assert.deepEqual(f.disk().tools, []);
    next.dispose();
});

test("活动：大量长工具结果和后台任务保持内存及快照有界", async t => {
    const f = fixture(t);
    for (let i = 0; i < 250; i++) {
        f.writer.observe(call("call-" + i, { command: "c".repeat(5000), description: "d".repeat(5000) }));
        f.writer.observe(result("call-" + i, "r".repeat(100_000)));
        f.writer.observe(system("task_started", { task_id: "task-" + i, tool_use_id: "call-" + i, is_backgrounded: true, description: "d".repeat(5000) }));
        f.writer.observe(system("task_notification", { task_id: "task-" + i, status: "completed", summary: "s".repeat(100_000) }));
    }
    f.writer.flush(); const value = await readAgentActivity(f.runDir, f.run);
    assert.equal(value.status, "available"); assert.equal(value.tools.length, 32); assert.equal(value.backgroundTasks.length, 16);
    assert.ok(value.tools.every(tool => tool.command.length <= 1000 && tool.summary.length <= 1600));
    assert.ok(value.backgroundTasks.every(task => task.description.length <= 300 && task.summary.length <= 1600));
});

test("活动：写入失败和损坏或超限快照只让观测不可用", async t => {
    const f = fixture(t);
    writeFileSync(join(f.runDir, AGENT_ACTIVITY_PATH), "{broken");
    assert.equal((await readAgentActivity(f.runDir, f.run)).status, "unavailable");
    writeFileSync(join(f.runDir, AGENT_ACTIVITY_PATH), "x".repeat(300 * 1024));
    assert.equal((await readAgentActivity(f.runDir, f.run)).status, "unavailable");
    const bad = join(f.runDir, "regular-file"); writeFileSync(bad, "not a directory");
    const writer = createAgentActivityWriter({ runDir: bad, captureId: CAPTURE, stageStartedAt: START });
    assert.doesNotThrow(() => { writer.observe(call("call")); writer.flush(); writer.finish({ code: 0 }); writer.dispose(); });
});

test("活动：快照结构逐项校验，白名单不透传额外文件内容或未知字段", async t => {
    const f = fixture(t);
    f.writer.observe(call("tool"));
    f.writer.observe(system("task_started", { task_id: "task", tool_use_id: "tool", is_backgrounded: true }));
    const original = f.writer.snapshot(), path = join(f.runDir, AGENT_ACTIVITY_PATH);
    for (const change of [
        value => { value.tools[0] = null; },
        value => { value.backgroundTasks[0].name = { malicious: true }; },
        value => { value.lastAction = "unexpected"; },
        value => { value.lastAction.summary = []; },
        value => { value.thinking = null; },
        value => { value.phase = { unknown: true }; },
        value => { value.tools[0].captureId = OTHER; },
        value => { value.backgroundTasks[0].status = "invented"; },
    ]) {
        const damaged = structuredClone(original); change(damaged); writeFileSync(path, JSON.stringify(damaged));
        assert.equal((await readAgentActivity(f.runDir, f.run)).status, "unavailable");
    }
    original.extra = { secret: "never returned" }; original.tools[0].stdout = "unbounded output";
    original.backgroundTasks[0].output_file = "outside path"; original.lastAction.extra = "private";
    writeFileSync(path, JSON.stringify(original));
    const value = await readAgentActivity(f.runDir, f.run);
    assert.equal(value.status, "available"); assert.equal(value.extra, undefined);
    assert.equal(value.tools[0].stdout, undefined); assert.equal(value.backgroundTasks[0].output_file, undefined);
    assert.equal(value.lastAction.extra, undefined);
});

test("活动：旧任务只回退固定日志 mtime，拒绝旧轮次或其他执行器", async t => {
    const f = fixture(t), run = runFor(); delete run.externalExec.captureId;
    const log = join(f.runDir, "06-implementation/external-exec.log"); writeFileSync(log, "old log");
    utimesSync(log, new Date(START), new Date(Date.parse(START) + 5000));
    const result = await readAgentActivity(f.runDir, run);
    assert.equal(result.status, "legacy"); assert.equal(result.lastLogUpdateAt, "2026-09-14T08:42:19.027Z");
    assert.equal(result.lastSignalAt, undefined); assert.equal(result.phase, undefined);
    utimesSync(log, new Date(0), new Date(0)); assert.equal((await readAgentActivity(f.runDir, run)).status, "unavailable");
    run.externalExec.executor = "dsh-agent"; assert.equal((await readAgentActivity(f.runDir, run)).status, "unavailable");
});

test("活动：读写均拒绝穿出当前任务目录的软链接", async t => {
    const f = fixture(t), escaped = mkdtempSync(join(tmpdir(), "i2p-activity-outside-"));
    t.after(() => rmSync(escaped, { recursive: true, force: true }));
    f.writer.dispose();
    const dir = join(f.runDir, "06-implementation");
    rmSync(dir, { recursive: true, force: true });
    try { symlinkSync(escaped, dir, process.platform === "win32" ? "junction" : "dir"); }
    catch (error) { if (["EPERM", "EACCES"].includes(error.code)) { t.skip("当前环境不允许创建软链接"); return; } throw error; }
    writeFileSync(join(escaped, "external-exec.activity.json"), JSON.stringify(f.writer.snapshot()));
    assert.equal((await readAgentActivity(f.runDir, f.run)).status, "unavailable");
    const writer = createAgentActivityWriter({ runDir: f.runDir, captureId: OTHER, stageStartedAt: START });
    assert.equal(writer.flush(), false); writer.dispose();
    assert.equal(JSON.parse(readFileSync(join(escaped, "external-exec.activity.json"), "utf8")).captureId, CAPTURE);
    // 单独移除 junction，清理测试目录时不递归进入目标目录。
    rmSync(dir, { recursive: true, force: true }); mkdirSync(dir);
});
