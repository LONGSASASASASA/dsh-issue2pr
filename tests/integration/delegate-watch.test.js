// tests/delegate-watch.test.js — A4 修正回归：全自动模式委外产物就绪监听
// 语义：拿到委外结果 → 机器验证（结构 + HEAD 基线应用性演练）→ 验证 ok 自动放行；
//      连续 DELEGATE_VERIFY_MAX_FAILS 次不过 → Run 显式失败；有人工门交人工。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

import { apply, __setTestHooks, delegateWatchTick, DELEGATE_VERIFY_MAX_FAILS } from "../../index.js";
import { saveProject } from "../../lib/core/store.js";
import { initRun, saveRun, loadRun } from "../../lib/core/pipeline.js";
import p7 from "../../lib/stages/p7-patch.js";

const root = mkdtempSync(join(tmpdir(), "i2p-dwatch-"));
const SLUG = "wtest";
let seq = 0;

const p10Calls = [];
__setTestHooks({
  dataRoot: root,
  executors: { P10: async (rcx) => { p10Calls.push(rcx.failure); return {}; } },
});

function fakeCtx() {
  return {
    effect(fn) { fn(); return () => {}; },
    logger: { info() {}, warn() {} },
    webServer: { register() {} },
    getConfig() { return { dataRoot: root }; },
    llm: { async *stream() { yield { type: "text-delta", index: 0, text: "{}" }; yield { type: "finish", reason: "stop" }; } },
  };
}

function gitInit(dir) {
  mkdirSync(dir, { recursive: true });
  const git = (args) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
  git(["init"]); git(["config", "user.email", "t@t"]); git(["config", "user.name", "t"]);
  git(["config", "core.autocrlf", "false"]);
  return git;
}

// 每个 case 独立 Run（独立 runDir / repoDir），互不污染
function freshCase({ reviewMode = "auto", p6Mode = "session" } = {}) {
  seq += 1;
  const runId = "20260830-1200" + String(seq).padStart(2, "0") + "-w";
  const runDir = join(root, "projects", SLUG, "runs", runId);
  const repoDir = join(root, "projects", SLUG, "worktrees", runId);
  const run = initRun({ runId, slug: SLUG, trigger: { kind: "issue", uri: "x.md" }, reviewMode, p6Mode });
  for (const id of ["P1", "P2", "P3", "P4", "P5"]) run.stages[id] = { status: "approved", attempts: 0 };
  run.stages.P6 = { status: "awaiting_review", attempts: 0, external: true };
  run.current = "P6"; run.status = "awaiting_review";
  saveRun(runDir, run);
  writeFileSync(join(runDir, "05-task-graph.json"), JSON.stringify({ nodes: [{ id: "T1" }] }));
  return { runId, runDir, repoDir };
}

// 真实仓库（buildRcx 的 repoDir 指向 per-Run worktree 路径）+ 一份对 HEAD 可应用的真实补丁
function seedRepoWithPatch(repoDir, runDir, { bad = false } = {}) {
  const git = gitInit(repoDir);
  writeFileSync(join(repoDir, "a.txt"), "line1\n");
  git(["add", "."]); git(["commit", "-m", "init"]);
  writeFileSync(join(repoDir, "a.txt"), "line1-fixed\n");
  const diff = execFileSync("git", ["diff", "--", "a.txt"], { cwd: repoDir }).toString();
  execFileSync("git", ["checkout", "--", "a.txt"], { cwd: repoDir, stdio: "pipe" });
  mkdirSync(join(runDir, "06-implementation", "patches"), { recursive: true });
  writeFileSync(join(runDir, "06-implementation", "patches", "0001-T1.diff"),
    bad ? diff.replace(/line1/g, "no-such-line") : diff);
  writeFileSync(join(runDir, "06-implementation", "coder-report.json"),
    JSON.stringify({ mode: "session", patches: [{ node: "T1", patch: "06-implementation/patches/0001-T1.diff" }], summary: "外部会话完成" }));
}

function freshP11Case() {
  seq += 1;
  const slug = "wtest-p11";
  const runId = "20260830-1300" + String(seq).padStart(2, "0") + "-w";
  const runDir = join(root, "projects", slug, "runs", runId);
  const repoDir = join(root, "projects", slug, "worktrees", runId);
  const run = initRun({ runId, slug, trigger: { kind: "issue", uri: "x.md" }, reviewMode: "auto", p6Mode: "builtin" });
  for (const id of ["P1", "P2", "P3", "P4", "P5", "P6", "P7", "P8", "P9"]) {
    run.stages[id] = { status: "approved", attempts: 0 };
  }
  run.stages.P11 = { status: "awaiting_review", attempts: 0, external: true };
  run.current = "P11";
  run.status = "awaiting_review";
  saveRun(runDir, run);
  saveProject(root, {
    name: "P11 监听", slug, repos: ["r1"], triggers: [], reviewMode: "auto", p6Mode: "builtin",
    stageConfig: { P11: { delegate: { mode: "session" } } },
  });
  return { runDir, repoDir };
}

