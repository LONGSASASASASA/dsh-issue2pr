import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, rmdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import p8 from "../../lib/stages/p8-test-runner.js";
import { createTestActivity, readTestActivity, TEST_ACTIVITY_PATH, TEST_OUTPUT_PATH } from "../../lib/stages/testActivity.js";

function fixture(t, source, { timeoutMs = 5000, root: existingRoot, startedAt = new Date().toISOString(), name = "test" } = {}) {
  const root = existingRoot || mkdtempSync(join(tmpdir(), "i2pr-p8-live-"));
  if (!existingRoot) t.after(() => {
    assert.ok(resolve(root).startsWith(resolve(tmpdir(), "i2pr-p8-live-")));
    rmSync(root, { recursive: true, force: true });
  });
  const runDir = join(root, "run"); mkdirSync(runDir, { recursive: true });
  const script = join(root, name + ".cjs"); writeFileSync(script, source);
  const command = `"${process.execPath}" "${script}"`;
  const run = { status: "running", current: "P8", stages: { P8: { status: "running", startedAt } } };
  writeFileSync(join(runDir, "run.json"), JSON.stringify(run));
  const rcx = { runDir, repoDir: root, project: { testCommand: command }, run, stageCfgOf: () => ({ timeoutMs }) };
  return { root, runDir, command, run, rcx, output: () => readFileSync(join(runDir, TEST_OUTPUT_PATH), "utf8"), report: () => JSON.parse(readFileSync(join(runDir, "07-test-report.json"), "utf8")) };
}

async function until(read, predicate = value => !!value, timeout = 4000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await read();
    if (predicate(value)) return value;
    await delay(20);
  }
  assert.fail("等待测试条件超时");
}

const heldOpen = `
const fs = require('node:fs');
const hold = setInterval(() => { if (fs.existsSync('release')) { clearInterval(hold); process.exit(0); } }, 20);
setTimeout(() => process.exit(2), 4000).unref();
`;

test("P8 实际子进程执行中持续落 stdout/stderr，跨 UTF-8 分片无损，结束不重复追加", async t => {
  const f = fixture(t, heldOpen + `
const text = Buffer.from('中文输出\\n');
process.stdout.write(text.subarray(0, 1));
setTimeout(() => process.stdout.write(text.subarray(1)), 50);
setTimeout(() => process.stderr.write('stderr detail\\n'), 100);
`);
  let done = false;
  const pending = p8(f.rcx).finally(() => { done = true; });
  await until(f.output, value => value.includes("stderr detail"));
  const live = await readTestActivity(f.runDir, f.run);
  assert.equal(done, false);
  assert.equal(live.executionStatus, "running");
  assert.equal(live.outputReady, true);
  assert.equal(live.process.state, "alive");
  assert.ok(live.lastOutputAt);
  assert.equal(live.outputBytes, Buffer.byteLength("中文输出\nstderr detail\n"));
  assert.equal(f.output(), "中文输出\nstderr detail\n");
  await until(() => JSON.parse(readFileSync(join(f.runDir, TEST_ACTIVITY_PATH), "utf8")), value => value.outputBytes > 0);
  assert.equal(existsSync(join(f.runDir, "07-test-report.json")), false);
  writeFileSync(join(f.root, "release"), "");
  await pending;
  const ended = await readTestActivity(f.runDir, f.run);
  assert.equal(ended.executionStatus, "completed");
  assert.equal(ended.exitCode, 0);
  assert.equal(ended.process.state, "unknown"); // 结束后释放内存句柄，终态由已保存的退出码证明。
  assert.ok(ended.finishedAt);
  assert.equal(f.output(), "中文输出\nstderr detail\n");
  assert.equal(f.report().version, 2);
  assert.equal(f.report().captureId, ended.captureId);
  assert.equal(f.report().stageStartedAt, f.run.stages.P8.startedAt);
  assert.equal(f.report().platform, process.platform);
  assert.equal(f.report().cwd, f.root);
  assert.ok(f.report().shell);
  assert.equal(f.report().executionStatus, "completed");
  assert.equal(f.report().tail, f.output());
  assert.equal(f.report().passed, true);
});

