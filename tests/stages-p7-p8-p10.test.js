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
  await rollbackLedger(runDir, repoDir, 0);
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
test("P7：session 模式回退——无 coder-report.json 时扫 patches/ 目录按序应用", async () => {
  const repoDir = gitRepo();
  const runDir = mkdtempSync(join(root, "run-"));
  mkdirSync(join(runDir, "06-implementation", "patches"), { recursive: true });
  mkdirSync(join(runDir, "ledger"), { recursive: true });
  writeFileSync(join(runDir, "06-implementation", "patches", "0001-a.diff"),
    "--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-line1\n+line1-session\n");
  const r = await p7({ runDir, repoDir, llm: null, reviewComment: "" });
  assert.match(r.summary, /1 份 patch/);
  assert.match(readFileSync(join(repoDir, "a.txt"), "utf8"), /session/);
  const ledger = readFileSync(join(runDir, "ledger", "patch-ledger.jsonl"), "utf8").trim().split("\n");
  assert.equal(JSON.parse(ledger[0]).patch, "06-implementation/patches/0001-a.diff");
});

test("P7：无任何 patch 时明确报错", async () => {
  const runDir = mkdtempSync(join(root, "run-"));
  await assert.rejects(() => p7({ runDir, repoDir: root, llm: null }), /无 patch 可应用/);
});

// claude 委托产出的 report：tasks 字段 + patch 路径相对 06-implementation/（P7 需归一化后按序应用）
test("P7：claude 委托 report（tasks 格式 · 短路径）→ 归一化按序应用", async () => {
  const repoDir = gitRepo();
  const runDir = mkdtempSync(join(root, "run-"));
  mkdirSync(join(runDir, "06-implementation", "patches"), { recursive: true });
  mkdirSync(join(runDir, "ledger"), { recursive: true });
  writeFileSync(join(runDir, "06-implementation", "patches", "0001-a.diff"),
    "--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-line1\n+line1-step1\n");
  writeFileSync(join(runDir, "06-implementation", "patches", "0002-a.diff"),
    "--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-line1-step1\n+line1-step2\n"); // 叠加式：基于 0001 已应用状态
  writeFileSync(join(runDir, "06-implementation", "coder-report.json"),
    JSON.stringify({ mode: "claude-code", tasks: [
      { node: "T1", patch: "patches/0001-a.diff" },
      { node: "T2", patch: "patches/0002-a.diff" },
    ], summary: "叠加式两步" }));
  const r = await p7({ runDir, repoDir, llm: null, reviewComment: "" });
  assert.match(r.summary, /2 份 patch/);
  assert.match(readFileSync(join(repoDir, "a.txt"), "utf8"), /line1-step2/);
  const ledger = readFileSync(join(runDir, "ledger", "patch-ledger.jsonl"), "utf8").trim().split("\n");
  assert.equal(JSON.parse(ledger[0]).patch, "06-implementation/patches/0001-a.diff");
  assert.equal(JSON.parse(ledger[1]).patch, "06-implementation/patches/0002-a.diff");
});

test("P8：过程事件落 trace/events.jsonl（开始 + 结束，含耗时与 ok）", async () => {
  const runDir = mkdtempSync(join(root, "run-"));
  await p8({ runDir, repoDir: root, project: { testCommand: "node -e \"\"" }, llm: null });
  const lines = readFileSync(join(runDir, "trace", "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(lines[0].kind, "test");
  assert.match(lines[0].name, /node -e/);
  assert.equal(lines.at(-1).ok, true);
  assert.ok(typeof lines.at(-1).ms === "number");
});

test("P7：git apply 成功/失败都记过程事件", async () => {
  const repoDir = gitRepo();
  const runDir = mkdtempSync(join(root, "run-"));
  mkdirSync(join(runDir, "06-implementation", "patches"), { recursive: true });
  writeFileSync(join(runDir, "06-implementation", "patches", "0001-ok.diff"),
    "--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-line1\n+line1-ok\n");
  const rcx = { runDir, repoDir, llm: null, run: { current: "P7" } };
  await p7(rcx);
  writeFileSync(join(runDir, "06-implementation", "patches", "0002-bad.diff"),
    "--- a/nope.txt\n+++ b/nope.txt\n@@ -1 +1 @@\n-x\n+y\n");
  writeFileSync(join(runDir, "06-implementation", "coder-report.json"),
    JSON.stringify({ patches: [{ patch: "06-implementation/patches/0002-bad.diff" }] }));
  await assert.rejects(() => p7(rcx), /Patch 应用失败/);
  const evs = readFileSync(join(runDir, "trace", "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.ok(evs.some((e) => e.kind === "git" && e.ok === true), "成功 apply 记事件");
  assert.ok(evs.some((e) => e.kind === "git" && e.ok === false), "失败 apply 记事件");
  assert.ok(evs.every((e) => e.stage === "P7"), "事件携带阶段号");
});

test("A1/A2 修复：P7 重跑前自动重置工作区（打回/回退后 re-apply 不再必败）", async () => {
  const repoDir = gitRepo();
  const runDir = mkdtempSync(join(root, "run-"));
  mkdirSync(join(runDir, "06-implementation", "patches"), { recursive: true });
  mkdirSync(join(runDir, "ledger"), { recursive: true });
  writeFileSync(join(runDir, "06-implementation", "coder-report.json"),
    JSON.stringify({ patches: [{ patch: "06-implementation/patches/0001-a.diff" }] }));
  writeFileSync(join(runDir, "06-implementation", "patches", "0001-a.diff"),
    "--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-line1\n+line1-patched\n");
  await p7({ runDir, repoDir, llm: null, reviewComment: "" });
  assert.match(readFileSync(join(repoDir, "a.txt"), "utf8"), /patched/);
  // 旧实现：工作区仍是 patched 状态，直接 re-apply 必失败（git apply --check 报 already exists）
  await p7({ runDir, repoDir, llm: null, reviewComment: "" });
  assert.match(readFileSync(join(repoDir, "a.txt"), "utf8"), /patched/, "基线重置后重新应用一次");
  const ledger = readFileSync(join(runDir, "ledger", "patch-ledger.jsonl"), "utf8").trim().split("\n");
  assert.equal(ledger.length, 2, "两次应用各记一行 ledger");
});
