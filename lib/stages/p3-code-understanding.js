// lib/stages/p3-code-understanding.js — 调研 §4：调用链理解（基于真实文件内容）
import { writeArtifact, readArtifact } from "../store.js";
import { requireArtifact, readRepoFile } from "./helpers.js";

export default async function execute(rcx) {
  const candidates = JSON.parse(requireArtifact(rcx.runDir, "02-search-candidates.json", readArtifact));
  const files = (candidates.candidates || []).slice(0, 6)
    .map((c) => `### ${c.path}\n\`\`\`\n${readRepoFile(rcx.repoDir, c.path)}\n\`\`\``).join("\n\n");
  const md = await rcx.llm.complete({
    system: "你是 Code Understanding。基于真实文件内容分析调用链：关键函数、调用方、潜在修改点。输出中文 markdown，三小节标题固定为「## 关键函数」「## 调用方」「## 潜在修改点」。",
    user: `【候选文件内容】\n${files}\n\n【打回意见】${rcx.reviewComment || "无"}`,
  });
  writeArtifact(rcx.runDir, "03-code-understanding.md", md);
  return { artifact: "03-code-understanding.md", summary: "报告 " + md.length + " 字" };
}