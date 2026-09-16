import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyzeFailure } from "../../lib/core/failureAnalysis.js";
import { initRun, saveRun, loadRun } from "../../lib/core/pipeline.js";
import { writeArtifact } from "../../lib/core/store.js";
import p10 from "../../lib/stages/p10-failure.js";

function fixture(t, status = "failed", log = "command exited 1") {
  const runDir = mkdtempSync(join(tmpdir(), "i2p-failure-"));
  t.after(() => rmSync(runDir, { recursive: true, force: true }));
  const run = initRun({ runId: "test", slug: "test", reviewMode: "auto" });
  run.current = "P8"; run.status = "failed";
  run.stages.P8 = { status: "failed", startedAt: "2026-09-15T01:00:00.000Z", error: "测试命令失败" };
  saveRun(runDir, run);
  const report = { version: 2, captureId: "capture-1", stageStartedAt: run.stages.P8.startedAt,
    executionStatus: status, exitCode: status === "failed" ? 1 : null, signal: null,
    command: "npm test", cwd: "test-repo", shell: "cmd.exe", platform: "win32", timeoutMs: 300000,
    startedAt: run.stages.P8.startedAt, finishedAt: "2026-09-15T01:05:00.000Z", outputPath: "08-test-output.txt", passed: false };
  writeArtifact(runDir, "07-test-report.json", JSON.stringify(report));
  writeArtifact(runDir, "08-test-activity.json", JSON.stringify(report));
  writeArtifact(runDir, "08-test-output.txt", log);
  return { runDir, run, executors: { P10: p10 }, llm: { completeJson: async () => ({ category: "实现错误", detail: "模型猜测", action: "replan" }) } };
}
const reportOf = rcx => JSON.parse(readFileSync(join(rcx.runDir, "09-failure-analysis.json"), "utf8"));

