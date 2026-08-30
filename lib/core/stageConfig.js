// lib/stageConfig.js — 阶段级配置模型（能力表 / 默认提示词 / 合并 / 委托任务包）
// 配置存于 project.json 的 stageConfig 字段：{ P1: { prompts, provider, model,
// reasoningEffort, timeoutMs, maxTokens, delegate }, … }；未配置项回落默认值。
// STAGE_DEFS 的 prompts 与各阶段文件中的硬编码提示词保持 1:1（改默认值两处同步改）。
import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { readArtifact } from "./store.js";
import { readTriggerText } from "../stages/helpers.js";

const CODER_SYSTEM = [
  "你是 Coder Sub-Agent，纪律（superpowers）：",
  "1. TDD：涉及行为修改时先产出失败测试，再产出实现；",
  "2. 只输出 unified diff（--- a/ +++ b/），最小修改范围，永不整文件覆盖；",
  "3. 外科手术式改动：不顺手改进相邻代码；",
  "4. verify-before-claim：不得声称未验证的结论。",
].join("\n");

const P3_SYSTEM = [
  "你是 Code Understanding。基于候选文件的真实源码（每行前缀「行号|」为该文件真实行号）做深度调用链分析，",
  "输出中文 markdown，三个二级小节标题固定为「## 关键函数」「## 调用方」「## 潜在修改点」。要求：",
  "「## 关键函数」按文件分「### 相对路径」子节，每个函数一条：定位锚点（格式 `路径:行号`）+ 一句话职责",
  "+ 关键细节（参数含义、分支条件、常量取值、返回值、副作用），片段内看不到的明说「片段内不可见」；",
  "「## 调用方」按入口/主题分子节，每条链路完整写 A() → B() → C() 并逐步说明数据与控制流，",
  "候选文件之外的调用方标注「片段外，推测」；",
  "「## 潜在修改点」按与 Issue 目标的关联度降序排列，每条给：定位（文件+函数+`路径:行号` 锚点）/",
  "为什么关联 Issue/建议改法/影响面与风险。",
  "纪律：只依据提供的源码，不臆造行号、函数或调用关系；输入被截断的部分如实说明；宁详勿略，但重复与空话不写。",
].join("");

