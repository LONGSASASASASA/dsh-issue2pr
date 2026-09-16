// P11：客观门禁读取实际证据，语义验收对照需求与产物；未通过不得放行。
import { writeArtifact, readArtifact } from "../core/store.js";
import { maybeDelegate } from "./helpers.js";
import { sysOf } from "../core/stageConfig.js";
import { verifyPatchEvidence } from "../infra/patchEvidence.js";
import { DELIVERY_GATES, evaluationErrors, gateReasons } from "../core/delivery.js";

export { verifyPatchEvidence } from "../infra/patchEvidence.js";

function jsonEvidence(runDir, path) {
  const text = readArtifact(runDir, path);
  if (!text?.trim()) return { path, text: "", value: null, error: path + " 缺失或为空" };
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("顶层必须是对象");
    return { path, text, value, error: "" };
  } catch { return { path, text, value: null, error: path + " 不是有效 JSON 对象" }; }
}

function patchContext(runDir, evidence) {
  let remaining = 48000;
  return (evidence.patches || []).map(item => {
    const text = readArtifact(runDir, item.patch) || "";
    const shown = text.slice(0, Math.min(16000, remaining));
    remaining -= shown.length;
    const note = shown.length === text.length ? "完整补丁" : "仅上下文节选 " + shown.length + "/" + text.length + " 字；原文件未截断，证据校验基于完整文件";
    return "【" + item.patch + " · " + note + "】\n" + shown;
  }).join("\n\n");
}

