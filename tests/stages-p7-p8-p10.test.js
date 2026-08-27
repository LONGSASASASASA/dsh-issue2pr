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

test("P8：真实执行命令，exitCode 落报告；失败抛错；完整输出落 08-test-output.txt", async () => {
  const runDir = mkdtempSync(join(root, "run-"));
  const good = await p8({ runDir, repoDir: root, project: { testCommand: "node -e \"process.stdout.write('A'.repeat(5000))\"" }, llm: null });
  const report = JSON.parse(readFileSync(join(runDir, good.artifact), "utf8"));
  assert.equal(report.passed, true);
  assert.equal(report.tail.length, 4000, "report.tail 截断为 4000 字");
  const full = readFileSync(join(runDir, "08-test-output.txt"), "utf8");
  assert.ok(full.length >= 5000, "08-test-output.txt 含完整输出（未截断）");
  assert.ok(full.startsWith("A".repeat(10)), "完整输出的开头部分也在文件中，证明未截断");
  await assert.rejects(() => p8({ runDir, repoDir: root, project: { testCommand: "node -e \"process.stdout.write('B'.repeat(200)); process.exit(1)\"" }, llm: null }), /测试失败/);
  const failOut = readFileSync(join(runDir, "08-test-output.txt"), "utf8");
  assert.ok(failOut.includes("B".repeat(200)), "失败路径完整输出同样落盘");
});

test("P10：失败六分类契约", async () => {
  const runDir = mkdtempSync(join(root, "run-"));
  const llm = { completeJson: async () => ({ category: "实现错误", detail: "diff 与意图不符", action: "rollback" }) };
  const r = await p10({ runDir, repoDir: root, llm, failure: { stage: "P6", error: "Reviewer 拒绝" }, run: { status: "failed" } });
  const saved = JSON.parse(readFileSync(join(runDir, r.artifact), "utf8"));
  assert.equal(saved.action, "rollback");
});

test("P10：run.status 非 failed 时跳过，不写产物", async () => {
  const runDir = mkdtempSync(join(root, "run-"));
  const llm = { completeJson: async () => { throw new Error("不应被调用"); } };
  const r = await p10({ runDir, repoDir: root, llm, failure: { stage: "P8", error: "测试失败" }, run: { status: "running" } });
  assert.equal(r.artifact, null);
  assert.equal(existsSync(join(runDir, "09-failure-analysis.json")), false);
});