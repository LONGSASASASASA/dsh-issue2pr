// P8 的实时输出与执行快照；不把高频输出写入 run.json。
import { appendFileSync, readFileSync } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { writeArtifact } from "../core/store.js";

export const TEST_ACTIVITY_PATH = "08-test-activity.json";
export const TEST_OUTPUT_PATH = "08-test-output.txt";
const owners = new Map(), executions = new Map(), failedExecutions = new Map();
const SNAPSHOT_FIELDS = ["version", "status", "captureId", "stageStartedAt", "command", "startedAt", "finishedAt", "updatedAt",
  "executionStatus", "lastOutputAt", "outputBytes", "exitCode", "signal", "outputPath", "outputReady", "logError", "environment", "error"];
const validAt = value => typeof value === "string" && Number.isFinite(Date.parse(value));
const contained = (base, path) => {
  const rel = relative(base, path);
  return rel && rel !== ".." && !rel.startsWith("../") && !rel.startsWith("..\\") && !isAbsolute(rel);
};

export function createTestActivity({ runDir, command, stageStartedAt, flushMs = 500 }) {
  const key = resolve(runDir), owner = Symbol("P8"), captureId = randomUUID();
  const time = () => new Date().toISOString();
  const state = {
    version: 1, status: "available", captureId, stageStartedAt: stageStartedAt || time(), command,
    startedAt: time(), finishedAt: null, updatedAt: time(), executionStatus: "running",
    lastOutputAt: null, outputBytes: 0, exitCode: null, signal: null, outputPath: TEST_OUTPUT_PATH, outputReady: false,
  };
  let timer = null, dirty = true, finalizing = false, disposed = false, failures = 0;
  let child = null, tail = "", sawRunFile = false, ownershipError = null;
  const owned = () => {
    ownershipError = null;
    if (owners.get(key) !== owner) return false;
    try {
      const stage = JSON.parse(readFileSync(resolve(key, "run.json"), "utf8"))?.stages?.P8;
      sawRunFile = true;
      // pending/新 startedAt 表示已重置；stopped 仍允许保存真实取消结果。
      return stage?.startedAt === state.stageStartedAt && stage?.status !== "pending";
    } catch (error) {
      // 裸阶段单测可没有 run.json；真实任务一旦存在，删除/损坏时不再写旧执行。
      if (error?.code !== "ENOENT") ownershipError = error;
      return error?.code === "ENOENT" && !sawRunFile;
    }
  };
  const snapshot = () => ({ ...state });
  owners.set(key, owner);
  failedExecutions.delete(key);
  executions.set(key, { captureId, stageStartedAt: state.stageStartedAt, snapshot, child: () => child });

  const fail = error => {
    if (!state.logError) state.logError = "测试输出或状态保存失败：" + String(error?.message || error).slice(0, 1400);
    state.updatedAt = time(); dirty = true;
  };
  const schedule = (ms = flushMs) => {
    if (timer || !owned() || disposed || finalizing || !dirty) return;
    timer = setTimeout(flush, Math.max(1, ms));
    timer.unref?.();
  };
  const flush = () => {
    if (timer) { clearTimeout(timer); timer = null; }
    if (!owned() || disposed || !dirty) return false;
    try {
      writeArtifact(key, TEST_ACTIVITY_PATH, JSON.stringify(state) + "\n");
      dirty = false; failures = 0;
      return true;
    } catch (error) {
      // Windows 的临时文件占用可能导致 rename 失败。即便后续没有输出也继续重试。
      failures = Math.min(failures + 1, 6);
      schedule(Math.min(5000, Math.max(100, flushMs) * (2 ** (failures - 1))));
      return false;
    }
  };
  try {
    // 原子替换旧日志后再启动命令，本轮无输出也不会显示上轮内容。
    if (!owned()) throw new Error("无法确认当前 P8 执行身份，尚未初始化本轮输出");
    writeArtifact(key, TEST_OUTPUT_PATH, "");
    state.outputReady = true;
  } catch (error) {
    fail(error); state.executionStatus = "failed"; state.finishedAt = time();
  }
  flush();

  return {
    captureId, snapshot, owned, flush, fail,
    setChild(value) { child = value; },
    setEnvironment(value) { state.environment = value; dirty = true; schedule(); },
    get tail() { return tail; },
    append(text, { observed = true } = {}) {
      if (disposed || finalizing || !text) return;
      if (!owned()) {
        // 身份文件暂时不可读时不能冒险写旧路径；明确记录缺失，恢复后也不假报完整。
        if (ownershipError) { fail(ownershipError); schedule(); }
        return;
      }
      state.updatedAt = time();
      if (observed) state.lastOutputAt = state.updatedAt;
      tail = (tail + text).slice(-4000);
      try {
        // 不复用 exec 回调的整份缓存，避免末尾重复写入 stdout/stderr。
        appendFileSync(resolve(key, TEST_OUTPUT_PATH), text, "utf8");
        state.outputBytes += Buffer.byteLength(text, "utf8");
      } catch (error) { fail(error); }
      dirty = true; schedule();
    },
    async finish({ executionStatus, exitCode = null, signal = null, error } = {}) {
      if (!owned() || disposed) return false;
      finalizing = true;
      state.executionStatus = state.logError ? "failed" : executionStatus;
      state.exitCode = Number.isInteger(exitCode) ? exitCode : null;
      state.signal = typeof signal === "string" ? signal : null;
      if (error) state.error = String(error);
      state.finishedAt = time(); state.updatedAt = state.finishedAt; dirty = true;
      // 有限收尾；持续失败保留内存快照并明确标记，不能虚假汇报测试通过。
      for (let attempt = 0; attempt < 4 && owned(); attempt++) {
        if (flush()) return true;
        if (attempt < 3) await delay(50 * (2 ** attempt));
      }
      if (owned()) {
        fail(new Error("08-test-activity.json 无法保存"));
        state.executionStatus = "failed";
      }
      return false;
    },
    dispose() {
      disposed = true;
      if (timer) { clearTimeout(timer); timer = null; }
      if (owners.get(key) === owner) owners.delete(key);
      if (executions.get(key)?.captureId === captureId) {
        executions.delete(key);
        // 仅持久化故障需要内存兜底。正常结束从磁盘读取，释放闭包与子进程。
        if (state.logError) {
          const saved = snapshot();
          failedExecutions.set(key, { captureId, stageStartedAt: state.stageStartedAt, snapshot: () => saved, child: () => null });
          while (failedExecutions.size > 32) failedExecutions.delete(failedExecutions.keys().next().value);
        }
      }
      child = null;
    },
  };
}

