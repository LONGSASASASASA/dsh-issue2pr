// P10 是失败阶段的旁路分析：独立记状态，绝不移动主流程 current。
import { randomUUID } from "node:crypto";
import { loadRun, saveRun, structuredErrorOf } from "./pipeline.js";
import { appendArtifactLine, readArtifact, writeArtifact } from "./store.js";

export async function analyzeFailure(rcx, error, configure = value => value, errorInfo = null) {
  const { runDir } = rcx;
  const run = loadRun(runDir);
  if (!run || run.status !== "failed" || !rcx.executors?.P10) return;
  const sourceStage = run.current;
  const sourceStartedAt = run.stages?.[sourceStage]?.startedAt || null;
  // 源阶段执行身份（TASK-01）：旧 run 无 stageExecutionId 时为 null，双方一致即视为同一轮（兼容形态）
  const sourceStageExecutionId = run.stages?.[sourceStage]?.stageExecutionId || null;
  const previous = run.stages?.P10;
  const resume = rcx.resumeFailureAnalysis && previous?.status === "awaiting_review" &&
    previous.sourceStage === sourceStage && previous.sourceStartedAt === sourceStartedAt &&
    (previous.sourceStageExecutionId || null) === sourceStageExecutionId && previous.analysisId;
  if (previous?.sourceStage === sourceStage && previous?.sourceStartedAt === sourceStartedAt &&
      (previous?.sourceStageExecutionId || null) === sourceStageExecutionId &&
      ["running", "approved", "awaiting_review"].includes(previous.status) && !resume) return;
  const analysisId = resume ? previous.analysisId : randomUUID();
  const identity = { analysisId, sourceStage, sourceStartedAt,
    ...(sourceStageExecutionId ? { sourceStageExecutionId } : {}) };
  const startedAt = new Date().toISOString();
  const artifact = `trace/failures/${analysisId}.json`;
  run.stages.P10 = { ...identity, startedAt, status: "running", attempts: (previous?.attempts || 0) + 1 };
  delete run.failureAnalysis;
  saveRun(runDir, run);
  const current = () => {
    const latest = loadRun(runDir);
    return latest?.status === "failed" && latest.current === sourceStage &&
      (latest.stages?.[sourceStage]?.startedAt || null) === sourceStartedAt &&
      (latest.stages?.[sourceStage]?.stageExecutionId || null) === sourceStageExecutionId &&
      latest.stages?.P10?.analysisId === analysisId ? latest : null;
  };
  const event = (name, detail, ok = true) => {
    if (!current()) return;
    appendArtifactLine(runDir, "trace/events.jsonl", {
      ...identity, at: new Date().toISOString(), stage: "P10", kind: "stage", name, detail,
      ms: Date.now() - Date.parse(startedAt), ok,
    });
  };
  event("P10 开始", `${sourceStage} 失败分析`);
  // 克隆上下文仅供 P10 路由/事件；盘上的 current 始终保留失败阶段。
  try {
    const scoped = configure({ ...rcx, run: { ...run, current: "P10" },
      failure: { stage: sourceStage, error, ...(errorInfo && typeof errorInfo === "object" ? { structuredError: errorInfo } : {}), ...identity },
      failureAnalysisArtifact: artifact, failureAnalysisCurrent: () => !!current(),
      failureAnalysisResponse: `${artifact}.response.json`,
      failureAnalysisTask: `delegate/P10-${analysisId}-task.md`,
      resumeFailureAnalysis: !!resume,
    });
    const result = await rcx.executors.P10(scoped);
    const latest = current();
    if (!latest) return;
    const st = latest.stages.P10;
    st.finishedAt = new Date().toISOString();
    st.artifact = result?.artifact || null;
    if (result?.external) {
      st.status = "awaiting_review";
      st.external = true;
      st.responseArtifact = scoped.failureAnalysisResponse;
      st.summary = result.summary || "等待外部失败分析";
    } else {
      const text = result?.artifact && readArtifact(runDir, result.artifact);
      const report = text && JSON.parse(text);
      if (!report?.category) throw new Error("P10 未生成有效失败分析报告");
      const out = { ...report, ...identity };
      writeArtifact(runDir, artifact, JSON.stringify(out, null, 2));
      writeArtifact(runDir, "09-failure-analysis.json", JSON.stringify(out, null, 2));
      st.status = "approved";
      st.artifact = "09-failure-analysis.json";
      st.summary = result.summary || `${out.category}→${out.action}`;
      latest.failureAnalysis = { category: out.category, detail: out.detail || "", action: out.action || "",
        ...identity, degraded: !!out.degraded, artifact: st.artifact, at: st.finishedAt };
    }
    saveRun(runDir, latest);
    event(st.status === "awaiting_review" ? "P10 等待外部分析" : "P10 完成", st.summary);
    Object.assign(rcx.run, latest);
    return result;
  } catch (cause) {
    const latest = current();
    if (!latest) return;
    const st = latest.stages.P10;
    st.status = "failed";
    st.finishedAt = new Date().toISOString();
    st.error = String(cause?.message || cause);
    // 补全③：P10 自身失败也落结构化错误（LLM 错误自带 code/llmCause/logRefs，UI 徽标与留档引用可见）；
    // 源阶段失败的结构化错误已在 09 报告 evidence.structuredError 保留，此处记录的是 P10 自身的异常
    st.errorInfo = { ...structuredErrorOf(cause, "P10", st), sourceStage: sourceStage || null };
    saveRun(runDir, latest);
    event("P10 分析失败", st.error, false);
    Object.assign(rcx.run, latest);
    throw cause;
  }
}
