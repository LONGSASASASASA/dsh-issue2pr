// lib/stages/p9-reviewer.js — 调研 §9：Review 是 PRBuilder 的前置门控
import { writeArtifact, readArtifact } from "../core/store.js";
import { requireArtifact, maybeDelegate } from "./helpers.js";
import { sysOf, paramsOf } from "../core/stageConfig.js";
import { llmError } from "../infra/llm.js";

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
      if (text == null) return null;
      const shown = text.slice(0, diffChars);
      const note = shown.length === text.length ? "完整补丁" : `上下文节选 ${shown.length}/${text.length} 字，原文件未截断`;
      return `### ${rel}（${note}）\n\n${shown}\n`;
    })
    .filter((s) => s != null)
    .join("\n");

  const out = await rcx.llm.completeJson({
    system: sysOf(rcx, "P9"),
    user: `【coder-report】\n${coderReportRaw}\n【实际补丁（完整性见各文件标注）】\n${diffs || "（无 diff 文件）"}\n上下文节选不代表原补丁文件损坏。若节选不足以审查，请明确所缺证据，不得假定原文件截断。\n【test-report】\n${tests}\n【输出契约】{"diff_scope":"结论","api_security":"结论","tests":"结论","verdict":"pass|fail"}\n【打回意见】${rcx.reviewComment || "无"}`,
    required: ["diff_scope", "api_security", "tests", "verdict"],
    // TASK-05：三维门控契约 schema（verdict 限 pass|fail 枚举，三维结论必为字符串）
    schema: {
      type: "object",
      required: ["diff_scope", "api_security", "tests", "verdict"],
      properties: {
        diff_scope: { type: "string" },
        api_security: { type: "string" },
        tests: { type: "string" },
        verdict: { type: "string", enum: ["pass", "fail"] },
      },
    },
  });
  writeArtifact(rcx.runDir, "08-review-report.json", JSON.stringify(out, null, 2));
  // TASK-07：P9 fail 是有效业务结论（business_gate_failed），与协议/调用错误分开
  if (out.verdict !== "pass") {
    throw llmError("business_gate_failed", "Reviewer 门控未过: " + (out.diff_scope || ""),
      { gate: "P9-reviewer", verdict: out.verdict });
  }
  return { artifact: "08-review-report.json", summary: "三维门控 pass" };
}
