// lib/stages/index.js — 阶段注册表（后续任务逐步补齐）
import p1 from "./p1-issue-analyzer.js";
import p2 from "./p2-search.js";
import p3 from "./p3-code-understanding.js";
import p4 from "./p4-hypothesis.js";
import p5 from "./p5-planner.js";
import p6 from "./p6-coder.js";
import p7 from "./p7-patch.js";
import p8 from "./p8-test-runner.js";
import p10 from "./p10-failure.js";

export function buildExecutors() {
  return { P1: p1, P2: p2, P3: p3, P4: p4, P5: p5, P6: p6, P7: p7, P8: p8, P10: p10 };
}