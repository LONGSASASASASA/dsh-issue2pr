import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { STAGES, MAIN_FLOW, initRun, saveRun, loadRun, isGate, advance, applyReview } from "../../lib/core/pipeline.js";
import { delegateReady } from "../../lib/core/stageConfig.js";
import p7 from "../../lib/stages/p7-patch.js";

const root = mkdtempSync(join(tmpdir(), "i2p-pipe-"));
function freshRun(reviewMode) {
  const runDir = mkdtempSync(join(root, "run-"));
  const run = initRun({ runId: "20260827-200000-x", slug: "d",
    trigger: { kind: "issue", uri: "x.md" }, reviewMode, p6Mode: "builtin" });
  saveRun(runDir, run);
  return { runDir, run };
}
const okExecutors = Object.fromEntries(MAIN_FLOW.concat(["P10"]).map((id) => [id,
  async (rcx) => { rcx.log({ span: id, ms: 1 }); return { artifact: id + ".json" }; }]));

test("STAGES 11 项，key 门恰为 P5/P6/P9/P11", () => {
  assert.equal(STAGES.length, 11);
  assert.deepEqual(STAGES.filter((s) => s.key).map((s) => s.id), ["P5", "P6", "P9", "P11"]);
  assert.deepEqual(MAIN_FLOW, ["P1","P2","P3","P4","P5","P6","P7","P8","P9","P11"]);
});

test("every 模式：逐阶段停 awaiting_review，approve 后才推进", async () => {
  const { runDir, run } = freshRun("every");
  const rcx = { runDir, run, executors: okExecutors, log() {} };
  await advance(rcx);
  assert.equal(run.stages.P1.status, "awaiting_review");
  const [ok] = await applyReview(rcx, { decision: "approve", comment: "" });
  assert.ok(ok);
  await advance(rcx);
  assert.equal(run.stages.P1.status, "approved");
  assert.equal(run.stages.P2.status, "awaiting_review");
  assert.equal(loadRun(runDir).stages.P2.status, "awaiting_review"); // 已落盘
});

test("key-only 模式：P1 直过，P5 停", async () => {
  const { runDir, run } = freshRun("key-only");
  const rcx = { runDir, run, executors: okExecutors, log() {} };
  for (let i = 0; i < 4; i++) await advance(rcx);
  assert.equal(run.stages.P1.status, "approved");
  assert.equal(run.stages.P5.status, "awaiting_review");
  assert.equal(isGate(run, "P5"), true);
  assert.equal(isGate(run, "P1"), false);
});

test("awaiting_review 时再调 advance 不重跑门阶段", async () => {
  const { runDir, run } = freshRun("every");
  let calls = 0;
  const counted = { ...okExecutors, P1: async () => { calls += 1; return { artifact: "P1.json" }; } };
  const rcx = { runDir, run, executors: counted, log() {} };
  await advance(rcx);
  assert.equal(run.stages.P1.status, "awaiting_review");
  assert.equal(calls, 1);
  await advance(rcx); // 复核前再次推进：应被防护拦下，不得重跑
  assert.equal(run.stages.P1.status, "awaiting_review");
  assert.equal(calls, 1);
  assert.equal(run.status, "awaiting_review");
});

test("auto 模式：跑完全程 completed", async () => {
  const { runDir, run } = freshRun("auto");
  const rcx = { runDir, run, executors: okExecutors, log() {} };
  for (let i = 0; i < 10; i++) await advance(rcx);
  assert.equal(run.status, "completed");
});

test("reject 必须带意见；打回后阶段回 pending 且 attempts+1，意见入 reviews/", async () => {
  const { runDir, run } = freshRun("every");
  const rcx = { runDir, run, executors: okExecutors, log() {} };
  await advance(rcx);
  assert.equal((await applyReview(rcx, { decision: "reject", comment: "" }))[0], false);
  const [ok] = await applyReview(rcx, { decision: "reject", comment: "契约缺 risk_level" });
  assert.ok(ok);
  assert.equal(run.stages.P1.status, "pending");
  assert.equal(run.stages.P1.attempts, 1);
  assert.equal(rcx.reviewComment, "契约缺 risk_level");
  const files = readdirSync(join(runDir, "reviews"));
  assert.equal(files.length, 1);
  assert.match(files[0], /-reject-P1\.json$/);
});

