// tests/connections.test.js — Git 托管连接：校验/存储/host 匹配/凭据注入/脱敏
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadConnections, upsertConnection, deleteConnection, normalizeConnection,
  hostOf, matchConnection, gitCredentialSpec, redactUrl, maskToken,
} from "../../lib/infra/connections.js";

const root = mkdtempSync(join(tmpdir(), "i2p-conn-"));

test("normalizeConnection 校验：kind 枚举/host 合法性/CodeArts 用户名必填", () => {
  assert.throws(() => normalizeConnection({ kind: "gitee", host: "x.com", token: "t" }), /kind 仅允许/);
  assert.throws(() => normalizeConnection({ kind: "codearts", host: "bad_host", token: "t", username: "u" }), /host 必须是合法域名/);
  assert.throws(() => normalizeConnection({ kind: "github", host: "gitlab.com", token: "t" }), /固定为 github\.com/);
  assert.throws(() => normalizeConnection({ kind: "codearts", host: "codehub.example.com", token: "t" }), /HTTPS 用户名/);
  assert.throws(() => normalizeConnection({ kind: "github", host: "github.com", token: "  " }), /token 不能为空/);
  // 误粘贴完整 URL / 带端口 → 归一化为纯域名
  const n = normalizeConnection({ kind: "gitlab", host: "https://GitLab.Example.com:443/group", token: "t" });
  assert.equal(n.host, "gitlab.example.com");
});

test("upsertConnection 同 host 覆盖、跨 kind 冲突拒绝；deleteConnection", () => {
  const a = upsertConnection(root, { kind: "github", host: "github.com", token: "ghp_old_token" });
  assert.equal(a.id, "github.com");
  const b = upsertConnection(root, { kind: "github", host: "GITHUB.com", token: "ghp_new_token" });
  assert.equal(loadConnections(root).length, 1);
  assert.equal(b.token, "ghp_new_token");
  assert.equal(b.createdAt, a.createdAt, "覆盖时保留原 createdAt");
  assert.throws(() => upsertConnection(root, { kind: "gitlab", host: "github.com", token: "t" }), /已配置为 GitHub/);
  assert.ok(deleteConnection(root, "github.com"));
  assert.equal(loadConnections(root).length, 0);
  assert.equal(deleteConnection(root, "github.com"), null);
});

test("hostOf 支持 https / ssh:// / scp 形态", () => {
  assert.equal(hostOf("https://github.com/org/repo.git"), "github.com");
  assert.equal(hostOf("https://user@bitbucket.org/org/repo"), "bitbucket.org");
  assert.equal(hostOf("ssh://git@gitlab.com:22/org/repo.git"), "gitlab.com");
  assert.equal(hostOf("git@gitlab.example.com:org/repo.git"), "gitlab.example.com");
  assert.equal(hostOf("D:\\repos\\local"), null);
});

test("matchConnection 按 hostname 精确匹配", () => {
  const list = [
    { id: "github.com", kind: "github", host: "github.com", token: "t1" },
    { id: "codehub.cn-north-4.huaweicloud.com", kind: "codearts", host: "codehub.cn-north-4.huaweicloud.com", token: "p", username: "tenant/iam" },
  ];
  assert.equal(matchConnection("https://github.com/o/r.git", list).kind, "github");
  assert.equal(matchConnection("git@codehub.cn-north-4.huaweicloud.com:o/r.git", list).kind, "codearts");
  assert.equal(matchConnection("https://gitlab.com/o/r.git", list), null);
});