async function seedP11Evidence(repoDir, runDir) {
  const git = gitInit(repoDir);
  writeFileSync(join(repoDir, "a.txt"), "line1\n");
  git(["add", "."]); git(["commit", "-m", "init"]);
  writeFileSync(join(repoDir, "a.txt"), "line1-fixed\n");
  const diff = execFileSync("git", ["diff", "--", "a.txt"], { cwd: repoDir }).toString();
  execFileSync("git", ["checkout", "--", "a.txt"], { cwd: repoDir, stdio: "pipe" });
  mkdirSync(join(runDir, "06-implementation", "patches"), { recursive: true });
  writeFileSync(join(runDir, "06-implementation", "patches", "0001-T1.diff"), diff);
  writeFileSync(join(runDir, "06-implementation", "coder-report.json"), JSON.stringify({
    mode: "builtin", patches: [{ node: "T1", patch: "06-implementation/patches/0001-T1.diff" }],
  }));
  await p7({ runDir, repoDir, llm: null });
}

saveProject(root, { name: "监听", slug: SLUG, repos: ["r1"], triggers: [], reviewMode: "auto", p6Mode: "session" });
apply(fakeCtx()); // 注册即初始化（无副作用）

test("监听 tick：未拿到委外结果 → waiting，不动状态", async () => {
  const { runDir } = freshCase();
  assert.equal(await delegateWatchTick(fakeCtx(), root, runDir), "waiting");
  assert.equal(loadRun(runDir).status, "awaiting_review");
});

test("监听 tick：人工门（key-only 的 P6）→ gate，不自动放行", async () => {
  const { runDir, repoDir } = freshCase({ reviewMode: "key-only" });
  seedRepoWithPatch(repoDir, runDir);
  assert.equal(await delegateWatchTick(fakeCtx(), root, runDir), "gate");
  assert.equal(loadRun(runDir).status, "awaiting_review", "人工门必须等人，机器不得代批");
});

test("监听 tick：非委托等待 → idle", async () => {
  const { runDir } = freshCase({ p6Mode: "builtin" });
  assert.equal(await delegateWatchTick(fakeCtx(), root, runDir), "idle");
});

test("监听 tick：只有部分补丁、报告未生成时持续等待，不自动放行或清理补丁", async () => {
  const { runDir, repoDir } = freshCase();
  seedRepoWithPatch(repoDir, runDir);
  unlinkSync(join(runDir, "06-implementation", "coder-report.json"));
  const patchPath = join(runDir, "06-implementation", "patches", "0001-T1.diff");
  const before = readFileSync(patchPath, "utf8");
  for (let i = 0; i <= DELEGATE_VERIFY_MAX_FAILS; i++) {
    assert.equal(await delegateWatchTick(fakeCtx(), root, runDir), "waiting");
  }
  const run = loadRun(runDir);
  assert.equal(run.status, "awaiting_review");
  assert.equal(run.stages.P6.status, "awaiting_review");
  assert.equal(run.stages.P7.status, "pending");
  assert.equal(run.delegateVerifyFails, undefined);
  assert.equal(readFileSync(patchPath, "utf8"), before);
});

test("A4 修正主链路：拿到委外结果 + 验证 ok → 自动放行流转（auto-approve 记录可审计）", async () => {
  const { runDir, repoDir } = freshCase();
  seedRepoWithPatch(repoDir, runDir);
  assert.equal(await delegateWatchTick(fakeCtx(), root, runDir), "advanced");
  const run = loadRun(runDir);
  assert.equal(run.status, "running", "验证通过后恢复推进");
  assert.equal(run.stages.P6.status, "approved");
  assert.equal(run.delegateVerifyFails, undefined, "成功即清容错计数");
  const reviews = readdirSync(join(runDir, "reviews"));
  const recFile = reviews.find((f) => /auto-approve-P6\.json$/.test(f));
  assert.ok(recFile, "机器放行留审计记录: " + reviews.join(","));
  const rec = JSON.parse(readFileSync(join(runDir, "reviews", recFile), "utf8"));
  assert.equal(rec.auto, true);
  assert.equal(rec.verification.ok, true);
  assert.equal(rec.verification.rehearsal, true, "真实仓库下走应用性演练");
});

test("A4 修正主链路：产物存在但不可应用 → 容错窗口内等待，连续不过 → Run 显式失败 + P10 归因", async () => {
  const { runDir, repoDir } = freshCase();
  seedRepoWithPatch(repoDir, runDir, { bad: true });
  const before = p10Calls.length;
  for (let i = 1; i < DELEGATE_VERIFY_MAX_FAILS; i++) {
    assert.equal(await delegateWatchTick(fakeCtx(), root, runDir), "verify-fail", "第 " + i + " 次仍在容错窗口");
    assert.equal(loadRun(runDir).delegateVerifyFails, i, "计数落盘");
    assert.equal(loadRun(runDir).status, "awaiting_review", "窗口内不失败也不放行");
  }
  assert.equal(await delegateWatchTick(fakeCtx(), root, runDir), "failed");
  const run = loadRun(runDir);
  assert.equal(run.status, "failed", "稳定不可用 → 显式失败");
  assert.equal(run.stages.P6.status, "failed");
  assert.match(run.stages.P6.error, /委外产物验证连续/);
  assert.match(run.stages.P6.error, /无法应用到 HEAD 基线/);
  assert.equal(p10Calls.length, before + 1, "失败走 P10 归因");
  assert.equal(p10Calls[p10Calls.length - 1].stage, "P6");
});

