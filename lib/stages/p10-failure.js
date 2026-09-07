// lib/stages/p10-failure.js — 调研 §10：先分类，再决定路径
import { writeArtifact } from "../core/store.js";
import { maybeDelegate } from "./helpers.js";
import { sysOf } from "../core/stageConfig.js";

const CATEGORIES = ["实现错误", "根因错误", "测试选择", "环境缺失", "权限被拒", "反复失败"];

export default async function execute(rcx) {
  // 仅失败路径动作：run.status 非 failed 直接跳过（不写任何产物）
  if (rcx.run?.status !== "failed") return { artifact: null, summary: "非失败路径，P10 跳过" };
  const delegated = await maybeDelegate(rcx, "P10");
  if (delegated) return delegated;
  const artifact = "09-failure-analysis.json";
  const fallback = {
    category: "反复失败",
    detail: `P10 LLM 分析不可用时保留原始失败：${rcx.failure?.stage || "未知阶段"} · ${rcx.failure?.error || "未知错误"}`,
    action: "escalate",
    degraded: true,
  };
  writeArtifact(rcx.runDir, artifact, JSON.stringify(fallback, null, 2));
  let out;
  try {
    out = await rcx.llm.completeJson({
      system: sysOf(rcx, "P10"),
      user: `【失败阶段】${rcx.failure?.stage}\n【错误】${rcx.failure?.error}\n【类别】${CATEGORIES.join("/")}\n【输出契约】{"category":"类别","detail":"依据","action":"replan|rollback|escalate"}`,
      required: ["category", "action"],
    });
  } catch {
    return { artifact, summary: `${fallback.category}→${fallback.action}（降级）` };
  }
  if (!CATEGORIES.includes(out.category)) out.category = "反复失败";
  writeArtifact(rcx.runDir, artifact, JSON.stringify(out, null, 2));
  return { artifact, summary: `${out.category}→${out.action}` };
}
