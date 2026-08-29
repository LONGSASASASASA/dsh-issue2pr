// tests/connections.test.js — Git 托管连接：校验/存储/host 匹配/凭据注入/脱敏
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadConnections, upsertConnection, deleteConnection, normalizeConnection,
  hostOf, matchConnection, injectGitCredentials, redactUrl, maskToken,
} from "../lib/connections.js";

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

test("injectGitCredentials：三类托管各自注入；ssh/已带凭据原样返回", () => {
  const gh = { kind: "github", host: "github.com", token: "ghp_x" };
  assert.equal(injectGitCredentials("https://github.com/o/r.git", gh), "https://x-access-token:ghp_x@github.com/o/r.git");
  const gl = { kind: "gitlab", host: "gitlab.com", token: "glo_y" };
  assert.equal(injectGitCredentials("https://gitlab.com/o/r.git", gl), "https://oauth2:glo_y@gitlab.com/o/r.git");
  const ca = { kind: "codearts", host: "codehub.example.com", token: "p@ss:w", username: "tenant/iam" };
  assert.equal(
    injectGitCredentials("https://codehub.example.com/o/r.git", ca),
    "https://tenant%2Fiam:p%40ss%3Aw@codehub.example.com/o/r.git",
  );
  // scp 形态走 SSH key，不注入
  assert.equal(injectGitCredentials("git@github.com:o/r.git", gh), "git@github.com:o/r.git");
  // 用户显式内嵌凭据优先
  assert.equal(injectGitCredentials("https://u:p@github.com/o/r.git", gh), "https://u:p@github.com/o/r.git");
  assert.equal(injectGitCredentials("https://github.com/o/r.git", null), "https://github.com/o/r.git");
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