// 每阶段定义：name/desc（UI）；prompts（默认提示词，key ""=单角色）；
// caps（可配能力：route=模型/思考深度，exec=超时/maxTokens，delegate=委托外部，test=测试命令）；
// params（阶段专属工具参数元数据：def 默认值 / type string|number / label+unit 供 UI 渲染；
//         开源原则：凡影响执行行为的数值与路径不硬编码，一律在此声明并可被 project.json 覆盖）；
// delegateSpec（委托开放阶段的任务包构成：inputs 上游产物 / output 输出产物 / contract 输出契约）
export const STAGE_DEFS = {
  P1: {
    name: "IssueAnalyzer", desc: "Issue → 结构化契约",
    prompts: { "": "你是 IssueAnalyzer。把自然语言 Issue 提炼为结构化契约，只输出 JSON，不要输出其他文字。" },
    caps: { route: true, exec: true, delegate: true },
    delegateSpec: { inputs: "trigger", output: "01-issue-analysis.json",
      contract: '{"phenomenon":"现象","trigger":"触发条件","scope":["影响模块"],"success_criteria":["可验证成功标准"],"constraints":["约束"],"risk_level":"low|medium|high"}' },
  },
  P2: {
    name: "Search Layer", desc: "候选文件 + 证据",
    prompts: { "": "你是 Search Layer。根据 Issue 契约和仓库文件清单选出候选文件，每条必须给 SearchEvidence。只输出 JSON。" },
    caps: { route: true, exec: true, delegate: true },
    params: {
      repoScanMax: { def: 400, type: "number", label: "仓库清单扫描上限", unit: "个文件",
        hint: "P2 把文件清单喂给 LLM 选候选；超大仓库截断防 prompt 膨胀" },
    },
    delegateSpec: { inputs: ["01-issue-analysis.json", "repo"], output: "02-search-candidates.json",
      contract: '{"candidates":[{"path":"相对路径","role":"模块角色","evidence":"选择理由","confidence":"high|medium|low"}],"test_candidates":["测试文件"],"uncertain":["需进一步探索项"]}' },
  },
  P3: {
    name: "Code Understanding", desc: "调用链与修改点",
    prompts: { "": P3_SYSTEM },
    caps: { route: true, exec: true, delegate: true },
    params: {
      deepReadFiles: { def: 6, type: "number", label: "深读候选文件数", unit: "个",
        hint: "按 P2 候选置信度顺序取前 N 个读全文" },
      fileChars: { def: 6000, type: "number", label: "单文件读取上限", unit: "字",
        hint: "超长文件截断，防止上下文溢出" },
    },
    delegateSpec: { inputs: ["02-search-candidates.json", "repo"], output: "03-code-understanding.md",
      contract: "中文 markdown，含「## 关键函数」「## 调用方」「## 潜在修改点」三节；关键函数带 `路径:行号` 锚点与关键细节，调用方给完整链路（片段外标注推测），修改点按与 Issue 关联度排序并说明影响面" },
  },
  P4: {
    name: "Hypothesis", desc: "可验证根因假设",
    prompts: { "": "你是诊断模块。每个根因假设必须携带证据、验证文件与验证方法，禁止「我看着像」式结论。只输出 JSON。" },
    caps: { route: true, exec: true, delegate: true },
    delegateSpec: { inputs: ["03-code-understanding.md"], output: "04-hypotheses.json",
      contract: '{"hypotheses":[{"id":"A","title":"假设","evidence":"来自报告的证据","verify_file":"验证文件","verify_method":"可执行的验证方法"}]}' },
  },
  P5: {
    name: "Planner", desc: "TaskGraph 规划 · 复核门",
    prompts: { "": "你是 Planner。把修复任务拆成有依赖关系的 TaskGraph，每节点可独立验证。只输出 JSON。" },
    caps: { route: true, exec: true, delegate: true },
    delegateSpec: { inputs: ["04-hypotheses.json"], output: "05-task-graph.json",
      contract: '{"nodes":[{"id":"T1","title":"任务","input":"前置 artifact","output":"本任务 artifact","deps":["T0"],"success_criteria":"可验证通过条件","risk":"low|medium|high"}],"review_gate":"节点id","pr_gate":"节点id"}' },
  },
  P6: {
    name: "代码优化", desc: "多智能体协同 · 复核门",
    prompts: {
      planner: "你是多智能体 Planner。把 TaskGraph 节点派给 Coder，每单指定目标文件。只输出 JSON。",
      coder: CODER_SYSTEM,
      reviewer: "你是 Reviewer Sub-Agent。审 diff：范围是否最小、是否越权、是否遗漏调用方。只输出 JSON。",
    },
    caps: { route: true, exec: true, delegate: true },
    params: {
      claudeBin: { def: "", type: "string", label: "claude 可执行文件",
        hint: "委托 Claude Code 模式用；留空 = 自动探测（PATH → 常见安装位置）。开源环境路径各异，建议显式填写，如 C:\\Users\\you\\AppData\\Roaming\\npm\\claude.cmd" },
      claudeTimeoutMin: { def: 120, type: "number", label: "claude 执行超时", unit: "分钟",
        hint: "无人值守执行任务包的最长等待；超时回退等人工会话" },
      claudeAuthPreset: { def: "none", type: "string", label: "claude 认证预设", options: ["none", "glm", "custom"],
        hint: "none=继承本机 claude 登录态；glm=GLM Coding Plan 的 Anthropic 兼容端点（token 存全局 relay-auth.json，厂商端点无 IP 白名单，403 根治）；custom=自建网关 baseUrl" },
      claudeBaseUrl: { def: "", type: "string", label: "自定义中转 baseUrl",
        hint: "claudeAuthPreset=custom 时生效；ANTHROPIC_BASE_URL 指向网关根（不带 /v1/messages），如 https://gw.example.com/api/anthropic" },
      claudeRelayModel: { def: "glm-5.3", type: "string", label: "GLM 中转模型",
        hint: "claudeAuthPreset=glm 时生效；会连模型映射（ANTHROPIC_MODEL/DEFAULT_*）一并覆盖，用户 settings 里别家端点的模型名会 1214 报错" },
      claudePermission: { def: "acceptEdits", type: "string", label: "claude 权限档位", options: ["acceptEdits", "bypass", "dontAsk"],
        hint: "acceptEdits=文件编辑自动放行+Bash/检索宽白名单（默认）；bypass=旧行为 --dangerously-skip-permissions；dontAsk=未允许即拒（最严）" },
    },
    delegateSpec: { inputs: ["05-task-graph.json"], output: "06-implementation/",
      contract: "patches/*.diff（unified diff）逐任务一份 + coder-report.json（含 patches 清单与结论）" },
  },
  P7: {
    name: "Patch Pipeline", desc: "版本校验 → 落盘 + ledger",
    prompts: {}, caps: {},
  },
  P8: {
    name: "TestRunner", desc: "沙箱真实执行",
    prompts: {}, caps: { exec: true, test: true },
  },
  P9: {
    name: "Reviewer", desc: "三维门控审查 · 复核门",
    prompts: { "": "你是 Reviewer Agent。三维门控：①Diff 范围（过大/越权/遗漏调用方）②API 与安全 ③测试补强与说明忠实。测试通过 ≠ 可合并。只输出 JSON。" },
    caps: { route: true, exec: true, delegate: true },
    params: {
      diffChars: { def: 1200, type: "number", label: "diff 每文件载入上限", unit: "字",
        hint: "审查时每份 diff 只载入头部 N 字（路径 + hunk 概览足够范围裁决）；调大更全面但易撑爆 prompt" },
    },
    delegateSpec: { inputs: ["06-implementation/coder-report.json", "07-test-report.json"], output: "08-review-report.json",
      contract: '{"diff_scope":"结论","api_security":"结论","tests":"结论","verdict":"pass|fail"}' },
  },
  P10: {
    name: "FailureClassifier", desc: "失败旁路 · 仅失败时执行",
    prompts: { "": "你是 FailureClassifier。把失败归入六类之一并给出处理路径。只输出 JSON。" },
    caps: { route: true, exec: true, delegate: true },
    delegateSpec: { inputs: "failure", output: "09-failure-analysis.json",
      contract: '{"category":"类别（实现错误/根因错误/测试选择/环境缺失/权限被拒/反复失败）","detail":"依据","action":"replan|rollback|escalate"}' },
  },
  P11: {
    name: "PRBuilder + Eval", desc: "PR 说明 + Gate 评测 · 复核门",
    prompts: {
      desc: "你是 PRBuilder。生成忠实反映修改与验证过程的 PR 说明（中文 markdown）：背景/根因/修改点/验证证据/风险。禁止夸大。",
      gate: "你是 EvaluationRunner。按 Gate 六项判定：ROOT 根因有证据 / PATCH 干净应用 / TEST 无回归 / DIFF 可审查 / DESC 说明忠实 / ACCEPT 门控通过。只输出 JSON。",
    },
    caps: { route: true, exec: true, delegate: true },
    delegateSpec: { inputs: ["01-issue-analysis.json", "08-review-report.json", "07-test-report.json"], output: "10-pr-description.md",
      contract: "10-pr-description.md（中文 markdown PR 说明）+ 11-eval-report.json（{\"ROOT\":\"pass|fail\",…六项}）" },
  },
};

