// lib/infra/patchEvidence.js — P11 共享的 patch 指纹与实际工作区证据校验
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readArtifact } from "../core/store.js";
import { collectPatches } from "../stages/p7-patch.js";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function normalizedDiff(value) {
  return String(value || "").replace(/\r\n/g, "\n");
}

function firstLine(value) {
  return String(value || "").split("\n").find((line) => line.trim()) || "";
}

function execGit(args, { cwd, env, input = "" }) {
  return new Promise((resolve, reject) => {
    const child = execFile("git", args, {
      cwd, env, timeout: 60000, windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      if (error) {
        error.stderr = String(stderr || error.message);
        reject(error);
      } else {
        resolve(String(stdout || ""));
      }
    });
    child.stdin?.on?.("error", () => {});
    child.stdin.end(input);
  });
}

function normalizedPatchPath(value) {
  return typeof value === "string" ? value.replace(/\\/g, "/") : "";
}

function readLedger(runDir) {
  const raw = readArtifact(runDir, "ledger/patch-ledger.jsonl");
  if (raw == null) return { entries: [], errors: ["patch ledger 不存在，无法完成证据校验"] };
  const entries = [];
  const errors = [];
  let logicalIndex = 0;
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const index = logicalIndex++;
    try {
      const value = JSON.parse(line);
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        errors.push("patch ledger 第 " + index + " 行不是对象");
      } else {
        entries.push({ index, value });
      }
    } catch (error) {
      errors.push("patch ledger 第 " + index + " 行不是合法 JSON: " + String(error.message || error));
    }
  }
  if (!entries.length && !errors.length) errors.push("patch ledger 为空，无法完成证据校验");
  return { entries, errors };
}

function latestAppliedBatchId(entries) {
  let batchId = null;
  for (const item of entries) {
    const entry = item.value;
    if (entry.status === "applied" && typeof entry.batchId === "string" && entry.batchId) {
      batchId = entry.batchId;
    }
  }
  return batchId;
}

function latestLedgerEvents(entries) {
  const batchId = latestAppliedBatchId(entries);
  const byIndex = new Map(entries.map((item) => [item.index, item]));
  const events = new Map();
  for (const item of entries) {
    const entry = item.value;
    if (entry.rollbackOf !== undefined) {
      const target = byIndex.get(Number(entry.rollbackOf));
      const targetBatchId = target?.value?.batchId;
      const eventBatchId = targetBatchId || entry.batchId;
      if (batchId && eventBatchId !== batchId) continue;
      const patch = normalizedPatchPath(entry.patch || target?.value?.patch);
      if (patch) events.set(patch, { kind: "rollback", index: item.index, entry });
      continue;
    }
    if (batchId && entry.batchId !== batchId) continue;
    const patch = normalizedPatchPath(entry.patch);
    if (patch) events.set(patch, { kind: "apply", index: item.index, entry });
  }
  return events;
}

async function indexDiff(repoDir, patches, applyPatches) {
  const tempDir = mkdtempSync(join(tmpdir(), "i2p-p11-index-"));
  try {
    const env = { ...process.env, GIT_INDEX_FILE: join(tempDir, "index") };
    await execGit(["read-tree", "HEAD"], { cwd: repoDir, env });
    if (applyPatches) {
      for (const patch of patches) {
        await execGit(["apply", "--cached", "--binary", "-"], {
          cwd: repoDir, env, input: patch.content,
        });
      }
    } else {
      await execGit(["add", "-A", "--", "."], { cwd: repoDir, env });
    }
    return normalizedDiff(await execGit([
      "diff", "--cached", "--binary", "--no-ext-diff", "--no-renames", "--no-color",
    ], { cwd: repoDir, env }));
  } finally {
    try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* 尽力清理临时索引 */ }
  }
}

/**
 * 校验 P7 patch ledger、补丁内容与实际仓库工作区是否完全一致。
 *
 * Args:
 *   rcx: 至少包含 runDir 与 repoDir 的运行上下文。
 *
 * Returns:
 *   包含逐份 SHA-256、预期/实际 diff 指纹和错误列表的证据结果。
 */
