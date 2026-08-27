// lib/stages/p8-test-runner.js — 调研 §9 铁律：结果必须来自真实工具执行
import { execFileSync, execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeArtifact } from "../store.js";

function detectCommand(repoDir) {
  const pkg = join(repoDir, "package.json");
  if (existsSync(pkg) && JSON.parse(readFileSync(pkg, "utf8")).scripts?.test) return "npm test";
  throw new Error("未配置测试命令（project.testCommand 为空且无法自动探测）");
}

export default async function execute(rcx) {
  const command = rcx.project?.testCommand || detectCommand(rcx.repoDir);
  let exitCode = 0, tail = "";
  try {
    tail = execSync(command, { cwd: rcx.repoDir, encoding: "utf8", stdio: "pipe", timeout: 300000 });
  } catch (e) { exitCode = e.status ?? 1; tail = String(e.stdout || "") + String(e.stderr || e.message); }
  // 完整输出持久化（成功与失败路径均落盘、不截断），排障可回溯；07-test-report.json 只留末尾 4000 字
  writeArtifact(rcx.runDir, "08-test-output.txt", tail);
  const report = { command, exitCode, tail: tail.slice(-4000), passed: exitCode === 0, ranAt: new Date().toISOString() };
  writeArtifact(rcx.runDir, "07-test-report.json", JSON.stringify(report, null, 2));
  if (!report.passed) throw new Error("测试失败(exitCode=" + exitCode + ")，详见 07-test-report.json");
  return { artifact: "07-test-report.json", summary: `exitCode=0` };
}