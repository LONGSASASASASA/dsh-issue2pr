// lib/infra/ids.js — 调用身份生成（修复清单 20260916-001 TASK-01）
// 三级身份：stageExecutionId（一次阶段执行，重跑换新）→ callId（一次逻辑 LLM 调用，
// 重试共享）→ attemptId（一次真实模型请求）。retryOf 指向前一个 attemptId，
// 阶段重跑与模型重试由此区分；委外执行的 captureId 与 stageExecutionId 在 run.json 关联。
import { randomUUID } from "node:crypto";

const suffix = () => randomUUID().replace(/-/g, "").slice(0, 12);
const stamp = (d = new Date()) => {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};

// 形如 P6-20260916-143005-1a2b3c4d5e6f：阶段前缀便于人读与 grep，随机后缀保证同秒重跑不碰撞
export function newStageExecutionId(stageId, now = new Date()) {
  return `${stageId}-${stamp(now)}-${suffix()}`;
}
export function newCallId() { return `call-${suffix()}`; }
export function newAttemptId() { return `attempt-${suffix()}`; }
