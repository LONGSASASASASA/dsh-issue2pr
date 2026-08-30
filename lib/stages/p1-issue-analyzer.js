// lib/stages/p1-issue-analyzer.js — 调研 §3：自然语言 → 结构化契约
import { writeArtifact } from "../core/store.js";
import { readTriggerText, maybeDelegate } from "./helpers.js";
import { sysOf } from "../core/stageConfig.js";

export default async function execute(rcx) {
  const delegated = await maybeDelegate(rcx, "P1");
  if (delegated) return delegated;
  const issue = await readTriggerText(rcx);
  const rejected = rcx.reviewComment ? `\n\n【人工复核打回意见，必须修正】${rcx.reviewComment}` : "";
  const out = await rcx.llm.completeJson({
    system: sysOf(rcx, "P1"),
    user: `【Issue 全文】\n${issue}\n\n【输出契约】{"phenomenon":"现象","trigger":"触发条件","scope":["影响模块"],"success_criteria":["可验证成功标准"],"constraints":["约束"],"risk_level":"low|medium|high"}${rejected}`,
    required: ["phenomenon", "trigger", "scope", "success_criteria", "constraints", "risk_level"],
  });
  writeArtifact(rcx.runDir, "01-issue-analysis.json", JSON.stringify(out, null, 2));
  return { artifact: "01-issue-analysis.json", summary: `scope=${(out.scope || []).join(",")}` };
}
