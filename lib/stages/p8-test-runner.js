// lib/stages/p8-test-runner.js — 调研 §9 铁律：结果必须来自真实工具执行
// exec 用异步版本：execSync 最长可阻塞事件循环 5 分钟，期间 stop/删除/轮询请求全部排队无响应。
import { exec } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeArtifact } from "../core/store.js";
import { logEvent } from "./helpers.js";
import { DEFAULT_TEST_TIMEOUT_MS } from "../core/stageConfig.js";
import { createTestActivity } from "./testActivity.js";

function detectCommand(repoDir) {
  const pkg = join(repoDir, "package.json");
  if (existsSync(pkg) && JSON.parse(readFileSync(pkg, "utf8")).scripts?.test) return "npm test";
  throw new Error("未配置测试命令（project.testCommand 为空且无法自动探测）");
}

export default async function execute(rcx) {
  // 超时可配（配置页 P8；0/未配置 = 默认 5 分钟）
  const p8cfg = typeof rcx.stageCfgOf === "function" ? rcx.stageCfgOf("P8") : null; // 裸 rcx（单测）回落默认
  const timeoutMs = (p8cfg && p8cfg.timeoutMs) || DEFAULT_TEST_TIMEOUT_MS;
  const command = rcx.project?.testCommand || detectCommand(rcx.repoDir);
  const activity = createTestActivity({ runDir: rcx.runDir, command, stageStartedAt: rcx.run?.stages?.P8?.startedAt });
  const runCommand = (command, cwd) => new Promise((resolve) => {
    const t0 = Date.now();
    let timedOut = false;
    // 标记到期原因；实际超时回收沿用 exec 内部实现（包括关闭两路输出管道）。
    const timer = setTimeout(() => { timedOut = true; }, timeoutMs);
    timer.unref?.();
    const child = exec(command, { cwd, encoding: "utf8", timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024,
      windowsHide: true }, err => {
      clearTimeout(timer);
      const timeout = timedOut && err?.killed && err?.code !== "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";
      if (timeout) activity.append("\n（超时被终止）", { observed: false });
      resolve({ code: err ? err.code ?? 1 : 0, ms: Date.now() - t0,
        executionStatus: timeout ? "timeout" : err ? "failed" : "completed",
        exitCode: child.exitCode, signal: child.signalCode });
    });
    activity.setChild(child);
    // exec 为两路流各自启用 UTF-8 解码，跨分片字符不会被替换成乱码。
    child.stdout?.on("data", text => activity.append(text));
    child.stderr?.on("data", text => activity.append(text));
  });
  try {
    if (!activity.owned()) throw new Error("本次测试已被新的 P8 执行替代");
    if (activity.snapshot().logError) {
      await activity.finish({ executionStatus: "failed" });
      throw new Error(activity.snapshot().logError);
    }
    logEvent(rcx, { kind: "test", name: command, detail: `开始执行（最长 ${Math.round(timeoutMs / 60000)} 分钟）` });
    const { code, ms, ...outcome } = await runCommand(command, rcx.repoDir);
    await activity.finish(outcome);
    // 同一个 runDir 重跑时，旧命令即使稍后结束，也不能覆盖本轮输出和报告。
    if (!activity.owned()) throw new Error("本次测试已被新的 P8 执行替代");
    const failure = activity.snapshot().logError;
    const report = { command, exitCode: code, tail: activity.tail, passed: code === 0 && !failure, ranAt: new Date().toISOString() };
    try { writeArtifact(rcx.runDir, "07-test-report.json", JSON.stringify(report, null, 2)); }
    catch (error) {
      activity.fail(error);
      await activity.finish({ ...outcome, executionStatus: "failed" });
      throw error;
    }
    logEvent(rcx, { kind: "test", name: command, detail: failure || activity.tail.slice(-1200) || "（无输出）", ms, ok: report.passed });
    if (failure) throw new Error(failure);
    if (!report.passed) throw new Error("测试失败(exitCode=" + code + ")，详见 07-test-report.json");
    return { artifact: "07-test-report.json", summary: `exitCode=0` };
  } catch (error) {
    if (activity.owned() && activity.snapshot().executionStatus === "running") await activity.finish({ executionStatus: "failed" });
    throw error;
  } finally { activity.dispose(); }
}
