// lib/stages/p7-patch.js — 调研 §8/§11：diff 为原子单位；回滚只反应用 Agent patch
// git 一律走异步子进程：execFileSync 会阻塞 Node 事件循环，期间 stop/删除/轮询请求全部排队。
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { appendArtifactLine } from "../store.js";
import { logEvent } from "./helpers.js";

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

// patch 清单：优先 builtin 模式的 coder-report.json；session 模式下 DSH 会话
// 只写 patches/*.diff（无 report），此时退化为扫描目录（文件名序 = 应用序）。
function collectPatches(runDir) {
  const reportPath = join(runDir, "06-implementation", "coder-report.json");
  if (existsSync(reportPath)) {
    return JSON.parse(readFileSync(reportPath, "utf8")).patches || [];
  }
  const dir = join(runDir, "06-implementation", "patches");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith(".diff")).sort()
    .map((f) => ({ patch: "06-implementation/patches/" + f }));
}

export default async function execute(rcx) {
  const patches = collectPatches(rcx.runDir);
  if (!patches.length) throw new Error("P7 无 patch 可应用（06-implementation/patches/ 为空且无 coder-report.json）");
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