test("B3：复核打回达到项目上限后 Run failed，且后续 advance 不再执行阶段", async () => {
  const { runDir, run } = freshRun("every");
  const calls = [];
  const executors = {
    ...okExecutors,
    P1: async () => { calls.push("P1"); return { artifact: "P1.json" }; },
  };
  const rcx = { runDir, run, project: { maxReviewAttempts: 2 }, executors, log() {} };

  await advance(rcx);
  assert.equal(run.stages.P1.status, "awaiting_review");
  assert.equal((await applyReview(rcx, { decision: "reject", comment: "第一次意见" }))[0], true);
  await advance(rcx);
  assert.equal(run.stages.P1.status, "awaiting_review");

  const [ok, message] = await applyReview(rcx, { decision: "reject", comment: "第二次意见" });

  assert.equal(ok, false);
  assert.match(message, /P1/);
  assert.match(message, /最大复核次数/);
  assert.match(message, /2/);
  assert.equal(run.stages.P1.status, "failed");
  assert.equal(run.stages.P1.attempts, 2);
  assert.equal(run.status, "failed");
  assert.match(run.stages.P1.error, /最大复核次数/);

  await advance(rcx);
  assert.equal(calls.length, 2, "达到上限后不得继续执行 P1 或后续阶段");
  assert.equal(run.stages.P2.status, "pending");
});

