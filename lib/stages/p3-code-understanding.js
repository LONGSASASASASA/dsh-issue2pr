// lib/stages/p3-code-understanding.js — 调研 §4：调用链理解（基于真实文件内容）
import { writeArtifact, readArtifact } from "../store.js";
import { requireArtifact, readRepoFile, maybeDelegate } from "./helpers.js";
import { sysOf, paramsOf } from "../stageConfig.js";

export default async function execute(rcx) {
  const delegated = await maybeDelegate(rcx, "P3");
  if (delegated) return delegated;
  const candidates = JSON.parse(requireArtifact(rcx.runDir, "02-search-candidates.json", readArtifact));
  const pm = paramsOf(rcx, "P3");
  const files = (candidates.candidates || []).slice(0, pm.deepReadFiles)
    .map((c) => {
      const raw = readRepoFile(rcx.repoDir, c.path, pm.fileChars);
      // 行号前缀让 LLM 能给出可信的 `路径:行号` 锚点（readRepoFile 本身不加，P6 写补丁依赖原文）
      const numbered = raw.split("\n").map((l, i) => `${i + 1}|${l}`).join("\n");
      return `### ${c.path}\n\`\`\`\n${numbered}\n\`\`\``;
    }).join("\n\n");
  const md = await rcx.llm.complete({
    system: sysOf(rcx, "P3"),
    user: `【候选文件内容】（每行前缀「行号|」为源码真实行号）\n${files}\n\n【打回意见】${rcx.reviewComment || "无"}`,
  });
  writeArtifact(rcx.runDir, "03-code-understanding.md", md);
  return { artifact: "03-code-understanding.md", summary: "报告 " + md.length + " 字" };
}