export async function verifyPatchEvidence(rcx) {
  if (!rcx.repoDir) {
    return {
      ok: false,
      skipped: false,
      patches: [],
      errors: ["patch 证据校验缺少 repoDir，拒绝跳过实际仓库 diff 校验"],
    };
  }
  if (!existsSync(rcx.repoDir)) {
    return {
      ok: false,
      skipped: false,
      patches: [],
      errors: ["patch 证据校验 repoDir 不存在: " + rcx.repoDir],
    };
  }
  const errors = [];
  let patches = [];
  try {
    patches = collectPatches(rcx.runDir);
  } catch (error) {
    errors.push(String(error.message || error));
  }
  if (!patches.length) errors.push("未检测到当前补丁清单");

  let ledger = { entries: [], errors: [] };
  try { ledger = readLedger(rcx.runDir); }
  catch (error) { ledger.errors.push("读取 patch ledger 失败: " + String(error.message || error)); }
  errors.push(...ledger.errors);
  const events = latestLedgerEvents(ledger.entries);
  const currentPatchKeys = new Set(patches.map((patch) => normalizedPatchPath(patch.patch)));
  for (const [pathKey, event] of events) {
    if (event.kind === "apply" && !currentPatchKeys.has(pathKey)) {
      errors.push(pathKey + " 存在活动 applied ledger 记录，但不在当前补丁清单");
    }
  }
  const checked = [];
  const applyable = [];

  for (const patch of patches) {
    const pathKey = normalizedPatchPath(patch.patch);
    const event = events.get(pathKey);
    const check = { patch: patch.patch, ok: true };
    if (!event || event.kind !== "apply") {
      check.ok = false;
      errors.push(patch.patch + " 没有对应的最新 applied ledger 记录");
      checked.push(check);
      continue;
    }
    const entry = event.entry;
    const expectedHash = entry.patchSha256 || entry.sha256;
    if (!expectedHash) {
      check.ok = false;
      errors.push(patch.patch + " 的 ledger 缺少 SHA-256（请重跑 P7 生成带指纹台账）");
    } else if (!/^[a-f0-9]{64}$/i.test(String(expectedHash))) {
      check.ok = false;
      errors.push(patch.patch + " 的 ledger SHA-256 格式无效");
    } else if (entry.patchSha256 && entry.sha256 &&
      String(entry.patchSha256).toLowerCase() !== String(entry.sha256).toLowerCase()) {
      check.ok = false;
      errors.push(patch.patch + " 的 patchSha256 与 sha256 不一致");
    }
    const content = readArtifact(rcx.runDir, patch.patch);
    if (content == null) {
      check.ok = false;
      errors.push(patch.patch + " 文件不存在，无法核对 SHA-256");
      checked.push(check);
      continue;
    }
    const actualHash = sha256(content);
    check.sha256 = actualHash;
    check.ledgerSha256 = String(expectedHash || "");
    if (String(expectedHash || "").toLowerCase() !== actualHash) {
      check.ok = false;
      errors.push(patch.patch + " 文件内容 SHA-256 与 ledger 不一致");
    }
    if (check.ok) applyable.push({ rel: patch.patch, content });
    checked.push(check);
  }

  let expectedDiff = "";
  let actualDiff = "";
  if (!errors.length && applyable.length) {
    try {
      expectedDiff = await indexDiff(rcx.repoDir, applyable, true);
      actualDiff = await indexDiff(rcx.repoDir, [], false);
      if (expectedDiff !== actualDiff) {
        errors.push("工作区实际 diff 与已应用 patch 预期不一致（存在额外修改或缺失修改）");
      }
    } catch (error) {
      errors.push("仓库 diff 证据校验失败: " + firstLine(error.stderr || error.message));
    }
  }
  return {
    ok: errors.length === 0,
    skipped: false,
    patches: checked,
    expectedDiffSha256: expectedDiff ? sha256(expectedDiff) : null,
    actualDiffSha256: actualDiff ? sha256(actualDiff) : null,
    errors,
  };
}
