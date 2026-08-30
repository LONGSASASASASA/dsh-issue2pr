// lib/stages/p6-coder.js — 需求 5：多智能体协同代码优化
// builtin：Planner 派单 → 并行 Coder（superpowers 纪律：TDD/最小 diff/verify-before-claim）→ Reviewer 门控
// session：生成任务包，交给 DSH 会话（真 workflow + superpowers skills）
// claude：生成任务包后自动委外执行（执行细节在 lib/delegate/executors/）；产物就绪进正常复核门，失败回退"等人工会话"
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { writeArtifact, readArtifact } from "../core/store.js";
import { requireArtifact, readRepoFile, logEvent } from "./helpers.js";
import { slugify, timestamp } from "../core/store.js";
import { saveRun, sessionPatchesReady } from "../core/pipeline.js";
import { sysOf, paramsOf } from "../core/stageConfig.js";
import claudeCodeExecutor, { resolveClaudeBin } from "../delegate/executors/claude-code.js";
import { authRelayActive } from "../delegate/executors/claude-auth.js";
import { loadRelayToken } from "../infra/relayAuth.js";

function countPatches(runDir) {
  const dir = join(runDir, "06-implementation", "patches");
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".diff")).length : 0;
}

function buildSessionTask(graph) {
  return [
    "# P6 会话任务包（交外部编码会话执行：workflow + superpowers）", "",
    "## TaskGraph", "```json", graph, "```", "",
    "## 要求", "- 用 workflow 工具 fan-out：planner → 并行 coder → reviewer；",
    "- 每节点产出 unified diff 到本目录 patches/；", "- 完成后写 coder-report.json 并通过人工复核门。",
  ].join("\n");
}

// claude headless（--output-format json）统计摘要：耗时/轮次/费用（无统计返回空串）
function statsSummary(s) {
  if (!s) return "";
  const parts = [];
  if (s.durationMs != null) parts.push("耗时 " + Math.round(s.durationMs / 60000) + " 分钟");
  if (s.turns != null) parts.push(s.turns + " 轮");
  if (s.costUsd != null) parts.push("$" + Number(s.costUsd).toFixed(2));
  return parts.length ? "（" + parts.join(" · ") + "）" : "";
}

