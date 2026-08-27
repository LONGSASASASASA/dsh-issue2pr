// lib/stages/p5-planner.js — 调研 §6：TaskGraph，每节点有契约
import { writeArtifact, readArtifact } from "../store.js";
import { requireArtifact } from "./helpers.js";

export default async function execute(rcx) {
  const hypotheses = requireArtifact(rcx.runDir, "04-hypotheses.json", readArtifact);
  const out = await rcx.llm.completeJson({
    system: "你是 Planner。把修复任务拆成有依赖关系的 TaskGraph，每节点可独立验证。只输出 JSON。",
    user: `【根因假设】\n${hypotheses}\n\n【输出契约】{"nodes":[{"id":"T1","title":"任务","input":"前置 artifact","output":"本任务 artifact","deps":["T0"],"success_criteria":"可验证通过条件","risk":"low|medium|high"}],"review_gate":"节点id","pr_gate":"节点id"}\n【打回意见】${rcx.reviewComment || "无"}`,
    required: ["nodes"],
  });
  writeArtifact(rcx.runDir, "05-task-graph.json", JSON.stringify(out, null, 2));
  return { artifact: "05-task-graph.json", summary: `${out.nodes.length} 节点` };
}