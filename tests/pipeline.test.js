import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { STAGES, MAIN_FLOW, initRun, saveRun, loadRun, isGate, advance, applyReview } from "../lib/pipeline.js";

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
  const [ok] = applyReview(rcx, { decision: "approve", comment: "" });
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
  assert.equal(applyReview(rcx, { decision: "reject", comment: "" })[0], false);
  const [ok] = applyReview(rcx, { decision: "reject", comment: "契约缺 risk_level" });
  assert.ok(ok);
  assert.equal(run.stages.P1.status, "pending");
  assert.equal(run.stages.P1.attempts, 1);
  assert.equal(rcx.reviewComment, "契约缺 risk_level");
  const files = readdirSync(join(runDir, "reviews"));
  assert.equal(files.length, 1);
  assert.match(files[0], /-reject-P1\.json$/);
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
  applyReview(rcx, { decision: "approve", comment: "" });
  await advance(rcx); // 跑 P6 → external → awaiting_review
  assert.equal(run.stages.P6.status, "awaiting_review");
  assert.equal(run.stages.P6.external, true);
  assert.equal(loadRun(runDir).stages.P6.external, true); // 已落盘
  const evs = readFileSync(join(runDir, "trace", "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.ok(evs.some((e) => e.stage === "P6" && /任务包已生成 · 等待外部会话执行/.test(e.name)), "事件应写明等待外部会话执行");
  assert.ok(!evs.some((e) => e.stage === "P6" && /完成/.test(e.name)), "P6 未实施完成，事件不得出现\"完成\"");
  // 空 patches：approve 被拦（否则 P7 必然无 patch 可用而失败）
  const [ok1, msg1] = applyReview(rcx, { decision: "approve", comment: "" });
  assert.equal(ok1, false);
  assert.match(msg1, /session 模式/);
  assert.equal(run.stages.P6.status, "awaiting_review");
  // 外部会话产出 patch → 放行
  mkdirSync(join(runDir, "06-implementation", "patches"), { recursive: true });
  writeFileSync(join(runDir, "06-implementation", "patches", "0001-T1.diff"), "--- a/x\n+++ b/x\n");
  const [ok2] = applyReview(rcx, { decision: "approve", comment: "" });
  assert.ok(ok2);
  assert.equal(run.stages.P6.status, "approved");
});
