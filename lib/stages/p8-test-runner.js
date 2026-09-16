// P8：非交互真实测试，执行事实和本轮证据落盘后才判断通过。
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeArtifact } from "../core/store.js";
import { logEvent } from "./helpers.js";
import { DEFAULT_TEST_TIMEOUT_MS } from "../core/stageConfig.js";
import { createTestActivity } from "./testActivity.js";
import { resolveTestEnvironment, runTestProcess } from "../infra/testProcess.js";

function detectCommand(repoDir) {
  const pkg = join(repoDir, "package.json");
  if (existsSync(pkg) && JSON.parse(readFileSync(pkg, "utf8")).scripts?.test) return "npm test";
  throw new Error("未配置测试命令（project.testCommand 为空且无法自动探测）");
}

export default async function execute(rcx) {
  const p8cfg = typeof rcx.stageCfgOf === "function" ? rcx.stageCfgOf("P8") : null;
  const timeoutMs = p8cfg?.timeoutMs || DEFAULT_TEST_TIMEOUT_MS;
  const requested = rcx.run?.executionConfig
    ? rcx.run.executionConfig.testEnvironment ?? { platform: "host", shell: "" }
    : rcx.project?.testEnvironment ?? {};
  let command = rcx.project?.testCommand || "", preflightError, environment;
  try {
    environment = resolveTestEnvironment(requested, rcx.repoDir);
    command ||= detectCommand(rcx.repoDir);
  } catch (error) { preflightError = String(error.message || error); }
  const activity = createTestActivity({ runDir: rcx.runDir, command, stageStartedAt: rcx.run?.stages?.P8?.startedAt });
  const actualEnvironment = environment || { platform: process.platform, shell: requested.shell || "", cwd: rcx.repoDir };
  activity.setEnvironment(actualEnvironment);
  const startedAt = activity.snapshot().startedAt;
  try {
    if (!activity.owned()) throw new Error("本次测试已被新的 P8 执行替代");
    if (activity.snapshot().logError) {
      await activity.finish({ executionStatus: "failed" });
      throw new Error(activity.snapshot().logError);
    }
    logEvent(rcx, { kind: "test", name: command || "测试环境预检", detail: `平台 ${actualEnvironment.platform} · Shell ${actualEnvironment.shell || "未确定"} · 最长 ${Math.round(timeoutMs / 60000)} 分钟` });
    const outcome = preflightError
      ? { executionStatus: "environment_error", exitCode: null, signal: null, ms: 0, error: preflightError }
      : await runTestProcess({ runDir: rcx.runDir, command, environment, timeoutMs,
        onOutput: text => activity.append(text), onChild: child => activity.setChild(child),
        shouldCancel: () => {
          if (!activity.owned()) return "本次测试已被新的 P8 执行替代或任务已删除";
          try {
            const disk = JSON.parse(readFileSync(join(rcx.runDir, "run.json"), "utf8"));
            if (["stopped", "deleted"].includes(disk.status)) return "用户停止测试";
          } catch { /* 裸阶段调用可无 run.json；实际任务删除由 owned 检测 */ }
          return null;
        },
      });
    if (outcome.executionStatus === "timeout") activity.append(outcome.cleanupError ? "\n（测试超时，进程回收未确认）" : "\n（超时被终止）", { observed: false });
    if (outcome.error) activity.append("\n" + outcome.error + "\n", { observed: false });
    if (outcome.cleanupError) {
      activity.append("\n" + outcome.cleanupError + "\n", { observed: false });
      if (outcome.executionStatus === "completed") outcome.executionStatus = "failed";
    }
    await activity.finish(outcome);
    if (!activity.owned()) throw new Error("本次测试已被新的 P8 执行替代");
    const failure = activity.snapshot().logError;
    const report = {
      version: 2, captureId: activity.captureId, stageStartedAt: activity.snapshot().stageStartedAt,
      command, ...actualEnvironment, requestedEnvironment: requested, timeoutMs, startedAt,
      finishedAt: activity.snapshot().finishedAt, executionStatus: failure ? "failed" : outcome.executionStatus,
      exitCode: outcome.exitCode, signal: outcome.signal, outputPath: "08-test-output.txt",
      tail: activity.tail, passed: outcome.executionStatus === "completed" && outcome.exitCode === 0 && !failure && !outcome.cleanupError,
      ranAt: new Date().toISOString(),
      ...(outcome.error || failure ? { error: failure || outcome.error } : {}),
      ...(outcome.cleanupError ? { cleanupError: outcome.cleanupError } : {}),
      ...(outcome.commandAdaptation ? { commandAdaptation: outcome.commandAdaptation, executedCommand: outcome.executedCommand } : {}),
    };
    try { writeArtifact(rcx.runDir, "07-test-report.json", JSON.stringify(report, null, 2)); }
    catch (error) { activity.fail(error); await activity.finish({ ...outcome, executionStatus: "failed" }); throw error; }
    logEvent(rcx, { kind: "test", name: command || "测试环境预检", detail: failure || outcome.error || activity.tail.slice(-1200) || "（无输出）", ms: outcome.ms, ok: report.passed });
    if (failure) throw new Error(failure);
    if (!report.passed) {
      const label = { timeout: "测试超时", cancelled: "测试取消", spawn_failed: "测试进程启动失败", environment_error: "测试环境不兼容" }[outcome.executionStatus] || "测试失败";
      throw new Error(label + "(exitCode=" + outcome.exitCode + ")" + (outcome.error ? "：" + outcome.error : "")
        + (outcome.cleanupError ? "；" + outcome.cleanupError : "") + "，详见 07-test-report.json");
    }
    return { artifact: "07-test-report.json", summary: "exitCode=0" };
  } catch (error) {
    if (activity.owned() && activity.snapshot().executionStatus === "running") await activity.finish({ executionStatus: "failed", error: error.message });
    throw error;
  } finally { activity.dispose(); }
}
