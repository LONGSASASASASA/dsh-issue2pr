// lib/stages/p7-patch.js — 调研 §8/§11：diff 为原子单位；回滚只反应用 Agent patch
// git 一律走异步子进程：execFileSync 会阻塞 Node 事件循环，期间 stop/删除/轮询请求全部排队。
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { execFile } from "node:child_process";
import { isAbsolute, join, relative, resolve } from "node:path";
import { appendArtifactLine, readArtifact } from "../core/store.js";
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

export async function hashRepo(repoDir) {
  try {
    const hash = (await execStdin("git", ["rev-parse", "HEAD"], { cwd: repoDir }, "")).trim();
    return hash || null;
  } catch { return null; }
}

// patch 清单：优先 coder-report.json（builtin 写 patches 字段；claude 委托写 tasks 字段且
// patch 路径相对 06-implementation/，这里统一归一化为相对 runDir 全路径）；
// report 缺失时退化为扫描目录（文件名序 = 应用序）。
// 导出供 delegateVerify 复用：验证清单 = P7 应用清单，同一口径。
export function collectPatches(runDir) {
  const normalize = (value) => {
    if (typeof value !== "string" || !value.trim()) return null;
    const raw = value.trim().replace(/\\/g, "/");
    const patch = raw.startsWith("06-implementation/")
      ? raw : "06-implementation/" + raw.replace(/^\/+/, "");
    const root = resolve(runDir);
    const relativePath = relative(root, resolve(root, patch)).replace(/\\/g, "/");
    if (isAbsolute(relativePath) || relativePath === ".." || relativePath.startsWith("../")) {
      throw new Error("非法路径（patch 越界）: " + value);
    }
    return { patch };
  };
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
  const batchId = randomUUID();
  // A1/A2 修复：应用补丁前先把工作区重置回 HEAD 基线。
  // 打回重跑/回退重跑时上一轮已应用的补丁仍在工作区（直接 re-apply 必失败）；
  // worktree 兜底共用基线 repo 的路径下同理清残留。reset 不碰 .gitignore 的目录（如 node_modules）。
  await resetRepoClean(rcx.repoDir);
  logEvent(rcx, { kind: "git", name: "工作区基线重置", detail: "P7 应用补丁前 git reset --hard + git clean -fd" });
  for (const p of patches) {
    const diff = readArtifact(rcx.runDir, p.patch);
    if (diff == null) throw new Error("Patch 文件不存在: " + p.patch);
    const patchSha256 = hashPatch(diff);
    const hashBefore = await hashRepo(rcx.repoDir);
    if (!hashBefore) throw new Error("无法读取 Git HEAD 哈希，拒绝写入 patch ledger");
    const t0 = Date.now();
    try {
      await execStdin("git", ["apply", "--check", "-"], { cwd: rcx.repoDir }, diff);
      await execStdin("git", ["apply", "-"], { cwd: rcx.repoDir }, diff);
    } catch (e) {
      logEvent(rcx, { kind: "git", name: "git apply " + p.patch, detail: String(e.stderr || e.message), ms: Date.now() - t0, ok: false });
      throw new Error("Patch 应用失败(" + p.patch + "): " + String(e.stderr || e.message));
    }
    logEvent(rcx, { kind: "git", name: "git apply " + p.patch, detail: diff.length + " 字 diff · 基线 " + hashBefore.slice(0, 8), ms: Date.now() - t0 });
    appendArtifactLine(rcx.runDir, "ledger/patch-ledger.jsonl", {
      patch: p.patch, status: "applied", batchId, hashBefore, patchSha256, sha256: patchSha256,
      appliedAt: new Date().toISOString(),
    });
  }
  return { artifact: "ledger/patch-ledger.jsonl", summary: `应用 ${patches.length} 份 patch` };
}

function hashPatch(diff) {
  return createHash("sha256").update(diff, "utf8").digest("hex");
}

function latestAppliedBatchId(entries) {
  let batchId = null;
  for (const entry of entries) {
    if (entry && entry.status === "applied" && typeof entry.batchId === "string" && entry.batchId) {
      batchId = entry.batchId;
    }
  }
  return batchId;
}