// claude 模式主流程：委托 → 等待 → 按产物验收（patches/report 是硬标准，退出码仅参考）
async function delegateClaude(rcx, graph) {
  const { runDir, repoDir } = rcx;
  const patchesAbs = join(runDir, "06-implementation", "patches");
  const taskAbs = join(runDir, "06-implementation", "session-task.md");
  const reportAbs = join(runDir, "06-implementation", "coder-report.json");
  let total = null;
  try { total = JSON.parse(graph).nodes.length; } catch { /* 任务总数仅用于进度展示 */ }
  const prompt = [
    "# 角色", "你是 issue2pr 流水线在 P6 阶段委托的外部编码会话（Claude Code）。按任务包完成代码修复并产出标准补丁。", "",
    "# 输入", "- 目标仓库（当前工作目录）：" + repoDir,
    "- 任务包：" + taskAbs + " —— 先完整阅读，严格按其中 TaskGraph 的节点与依赖执行", "",
    "# 产物契约（流水线据此验收，缺一不可）",
    "1. 按依赖顺序逐节点实施，直接修改目标仓库文件（最小 diff、不越权重构、不新增无关文件、禁止 git commit）；",
    "2. 每完成一个节点，导出该节点补丁并恢复工作区：",
    "   git add -A",
    '   git diff --cached --binary > "' + patchesAbs + '\\0001-T1.diff"  ← 依次 0001/0002… 按节点编号',
    "   git reset -q && git checkout -- . && git clean -fdq   ← 必须保持工作区干净（P7 会重新应用这些 diff）",
    "3. 全部节点完成后写报告 " + reportAbs + "（patch 路径必须是相对 run 目录的全路径，与下方一致）：",
    '   {"mode":"claude-code","patches":[{"node":"T1","patch":"06-implementation/patches/0001-T1.diff","note":"一句话"}],"summary":"总体说明"}', "",
    "完成后只输出一行总结。",
  ].join("\n");

  const pm = paramsOf(rcx, "P6");
  const bin = resolveClaudeBin(pm.claudeBin);
  // 认证中转：preset/baseUrl 来自项目 params，token 全局存 relay-auth.json（门禁卡片同源，一套凭据多项目复用）
  const auth = { preset: pm.claudeAuthPreset || "none", baseUrl: pm.claudeBaseUrl || "", model: pm.claudeRelayModel || "", token: loadRelayToken(rcx.dataRoot) };
  // 超时优先级：阶段配置（params.claudeTimeoutMin）> 环境变量 ISSUE2PR_CLAUDE_TIMEOUT_MS > 默认 2 小时
  const claudeTimeoutMs = (Number(pm.claudeTimeoutMin) > 0 ? Number(pm.claudeTimeoutMin) * 60000 : 0)
    || Number(process.env.ISSUE2PR_CLAUDE_TIMEOUT_MS) || 2 * 60 * 60 * 1000;
  // 执行状态落盘 run.json（UI 3s 轮询可见；rcx.run 是驱动循环持有的活引用，advance 后续 saveRun 会保留该字段）
  const setExec = (patch) => {
    if (!rcx.run) return;
    rcx.run.externalExec = Object.assign({ executor: claudeCodeExecutor.id }, rcx.run.externalExec, patch);
    saveRun(runDir, rcx.run);
  };
  setExec({ status: "running", bin, startedAt: new Date().toISOString() });
  logEvent(rcx, { kind: "tool", name: "委托 Claude Code 执行任务包",
    detail: "cwd=" + repoDir + " · bin=" + bin + " · auth=" + (authRelayActive(auth) ? auth.preset : "none") });

  // 过程可见：等待期间周期采样 patch 数，变化即记过程事件（UI 阶段详情"过程"面板实时可看）
  let lastN = 0;
  const progressTimer = setInterval(() => {
    const n = countPatches(runDir);
    if (n !== lastN) {
      lastN = n;
      const latest = existsSync(patchesAbs) ? readdirSync(patchesAbs).filter((f) => f.endsWith(".diff")).sort().slice(-1)[0] : "";
      logEvent(rcx, { kind: "tool", name: "Claude Code 进度 " + n + (total ? "/" + total : ""),
        detail: latest ? "最新产出 " + latest : "" });
    }
  }, rcx.externalProgressIntervalMs || 30000);
  let r;
  try {
    // spawn/stream-json 解析/超时杀树/认证 env/实时日志都在执行器内；rcx.spawnExternal 仍是测试注入口
    r = await claudeCodeExecutor.run({
      rcx, bin, repoDir, runDir, prompt, timeoutMs: claudeTimeoutMs, params: pm, auth,
      logPath: join(runDir, "06-implementation", "external-exec.log"), // 实时逐行落盘（重启可续读）
    });
  } finally {
    clearInterval(progressTimer);
  }

  // stats/sessionId/failure 已由执行器归一（stream-json result 帧 + 旧 JSON 兜底），阶段层直接消费
  const stats = r.stats || null;

  if (sessionPatchesReady(runDir)) {
    setExec({ status: "done", exitCode: r.code, stats, ...(r.sessionId ? { sessionId: r.sessionId } : {}), finishedAt: new Date().toISOString() });
    logEvent(rcx, { kind: "tool", name: "Claude Code 执行完成",
      detail: countPatches(runDir) + " 份 patch 已就绪（exit=" + r.code + "）" + statsSummary(stats) });
    return { artifact: "06-implementation/", summary: "Claude Code 已执行任务包：" + countPatches(runDir) + " 份 patch + report，等待人工复核" + statsSummary(stats) };
  }

  // 失败分类在执行器内统一（result.is_error / 0-token / 超时 / spawn / 退出码），hint 引导回项目页门禁
  const failure = r.failure || { kind: "exit", message: "退出码 " + r.code + "，未产出补丁", hint: "" };
  const reason = failure.message + (failure.hint ? "；" + failure.hint : "");
  setExec({ status: failure.kind === "spawn" ? "skipped" : "failed", exitCode: r.code, stats, ...(r.sessionId ? { sessionId: r.sessionId } : {}), error: String(reason).slice(0, 500), finishedAt: new Date().toISOString() });
  logEvent(rcx, { kind: "tool", name: "Claude Code 执行未产出补丁", detail: String(reason).slice(0, 500), ok: false });
  // 回退等人工：保持 external 语义（UI 显示"等外部执行"并拦截空产物 approve），人可接管 session-task.md
  return { artifact: "06-implementation/session-task.md", summary: "Claude Code 执行未成功（" + String(reason).slice(0, 200) + "），回退等待人工会话", external: true };
}

