/**
 * dsh-issue2pr — node 半：REST API + 驱动循环（随 dsh web 同生共死）。
 * 路由与 spec §7 对齐：projects / runs（嵌套）/ review / rollback / tree / artifact。
 * 数据读写一律走 lib/core/store.js 与 lib/core/pipeline.js，不重复造轮子。
 */
import { join, relative, sep } from "node:path";
import { existsSync, readdirSync, mkdirSync, readFileSync } from "node:fs";
import { execFile } from "node:child_process";
import {
  defaultDataRoot, saveProject, loadProject, listProjects,
  createRun, runDirOf, readArtifact, listRunTree, rmTree, loadUiState, saveUiState,
  writeArtifact, recoverCorruptRun, timestamp,
  loadSettings, saveSettings, executionProject,
} from "./lib/core/store.js";
import { initRun, saveRun, loadRun, advance, applyReview, isGate, STAGES, MAIN_FLOW } from "./lib/core/pipeline.js";
import { verifyDelegateResult } from "./lib/delegate/delegateVerify.js";
import { makeLlm, routeInfo } from "./lib/infra/llm.js";
import { buildExecutors } from "./lib/stages/index.js";
import { rollbackLedger } from "./lib/stages/p7-patch.js";
import { stopExternals } from "./lib/delegate/executors/index.js";
import { resolveClaudeBin } from "./lib/delegate/executors/claude-code.js";
import { testDshGate } from "./lib/delegate/executors/dsh-agent.js";
import { loadRelayToken, saveRelayToken, relayAuthExists, relayAuthInfo } from "./lib/infra/relayAuth.js";
import { discoverAgents, testAgentGate, realRunWhich, realRunNpmPrefix, realRunVersion } from "./lib/delegate/agents.js";
import { readTriggerText, logEvent } from "./lib/stages/helpers.js";
import {
  loadConnections, upsertConnection, deleteConnection, normalizeConnection,
  matchConnection, gitCredentialSpec, redactUrl, maskToken, hostOf, CONNECTION_KINDS,
} from "./lib/infra/connections.js";
import { STAGE_DEFS, stageCfgOf, stageDelegated, delegateReady, purgeDelegateArtifacts, routeOverridesOf, DEFAULT_LLM_TIMEOUT_MS, DEFAULT_TEST_TIMEOUT_MS } from "./lib/core/stageConfig.js";
import { baseRepoDir, runRepoDir, ensureWorktree, removeWorktree, resetRepoClean } from "./lib/infra/repoState.js";
import { ASSISTANT_SYSTEM_HEAD, buildAssistantContext } from "./lib/assistant.js";

export const name = "dsh-issue2pr";
export const inject = ["webServer", "llm", "agentDefaultModel"];

// —— 测试注入（仅本插件测试用）：覆盖内部默认值 dataRoot / executors ——
let __testHooks = null;
export function __setTestHooks(hooks) { __testHooks = hooks || null; }

export function sendJson(res, code, obj) {
  const data = Buffer.from(JSON.stringify(obj), "utf8");
  // no-store：run 状态高频轮询，任何浏览器/代理缓存都会让停止/删除「看起来没生效」
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Content-Length": data.length, "Cache-Control": "no-store" });
  res.end(data);
}

export function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); } catch (e) { reject(e); } });
    req.on("error", reject);
  });
}

// —— 执行器解析：测试注入缺省 = 立即 approved 的空执行器；生产走 buildExecutors() ——
function executorsOf() {
  if (__testHooks && __testHooks.executors) {
    const map = {};
    for (const s of STAGES) map[s.id] = __testHooks.executors[s.id] || (async () => ({}));
    return map;
  }
  return buildExecutors();
}

// —— rcx 组装：项目元数据现读，执行配置固定为任务启动快照 ——
// llm 的事件钩子绑定到 rcx 本身（读 run.current 得到当前阶段），LLM 调用自动进 trace/events.jsonl
// stageCfgOf：按阶段取合并后的配置（阶段执行器读提示词/委托；llm 读路由覆盖），
// 无快照的历史任务仍读取旧项目配置；连接凭据独立管理，不进入任务快照。
function buildRcx(ctx, root, runDir, run) {
  const rcx = {
    runDir, run, dataRoot: root, hostCtx: ctx, // dsh-agent 执行器经 ctx.get("agents") 消费宿主智能体服务
    project: executionProject(loadProject(root, run.project), run),
    repoDir: runRepoDir(root, run.project, run.id), // per-Run worktree（drive 开工时确保存在，失败兜底基线 repo）
    trigger: run.trigger,
    llm: null,
    p6Mode: run.p6Mode,
    executors: executorsOf(),
    log() {},
  };
  // 连接配置用 getter 现读盘：Run 进行中新增/修改连接，下一阶段即生效（与 project 同策略）
  Object.defineProperty(rcx, "connections", { get: () => loadConnections(root) });
  rcx.stageCfgOf = (stageId) => {
    const cfg = stageCfgOf(rcx.project, stageId || rcx.run?.current);
    const route = rcx.run?.executionConfig?.defaultRoute;
    return route && !cfg.provider && !cfg.model
      ? { ...cfg, provider: route.provider, model: route.model, reasoningEffort: cfg.reasoningEffort || route.reasoningEffort || "" }
      : cfg;
  };
  rcx.llm = makeLlm(ctx, (ev) => logEvent(rcx, ev), () => routeOverridesOf(rcx));
  return rcx;
}

// —— 单 run 一把锁防并发；rcx 跨 drive/review 共享（打回意见 reviewComment 跨循环传递） ——
const runSessions = new Map();

function sessionFor(runDir) {
  if (!runSessions.has(runDir)) runSessions.set(runDir, { lock: Promise.resolve(), rcx: null });
  return runSessions.get(runDir);
}

// —— 项目级互斥（A3 修复）：同项目的 Run 串行推进 ——
// per-Run worktree 已让并发 Run 的仓库隔离；worktree 创建失败的兜底路径（共用基线 repo）与
// 基线 repo 的 clone/reset 管理操作仍需互斥。锁按需创建、空闲自动回收，等待不因前任失败而中断。
const projectLocks = new Map();
function withProjectLock(key, fn) {
  const prev = projectLocks.get(key) || Promise.resolve();
  const task = prev.then(() => fn());
  const tail = task.then(() => {}, () => {});
  projectLocks.set(key, tail);
  tail.then(() => { if (projectLocks.get(key) === tail) projectLocks.delete(key); });
  return task;
}
function projectKeyOf(root, runDir) {
  try {
    const rel = relative(join(root, "projects"), runDir);
    const slug = String(rel).split(sep)[0];
    if (slug && !slug.startsWith("..")) return join(root, "projects", slug);
  } catch { /* 兜底 */ }
  return runDir;
}

