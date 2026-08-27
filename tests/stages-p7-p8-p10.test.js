// tests/stages-p7-p8-p10.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import p7, { rollbackLedger } from "../lib/stages/p7-patch.js";
import p8 from "../lib/stages/p8-test-runner.js";
import p10 from "../lib/stages/p10-failure.js";

const root = mkdtempSync(join(tmpdir(), "i2p-p78-"));
function gitRepo() {
  const dir = mkdtempSync(join(root, "repo-"));
  const git = (args) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
  git(["init"]); git(["config", "user.email", "t@t"]); git(["config", "user.name", "t"]);
  // Windows 系统级 core.autocrlf=true 会让 git apply 落盘时把 LF 转 CRLF，掩盖回滚恢复语义；测试仓库内归一化为 false
  git(["config", "core.autocrlf", "false"]);
  writeFileSync(join(dir, "a.txt"), "line1\n");
  git(["add", "."]); git(["commit", "-m", "init"]);
  return dir;
}

test("P7：应用 diff 并写 ledger；rollback 只反应用该 patch", async () => {
  const repoDir = gitRepo();
  const runDir = mkdtempSync(join(root, "run-"));
  mkdirSync(join(runDir, "06-implementation", "patches"), { recursive: true });
  mkdirSync(join(runDir, "ledger"), { recursive: true });
  writeFileSync(join(runDir, "06-implementation", "coder-report.json"),
    JSON.stringify({ patches: [{ patch: "06-implementation/patches/0001-a.diff" }] }));
  writeFileSync(join(runDir, "06-implementation", "patches", "0001-a.diff"),
    "--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-line1\n+line1-patched\n");
  const r = await p7({ runDir, repoDir, llm: null, reviewComment: "" });
  assert.match(readFileSync(join(repoDir, "a.txt"), "utf8"), /patched/);
  assert.ok(existsSync(join(runDir, "ledger", "patch-ledger.jsonl")));
  rollbackLedger(runDir, repoDir, 0);
  assert.equal(readFileSync(join(repoDir, "a.txt"), "utf8"), "line1\n");
});

test("P8：真实执行命令，exitCode 落报告；失败抛错", async () => {
  const runDir = mkdtempSync(join(root, "run-"));
  const good = await p8({ runDir, repoDir: root, project: { testCommand: "node -e \"process.exit(0)\"" }, llm: null });
  const report = JSON.parse(readFileSync(join(runDir, good.artifact), "utf8"));
  assert.equal(report.passed, true);
  await assert.rejects(() => p8({ runDir, repoDir: root, project: { testCommand: "node -e \"process.exit(1)\"" }, llm: null }), /测试失败/);
});

test("P10：失败六分类契约", async () => {
  const runDir = mkdtempSync(join(root, "run-"));
  const llm = { completeJson: async () => ({ category: "实现错误", detail: "diff 与意图不符", action: "rollback" }) };
  const r = await p10({ runDir, repoDir: root, llm, failure: { stage: "P6", error: "Reviewer 拒绝" } });
  const saved = JSON.parse(readFileSync(join(runDir, r.artifact), "utf8"));
  assert.equal(saved.action, "rollback");
});