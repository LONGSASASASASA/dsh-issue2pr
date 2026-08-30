// lib/stages/p7-patch.js — 调研 §8/§11：diff 为原子单位；回滚只反应用 Agent patch
// git 一律走异步子进程：execFileSync 会阻塞 Node 事件循环，期间 stop/删除/轮询请求全部排队。
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { appendArtifactLine } from "../core/store.js";
import { logEvent } from "./helpers.js";
import { resetRepoClean } from "../infra/repoState.js";

// 带stdin输入的异步执行（git apply - 用 stdin 收 diff）
function execStdin(cmd, args, opts, input) {
  return new Promise((resolve, reject) => {
    const child = execFile(cmd, args, { ...opts, stdio: ["pipe", "pipe", "pipe"], maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) { err.stderr = String(stderr || err.message); reject(err); }
      else resolve(String(stdout || ""));
    });
    child.stdin.on("error", () => {}); // 子进程异常退出时的 EPIPE 不掩盖主错误
    child.stdin.end(input);
  });
}

async function hashRepo(repoDir) {
  try {
    return (await execStdin("git", ["rev-parse", "HEAD"], { cwd: repoDir }, "")).trim();
  } catch { return "nogit"; }
}

// patch 清单：优先 coder-report.json（builtin 写 patches 字段；claude 委托写 tasks 字段且
// patch 路径相对 06-implementation/，这里统一归一化为相对 runDir 全路径）；
// report 缺失时退化为扫描目录（文件名序 = 应用序）。
// 导出供 delegateVerify 复用：验证清单 = P7 应用清单，同一口径。
export function collectPatches(runDir) {
  const normalize = (p) => !p ? null
    : { patch: p.startsWith("06-implementation/") ? p : "06-implementation/" + p.replace(/^\/+/, "") };
  const reportPath = join(runDir, "06-implementation", "coder-report.json");
  if (existsSync(reportPath)) {
    let report;
    try { report = JSON.parse(readFileSync(reportPath, "utf8")); }
    catch { throw new Error("coder-report.json 损坏（非法 JSON），无法解析补丁清单；请回退 P6 重跑或修复报告文件"); }
    const list = Array.isArray(report.patches) ? report.patches
      : Array.isArray(report.tasks) ? report.tasks.map((t) => ({ patch: t.patch }))
      : [];
    return list.map((p) => normalize(p && p.patch)).filter(Boolean);
  }
  const dir = join(runDir, "06-implementation", "patches");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith(".diff")).sort()
    .map((f) => ({ patch: "06-implementation/patches/" + f }));
}

export default async function execute(rcx) {
  const patches = collectPatches(rcx.runDir);
  if (!patches.length) throw new Error("P7 无 patch 可应用（06-implementation/patches/ 为空且无 coder-report.json）");
  // A1/A2 修复：应用补丁前先把工作区重置回 HEAD 基线。
  // 打回重跑/回退重跑时上一轮已应用的补丁仍在工作区（直接 re-apply 必失败）；
  // worktree 兜底共用基线 repo 的路径下同理清残留。reset 不碰 .gitignore 的目录（如 node_modules）。
  await resetRepoClean(rcx.repoDir);
  logEvent(rcx, { kind: "git", name: "工作区基线重置", detail: "P7 应用补丁前 git reset --hard + git clean -fd" });
  for (const p of patches) {
    const diff = readFileSync(join(rcx.runDir, p.patch), "utf8");
    const hashBefore = await hashRepo(rcx.repoDir);
    const t0 = Date.now();
    try {
      await execStdin("git", ["apply", "--check", "-"], { cwd: rcx.repoDir }, diff);
      await execStdin("git", ["apply", "-"], { cwd: rcx.repoDir }, diff);
    } catch (e) {
      logEvent(rcx, { kind: "git", name: "git apply " + p.patch, detail: String(e.stderr || e.message), ms: Date.now() - t0, ok: false });
      throw new Error("Patch 应用失败(" + p.patch + "): " + String(e.stderr || e.message));
    }
    logEvent(rcx, { kind: "git", name: "git apply " + p.patch, detail: diff.length + " 字 diff · 基线 " + hashBefore.slice(0, 8), ms: Date.now() - t0 });
    appendArtifactLine(rcx.runDir, "ledger/patch-ledger.jsonl", { patch: p.patch, hashBefore, appliedAt: new Date().toISOString() });
  }
  return { artifact: "ledger/patch-ledger.jsonl", summary: `应用 ${patches.length} 份 patch` };
}

export async function rollbackLedger(runDir, repoDir, lineNo) {
  const lines = readFileSync(join(runDir, "ledger", "patch-ledger.jsonl"), "utf8").trim().split("\n");
  const entry = JSON.parse(lines[lineNo]);
  const diff = readFileSync(join(runDir, entry.patch), "utf8");
  await execStdin("git", ["apply", "-R", "-"], { cwd: repoDir }, diff);
  appendArtifactLine(runDir, "ledger/patch-ledger.jsonl", { rollbackOf: lineNo, at: new Date().toISOString() });
}
