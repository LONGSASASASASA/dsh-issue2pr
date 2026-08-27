// lib/stages/p7-patch.js — 调研 §8/§11：diff 为原子单位；回滚只反应用 Agent patch
import { appendFileSync, readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { writeArtifact, readArtifact } from "../store.js";
import { requireArtifact } from "./helpers.js";

function hashRepo(repoDir) {
  try { return execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoDir, encoding: "utf8" }).trim(); }
  catch { return "nogit"; }
}

export default async function execute(rcx) {
  const report = JSON.parse(requireArtifact(rcx.runDir, "06-implementation/coder-report.json", readArtifact));
  const ledgerPath = join(rcx.runDir, "ledger", "patch-ledger.jsonl");
  for (const p of report.patches || []) {
    const diff = readFileSync(join(rcx.runDir, p.patch), "utf8");
    const hashBefore = hashRepo(rcx.repoDir);
    try {
      execFileSync("git", ["apply", "--check", "-"], { cwd: rcx.repoDir, input: diff, stdio: "pipe" });
      execFileSync("git", ["apply", "-"], { cwd: rcx.repoDir, input: diff, stdio: "pipe" });
    } catch (e) { throw new Error("Patch 应用失败(" + p.patch + "): " + String(e.stderr || e.message)); }
    appendFileSync(ledgerPath, JSON.stringify({ patch: p.patch, hashBefore, appliedAt: new Date().toISOString() }) + "\n");
  }
  return { artifact: "ledger/patch-ledger.jsonl", summary: `应用 ${(report.patches || []).length} 份 patch` };
}

export function rollbackLedger(runDir, repoDir, lineNo) {
  const lines = readFileSync(join(runDir, "ledger", "patch-ledger.jsonl"), "utf8").trim().split("\n");
  const entry = JSON.parse(lines[lineNo]);
  const diff = readFileSync(join(runDir, entry.patch), "utf8");
  execFileSync("git", ["apply", "-R", "-"], { cwd: repoDir, input: diff, stdio: "pipe" });
  appendFileSync(join(runDir, "ledger", "patch-ledger.jsonl"),
    JSON.stringify({ rollbackOf: lineNo, at: new Date().toISOString() }) + "\n");
}