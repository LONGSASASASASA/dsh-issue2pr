// lib/stages/helpers.js — 各阶段通用辅助（读触发文档 / 列仓库文件 / 读文件 / 取上游产物）
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, sep } from "node:path";

export async function readTriggerText(rcx) {
  const uri = rcx.trigger.uri;
  if (/^https?:\/\//.test(uri)) return `<远程触发文档，按 URL 语义理解: ${uri}>`;
  if (!existsSync(uri)) throw new Error("触发文档不存在: " + uri);
  return readFileSync(uri, "utf8");
}

const IGNORE = new Set([".git", "node_modules", "dist", ".next", "coverage"]);
export function listRepoFiles(repoDir, max = 400) {
  const out = [];
  (function walk(dir) {
    if (out.length >= max || !existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      if (IGNORE.has(name)) continue;
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else { out.push(full.slice(repoDir.length + 1).split(sep).join("/")); if (out.length >= max) return; }
    }
  })(repoDir);
  return out;
}

export function readRepoFile(repoDir, rel, maxChars = 6000) {
  // 防路径逃逸（Task 7 修复）：含 .. 段或绝对路径的 rel 直接占位返回，不读仓库外文件
  const relStr = String(rel);
  if (relStr.split(/[\\/]+/).includes("..") || /^([a-zA-Z]:)?[\\/]/.test(relStr)) return "(非法路径)";
  const full = join(repoDir, rel);
  if (!existsSync(full)) return `<文件不存在: ${rel}>`;
  return readFileSync(full, "utf8").slice(0, maxChars);
}

export function requireArtifact(runDir, rel, readArtifact) {
  const text = readArtifact(runDir, rel);
  if (text == null) throw new Error("缺少上游产物: " + rel);
  return text;
}