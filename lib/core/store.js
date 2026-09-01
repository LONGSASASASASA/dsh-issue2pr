// lib/store.js — 目录与命名规则（唯一允许写盘的地方）
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync, renameSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, normalize, sep } from "node:path";
import { validateStageConfig } from "./stageConfig.js";

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
  for (const r of p.repos) {
    const uri = typeof r === "string" ? r : r?.uri;
    if (typeof uri !== "string" || !uri.trim()) return [false, "仓库条目必须是 uri 字符串或 { uri }"];
  }
  if (!Array.isArray(p.triggers)) return [false, "triggers 必须是数组"];
  for (const t of p.triggers) {
    if (!t || (t.kind !== "requirement" && t.kind !== "issue") || typeof t.uri !== "string" || !t.uri.trim())
      return [false, "触发源 kind 仅允许 requirement|issue 且 uri 必填"];
  }
  if (!["every", "key-only", "auto"].includes(p.reviewMode)) return [false, "reviewMode 仅允许 every|key-only|auto"];
  if (!["builtin", "session", "claude", "dsh"].includes(p.p6Mode)) return [false, "p6Mode 仅允许 builtin|session|claude|dsh"];
  if (p.maxReviewAttempts !== undefined &&
      (!Number.isInteger(p.maxReviewAttempts) || p.maxReviewAttempts < 1)) {
    return [false, "maxReviewAttempts 必须是正整数"];
  }
  const [scOk, scMsg] = validateStageConfig(p.stageConfig);
  if (!scOk) return [false, scMsg];
  return [true, "ok"];
}

const projectDir = (root, slug) => join(root, "projects", slug);
const projectFile = (root, slug) => join(projectDir(root, slug), "project.json");

export function saveProject(root, p) {
  const [ok, msg] = validateProject(p);
  if (!ok) throw new Error(msg);
  // 规范化：repos 允许传字符串或 { uri }，落盘统一为 { uri }，下游（clone 等）不用再做双形态判断
  const norm = { ...p, repos: p.repos.map((r) => (typeof r === "string" ? { uri: r.trim() } : { uri: String(r.uri).trim() })) };
  mkdirSync(projectDir(root, norm.slug), { recursive: true });
  const tmp = projectFile(root, norm.slug) + ".tmp";
  writeFileSync(tmp, JSON.stringify({ ...norm, updatedAt: new Date().toISOString() }, null, 2));
  renameSync(tmp, projectFile(root, norm.slug));
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

// —— UI 偏好（当前仅 lastProject）：宿主 webview 的 localStorage 不跨软件重启持久，
// 选中记忆以此文件为兜底；localStorage 命中时零延迟、不请求。
export function loadUiState(root) {
  const file = join(root, "ui-state.json");
  if (!existsSync(file)) return {};
  try { return JSON.parse(readFileSync(file, "utf8")) || {}; }
  catch { return {}; }
}

export function saveUiState(root, state) {
  const tmp = join(root, "ui-state.json.tmp");
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, join(root, "ui-state.json"));
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
  if (existsSync(runDir)) throw new Error("Run 已存在: " + runId);
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
  mkdirSync(dirname(full), { recursive: true });
  const tmp = full + ".tmp-" + randomUUID();
  try {
    fs.writeFileSync(tmp, content);
    renameSync(tmp, full);
  } catch (error) {
    try { rmSync(tmp, { force: true }); } catch { /* 临时文件清理尽力而为 */ }
    throw error;
  }
}

export function recoverCorruptRun(runDir, stageId, message, parseError) {
  const runFile = join(runDir, "run.json");
  const backup = runFile + ".corrupt-" + randomUUID();
  renameSync(runFile, backup);
  const project = basename(dirname(dirname(runDir)));
  const id = stageId || "P1";
  return {
    id: basename(runDir),
    project,
    status: "running",
    current: id,
    stages: { [id]: { status: "running", attempts: 0 } },
    recovery: {
      kind: "malformed-run-json",
      backup: basename(backup),
      parseError: String((parseError && parseError.message) || parseError),
    },
    trigger: null,
    reviewMode: "auto",
    p6Mode: "builtin",
    error: message,
  };
}

export function readArtifact(runDir, rel) {
  const full = safeJoin(runDir, rel);
  return existsSync(full) ? readFileSync(full, "utf8") : null;
}

// 追加一行 JSONL（trace 事件流等）；目录不存在自动建
export function appendArtifactLine(runDir, rel, obj) {
  const full = safeJoin(runDir, rel);
  mkdirSync(join(full, ".."), { recursive: true });
  appendFileSync(full, JSON.stringify(obj) + "\n");
}

// 删除整棵目录（项目 / Run）。Windows 下 git 克隆的 .git/objects 文件是只读的，
// 直接 rmSync 会 EPERM；先递归清只读位，再带重试删除（杀毒/索引器短暂占用）。
export function rmTree(dir) {
  if (!existsSync(dir)) return;
  try {
    (function clearReadOnly(d) {
      for (const name of readdirSync(d)) {
        const full = join(d, name);
        const st = statSync(full);
        if (st.isDirectory()) clearReadOnly(full);
        else if (!(st.mode & 0o200)) chmodSync(full, 0o666);
      }
    })(dir);
  } catch { /* 清位尽力而为，失败仍尝试删除 */ }
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 120 });
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