export const DEFAULT_LLM_TIMEOUT_MS = 300000; // 5 分钟（与历史行为一致）
export const DEFAULT_TEST_TIMEOUT_MS = 300000;

// —— 合并：用户配置覆盖默认；任何缺省回落 ——
// params 合并规则：按 STAGE_DEFS 元数据逐键取（用户值 ?? def），未知键忽略
export function stageCfgOf(project, stageId) {
  const def = STAGE_DEFS[stageId] || {};
  const user = (project && project.stageConfig && project.stageConfig[stageId]) || {};
  const prompts = {};
  for (const key of Object.keys(def.prompts || {})) prompts[key] = (user.prompts && user.prompts[key]) || def.prompts[key];
  const params = {};
  for (const [k, meta] of Object.entries(def.params || {})) {
    const uv = user.params && user.params[k];
    params[k] = meta.type === "string"
      ? (uv != null && uv !== "" ? String(uv) : meta.def)
      : (Number.isFinite(Number(uv)) && Number(uv) > 0 ? Number(uv) : meta.def);
  }
  return {
    prompts,
    params,
    provider: user.provider || "",
    model: user.model || "",
    reasoningEffort: user.reasoningEffort || "",
    timeoutMs: Number(user.timeoutMs) > 0 ? Number(user.timeoutMs) : 0,
    maxTokens: Number(user.maxTokens) > 0 ? Number(user.maxTokens) : 0,
    delegate: {
      mode: (user.delegate && user.delegate.mode) || "off",
      agent: (user.delegate && user.delegate.agent) || "",
      brief: (user.delegate && user.delegate.brief) || "",
    },
  };
}

// 阶段执行器取提示词：rcx.stageCfgOf(id).prompts[key]（stageCfgOf 由 buildRcx 注入；缺省时回落 STAGE_DEFS 默认）
export function sysOf(rcx, stageId, key) {
  const cfg = typeof rcx.stageCfgOf === "function" ? rcx.stageCfgOf(stageId) : null;
  return (cfg && cfg.prompts && cfg.prompts[key || ""]) || STAGE_DEFS[stageId].prompts[key || ""];
}

