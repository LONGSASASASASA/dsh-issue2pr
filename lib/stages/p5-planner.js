// lib/stages/p5-planner.js — 调研 §6：TaskGraph，每节点有契约
import { writeArtifact, readArtifact } from "../core/store.js";
import { requireArtifact, maybeDelegate } from "./helpers.js";
import { sysOf } from "../core/stageConfig.js";

// TASK-05：TaskGraph 输出契约 schema（节点七字段齐全，deps 为字符串数组，
// risk 限枚举；review_gate / pr_gate 契约中为可选引用）
const SCHEMA = {
  type: "object",
  required: ["nodes"],
  properties: {
    nodes: {
      type: "array",
      items: {
        type: "object",
        required: ["id", "title", "input", "output", "deps", "success_criteria", "risk"],
        properties: {
          id: { type: "string" },
          title: { type: "string" },
          input: { type: "string" },
          output: { type: "string" },
          deps: { type: "array", items: { type: "string" } },
          success_criteria: { type: "string" },
          risk: { type: "string", enum: ["low", "medium", "high"] },
        },
      },
    },
    review_gate: { type: "string" },
    pr_gate: { type: "string" },
  },
};

export default async function execute(rcx) {
  const delegated = await maybeDelegate(rcx, "P5");
  if (delegated) return delegated;
  const hypotheses = requireArtifact(rcx.runDir, "04-hypotheses.json", readArtifact);
  const out = await rcx.llm.completeJson({
    system: sysOf(rcx, "P5"),
    user: `【根因假设】\n${hypotheses}\n\n【输出契约】{"nodes":[{"id":"T1","title":"任务","input":"前置 artifact","output":"本任务 artifact","deps":["T0"],"success_criteria":"可验证通过条件","risk":"low|medium|high"}],"review_gate":"节点id","pr_gate":"节点id"}\n【打回意见】${rcx.reviewComment || "无"}`,
    required: ["nodes"],
    schema: SCHEMA,
  });
  writeArtifact(rcx.runDir, "05-task-graph.json", JSON.stringify(out, null, 2));
  return { artifact: "05-task-graph.json", summary: `${out.nodes.length} 节点` };
}
