// tests/store.test.js
import { mock, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdtempSync, readFileSync, existsSync, writeFileSync, mkdirSync, chmodSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as store from "../../lib/core/store.js";
import { rmTree, appendArtifactLine } from "../../lib/core/store.js";

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
  assert.equal(store.validateProject({ ...good, maxReviewAttempts: 0 })[0], false);
  assert.equal(store.validateProject({ ...good, maxReviewAttempts: 1.5 })[0], false);
  assert.deepEqual(store.validateProject({ ...good, maxReviewAttempts: 2 }), [true, "ok"]);
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

test("writeArtifact：临时写入中断时保留旧文件并清理临时文件", () => {
  const runDir = join(root, "atomic");
  const artifact = join(runDir, "report.json");
  mkdirSync(runDir, { recursive: true });
  writeFileSync(artifact, "旧内容");
  const originalWrite = fs.writeFileSync;
  const writeMock = mock.method(fs, "writeFileSync", (file, content, ...args) => {
    if (String(file).startsWith(artifact + ".tmp-")) {
      originalWrite(file, String(content).slice(0, 2), ...args);
      throw new Error("模拟写入中断");
    }
    return originalWrite(file, content, ...args);
  });

  try {
    assert.throws(() => store.writeArtifact(runDir, "report.json", "新内容"), /模拟写入中断/);
  } finally {
    writeMock.mock.restore();
  }

  assert.equal(readFileSync(artifact, "utf8"), "旧内容");
  assert.deepEqual(readdirSync(runDir).filter((name) => name.startsWith("report.json.tmp-")), []);
});

test("readArtifact 不存在返回 null", () => {
  assert.equal(store.readArtifact(root, "a/b/c.txt"), null);
});

test("createRun 同秒冲突：同一 trigger 连续两次创建抛 Run 已存在", () => {
  store.saveProject(root, { name: "c", slug: "c", repos: ["r"], triggers: [], reviewMode: "every", p6Mode: "builtin" });
  store.createRun(root, "c", { kind: "issue", uri: "dup.md" });
  assert.throws(() => store.createRun(root, "c", { kind: "issue", uri: "dup.md" }), /Run 已存在/);
});
test("rmTree：删除含只读文件的目录树（Windows git objects 场景）", () => {
  const dir = join(root, "proj-ro");
  mkdirSync(join(dir, "repo", ".git", "objects", "ab"), { recursive: true });
  writeFileSync(join(dir, "repo", ".git", "objects", "ab", "obj1"), "git object");
  chmodSync(join(dir, "repo", ".git", "objects", "ab", "obj1"), 0o444); // 模拟 git 只读对象
  writeFileSync(join(dir, "project.json"), "{}");
  rmTree(dir);
  assert.equal(existsSync(dir), false, "只读文件目录树应被完整删除");
});

test("appendArtifactLine：追加 JSONL 并自动建目录", () => {
  const runDir = join(root, "run-ev");
  appendArtifactLine(runDir, "trace/events.jsonl", { at: "t1", kind: "llm", name: "m1" });
  appendArtifactLine(runDir, "trace/events.jsonl", { at: "t2", kind: "git", name: "g1" });
  const lines = readFileSync(join(runDir, "trace", "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(lines.length, 2);
  assert.equal(lines[1].name, "g1");
});
