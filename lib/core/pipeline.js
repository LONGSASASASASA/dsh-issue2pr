// lib/pipeline.js — 状态机核心（不含任何 LLM/执行细节）
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeArtifact, appendArtifactLine, timestamp } from "./store.js";
import { STAGE_DEFS, stageDelegated, delegateReady, purgeDelegateArtifacts } from "./stageConfig.js";
import { verifyDelegateResult } from "../delegate/delegateVerify.js";
import { verifyPatchEvidence } from "../infra/patchEvidence.js";
import { validateDeliveryReport } from "./delivery.js";

export const STAGES = [
  { id: "P1",  name: "IssueAnalyzer",      artifact: "01-issue-analysis.json",     key: false },
  { id: "P2",  name: "Search Layer",       artifact: "02-search-candidates.json",  key: false },
  { id: "P3",  name: "Code Understanding", artifact: "03-code-understanding.md",   key: false },
  { id: "P4",  name: "Hypothesis",         artifact: "04-hypotheses.json",         key: false },
  { id: "P5",  name: "Planner",            artifact: "05-task-graph.json",         key: true  },
  { id: "P6",  name: "代码优化",            artifact: "06-implementation/",         key: true  },
  { id: "P7",  name: "Patch Pipeline",     artifact: "ledger/patch-ledger.jsonl",  key: false },
  { id: "P8",  name: "TestRunner",         artifact: "07-test-report.json",        key: false },
  { id: "P9",  name: "Reviewer",           artifact: "08-review-report.json",      key: true  },
  { id: "P10", name: "FailureClassifier",  artifact: "09-failure-analysis.json",   key: false },
  { id: "P11", name: "PRBuilder + Eval",   artifact: "10-pr-description.md",       key: true  },
];
export const MAIN_FLOW = ["P1", "P2", "P3", "P4", "P5", "P6", "P7", "P8", "P9", "P11"];
export const DEFAULT_MAX_REVIEW_ATTEMPTS = 3;

export function initRun({ runId, slug, trigger, reviewMode, p6Mode }) {
  return {
    id: runId, project: slug, trigger, reviewMode, p6Mode,
    createdAt: new Date().toISOString(), status: "pending", current: "P1",
    stages: Object.fromEntries(STAGES.map((s) => [s.id, { status: "pending", attempts: 0 }])),
  };
}

const runFile = (runDir) => join(runDir, "run.json");
export function saveRun(runDir, run) { writeArtifact(runDir, "run.json", JSON.stringify(run, null, 2)); }
export function loadRun(runDir) {
  return existsSync(runFile(runDir)) ? JSON.parse(readFileSync(runFile(runDir), "utf8")) : null;
}

export function isGate(run, stageId) {
  if (run.reviewMode === "every") return true;
  if (run.reviewMode === "key-only") return !!STAGES.find((s) => s.id === stageId)?.key;
  return false;
}

// 报告落盘才进入完整性验证；中途生成的补丁不能视为已交付。
export function sessionPatchesReady(runDir) {
  return delegateReady(runDir, "P6");
}

function maxReviewAttemptsOf(rcx) {
  const candidates = [rcx?.run?.maxReviewAttempts, rcx?.project?.maxReviewAttempts];
  for (const value of candidates) {
    const attempts = Number(value);
    if (Number.isInteger(attempts) && attempts > 0) return attempts;
  }
  return DEFAULT_MAX_REVIEW_ATTEMPTS;
}

function appendSpan(runDir, span) {
  mkdirSync(join(runDir, "trace"), { recursive: true });
  appendFileSync(join(runDir, "trace", "spans.jsonl"), JSON.stringify({ at: new Date().toISOString(), ...span }) + "\n");
}

// 过程事件（trace/events.jsonl，UI 阶段详情展示；写失败不影响主流程）
function appendEvent(runDir, stage, ev) {
  try {
    appendArtifactLine(runDir, "trace/events.jsonl", {
      at: new Date().toISOString(), stage,
      kind: ev.kind || "stage", name: String(ev.name || "").slice(0, 200),
      detail: String(ev.detail == null ? "" : ev.detail).slice(0, 2000),
      ms: typeof ev.ms === "number" ? Math.round(ev.ms) : null, ok: ev.ok !== false,
    });
  } catch { /* 忽略 */ }
}