// 阶段执行器取专属工具参数（裸 rcx 单测无 stageCfgOf 时回落 STAGE_DEFS 默认值）
export function paramsOf(rcx, stageId) {
  const cfg = typeof rcx.stageCfgOf === "function" ? rcx.stageCfgOf(stageId) : null;
  if (cfg && cfg.params) return cfg.params;
  const out = {};
  for (const [k, m] of Object.entries((STAGE_DEFS[stageId] || {}).params || {})) out[k] = m.def;
  return out;
}

// LLM 路由/执行覆盖（makeLlm 的 overridesOf 用）
export function routeOverridesOf(rcx) {
  const cfg = rcx.stageCfgOf();
  return {
    provider: cfg.provider || "",
    model: cfg.model || "",
    reasoningEffort: cfg.reasoningEffort || "",
    timeoutMs: cfg.timeoutMs || 0,
    maxTokens: cfg.maxTokens || 0,
  };
}

// —— 校验（validateProject 调用；宽松策略：只查形态，不限制自由文本） ——
export function validateStageConfig(sc) {
  if (sc === undefined || sc === null) return [true, "ok"];
  if (typeof sc !== "object" || Array.isArray(sc)) return [false, "stageConfig 必须是对象"];
  for (const [id, cfg] of Object.entries(sc)) {
    if (!STAGE_DEFS[id]) return [false, "stageConfig 含未知阶段: " + id];
    if (cfg === null || typeof cfg !== "object") return [false, "stageConfig." + id + " 必须是对象"];
    for (const field of ["provider", "model", "reasoningEffort"]) {
      const v = cfg[field];
      if (v !== undefined && v !== null && typeof v !== "string") return [false, `stageConfig.${id}.${field} 必须是字符串`];
    }
    for (const field of ["timeoutMs", "maxTokens"]) {
      const v = cfg[field];
      if (v !== undefined && v !== null && (typeof v !== "number" || !Number.isFinite(v) || v < 0)) {
        return [false, `stageConfig.${id}.${field} 必须是非负数字`];
      }
    }
    if (cfg.prompts !== undefined) {
      if (typeof cfg.prompts !== "object" || cfg.prompts === null || Array.isArray(cfg.prompts)) {
        return [false, `stageConfig.${id}.prompts 必须是对象`];
      }
      for (const v of Object.values(cfg.prompts)) {
        if (typeof v !== "string") return [false, `stageConfig.${id}.prompts 的值必须是字符串`];
      }
    }
    if (cfg.params !== undefined && cfg.params !== null) {
      if (typeof cfg.params !== "object" || Array.isArray(cfg.params)) {
        return [false, `stageConfig.${id}.params 必须是对象`];
      }
      const defParams = (STAGE_DEFS[id] && STAGE_DEFS[id].params) || {};
      for (const [k, v] of Object.entries(cfg.params)) {
        const meta = defParams[k];
        if (!meta) return [false, `stageConfig.${id}.params 含未知参数: ${k}`];
        if (meta.type === "string") {
          if (typeof v !== "string") return [false, `stageConfig.${id}.params.${k} 必须是字符串`];
          if (meta.options && !meta.options.includes(v)) return [false, `stageConfig.${id}.params.${k} 仅允许 ${meta.options.join("|")}`];
        } else if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) {
          return [false, `stageConfig.${id}.params.${k} 必须是正数`];
        }
      }
    }
    if (cfg.delegate !== undefined && cfg.delegate !== null) {
      const d = cfg.delegate;
      if (typeof d !== "object") return [false, `stageConfig.${id}.delegate 必须是对象`];
      if (d.mode !== undefined && !["off", "session"].includes(d.mode)) {
        return [false, `stageConfig.${id}.delegate.mode 仅允许 off|session`];
      }
      if (d.agent !== undefined && typeof d.agent !== "string") return [false, `stageConfig.${id}.delegate.agent 必须是字符串`];
      if (d.brief !== undefined && typeof d.brief !== "string") return [false, `stageConfig.${id}.delegate.brief 必须是字符串`];
    }
  }
  return [true, "ok"];
}

