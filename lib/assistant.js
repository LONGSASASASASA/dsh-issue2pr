// lib/assistant.js — 悬浮智能助手的上下文聚合（每次提问时现读，不落盘不缓存）
// focus 来自前端 viewStore：{ nav, slug, runId }（用户当前所在页面 / 选中项目 / 选中 Run）
import { join } from "node:path";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { listProjects, readArtifact, loadSettings, executionProject } from "./core/store.js";
import { loadRun } from "./core/pipeline.js";
import { STAGE_DEFS } from "./core/stageConfig.js";

export const ASSISTANT_SYSTEM_HEAD = [
  "你是 Issue2PR 插件（运行在 DSH 宿主里）内置的智能助手，悬浮在工作台右上角，",
  "职责是解答用户对这个工作台的提问、疑惑，以及运行过程中的状态询问。",
  "",
  "回答守则：",
  "1. 回答运行状态类问题（跑到哪了/为什么失败/卡住了吗）时，只依据下方「实时上下文」，不要臆造；上下文里没有的信息就明说「当前上下文里没有」，并建议用户先在项目页选中项目或运行页选中 Run。",
  "2. 概念类问题（P1-P11 是什么、复核门、外部委托、reviewMode 等）可基于你对插件设计的理解回答，下方附有阶段速查表。",
  "3. 用户提到「这个项目/这个 Run」时，优先理解为实时上下文里「当前聚焦」的部分。",
  "4. 用简体中文，简洁直接，先给结论；操作路径为顶部项目/任务/设置；任务详情含执行过程/整体验证/交付/文件，帮助在顶部。全局设置仅作用于新任务，已有任务使用启动快照。",
  "5. 不要编造不存在的功能或数据。",
].join("\n");

// 上下文总长保护：超出时优先保住「聚焦 Run + 最近事件」（截断在末尾按序丢弃全局部分）
const MAX_CONTEXT_CHARS = 12000;
const EVENT_TAIL = 30;
const EVENT_DETAIL_CHARS = 300;

const NAV_LABELS = {
  projects: "项目页", runs: "任务页", artifacts: "任务文件", config: "全局设置", guide: "使用帮助",
};

// session/claude 模式外部执行进度（口径与 index.js externalProgress 一致：不 import 是为避免循环依赖）
function externalProgressOf(runDir) {
  const dir = join(runDir, "06-implementation", "patches");
  let patches = 0;
  if (existsSync(dir)) patches = readdirSync(dir).filter((f) => f.endsWith(".diff")).length;
  let tasks = null;
  try { tasks = JSON.parse(readFileSync(join(runDir, "05-task-graph.json"), "utf8")).nodes.length; } catch { /* 缺任务图时只报 patch 数 */ }
  return { patches, tasks, report: existsSync(join(runDir, "06-implementation", "coder-report.json")) };
}

// 单项目最近一个 Run 摘要（runId 前缀即时间戳，目录名字典序 = 时间序，取最后一个）
function latestRunOf(root, slug) {
  const runsDir = join(root, "projects", slug, "runs");
  if (!existsSync(runsDir)) return null;
  const ids = readdirSync(runsDir).filter((id) => existsSync(join(runsDir, id, "run.json"))).sort();
  if (!ids.length) return null;
  const run = loadRun(join(runsDir, ids[ids.length - 1]));
  return run ? { id: run.id, status: run.status, current: run.current, createdAt: run.createdAt, _dir: join(runsDir, ids[ids.length - 1]) } : null;
}

function stageTable(run) {
  return STAGES_LINE.map(([id, name, desc]) => {
    const st = run.stages[id] || {};
    return `- ${id} ${name}（${desc}）：${st.status || "pending"}`
      + (st.error ? `，错误: ${String(st.error).slice(0, 200)}` : "");
  }).join("\n");
}
const STAGES_LINE = Object.entries(STAGE_DEFS).map(([id, def]) => [id, def.name, def.desc]);

function eventTail(runDir) {
  const raw = readArtifact(runDir, "trace/events.jsonl");
  if (!raw) return [];
  const lines = raw.split("\n").filter((l) => l.trim());
  return lines.slice(-EVENT_TAIL).map((l) => {
    try {
      const e = JSON.parse(l);
      const detail = String(e.detail == null ? "" : e.detail).slice(0, EVENT_DETAIL_CHARS);
      return `[${String(e.at || "")}] ${e.stage || ""} ${e.name || ""}${e.ok === false ? "（失败）" : ""}${detail ? "\n  " + detail.replace(/\n/g, "\n  ") : ""}`;
    } catch { return null; }
  }).filter(Boolean);
}

