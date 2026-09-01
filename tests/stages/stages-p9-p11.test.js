// tests/stages-p9-p11.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import p9 from "../../lib/stages/p9-reviewer.js";
import p11, { verifyPatchEvidence } from "../../lib/stages/p11-pr-builder.js";
import p7 from "../../lib/stages/p7-patch.js";

const root = mkdtempSync(join(tmpdir(), "i2p-p911-"));
function runDir() {
  const d = mkdtempSync(join(root, "run-"));
  mkdirSync(join(d, "06-implementation", "patches"), { recursive: true });
  writeFileSync(join(d, "06-implementation", "patches", "0001-a.diff"), "--- a/a\n+++ b/a\n@@ -1 +1 @@\n-x\n+y\n");
  writeFileSync(join(d, "07-test-report.json"), JSON.stringify({ passed: true, exitCode: 0 }));
  writeFileSync(join(d, "01-issue-analysis.json"), JSON.stringify({ phenomenon: "刷新退出" }));
  writeFileSync(join(d, "06-implementation", "coder-report.json"), JSON.stringify({ mode: "builtin", patches: [{ node: "T1", file: "a", patch: "06-implementation/patches/0001-a.diff" }] }));
  return d;
}
const passLlm = {
  completeJson: async () => ({ diff_scope: "最小", api_security: "无风险", tests: "已补强", verdict: "pass",
    ROOT: "pass", PATCH: "pass", TEST: "pass", DIFF: "pass", DESC: "pass", ACCEPT: "pass" }),
  complete: async () => "# PR：修复刷新退出\n\n## 修改\n- guard await",
};

function realRepo() {
  const dir = mkdtempSync(join(root, "repo-"));
  const git = (args) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
  git(["init"]); git(["config", "user.email", "t@t"]); git(["config", "user.name", "t"]);
  git(["config", "core.autocrlf", "false"]);
  writeFileSync(join(dir, "a"), "old\n");
  git(["add", "."]); git(["commit", "-m", "init"]);
  return dir;
}

function patchRun(repoDir) {
  const d = runDir();
  mkdirSync(join(d, "ledger"), { recursive: true });
  writeFileSync(join(d, "06-implementation", "patches", "0001-a.diff"),
    "--- a/a\n+++ b/a\n@@ -1 +1 @@\n-old\n+new\n");
  return p7({ runDir: d, repoDir, llm: null }).then(() => d);
}

test("P9：三维门控产出 08-review-report.json", async () => {
  const d = runDir();
  let captured = "";
  const llm = { ...passLlm, completeJson: async (q) => { captured = q.user; return passLlm.completeJson(q); } };
  const r = await p9({ runDir: d, llm, reviewComment: "" });
  assert.equal(r.artifact, "08-review-report.json");
  const saved = JSON.parse(readFileSync(join(d, r.artifact), "utf8"));
  assert.equal(saved.verdict, "pass");
  // 修复轮：真实 diff 内容必须进入 prompt（Diff 范围裁决不许盲审）
  assert.match(captured, /【Diff 全文】/);
  assert.match(captured, /0001-a\.diff/);
  assert.match(captured, /\+y/);
});

test("P9：verdict=fail 抛错", async () => {
  const d = runDir();
  const failLlm = { ...passLlm, completeJson: async () => ({ diff_scope: "越权", api_security: "-", tests: "-", verdict: "fail" }) };
  await assert.rejects(() => p9({ runDir: d, llm: failLlm, reviewComment: "" }), /Reviewer 门控未过/);
});

test("P11：产出 PR 说明 + eval Gate 六项", async () => {
  const repo = realRepo();
  const d = await patchRun(repo);
  writeFileSync(join(d, "08-review-report.json"), JSON.stringify({ verdict: "pass" }));
  const r = await p11({ runDir: d, repoDir: repo, llm: passLlm, reviewComment: "" });
  assert.equal(r.artifact, "10-pr-description.md");
  assert.match(readFileSync(join(d, "10-pr-description.md"), "utf8"), /修复刷新退出/);
  const evalReport = JSON.parse(readFileSync(join(d, "11-eval-report.json"), "utf8"));
  for (const g of ["ROOT", "PATCH", "TEST", "DIFF", "DESC", "ACCEPT"]) assert.equal(evalReport[g], "pass");
});

test("P11：外部 eval 自报 pass 但实际仓库有额外改动时强制 PATCH/DIFF fail", async () => {
  const repo = realRepo();
  const d = await patchRun(repo);
  writeFileSync(join(repo, "a"), "unexpected\n");

  await assert.rejects(
    () => p11({ runDir: d, repoDir: repo, llm: passLlm, reviewComment: "" }),
    /证据校验未通过/,
  );
  const evalReport = JSON.parse(readFileSync(join(d, "11-eval-report.json"), "utf8"));
  assert.equal(evalReport.PATCH, "fail");
  assert.equal(evalReport.DIFF, "fail");
  assert.ok(evalReport.patchEvidence.errors.length > 0);
});

test("P11：patch 文件被篡改时按 ledger SHA-256 拒绝放行", async () => {
  const repo = realRepo();
  const d = await patchRun(repo);
  writeFileSync(join(d, "06-implementation", "patches", "0001-a.diff"),
    "--- a/a\n+++ b/a\n@@ -1 +1 @@\n-old\n+tampered\n");

  await assert.rejects(
    () => p11({ runDir: d, repoDir: repo, llm: passLlm, reviewComment: "" }),
    /SHA-256|证据校验未通过/,
  );
  const evalReport = JSON.parse(readFileSync(join(d, "11-eval-report.json"), "utf8"));
  assert.equal(evalReport.PATCH, "fail");
});

