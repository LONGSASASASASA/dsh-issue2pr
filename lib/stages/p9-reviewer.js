// lib/stages/p9-reviewer.js — 调研 §9：Review 是 PRBuilder 的前置门控
import { writeArtifact, readArtifact } from "../store.js";
import { requireArtifact, maybeDelegate } from "./helpers.js";
import { sysOf, paramsOf } from "../stageConfig.js";

export default async function execute(rcx) {
  const delegated = await maybeDelegate(rcx, "P9");
  if (delegated) return delegated;
  const coderReportRaw = readArtifact(rcx.runDir, "06-implementation/coder-report.json") || "{}";
  const tests = requireArtifact(rcx.runDir, "07-test-report.json", readArtifact);
  const diffChars = paramsOf(rcx, "P9").diffChars;

  // 读盘取 diff 全文（修复轮：Diff 范围裁决必须看到真实 patch，而非 coder 自评）
  // coder-report 无可用清单或 diff 文件读不到 → 降级为空清单，不抛错
  let coderReport = {};
  try { coderReport = JSON.parse(coderReportRaw); } catch { coderReport = {}; }
  // builtin 写 patches 字段；claude 委托写 tasks 字段——两者都认，取到清单为止
  const patchList = Array.isArray(coderReport.patches) ? coderReport.patches
    : Array.isArray(coderReport.tasks) ? coderReport.tasks : [];
  const diffs = patchList
    .map((p) => {
      const name = p && typeof p.patch === "string" ? p.patch.split(/[\\/]+/).pop() : "";
      if (!name) return null;
      const rel = `06-implementation/patches/${name}`;
      const text = readArtifact(rcx.runDir, rel);
      // 每份只取头部 diffChars 字（文件路径 + hunk 概览足够范围裁决）：
      // 15 份 × 4000 字曾让 prompt 达 45K 字，实测 LLM 直接空响应（上限可在「配置」调整）
      return text == null ? null : `### ${rel}\n\n${text.slice(0, diffChars)}\n`;
    })
    .filter((s) => s != null)
    .join("\n");

  const out = await rcx.llm.completeJson({
    system: sysOf(rcx, "P9"),
    user: `【coder-report】\n${coderReportRaw}\n【Diff 全文】\n${diffs || "（无 diff 文件）"}\n【test-report】\n${tests}\n【输出契约】{"diff_scope":"结论","api_security":"结论","tests":"结论","verdict":"pass|fail"}\n【打回意见】${rcx.reviewComment || "无"}`,
    required: ["diff_scope", "api_security", "tests", "verdict"],
  });
  writeArtifact(rcx.runDir, "08-review-report.json", JSON.stringify(out, null, 2));
  if (out.verdict !== "pass") throw new Error("Reviewer 门控未过: " + (out.diff_scope || ""));
  return { artifact: "08-review-report.json", summary: "三维门控 pass" };
}
