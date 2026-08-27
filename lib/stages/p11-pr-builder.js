// lib/stages/p11-pr-builder.js — 调研 §15：PR 说明忠实反映修改 + Gate 评测
import { writeArtifact, readArtifact } from "../store.js";
import { requireArtifact } from "./helpers.js";

export default async function execute(rcx) {
  const issue = requireArtifact(rcx.runDir, "01-issue-analysis.json", readArtifact);
  const review = requireArtifact(rcx.runDir, "08-review-report.json", readArtifact);
  const tests = requireArtifact(rcx.runDir, "07-test-report.json", readArtifact);
  const md = await rcx.llm.complete({
    system: "你是 PRBuilder。生成忠实反映修改与验证过程的 PR 说明（中文 markdown）：背景/根因/修改点/验证证据/风险。禁止夸大。",
    user: `【Issue 契约】\n${issue}\n【Reviewer 结论】\n${review}\n【测试报告】\n${tests}`,
  });
  writeArtifact(rcx.runDir, "10-pr-description.md", md);
  const evalOut = await rcx.llm.completeJson({
    system: "你是 EvaluationRunner。按 Gate 六项判定：ROOT 根因有证据 / PATCH 干净应用 / TEST 无回归 / DIFF 可审查 / DESC 说明忠实 / ACCEPT 门控通过。只输出 JSON。",
    user: `【PR 说明】\n${md}\n【输出契约】{"ROOT":"pass|fail","PATCH":"pass|fail","TEST":"pass|fail","DIFF":"pass|fail","DESC":"pass|fail","ACCEPT":"pass|fail"}`,
    required: ["ROOT", "PATCH", "TEST", "DIFF", "DESC", "ACCEPT"],
  });
  writeArtifact(rcx.runDir, "11-eval-report.json", JSON.stringify(evalOut, null, 2));
  return { artifact: "10-pr-description.md", summary: "PR 说明 + Gate 评测完成" };
}