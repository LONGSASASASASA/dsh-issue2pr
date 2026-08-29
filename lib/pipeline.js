// lib/pipeline.js — 状态机核心（不含任何 LLM/执行细节）
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { writeArtifact, appendArtifactLine, timestamp } from "./store.js";
import { STAGE_DEFS, stageDelegated, delegateReady } from "./stageConfig.js";

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

// session 模式的外部执行就绪判定（与 p7-patch 的 collectPatches 口径一致：
// coder-report.json 存在，或 patches/ 下有 *.diff）
export function sessionPatchesReady(runDir) {
  if (existsSync(join(runDir, "06-implementation", "coder-report.json"))) return true;
  const dir = join(runDir, "06-implementation", "patches");
  if (!existsSync(dir)) return false;
  return readdirSync(dir).some((f) => f.endsWith(".diff"));
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
  // 一次调用持续推进，直到遇上复核门（awaiting_review）或全部通过（completed）；
  // 阶段失败则立即停在该阶段（failed）。每次状态变化都同步落盘 run.json。
  for (;;) {
    // 每个阶段开始前查盘：外部 stop/delete 改写了 run.json 时立即终止推进
    const disk = loadRun(runDir);
    if (!disk || disk.status === "stopped" || disk.status === "deleted") { Object.assign(run, disk || { status: "stopped" }); return; }
    const nextId = MAIN_FLOW.find((id) => run.stages[id].status !== "approved");
    if (!nextId) { run.status = "completed"; saveRun(runDir, run); return; }
    const st = run.stages[nextId];
    run.current = nextId; run.status = "running"; st.status = "running";
    st.startedAt = new Date().toISOString();
    saveRun(runDir, run);
    appendEvent(runDir, nextId, { kind: "stage", name: nextId + " 开始", detail: STAGES.find((s) => s.id === nextId)?.name || "" });
    const t0 = Date.now();
    try {
      const result = await executors[nextId](rcx);
      // 执行器运行期间可能被外部 stop/delete：落盘前复查，避免把 running 写回覆盖 stopped
      const diskAfter = loadRun(runDir);
      if (!diskAfter || diskAfter.status === "stopped" || diskAfter.status === "deleted") {
        Object.assign(run, diskAfter || { status: "stopped" });
        return;
      }
      st.artifact = result && result.artifact;
      if (result && result.external) st.external = true; // session 模式：实施移交外部会话
      st.finishedAt = new Date().toISOString();
      appendSpan(runDir, { span: nextId, ms: Date.now() - t0, decision: (result && result.summary) || "" });
      st.status = isGate(run, nextId) ? "awaiting_review" : "approved";
      run.status = st.status === "approved" ? "running" : "awaiting_review";
      // external 阶段的实施不在本阶段完成，事件文案不能写"完成"（避免误导为已交付）
      const doneLabel = result && result.external
        ? nextId + " 任务包已生成 · 等待外部会话执行"
        : nextId + (st.status === "awaiting_review" ? " 完成 · 待复核" : " 完成");
      appendEvent(runDir, nextId, { kind: "stage", name: doneLabel,
        detail: (result && result.summary) || "", ms: Date.now() - t0 });
    } catch (e) {
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

export function applyReview(rcx, { decision, comment }) {
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
    const output = isP6 ? "patches/*.diff 或 coder-report.json" : (STAGE_DEFS[id]?.delegateSpec?.output || "阶段产物");
    const mode = isP6 ? ((run.p6Mode || "session") + " 模式") : "委托模式";
    return [false, id + " " + mode + "：外部执行方尚未产出（未检测到 " + output + "）。请先在外部智能体执行任务包，产出落盘后再通过复核门"];
  }
  const record = { stage: id, decision, comment: comment || "", at: new Date().toISOString() };
  writeArtifact(runDir, `reviews/${timestamp()}-${decision}-${id}.json`, JSON.stringify(record, null, 2));
  appendEvent(runDir, id, { kind: "stage", name: id + (decision === "approve" ? " 复核通过" : " 复核打回"),
    detail: comment || "无意见" });
  if (decision === "approve") {
    st.status = "approved";
    run.status = "running";
    rcx.reviewComment = "";
  } else {
    st.status = "pending";
    st.attempts += 1;
    run.status = "running";
    rcx.reviewComment = comment;
  }
  saveRun(runDir, run);
  return [true, decision === "approve" ? "已通过" : "已打回，将带意见重跑"];
}