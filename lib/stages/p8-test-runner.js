// lib/stages/p8-test-runner.js — 调研 §9 铁律：结果必须来自真实工具执行
// exec 用异步版本：execSync 最长可阻塞事件循环 5 分钟，期间 stop/删除/轮询请求全部排队无响应。
import { exec } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeArtifact } from "../store.js";
import { logEvent } from "./helpers.js";

function detectCommand(repoDir) {
  const pkg = join(repoDir, "package.json");
  if (existsSync(pkg) && JSON.parse(readFileSync(pkg, "utf8")).scripts?.test) return "npm test";
  throw new Error("未配置测试命令（project.testCommand 为空且无法自动探测）");
}

function runCommand(command, cwd) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    exec(command, { cwd, encoding: "utf8", timeout: 300000, maxBuffer: 32 * 1024 * 1024,
      windowsHide: true }, (err, stdout, stderr) => {
      if (err) {
        const killed = err.killed || err.signal === "SIGTERM";
        resolve({ code: err.code ?? 1, ms: Date.now() - t0,
          out: String(stdout || "") + String(stderr || "") + (killed ? "\n（超时被终止）" : "") });
      } else {
        // 与旧 execSync 语义一致：成功路径只保留 stdout
        resolve({ code: 0, ms: Date.now() - t0, out: String(stdout || "") });
      }
    });
  });
}

export default async function execute(rcx) {
  const command = rcx.project?.testCommand || detectCommand(rcx.repoDir);
  logEvent(rcx, { kind: "test", name: command, detail: "开始执行（最长 5 分钟）" });
  const { code, ms, out } = await runCommand(command, rcx.repoDir);
  // 完整输出持久化（成功与失败路径均落盘、不截断），排障可回溯；07-test-report.json 只留末尾 4000 字
  writeArtifact(rcx.runDir, "08-test-output.txt", out);
  const report = { command, exitCode: code, tail: out.slice(-4000), passed: code === 0, ranAt: new Date().toISOString() };
  writeArtifact(rcx.runDir, "07-test-report.json", JSON.stringify(report, null, 2));
  logEvent(rcx, { kind: "test", name: command, detail: out.slice(-1200) || "（无输出）", ms, ok: code === 0 });
  if (!report.passed) throw new Error("测试失败(exitCode=" + code + ")，详见 07-test-report.json");
  return { artifact: "07-test-report.json", summary: `exitCode=0` };
}
