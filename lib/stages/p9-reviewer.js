// lib/stages/p9-reviewer.js — 调研 §9：Review 是 PRBuilder 的前置门控
import { writeArtifact, readArtifact } from "../store.js";
import { requireArtifact } from "./helpers.js";

export default async function execute(rcx) {
  const patches = readArtifact(rcx.runDir, "06-implementation/coder-report.json") || "{}";
  const tests = requireArtifact(rcx.runDir, "07-test-report.json", readArtifact);
  const out = await rcx.llm.completeJson({
    system: "你是 Reviewer Agent。三维门控：①Diff 范围（过大/越权/遗漏调用方）②API 与安全 ③测试补强与说明忠实。测试通过 ≠ 可合并。只输出 JSON。",
    user: `【coder-report】\n${patches}\n【test-report】\n${tests}\n【输出契约】{"diff_scope":"结论","api_security":"结论","tests":"结论","verdict":"pass|fail"}\n【打回意见】${rcx.reviewComment || "无"}`,
    required: ["diff_scope", "api_security", "tests", "verdict"],
  });
  writeArtifact(rcx.runDir, "08-review-report.json", JSON.stringify(out, null, 2));
  if (out.verdict !== "pass") throw new Error("Reviewer 门控未过: " + (out.diff_scope || ""));
  return { artifact: "08-review-report.json", summary: "三维门控 pass" };
}