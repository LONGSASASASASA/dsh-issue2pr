// lib/stages/p2-search.js — 调研 §4：结构化 Issue → 候选文件 + 证据
import { writeArtifact, readArtifact } from "../core/store.js";
import { listRepoFiles, requireArtifact, maybeDelegate } from "./helpers.js";
import { sysOf, paramsOf } from "../core/stageConfig.js";

// TASK-05：候选文件输出契约 schema（candidates 元素四字段齐全，confidence 限枚举）
const SCHEMA = {
  type: "object",
  required: ["candidates", "test_candidates", "uncertain"],
  properties: {
    candidates: {
      type: "array",
      items: {
        type: "object",
        required: ["path", "role", "evidence", "confidence"],
        properties: {
          path: { type: "string" },
          role: { type: "string" },
          evidence: { type: "string" },
          confidence: { type: "string", enum: ["high", "medium", "low"] },
        },
      },
    },
    test_candidates: { type: "array", items: { type: "string" } },
    uncertain: { type: "array", items: { type: "string" } },
  },
};

export default async function execute(rcx) {
  const delegated = await maybeDelegate(rcx, "P2");
  if (delegated) return delegated;
  const contract = requireArtifact(rcx.runDir, "01-issue-analysis.json", readArtifact);
  const files = listRepoFiles(rcx.repoDir, paramsOf(rcx, "P2").repoScanMax).join("\n");
  const out = await rcx.llm.completeJson({
    system: sysOf(rcx, "P2"),
    user: `【Issue 契约】\n${contract}\n\n【仓库文件清单】\n${files}\n\n【输出契约】{"candidates":[{"path":"相对路径","role":"模块角色","evidence":"选择理由","confidence":"high|medium|low"}],"test_candidates":["测试文件"],"uncertain":["需进一步探索项"]}`,
    required: ["candidates", "test_candidates", "uncertain"],
    schema: SCHEMA,
  });
  writeArtifact(rcx.runDir, "02-search-candidates.json", JSON.stringify(out, null, 2));
  return { artifact: "02-search-candidates.json", summary: `候选 ${out.candidates.length} 个` };
}
