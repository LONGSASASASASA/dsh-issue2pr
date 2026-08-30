// tests/stages-p9-p11.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import p9 from "../../lib/stages/p9-reviewer.js";
import p11 from "../../lib/stages/p11-pr-builder.js";

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
  const d = runDir();
  writeFileSync(join(d, "08-review-report.json"), JSON.stringify({ verdict: "pass" }));
  const r = await p11({ runDir: d, llm: passLlm, reviewComment: "" });
  assert.equal(r.artifact, "10-pr-description.md");
  assert.match(readFileSync(join(d, "10-pr-description.md"), "utf8"), /修复刷新退出/);
  const evalReport = JSON.parse(readFileSync(join(d, "11-eval-report.json"), "utf8"));
  for (const g of ["ROOT", "PATCH", "TEST", "DIFF", "DESC", "ACCEPT"]) assert.equal(evalReport[g], "pass");
});