// —— 仓库克隆：repo 目录不存在时 git clone --depth 1 主仓库（幂等） ——
// https 凭据只通过子进程环境中的 http.extraheader 注入，URI/argv 永不携带 token。
function ensureRepo(root, project, rcx) {
  const repoDir = baseRepoDir(root, project.slug);
  if (existsSync(join(repoDir, ".git"))) return Promise.resolve(repoDir);
  if (!project.repos || !project.repos.length) return Promise.reject(new Error("项目未配置仓库"));
  mkdirSync(repoDir, { recursive: true });
  const uri0 = typeof project.repos[0] === "string" ? project.repos[0] : project.repos[0].uri;
  const conn = matchConnection(uri0, loadConnections(root));
  const credential = gitCredentialSpec(uri0, conn, process.env);
  const t0 = Date.now();
  logEvent(rcx, {
    kind: "git", name: "git clone --depth 1 " + redactUrl(uri0),
    detail: "克隆主仓库到本地 repo/" + (conn ? `（已注入 ${CONNECTION_KINDS[conn.kind].label} 连接凭据）` : ""),
  });
  return new Promise((resolve, reject) => {
    execFile("git", ["clone", "--depth", "1", credential.uri, repoDir], {
      stdio: "pipe", timeout: 120000, windowsHide: true, env: credential.env,
    }, (err, stdout, stderr) => {
      if (err) {
        const stderrS = redactUrl(String(stderr || err.message));
        logEvent(rcx, { kind: "git", name: "git clone 失败", detail: stderrS, ms: Date.now() - t0, ok: false });
        const host = hostOf(uri0);
        const hint = !conn && host ? `（若为私有仓库，请在项目页「Git 托管连接」配置 ${host} 的凭据）` : "";
        reject(new Error("git clone 失败" + hint + ": " + stderrS));
      } else {
        logEvent(rcx, { kind: "git", name: "git clone 完成", detail: redactUrl(uri0), ms: Date.now() - t0 });
        resolve(repoDir);
      }
    });
  });
}

// —— 快速失败：把运行中的 run 置为 failed（阶段状态同步落盘），供克隆失败等开工前错误使用 ——
export function failRun(runDir, stageId, message) {
  let run;
  try {
    run = loadRun(runDir);
  } catch (parseError) {
    run = recoverCorruptRun(runDir, stageId, message, parseError);
  }
  if (!run || run.status !== "running") return run;
  run.status = "failed";
  if (!run.stages || typeof run.stages !== "object" || Array.isArray(run.stages)) run.stages = {};
  const id = stageId || run.current || "P1";
  const st = run.stages[id] || (run.stages[id] = { status: "pending", attempts: 0 });
  st.status = "failed"; st.error = message;
  saveRun(runDir, run);
  return run;
}

// —— 失败分析（P10）结果写回 run.json：此前只落 09-failure-analysis.json 产物，run.json 不记，
// UI 轮询状态机无从得知"失败已分析/建议动作"。此处读产物合并进 run.failureAnalysis（尽力而为，不阻断主流程）。
function recordFailureAnalysis(runDir) {
  try {
    const run = loadRun(runDir);
    if (!run || run.status !== "failed") return;
    const out = JSON.parse(readFileSync(join(runDir, "09-failure-analysis.json"), "utf8"));
    if (!out || !out.category) return;
    run.failureAnalysis = { category: out.category, detail: out.detail || "", action: out.action || "", at: new Date().toISOString() };
    saveRun(runDir, run);
  } catch { /* 产物缺失/损坏时静默跳过 */ }
}

async function classifyFailure(ctx, runDir, rcx, run, message) {
  if (!rcx?.executors?.P10) return;
  rcx.run = run;
  try {
    await rcx.executors.P10({ ...rcx, failure: { stage: run.current, error: message } });
    recordFailureAnalysis(runDir);
  } catch (error) {
    ctx.logger?.error?.("issue2pr: P10 失败分析也失败: " +
      String((error && error.message) || error));
  }
}

// 推进循环：仅 run.status==="running" 时调用 advance（awaiting_review 停手等 applyReview）；
// 阶段失败自动调 P10 executor 写分类产物后停（v1：不自动 replan）。
function drive(ctx, root, runDir) {
  const s = sessionFor(runDir);
  // 单 Run 锁（防同 Run 并发推进）之内再套项目锁（防同项目 Run 交错写仓库）—— A3 修复
  const task = s.lock.then(() => withProjectLock(projectKeyOf(root, runDir), async () => {
    // 确保仓库已克隆（幂等：已存在则跳过）。克隆失败 = 流水线无法开工：
    // 快速失败写入 run.json 并走 P10 分类，而不是让 P2 拿空仓库产出垃圾候选。
    // 测试钩子注入执行器时跳过真实 clone / worktree（用例使用假仓库地址）。
    const initRun = loadRun(runDir);
    if (!__testHooks && initRun && initRun.status === "running") {
      const project = loadProject(root, initRun.project);
      if (project) {
        const rcx0 = s.rcx || (s.rcx = buildRcx(ctx, root, runDir, initRun));
        try {
          await ensureRepo(root, project, rcx0);
          // A3：每 Run 独立 worktree（同项目并发 Run 互不污染；创建失败兜底共用基线 repo，靠项目锁串行保安全）
          rcx0.repoDir = await ensureWorktree(root, project.slug, initRun.id, (ev) => logEvent(rcx0, ev));
          // A1：即将执行 P2-P6 时把工作区重置回 HEAD 基线 —— 清掉上一轮已应用补丁与未跟踪残留
          //（P7 应用前自身也会 reset，双保险；P8-P11 不 reset，需要保留 P7 已应用的补丁状态）
          const nextId = MAIN_FLOW.find((id) => initRun.stages[id] && initRun.stages[id].status !== "approved");
          if (nextId && MAIN_FLOW.indexOf(nextId) <= MAIN_FLOW.indexOf("P6")) {
            await resetRepoClean(rcx0.repoDir);
            logEvent(rcx0, { kind: "git", name: "工作区基线重置", detail: nextId + " 执行前 git reset --hard + git clean -fd（清除上一轮补丁/未跟踪残留）" });
          }
        }
        catch (e) {
          const msg = "仓库准备失败: " + String((e && e.message) || e);
          const run = failRun(runDir, initRun.current, msg);
          if (run) {
            const rcx = s.rcx;
            if (rcx) {
              rcx.run = run;
              try {
                await rcx.executors.P10({ ...rcx, failure: { stage: run.current, error: msg } });
                recordFailureAnalysis(runDir);
              } catch (p10Error) {
                ctx.logger?.error?.("issue2pr: P10 失败分析也失败: " +
                  String((p10Error && p10Error.message) || p10Error));
              }
            }
          }
          ctx.logger?.warn?.("issue2pr: " + msg);
          return;
        }
      }
    }
    for (;;) {
      const run = loadRun(runDir);
      if (!run) {
        // run.json 不在了 = 运行中被删除：清掉执行器可能重建的孤儿产物目录
        try { rmTree(runDir); } catch { /* 尽力清理 */ }
        runSessions.delete(runDir);
        return;
      }
      // A4 修正：停在 awaiting_review 且属"委外等待 + 无人工门"（全自动模式）时，
      // 挂一个就绪监听：拿到委外结果 → 机器验证 → 验证 ok 自动放行流转
      if (run.status !== "running") { maybeWatchDelegate(ctx, root, runDir, run); return; }
      const rcx = s.rcx || (s.rcx = buildRcx(ctx, root, runDir, run));
      rcx.run = run; // 刷新为最新落盘状态（reviewComment 保留在 rcx 上）
      rcx.project = executionProject(loadProject(root, run.project), run) || rcx.project;
      await advance(rcx);
      if (run.status === "failed") {
        try {
          await rcx.executors.P10({ ...rcx, failure: { stage: run.current, error: run.stages[run.current]?.error } });
          recordFailureAnalysis(runDir);
        } catch { /* P10 自身失败不阻断主流程 */ }
        return;
      }
    }
  }));
  const guarded = task.catch(async (error) => {
    const detail = String((error && error.message) || error);
    const message = "运行驱动异常: " + detail;
    ctx.logger?.error?.("issue2pr: " + message);
    let run;
    let loadError = null;
    try {
      run = loadRun(runDir);
    } catch (parseError) {
      ctx.logger?.error?.("issue2pr: " + message + "；读取 run.json 失败: " +
        String((parseError && parseError.message) || parseError));
      loadError = parseError;
    }
    if (!run && !loadError) return;
    if (run && run.status !== "running") return;
    let failed;
    try {
      failed = failRun(runDir, run && run.current, message);
    } catch (failError) {
      ctx.logger?.error?.("issue2pr: " + message + "；写入 failed 状态失败: " +
        String((failError && failError.message) || failError));
      return;
    }
    if (!failed) return;
    let rcx = s.rcx;
    if (!rcx) {
      try {
        rcx = s.rcx = buildRcx(ctx, root, runDir, failed);
      } catch (buildError) {
        ctx.logger?.error?.("issue2pr: 失败状态已落盘，但 P10 上下文构建失败: " +
          String((buildError && buildError.message) || buildError));
        return;
      }
    }
    if (!rcx.executors?.P10) return;
    rcx.run = failed;
    try {
      await rcx.executors.P10({ ...rcx, failure: { stage: failed.current, error: message } });
      recordFailureAnalysis(runDir);
    } catch (p10Error) {
      ctx.logger?.error?.("issue2pr: P10 失败分析也失败: " +
        String((p10Error && p10Error.message) || p10Error));
    }
  });
  s.lock = guarded.then(() => {}, () => {}); // 失败已记录，锁链保持可继续使用
  return s.lock;
}