export async function advance(rcx) {
  const { run, runDir, executors } = rcx;
  // 处于复核门等待时不再推进，避免重复执行门阶段（违反不变式并浪费执行）
  if (run.status === "awaiting_review") return;
  // 终态不可被外部再次 advance 复活；pending 仍允许首次启动。
  if (["failed", "stopped", "deleted", "completed"].includes(run.status)) return;
  // 一次调用持续推进，直到遇上复核门（awaiting_review）或全部通过（completed）；
  // 阶段失败则立即停在该阶段（failed）。每次状态变化都同步落盘 run.json。
  for (;;) {
    // 每个阶段开始前查盘：外部 stop/delete 改写了 run.json 时立即终止推进
    const disk = loadRun(runDir);
    if (!disk || disk.status === "stopped" || disk.status === "deleted") { Object.assign(run, disk || { status: "stopped" }); return; }
    const nextId = MAIN_FLOW.find((id) => run.stages[id].status !== "approved");
    if (!nextId) {
      // approved 只代表阶段曾被放行；最终完成前仍须检查当前交付产物，防止旧状态绕过验收。
      const delivery = validateDeliveryReport(runDir);
      if (!delivery.ok) {
        const st = run.stages.P11;
        st.status = "failed";
        st.error = "P11 交付验收未通过: " + delivery.errors.join("；");
        st.finishedAt = new Date().toISOString();
        run.current = "P11";
        run.status = "failed";
        appendSpan(runDir, { span: "P11", ms: 0, error: st.error });
        appendEvent(runDir, "P11", { kind: "stage", name: "P11 交付验收未通过", detail: st.error, ok: false });
      } else {
        run.status = "completed";
      }
      saveRun(runDir, run);
      return;
    }
    const st = run.stages[nextId];
    run.current = nextId; run.status = "running"; st.status = "running";
    st.startedAt = new Date().toISOString();
    saveRun(runDir, run);
    appendEvent(runDir, nextId, { kind: "stage", name: nextId + " 开始", detail: STAGES.find((s) => s.id === nextId)?.name || "" });
    const t0 = Date.now();
    try {
      // A4 兜底 + 修正：P7 应用前对委托 P6 产物做完整验证（不只是存在性检查）。
      // 存在 ≠ 可用：产物被外部删除 → 显式失败；产物存在但对 HEAD 基线不可应用（过期/坏补丁）
      // → 同样显式拦截，而不是让 git apply 在半路炸出难定位的错。
      if (nextId === "P7" && stageDelegated(rcx, "P6")) {
        if (!delegateReady(runDir, "P6")) {
          throw new Error("P6 委托产物缺失（无 coder-report.json），无法确认任务完整性；请补齐 P6 产物后重试");
        }
        const v7 = await verifyDelegateResult(rcx, "P6");
        if (!v7.ok) {
          throw new Error("P6 委外产物验证未通过，P7 拒绝应用: " + v7.errors.join("；"));
        }
      }
      const result = await executors[nextId](rcx);
      // 执行器运行期间可能被外部 stop/delete：落盘前复查，避免把 running 写回覆盖 stopped
      const diskAfter = loadRun(runDir);
      if (!diskAfter || diskAfter.status === "stopped" || diskAfter.status === "deleted"
          || diskAfter.stages?.[nextId]?.startedAt !== st.startedAt) {
        Object.assign(run, diskAfter || { status: "stopped" });
        return;
      }
      st.artifact = result && result.artifact;
      if (result && result.external) st.external = true; // session 模式：实施移交外部会话
      st.finishedAt = new Date().toISOString();
      appendSpan(runDir, { span: nextId, ms: Date.now() - t0, decision: (result && result.summary) || "" });
      // A4 修复 + 修正：委托阶段必须「拿到委外结果且验证 ok」才允许流转，缺一不可：
      // ① 产物未就绪 → 无论复核模式是否有门都停下等待（空手放行 = 下游必然失败）；
      // ② 产物就绪 → 立即执行验证（结构完整 + 对 HEAD 基线的应用性演练），验证不过 = 显式失败。
      //    全自动模式 claude 产出的坏补丁 / 会话期间被篡改的补丁，原先会直通 P7 才在 apply 炸，
      //    现在在 P6 门上就地拦截并给出可定位的错误。
      let delegateBlocked = false;
      if (stageDelegated(rcx, nextId)) {
        if (!delegateReady(runDir, nextId)) {
          delegateBlocked = true;
        } else {
          const v = await verifyDelegateResult(rcx, nextId);
          appendEvent(runDir, nextId, { kind: "stage", name: nextId + " 委外产物验证" + (v.ok ? "通过" : "未通过"),
            detail: v.ok
              ? "结构完整" + (v.rehearsal ? "，对 HEAD 基线应用性演练通过（" + v.patches + " 份补丁）" : "（无仓库环境，未演练）")
              : v.errors.join("；"),
            ok: v.ok });
          if (!v.ok) throw new Error(nextId + " 委外产物验证未通过: " + v.errors.join("；") + "；请回退该阶段重跑，或修正外部产物");
        }
      }
      if (nextId === "P11" && !stageDelegated(rcx, nextId)) {
        const delivery = validateDeliveryReport(runDir);
        if (!delivery.ok) throw new Error("P11 交付验收未通过: " + delivery.errors.join("；"));
      }
      st.status = (isGate(run, nextId) || delegateBlocked) ? "awaiting_review" : "approved";
      run.status = st.status === "approved" ? "running" : "awaiting_review";
      // external 阶段的实施不在本阶段完成，事件文案不能写"完成"（避免误导为已交付）
      const doneLabel = result && result.external
        ? nextId + " 任务包已生成 · 等待外部会话执行"
        : delegateBlocked
          ? nextId + " 任务包已生成 · 等待外部产出后放行"
          : nextId + (st.status === "awaiting_review" ? " 完成 · 待复核" : " 完成");
      appendEvent(runDir, nextId, { kind: "stage", name: doneLabel,
        detail: (result && result.summary) || "", ms: Date.now() - t0 });
    } catch (e) {
      // 取消或旧执行迟到的异常不得把 stopped/新一轮状态覆盖为 failed。
      const diskAfterError = loadRun(runDir);
      if (!diskAfterError || ["stopped", "deleted"].includes(diskAfterError.status)
          || diskAfterError.stages?.[nextId]?.startedAt !== st.startedAt) {
        Object.assign(run, diskAfterError || { status: "stopped" });
        return;
      }
      st.status = "failed"; st.error = String((e && e.message) || e);
      run.status = "failed";
      appendSpan(runDir, { span: nextId, ms: Date.now() - t0, error: st.error });
      appendEvent(runDir, nextId, { kind: "stage", name: nextId + " 失败", detail: st.error, ms: Date.now() - t0, ok: false });
      saveRun(runDir, run);
      return;
    }
    saveRun(runDir, run);
    if (st.status === "awaiting_review") return;
  }
}