function verifyRollbackFingerprint(entry, diff, lineNo) {
  const expected = [entry.patchSha256, entry.sha256].filter((value) => value !== undefined);
  if (!expected.length) {
    if (entry.batchId) {
      throw new Error("无法回滚：当前 batch ledger 行缺少 patch SHA-256（请重跑 P7）");
    }
    return;
  }
  const actual = hashPatch(diff);
  for (const value of expected) {
    if (!/^[a-f0-9]{64}$/i.test(String(value)) || String(value).toLowerCase() !== actual) {
      throw new Error("无法回滚：ledger 行 " + lineNo + " 的 patch SHA-256 与文件内容不一致");
    }
  }
}

const rollbackLocks = new Map();

function readLedgerEntries(runDir) {
  const file = join(runDir, "ledger", "patch-ledger.jsonl");
  if (!existsSync(file)) throw new Error("无法回滚：patch ledger 不存在");
  const lines = readFileSync(file, "utf8").split(/\r?\n/).filter((line) => line.trim());
  if (!lines.length) throw new Error("无法回滚：patch ledger 为空");
  return lines.map((line, index) => {
    try {
      return JSON.parse(line);
    } catch (error) {
      throw new Error("无法回滚：patch ledger 第 " + index + " 行不是合法 JSON", { cause: error });
    }
  });
}

function patchFileOf(runDir, patch) {
  if (typeof patch !== "string" || !patch.trim()) {
    throw new Error("无法回滚：ledger 行缺少 patch 路径");
  }
  const root = resolve(runDir);
  const full = resolve(root, patch);
  const rel = relative(root, full);
  if (isAbsolute(rel) || rel === ".." || rel.startsWith(".." + "\\") || rel.startsWith(".." + "/")) {
    throw new Error("无法回滚：ledger patch 路径越界");
  }
  return full;
}

async function rollbackLedgerOnce(runDir, repoDir, lineNo) {
  if (!Number.isInteger(lineNo) || lineNo < 0) {
    throw new Error("无法回滚：lineNo 必须是合法行号");
  }
  const entries = readLedgerEntries(runDir);
  if (lineNo >= entries.length) {
    throw new Error("无法回滚：ledger 行号不存在（" + lineNo + "）");
  }
  const entry = entries[lineNo];
  if (!entry || typeof entry !== "object" || Array.isArray(entry) || entry.rollbackOf !== undefined) {
    throw new Error("无法回滚：目标 ledger 行不是应用记录");
  }
  const alreadyRolledBack = entry.status === "rolled_back" || entries.some((candidate) =>
    candidate && Number(candidate.rollbackOf) === lineNo && candidate.status !== "rollback_failed");
  if (alreadyRolledBack) {
    return { status: "already_rolled_back", rollbackOf: lineNo, patch: entry.patch };
  }
  const activeBatchId = latestAppliedBatchId(entries);
  if (activeBatchId && entry.batchId !== activeBatchId) {
    throw new Error("无法回滚：目标 ledger 行不属于当前活动批次");
  }
  const diff = readFileSync(patchFileOf(runDir, entry.patch), "utf8");
  verifyRollbackFingerprint(entry, diff, lineNo);
  try {
    await execStdin("git", ["apply", "-R", "--check", "-"], { cwd: repoDir }, diff);
  } catch (error) {
    const detail = String(error.stderr || error.message || error);
    throw new Error("回滚前置校验失败（ledger 行 " + lineNo + "）: " + detail, { cause: error });
  }
  try {
    await execStdin("git", ["apply", "-R", "-"], { cwd: repoDir }, diff);
  } catch (error) {
    const detail = String(error.stderr || error.message || error);
    throw new Error("回滚执行失败（ledger 行 " + lineNo + "）: " + detail, { cause: error });
  }
  const record = {
    rollbackOf: lineNo, patch: entry.patch, status: "rolled_back",
    ...(entry.batchId ? { batchId: entry.batchId } : {}), at: new Date().toISOString(),
  };
  appendArtifactLine(runDir, "ledger/patch-ledger.jsonl", record);
  return record;
}

export function rollbackLedger(runDir, repoDir, lineNo) {
  const key = runDir + "\u0000" + repoDir + "\u0000" + String(lineNo);
  const previous = rollbackLocks.get(key) || Promise.resolve();
  const task = previous.then(() => rollbackLedgerOnce(runDir, repoDir, lineNo));
  const tail = task.then(() => undefined, () => undefined);
  rollbackLocks.set(key, tail);
  tail.then(() => {
    if (rollbackLocks.get(key) === tail) rollbackLocks.delete(key);
  });
  return task;
}