function validSnapshot(value, stageStartedAt) {
  return value && value.version === 1 && value.status === "available"
    && value.stageStartedAt === stageStartedAt && validAt(value.startedAt) && validAt(value.updatedAt)
    && typeof value.captureId === "string" && value.captureId.length > 0 && value.captureId.length <= 128
    && typeof value.command === "string" && value.command.length <= 32768
    && ["running", "completed", "failed", "timeout", "cancelled", "spawn_failed", "environment_error"].includes(value.executionStatus)
    && (value.finishedAt === null || validAt(value.finishedAt))
    && (value.lastOutputAt === null || validAt(value.lastOutputAt))
    && Number.isSafeInteger(value.outputBytes) && value.outputBytes >= 0
    && (value.exitCode === null || Number.isInteger(value.exitCode))
    && (value.signal === null || typeof value.signal === "string" && value.signal.length <= 100)
    && value.outputPath === TEST_OUTPUT_PATH
    && (value.outputReady === undefined || typeof value.outputReady === "boolean")
    && (value.logError === undefined || typeof value.logError === "string" && value.logError.length <= 1600);
}

export async function readTestActivity(runDir, run) {
  const stageStartedAt = run?.stages?.P8?.startedAt, key = resolve(runDir);
  const unavailable = (reasonCode, reason) => ({ status: "unavailable", reasonCode, reason, outputPath: TEST_OUTPUT_PATH });
  if (!validAt(stageStartedAt) || run?.stages?.P8?.status === "pending") return unavailable("missing", "当前阶段尚未开始采集测试活动");
  const current = executions.get(key) || failedExecutions.get(key);
  let value, file;
  // 当前宿主的内存状态与子进程来自同一 capture。磁盘故障时仍能显示真实故障。
  if (current?.stageStartedAt === stageStartedAt) value = current.snapshot();
  else {
    try {
      const path = resolve(key, TEST_ACTIVITY_PATH);
      if (!contained(await realpath(key), await realpath(path))) return unavailable("invalid", "测试活动文件路径无效");
      file = await open(path, "r");
      const st = await file.stat();
      if (!st.isFile() || st.size > 64 * 1024) return unavailable("invalid", "测试活动文件格式无效");
      const bytes = Buffer.alloc(st.size);
      const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
      value = JSON.parse(bytes.subarray(0, bytesRead).toString("utf8"));
    } catch (error) {
      return unavailable(error?.code === "ENOENT" ? "missing" : error instanceof SyntaxError ? "invalid" : "read_error", "当前执行未提供可读取的测试活动");
    } finally { await file?.close().catch(() => {}); }
  }
  if (value?.stageStartedAt !== stageStartedAt) return unavailable("stale", "测试活动来自上次执行，等待本轮数据");
  if (!validSnapshot(value, stageStartedAt)) return unavailable("invalid", "测试活动文件格式无效");
  const child = current?.captureId === value.captureId ? current.child() : null;
  const snapshot = Object.fromEntries(SNAPSHOT_FIELDS.filter(name => value[name] !== undefined).map(name => [name, value[name]]));
  return { ...snapshot, process: { state: child ? child.exitCode != null || child.signalCode ? "exited" : "alive" : "unknown", checkedAt: new Date().toISOString() } };
}
