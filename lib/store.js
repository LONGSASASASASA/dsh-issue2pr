// lib/store.js — 目录与命名规则（唯一允许写盘的地方）
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join, normalize, sep } from "node:path";

export function defaultDataRoot() { return join(homedir(), ".dsh", "issue2pr"); }

export function slugify(text) {
  const s = String(text).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return s || "run";
}

export function timestamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export function validateProject(p) {
  if (!p || typeof p.name !== "string" || !p.name.trim()) return [false, "缺少项目名称"];
  if (!/^[a-z0-9-]+$/.test(p.slug || "")) return [false, "slug 只允许小写字母/数字/连字符"];
  if (!Array.isArray(p.repos) || p.repos.length === 0) return [false, "至少一个 git 仓库"];
  if (!Array.isArray(p.triggers)) return [false, "triggers 必须是数组"];
  for (const t of p.triggers) {
    if (!t || (t.kind !== "requirement" && t.kind !== "issue") || typeof t.uri !== "string" || !t.uri.trim())
      return [false, "触发源 kind 仅允许 requirement|issue 且 uri 必填"];
  }
  if (!["every", "key-only", "auto"].includes(p.reviewMode)) return [false, "reviewMode 仅允许 every|key-only|auto"];
  if (!["builtin", "session"].includes(p.p6Mode)) return [false, "p6Mode 仅允许 builtin|session"];
  return [true, "ok"];
}

const projectDir = (root, slug) => join(root, "projects", slug);
const projectFile = (root, slug) => join(projectDir(root, slug), "project.json");

export function saveProject(root, p) {
  const [ok, msg] = validateProject(p);
  if (!ok) throw new Error(msg);
  mkdirSync(projectDir(root, p.slug), { recursive: true });
  const tmp = projectFile(root, p.slug) + ".tmp";
  writeFileSync(tmp, JSON.stringify({ ...p, updatedAt: new Date().toISOString() }, null, 2));
  renameSync(tmp, projectFile(root, p.slug));
}

export function loadProject(root, slug) {
  if (!existsSync(projectFile(root, slug))) return null;
  return JSON.parse(readFileSync(projectFile(root, slug), "utf8"));
}

export function listProjects(root) {
  const dir = join(root, "projects");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((slug) => {
    const p = loadProject(root, slug);
    return p ? [p] : [];
  });
}

export function newRunId(triggerUri, now = new Date()) {
  const base = String(triggerUri).split(/[\\/]/).pop().slice(0, 24);
  return `${timestamp(now)}-${slugify(base)}`;
}

export function runDirOf(root, slug, runId) {
  if (!/^\d{8}-\d{6}-[a-z0-9-]+$/.test(runId)) throw new Error("非法 runId: " + runId);
  return join(projectDir(root, slug), "runs", runId);
}

export function createRun(root, slug, trigger) {
  const runId = newRunId(trigger.uri);
  const runDir = runDirOf(root, slug, runId);
  for (const sub of ["", "ledger", "trace", "reviews", "spec-changes"])
    mkdirSync(join(runDir, sub), { recursive: true });
  return { runId, runDir };
}

function safeJoin(runDir, rel) {
  const full = normalize(join(runDir, rel));
  if (full !== runDir && !full.startsWith(runDir + sep)) throw new Error("非法路径: " + rel);
  return full;
}

export function writeArtifact(runDir, rel, content) {
  const full = safeJoin(runDir, rel);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content);
}

export function readArtifact(runDir, rel) {
  const full = safeJoin(runDir, rel);
  return existsSync(full) ? readFileSync(full, "utf8") : null;
}

export function listRunTree(runDir) {
  const out = [];
  (function walk(dir) {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      const st = statSync(full);
      if (st.isDirectory()) walk(full);
      else out.push({ path: full.slice(runDir.length + 1).split(sep).join("/"), size: st.size, mtimeMs: st.mtimeMs });
    }
  })(runDir);
  return out.sort((a, b) => a.path.localeCompare(b.path));
}