test("P8 无输出立即可观测，流程 stopped 后取消真实进程并记录取消", async t => {
  const f = fixture(t, heldOpen + "fs.writeFileSync('ready', '');");
  writeFileSync(join(f.runDir, TEST_OUTPUT_PATH), "上轮输出");
  const pending = p8(f.rcx).then(() => null, error => error);
  assert.equal(f.output(), "");
  await until(() => existsSync(join(f.root, "ready")));
  f.run.status = "stopped"; f.run.stages.P8.status = "stopped";
  writeFileSync(join(f.runDir, "run.json"), JSON.stringify(f.run));
  const live = await readTestActivity(f.runDir, f.run);
  assert.equal(live.executionStatus, "running");
  assert.equal(live.process.state, "alive");
  assert.equal(live.lastOutputAt, null);
  assert.equal(live.outputBytes, 0);
  assert.match((await pending).message, /测试取消/);
  assert.equal(f.report().executionStatus, "cancelled");
  assert.equal(f.report().passed, false);
  assert.notEqual((await readTestActivity(f.runDir, f.run)).process.state, "alive");
});

test("P8 失败保存两路完整输出、末尾报告及真实退出码", async t => {
  const f = fixture(t, "process.stdout.write('A'.repeat(5000)); process.stderr.write('失败明细'); process.exitCode = 7;");
  await assert.rejects(p8(f.rcx), /测试失败\(exitCode=7\)/);
  assert.equal(f.output(), "A".repeat(5000) + "失败明细");
  assert.equal(f.report().tail, f.output().slice(-4000));
  assert.equal(f.report().passed, false);
  const ended = await readTestActivity(f.runDir, f.run);
  assert.equal(ended.executionStatus, "failed"); assert.equal(ended.exitCode, 7);
});

test("P8 超时保留终止前输出，状态明确 timeout", async t => {
  let childPid;
  // 先注册子进程清理，再让 fixture 注册目录清理；Windows 工作目录句柄需先释放。
  t.after(async () => {
    if (Number.isSafeInteger(childPid) && childPid > 0 && childPid !== process.pid) {
      try { process.kill(childPid); } catch (error) { if (error.code !== "ESRCH") throw error; }
      await delay(100);
    }
  });
  const f = fixture(t, "require('node:fs').writeFileSync('child-pid', String(process.pid)); process.stdout.write('before timeout\\n'); setTimeout(() => process.exit(0), 10000);", { timeoutMs: 600 });
  const started = Date.now();
  const pending = p8(f.rcx).then(() => null, error => error);
  await until(() => existsSync(join(f.root, "child-pid")));
  childPid = Number(readFileSync(join(f.root, "child-pid"), "utf8"));
  assert.ok(Number.isSafeInteger(childPid) && childPid > 0 && childPid !== process.pid);
  assert.match((await pending).message, /测试超时/);
  // 边界须显著低于子进程自身的 10s 退出（区分「kill 及时生效」与「等子进程自然退出」）；
  // 全量并行负载下 Windows 进程终止偶发超 2.5s，放宽到 4s 保持判别力
  assert.ok(Date.now() - started < 4000, "长寿命后代持有输出管道也不能拖住 exec 超时回调");
  const ended = await readTestActivity(f.runDir, f.run);
  assert.equal(ended.executionStatus, "timeout");
  assert.match(f.output(), /^before timeout\n/);
  assert.equal(f.output().split("超时被终止").length, 2);
  assert.equal(f.report().passed, false);
});

test("P8 重跑隔离旧输出、旧快照和迟到的最终报告", async t => {
  const a = fixture(t, `const fs=require('node:fs'); process.stdout.write('old early\\n');
const hold=setInterval(()=>{if(fs.existsSync('release-old')){clearInterval(hold);process.stdout.write('old late\\n');}},20);
setTimeout(()=>process.exit(2),4000).unref();`, { name: "old", startedAt: "2026-09-14T01:00:00.000Z" });
  const old = p8(a.rcx).then(() => null, error => error);
  await until(a.output, value => value.includes("old early"));
  const first = await readTestActivity(a.runDir, a.run);
  const b = fixture(t, "process.stdout.write('new only\\n');", { root: a.root, name: "new", startedAt: "2026-09-14T01:00:01.000Z" });
  await p8(b.rcx);
  const second = await readTestActivity(b.runDir, b.run);
  assert.notEqual(first.captureId, second.captureId);
  const stale = await readTestActivity(b.runDir, a.run);
  assert.equal(stale.reasonCode, "stale");
  writeFileSync(join(a.root, "release-old"), "");
  assert.match((await old).message, /新的 P8 执行替代/);
  assert.equal(b.output(), "new only\n");
  assert.equal(b.report().command, b.command);
  assert.equal((await readTestActivity(b.runDir, b.run)).captureId, second.captureId);
});

