// lib/stages/p3-code-understanding.js — 调研 §4：调用链理解（基于真实文件内容）
import { writeArtifact, readArtifact } from "../store.js";
import { requireArtifact, readRepoFile, maybeDelegate } from "./helpers.js";
import { sysOf } from "../stageConfig.js";

export default async function execute(rcx) {
  const delegated = await maybeDelegate(rcx, "P3");
  if (delegated) return delegated;
  const candidates = JSON.parse(requireArtifact(rcx.runDir, "02-search-candidates.json", readArtifact));
  const files = (candidates.candidates || []).slice(0, 6)
    .map((c) => `### ${c.path}\n\`\`\`\n${readRepoFile(rcx.repoDir, c.path)}\n\`\`\``).join("\n\n");
  const md = await rcx.llm.complete({
    system: sysOf(rcx, "P3"),
    user: `【候选文件内容】\n${files}\n\n【打回意见】${rcx.reviewComment || "无"}`,
  });
  writeArtifact(rcx.runDir, "03-code-understanding.md", md);
  return { artifact: "03-code-understanding.md", summary: "报告 " + md.length + " 字" };
}
