// lib/connections.js — Git 托管连接（GitHub / GitLab / 华为云 CodeArts 凭据）
// 全局共享：<dataRoot>/connections.json（与项目无关，一套凭据多项目复用）。
// 主 JSON 只保存连接元数据与 secretRef；秘密由 SecretStore keychain-first 管理。
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWritePrivateFile, getSecretStore, secretRefFor } from "./secretStore.js";

export const CONNECTION_KINDS = {
  github: { label: "GitHub", defaultHost: "github.com", hostFixed: true, needsUsername: false, tokenLabel: "Access Token" },
  gitlab: { label: "GitLab", defaultHost: "gitlab.com", hostFixed: false, needsUsername: false, tokenLabel: "Personal Access Token" },
  codearts: { label: "华为云 CodeArts", defaultHost: "", hostFixed: false, needsUsername: true, tokenLabel: "HTTPS 密码" },
};

const connFile = (root) => join(root, "connections.json");

function setInMemoryToken(connection, token) {
  Object.defineProperty(connection, "token", {
    value: String(token || ""), enumerable: false, configurable: true, writable: true,
  });
  return connection;
}

function refOf(connection) {
  return connection.secretRef || secretRefFor("git", connection.host || connection.id);
}

function connectionMetadata(connection, store) {
  const metadata = { ...(connection || {}) };
  const token = typeof connection?.token === "string" ? connection.token : "";
  delete metadata.token;
  if (token) {
    const ref = refOf(metadata);
    const saved = store.set(ref, token);
    metadata.secretRef = ref;
    metadata.secretStorage = saved.mode;
    metadata.secretEncrypted = saved.encrypted;
    if (saved.warning) metadata.secretWarning = saved.warning;
    else delete metadata.secretWarning;
  } else if (metadata.secretRef) {
    const info = store.describe(metadata.secretRef);
    metadata.secretStorage = metadata.secretStorage || info.mode;
    metadata.secretEncrypted = info.encrypted;
    if (info.warning) metadata.secretWarning = info.warning;
    else delete metadata.secretWarning;
  }
  return metadata;
}

export function loadConnections(root) {
  const file = connFile(root);
  if (!existsSync(file)) return [];
  try {
    const raw = JSON.parse(readFileSync(file, "utf8"));
    if (!Array.isArray(raw)) return [];
    const store = getSecretStore(root);
    let migrated = false;
    const list = raw.filter((entry) => entry && typeof entry === "object").map((entry) => {
      const connection = { ...entry };
      const legacyToken = typeof entry.token === "string" ? entry.token : "";
      const ref = entry.secretRef || (legacyToken ? refOf(entry) : "");
      let token = "";
      if (legacyToken && ref) {
        const saved = store.set(ref, legacyToken);
        connection.secretRef = ref;
        connection.secretStorage = saved.mode;
        connection.secretEncrypted = saved.encrypted;
        if (saved.warning) connection.secretWarning = saved.warning;
        delete connection.token;
        token = legacyToken;
        migrated = true;
      } else if (ref) {
        const loaded = store.get(ref);
        if (loaded) {
          token = loaded.value;
          connection.secretStorage = loaded.mode;
          connection.secretEncrypted = loaded.encrypted;
          if (loaded.warning) connection.secretWarning = loaded.warning;
          else delete connection.secretWarning;
        }
        delete connection.token;
      }
      return setInMemoryToken(connection, token);
    });
    if (migrated) {
      try { saveConnections(root, list); } catch { /* 下次读取重试迁移，不丢弃内存中的 token */ }
    }
    return list;
  } catch { return []; }
}

export function saveConnections(root, list) {
  const store = getSecretStore(root);
  const metadata = (Array.isArray(list) ? list : [])
    .filter((entry) => entry && typeof entry === "object")
    .map((entry) => connectionMetadata(entry, store));
  atomicWritePrivateFile(connFile(root), JSON.stringify(metadata, null, 2));
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
  const store = getSecretStore(root);
  const ref = secretRefFor("git", norm.host);
  const saved = store.set(ref, norm.token);
  const persisted = {
    ...norm, secretRef: ref, secretStorage: saved.mode, secretEncrypted: saved.encrypted,
  };
  if (saved.warning) persisted.secretWarning = saved.warning;
  delete persisted.token;
  const i = list.findIndex((x) => x.host === norm.host);
  if (i >= 0) list[i] = persisted; else list.push(persisted);
  saveConnections(root, list);
  return setInMemoryToken({ ...persisted }, norm.token);
}

export function deleteConnection(root, id) {
  const list = loadConnections(root);
  const i = list.findIndex((x) => x.id === id || x.host === id);
  if (i < 0) return null;
  const [removed] = list.splice(i, 1);
  const store = getSecretStore(root);
  store.delete(refOf(removed));
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

function decodeUrlPart(value) {
  try { return decodeURIComponent(String(value || "")); } catch { return String(value || ""); }
}

function nextGitConfigIndex(env) {
  const count = Number.parseInt(String(env.GIT_CONFIG_COUNT || ""), 10);
  return Number.isInteger(count) && count >= 0 ? count : 0;
}

/**
 * 构造不泄露凭据的 Git URI 与进程环境。

 * Args:
 *   uri: 原始仓库 URI。
 *   conn: 匹配到的托管连接，可为空。
 *   baseEnv: 子进程继承的基础环境。

 * Returns:
 *   清理后的 URI 与包含临时 Git extraheader 的环境对象。
 */
export function gitCredentialSpec(uri, conn, baseEnv = process.env) {
  const source = String(uri || "");
  const env = { ...(baseEnv || {}) };
  if (!/^https?:\/\//i.test(source)) return { uri: source, env };

  let parsed;
  try { parsed = new URL(source); } catch { return { uri: source, env }; }
  const embeddedUser = decodeUrlPart(parsed.username);
  const embeddedToken = decodeUrlPart(parsed.password);
  const hasEmbedded = Boolean(parsed.username || parsed.password);
  let username = embeddedUser;
  let token = embeddedToken;
  if (!hasEmbedded && conn && conn.token) {
    username = conn.kind === "github" ? "x-access-token"
      : conn.kind === "gitlab" ? "oauth2" : String(conn.username || "");
    token = String(conn.token);
  }

  // 仅有用户名时没有可转移的秘密：保留原 URI，让 Git 继续执行其自身认证流程。
  // 只有密码或连接 token 存在时才清理 URI 并注入临时 extraheader。
  if (!parsed.password && !token) return { uri: source, env };

  parsed.username = "";
  parsed.password = "";
  const cleanUri = parsed.toString();
  if (!token && !username) return { uri: cleanUri, env };

  const index = nextGitConfigIndex(env);
  const basic = Buffer.from(username + ":" + token, "utf8").toString("base64");
  env.GIT_CONFIG_COUNT = String(index + 1);
  env["GIT_CONFIG_KEY_" + index] = "http." + parsed.origin + "/.extraheader";
  env["GIT_CONFIG_VALUE_" + index] = "AUTHORIZATION: Basic " + basic;
  // 私有仓库认证失败时立即返回，避免 Git 等待交互式密码输入。
  env.GIT_TERMINAL_PROMPT = "0";
  return { uri: cleanUri, env };
}

// 兼容旧调用方：名称保留，但绝不再返回带凭据的 URL。
export function injectGitCredentials(uri, conn) {
  return gitCredentialSpec(uri, conn, {}).uri;
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