// —— A4 修正：全自动模式的委外产物就绪监听（拿到结果 + 验证 ok 才自动流转）——
// 触发条件：drive 停在 awaiting_review，当前阶段是委托阶段且无人工门（reviewMode=auto，
// 或 key-only 下未设门的委托阶段）。有人工门（every / key-only 的门阶段）不自动放行，
// 验证由 applyReview 的人工"通过"动作触发（同一验证函数，同一口径）。
// 语义：拿到委外结果 → verifyDelegateResult（结构 + 对 HEAD 基线的应用性演练）→
//   验证 ok  → 自动放行（落 auto-approve 复核记录，机器决策可审计）+ 继续推进；
//   验证不过 → 容错窗口内继续等待（外部会话可能还在写产物）；连续
//   DELEGATE_VERIFY_MAX_FAILS 次不过（产物稳定存在但不可用）→ Run 显式失败。
export const DELEGATE_WATCH_INTERVAL_MS =
  Number(process.env.ISSUE2PR_DELEGATE_WATCH_MS) > 0 ? Number(process.env.ISSUE2PR_DELEGATE_WATCH_MS) : 5000;
export const DELEGATE_VERIFY_MAX_FAILS =
  Number(process.env.ISSUE2PR_DELEGATE_VERIFY_MAX_FAILS) > 0 ? Number(process.env.ISSUE2PR_DELEGATE_VERIFY_MAX_FAILS) : 3;

function stopDelegateWatch(runDir) {
  const s = runSessions.get(runDir);
  if (s && s.watch) { clearInterval(s.watch); s.watch = null; }
}

function maybeWatchDelegate(ctx, root, runDir, run) {
  if (!run || run.status !== "awaiting_review") return;
  const s = sessionFor(runDir);
  if (s.watch) return; // 已在监听
  const rcx = s.rcx || (s.rcx = buildRcx(ctx, root, runDir, run));
  rcx.run = run;
  rcx.project = executionProject(loadProject(root, run.project), run) || rcx.project;
  if (!stageDelegated(rcx, run.current) || isGate(run, run.current)) return; // 人工门交人工
  s.watch = setInterval(async () => {
    const r = await delegateWatchTick(ctx, root, runDir);
    if (r !== "waiting" && r !== "verify-fail") stopDelegateWatch(runDir);
    if (r === "advanced") drive(ctx, root, runDir);
  }, DELEGATE_WATCH_INTERVAL_MS);
  s.watch.unref?.(); // 不阻止进程退出（测试 / 停服场景）
  ctx.logger?.info?.("issue2pr: 全自动模式监听委外产物就绪（每 " + DELEGATE_WATCH_INTERVAL_MS + "ms 验证一次）");
}

// 单次监听推进（导出供测试直接驱动）。
// 返回: idle(非委托等待态) | gate(人工门，交人工) | waiting(未拿到委外结果)
//      | verify-fail(验证未过，仍在容错窗口) | advanced(验证过 → 已自动放行) | failed(连续不过 → Run 显式失败)
export async function delegateWatchTick(ctx, root, runDir) {
  const run = loadRun(runDir);
  if (!run || run.status !== "awaiting_review") return "idle";
  const id = run.current;
  const s = sessionFor(runDir);
  const rcx = s.rcx || (s.rcx = buildRcx(ctx, root, runDir, run));
  rcx.run = run;
  rcx.project = executionProject(loadProject(root, run.project), run) || rcx.project;
  if (!stageDelegated(rcx, id)) return "idle";
  if (isGate(run, id)) return "gate"; // 复核模式中途改为有人工门 → 交人工
  if (!delegateReady(runDir, id)) return "waiting"; // 还没拿到委外结果
  const v = await verifyDelegateResult(rcx, id);
  logEvent(rcx, { kind: "stage", name: id + " 委外产物自动验证" + (v.ok ? "通过" : "未通过"),
    detail: v.ok
      ? "结构完整" + (v.rehearsal ? "，对 HEAD 基线应用性演练通过（" + v.patches + " 份补丁）" : "")
      : v.errors.join("；"),
    ok: v.ok });
  if (v.ok) {
    // 自动放行：落 auto-approve 复核记录（审计可见这是机器决策，非人工）
    delete run.delegateVerifyFails;
    const st = run.stages[id];
    st.status = "approved"; st.finishedAt = new Date().toISOString();
    run.status = "running";
    writeArtifact(runDir, `reviews/${timestamp()}-auto-approve-${id}.json`, JSON.stringify({
      stage: id, decision: "approve", auto: true,
      comment: "全自动模式：委外产物就绪且机器验证通过，自动放行",
      verification: { ok: true, patches: v.patches, rehearsal: v.rehearsal },
      at: new Date().toISOString(),
    }, null, 2));
    saveRun(runDir, run);
    return "advanced";
  }
  run.delegateVerifyFails = (run.delegateVerifyFails || 0) + 1;
  if (run.delegateVerifyFails < DELEGATE_VERIFY_MAX_FAILS) {
    saveRun(runDir, run); // 计数落盘：外部会话可能仍在写产物，给容错窗口
    return "verify-fail";
  }
  // 连续 N 次不过：产物稳定存在但不可用 → 显式失败（不无限等待，更不空手放行）
  delete run.delegateVerifyFails;
  const st = run.stages[id];
  const msg = id + " 委外产物验证连续 " + DELEGATE_VERIFY_MAX_FAILS + " 次未通过: " + v.errors.join("；")
    + "；请回退该阶段重跑，或修正外部产物";
  st.status = "failed"; st.error = msg;
  run.status = "failed";
  saveRun(runDir, run);
  rcx.run = run;
  try {
    await rcx.executors.P10({ ...rcx, failure: { stage: id, error: msg } });
    recordFailureAnalysis(runDir);
  } catch { /* P10 自身失败不阻断主流程 */ }
  return "failed";
}