export default async function execute(rcx) {
  const delegated = await maybeDelegate(rcx, "P11");
  if (delegated) return delegated;
  const patchEvidence = await verifyPatchEvidence(rcx);
  const issue = jsonEvidence(rcx.runDir, "01-issue-analysis.json");
  const hypotheses = jsonEvidence(rcx.runDir, "04-hypotheses.json");
  const review = jsonEvidence(rcx.runDir, "08-review-report.json");
  const tests = jsonEvidence(rcx.runDir, "07-test-report.json");
  const report = {
    schemaVersion: 2, evaluatedAt: new Date().toISOString(),
    // TASK-07：eval 报告绑定本轮 P11 执行身份，重跑后旧报告不可复用通过状态
    stageExecutionId: rcx.run?.stages?.P11?.stageExecutionId || null,
    ROOT: null, PATCH: patchEvidence.ok ? "pass" : "fail", TEST: null, DIFF: null, DESC: null, ACCEPT: "fail",
    reasons: {}, patchEvidence,
  };
  report.reasons.PATCH = patchEvidence.ok
    ? ["补丁账本、文件 SHA-256 与实际工作区差异一致"] : patchEvidence.errors;
  if (!tests.error) {
    report.TEST = tests.value.passed === true && tests.value.exitCode === 0 ? "pass" : "fail";
    report.reasons.TEST = ["07-test-report.json：passed=" + String(tests.value.passed) + "，exitCode=" + String(tests.value.exitCode)];
  } else report.reasons.TEST = [tests.error];
  if (!patchEvidence.ok) {
    report.DIFF = "fail";
    report.reasons.DIFF = ["实际变更未通过补丁证据校验，原审查结论不能证明当前工作区：" + patchEvidence.errors.join("；")];
  } else if (!review.error) {
    report.DIFF = review.value.verdict === "pass" ? "pass" : "fail";
    report.reasons.DIFF = ["08-review-report.json：verdict=" + String(review.value.verdict),
      ...[review.value.diff_scope, review.value.api_security, review.value.tests].filter(value => typeof value === "string" && value.trim())];
  } else report.reasons.DIFF = [review.error];
  const persist = () => writeArtifact(rcx.runDir, "11-eval-report.json", JSON.stringify(report, null, 2));
  const inputErrors = [issue.error, hypotheses.error, tests.error, review.error].filter(Boolean);
  if (!patchEvidence.ok || ["PATCH", "TEST", "DIFF"].some(key => report[key] !== "pass") || inputErrors.length) {
    const blockers = [...inputErrors, ...["PATCH", "TEST", "DIFF"].filter(key => report[key] !== "pass").flatMap(key => report.reasons[key])];
    report.reasons.ROOT = [issue.error || hypotheses.error || "前置证据未通过，尚未执行根因评测"];
    report.reasons.DESC = ["前置证据未通过，尚未生成和评测 PR 说明"];
    report.reasons.ACCEPT = ["前置证据未通过：" + [...new Set(blockers)].join("；")];
    persist();
    throw new Error("P11 " + (!patchEvidence.ok ? "证据校验未通过" : "验收未通过") + ": " + report.reasons.ACCEPT.join("；"));
  }
  const evidenceText = [
    "【Issue 契约 · 01-issue-analysis.json】\n" + issue.text,
    "【根因证据 · 04-hypotheses.json】\n" + hypotheses.text,
    "【Reviewer 结论 · 08-review-report.json】\n" + review.text,
    "【测试报告 · 07-test-report.json】\n" + tests.text,
    "【补丁应用校验】\n" + JSON.stringify(patchEvidence),
    "【补丁账本 · ledger/patch-ledger.jsonl】\n" + (readArtifact(rcx.runDir, "ledger/patch-ledger.jsonl") || ""),
    "【实际补丁】\n" + patchContext(rcx.runDir, patchEvidence),
    "【执行报告（自述，需与以上证据核对）】\n" + (readArtifact(rcx.runDir, "06-implementation/coder-report.json") || "未记录"),
    "【打回意见】\n" + (rcx.reviewComment || "无"),
  ].join("\n\n");
  // 重评期间或模型调用失败时，不能沿用上轮的绿色结果。
  report.ACCEPT = null;
  report.reasons.ROOT = ["根因评测尚未完成"];
  report.reasons.DESC = ["说明生成与评测尚未完成"];
  report.reasons.ACCEPT = ["最终验收尚未完成"];
  persist();
  try {
    const md = await rcx.llm.complete({
      system: sysOf(rcx, "P11", "desc"),
      user: evidenceText + "\n\n【说明要求】以实际补丁和测试记录为准；上下文节选不代表原补丁损坏。明确尚未满足的需求、约束与文档同步要求，不得把计划或执行者自述当作已验证事实。",
    });
    if (typeof md !== "string" || !md.trim()) throw new Error("PR 说明为空，需重新生成");
    writeArtifact(rcx.runDir, "10-pr-description.md", md);
    const evalOut = await rcx.llm.completeJson({
      system: sysOf(rcx, "P11", "gate"),
      user: evidenceText + "\n\n【PR 说明】\n" + md
        + "\n\n【已确定的客观门禁】PATCH=pass（实际应用校验），TEST=pass（测试报告），DIFF=pass（P9 审查与实际补丁校验）。沿用这些结论，不从 PR 说明重新猜测。"
        + "\n【语义验收】ROOT 对照根因证据；DESC 对照真实补丁、测试、审查及未完成事项；ACCEPT 逐项核对 Issue success_criteria 与 constraints，包括兼容策略和文档同步。需要修正的真实遗漏应在 ACCEPT/DESC 给出引用文件和具体原因。信息不足不得声称通过，fail 必须说明依据。"
        + '\n【输出契约】{"ROOT":"pass|fail","DESC":"pass|fail","ACCEPT":"pass|fail","reasons":{"ROOT":["依据"],"DESC":["依据"],"ACCEPT":["依据"]}}',
      required: ["ROOT", "DESC", "ACCEPT"],
      // TASK-05：语义验收契约 schema —— ROOT/DESC/ACCEPT 严格限 pass|fail 枚举，
      // reasons 三键必填且为字符串数组（fail 必须给依据的要求由 gateReasons 层兜底）
      schema: {
        type: "object",
        required: ["ROOT", "DESC", "ACCEPT", "reasons"],
        properties: {
          ROOT: { type: "string", enum: ["pass", "fail"] },
          DESC: { type: "string", enum: ["pass", "fail"] },
          ACCEPT: { type: "string", enum: ["pass", "fail"] },
          reasons: {
            type: "object",
            required: ["ROOT", "DESC", "ACCEPT"],
            properties: {
              ROOT: { type: "array", items: { type: "string" } },
              DESC: { type: "array", items: { type: "string" } },
              ACCEPT: { type: "array", items: { type: "string" } },
            },
          },
        },
      },
    });
    for (const key of ["ROOT", "DESC", "ACCEPT"]) {
      report[key] = ["pass", "fail"].includes(evalOut?.[key]) ? evalOut[key] : null;
      report.reasons[key] = gateReasons(evalOut, key);
      if (report[key] === null) report.reasons[key] = [key + " 评测未返回有效 pass|fail 结论，需重新评测"];
      else if (report[key] === "fail" && !report.reasons[key].length) report.reasons[key] = [key + " 评测判为未通过，但未提供依据，需重新评测"];
    }
    const blockers = DELIVERY_GATES.filter(key => key !== "ACCEPT" && report[key] !== "pass");
    if (blockers.length) {
      report.ACCEPT = "fail";
      report.reasons.ACCEPT = [...report.reasons.ACCEPT, "前置门禁未全部通过：" + blockers.join("、")];
    }
  } catch (error) {
    report.ACCEPT = null;
    report.reasons.ACCEPT = ["评测未完成：" + String(error.message || error)];
    persist();
    throw error;
  }
  persist();
  const errors = evaluationErrors(report);
  if (errors.length) throw new Error("P11 验收未通过: " + errors.join("；"));
  return { artifact: "10-pr-description.md", summary: "PR 说明生成，六项验收全部通过" };
}
