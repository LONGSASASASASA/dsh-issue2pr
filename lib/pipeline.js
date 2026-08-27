// lib/pipeline.js — 状态机核心（不含任何 LLM/执行细节）
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { writeArtifact, timestamp } from "./store.js";

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

function appendSpan(runDir, span) {
  mkdirSync(join(runDir, "trace"), { recursive: true });
  appendFileSync(join(runDir, "trace", "spans.jsonl"), JSON.stringify({ at: new Date().toISOString(), ...span }) + "\n");
}

export async function advance(rcx) {
  const { run, runDir, executors } = rcx;
  // 处于复核门等待时不再推进，避免重复执行门阶段（违反不变式并浪费执行）
  if (run.status === "awaiting_review") return;
  // 一次调用持续推进，直到遇上复核门（awaiting_review）或全部通过（completed）；
  // 阶段失败则立即停在该阶段（failed）。每次状态变化都同步落盘 run.json。
  for (;;) {
    const nextId = MAIN_FLOW.find((id) => run.stages[id].status !== "approved");
    if (!nextId) { run.status = "completed"; saveRun(runDir, run); return; }
    const st = run.stages[nextId];
    run.current = nextId; run.status = "running"; st.status = "running";
    st.startedAt = new Date().toISOString();
    saveRun(runDir, run);
    const t0 = Date.now();
    try {
      const result = await executors[nextId](rcx);
      st.artifact = result && result.artifact;
      st.finishedAt = new Date().toISOString();
      appendSpan(runDir, { span: nextId, ms: Date.now() - t0, decision: (result && result.summary) || "" });
      st.status = isGate(run, nextId) ? "awaiting_review" : "approved";
      run.status = st.status === "approved" ? "running" : "awaiting_review";
    } catch (e) {
      st.status = "failed"; st.error = String((e && e.message) || e);
      run.status = "failed";
      appendSpan(runDir, { span: nextId, ms: Date.now() - t0, error: st.error });
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
  const record = { stage: id, decision, comment: comment || "", at: new Date().toISOString() };
  writeArtifact(runDir, `reviews/${timestamp()}-${decision}-${id}.json`, JSON.stringify(record, null, 2));
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