export function buildAssistantContext(root, focus = {}) {
  const out = [];
  const push = (s) => out.push(s);

  // —— 0. 用户当前位置 ——
  const navLabel = NAV_LABELS[focus.nav] || (focus.nav ? String(focus.nav) : "未知");
  push(`## 用户当前位置\n正在看「${navLabel}」；选中项目：${focus.slug || "（未选中）"}；选中 Run：${focus.runId || "（未选中）"}。`);

  // —— 1. 全局：所有项目概要（最多 10 个，每个带最近 Run 状态） ——
  const projects = listProjects(root);
  const settings = loadSettings(root);
  push(`\n## 全局新任务设置\n版本=${settings.revision}；reviewMode=${settings.reviewMode}；P6 模式=${settings.p6Mode}；测试命令=${settings.testCommand || "自动探测"}；自定义阶段=${Object.keys(settings.stageConfig || {}).join("、") || "无"}。只适用于新任务。`);
  push("\n## 全局：项目概要（共 " + projects.length + " 个）");
  if (!projects.length) push("（还没有项目。用户可在「项目」页新建。）");
  for (const p of projects.slice(0, 10)) {
    const trig = (p.triggers || []).map((t) => t.kind + " " + t.uri).join("；") || "（无）";
    const last = latestRunOf(root, p.slug);
    push(`- ${p.name}（slug: ${p.slug}）；新任务采用全局设置；触发源：${trig}`
      + (last ? `；最近 Run ${last.id}（${String(last.createdAt || "").slice(0, 19)}）状态=${last.status}，当前阶段=${last.current}` : "；尚无 Run"));
  }

  // —— 2. 聚焦项目配置摘要 ——
  if (focus.slug && /^[a-z0-9-]+$/.test(focus.slug)) {
    const p = projects.find((x) => x.slug === focus.slug);
    if (p) {
      const repos = (p.repos || []).map((r) => r.uri).join("；");
      push(`\n## 当前聚焦项目：${p.name}（${p.slug}）`);
      push(`仓库：${repos}`);
      push("项目保存仓库和触发源；新任务执行配置取自全局设置。");
    }
  }

  // —— 3. 聚焦 Run 状态机 + 外部执行进度 + 最近事件 ——
  if (focus.slug && focus.runId && /^[a-z0-9-]+$/.test(focus.slug) && /^\d{8}-\d{6}-[a-z0-9-]+$/.test(focus.runId)) {
    const runsDir = join(root, "projects", focus.slug, "runs", focus.runId);
    const run = loadRun(runsDir);
    if (run) {
      push(`\n## 当前聚焦 Run：${run.id}`);
      push(`状态=${run.status}；当前阶段=${run.current}；创建于 ${run.createdAt}；reviewMode=${run.reviewMode}；P6 模式=${run.p6Mode}；触发源：${run.trigger?.kind || ""} ${run.trigger?.uri || ""}`);
      const effective = executionProject(projects.find(p => p.slug === focus.slug), run);
      push(run.executionConfig
        ? `配置来源：启动快照 v${run.executionConfig.revision}；默认模型=${run.executionConfig.defaultRoute?.model || "未记录"}；后续全局修改不影响此任务。`
        : "配置来源：历史任务无启动快照，兼容读取旧项目执行配置；不能据当前配置推断历史执行参数。");
      push(`测试命令=${effective?.testCommand || "自动探测"}；自定义阶段=${Object.keys(effective?.stageConfig || {}).join("、") || "无"}`);
      if (run.externalExec) {
        const e = run.externalExec;
        push(`外部执行：executor=${e.executor || "?"}，status=${e.status || "?"}`
          + (e.statsSummary ? `，${e.statsSummary}` : "")
          + (e.error ? `，错误: ${String(e.error).slice(0, 200)}` : ""));
      }
      if (["session", "claude", "dsh"].includes(run.p6Mode)) {
        const ep = externalProgressOf(runsDir);
        push(`外部进度：patch ${ep.patches}${ep.tasks != null ? "/" + ep.tasks : ""} 份，coder-report ${ep.report ? "已生成" : "未生成"}`);
      }
      push("\n### 各阶段状态");
      push(stageTable(run));
      const evs = eventTail(runsDir);
      if (evs.length) {
        push(`\n### 最近事件（${evs.length} 条，按时间序）`);
        push(evs.join("\n"));
      }
    }
  }

  // —— 4. 概念速查 ——
  push("\n## 阶段速查表（P1-P11 流水线）");
  for (const [id, def] of Object.entries(STAGE_DEFS)) push(`- ${id} ${def.name}：${def.desc}`);

  const text = out.join("\n");
  return text.length > MAX_CONTEXT_CHARS ? text.slice(0, MAX_CONTEXT_CHARS) + "\n…（上下文过长已截断）" : text;
}
