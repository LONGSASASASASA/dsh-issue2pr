// lib/stages/p4-hypothesis.js — 调研 §5：每个假设必须可验证
import { writeArtifact, readArtifact } from "../core/store.js";
import { requireArtifact, maybeDelegate } from "./helpers.js";
import { sysOf } from "../core/stageConfig.js";

export default async function execute(rcx) {
  const delegated = await maybeDelegate(rcx, "P4");
  if (delegated) return delegated;
  const report = requireArtifact(rcx.runDir, "03-code-understanding.md", readArtifact);
  const out = await rcx.llm.completeJson({
    system: sysOf(rcx, "P4"),
    user: `【代码理解报告】\n${report}\n\n【输出契约】{"hypotheses":[{"id":"A","title":"假设","evidence":"来自报告的证据","verify_file":"验证文件","verify_method":"可执行的验证方法"}]}\n【打回意见】${rcx.reviewComment || "无"}`,
    required: ["hypotheses"],
  });
  writeArtifact(rcx.runDir, "04-hypotheses.json", JSON.stringify(out, null, 2));
  return { artifact: "04-hypotheses.json", summary: `假设 ${out.hypotheses.length} 个` };
}
