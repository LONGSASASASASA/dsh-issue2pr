// lib/stages/p9-reviewer.js — 调研 §9：Review 是 PRBuilder 的前置门控
import { writeArtifact, readArtifact } from "../store.js";
import { requireArtifact } from "./helpers.js";

export default async function execute(rcx) {
  const coderReportRaw = readArtifact(rcx.runDir, "06-implementation/coder-report.json") || "{}";
  const tests = requireArtifact(rcx.runDir, "07-test-report.json", readArtifact);

  // 读盘取 diff 全文（修复轮：Diff 范围裁决必须看到真实 patch，而非 coder 自评）
  // coder-report 无 patches 字段或 diff 文件读不到 → 降级为空清单，不抛错
  let coderReport = {};
  try { coderReport = JSON.parse(coderReportRaw); } catch { coderReport = {}; }
  const diffs = (Array.isArray(coderReport.patches) ? coderReport.patches : [])
    .map((p) => {
      const name = p && typeof p.patch === "string" ? p.patch.split(/[\\/]+/).pop() : "";
      if (!name) return null;
      const rel = `06-implementation/patches/${name}`;
      const text = readArtifact(rcx.runDir, rel);
      return text == null ? null : `### ${rel}\n\n${text.slice(0, 4000)}\n`;
    })
    .filter((s) => s != null)
    .join("\n");

  const out = await rcx.llm.completeJson({
    system: "你是 Reviewer Agent。三维门控：①Diff 范围（过大/越权/遗漏调用方）②API 与安全 ③测试补强与说明忠实。测试通过 ≠ 可合并。只输出 JSON。",
    user: `【coder-report】\n${coderReportRaw}\n【Diff 全文】\n${diffs || "（无 diff 文件）"}\n【test-report】\n${tests}\n【输出契约】{"diff_scope":"结论","api_security":"结论","tests":"结论","verdict":"pass|fail"}\n【打回意见】${rcx.reviewComment || "无"}`,
    required: ["diff_scope", "api_security", "tests", "verdict"],
  });
  writeArtifact(rcx.runDir, "08-review-report.json", JSON.stringify(out, null, 2));
  if (out.verdict !== "pass") throw new Error("Reviewer 门控未过: " + (out.diff_scope || ""));
  return { artifact: "08-review-report.json", summary: "三维门控 pass" };
}