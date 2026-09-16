// tests/unit/ids.test.js — 调用身份生成（修复清单 20260916-001 TASK-01）
import { test } from "node:test";
import assert from "node:assert/strict";
import { newStageExecutionId, newCallId, newAttemptId } from "../../lib/infra/ids.js";

test("newStageExecutionId：阶段前缀 + 时间戳 + 随机后缀；同秒重跑不碰撞", () => {
  const now = new Date("2026-09-16T14:30:05");
  const a = newStageExecutionId("P6", now);
  const b = newStageExecutionId("P6", now);
  assert.match(a, /^P6-\d{8}-\d{6}-[0-9a-f]{12}$/);
  assert.equal(a.slice(0, 11), "P6-20260916", "时间戳段稳定（人读可定位）");
  assert.notEqual(a, b, "同秒两次执行身份必须不同（随机后缀）");
  assert.notEqual(newStageExecutionId("P6", now), newStageExecutionId("P9", now), "阶段前缀区分来源");
});

test("newCallId / newAttemptId：前缀区分语义且不重复", () => {
  const ids = [newCallId(), newCallId(), newAttemptId(), newAttemptId()];
  assert.equal(new Set(ids).size, 4);
  for (const id of ids) assert.match(id, /^(call|attempt)-[0-9a-f]{12}$/);
});