export default async function execute(rcx) {
  const graph = requireArtifact(rcx.runDir, "05-task-graph.json", readArtifact);

  if (rcx.p6Mode === "session" || rcx.p6Mode === "claude") {
    writeArtifact(rcx.runDir, "06-implementation/session-task.md", buildSessionTask(graph));
    if (rcx.p6Mode === "session") {
      logEvent(rcx, { kind: "info", name: "session 模式：任务包已生成",
        detail: "06-implementation/session-task.md 已写入；等 DSH 会话产出 patches/ 后，在复核门通过再进 P7" });
      // external：本阶段只产出任务包，实施由外部 DSH 会话完成（advance 据此显示"等外部执行"并拦截空 patches 的 approve）
      return { artifact: "06-implementation/session-task.md", summary: "任务包已生成，等待外部 DSH 会话执行", external: true };
    }
    return await delegateClaude(rcx, graph);
  }

  // 1) Planner 派单
  const plan = await rcx.llm.completeJson({
    system: sysOf(rcx, "P6", "planner"),
    user: `【TaskGraph】\n${graph}\n\n【输出契约】{"assignments":[{"node":"T1","file":"相对路径","note":"实现要点"}]}`,
    required: ["assignments"],
  });
  logEvent(rcx, { kind: "info", name: "Planner 派单 " + plan.assignments.length + " 个任务",
    detail: plan.assignments.map((a) => a.node + " → " + a.file).join("；") });

  // 2) 并行 Coder
  const patches = await Promise.all(plan.assignments.map(async (a, i) => {
    const current = readRepoFile(rcx.repoDir, a.file);
    const diff = await rcx.llm.complete({
      system: sysOf(rcx, "P6", "coder"),
      user: `【任务 ${a.node}】${a.note || ""}\n【当前文件 ${a.file}】\n\`\`\`\n${current}\n\`\`\`\n【打回意见】${rcx.reviewComment || "无"}\n只输出 unified diff。`,
    });
    const rel = `06-implementation/patches/${String(i + 1).padStart(4, "0")}-${slugify(a.node + "-" + a.file).slice(0, 40)}.diff`;
    writeArtifact(rcx.runDir, rel, diff);
    logEvent(rcx, { kind: "tool", name: "Coder " + a.node + " 产出 diff", detail: rel + "（" + diff.length + " 字）" });
    return { node: a.node, file: a.file, patch: rel, content: diff };
  }));

  // 3) Reviewer 门控（附带 diff 文本，杜绝盲审——Task 7 修复）
  const review = await rcx.llm.completeJson({
    system: sysOf(rcx, "P6", "reviewer"),
    user: `【diff 清单】\n${patches.map((p) => `### ${p.patch}\n\n${(p.content || "").slice(0, 4000)}\n`).join("\n")}\n【输出契约】{"verdict":"pass|fail","notes":"理由"}`,
    required: ["verdict"],
  });
  logEvent(rcx, { kind: "info", name: "Reviewer 门控 " + review.verdict, detail: review.notes || "", ok: review.verdict === "pass" });
  if (review.verdict !== "pass") throw new Error("P6 Reviewer 拒绝: " + (review.notes || "无理由"));

  const report = { mode: "builtin", planner: plan, patches, reviewer: review, discipline: ["tdd", "minimal-diff", "verify-before-claim"], at: timestamp() };
  writeArtifact(rcx.runDir, "06-implementation/coder-report.json", JSON.stringify(report, null, 2));
  return { artifact: "06-implementation/", summary: `${patches.length} 份 diff，reviewer pass` };
}
