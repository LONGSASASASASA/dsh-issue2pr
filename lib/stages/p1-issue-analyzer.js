// lib/stages/p1-issue-analyzer.js — 调研 §3：自然语言 → 结构化契约
import { writeArtifact } from "../core/store.js";
import { readTriggerText, maybeDelegate } from "./helpers.js";
import { sysOf } from "../core/stageConfig.js";

// TASK-05：输出契约 schema（与 prompt 契约一一对应，不新增推导要求）
// goal（20260917-001）：一句话北极星目标，P2 起各阶段经 goalBriefOf 只读注入，
// 是全流水线目标的唯一权威载体；non_goals 圈定不做的范围（防扩权，可缺省）
const SCHEMA = {
  type: "object",
  required: ["goal", "phenomenon", "trigger", "scope", "success_criteria", "constraints", "risk_level"],
  properties: {
    goal: { type: "string" },
    non_goals: { type: "array", items: { type: "string" } },
    phenomenon: { type: "string" },
    trigger: { type: "string" },
    scope: { type: "array", items: { type: "string" } },
    success_criteria: { type: "array", items: { type: "string" } },
    constraints: { type: "array", items: { type: "string" } },
    risk_level: { type: "string", enum: ["low", "medium", "high"] },
  },
};

export default async function execute(rcx) {
  const delegated = await maybeDelegate(rcx, "P1");
  if (delegated) return delegated;
  const issue = await readTriggerText(rcx);
  const rejected = rcx.reviewComment ? `\n\n【人工复核打回意见，必须修正】${rcx.reviewComment}` : "";
  const out = await rcx.llm.completeJson({
    system: sysOf(rcx, "P1"),
    user: `【Issue 全文】\n${issue}\n\n【输出契约】{"goal":"一句话目标","phenomenon":"现象","trigger":"触发条件","scope":["影响模块"],"success_criteria":["可验证成功标准"],"constraints":["约束"],"non_goals":["明确不做什么"],"risk_level":"low|medium|high"}${rejected}`,
    required: ["goal", "phenomenon", "trigger", "scope", "success_criteria", "constraints", "risk_level"],
    schema: SCHEMA,
  });
  writeArtifact(rcx.runDir, "01-issue-analysis.json", JSON.stringify(out, null, 2));
  return { artifact: "01-issue-analysis.json", summary: `scope=${(out.scope || []).join(",")}` };
}
