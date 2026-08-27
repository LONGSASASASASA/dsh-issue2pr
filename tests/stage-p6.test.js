// tests/stage-p6.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import p6 from "../lib/stages/p6-coder.js";

const root = mkdtempSync(join(tmpdir(), "i2p-p6-"));
const repoDir = join(root, "repo");
mkdirSync(join(repoDir, "src"), { recursive: true });
writeFileSync(join(repoDir, "src", "guard.ts"), "restoreSession();");

const TASK_GRAPH = JSON.stringify({ nodes: [
  { id: "T1", title: "守卫加 await", output: "patch", deps: [] },
  { id: "T2", title: "补回归测试", output: "patch", deps: ["T1"] },
]});

function llmSequence(seq) {
  let i = 0;
  return {
    completeJson: async () => JSON.parse(seq[Math.min(i++, seq.length - 1)]),
    complete: async () => "--- a/src/guard.ts\n+++ b/src/guard.ts\n@@ -1 +1 @@\n-restoreSession();\n+await restoreSession();",
  };
}

test("builtin：每节点一份 diff + coder-report，planner/coder/reviewer 都发生", async () => {
  const runDir = mkdtempSync(join(root, "run-"));
  writeFileSync(join(runDir, "05-task-graph.json"), TASK_GRAPH);
  const llm = llmSequence([
    '{"assignments":[{"node":"T1","file":"src/guard.ts"},{"node":"T2","file":"tests/x.test.ts"}]}', // planner
    '{"verdict":"pass","notes":"最小 diff"}',                                                          // reviewer
  ]);
  const r = await p6({ runDir, repoDir, llm, reviewComment: "", p6Mode: "builtin" });
  assert.equal(r.artifact, "06-implementation/");
  const patches = readdirSync(join(runDir, "06-implementation", "patches"));
  assert.equal(patches.length, 2);
  assert.match(patches[0], /^0001-.*\.diff$/);
  const report = JSON.parse(readFileSync(join(runDir, "06-implementation", "coder-report.json"), "utf8"));
  assert.equal(report.mode, "builtin");
  assert.equal(report.reviewer.verdict, "pass");
});

test("builtin：reviewer fail → 抛错（交给 P10）", async () => {
  const runDir = mkdtempSync(join(root, "run-"));
  writeFileSync(join(runDir, "05-task-graph.json"), TASK_GRAPH);
  const llm = llmSequence(['{"assignments":[{"node":"T1","file":"src/guard.ts"}]}', '{"verdict":"fail","notes":"越权修改"}']);
  await assert.rejects(() => p6({ runDir, repoDir, llm, reviewComment: "", p6Mode: "builtin" }), /越权修改/);
});

test("session：写 session-task.md，不调 LLM", async () => {
  const runDir = mkdtempSync(join(root, "run-"));
  writeFileSync(join(runDir, "05-task-graph.json"), TASK_GRAPH);
  const llm = { completeJson: async () => { throw new Error("不应被调用"); }, complete: async () => { throw new Error("不应被调用"); } };
  const r = await p6({ runDir, repoDir, llm, reviewComment: "", p6Mode: "session" });
  assert.equal(r.artifact, "06-implementation/session-task.md");
  assert.ok(existsSync(join(runDir, "06-implementation", "session-task.md")));
});