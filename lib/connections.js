// lib/connections.js — Git 托管连接（GitHub / GitLab / 华为云 CodeArts 凭据）
// 全局共享：<dataRoot>/connections.json（与项目无关，一套凭据多项目复用）。
// token 明文落盘，与本机 GITHUB_TOKEN 环境变量同级安全；UI 注明存储路径。
import { existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";

export const CONNECTION_KINDS = {
  github: { label: "GitHub", defaultHost: "github.com", hostFixed: true, needsUsername: false, tokenLabel: "Access Token" },
  gitlab: { label: "GitLab", defaultHost: "gitlab.com", hostFixed: false, needsUsername: false, tokenLabel: "Personal Access Token" },
  codearts: { label: "华为云 CodeArts", defaultHost: "", hostFixed: false, needsUsername: true, tokenLabel: "HTTPS 密码" },
};

const connFile = (root) => join(root, "connections.json");

export function loadConnections(root) {
  const file = connFile(root);
  if (!existsSync(file)) return [];
  try {
    const list = JSON.parse(readFileSync(file, "utf8"));
    return Array.isArray(list) ? list : [];
  } catch { return []; }
}

export function saveConnections(root, list) {
  const tmp = connFile(root) + ".tmp";
  writeFileSync(tmp, JSON.stringify(list, null, 2));
  renameSync(tmp, connFile(root));
}

// 校验 + 规范化；id 直接用 host（同 host 唯一，天然 upsert 键）
export function normalizeConnection(c, existing = []) {
  if (!c || typeof c !== "object") throw new Error("连接必须是对象");
  const kind = CONNECTION_KINDS[c.kind] ? c.kind : null;
  if (!kind) throw new Error("kind 仅允许 github|gitlab|codearts");
  const meta = CONNECTION_KINDS[kind];
  let host = String(c.host || meta.defaultHost || "").trim().toLowerCase();
  // 去掉用户误粘贴的协议前缀与路径
  host = host.replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/:\d+$/, "");
  if (!/^[a-z0-9.-]+(\.[a-z0-9-]+)*$/.test(host)) {
    throw new Error("host 必须是合法域名（如 github.com / gitlab.example.com）");
  }
  if (meta.hostFixed && host !== meta.defaultHost) {
    throw new Error(kind + " 连接的 host 固定为 " + meta.defaultHost);
  }
  const token = String(c.token || "").trim();
  if (!token) throw new Error("token 不能为空");
  if (meta.needsUsername && !String(c.username || "").trim()) {
    throw new Error("CodeArts 连接需要 HTTPS 用户名（租户名/IAM用户名，在 CodeArts「个人设置 → HTTPS密码」页获取）");
  }
  const dup = existing.find((x) => x.host === host);
  if (dup && dup.kind !== kind) throw new Error(host + " 已配置为 " + CONNECTION_KINDS[dup.kind].label + " 连接，请先删除原连接");
  const out = { id: host, kind, host, token, createdAt: dup?.createdAt || new Date().toISOString() };
  if (meta.needsUsername) out.username = String(c.username).trim();
  return out;
}

export function upsertConnection(root, c) {
  const list = loadConnections(root);
  const norm = normalizeConnection(c, list);
  const i = list.findIndex((x) => x.host === norm.host);
  if (i >= 0) list[i] = norm; else list.push(norm);
  saveConnections(root, list);
  return norm;
}

export function deleteConnection(root, id) {
  const list = loadConnections(root);
  const i = list.findIndex((x) => x.id === id || x.host === id);
  if (i < 0) return null;
  const [removed] = list.splice(i, 1);
  saveConnections(root, list);
  return removed;
}

// 从仓库/issue URI 解析 hostname：支持 https、ssh://、scp 形态（git@host:path）
export function hostOf(uri) {
  const s = String(uri || "").trim();
  const m = s.match(/^(?:https?|ssh|git):\/\/(?:[^@\/]+@)?([^\/:?#]+)/i);
  if (m) return m[1].toLowerCase();
  const scp = s.match(/^git@([^\/:?#]+):/);
  if (scp) return scp[1].toLowerCase();
  return null;
}

export function matchConnection(uri, list) {
  const host = hostOf(uri);
  if (!host) return null;
  return list.find((c) => c.host === host) || null;
}

// https 仓库地址注入凭据；ssh/scp 形态或已内嵌凭据的地址原样返回（用户显式配置优先）
export function injectGitCredentials(uri, conn) {
  const s = String(uri || "");
  if (!conn || !/^https?:\/\//i.test(s)) return s;
  try {
    const u = new URL(s);
    if (u.username || u.password) return s;
    if (conn.kind === "github") { u.username = "x-access-token"; u.password = conn.token; }
    else if (conn.kind === "gitlab") { u.username = "oauth2"; u.password = conn.token; }
    else { u.username = conn.username || ""; u.password = conn.token; }
    return u.toString();
  } catch { return s; }
}

// 错误信息/事件日志脱敏：https://user:pass@… → https://***@…（URL 可嵌在句子中间，全局替换）
export function redactUrl(uri) {
  return String(uri || "").replace(/(https?:\/\/)[^@\/\s'"]+@/gi, "$1***@");
}

export function maskToken(token) {
  const t = String(token || "");
  if (t.length <= 8) return "****";
  return t.slice(0, 4) + "…" + t.slice(-4);
}