test("阶段失败 → failed + error，trace 有 span", async () => {
  const { runDir, run } = freshRun("every");
  const bad = { ...okExecutors, P1: async () => { throw new Error("LLM 输出无法解析"); } };
  const rcx = { runDir, run, executors: bad, log() {} };
  await advance(rcx);
  assert.equal(run.stages.P1.status, "failed");
  assert.match(run.stages.P1.error, /无法解析/);
});
test("advance 写过程事件：阶段开始/完成落 trace/events.jsonl", async () => {
  const { runDir, run } = freshRun("every");
  const rcx = { runDir, run, executors: okExecutors, log() {} };
  await advance(rcx);
  const evs = readFileSync(join(runDir, "trace", "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.ok(evs.some((e) => e.stage === "P1" && /开始/.test(e.name)), "阶段开始事件");
  assert.ok(evs.some((e) => e.stage === "P1" && /完成/.test(e.name)), "阶段完成事件");
  assert.ok(evs.every((e) => typeof e.ok === "boolean" && e.kind === "stage"));
});

test("advance 失败路径写失败事件（ok:false + 错误详情）", async () => {
  const { runDir, run } = freshRun("every");
  const bad = { ...okExecutors, P1: async () => { throw new Error("炸了"); } };
  const rcx = { runDir, run, executors: bad, log() {} };
  await advance(rcx);
  const evs = readFileSync(join(runDir, "trace", "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.ok(evs.some((e) => e.stage === "P1" && e.ok === false && /炸了/.test(e.detail)));
});

test("P6 external（session）：事件不说\"完成\"；空 patches 拒绝 approve，产出后放行", async () => {
  const { runDir, run } = freshRun("key-only"); // P1-P4 直过，P5/P6 是门
  run.p6Mode = "session";
  const extExec = { ...okExecutors,
    P6: async () => ({ artifact: "06-implementation/session-task.md", summary: "任务包已生成，等待外部 DSH 会话执行", external: true }) };
  const rcx = { runDir, run, executors: extExec, log() {} };
  await advance(rcx); // 停 P5
  await applyReview(rcx, { decision: "approve", comment: "" });
  await advance(rcx); // 跑 P6 → external → awaiting_review
  assert.equal(run.stages.P6.status, "awaiting_review");
  assert.equal(run.stages.P6.external, true);
  assert.equal(loadRun(runDir).stages.P6.external, true); // 已落盘
  const evs = readFileSync(join(runDir, "trace", "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.ok(evs.some((e) => e.stage === "P6" && /任务包已生成 · 等待外部会话执行/.test(e.name)), "事件应写明等待外部会话执行");
  assert.ok(!evs.some((e) => e.stage === "P6" && /完成/.test(e.name)), "P6 未实施完成，事件不得出现\"完成\"");
  // 空 patches：approve 被拦（否则 P7 必然无 patch 可用而失败）
  const [ok1, msg1] = await applyReview(rcx, { decision: "approve", comment: "" });
  assert.equal(ok1, false);
  assert.match(msg1, /session 模式/);
  assert.equal(run.stages.P6.status, "awaiting_review");
  // 外部会话产出 patch → 放行
  mkdirSync(join(runDir, "06-implementation", "patches"), { recursive: true });
  writeFileSync(join(runDir, "06-implementation", "patches", "0001-T1.diff"), "--- a/x\n+++ b/x\n");
  const [ok2] = await applyReview(rcx, { decision: "approve", comment: "" });
  assert.ok(ok2);
  assert.equal(run.stages.P6.status, "approved");
});

test("A4 修复：auto 模式 + P6 session → 外部产物未就绪时挂起等待（不再直通 P7 必败）", async () => {
  const { runDir, run } = freshRun("auto");
  run.p6Mode = "session";
  const extExec = { ...okExecutors,
    P6: async () => ({ artifact: "06-implementation/session-task.md", summary: "任务包已生成", external: true }) };
  const rcx = { runDir, run, executors: extExec, log() {} };
  await advance(rcx);
  assert.equal(run.stages.P6.status, "awaiting_review", "全自动也不能空手放行委托阶段");
  assert.equal(run.status, "awaiting_review");
  // 外部产出后放行 → P7 才被执行
  mkdirSync(join(runDir, "06-implementation", "patches"), { recursive: true });
  writeFileSync(join(runDir, "06-implementation", "patches", "0001-T1.diff"), "--- a/x\n+++ b/x\n");
  assert.ok((await applyReview(rcx, { decision: "approve", comment: "" }))[0]);
  await advance(rcx);
  assert.equal(run.stages.P7.status, "approved", "产出就绪后 P7 正常推进");
});

test("A2 修复：打回委托 P6 清空旧外部产物（防 delegateReady 误判与过期 patch 复用）", async () => {
  const { runDir, run } = freshRun("key-only");
  run.p6Mode = "session";
  const extExec = { ...okExecutors,
    P6: async () => ({ artifact: "06-implementation/session-task.md", summary: "任务包", external: true }) };
  const rcx = { runDir, run, executors: extExec, log() {} };
  for (let i = 0; i < 5; i++) await advance(rcx); // P1-P4 直过，停 P5
  await applyReview(rcx, { decision: "approve", comment: "" });
  await advance(rcx); // P6 external → awaiting_review
  // 外部会话产出旧产物
  mkdirSync(join(runDir, "06-implementation", "patches"), { recursive: true });
  writeFileSync(join(runDir, "06-implementation", "patches", "0001-T1.diff"), "--- a/x\n+++ b/x\n");
  writeFileSync(join(runDir, "06-implementation", "coder-report.json"), "{\"mode\":\"session\"}");
  writeFileSync(join(runDir, "06-implementation", "session-task.md"), "任务包");
  assert.equal(delegateReady(runDir, "P6"), true);
  // 打回：旧产物必须被清场
  assert.ok((await applyReview(rcx, { decision: "reject", comment: "改动越界" }))[0]);
  assert.equal(run.stages.P6.status, "pending");
  assert.equal(existsSync(join(runDir, "06-implementation", "coder-report.json")), false, "旧 report 已清");
  assert.equal(existsSync(join(runDir, "06-implementation", "patches", "0001-T1.diff")), false, "旧 diff 已清");
  assert.equal(existsSync(join(runDir, "06-implementation", "session-task.md")), true, "任务包保留（重跑重新生成）");
  // 重跑后仍是空手 → approve 继续被拦（打回意见真正生效）
  await advance(rcx);
  assert.equal(run.stages.P6.status, "awaiting_review");
  const [ok2, msg2] = await applyReview(rcx, { decision: "approve", comment: "" });
  assert.equal(ok2, false);
  assert.match(msg2, /尚未产出/);
});

test("A4 兜底：委托 P6 产物缺失时 P7 显式失败（不空跑）", async () => {
  const { runDir, run } = freshRun("auto");
  run.p6Mode = "session";
  for (const id of ["P1", "P2", "P3", "P4", "P5", "P6"]) run.stages[id] = { status: "approved", attempts: 0 };
  run.current = "P7";
  saveRun(runDir, run);
  const rcx = { runDir, run, executors: okExecutors, log() {} };
  await advance(rcx);
  assert.equal(run.stages.P7.status, "failed");
  assert.match(run.stages.P7.error, /委托产物缺失/);
  assert.equal(run.status, "failed");
});
// —— A4 修正回归：放行前必须「拿到委外结果 + 验证 ok」，坏补丁在门上拦截 ——
// 真实 git 仓库夹具：验证应用性演练（对 HEAD 基线 git apply）真实生效
function gitInit2(dir) {
  mkdirSync(dir, { recursive: true });
  const git = (a) => execFileSync("git", a, { cwd: dir, stdio: "pipe" });
  git(["init"]); git(["config", "user.email", "t@t"]); git(["config", "user.name", "t"]);
  git(["config", "core.autocrlf", "false"]);
  return git;
}
function realPatchFixture(repoDir) {
  const git = gitInit2(repoDir);
  writeFileSync(join(repoDir, "a.txt"), "line1\n");
  git(["add", "."]); git(["commit", "-m", "init"]);
  writeFileSync(join(repoDir, "a.txt"), "line1-fixed\n");
  const diff = execFileSync("git", ["diff", "--", "a.txt"], { cwd: repoDir }).toString();
  execFileSync("git", ["checkout", "--", "a.txt"], { cwd: repoDir, stdio: "pipe" });
  return diff;
}

test("A4 修正：人工放行也过机器验证——非 diff 内容的补丁被拒（不只是文件存在性）", async () => {
  const { runDir, run } = freshRun("key-only");
  run.p6Mode = "session";
  const extExec = { ...okExecutors,
    P6: async () => ({ artifact: "06-implementation/session-task.md", summary: "任务包", external: true }) };
  const rcx = { runDir, run, executors: extExec, log() {} };
  for (let i = 0; i < 5; i++) await advance(rcx);
  await applyReview(rcx, { decision: "approve", comment: "" });
  await advance(rcx); // P6 → awaiting_review
  mkdirSync(join(runDir, "06-implementation", "patches"), { recursive: true });
  writeFileSync(join(runDir, "06-implementation", "patches", "0001.diff"), "这不是补丁，只是普通文本");
  const [ok, msg] = await applyReview(rcx, { decision: "approve", comment: "" });
  assert.equal(ok, false);
  assert.match(msg, /委外产物验证未通过/);
  assert.match(msg, /不是 unified diff/);
  assert.equal(run.stages.P6.status, "awaiting_review", "验证不过不放行");
});

test("A4 修正：对 HEAD 基线不可应用的补丁，人工放行被拒；修正后放行", async () => {
  const { runDir, run } = freshRun("key-only");
  run.p6Mode = "session";
  const repoDir = mkdtempSync(join(root, "repo-"));
  const diff = realPatchFixture(repoDir);
  const extExec = { ...okExecutors,
    P6: async () => ({ artifact: "06-implementation/session-task.md", summary: "任务包", external: true }) };
  const rcx = { runDir, run, repoDir, executors: extExec, log() {} };
  for (let i = 0; i < 5; i++) await advance(rcx);
  await applyReview(rcx, { decision: "approve", comment: "" });
  await advance(rcx); // P6 → awaiting_review
  mkdirSync(join(runDir, "06-implementation", "patches"), { recursive: true });
  writeFileSync(join(runDir, "06-implementation", "patches", "0001.diff"), diff.replace(/line1/g, "ghost-line"));
  let [ok, msg] = await applyReview(rcx, { decision: "approve", comment: "" });
  assert.equal(ok, false, "上下文不匹配的补丁不得放行");
  assert.match(msg, /无法应用到 HEAD 基线/);
  // 外部会话修正产物 → 同一验证口径下放行
  writeFileSync(join(runDir, "06-implementation", "patches", "0001.diff"), diff);
  [ok] = await applyReview(rcx, { decision: "approve", comment: "" });
  assert.ok(ok);
  assert.equal(run.stages.P6.status, "approved");
});

test("A4 修正：全自动 + 委托产物就绪但坏 → advance 显式失败（不流进 P7）", async () => {
  const { runDir, run } = freshRun("auto");
  run.p6Mode = "claude";
  const repoDir = mkdtempSync(join(root, "repo-"));
  const diff = realPatchFixture(repoDir);
  let p7Ran = 0;
  const extExec = { ...okExecutors,
    P6: async () => ({ // claude 执行完返回（非 external），产物已落盘但不可应用
      artifact: "06-implementation/",
      summary: "claude 完成（但补丁坏）",
    }),
    P7: async () => { p7Ran += 1; return { artifact: "ledger/patch-ledger.jsonl" }; } };
  const rcx = { runDir, run, repoDir, executors: extExec, log() {} };
  // 预置：P1-P5 已过，当前 P6
  for (const id of ["P1", "P2", "P3", "P4", "P5"]) run.stages[id] = { status: "approved", attempts: 0 };
  run.current = "P6"; saveRun(runDir, run);
  mkdirSync(join(runDir, "06-implementation", "patches"), { recursive: true });
  writeFileSync(join(runDir, "06-implementation", "patches", "0001.diff"), diff.replace(/line1/g, "ghost-line"));
  await advance(rcx);
  assert.equal(run.stages.P6.status, "failed", "坏补丁在 P6 显式失败");
  assert.match(run.stages.P6.error, /委外产物验证未通过/);
  assert.match(run.stages.P6.error, /无法应用到 HEAD 基线/);
  assert.equal(p7Ran, 0, "P7 不得执行（宁可显式失败，不可错跑）");
  assert.equal(run.status, "failed");
});

test("A4 修正：全自动 + 委托产物就绪且验证 ok → 自动放行，P7 正常执行", async () => {
  const { runDir, run } = freshRun("auto");
  run.p6Mode = "claude";
  const repoDir = mkdtempSync(join(root, "repo-"));
  const diff = realPatchFixture(repoDir);
  let p7Ran = 0;
  const extExec = { ...okExecutors,
    P6: async () => ({ artifact: "06-implementation/", summary: "claude 完成" }),
    P7: async () => { p7Ran += 1; return { artifact: "ledger/patch-ledger.jsonl" }; } };
  const rcx = { runDir, run, repoDir, executors: extExec, log() {} };
  for (const id of ["P1", "P2", "P3", "P4", "P5"]) run.stages[id] = { status: "approved", attempts: 0 };
  run.current = "P6"; saveRun(runDir, run);
  mkdirSync(join(runDir, "06-implementation", "patches"), { recursive: true });
  writeFileSync(join(runDir, "06-implementation", "patches", "0001.diff"), diff);
  await advance(rcx);
  assert.equal(run.stages.P6.status, "approved", "拿到结果且验证 ok → 自动放行");
  assert.equal(run.status, "completed");
  assert.ok(p7Ran >= 1, "P7 已执行");
  // 过程事件留痕：验证通过事件可追溯
  const evs = readFileSync(join(runDir, "trace", "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.ok(evs.some((e) => e.stage === "P6" && /委外产物验证通过/.test(e.name)), "验证通过事件落盘");
});

test("P11：内置人工 approve 前重新核对工作区证据", async () => {
  const repoDir = mkdtempSync(join(root, "repo-p11-"));
  const git = (args) => execFileSync("git", args, { cwd: repoDir, stdio: "pipe" });
  git(["init"]); git(["config", "user.email", "t@t"]); git(["config", "user.name", "t"]);
  git(["config", "core.autocrlf", "false"]);
  writeFileSync(join(repoDir, "a.txt"), "before\n");
  git(["add", "."]); git(["commit", "-m", "init"]);

  const runDir = mkdtempSync(join(root, "run-p11-"));
  mkdirSync(join(runDir, "06-implementation", "patches"), { recursive: true });
  writeFileSync(join(runDir, "06-implementation", "patches", "0001.diff"),
    "--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-before\n+after\n");
  writeFileSync(join(runDir, "06-implementation", "coder-report.json"), JSON.stringify({
    patches: [{ patch: "06-implementation/patches/0001.diff" }],
  }));
  await p7({ runDir, repoDir, llm: null });

  const run = initRun({ runId: "20260831-p11-approve", slug: "d",
    trigger: { kind: "issue", uri: "x.md" }, reviewMode: "every", p6Mode: "builtin" });
  for (const id of ["P1", "P2", "P3", "P4", "P5", "P6", "P7", "P8", "P9"]) {
    run.stages[id] = { status: "approved", attempts: 0 };
  }
  run.current = "P11";
  run.stages.P11 = { status: "awaiting_review", attempts: 0 };
  run.status = "awaiting_review";
  saveRun(runDir, run);
  writeFileSync(join(repoDir, "a.txt"), "unexpected\n");

  const [ok, message] = await applyReview({ runDir, run, repoDir }, {
    decision: "approve", comment: "",
  });

  assert.equal(ok, false);
  assert.match(message, /P11.*证据校验未通过/);
  assert.equal(run.stages.P11.status, "awaiting_review");
});
