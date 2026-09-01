// lib/stages/p11-pr-builder.js — 调研 §15：PR 说明忠实反映修改 + Gate 评测
import { writeArtifact, readArtifact } from "../core/store.js";
import { requireArtifact, maybeDelegate } from "./helpers.js";
import { sysOf } from "../core/stageConfig.js";
import { verifyPatchEvidence } from "../infra/patchEvidence.js";

export { verifyPatchEvidence } from "../infra/patchEvidence.js";

function evidenceFailureReport(evidence) {
  return {
    ROOT: "fail", PATCH: "fail", TEST: "fail", DIFF: "fail", DESC: "fail", ACCEPT: "fail",
    patchEvidence: evidence,
  };
}

export default async function execute(rcx) {
  const delegated = await maybeDelegate(rcx, "P11");
  if (delegated) return delegated;
  const patchEvidence = await verifyPatchEvidence(rcx);
  if (!patchEvidence.ok) {
    writeArtifact(rcx.runDir, "11-eval-report.json", JSON.stringify(evidenceFailureReport(patchEvidence), null, 2));
    throw new Error("P11 证据校验未通过: " + patchEvidence.errors.join("；"));
  }
  const issue = requireArtifact(rcx.runDir, "01-issue-analysis.json", readArtifact);
  const review = requireArtifact(rcx.runDir, "08-review-report.json", readArtifact);
  const tests = requireArtifact(rcx.runDir, "07-test-report.json", readArtifact);
  const md = await rcx.llm.complete({
    system: sysOf(rcx, "P11", "desc"),
    user: `【Issue 契约】\n${issue}\n【Reviewer 结论】\n${review}\n【测试报告】\n${tests}`,
  });
  writeArtifact(rcx.runDir, "10-pr-description.md", md);
  const evalOut = await rcx.llm.completeJson({
    system: sysOf(rcx, "P11", "gate"),
    user: `【PR 说明】\n${md}\n【输出契约】{"ROOT":"pass|fail","PATCH":"pass|fail","TEST":"pass|fail","DIFF":"pass|fail","DESC":"pass|fail","ACCEPT":"pass|fail"}`,
    required: ["ROOT", "PATCH", "TEST", "DIFF", "DESC", "ACCEPT"],
  });
  writeArtifact(rcx.runDir, "11-eval-report.json", JSON.stringify({ ...evalOut, patchEvidence }, null, 2));
  return { artifact: "10-pr-description.md", summary: "PR 说明 + Gate 评测完成" };
}