// 异步原因（A4 修正）：委托阶段的通过判定要做完整验证（含 git 应用性演练），
// 文件存在性检查不再足够——人工放行与全自动放行同一验证口径。
export async function applyReview(rcx, { decision, comment }) {
  const { run, runDir } = rcx;
  const id = run.current;
  const st = run.stages[id];
  if (!st || st.status !== "awaiting_review") return [false, "当前阶段不在待复核状态"];
  if (decision === "reject" && !String(comment || "").trim()) return [false, "打回必须填写复核意见"];
  if (decision !== "approve" && decision !== "reject") return [false, "decision 仅允许 approve|reject"];
  // 委托模式（P6 session/claude、其余阶段配置页委托开关）：实施在插件外完成。
  // 空手放行会让下游拿不到产物而必然失败，因此通过前必须看到该阶段产出。
  // 按 p6Mode/stageConfig 推导（不依赖 st.external 字段）：旧版本创建的 run 也能被拦截。
  if (decision === "approve" && stageDelegated(rcx, id) && !delegateReady(runDir, id)) {
    const isP6 = id === "P6";
    const output = isP6 ? "coder-report.json，已有补丁不代表全部任务完成" : (STAGE_DEFS[id]?.delegateSpec?.output || "阶段产物");
    const mode = isP6 ? ((run.p6Mode || "session") + " 模式") : "委托模式";
    return [false, id + " " + mode + "：外部执行方尚未产出（未检测到 " + output + "）。请先在外部智能体执行任务包，产出落盘后再通过复核门"];
  }
  // A4 修正：人工放行同样必须先过机器验证——「文件存在」只证明拿到结果，不证明结果可用。
  // 坏补丁（结构残缺 / 对 HEAD 基线不可应用 / report 损坏）在这里拦截，不让它进 P7。
  if (decision === "approve" && stageDelegated(rcx, id)) {
    const v = await verifyDelegateResult(rcx, id);
    if (!v.ok) {
      return [false, id + " 委外产物验证未通过: " + v.errors.join("；") + "。请修正外部产物后重试，或打回重跑"];
    }
  }
  if (decision === "approve" && id === "P11" && !stageDelegated(rcx, id)) {
    const evidence = await verifyPatchEvidence(rcx);
    if (!evidence.ok) {
      return [false, "P11 证据校验未通过: " + evidence.errors.join("；") + "。请确认工作区与已应用 patch 一致后重试"];
    }
    const delivery = validateDeliveryReport(runDir);
    if (!delivery.ok) {
      return [false, "P11 交付验收未通过: " + delivery.errors.join("；") + "。请修正交付产物后重试，或打回重跑"];
    }
  }
  const nextAttempts = decision === "reject"
    ? (Number.isInteger(st.attempts) && st.attempts >= 0 ? st.attempts : 0) + 1
    : st.attempts;
  const maxAttempts = maxReviewAttemptsOf(rcx);
  const terminalReject = decision === "reject" && nextAttempts >= maxAttempts;
  const record = {
    stage: id, decision, comment: comment || "", at: new Date().toISOString(),
    ...(decision === "reject" ? { attempt: nextAttempts, maxReviewAttempts: maxAttempts } : {}),
  };
  writeArtifact(runDir, `reviews/${timestamp()}-${decision}-${id}.json`, JSON.stringify(record, null, 2));
  appendEvent(runDir, id, { kind: "stage", name: id + (decision === "approve"
    ? " 复核通过"
    : terminalReject ? " 复核打回（达到最大复核次数，Run 已失败）" : " 复核打回"),
    detail: comment || "无意见" });
  if (decision === "approve") {
    st.status = "approved";
    run.status = "running";
    rcx.reviewComment = "";
  } else {
    st.status = "pending";
    st.attempts = nextAttempts;
    rcx.reviewComment = comment;
    // A2 修复：打回委托阶段时清空旧外部产物 —— 旧 patches/report 会让 delegateReady 误判
    // "外部已交付"（复核门形同虚设），并被 P7 当作本轮补丁应用（过期 patch 混入）。清场后按新任务包重新产出。
    if (stageDelegated(rcx, id)) {
      const removed = purgeDelegateArtifacts(runDir, id);
      appendEvent(runDir, id, { kind: "stage", name: id + " 打回清场",
        detail: removed.length ? "已清除旧外部产物: " + removed.join(", ") : "无旧外部产物可清" });
    }
    if (terminalReject) {
      st.status = "failed";
      st.error = id + " 已达到最大复核次数（" + maxAttempts + " 次），Run 已失败，请人工介入";
      st.finishedAt = new Date().toISOString();
      run.status = "failed";
    } else {
      run.status = "running";
    }
  }
  saveRun(runDir, run);
  if (terminalReject) return [false, st.error];
  return [true, decision === "approve" ? "已通过" : "已打回，将带意见重跑"];
}
