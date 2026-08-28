// tests/store.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as store from "../lib/store.js";

const root = mkdtempSync(join(tmpdir(), "i2p-store-"));

test("slugify 规则", () => {
  assert.equal(store.slugify("Session Refresh Logout!!"), "session-refresh-logout");
  assert.equal(store.slugify("刷新 退出"), "run");           // 非 ASCII 全折叠后为空 → run
  assert.equal(store.slugify("--A__B--"), "a-b");
});

test("validateProject 契约", () => {
  const good = { name: "p", slug: "p-1", repos: ["https://x/y.git"],
    triggers: [{ kind: "issue", uri: "https://x/issues/1" }], reviewMode: "every", p6Mode: "builtin" };
  assert.deepEqual(store.validateProject(good), [true, "ok"]);
  assert.equal(store.validateProject({ ...good, slug: "BAD_SLUG" })[0], false);
  assert.equal(store.validateProject({ ...good, repos: [] })[0], false);
  assert.equal(store.validateProject({ ...good, triggers: [{ kind: "bug", uri: "x" }] })[0], false);
  assert.equal(store.validateProject({ ...good, reviewMode: "sometimes" })[0], false);
});

test("saveProject/loadProject/listProjects 往返", () => {
  const p = { name: "演示", slug: "demo", repos: ["r1"], triggers: [], reviewMode: "key-only", p6Mode: "session" };
  store.saveProject(root, p);
  assert.equal(store.loadProject(root, "demo").name, "演示");
  assert.equal(store.listProjects(root).length, 1);
  assert.equal(store.loadProject(root, "nope"), null);
});

test("newRunId 带时间戳与触发源 slug", () => {
  const id = store.newRunId("D:\\issues\\session-logout.md", new Date(2026, 7, 27, 20, 30, 5));
  assert.equal(id, "20260827-203005-session-logout-md");
});

test("createRun 建目录骨架；writeArtifact 拒绝 ..；listRunTree 递归", () => {
  store.saveProject(root, { name: "d", slug: "d", repos: ["r"], triggers: [], reviewMode: "every", p6Mode: "builtin" });
  const { runId, runDir } = store.createRun(root, "d", { kind: "issue", uri: "x.md" });
  assert.ok(/^\d{8}-\d{6}-x-md$/.test(runId));
  for (const sub of ["ledger", "trace", "reviews", "spec-changes"]) assert.ok(existsSync(join(runDir, sub)));
  store.writeArtifact(runDir, "06-implementation/patches/0001-a.diff", "DIFF");
  assert.equal(readFileSync(join(runDir, "06-implementation", "patches", "0001-a.diff"), "utf8"), "DIFF");
  assert.throws(() => store.writeArtifact(runDir, "../escape.txt", "x"), /非法路径/);
  const tree = store.listRunTree(runDir);
  assert.ok(tree.some((f) => f.path === "06-implementation/patches/0001-a.diff"));
});

test("readArtifact 不存在返回 null", () => {
  assert.equal(store.readArtifact(root, "a/b/c.txt"), null);
});

test("createRun 同秒冲突：同一 trigger 连续两次创建抛 Run 已存在", () => {
  store.saveProject(root, { name: "c", slug: "c", repos: ["r"], triggers: [], reviewMode: "every", p6Mode: "builtin" });
  store.createRun(root, "c", { kind: "issue", uri: "dup.md" });
  assert.throws(() => store.createRun(root, "c", { kind: "issue", uri: "dup.md" }), /Run 已存在/);
});