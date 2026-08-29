// lib/stages/p2-search.js — 调研 §4：结构化 Issue → 候选文件 + 证据
import { writeArtifact, readArtifact } from "../store.js";
import { listRepoFiles, requireArtifact, maybeDelegate } from "./helpers.js";
import { sysOf } from "../stageConfig.js";

export default async function execute(rcx) {
  const delegated = await maybeDelegate(rcx, "P2");
  if (delegated) return delegated;
  const contract = requireArtifact(rcx.runDir, "01-issue-analysis.json", readArtifact);
  const files = listRepoFiles(rcx.repoDir).join("\n");
  const out = await rcx.llm.completeJson({
    system: sysOf(rcx, "P2"),
    user: `【Issue 契约】\n${contract}\n\n【仓库文件清单】\n${files}\n\n【输出契约】{"candidates":[{"path":"相对路径","role":"模块角色","evidence":"选择理由","confidence":"high|medium|low"}],"test_candidates":["测试文件"],"uncertain":["需进一步探索项"]}`,
    required: ["candidates", "test_candidates", "uncertain"],
  });
  writeArtifact(rcx.runDir, "02-search-candidates.json", JSON.stringify(out, null, 2));
  return { artifact: "02-search-candidates.json", summary: `候选 ${out.candidates.length} 个` };
}