test("P8 输出写入故障可见，退出 0 也不能假报 passed", async t => {
  const f = fixture(t, heldOpen + `fs.writeFileSync('ready','');
const later=setInterval(()=>{if(fs.existsSync('emit')){clearInterval(later);process.stdout.write('cannot persist\\n');}},20);`);
  const pending = p8(f.rcx).then(() => null, error => error);
  await until(() => existsSync(join(f.root, "ready")));
  renameSync(join(f.runDir, TEST_OUTPUT_PATH), join(f.runDir, "saved-output.txt"));
  mkdirSync(join(f.runDir, TEST_OUTPUT_PATH));
  writeFileSync(join(f.root, "emit"), "");
  await until(() => readTestActivity(f.runDir, f.run), value => !!value.logError);
  writeFileSync(join(f.root, "release"), "");
  assert.match((await pending).message, /保存失败/);
  const ended = await readTestActivity(f.runDir, f.run);
  assert.equal(ended.executionStatus, "failed");
  assert.equal(ended.exitCode, 0);
  assert.equal(f.report().passed, false);
  assert.match(f.report().tail, /cannot persist/);
});

test("P8 重置为 pending 后旧命令不再写入，尚未启动新命令也不会覆盖报告", async t => {
  const f = fixture(t, `const fs=require('node:fs'); process.stdout.write('before reset\\n');
const hold=setInterval(()=>{if(fs.existsSync('release-old')){clearInterval(hold);process.stdout.write('after reset\\n');}},20);
setTimeout(()=>process.exit(2),4000).unref();`);
  const pending = p8(f.rcx).then(() => null, error => error);
  await until(f.output, value => value.includes("before reset"));
  writeFileSync(join(f.runDir, "07-test-report.json"), "previous report");
  f.run.stages.P8 = { status: "pending" };
  writeFileSync(join(f.runDir, "run.json"), JSON.stringify(f.run));
  writeFileSync(join(f.root, "release-old"), "");
  assert.match((await pending).message, /新的 P8 执行替代/);
  assert.equal(f.output(), "before reset\n");
  assert.equal(readFileSync(join(f.runDir, "07-test-report.json"), "utf8"), "previous report");
  assert.equal((await readTestActivity(f.runDir, f.run)).status, "unavailable");
});

test("P8 初始输出创建失败时不启动命令，也不复用旧结果", async t => {
  const f = fixture(t, "require('node:fs').writeFileSync('was-started', '');");
  mkdirSync(join(f.runDir, TEST_OUTPUT_PATH));
  await assert.rejects(p8(f.rcx), /保存失败/);
  assert.equal(existsSync(join(f.root, "was-started")), false);
  const activity = await readTestActivity(f.runDir, f.run);
  assert.equal(activity.executionStatus, "failed"); assert.equal(activity.process.state, "unknown");
  assert.equal(activity.outputReady, false);
  assert.ok(activity.logError);
});

test("P8 执行身份暂时不可读而丢失的输出不能在恢复后假报完整通过", async t => {
  const f = fixture(t, heldOpen + `fs.writeFileSync('ready','');
const later=setInterval(()=>{if(fs.existsSync('emit')){clearInterval(later);process.stdout.write('during unreadable identity\\n');}},20);`);
  const pending = p8(f.rcx).then(() => null, error => error);
  await until(() => existsSync(join(f.root, "ready")));
  writeFileSync(join(f.runDir, "run.json"), "{");
  writeFileSync(join(f.root, "emit"), "");
  await until(() => readTestActivity(f.runDir, f.run), value => !!value.logError);
  writeFileSync(join(f.runDir, "run.json"), JSON.stringify(f.run));
  writeFileSync(join(f.root, "release"), "");
  assert.match((await pending).message, /保存失败/);
  assert.equal(f.report().passed, false);
});

