// P11 放行契约：执行结束不等于验收通过，所有调用路径共用同一报告检查。
import { readArtifact } from "./store.js";

export const DELIVERY_GATES = ["ROOT", "PATCH", "TEST", "DIFF", "DESC", "ACCEPT"];
export const DELIVERY_GATE_NAMES = {
  ROOT: "根因证据", PATCH: "补丁应用", TEST: "回归测试",
  DIFF: "变更审查", DESC: "说明忠实", ACCEPT: "验收门禁",
};

export function gateReasons(report, key) {
  const value = report?.reasons?.[key];
  return (Array.isArray(value) ? value : typeof value === "string" ? [value] : [])
    .filter(reason => typeof reason === "string" && reason.trim()).map(reason => reason.trim());
}

export function evaluationErrors(report) {
  if (!report || typeof report !== "object" || Array.isArray(report)) return ["11-eval-report.json 必须是验收对象"];
  return DELIVERY_GATES.flatMap(key => {
    if (report[key] === "pass") return [];
    const reasons = gateReasons(report, key);
    const state = report[key] === "fail" ? "未通过" : "缺少有效结论（仅允许 pass|fail）";
    return [key + " " + DELIVERY_GATE_NAMES[key] + state + "：" + (reasons.join("；") || "报告未记录原因，需重新评测")];
  });
}

export function validateDeliveryReport(runDir) {
  let report = null;
  const errors = [];
  try {
    if (!readArtifact(runDir, "10-pr-description.md")?.trim()) errors.push("10-pr-description.md 缺失或为空");
    const text = readArtifact(runDir, "11-eval-report.json");
    if (!text?.trim()) errors.push("11-eval-report.json 缺失或为空，尚未完成验收");
    else {
      try { report = JSON.parse(text); errors.push(...evaluationErrors(report)); }
      catch { errors.push("11-eval-report.json 不是合法 JSON"); }
    }
  } catch (error) { errors.push("验收报告读取失败：" + String(error.message || error)); }
  return { ok: errors.length === 0, errors, report };
}