test("gitCredentialSpec：URL 不带凭据，认证只进入 http.extraheader 环境", () => {
  const gh = { kind: "github", host: "github.com", token: "ghp_x" };
  const ghSpec = gitCredentialSpec("https://github.com/o/r.git", gh, { BASE: "keep" });
  assert.equal(ghSpec.uri, "https://github.com/o/r.git");
  assert.equal(ghSpec.env.BASE, "keep");
  assert.equal(ghSpec.env.GIT_CONFIG_KEY_0, "http.https://github.com/.extraheader");
  assert.equal(ghSpec.env.GIT_CONFIG_VALUE_0, "AUTHORIZATION: Basic eC1hY2Nlc3MtdG9rZW46Z2hwX3g=");
  assert.equal(ghSpec.env.GIT_TERMINAL_PROMPT, "0");
  assert.doesNotMatch(ghSpec.uri, /ghp_x/);
  const gl = { kind: "gitlab", host: "gitlab.com", token: "glo_y" };
  const glSpec = gitCredentialSpec("https://gitlab.com/o/r.git", gl, {});
  assert.equal(glSpec.uri, "https://gitlab.com/o/r.git");
  assert.equal(glSpec.env.GIT_CONFIG_VALUE_0, "AUTHORIZATION: Basic b2F1dGgyOmdsb195");
  const ca = { kind: "codearts", host: "codehub.example.com", token: "p@ss:w", username: "tenant/iam" };
  const caSpec = gitCredentialSpec("https://codehub.example.com/o/r.git", ca, {});
  assert.equal(caSpec.uri, "https://codehub.example.com/o/r.git");
  assert.equal(caSpec.env.GIT_CONFIG_VALUE_0, "AUTHORIZATION: Basic dGVuYW50L2lhbTpwQHNzOnc=");
  // scp 形态走 SSH key，不注入
  const sshSpec = gitCredentialSpec("git@github.com:o/r.git", gh, { BASE: "keep" });
  assert.equal(sshSpec.uri, "git@github.com:o/r.git");
  assert.equal(sshSpec.env.BASE, "keep");
  // 用户显式内嵌凭据也必须从 argv 移走
  const embeddedSpec = gitCredentialSpec("https://u:p@github.com/o/r.git", gh, {});
  assert.equal(embeddedSpec.uri, "https://github.com/o/r.git");
  assert.equal(embeddedSpec.env.GIT_CONFIG_VALUE_0, "AUTHORIZATION: Basic dTpw");
  const anonymousSpec = gitCredentialSpec("https://github.com/o/r.git", null, {});
  assert.equal(anonymousSpec.uri, "https://github.com/o/r.git");
  assert.equal(anonymousSpec.env.GIT_CONFIG_VALUE_0, undefined);
});

test("gitCredentialSpec：仅用户名 URL 保留原认证流程，不注入空密码", () => {
  const spec = gitCredentialSpec("https://alice@github.com/org/repo.git", null, { BASE: "keep" });

  assert.equal(spec.uri, "https://alice@github.com/org/repo.git");
  assert.equal(spec.env.BASE, "keep");
  assert.equal(spec.env.GIT_CONFIG_COUNT, undefined);
  assert.equal(spec.env.GIT_TERMINAL_PROMPT, undefined);
});

test("redactUrl / maskToken 脱敏", () => {
  assert.equal(redactUrl("https://x-access-token:ghp_secret@github.com/o/r.git"), "https://***@github.com/o/r.git");
  assert.equal(redactUrl("https://github.com/o/r.git"), "https://github.com/o/r.git");
  // URL 嵌在错误句子里也要脱敏（git stderr 场景），多处全替换
  assert.equal(
    redactUrl("Authentication failed for 'https://x-access-token:ghp_x@github.com/o/r.git/' and 'https://oauth2:glt@gitlab.com/a/b.git'"),
    "Authentication failed for 'https://***@github.com/o/r.git/' and 'https://***@gitlab.com/a/b.git'",
  );
  assert.equal(maskToken("ghp_1234567890abcdef"), "ghp_…cdef");
  assert.equal(maskToken("short"), "****");
});

test("connections：兼容旧明文文件并迁移，主 JSON 只保留 secretRef", () => {
  const legacyRoot = mkdtempSync(join(tmpdir(), "i2p-conn-legacy-"));
  writeFileSync(join(legacyRoot, "connections.json"), JSON.stringify([
    { id: "github.com", kind: "github", host: "github.com", token: "ghp_legacy" },
  ]));

  const list = loadConnections(legacyRoot);

  assert.equal(list[0].token, "ghp_legacy");
  const migrated = readFileSync(join(legacyRoot, "connections.json"), "utf8");
  assert.doesNotMatch(migrated, /ghp_legacy/);
  assert.match(migrated, /secretRef/);
});