test("P11：证据校验缺少 repoDir 时失败闭合，不得静默跳过", async () => {
  const repo = realRepo();
  const d = await patchRun(repo);

  const evidence = await verifyPatchEvidence({ runDir: d });

  assert.equal(evidence.ok, false);
  assert.equal(evidence.skipped, false);
  assert.match(evidence.errors.join("；"), /repoDir/);
});

test("P11：patch 清单路径越界时返回结构化证据失败", async () => {
  const repo = realRepo();
  const d = runDir();
  mkdirSync(join(d, "ledger"), { recursive: true });
  writeFileSync(join(d, "06-implementation", "coder-report.json"), JSON.stringify({
    patches: [{ patch: "../../outside.diff" }],
  }));
  writeFileSync(join(d, "ledger", "patch-ledger.jsonl"), JSON.stringify({
    patch: "06-implementation/../../outside.diff", status: "applied", sha256: "0".repeat(64),
  }) + "\n");

  const evidence = await verifyPatchEvidence({ runDir: d, repoDir: repo });

  assert.equal(evidence.ok, false);
  assert.match(evidence.errors.join("；"), /非法路径|越界/);
});

test("P11：ledger 中当前清单之外的活动应用记录必须被拒绝", async () => {
  const repo = mkdtempSync(join(root, "repo-extra-ledger-"));
  const git = (args) => execFileSync("git", args, { cwd: repo, stdio: "pipe" });
  git(["init"]); git(["config", "user.email", "t@t"]); git(["config", "user.name", "t"]);
  git(["config", "core.autocrlf", "false"]);
  writeFileSync(join(repo, "a"), "a-old\n");
  writeFileSync(join(repo, "b"), "b-old\n");
  git(["add", "."]); git(["commit", "-m", "init"]);

  const d = mkdtempSync(join(root, "run-extra-ledger-"));
  mkdirSync(join(d, "06-implementation", "patches"), { recursive: true });
  mkdirSync(join(d, "ledger"), { recursive: true });
  writeFileSync(join(d, "06-implementation", "patches", "0001-a.diff"),
    "--- a/a\n+++ b/a\n@@ -1 +1 @@\n-a-old\n+a-new\n");
  writeFileSync(join(d, "06-implementation", "patches", "0002-b.diff"),
    "--- a/b\n+++ b/b\n@@ -1 +1 @@\n-b-old\n+b-extra\n");
  writeFileSync(join(d, "06-implementation", "coder-report.json"), JSON.stringify({
    patches: [
      { patch: "06-implementation/patches/0001-a.diff" },
      { patch: "06-implementation/patches/0002-b.diff" },
    ],
  }));
  await p7({ runDir: d, repoDir: repo, llm: null });

  // 模拟外部结果把额外文件恢复到 HEAD；最终工作区 diff 看似干净，但 ledger 仍声明它已应用。
  git(["checkout", "--", "b"]);
  writeFileSync(join(d, "06-implementation", "coder-report.json"), JSON.stringify({
    patches: [{ patch: "06-implementation/patches/0001-a.diff" }],
  }));

  const evidence = await verifyPatchEvidence({ runDir: d, repoDir: repo });

  assert.equal(evidence.ok, false);
  assert.match(evidence.errors.join("；"), /ledger|额外|清单/);
});

test("P11：P7 重跑替换 patch 后只校验最新批次，不误判历史 ledger", async () => {
  const repo = realRepo();
  const d = await patchRun(repo);
  // 本轮先应用 0001-a，再模拟 P6 重跑生成只包含 0002-b 的新 patch。
  writeFileSync(join(d, "06-implementation", "patches", "0001-a.diff"),
    "--- a/a\n+++ b/a\n@@ -1 +1 @@\n-old\n+new-a\n");
  writeFileSync(join(d, "06-implementation", "patches", "0002-b.diff"),
    "--- a/a\n+++ b/a\n@@ -1 +1 @@\n-old\n+new-b\n");
  writeFileSync(join(d, "06-implementation", "coder-report.json"), JSON.stringify({
    patches: [{ patch: "06-implementation/patches/0001-a.diff" }],
  }));
  await p7({ runDir: d, repoDir: repo, llm: null });
  writeFileSync(join(d, "06-implementation", "coder-report.json"), JSON.stringify({
    patches: [{ patch: "06-implementation/patches/0002-b.diff" }],
  }));
  await p7({ runDir: d, repoDir: repo, llm: null });

  const evidence = await verifyPatchEvidence({ runDir: d, repoDir: repo });

  assert.equal(evidence.ok, true);
});

test("P11：ledger 空行不改变旧 rollbackOf 的逻辑行号", async () => {
  const repo = realRepo();
  const d = await patchRun(repo);
  const ledgerPath = join(d, "ledger", "patch-ledger.jsonl");
  const applied = readFileSync(ledgerPath, "utf8").trim();
  execFileSync("git", ["reset", "--hard", "HEAD"], { cwd: repo, stdio: "pipe" });
  writeFileSync(ledgerPath, "\n" + applied + "\n" + JSON.stringify({
    rollbackOf: 0, status: "rolled_back",
  }) + "\n");

  const evidence = await verifyPatchEvidence({ runDir: d, repoDir: repo });

  assert.equal(evidence.ok, false);
  assert.match(evidence.errors.join("；"), /没有对应的最新 applied/);
});
