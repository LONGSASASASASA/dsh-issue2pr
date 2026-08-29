// lib/stages/p6-coder.js — 需求 5：多智能体协同代码优化
// builtin：Planner 派单 → 并行 Coder（superpowers 纪律：TDD/最小 diff/verify-before-claim）→ Reviewer 门控
// session：生成任务包，交给 DSH 会话（真 workflow + superpowers skills）
import { writeArtifact, readArtifact } from "../store.js";
import { requireArtifact, readRepoFile, logEvent } from "./helpers.js";
import { slugify, timestamp } from "../store.js";

const CODER_SYSTEM = [
  "你是 Coder Sub-Agent，纪律（superpowers）：",
  "1. TDD：涉及行为修改时先产出失败测试，再产出实现；",
  "2. 只输出 unified diff（--- a/ +++ b/），最小修改范围，永不整文件覆盖；",
  "3. 外科手术式改动：不顺手改进相邻代码；",
  "4. verify-before-claim：不得声称未验证的结论。",
].join("\n");

export default async function execute(rcx) {
  const graph = requireArtifact(rcx.runDir, "05-task-graph.json", readArtifact);

  if (rcx.p6Mode === "session") {
    const task = [
      "# P6 会话任务包（交 DSH 会话执行：workflow + superpowers）", "",
      "## TaskGraph", "```json", graph, "```", "",
      "## 要求", "- 用 workflow 工具 fan-out：planner → 并行 coder → reviewer；",
      "- 每节点产出 unified diff 到本目录 patches/；", "- 完成后写 coder-report.json 并通过人工复核门。",
    ].join("\n");
    writeArtifact(rcx.runDir, "06-implementation/session-task.md", task);
    logEvent(rcx, { kind: "info", name: "session 模式：任务包已生成",
      detail: "06-implementation/session-task.md 已写入；等 DSH 会话产出 patches/ 后，在复核门通过再进 P7" });
    return { artifact: "06-implementation/session-task.md", summary: "等待会话执行" };
  }

  // 1) Planner 派单
  const plan = await rcx.llm.completeJson({
    system: "你是多智能体 Planner。把 TaskGraph 节点派给 Coder，每单指定目标文件。只输出 JSON。",
    user: `【TaskGraph】\n${graph}\n\n【输出契约】{"assignments":[{"node":"T1","file":"相对路径","note":"实现要点"}]}`,
    required: ["assignments"],
  });
  logEvent(rcx, { kind: "info", name: "Planner 派单 " + plan.assignments.length + " 个任务",
    detail: plan.assignments.map((a) => a.node + " → " + a.file).join("；") });

  // 2) 并行 Coder
  const patches = await Promise.all(plan.assignments.map(async (a, i) => {
    const current = readRepoFile(rcx.repoDir, a.file);
    const diff = await rcx.llm.complete({
      system: CODER_SYSTEM,
      user: `【任务 ${a.node}】${a.note || ""}\n【当前文件 ${a.file}】\n\`\`\`\n${current}\n\`\`\`\n【打回意见】${rcx.reviewComment || "无"}\n只输出 unified diff。`,
    });
    const rel = `06-implementation/patches/${String(i + 1).padStart(4, "0")}-${slugify(a.node + "-" + a.file).slice(0, 40)}.diff`;
    writeArtifact(rcx.runDir, rel, diff);
    logEvent(rcx, { kind: "tool", name: "Coder " + a.node + " 产出 diff", detail: rel + "（" + diff.length + " 字）" });
    return { node: a.node, file: a.file, patch: rel, content: diff };
  }));

  // 3) Reviewer 门控（附带 diff 文本，杜绝盲审——Task 7 修复）
  const review = await rcx.llm.completeJson({
    system: "你是 Reviewer Sub-Agent。审 diff：范围是否最小、是否越权、是否遗漏调用方。只输出 JSON。",
    user: `【diff 清单】\n${patches.map((p) => `### ${p.patch}\n\n${(p.content || "").slice(0, 4000)}\n`).join("\n")}\n【输出契约】{"verdict":"pass|fail","notes":"理由"}`,
    required: ["verdict"],
  });
  logEvent(rcx, { kind: "info", name: "Reviewer 门控 " + review.verdict, detail: review.notes || "", ok: review.verdict === "pass" });
  if (review.verdict !== "pass") throw new Error("P6 Reviewer 拒绝: " + (review.notes || "无理由"));

  const report = { mode: "builtin", planner: plan, patches, reviewer: review, discipline: ["tdd", "minimal-diff", "verify-before-claim"], at: timestamp() };
  writeArtifact(rcx.runDir, "06-implementation/coder-report.json", JSON.stringify(report, null, 2));
  return { artifact: "06-implementation/", summary: `${patches.length} 份 diff，reviewer pass` };
}