// 启动恢复：dsh 进程重启后，盘上遗留 status==="running" 的 Run 已无驱动循环，
// 置为 stopped（阶段状态同步），避免 UI 永远显示「运行中」。可用「重跑」续跑。
export function recoverInterruptedRuns(root) {
  const projectsDir = join(root, "projects");
  if (!existsSync(projectsDir)) return;
  for (const slug of readdirSync(projectsDir)) {
    const runsDir = join(projectsDir, slug, "runs");
    if (!existsSync(runsDir)) continue;
    for (const id of readdirSync(runsDir)) {
      const runDir = join(runsDir, id);
      const run = loadRun(runDir);
      if (!run || run.status !== "running") continue;
      const st = run.stages[run.current];
      if (st && st.status === "running") st.status = "stopped";
      run.status = "stopped";
      run.interruptedAt = new Date().toISOString();
      saveRun(runDir, run);
    }
  }
}

async function handleApi(ctx, root, req, res) {
  const url = new URL(req.url, "http://localhost");
  const parts = url.pathname.split("/").filter(Boolean);
  const m = req.method;
  try {
    if (m === "GET" && parts.join("/") === "issue2pr/api/ping") {
      return sendJson(res, 200, { ok: true, plugin: "dsh-issue2pr" });
    }
    if (parts.join("/") === "issue2pr/api/settings") {
      if (m === "GET") return sendJson(res, 200, { ok: true, settings: loadSettings(root) });
      if (m === "PUT") {
        const body = await readBody(req);
        if (body?.p6Mode === "claude" && (!__testHooks || __testHooks.agentProbes)) {
          const bin = resolveClaudeBin(body.stageConfig?.P6?.params?.claudeBin || "");
          const runner = __testHooks?.agentProbes?.runVersion || realRunVersion;
          const error = await new Promise(resolve => runner(bin, {}, err => resolve(err)));
          if (error) return sendJson(res, 400, { ok: false, message: "Claude Code 程序不可运行，请在执行器与环境中完成探测" });
        }
        if (body?.p6Mode === "dsh" && !__testHooks) {
          const agents = typeof ctx.get === "function" ? ctx.get("agents") : null;
          if (typeof agents?.create !== "function") return sendJson(res, 400, { ok: false, message: "宿主智能体服务不可用" });
        }
        try { return sendJson(res, 200, { ok: true, settings: saveSettings(root, body) }); }
        catch (error) { return sendJson(res, error.code === "SETTINGS_CONFLICT" ? 409 : 400, { ok: false, message: error.message }); }
      }
      return sendJson(res, 405, { ok: false, message: "method not allowed" });
    }
    // —— 阶段默认值与能力表（配置页数据源：默认提示词 / 可配能力 / 默认超时） ——
    if (m === "GET" && parts.join("/") === "issue2pr/api/stage-defaults") {
      return sendJson(res, 200, {
        ok: true,
        defaults: {
          llmTimeoutMs: DEFAULT_LLM_TIMEOUT_MS, testTimeoutMs: DEFAULT_TEST_TIMEOUT_MS,
          maxTokens: 8192,
          stages: Object.fromEntries(Object.entries(STAGE_DEFS).map(([id, def]) => [id, {
            name: def.name, desc: def.desc, caps: def.caps, prompts: def.prompts,
            params: Object.keys(def.params || {}).length ? def.params : undefined,
            delegateSpec: def.caps.delegate ? def.delegateSpec : undefined,
          }])),
        },
      });
    }
    if (parts[0] !== "issue2pr" || parts[1] !== "api") {
      return sendJson(res, 404, { ok: false, message: "not found" });
    }
    // —— /issue2pr/api/ui-state：UI 偏好兜底存储（宿主重启丢 localStorage 时恢复选中记忆） ——
    if (parts[2] === "ui-state" && !parts[3]) {
      if (m === "GET") return sendJson(res, 200, { ok: true, state: loadUiState(root) });
      if (m === "POST") {
        const body = await readBody(req);
        const prev = loadUiState(root);
        // lastProject：只认本字段；slug 走既有白名单形态，null/空 = 清除
        const lp = body && Object.prototype.hasOwnProperty.call(body, "lastProject") ? body.lastProject : prev.lastProject;
        // lastRunBySlug：按项目记最近选中的 Run（宿主标签切换会销毁重建插件 webview，选中现场以此恢复）；
        // 按键合并：值合法则覆盖，null = 清除该项目的记忆，非法条目忽略
        const lrPrev = (prev.lastRunBySlug && typeof prev.lastRunBySlug === "object") ? { ...prev.lastRunBySlug } : {};
        if (body && body.lastRunBySlug && typeof body.lastRunBySlug === "object") {
          for (const [s, rid] of Object.entries(body.lastRunBySlug)) {
            if (!/^[a-z0-9-]+$/.test(s)) continue;
            if (rid === null) delete lrPrev[s];
            else if (/^\d{8}-\d{6}-[a-z0-9-]+$/.test(String(rid))) lrPrev[s] = String(rid);
          }
        }
        // 智能助手面板尺寸（跨软件重启兜底）：整数且在合法范围才更新，非法值忽略保留旧值
        const intIn = (v, lo, hi) => (Number.isInteger(v) && v >= lo && v <= hi) ? v : null;
        const state = {
          ...prev,
          lastProject: (typeof lp === "string" && /^[a-z0-9-]+$/.test(lp)) ? lp : null,
          lastRunBySlug: lrPrev,
          aiW: (body ? intIn(body.aiW, 240, 760) : null) ?? prev.aiW,
          aiH: (body ? intIn(body.aiH, 200, 1800) : null) ?? prev.aiH,
          aiR: (body ? intIn(body.aiR, 0, 4000) : null) ?? prev.aiR,
          aiT: (body ? intIn(body.aiT, 44, 2000) : null) ?? prev.aiT,
          aiTop: (body ? intIn(body.aiTop, 44, 600) : null) ?? prev.aiTop,
        };
        saveUiState(root, state);
        return sendJson(res, 200, { ok: true, state });
      }
      return sendJson(res, 404, { ok: false, message: "not found" });
    }
    // —— /issue2pr/api/connections：Git 托管连接（GitHub/GitLab/CodeArts 凭据，全局共享，所有项目复用） ——
    // connections.json 只保存元数据/secretRef；返回给 UI 的 token 仅为掩码，且展示实际存储模式。
    if (parts[2] === "connections") {
      const masked = (c) => ({
        id: c.id, kind: c.kind, host: c.host, username: c.username, createdAt: c.createdAt,
        secretRef: c.secretRef, secretStorage: c.secretStorage,
        secretEncrypted: c.secretEncrypted, secretWarning: c.secretWarning,
        token: c.token ? maskToken(c.token) : "",
      });
      if (!parts[3] && m === "GET") {
        return sendJson(res, 200, { ok: true, connections: loadConnections(root).map(masked) });
      }
      if (!parts[3] && m === "POST") {
        const body = await readBody(req);
        try { return sendJson(res, 200, { ok: true, connection: masked(upsertConnection(root, body)) }); }
        catch (e) { return sendJson(res, 400, { ok: false, message: (e && e.message) || String(e) }); }
      }
      if (parts[3] && !parts[4] && m === "DELETE") {
        const removed = deleteConnection(root, decodeURIComponent(parts[3]));
        if (!removed) return sendJson(res, 404, { ok: false, message: "连接不存在" });
        return sendJson(res, 200, { ok: true });
      }
      // —— 连接探活：github/gitlab 调 /user 回显账号名；支持未保存前直接测输入值（添加表单用） ——
      if (parts[3] === "test" && m === "POST") {
        const body = await readBody(req);
        let conn = null;
        if (body && body.token && body.kind) {
          try { conn = normalizeConnection(body, loadConnections(root)); }
          catch (e) { return sendJson(res, 400, { ok: false, message: (e && e.message) || String(e) }); }
        } else {
          conn = loadConnections(root).find((c) => c.id === (body && body.id)) || null;
          if (!conn) return sendJson(res, 404, { ok: false, message: "连接不存在" });
        }
        if (conn.kind === "codearts") {
          return sendJson(res, 200, { ok: false, message: "CodeArts 无账号探活 API，请在下方仓库地址行点「测试」用真实仓库验证连通" });
        }
        const api = conn.kind === "github" ? `https://api.${conn.host}/user` : `https://${conn.host}/api/v4/user`;
        try {
          const resp = await fetch(api, {
            headers: { "User-Agent": "dsh-issue2pr", Authorization: "Bearer " + conn.token },
            signal: AbortSignal.timeout(10000),
          });
          if (!resp.ok) return sendJson(res, 200, { ok: false, message: "凭据无效 (HTTP " + resp.status + ")" });
          const data = await resp.json();
          return sendJson(res, 200, { ok: true, account: data.login || data.username || "" });
        } catch (e) { return sendJson(res, 200, { ok: false, message: "请求失败: " + String((e && e.message) || e) }); }
      }
      // —— 真实仓库连通性：匹配连接注入凭据后 git ls-remote（三类托管通用；CodeArts 的唯一探活手段） ——
      if (parts[3] === "test-repo" && m === "POST") {
        const body = await readBody(req);
        const uri = typeof body?.uri === "string" ? body.uri.trim() : "";
        if (!uri) return sendJson(res, 400, { ok: false, message: "uri 必填" });
        const conn = matchConnection(uri, loadConnections(root));
        const credential = gitCredentialSpec(uri, conn, process.env);
        const runGit = __testHooks?.runGit || ((args, opts, cb) => execFile("git", args, opts, cb));
        const t0 = Date.now();
        runGit(["ls-remote", "--heads", credential.uri], {
          timeout: 15000, windowsHide: true, env: credential.env,
        }, (err, stdout, stderr) => {
          if (err) {
            return sendJson(res, 200, {
              ok: false, matched: conn ? conn.id : null,
              message: "不可达: " + redactUrl(String(stderr || err.message)).slice(0, 300),
            });
          }
          const heads = String(stdout).trim().split("\n").filter(Boolean).length;
          sendJson(res, 200, {
            ok: true, matched: conn ? conn.id : null, ms: Date.now() - t0,
            message: "可达（" + heads + " 个分支" + (conn ? "" : "，匿名访问，未匹配连接") + "）",
          });
        });
        return;
      }
      return sendJson(res, 404, { ok: false, message: "not found" });
    }
    // —— /issue2pr/api/agents/discover：委外智能体（claude CLI）多方式发现 ——
    // 五种来源去重合并：项目配置 > 环境变量 > 常见安装位置 > npm 全局目录 > PATH 查找；
    // ?slug= 带项目时把该项目配置的 claudeBin 列为首位候选。测试钩子环境未注入 runNpmPrefix
    // 时跳过 npm 来源（避免单测真跑 npm config get prefix）。
    if (parts[2] === "agents" && parts[3] === "discover" && !parts[4] && m === "GET") {
      const slugQ = url.searchParams.get("slug");
      const project = (slugQ && /^[a-z0-9-]+$/.test(slugQ)) ? loadProject(root, slugQ) : loadSettings(root);
      const out = await discoverAgents({
        cfgBin: (project && project.stageConfig && project.stageConfig.P6 && project.stageConfig.P6.params && project.stageConfig.P6.params.claudeBin) || "",
        runWhich: __testHooks?.runWhich || realRunWhich,
        runNpmPrefix: __testHooks ? __testHooks.runNpmPrefix : realRunNpmPrefix,
      });
      return sendJson(res, 200, { ok: true, agents: out.agents, resolved: out.resolved });
    }
    // —— /issue2pr/api/agents/test：委外智能体测试门禁（按执行器分派） ——
    // claude-code（默认）：定位 → --version → headless 认证微任务；body 可带 auth 中转配置
    //   {preset, baseUrl, token}（未保存的表单值也可先测；token 留空回落已存 relay-auth）。
    // dsh-agent：智能体服务 → 模型路由 → 一次极小真实调用。ok=false 也回 200（与 connections/test 同约定）。
    if (parts[2] === "agents" && parts[3] === "test" && !parts[4] && m === "POST") {
      const body = await readBody(req);
      const t = Number(body?.timeoutMs);
      const timeoutMs = Number.isFinite(t) && t >= 10000 && t <= 180000 ? t : 120000;
      if (body?.executor === "dsh-agent") {
        if (__testHooks && __testHooks.dshGate) return sendJson(res, 200, __testHooks.dshGate);
        const gate = await testDshGate({ hostCtx: ctx, timeoutMs });
        return sendJson(res, 200, { ok: gate.ok, gate });
      }
      const bin = typeof body?.bin === "string" ? body.bin.trim() : "";
      const a = body?.auth;
      const auth = (a && typeof a === "object")
        ? {
            preset: ["glm", "custom"].includes(a.preset) ? a.preset : "none",
            baseUrl: typeof a.baseUrl === "string" ? a.baseUrl : "",
            // 表单 token 留空时回落已保存的全局 relay token（门禁测的就是保存后的真实路径）
            token: (typeof a.token === "string" && a.token.trim()) ? a.token.trim() : loadRelayToken(root),
          }
        : null;
      const gate = await testAgentGate({ bin, timeoutMs, auth, runners: (__testHooks && __testHooks.agentProbes) || {} });
      return sendJson(res, 200, { ok: gate.ok, gate });
    }
    // —— /issue2pr/api/relay-auth：claude 认证中转 token（全局一份） ——
    // relay-auth.json 只保存元数据/secretRef；返回 UI 一律打码并展示实际存储模式。
    if (parts[2] === "relay-auth" && !parts[3] && m === "GET") {
      const token = loadRelayToken(root);
      const info = relayAuthInfo(root);
      return sendJson(res, 200, {
        ok: true, exists: !!token, masked: token ? maskToken(token) : "",
        storage: info.storage, encrypted: info.encrypted, warning: info.warning,
      });
    }
    if (parts[2] === "relay-auth" && !parts[3] && m === "PUT") {
      const body = await readBody(req);
      if (!body || typeof body.token !== "string" || !body.token.trim()) {
        return sendJson(res, 400, { ok: false, message: "token 必填" });
      }
      saveRelayToken(root, body.token.trim());
      const info = relayAuthInfo(root);
      return sendJson(res, 200, {
        ok: true, exists: relayAuthExists(root), masked: maskToken(body.token.trim()),
        storage: info.storage, encrypted: info.encrypted, warning: info.warning,
      });
    }
    if (parts[2] === "relay-auth" && !parts[3] && m === "DELETE") {
      saveRelayToken(root, "");
      const info = relayAuthInfo(root);
      return sendJson(res, 200, {
        ok: true, exists: false, masked: "", storage: info.storage,
        encrypted: info.encrypted, warning: info.warning,
      });
    }
    // —— /issue2pr/api/preflight：环境健康探测（git 二进制 / claude CLI / LLM 默认路由与来源） ——
    // 纯只读探测：git --version、claudeBin 解析 + 存在性/PATH 校验、resolveRoute 现算；不发真实 LLM 请求。
    if (parts[2] === "preflight" && !parts[3] && m === "GET") {
      const runGit = __testHooks?.runGit || ((args, opts, cb) => execFile("git", args, opts, cb));
      const runWhich = __testHooks?.runWhich
        || ((args, opts, cb) => execFile(process.platform === "win32" ? "where" : "which", args, opts, cb));
      const slugQ = url.searchParams.get("slug");
      const project = (slugQ && /^[a-z0-9-]+$/.test(slugQ)) ? loadProject(root, slugQ) : loadSettings(root);
      const claudeBin = resolveClaudeBin(project?.stageConfig?.P6?.params?.claudeBin || "");
      const [git, claude] = await Promise.all([
        new Promise((r) => runGit(["--version"], { timeout: 5000 }, (err, stdout) =>
          r(err ? { ok: false, message: String(err.message || err) } : { ok: true, version: String(stdout).trim() }))),
        new Promise((r) => {
          if (existsSync(claudeBin)) return r({ ok: true, path: claudeBin });
          if (/^claude(\.cmd|\.exe)?$/i.test(claudeBin)) {
            // 兜底裸名"claude"：靠 where/which 验证是否在 PATH（显式配置的完整路径则不必，存在性即结论）
            return runWhich([claudeBin], { timeout: 5000 }, (err, stdout) => {
              const hit = !err && String(stdout).trim();
              r(hit ? { ok: true, path: String(stdout).trim().split(/\r?\n/)[0] } : { ok: false, path: claudeBin });
            });
          }
          r({ ok: false, path: claudeBin });
        }),
      ]);
      const info = routeInfo(ctx, {});
      const overrides = {};
      if (project?.stageConfig) {
        for (const id of Object.keys(STAGE_DEFS)) {
          const cfg = project.stageConfig[id];
          if (cfg && cfg.provider && cfg.model) overrides[id] = { provider: cfg.provider, model: cfg.model };
        }
      }
      return sendJson(res, 200, { ok: true, preflight: { git, claude, llm: { ...info.route, source: info.source, overrides } } });
    }
    // —— /issue2pr/api/check-local：本地触发源存在性（项目页触发源行内即时提示） ——
    if (parts[2] === "check-local" && !parts[3] && m === "POST") {
      const body = await readBody(req);
      const p = typeof body?.path === "string" ? body.path.trim() : "";
      if (!p) return sendJson(res, 400, { ok: false, message: "path 必填" });
      return sendJson(res, 200, { ok: true, exists: existsSync(p) });
    }
    // —— /issue2pr/api/assistant/ask：悬浮智能助手（LLM 走宿主 ctx.llm，流式 JSONL 响应） ——
    // body {question, history:[{role,text}], focus:{nav,slug,runId}}；每行 {"delta"} … 末行 {"done":true} 或 {"error"}
    // 上下文每次现读 buildAssistantContext（数据最新）；客户端断开（close）即 abort 生成
    if (parts[2] === "assistant" && parts[3] === "ask" && m === "POST") {
      const body = await readBody(req);
      const question = typeof body?.question === "string" ? body.question.trim() : "";
      if (!question || question.length > 4000) return sendJson(res, 400, { ok: false, message: "question 必填且不超过 4000 字" });
      const history = (Array.isArray(body?.history) ? body.history : [])
        .filter((x) => x && (x.role === "user" || x.role === "assistant") && typeof x.text === "string" && x.text.trim())
        .slice(-12).map((x) => ({ role: x.role, text: x.text.slice(0, 4000) }));
      const focus = body?.focus && typeof body.focus === "object" ? body.focus : {};
      const fSlug = typeof focus.slug === "string" && /^[a-z0-9-]+$/.test(focus.slug) ? focus.slug : null;
      const fRunId = typeof focus.runId === "string" && /^\d{8}-\d{6}-[a-z0-9-]+$/.test(focus.runId) ? focus.runId : null;

      const system = ASSISTANT_SYSTEM_HEAD + "\n\n" + buildAssistantContext(root, { nav: focus.nav, slug: fSlug, runId: fRunId });
      const messages = [...history, { role: "user", text: question }];

      let finished = false;
      const ac = new AbortController();
      req.on("close", () => { if (!finished) ac.abort(); });
      // 响应已开始流式写入后不能再走 sendJson（外层 catch 的 500 会二次 writeHead），
      // 因此端点内部消化一切错误：已写头则补 {"error"} 行，未写头前出错仍可 sendJson
      let headerSent = false;
      try {
        const llm = makeLlm(ctx, null, () => ({}));
        await llm.streamText({
          system, messages, maxTokens: 8192, signal: ac.signal,
          onDelta: (d) => {
            if (!headerSent) {
              res.writeHead(200, { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store", "Transfer-Encoding": "chunked" });
              headerSent = true;
            }
            res.write(JSON.stringify({ delta: d }) + "\n");
          },
        });
        if (!headerSent) {
          res.writeHead(200, { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store", "Transfer-Encoding": "chunked" });
          headerSent = true;
        }
        res.write(JSON.stringify({ done: true }) + "\n");
      } catch (e) {
        if (!headerSent) return sendJson(res, 500, { ok: false, message: (e && e.message) || String(e) });
        try { res.write(JSON.stringify({ error: String((e && e.message) || e) }) + "\n"); } catch { /* 连接已断 */ }
      } finally {
        finished = true;
        res.end();
      }
      return;
    }
    if (parts[2] !== "projects") {
      return sendJson(res, 404, { ok: false, message: "not found" });
    }
    const slug = parts[3];
    const p = parts[4];

    // —— /issue2pr/api/projects（集合，无 slug） ——
    if (!slug) {
      if (m === "GET") return sendJson(res, 200, { ok: true, projects: listProjects(root) });
      if (m === "POST") {
        const input = await readBody(req);
        // 新界面只提交项目元数据。保留旧执行字段供历史任务读取，门禁归全局 /settings。
        const previous = /^[a-z0-9-]+$/.test(input?.slug || "") ? loadProject(root, input.slug) : null;
        const body = { reviewMode: "key-only", p6Mode: "builtin", triggers: [], ...previous, ...input };
        try { saveProject(root, body); }
        catch (e) { return sendJson(res, 400, { ok: false, message: (e && e.message) || String(e) }); }
        return sendJson(res, 200, { ok: true, project: body });
      }
      return sendJson(res, 404, { ok: false, message: "not found" });
    }
    if (!/^[a-z0-9-]+$/.test(slug)) return sendJson(res, 400, { ok: false, message: "非法 slug" });

    // —— 删除项目（整目录：project.json + runs + repo 克隆）；?confirm=slug 防误删 ——
    if (!parts[4] && m === "DELETE") {
      const dir = join(root, "projects", slug);
      if (!existsSync(dir)) return sendJson(res, 404, { ok: false, message: "项目不存在" });
      if (url.searchParams.get("confirm") !== slug) return sendJson(res, 400, { ok: false, message: "缺少 confirm=slug 确认参数" });
      // 运行中/待复核的 Run 先落 stopped（驱动循环下一圈读盘即退出；目录随后整体删除）
      const runsDir = join(dir, "runs");
      let stopped = 0;
      if (existsSync(runsDir)) {
        for (const id of readdirSync(runsDir)) {
          const rd = join(runsDir, id);
          const r = loadRun(rd);
          if (r && (r.status === "running" || r.status === "awaiting_review")) {
            r.status = "stopped";
            if (r.stages[r.current] && r.stages[r.current].status === "running") r.stages[r.current].status = "stopped";
            saveRun(rd, r);
            stopDelegateWatch(rd);
            runSessions.delete(rd);
            stopExternals(rd);
            stopped += 1;
          }
        }
      }
      try { rmTree(dir); }
      catch (e) { return sendJson(res, 500, { ok: false, message: "删除失败: " + String((e && e.message) || e) }); }
      return sendJson(res, 200, { ok: true, message: stopped > 0 ? `项目已删除（含 ${stopped} 个进行中的 Run，已一并停止移除）` : "项目已删除" });
    }

    const project = loadProject(root, slug);
    const runsDir = join(root, "projects", slug, "runs");

    // —— /issue2pr/api/projects/:slug/runs（集合） ——
    if (p === "runs" && !parts[5]) {
      if (m === "GET") {
        // 扫 runs/*/run.json，出摘要
        const runs = existsSync(runsDir)
          ? readdirSync(runsDir).map((id) => {
              const r = loadRun(join(runsDir, id));
              return r ? { id: r.id, status: r.status, current: r.current, trigger: r.trigger, createdAt: r.createdAt,
                currentError: r.stages?.[r.current]?.error || "", externalStatus: r.externalExec?.status || null,
              } : null;
            }).filter(Boolean).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
          : [];
        return sendJson(res, 200, { ok: true, runs });
      }
      if (m === "POST") {
        if (!project) return sendJson(res, 404, { ok: false, message: "项目不存在" });
        const body = await readBody(req);
        const { kind, uri } = body || {};
        if ((kind !== "issue" && kind !== "requirement") || typeof uri !== "string" || !uri.trim()) {
          return sendJson(res, 400, { ok: false, message: "kind 仅允许 issue|requirement 且 uri 必填" });
        }
        const trigger = { kind, uri };
        let text;
        try { text = await readTriggerText({ trigger, connections: loadConnections(root) }); } // 读触发文本（连接凭据优先于环境变量）
        catch (e) { return sendJson(res, 400, { ok: false, message: (e && e.message) || String(e) }); }
        let settings, defaultRoute;
        try { settings = loadSettings(root); defaultRoute = routeInfo(ctx, {}).route; }
        catch (error) { return sendJson(res, 400, { ok: false, message: error.message }); }
        let created;
        try { created = createRun(root, slug, trigger); } // 同秒同触发源重复发起 → Run 已存在 → 409
        catch (e) { return sendJson(res, 409, { ok: false, message: (e && e.message) || String(e) }); }
        const { runId, runDir } = created;
        const run = initRun({ runId, slug, trigger: { ...trigger, text }, reviewMode: settings.reviewMode, p6Mode: settings.p6Mode });
        run.executionConfig = { ...structuredClone(settings), defaultRoute };
        run.status = "running"; // 发起即进入运行态（drive 只在 running 时推进）
        saveRun(runDir, run);
        sendJson(res, 200, { ok: true, runId });
        setImmediate(() => drive(ctx, root, runDir)); // 同步返回后异步推进
        return;
      }
      return sendJson(res, 404, { ok: false, message: "not found" });
    }

    // —— /issue2pr/api/projects/:slug/runs/:runId[/action] ——
    if (p === "runs" && parts[5]) {
      const runId = parts[5];
      let runDir;
      try { runDir = runDirOf(root, slug, runId); }
      catch (e) { return sendJson(res, 400, { ok: false, message: (e && e.message) || String(e) }); }
      const action = parts[6];

      if (!action && m === "GET") {
        const run = loadRun(runDir);
        if (!run) return sendJson(res, 404, { ok: false, message: "run 不存在" });
        if (run.p6Mode === "session" || run.p6Mode === "claude" || run.p6Mode === "dsh") run.externalProgress = externalProgress(runDir);
        return sendJson(res, 200, run); // 直接吐 run.json（session/claude 模式附带外部执行进度）
      }

      // —— 停止：不再推进（当前正在执行的阶段跑完即停；异步执行器不阻塞本请求） ——
      if (action === "stop" && m === "POST") {
        const run = loadRun(runDir);
        if (!run) return sendJson(res, 404, { ok: false, message: "run 不存在" });
        if (run.status !== "running" && run.status !== "awaiting_review") {
          return sendJson(res, 400, { ok: false, message: "仅运行中/待复核的 Run 可停止（当前: " + run.status + "）" });
        }
        run.status = "stopped";
        if (run.stages[run.current] && run.stages[run.current].status === "running") {
          run.stages[run.current].status = "stopped";
        }
        saveRun(runDir, run);
        stopExternals(runDir); // 委外在跑时一并终止（杀 CLI 进程树/取消宿主智能体），避免孤儿继续写仓库
        stopDelegateWatch(runDir); // 委外就绪监听一并停止
        return sendJson(res, 200, { ok: true, message: "已停止（当前阶段执行完即停）" });
      }

      // —— 回退重跑：指定阶段及其后全部置为 pending，从该阶段重新推进 ——
      if (action === "rerun" && m === "POST") {
        const run = loadRun(runDir);
        if (!run) return sendJson(res, 404, { ok: false, message: "run 不存在" });
        if (run.status === "running") return sendJson(res, 400, { ok: false, message: "运行中的 Run 请先停止再回退" });
        const body = await readBody(req);
        const stage = String(body?.stage || "");
        const ids = STAGES.map((s) => s.id);
        if (!ids.includes(stage)) return sendJson(res, 400, { ok: false, message: "非法阶段: " + stage });
        const project0 = executionProject(loadProject(root, slug), run);
        const shimRcx = project0 ? { run, project: project0, stageCfgOf: (id) => stageCfgOf(project0, id) } : null;
        for (const s of STAGES) {
          const idx = ids.indexOf(s.id);
          if (idx >= ids.indexOf(stage)) {
            run.stages[s.id] = { status: "pending", attempts: run.stages[s.id]?.attempts || 0 };
            // A2 修复：被重置的委托阶段清空旧外部产物 —— 否则 delegateReady 误判就绪、P7 应用过期 patch
            if (shimRcx && stageDelegated(shimRcx, s.id)) purgeDelegateArtifacts(runDir, s.id);
          }
        }
        run.current = stage;
        run.status = "running";
        saveRun(runDir, run);
        stopDelegateWatch(runDir); // 旧监听作废（阶段已重置、产物已清场，等新产物重新就绪）
        sendJson(res, 200, { ok: true, message: "已从 " + stage + " 重跑" });
        setImmediate(() => drive(ctx, root, runDir));
        return;
      }

      // —— 删除：整目录移除（先落一个 stopped 状态让推进循环退出；孤儿产物由驱动循环兜底清理） ——
      if (!action && m === "DELETE") {
        if (!existsSync(runDir)) return sendJson(res, 404, { ok: false, message: "run 不存在" });
        const run = loadRun(runDir);
        if (run && (run.status === "running" || run.status === "awaiting_review")) {
          run.status = "stopped";
          saveRun(runDir, run); // 推进循环下一圈 loadRun 读到 stopped 即退出
        }
        stopDelegateWatch(runDir); // 停委外就绪监听，再丢弃会话
        runSessions.delete(runDir); // 丢弃共享 rcx（reviewComment 等），防复活
        stopExternals(runDir);
        try { rmTree(runDir); }
        catch (e) { return sendJson(res, 500, { ok: false, message: "删除失败: " + String((e && e.message) || e) }); }
        removeWorktree(root, slug, runId).catch(() => {}); // 尽力清理 per-Run worktree（孤儿可由 prune 收敛）
        return sendJson(res, 200, { ok: true, message: "已删除" });
      }

      if (action === "review" && m === "POST") {
        const body = await readBody(req);
        const run = loadRun(runDir);
        if (!run) return sendJson(res, 404, { ok: false, message: "run 不存在" });
        // 新 UI 将用户实际看到的复核上下文带回；兼容未发送这些字段的旧客户端。
        const stage = run.stages?.[run.current];
        const expected = {
          expectedStage: run.current,
          expectedStatus: run.status,
          expectedAttempt: stage?.attempts || 0,
          expectedStartedAt: stage?.startedAt || null,
        };
        if (Object.keys(expected).some(key => Object.hasOwn(body || {}, key) && body[key] !== expected[key])) {
          return sendJson(res, 409, { ok: false, message: "任务复核上下文已变化，请刷新并检查当前阶段后重新提交" });
        }
        const s = sessionFor(runDir);
        const rcx = s.rcx || (s.rcx = buildRcx(ctx, root, runDir, run));
        rcx.run = run;
        const [ok, msg] = await applyReview(rcx, { decision: body?.decision, comment: body?.comment });
        if (!ok) {
          // 达到复核上限时 applyReview 已将 Run 置为 failed；即使 API 立即返回错误，
          // 也要同步执行 P10，保证失败旁路与驱动阶段失败保持同一契约。
          if (run.status === "failed" && run.stages[run.current]?.error === msg) {
            await classifyFailure(ctx, runDir, rcx, run, msg);
          }
          return sendJson(res, 400, { ok: false, message: msg });
        }
        stopDelegateWatch(runDir); // 人工已决策，监听退出（避免与人工决策赛跑）
        sendJson(res, 200, { ok: true, message: msg });
        if (run.status === "running") setImmediate(() => drive(ctx, root, runDir)); // approve/reject 后继续推进
        return;
      }

      if (action === "rollback" && m === "POST") {
        const run = loadRun(runDir);
        // 运行中/待复核时禁止回滚：避免推进循环或后续阶段在半撤销的仓库上继续工作
        if (run && (run.status === "running" || run.status === "awaiting_review")) {
          return sendJson(res, 400, { ok: false, message: "Run 运行中/待复核，请先停止再回滚" });
        }
        const body = await readBody(req);
        const lineNo = Number(body?.lineNo);
        if (!Number.isInteger(lineNo) || lineNo < 0) return sendJson(res, 400, { ok: false, message: "lineNo 必须是合法行号" });
        const wtRepo = runRepoDir(root, slug, runId); // A3：补丁应用在 per-Run worktree，回滚也要对着它
        const repoPath = existsSync(join(wtRepo, ".git")) ? wtRepo : baseRepoDir(root, slug);
        try {
          await rollbackLedger(runDir, repoPath, lineNo);
        } catch (e) { return sendJson(res, 400, { ok: false, message: "回滚失败: " + String((e && e.message) || e) }); }
        return sendJson(res, 200, { ok: true });
      }

      // —— 在系统文件管理器中打开 run 产物目录 ——
      if (action === "open" && m === "POST") {
        if (!existsSync(runDir)) return sendJson(res, 404, { ok: false, message: "run 不存在" });
        // opener 可注入（测试传空函数，避免 npm test 真弹资源管理器）
        const openerFn = __testHooks?.opener || execFile;
        const opener = process.platform === "win32" ? "explorer" : process.platform === "darwin" ? "open" : "xdg-open";
        openerFn(opener, [runDir], { timeout: 10000 }, (err) => {
          // explorer 常返回非 0 成功码，不据此报错
          if (err && process.platform !== "win32") ctx.logger?.warn?.("issue2pr: 打开目录失败: " + err.message);
        });
        return sendJson(res, 200, { ok: true, message: "已请求打开产物目录" });
      }

      if (action === "tree" && m === "GET") {
        if (!existsSync(runDir)) return sendJson(res, 404, { ok: false, message: "run 不存在" });
        return sendJson(res, 200, { ok: true, files: listRunTree(runDir) });
      }

      if (action === "artifact" && m === "GET") {
        const rel = url.searchParams.get("path") || "";
        const tail = url.searchParams.get("tail") === "1";
        const full = url.searchParams.get("full") === "1";
        let text;
        try { text = readArtifact(runDir, rel); } // safeJoin 防 ..
        catch (e) { return sendJson(res, 400, { ok: false, message: (e && e.message) || String(e) }); }
        if (text == null) return sendJson(res, 404, { ok: false, message: "产物不存在: " + rel });
        const bytes = Buffer.byteLength(text, "utf8");
        if (bytes > 200 * 1024 && !tail && !full) return sendJson(res, 400, { ok: false, message: "文件超过 200KB 上限" });
        if (full && bytes > 5 * 1024 * 1024) return sendJson(res, 400, { ok: false, message: "文件超过 5MB 全量读取上限" });
        if (tail && bytes > 200 * 1024) {
          // 尾部读取：超限文件仅返回末尾片段（首行可能被截断，丢弃），供 UI 查看最近执行过程
          let sliced = text.slice(-120 * 1024);
          const nl = sliced.indexOf("\n");
          if (nl >= 0) sliced = sliced.slice(nl + 1);
          return sendJson(res, 200, { ok: true, text: sliced, truncated: true });
        }
        return sendJson(res, 200, { ok: true, text });
      }

      return sendJson(res, 404, { ok: false, message: "not found" });
    }

    sendJson(res, 404, { ok: false, message: "not found" });
  } catch (e) {
    sendJson(res, 500, { ok: false, message: "出错: " + String((e && e.message) || e) });
  }
}

// session 模式外部执行进度（每次现算不落盘；UI 3s 轮询本接口自动刷新）
// tasks 取自 P5 任务图节点数，patches 为 06-implementation/patches/*.diff 计数，report 即 coder-report.json
function externalProgress(runDir) {
  const dir = join(runDir, "06-implementation", "patches");
  let patches = 0;
  if (existsSync(dir)) patches = readdirSync(dir).filter((f) => f.endsWith(".diff")).length;
  let tasks = null;
  try { tasks = JSON.parse(readFileSync(join(runDir, "05-task-graph.json"), "utf8")).nodes.length; } catch { /* 任务图缺失时只报 patch 数 */ }
  return { patches, tasks, report: existsSync(join(runDir, "06-implementation", "coder-report.json")) };
}

export function apply(ctx, config = {}) {
  const root = __testHooks?.dataRoot || config.dataRoot || defaultDataRoot();
  // 启动恢复：把上次进程退出时遗留的 running Run 置为 stopped（仅测试钩子注入时跳过，交由用例自行构造）
  if (!__testHooks?.dataRoot) {
    try { recoverInterruptedRuns(root); }
    catch (e) { ctx.logger?.warn?.("issue2pr: 启动恢复失败: " + String((e && e.message) || e)); }
  }
  ctx.effect(() => ctx.webServer.register({
    kind: "prefix", path: "/issue2pr", handler: (req, res) => handleApi(ctx, root, req, res),
  }), "issue2pr: api routes");
  ctx.logger?.info?.(`issue2pr: API ready at /issue2pr/api/projects/* (dataRoot=${root})`);
}