// —— 委托外部智能体：阶段不再本机调 LLM，而是产出任务包交外部智能体执行，
//    复核门按产出就绪判定放行 ——
// P6 与项目页「P6 执行模式」联动：p6Mode=session（人工外部会话）/ claude（claude CLI
// 自动执行）/ 委托开关任一开启，均为委托态
export function stageDelegated(rcx, stageId) {
  const def = STAGE_DEFS[stageId];
  if (!def || !def.caps.delegate) return false;
  // p6Mode 在 rcx 顶层（buildRcx）或 run 上（裸 rcx 单测）都可能出现
  const p6m = rcx.p6Mode || (rcx.run && rcx.run.p6Mode);
  if (stageId === "P6" && (p6m === "session" || p6m === "claude")) return true;
  // stageCfgOf 由 buildRcx 注入；裸 rcx（单测）回落"未开启委托"
  const cfg = typeof rcx.stageCfgOf === "function" ? rcx.stageCfgOf(stageId) : null;
  return !!(cfg && cfg.delegate && cfg.delegate.mode === "session");
}

export async function buildDelegateTask(rcx, stageId) {
  const def = STAGE_DEFS[stageId];
  const spec = def.delegateSpec;
  const cfg = rcx.stageCfgOf(stageId);
  const lines = [
    `# ${stageId} ${def.name} · 外部智能体任务包`, "",
    `- 阶段职责：${def.desc}`,
    `- 输出产物：\`${spec.output}\`（就绪后人工通过复核门，流水线继续）`,
    `- 输出契约：${spec.contract}`, "",
  ];
  // 输入：trigger=触发原文 / failure=失败信息 / 产物路径列表 / repo=本地仓库
  const inputs = Array.isArray(spec.inputs) ? spec.inputs : [spec.inputs];
  for (const inp of inputs) {
    if (inp === "trigger") {
      lines.push(`## 输入 · 触发原文`, "```markdown", String(await readTriggerText(rcx)).slice(0, 8000), "```", "");
    } else if (inp === "failure") {
      lines.push(`## 输入 · 失败信息`, "```json", JSON.stringify(rcx.failure || {}, null, 2), "```", "");
    } else if (inp === "repo") {
      lines.push(`## 输入 · 本地仓库`, `\`${rcx.repoDir}\`（在仓库中检索/阅读源码）`, "");
    } else {
      const text = readArtifact(rcx.runDir, inp);
      lines.push(`## 输入 · ${inp}`, "```", String(text == null ? "（缺失）" : text).slice(0, 12000), "```", "");
    }
  }
  if (rcx.reviewComment) lines.push(`## 打回意见（必须修正）`, rcx.reviewComment, "");
  if (cfg.delegate.agent) lines.push(`## 指定智能体`, cfg.delegate.agent, "");
  if (cfg.delegate.brief) lines.push(`## 附加要求（委托人填写）`, cfg.delegate.brief, "");
  return lines.join("\n");
}

// 委托产出就绪判定（applyReview 拦截空产出放行用）：
// P6 维持 patches/coder-report 口径；其余 = 阶段产物文件已落盘
export function delegateReady(runDir, stageId) {
  if (stageId === "P6") {
    const out = runDir + "/06-implementation";
    return delegateReadyFromFile(runDir, "06-implementation/coder-report.json") ||
      delegateReadyFromDir(runDir, "06-implementation/patches", ".diff");
  }
  const output = STAGE_DEFS[stageId]?.delegateSpec?.output;
  if (!output) return true;
  return delegateReadyFromFile(runDir, output);
}

function delegateReadyFromFile(runDir, rel) {
  return readArtifact(runDir, rel) != null;
}
function delegateReadyFromDir(runDir, rel, ext) {
  const dir = join(runDir, rel);
  return existsSync(dir) && readdirSync(dir).some((f) => f.endsWith(ext));
}

// 清空委托阶段的外部产出（打回 / 回退重跑时调用，返回被清除的产物相对路径清单）。
// 不清理旧产物的后果：delegateReady 误判"外部已交付"（复核门形同虚设），
// P7 把过期 patch 当作本轮补丁应用（打回意见等于没有生效）。任务包（session-task.md 等）保留，
// 由阶段执行器重跑时重新生成。
export function purgeDelegateArtifacts(runDir, stageId) {
  const removed = [];
  const kill = (rel) => {
    try { rmSync(join(runDir, rel), { force: true, recursive: true }); removed.push(rel); } catch { /* 尽力 */ }
  };
  if (stageId === "P6") {
    kill("06-implementation/coder-report.json");
    const dir = join(runDir, "06-implementation", "patches");
    if (existsSync(dir)) {
      for (const f of readdirSync(dir)) if (f.endsWith(".diff")) kill("06-implementation/patches/" + f);
    }
    return removed;
  }
  const output = STAGE_DEFS[stageId]?.delegateSpec?.output;
  if (output && !output.endsWith("/")) kill(output); // 目录型产物仅 P6；其余委托阶段产物为文件
  return removed;
}