test("容错窗口语义：验证失败后产物被修正 → 下一次 tick 直接放行（计数清零）", async () => {
  const { runDir, repoDir } = freshCase();
  seedRepoWithPatch(repoDir, runDir, { bad: true });
  await delegateWatchTick(fakeCtx(), root, runDir); // verify-fail ×1
  assert.equal(loadRun(runDir).delegateVerifyFails, 1);
  // 外部会话修正产物（重写为对 HEAD 可应用的真实补丁）
  writeFileSync(join(repoDir, "a.txt"), "line1-fixed\n");
  const diff = execFileSync("git", ["diff", "--", "a.txt"], { cwd: repoDir }).toString();
  execFileSync("git", ["checkout", "--", "a.txt"], { cwd: repoDir, stdio: "pipe" });
  writeFileSync(join(runDir, "06-implementation", "patches", "0001-T1.diff"), diff);
  assert.equal(await delegateWatchTick(fakeCtx(), root, runDir), "advanced");
  const run = loadRun(runDir);
  assert.equal(run.stages.P6.status, "approved");
  assert.equal(run.delegateVerifyFails, undefined, "成功即清容错计数");
});

test("委外 P11：合法自报 eval 但仓库有额外改动时不得自动放行", async () => {
  const { runDir, repoDir } = freshP11Case();
  await seedP11Evidence(repoDir, runDir);
  writeFileSync(join(repoDir, "a.txt"), "unexpected\n");
  writeFileSync(join(runDir, "10-pr-description.md"), "# PR\n说明");
  writeFileSync(join(runDir, "11-eval-report.json"), JSON.stringify({
    ROOT: "pass", PATCH: "pass", TEST: "pass", DIFF: "pass", DESC: "pass", ACCEPT: "pass",
  }));

  const result = await delegateWatchTick(fakeCtx(), root, runDir);

  assert.equal(result, "verify-fail");
  assert.equal(loadRun(runDir).status, "awaiting_review");
});

test("委外 P11：patch 证据与六项 eval 全通过时自动放行", async () => {
  const { runDir, repoDir } = freshP11Case();
  await seedP11Evidence(repoDir, runDir);
  writeFileSync(join(runDir, "10-pr-description.md"), "# PR\n说明");
  writeFileSync(join(runDir, "11-eval-report.json"), JSON.stringify({
    ROOT: "pass", PATCH: "pass", TEST: "pass", DIFF: "pass", DESC: "pass", ACCEPT: "pass",
  }));

  const result = await delegateWatchTick(fakeCtx(), root, runDir);

  assert.equal(result, "advanced");
  assert.equal(loadRun(runDir).stages.P11.status, "approved");
});

test("委外 P11：eval 任一门控为 fail 时不得自动放行", async () => {
  const { runDir, repoDir } = freshP11Case();
  await seedP11Evidence(repoDir, runDir);
  writeFileSync(join(runDir, "10-pr-description.md"), "# PR\n说明");
  writeFileSync(join(runDir, "11-eval-report.json"), JSON.stringify({
    ROOT: "pass", PATCH: "pass", TEST: "fail", DIFF: "pass", DESC: "pass", ACCEPT: "pass",
  }));

  const result = await delegateWatchTick(fakeCtx(), root, runDir);

  assert.equal(result, "verify-fail");
  assert.equal(loadRun(runDir).status, "awaiting_review");
});

test("委外 P11：eval 顶层为 null 时不得当作有效报告自动放行", async () => {
  const { runDir, repoDir } = freshP11Case();
  await seedP11Evidence(repoDir, runDir);
  writeFileSync(join(runDir, "10-pr-description.md"), "# PR\n说明");
  writeFileSync(join(runDir, "11-eval-report.json"), "null");

  const result = await delegateWatchTick(fakeCtx(), root, runDir);
  const run = loadRun(runDir);

  assert.equal(result, "verify-fail");
  assert.equal(run.status, "awaiting_review");
  assert.equal(run.stages.P11.status, "awaiting_review");
  assert.equal(run.delegateVerifyFails, 1);
  assert.equal(existsSync(join(runDir, "reviews")), false, "无有效验收对象不得生成通过记录");
  const events = readFileSync(join(runDir, "trace", "events.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
  assert.ok(events.some((event) => event.stage === "P11" && /验收对象/.test(event.detail)));
});
