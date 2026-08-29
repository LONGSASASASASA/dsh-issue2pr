// tests/stages-p3-p5.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import p3 from "../lib/stages/p3-code-understanding.js";
import p4 from "../lib/stages/p4-hypothesis.js";
import p5 from "../lib/stages/p5-planner.js";

const root = mkdtempSync(join(tmpdir(), "i2p-stg2-"));
const repoDir = join(root, "repo");
mkdirSync(join(repoDir, "src"), { recursive: true });
writeFileSync(join(repoDir, "src", "guard.ts"), "export function routerGuard(){ restoreSession(); }");

function fakeLlm(map) {
  return {
    complete: async ({ user }) => map.complete || "# 代码理解报告\n\n## 关键函数\nrouterGuard",
    completeJson: async ({ required }) => {
      const out = JSON.parse(map.json);
      for (const k of required) if (!(k in out)) throw new Error("缺字段 " + k);
      return out;
    },
  };
}
function prep(files) {
  const runDir = mkdtempSync(join(root, "run-"));
  for (const [rel, content] of Object.entries(files)) writeFileSync(join(runDir, rel), content);
  return runDir;
}

test("P3：读真实候选文件内容产出 md 报告", async () => {
  const runDir = prep({ "02-search-candidates.json": JSON.stringify({ candidates: [{ path: "src/guard.ts" }] }) });
  let seenUser = "";
  const llm = { complete: async ({ user }) => { seenUser = user; return "# 报告"; },
    completeJson: async () => ({}) };
  const r = await p3({ runDir, repoDir, llm, reviewComment: "" });
  assert.equal(r.artifact, "03-code-understanding.md");
  assert.match(seenUser, /restoreSession/);           // 真实文件内容进了 prompt
  assert.match(seenUser, /1\|export function routerGuard/); // 源码带真实行号前缀（供报告引用 路径:行号 锚点）
  assert.equal(readFileSync(join(runDir, r.artifact), "utf8"), "# 报告");
});

test("P4：假设带验证方法", async () => {
  const runDir = prep({ "03-code-understanding.md": "# 报告" });
  const llm = fakeLlm({ json: '{"hypotheses":[{"id":"A","title":"守卫未 await","evidence":"restoreSession 返回 Promise","verify_file":"src/guard.ts","verify_method":"检查是否 await"}]}' });
  const r = await p4({ runDir, repoDir, llm, reviewComment: "" });
  const saved = JSON.parse(readFileSync(join(runDir, r.artifact), "utf8"));
  assert.equal(saved.hypotheses[0].id, "A");
});

test("P5：TaskGraph 节点含完整字段", async () => {
  const runDir = prep({ "04-hypotheses.json": '{"hypotheses":[{"id":"A"}]}' });
  const llm = fakeLlm({ json: '{"nodes":[{"id":"T1","title":"守卫 await","input":"04-hypotheses.json","output":"patch","deps":[],"success_criteria":"测试通过","risk":"low"}],"review_gate":"T6","pr_gate":"T7"}' });
  const r = await p5({ runDir, repoDir, llm, reviewComment: "" });
  const saved = JSON.parse(readFileSync(join(runDir, r.artifact), "utf8"));
  assert.equal(saved.nodes[0].risk, "low");
});