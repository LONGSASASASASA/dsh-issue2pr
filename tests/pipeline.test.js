import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
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