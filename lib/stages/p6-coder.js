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
import { resolveClaudeBin } from "../delegate/executors/claude-code.js";
import { authRelayActive } from "../delegate/executors/claude-auth.js";
import { loadRelayToken } from "../infra/relayAuth.js";
import { resolveExecutor } from "../delegate/executors/index.js";
import { looksLikeDiff, verifyDelegateResult } from "../delegate/delegateVerify.js";
import { llmError } from "../infra/llm.js";

const BUILTIN_CODER_CONCURRENCY = 2;

function countPatches(runDir) {
  const dir = join(runDir, "06-implementation", "patches");
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".diff")).length : 0;
}

// 多本 journal 的最差完整性（errorInfo.logIntegrity 只保留一个总体状态）：
// corrupt > write_failed > partial > open > complete；未知值按 complete 处理，不放大
const INTEGRITY_SEVERITY = { complete: 0, open: 1, unavailable: 2, partial: 3, write_failed: 4, corrupt: 5 };
function worstIntegrity(list) {
  let worst = "complete";
  for (const v of list) worst = (INTEGRITY_SEVERITY[v] || 0) > INTEGRITY_SEVERITY[worst] ? v : worst;
  return worst;
}

function buildSessionTask(graph) {
  return [
    "# P6 会话任务包（交外部编码会话执行：workflow + superpowers）", "",
    "## TaskGraph", "```json", graph, "```", "",
    "## 要求", "- 用 workflow 工具 fan-out：planner → 并行 coder → reviewer；",
    "- 每节点记录状态 patched / no_change / failed；",
    "- patched 才产出 unified diff 到本目录 patches/；no_change 不生成 .diff，必须说明原因；",
    "- failed 记录失败原因；完成后写 coder-report.json 并通过人工复核门。",
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

// 委外执行通用主流程：执行正常结束且完整产物验收通过，才标记完成。
async function delegateExternal(rcx, executor) {
  const { runDir, repoDir } = rcx;
  const patchesAbs = join(runDir, "06-implementation", "patches");
  const taskAbs = join(runDir, "06-implementation", "session-task.md");
  const reportAbs = join(runDir, "06-implementation", "coder-report.json");
  const prompt = [
    "# 角色", "你是 issue2pr 流水线在 P6 阶段委托的外部编码会话（" + executor.label + "）。按任务包完成代码修复并产出标准补丁。", "",
    "# 输入", "- 目标仓库（当前工作目录）：" + repoDir,
    "- 任务包：" + taskAbs + " —— 先完整阅读，严格按其中 TaskGraph 的节点与依赖执行", "",
    "# 产物契约（流水线据此验收，缺一不可）",
    "1. 按依赖顺序逐节点执行；需要代码变更时直接修改目标仓库文件（最小 diff、不越权重构、不新增无关文件、禁止 git commit）；",
    "2. 每个节点必须记录一种结果：patched / no_change / failed。no_change 不生成 .diff，必须写 reason；failed 必须写 reason；",
    "3. 仅 patched 节点导出该节点补丁并恢复工作区：",
    "   git add -A",
    '   git diff --cached --binary > "' + patchesAbs + '\\0001-T1.diff"  ← 依次 0001/0002… 按节点编号',
    "   git reset -q && git checkout -- . && git clean -fdq   ← 必须保持工作区干净（P7 会重新应用这些 diff）",
    "4. 全部节点完成后写报告 " + reportAbs + "（patched 的 patch 路径必须是相对 run 目录的全路径）：",
    '   {"mode":"' + executor.id + '","tasks":[{"node":"T1","status":"patched","patch":"06-implementation/patches/0001-T1.diff","reason":"实现修复"},{"node":"T2","status":"no_change","reason":"仅分析或验证，无代码修改"}],"summary":"总体说明"}', "",
    "完成后只输出一行总结。",
  ].join("\n");

  const pm = paramsOf(rcx, "P6");
  const isClaude = executor.id === "claude-code";
  const execLabel = isClaude ? "Claude Code" : executor.label;
  // claude-code 专属：bin 解析 + 认证中转（preset/baseUrl/model 来自项目 params，token 全局存 relay-auth.json）
  const bin = isClaude ? resolveClaudeBin(pm.claudeBin) : "";
  const auth = isClaude
    ? { preset: pm.claudeAuthPreset || "none", baseUrl: pm.claudeBaseUrl || "", model: pm.claudeRelayModel || "", token: loadRelayToken(rcx.dataRoot) }
    : null;
  // 超时优先级：阶段配置（claude/dsh 各自的 TimeoutMin param）> 环境变量（仅 claude）> 默认 2 小时
  const cfgTimeoutMin = isClaude ? Number(pm.claudeTimeoutMin) : Number(pm.dshTimeoutMin);
  const timeoutMs = (cfgTimeoutMin > 0 ? cfgTimeoutMin * 60000 : 0)
    || (isClaude ? Number(process.env.ISSUE2PR_CLAUDE_TIMEOUT_MS) : 0) || 2 * 60 * 60 * 1000;
  // 执行状态落盘 run.json（UI 3s 轮询可见；rcx.run 是驱动循环持有的活引用，advance 后续 saveRun 会保留该字段）
  const setExec = (patch) => {
    if (!rcx.run) return;
    rcx.run.externalExec = Object.assign({ executor: executor.id }, rcx.run.externalExec, patch);
    saveRun(runDir, rcx.run);
  };
  // 委外留档身份关联（TASK-01）：captureId 与本轮阶段执行绑定（runId/stage/stageExecutionId），
  // 读取端据此拒绝旧 capture 混入新一轮执行；session 模式无执行器，不参与。
  const reportsCapture = executor.id === "claude-code" || executor.id === "dsh-agent";
  const onCapture = reportsCapture ? (captureId) => setExec({ captureId,
    runId: rcx.run?.id || null, stage: "P6",
    stageStartedAt: rcx.run?.stages?.P6?.startedAt || null,
    stageExecutionId: rcx.run?.stages?.P6?.stageExecutionId || null }) : null;
  setExec({ status: "running", ...(bin ? { bin } : {}), startedAt: new Date().toISOString() });
  logEvent(rcx, { kind: "tool", name: "委托 " + execLabel + " 执行任务包",
    detail: "cwd=" + repoDir + (bin ? " · bin=" + bin : "") + (auth ? " · auth=" + (authRelayActive(auth) ? auth.preset : "none") : "") });

  // 过程可见：等待期间周期采样 patch 数，变化即记过程事件（UI 阶段详情"过程"面板实时可看）
  let lastN = 0;
  const progressTimer = setInterval(() => {
    const n = countPatches(runDir);
    if (n !== lastN) {
      lastN = n;
      const latest = existsSync(patchesAbs) ? readdirSync(patchesAbs).filter((f) => f.endsWith(".diff")).sort().slice(-1)[0] : "";
      logEvent(rcx, { kind: "tool", name: execLabel + " patch 产出 " + n,
        detail: latest ? "最新产出 " + latest : "" });
    }
  }, rcx.externalProgressIntervalMs || 30000);
  let r;
  try {
    // 执行细节（spawn/流解析/超时回收/认证 env/日志）都在执行器内；rcx.spawnExternal 仍是测试注入口
    r = await executor.run({
      rcx, ...(bin ? { bin } : {}), repoDir, runDir, prompt, timeoutMs, params: pm, auth,
      ...(onCapture ? { onCapture } : {}),
      ...(isClaude ? { logPath: join(runDir, "06-implementation", "external-exec.log") } : {}), // claude 实时逐行落盘
      timelinePath: join(runDir, "06-implementation", "external-exec.timeline.log"), // 人读时间线（claude 实时 / dsh 事后）
    });
  } finally {
    clearInterval(progressTimer);
  }

  // stats/sessionId/failure 已由执行器归一（stream-json result 帧 + 旧 JSON 兜底），阶段层直接消费
  const stats = r.stats || null;

  const verification = await verifyDelegateResult(rcx, "P6");
  const failure = r.failure || (r.code !== 0
    ? { kind: "exit", message: "退出码 " + r.code, hint: "" } : null);
  if (!failure && verification.ok) {
    setExec({ status: "done", exitCode: r.code, stats, ...(r.sessionId ? { sessionId: r.sessionId } : {}), finishedAt: new Date().toISOString() });
    logEvent(rcx, { kind: "tool", name: execLabel + " 执行完成",
      detail: countPatches(runDir) + " 份 patch 已就绪（exit=" + r.code + "）"
        + (Array.isArray(r.toolCalls) && r.toolCalls.length ? " · 工具 " + r.toolCalls.length + " 次" : "") + statsSummary(stats) });
    return { artifact: "06-implementation/", summary: execLabel + " 已执行任务包：" + countPatches(runDir) + " 份 patch + report，等待人工复核" + statsSummary(stats) };
  }

  // 失败分类在执行器内统一（result.is_error / 0-token / 超时 / spawn / 退出码），hint 引导回项目页门禁
  const reason = [failure?.message, failure?.hint, ...verification.errors].filter(Boolean).join("；");
  // 补全①：委外失败留档引用贯通——records（异常判定与 start/exit 事件所在）排首，stdout/stderr 随后；
  // claude 三本 journal 带 dirs+各自完整性，dsh 单本带 dir+integrity；未建立的 journal 不引用、不虚构
  const journalRefsOf = (j) => {
    const logRefs = [], integrities = [];
    if (j && typeof j === "object") {
      if (j.dirs && typeof j.dirs === "object") {
        for (const key of ["records", "stdout", "stderr"]) {
          if (typeof j.dirs[key] === "string" && j.dirs[key]) {
            logRefs.push(j.dirs[key]);
            if (typeof j[key] === "string") integrities.push(j[key]);
          }
        }
      } else if (typeof j.dir === "string" && j.dir) {
        logRefs.push(j.dir);
        if (typeof j.integrity === "string") integrities.push(j.integrity);
      }
    }
    return { logRefs, logIntegrity: integrities.length ? worstIntegrity(integrities) : null };
  };
  const { logRefs: failLogRefs, logIntegrity: failLogIntegrity } = journalRefsOf(r.journal);
  setExec({ status: failure?.kind === "spawn" ? "skipped" : "failed", exitCode: r.code, stats, ...(r.sessionId ? { sessionId: r.sessionId } : {}), error: String(reason).slice(0, 500), finishedAt: new Date().toISOString() });
  logEvent(rcx, { kind: "tool", name: execLabel + " 执行未完成", detail: String(reason).slice(0, 500), ok: false,
    ...(failLogRefs.length ? { logDir: failLogRefs[0] } : {}), ...(failLogIntegrity ? { logIntegrity: failLogIntegrity } : {}) });
  // 有部分产物时显式失败，防止自动推进/监听把中断执行视为完成；保留补丁供接管。
  if (countPatches(runDir) || sessionPatchesReady(runDir)) {
    const failureError = new Error("P6 " + execLabel + " 执行未完成：" + reason + "；已有产物已保留，请补齐后重试");
    // 结构化附加字段由 advance 的 structuredErrorOf 透传进 st.errorInfo（logRefs/logIntegrity/failureKind）
    if (failure?.kind) failureError.failureKind = failure.kind;
    if (failLogRefs.length) failureError.logDirs = failLogRefs;
    if (failLogIntegrity) failureError.logIntegrity = failLogIntegrity;
    throw failureError;
  }
  // 回退等人工：保持 external 语义（UI 显示"等外部执行"并拦截空产物 approve），人可接管 session-task.md
  return { artifact: "06-implementation/session-task.md", summary: execLabel + " 执行未成功（" + String(reason).slice(0, 200) + "），回退等待人工会话", external: true };
}

export default async function execute(rcx) {
  const graph = requireArtifact(rcx.runDir, "05-task-graph.json", readArtifact);

  if (rcx.p6Mode === "session" || rcx.p6Mode === "claude" || rcx.p6Mode === "dsh") {
    writeArtifact(rcx.runDir, "06-implementation/session-task.md", buildSessionTask(graph));
    if (rcx.p6Mode === "session") {
      logEvent(rcx, { kind: "info", name: "session 模式：任务包已生成",
        detail: "06-implementation/session-task.md 已写入；等 DSH 会话产出 patches/ 后，在复核门通过再进 P7" });
      // external：本阶段只产出任务包，实施由外部 DSH 会话完成（advance 据此显示"等外部执行"并拦截空 patches 的 approve）
      return { artifact: "06-implementation/session-task.md", summary: "任务包已生成，等待外部 DSH 会话执行", external: true };
    }
    const executor = resolveExecutor(rcx.p6Mode === "dsh" ? "dsh-agent" : "claude-code");
    return await delegateExternal(rcx, executor);
  }

  // 1) Planner 派单
  const plan = await rcx.llm.completeJson({
    system: sysOf(rcx, "P6", "planner"),
    user: `【TaskGraph】\n${graph}\n\n【输出契约】{"assignments":[{"node":"T1","file":"相对路径","note":"实现要点"}]}`,
    required: ["assignments"],
    // TASK-05：派单契约 schema（node/file/note 齐全，file 为相对路径字符串）
    schema: {
      type: "object",
      required: ["assignments"],
      properties: {
        assignments: {
          type: "array",
          items: {
            type: "object",
            required: ["node", "file", "note"],
            properties: { node: { type: "string" }, file: { type: "string" }, note: { type: "string" } },
          },
        },
      },
    },
  });
  logEvent(rcx, { kind: "info", name: "Planner 派单 " + plan.assignments.length + " 个任务",
    detail: plan.assignments.map((a) => a.node + " → " + a.file).join("；") });

  // 2) 并行 Coder：固定小并发，避免 assignments 一次性全部打到模型端。
  const patches = [];
  for (let start = 0; start < plan.assignments.length; start += BUILTIN_CODER_CONCURRENCY) {
    const batch = await Promise.all(plan.assignments.slice(start, start + BUILTIN_CODER_CONCURRENCY).map(async (a, offset) => {
      const i = start + offset;
      const current = readRepoFile(rcx.repoDir, a.file);
      const diff = await rcx.llm.complete({
        system: sysOf(rcx, "P6", "coder"),
        user: `【任务 ${a.node}】${a.note || ""}\n【当前文件 ${a.file}】\n\`\`\`\n${current}\n\`\`\`\n【打回意见】${rcx.reviewComment || "无"}\n只输出 unified diff。`,
      });
      if (!looksLikeDiff(diff)) throw new Error("P6 Coder " + a.node + " 输出不是 unified diff");
      const rel = `06-implementation/patches/${String(i + 1).padStart(4, "0")}-${slugify(a.node + "-" + a.file).slice(0, 40)}.diff`;
      writeArtifact(rcx.runDir, rel, diff);
      logEvent(rcx, { kind: "tool", name: "Coder " + a.node + " 产出 diff", detail: rel + "（" + diff.length + " 字）" });
      return { node: a.node, file: a.file, patch: rel, content: diff };
    }));
    patches.push(...batch);
  }

  // 3) Reviewer 门控（附带 diff 文本，杜绝盲审——Task 7 修复）
  const review = await rcx.llm.completeJson({
    system: sysOf(rcx, "P6", "reviewer"),
    user: `【diff 清单】\n${patches.map((p) => `### ${p.patch}\n\n${(p.content || "").slice(0, 4000)}\n`).join("\n")}\n【输出契约】{"verdict":"pass|fail","notes":"理由"}`,
    required: ["verdict"],
    // TASK-05：门控契约 schema（verdict 限 pass|fail 枚举）
    schema: {
      type: "object",
      required: ["verdict"],
      properties: {
        verdict: { type: "string", enum: ["pass", "fail"] },
        notes: { type: "string" },
      },
    },
  });
  logEvent(rcx, { kind: "info", name: "Reviewer 门控 " + review.verdict, detail: review.notes || "", ok: review.verdict === "pass" });
  // TASK-07：有效业务结论 fail 是合法门禁结果，不是协议/调用错误——用
  // business_gate_failed 类别贯通，P10 据此走业务验收失败路径
  if (review.verdict !== "pass") {
    const gate = llmError("business_gate_failed", "P6 Reviewer 拒绝: " + (review.notes || "无理由"),
      { gate: "P6-reviewer", verdict: review.verdict, ...(review.notes ? { notes: String(review.notes).slice(0, 500) } : {}) });
    throw gate;
  }

  const report = { mode: "builtin", planner: plan, patches, reviewer: review, discipline: ["tdd", "minimal-diff", "verify-before-claim"], at: timestamp() };
  writeArtifact(rcx.runDir, "06-implementation/coder-report.json", JSON.stringify(report, null, 2));
  return { artifact: "06-implementation/", summary: `${patches.length} 份 diff，reviewer pass` };
}