test("P10：本轮真实日志进入提示词，超时事实优先于模型猜测，旁路状态事件完整", async t => {
  const rcx = fixture(t, "timeout", "Enter the new date: timeout");
  let prompt;
  rcx.llm.completeJson = async input => { prompt = input.user; return { category: "实现错误", detail: "bad code", action: "rollback" }; };
  await analyzeFailure(rcx, "测试超时");
  const run = loadRun(rcx.runDir), report = reportOf(rcx);
  assert.equal(run.current, "P8"); assert.equal(run.status, "failed");
  assert.equal(run.stages.P10.status, "approved");
  assert.equal(report.category, "执行超时"); assert.equal(report.action, "escalate");
  assert.equal(report.evidence.report.exitCode, null);
  assert.match(prompt, /Enter the new date/);
  assert.equal(run.failureAnalysis.analysisId, run.stages.P10.analysisId);
  assert.ok(run.stages.P10.startedAt); assert.ok(run.stages.P10.finishedAt);
  const events = readFileSync(join(rcx.runDir, "trace/events.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(events.length, 2); assert.ok(events.every(e => e.stage === "P10" && e.analysisId === report.analysisId));
});

test("P10：非零退出没有断言证据不判实现错误，也不凭空判反复失败", async t => {
  const rcx = fixture(t);
  await analyzeFailure(rcx, "exitCode=1");
  assert.equal(reportOf(rcx).category, "原因未确定");
  const other = fixture(t);
  other.llm.completeJson = async () => ({ category: "反复失败", detail: "猜测反复", action: "rollback" });
  await analyzeFailure(other, "exitCode=1");
  assert.equal(reportOf(other).category, "原因未确定");
});

test("P10：断言失败证据允许模型分析实现原因", async t => {
  const rcx = fixture(t, "failed", "AssertionError [ERR_ASSERTION]: Expected: NaN Received: 0");
  await analyzeFailure(rcx, "测试失败");
  assert.equal(reportOf(rcx).category, "实现错误");
});

test("P10：缺失和不匹配执行身份均不读取历史日志", async t => {
  for (const kind of ["missing", "capture", "stage"]) {
    const rcx = fixture(t, "timeout", "old secret-looking log");
    if (kind === "missing") rmSync(join(rcx.runDir, "07-test-report.json"));
    else {
      const activity = JSON.parse(readFileSync(join(rcx.runDir, "08-test-activity.json"), "utf8"));
      if (kind === "capture") activity.captureId = "old";
      else activity.stageStartedAt = "old";
      writeArtifact(rcx.runDir, "08-test-activity.json", JSON.stringify(activity));
    }
    await analyzeFailure(rcx, "测试失败");
    const report = reportOf(rcx);
    assert.equal(report.category, "原因未确定");
    assert.ok(report.evidence.unavailable); assert.equal(report.evidence.log, undefined);
  }
});

test("P10：模型不可用保留启动失败事实与原始证据", async t => {
  const rcx = fixture(t, "spawn_failed", "ENOENT shell missing");
  rcx.llm.completeJson = async () => { throw new Error("authentication unavailable"); };
  await analyzeFailure(rcx, "启动失败");
  const report = reportOf(rcx);
  assert.equal(report.category, "环境缺失"); assert.equal(report.degraded, true);
  assert.match(report.evidence.log, /ENOENT/); assert.match(report.analysisError, /authentication/);
});

test("P10：执行中重跑后同阶段新失败，旧分析不可覆盖状态或canonical报告", async t => {
  const rcx = fixture(t);
  let resolveModel;
  rcx.llm.completeJson = () => new Promise(resolve => { resolveModel = resolve; });
  const pending = analyzeFailure(rcx, "旧失败");
  await Promise.resolve();
  const fresh = loadRun(rcx.runDir);
  fresh.stages.P8.startedAt = "2026-09-15T02:00:00.000Z";
  fresh.stages.P10 = { status: "pending" };
  saveRun(rcx.runDir, fresh);
  writeArtifact(rcx.runDir, "09-failure-analysis.json", JSON.stringify({ category: "新分析" }));
  resolveModel({ category: "实现错误", detail: "旧结果", action: "rollback" });
  await pending;
  assert.equal(loadRun(rcx.runDir).stages.P10.status, "pending");
  assert.equal(reportOf(rcx).category, "新分析");
});

test("P10：目录删除后迟到的模型结果不重建目录", async t => {
  const rcx = fixture(t); let resolveModel;
  rcx.llm.completeJson = () => new Promise(resolve => { resolveModel = resolve; });
  const pending = analyzeFailure(rcx, "旧失败");
  await Promise.resolve();
  rmSync(rcx.runDir, { recursive: true, force: true });
  resolveModel({ category: "原因未确定", detail: "old", action: "escalate" });
  await pending; assert.equal(existsSync(rcx.runDir), false);
});

test("P10：外部等待、执行器异常分别记录状态，不改变主失败", async t => {
  const rcx = fixture(t);
  rcx.executors.P10 = async () => ({ external: true, artifact: "delegate/P10-task.md", summary: "等待外部分析" });
  await analyzeFailure(rcx, "错误");
  assert.equal(loadRun(rcx.runDir).stages.P10.status, "awaiting_review");
  const bad = fixture(t);
  bad.executors.P10 = async () => { throw new Error("executor failed"); };
  await assert.rejects(() => analyzeFailure(bad, "原失败"), /executor failed/);
  const run = loadRun(bad.runDir);
  assert.equal(run.stages.P10.status, "failed"); assert.equal(run.current, "P8");
  assert.equal(run.stages.P8.error, "测试命令失败");
  // 补全③：P10 自身失败也落结构化错误（UI 徽标与异常栈可见），并标明源阶段
  assert.equal(run.stages.P10.errorInfo.code, "stage_failed");
  assert.equal(run.stages.P10.errorInfo.stage, "P10");
  assert.equal(run.stages.P10.errorInfo.sourceStage, "P8");
  assert.match(run.stages.P10.errorInfo.stack, /executor failed/, "异常栈（异常日志）随结构化错误保存");
});

test("P10 委托：唯一输出、等待保留身份，匹配报告消费后发布而不推进 P8", async t => {
  const rcx = fixture(t, "timeout", "command timed out");
  rcx.stageCfgOf = () => ({ delegate: { mode: "session" } });
  rcx.llm.completeJson = async () => { throw new Error("不应调用模型"); };
  await analyzeFailure(rcx, "测试超时");
  const waiting = loadRun(rcx.runDir).stages.P10;
  assert.equal(waiting.status, "awaiting_review");
  const task = readFileSync(join(rcx.runDir, waiting.artifact), "utf8");
  assert.ok(task.includes(waiting.responseArtifact));
  assert.ok(task.includes(waiting.analysisId));
  assert.equal(task.includes("09-failure-analysis.json"), false);
  rcx.resumeFailureAnalysis = true;
  await analyzeFailure(rcx, "测试超时");
  assert.equal(loadRun(rcx.runDir).stages.P10.analysisId, waiting.analysisId);
  assert.equal(loadRun(rcx.runDir).stages.P10.status, "awaiting_review");
  writeArtifact(rcx.runDir, waiting.responseArtifact, JSON.stringify({
    analysisId: waiting.analysisId, sourceStage: waiting.sourceStage, sourceStartedAt: waiting.sourceStartedAt,
    category: "实现错误", detail: "external guess", action: "replan",
  }));
  await analyzeFailure(rcx, "测试超时");
  const finished = loadRun(rcx.runDir);
  assert.equal(finished.stages.P10.status, "approved");
  assert.equal(finished.stages.P10.analysisId, waiting.analysisId);
  assert.equal(finished.current, "P8"); assert.equal(finished.status, "failed");
  assert.equal(reportOf(rcx).category, "执行超时", "委托分析同样不能覆盖执行事实");
});

test("P10 委托：新轮次拒绝读取迟到旧报告与伪造身份", async t => {
  const rcx = fixture(t);
  rcx.stageCfgOf = () => ({ delegate: { mode: "session" } });
  await analyzeFailure(rcx, "old failure");
  const old = loadRun(rcx.runDir).stages.P10;
  const next = loadRun(rcx.runDir);
  next.stages.P8.startedAt = "2026-09-15T03:00:00.000Z";
  next.stages.P10 = { status: "pending" };
  saveRun(rcx.runDir, next);
  await analyzeFailure(rcx, "new failure");
  const current = loadRun(rcx.runDir).stages.P10;
  assert.notEqual(current.analysisId, old.analysisId);
  const staleReport = { analysisId: old.analysisId, sourceStage: old.sourceStage, sourceStartedAt: old.sourceStartedAt,
    category: "实现错误", detail: "old result", action: "rollback" };
  writeArtifact(rcx.runDir, old.responseArtifact, JSON.stringify(staleReport));
  rcx.resumeFailureAnalysis = true;
  await analyzeFailure(rcx, "new failure");
  assert.equal(loadRun(rcx.runDir).stages.P10.status, "awaiting_review");
  assert.equal(existsSync(join(rcx.runDir, "09-failure-analysis.json")), false);
  writeArtifact(rcx.runDir, current.responseArtifact, JSON.stringify(staleReport));
  await assert.rejects(() => analyzeFailure(rcx, "new failure"), /身份不匹配/);
  assert.equal(loadRun(rcx.runDir).stages.P10.status, "failed");
  assert.equal(existsSync(join(rcx.runDir, "09-failure-analysis.json")), false);
});

test("P10：超时但进程回收失败时不宣称已终止", async t => {
  const rcx = fixture(t, "timeout");
  const path = "07-test-report.json";
  const report = JSON.parse(readFileSync(join(rcx.runDir, path), "utf8"));
  report.cleanupError = "taskkill: access denied";
  writeArtifact(rcx.runDir, path, JSON.stringify(report));
  await analyzeFailure(rcx, "测试超时");
  assert.equal(reportOf(rcx).category, "执行超时");
  assert.match(reportOf(rcx).detail, /达到超时限制，但进程回收未确认/);
  assert.doesNotMatch(reportOf(rcx).detail, /被终止/);
});
