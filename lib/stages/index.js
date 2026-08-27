// lib/stages/index.js — 阶段注册表（后续任务逐步补齐）
import p1 from "./p1-issue-analyzer.js";
import p2 from "./p2-search.js";

export function buildExecutors() {
  return { P1: p1, P2: p2 };
}