test("P8 快照重命名瞬时失败会自动重试，无后续输出仍恢复", async t => {
  const f = fixture(t, "");
  mkdirSync(join(f.runDir, TEST_ACTIVITY_PATH));
  const writer = createTestActivity({ runDir: f.runDir, command: f.command, stageStartedAt: f.run.stages.P8.startedAt, flushMs: 20 });
  t.after(() => writer.dispose());
  rmdirSync(join(f.runDir, TEST_ACTIVITY_PATH));
  await until(() => existsSync(join(f.runDir, TEST_ACTIVITY_PATH)));
  const snapshot = JSON.parse(readFileSync(join(f.runDir, TEST_ACTIVITY_PATH), "utf8"));
  assert.equal(snapshot.captureId, writer.captureId);
  assert.equal(snapshot.executionStatus, "running");
  assert.equal(writer.snapshot().logError, undefined);
  await writer.finish({ executionStatus: "completed", exitCode: 0 });
});

test("P8 快照持续写入失败会有限收尾，并通过内存状态明确报错", async t => {
  const f = fixture(t, "process.stdout.write('test complete\\n');");
  mkdirSync(join(f.runDir, TEST_ACTIVITY_PATH));
  await assert.rejects(p8(f.rcx), /保存失败/);
  const snapshot = await readTestActivity(f.runDir, f.run);
  assert.equal(snapshot.executionStatus, "failed");
  assert.equal(snapshot.exitCode, 0);
  assert.ok(snapshot.logError);
  assert.equal(f.report().passed, false);
  assert.equal(f.output(), "test complete\n");
});

test("P8 报告无法保存时快照也标记失败，不能留下 completed 假象", async t => {
  const f = fixture(t, "process.stdout.write('test complete\\n');");
  mkdirSync(join(f.runDir, "07-test-report.json"));
  await assert.rejects(p8(f.rcx));
  const snapshot = await readTestActivity(f.runDir, f.run);
  assert.equal(snapshot.executionStatus, "failed");
  assert.equal(snapshot.exitCode, 0);
  assert.ok(snapshot.logError);
  assert.equal(f.output(), "test complete\n");
});

test("P8 读取旧宿主快照只报告未知进程，拒绝旧轮次及异常结构", async t => {
  const f = fixture(t, "");
  const snapshot = { version: 1, status: "available", captureId: "foreign-host", stageStartedAt: f.run.stages.P8.startedAt,
    command: "npm test", startedAt: f.run.stages.P8.startedAt, updatedAt: f.run.stages.P8.startedAt, finishedAt: null,
    executionStatus: "running", lastOutputAt: null, outputBytes: 0, exitCode: null, signal: null, outputPath: TEST_OUTPUT_PATH };
  const write = value => writeFileSync(join(f.runDir, TEST_ACTIVITY_PATH), JSON.stringify(value));
  assert.equal((await readTestActivity(f.runDir, f.run)).reasonCode, "missing");
  write(snapshot);
  assert.equal((await readTestActivity(f.runDir, f.run)).process.state, "unknown");
  write({ ...snapshot, unrelated: { content: "do not expose" }, process: { state: "alive" } });
  const safe = await readTestActivity(f.runDir, f.run);
  assert.equal(safe.unrelated, undefined);
  assert.equal(safe.process.state, "unknown");
  write({ ...snapshot, command: {} });
  assert.equal((await readTestActivity(f.runDir, f.run)).reasonCode, "invalid");
  write({ ...snapshot, stageStartedAt: "2020-01-01T00:00:00.000Z" });
  assert.equal((await readTestActivity(f.runDir, f.run)).reasonCode, "stale");
  writeFileSync(join(f.runDir, TEST_ACTIVITY_PATH), "{");
  assert.equal((await readTestActivity(f.runDir, f.run)).reasonCode, "invalid");
});
