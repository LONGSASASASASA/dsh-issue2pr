// tests/smoke.mjs — 前端渲染冒烟（不入 npm test）：mock React（含 deps 语义）真实渲染 Section 四个视图。
// 运行：node tests/smoke.mjs
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import assert from "node:assert/strict";

// ---------- 极简 React mock ----------
// 函数组件立即执行；hooks 按 (组件, 序号) 存态；useEffect 带 deps 语义（deps 变化才执行）。
let uidSeq = 0, curComp = "root", hookSeq = 0, effectSeq = 0;
const hookCells = new Map();
const effectCells = new Map();
function useState(init) {
  const key = curComp + ":s" + (hookSeq++);
  if (!hookCells.has(key)) {
    const cell = { v: typeof init === "function" ? init() : init };
    cell.set = (nv) => { cell.v = typeof nv === "function" ? nv(cell.v) : nv; };
    hookCells.set(key, cell);
  }
  const cell = hookCells.get(key);
  return [cell.v, cell.set];
}
function useEffect(fn, deps) {
  const key = curComp + ":e" + (effectSeq++);
  const prev = effectCells.get(key);
  const changed = !prev || !deps || deps.length !== prev.length || deps.some((d, i) => d !== prev[i]);
  if (changed) { effectCells.set(key, deps || []); fn(); }
}
const useRef = (v) => ({ current: v });
const useCallback = (fn) => fn;
function h(type, props, ...children) {
  if (typeof type === "function") {
    if (!type.__uid) type.__uid = ++uidSeq;
    const prev = curComp, hs = hookSeq, es = effectSeq;
    curComp = type.__uid; hookSeq = 0; effectSeq = 0;
    try { return type(props || {}); } finally { curComp = prev; hookSeq = hs; effectSeq = es; }
  }
  return { type, props: props || {}, children: children.flat(9) };
}
const miniReact = { createElement: h, useState, useEffect, useLayoutEffect: useEffect, useRef, useCallback };
// 官方 UI 原语 mock：MarkdownText 渲染为占位 div（smoke 只验布局结构，不验 MD 排版）
const primitives = { MarkdownText: (props) => ({ type: "div", props: { "data-md": 1 }, children: [String(props && props.text || "")] }) };

// ---------- fetch mock：按 URL 分发 ----------
const iso = (s) => new Date(Date.parse("2026-08-28T04:00:00Z") + s * 1000).toISOString();
// ui-state 服务端兜底记忆（视图 8b 用；POST 会更新它，模拟宿主端文件）
let serverUiState = { lastProject: null };
// Git 托管连接 + 环境预检 stub（视图 9 用；preflight 可变以测横幅）
let serverConnections = [
  { id: "gitlab.example.com", kind: "gitlab", host: "gitlab.example.com", token: "glt_…9f2e" },
];
let serverPreflight = { git: { ok: true, version: "git version 2.50.0" }, claude: { ok: true, path: "C:\\bin\\claude.cmd" }, llm: { provider: "glm", model: "glm-5.2", source: "host", overrides: {} } };
const fakeRun = {
  id: "r1", project: "p", status: "awaiting_review", current: "P5",
  trigger: { kind: "issue", uri: "D:\\x.md" }, reviewMode: "key-only", p6Mode: "builtin",
  stages: {
    P1: { status: "approved", startedAt: iso(0), finishedAt: iso(3) },
    P2: { status: "approved", startedAt: iso(4), finishedAt: iso(6) },
    P3: { status: "approved", startedAt: iso(6), finishedAt: iso(9) },
    P4: { status: "approved", startedAt: iso(9), finishedAt: iso(11) },
    P5: { status: "awaiting_review", attempts: 1, startedAt: iso(12) },
  },
};
globalThis.window = globalThis; // document 不定义：client 内有 typeof 守卫
globalThis.fetch = (url, opts) => {
  const u = String(url);
  let body = { ok: true };
  if (/\/assistant\/ask/.test(u)) { // 智能助手：伪流式 NDJSON（两段 delta + done）
    const lines = [JSON.stringify({ delta: "当前 Run 停在 P5 " }) + "\n", JSON.stringify({ delta: "待复核。" }) + "\n", JSON.stringify({ done: true }) + "\n"];
    let i = 0;
    return Promise.resolve({ ok: true, body: { getReader() {
      return { read: () => Promise.resolve(i < lines.length ? { done: false, value: Buffer.from(lines[i++]) } : { done: true }) };
    } } });
  }
  if (/\/ui-state/.test(u)) {
    if (opts && opts.body) { try { serverUiState = { lastProject: JSON.parse(opts.body).lastProject || null }; } catch { /* 忽略 */ } }
    body = { ok: true, state: serverUiState };
  } else if (/\/stage-defaults/.test(u)) {
    body = { ok: true, defaults: {
      llmTimeoutMs: 300000, testTimeoutMs: 300000, maxTokens: 8192,
      stages: Object.fromEntries([
        ["P1", { name: "IssueAnalyzer", desc: "Issue → 结构化契约", caps: { route: true, exec: true, delegate: true }, prompts: { "": "你是 IssueAnalyzer。把自然语言 Issue 提炼为结构化契约，只输出 JSON，不要输出其他文字。" }, delegateSpec: { inputs: "trigger", output: "01-issue-analysis.json", contract: "{}" } }],
        ["P2", { name: "Search Layer", desc: "候选文件 + 证据", caps: { route: true, exec: true, delegate: true }, prompts: { "": "你是 Search Layer。" }, delegateSpec: { output: "02-search-candidates.json", contract: "{}" } }],
        ["P3", { name: "Code Understanding", desc: "调用链与修改点", caps: { route: true, exec: true, delegate: true }, prompts: { "": "你是 Code Understanding。" }, delegateSpec: { output: "03-code-understanding.md", contract: "md" } }],
        ["P4", { name: "Hypothesis", desc: "可验证根因假设", caps: { route: true, exec: true, delegate: true }, prompts: { "": "你是诊断模块。" }, delegateSpec: { output: "04-hypotheses.json", contract: "{}" } }],
        ["P5", { name: "Planner", desc: "TaskGraph 规划 · 复核门", caps: { route: true, exec: true, delegate: true }, prompts: { "": "你是 Planner。" }, delegateSpec: { output: "05-task-graph.json", contract: "{}" } }],
        ["P6", { name: "代码优化", desc: "多智能体协同 · 复核门", caps: { route: true, exec: true, delegate: true }, prompts: { planner: "派单", coder: "编码", reviewer: "门控" }, delegateSpec: { output: "06-implementation/", contract: "diffs" } }],
        ["P7", { name: "Patch Pipeline", desc: "版本校验 → 落盘 + ledger", caps: {}, prompts: {} }],
        ["P8", { name: "TestRunner", desc: "沙箱真实执行", caps: { exec: true, test: true }, prompts: {} }],
        ["P9", { name: "Reviewer", desc: "三维门控审查 · 复核门", caps: { route: true, exec: true, delegate: true }, prompts: { "": "你是 Reviewer Agent。" }, delegateSpec: { output: "08-review-report.json", contract: "{}" } }],
        ["P10", { name: "FailureClassifier", desc: "失败旁路 · 仅失败时执行", caps: { route: true, exec: true, delegate: true }, prompts: { "": "你是 FailureClassifier。" }, delegateSpec: { output: "09-failure-analysis.json", contract: "{}" } }],
        ["P11", { name: "PRBuilder + Eval", desc: "PR 说明 + Gate 评测 · 复核门", caps: { route: true, exec: true, delegate: true }, prompts: { desc: "PR 说明", gate: "Gate 评测" }, delegateSpec: { output: "10-pr-description.md", contract: "md" } }],
      ]),
    } };
  } else if (/\/runs\/r1\/artifact/.test(u)) {
    body = { ok: true, text: /events\.jsonl/.test(u)
      ? JSON.stringify({ at: iso(10), stage: "P5", kind: "llm", name: "deepseek-v4-pro", detail: "prompt 800 字 → 响应 400 字\n【prompt】把修复任务拆成 TaskGraph…\n——\n【响应】{\"nodes\":[…]}", ms: 5200, ok: true }) + "\n"
      : /reviews\//.test(u) ? JSON.stringify({ stage: "P1", decision: "approve", comment: "", at: iso(5) }) : "{}" };
  } else if (/\/runs\/r1\/tree/.test(u)) {
    body = { ok: true, files: [{ path: "run.json", size: 10, mtimeMs: 1 }, { path: "reviews/1-approve-P1.json", size: 10, mtimeMs: 1 }, { path: "trace/events.jsonl", size: 10, mtimeMs: 1 }, { path: "ledger/patch-ledger.jsonl", size: 10, mtimeMs: 1 }] };
  } else if (/\/runs\/r1$/.test(u)) {
    body = fakeRun;
  } else if (/\/runs$/.test(u)) {
    body = { ok: true, runs: [{ id: "r1", status: "awaiting_review", current: "P5", trigger: fakeRun.trigger }] };
  } else if (/\/connections\/test-repo/.test(u)) {
    body = { ok: true, matched: null, message: "可达（3 个分支，匿名访问，未匹配连接）" };
  } else if (/\/connections\/test/.test(u)) {
    body = { ok: true, account: "octocat" };
  } else if (/\/connections/.test(u)) {
    body = (opts && opts.method === "DELETE") ? { ok: true } : { ok: true, connections: serverConnections };
  } else if (/\/preflight/.test(u)) {
    body = { ok: true, preflight: serverPreflight };
  } else if (/\/check-local/.test(u)) {
    let ex = false;
    try { ex = String(JSON.parse((opts && opts.body) || "{}").path || "").endsWith("x.md"); } catch { /* 忽略 */ }
    body = { ok: true, exists: ex };
  } else if (/\/projects$/.test(u)) {
    body = { ok: true, projects: [
      { name: "P 项目", slug: "p", repos: [{ uri: "https://p.git" }], triggers: [{ kind: "issue", uri: "D:\\x.md" }],
        reviewMode: "every", p6Mode: "builtin", testCommand: "" },
      { name: "演示", slug: "demo", repos: [{ uri: "https://x.git" }], triggers: [],
        reviewMode: "every", p6Mode: "builtin", testCommand: "",
        stageConfig: { P1: { prompts: { "": "自定义 P1 提示词" } } } },
      { name: "云仓库", slug: "cloud", repos: [{ uri: "https://gitlab.example.com/o/r.git" }], triggers: [],
        reviewMode: "every", p6Mode: "claude", testCommand: "" },
    ] };
  }
  return Promise.resolve({ json: () => Promise.resolve(body) });
};

// ---------- 载入 client.js 并执行 apply ----------
let modExports = null;
const lsStore = {}; // 可写 localStorage：navStore 持久化 / 项目选中记忆
globalThis.localStorage = {
  getItem: (k) => (k in lsStore ? lsStore[k] : null),
  setItem: (k, v) => { lsStore[k] = String(v); },
  removeItem: (k) => { delete lsStore[k]; },
};
globalThis.document = { // 拖宽手柄事件委托 / WorkbenchPage anchor 探测（smoke 环境无 DOM，事件 no-op、anchor 给固定 rect）
  addEventListener() {}, removeEventListener() {},
  querySelector: (sel) => String(sel).includes("conversation")
    ? { parentElement: { getBoundingClientRect: () => ({ left: 10, top: 10, width: 800, height: 600 }) } }
    : null,
  createElement: () => ({ dataset: {}, set textContent(v) {}, style: {}, appendChild() {} }),
  head: { appendChild() {} },
  body: { classList: { add() {}, remove() {} } },
};
globalThis.window.__ModuleLoader__ = {
  load: (def) => { modExports = def.factory((id) => { if (id === "react") return miniReact; if (id === "@deepseek-ai/dsh-client-ui-primitives") return primitives; throw new Error("unknown require: " + id); }); },
};
(0, eval)(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "client.js"), "utf8"));
assert.ok(modExports && typeof modExports.apply === "function", "factory 应导出 apply");

let Section = null;
const ctx = {
  locale: { bind: () => (s) => s, register() {} },
  effect(fn) { fn(); return () => {}; },
  slots: {
    inject(name, fn) { fn(); },
    register(spec, comp) { if (spec.name === "settings.section") Section = comp; },
  },
};
modExports.apply(ctx);
assert.ok(typeof Section === "function", "apply 应注册 settings.section 组件");

// ---------- 工具 ----------
function render() {
  curComp = "root"; hookSeq = 0; effectSeq = 0;
  return Section();
}
const settle = () => new Promise((r) => setImmediate(r)); // 等 fetch 微任务回填
function flatten(node, out) {
  if (node == null || typeof node === "boolean") return;
  if (typeof node === "string" || typeof node === "number") { out.push(String(node)); return; }
  if (Array.isArray(node)) { node.forEach((n) => flatten(n, out)); return; }
  if (node.children) node.children.forEach((c) => flatten(c, out));
}
function classNames(node, out) {
  if (node == null || typeof node !== "object") return;
  if (Array.isArray(node)) { node.forEach((n) => classNames(n, out)); return; }
  if (node.props && node.props.className) out.push(node.props.className);
  if (node.children) node.children.forEach((c) => classNames(c, out));
}
function elements(node, out) { // 收集全部元素节点（含 props/onClick），供交互断言用
  if (node == null || typeof node !== "object") return;
  if (Array.isArray(node)) { node.forEach((n) => elements(n, out)); return; }
  if (node.props) out.push(node);
  if (node.children) node.children.forEach((c) => elements(c, out));
}

// ---------- 视图 1：项目（默认 nav） ----------
let el = render(); await settle(); el = render(); // 第一轮跑 effect，微任务回填，第二轮读结果
let texts = []; flatten(el, texts);
assert.ok(texts.some((t) => t.includes("三步上手")), "项目视图应有三步上手说明");

// ---------- 视图 2：运行（空状态） ----------
hookCells.get("root:s0").set("runs"); // setNav("runs")
el = render();
texts = []; flatten(el, texts);
assert.ok(texts.some((t) => t.includes("P7 · Patch Pipeline")), "运行视图应渲染 11 阶段时间线");
assert.ok(texts.some((t) => t.includes("失败旁路")), "P10 应标注失败旁路");

// ---------- 视图 3：运行（选中有状态的 run） ----------
hookCells.get("root:s3").set("p");   // setSelSlug("p")
hookCells.get("root:s5").set("r1");  // setSelRunId("r1")
el = render(); await settle(); el = render(); await settle(); el = render();
texts = []; flatten(el, texts);
const cls = []; classNames(el, cls);
assert.ok(texts.some((t) => t.includes("3.0s")), "时间线应显示阶段耗时");
assert.ok(texts.some((t) => t.includes("重试1")), "时间线应显示重试次数");
assert.ok(texts.some((t) => t.includes("过程 · 本阶段调用记录")), "阶段详情应渲染过程事件面板");
assert.ok(texts.some((t) => t.includes("deepseek-v4-pro")), "过程事件应展示 LLM 调用");
// 阶段契约卡（运行 tab 顶部）：输出产物 / 输出契约
assert.ok(texts.some((t) => t.includes("阶段契约 · 输入 → 输出")), "运行 tab 应渲染阶段契约卡");
assert.ok(texts.some((t) => t.includes("05-task-graph.json")), "P5 契约卡应展示输出产物");
assert.ok(texts.some((t) => t.includes("输出契约")), "运行 tab 契约卡应含输出契约行");
assert.ok(cls.some((c) => String(c).includes("t-warn")), "待复核应用 warn tag");
assert.ok(cls.some((c) => String(c).split(" ").includes("step-row") && String(c).includes("awaiting_review")), "时间线步骤应带状态类");

// ---------- 视图 4：产物 ----------
hookCells.get("root:s0").set("artifacts");
el = render(); await settle(); el = render();
texts = []; flatten(el, texts);
assert.ok(texts.some((t) => t.includes("run.json") || t.includes("产物预览")), "产物视图应渲染文件树/预览");

// 视图 4b：目录折叠 —— 点击目录行 → 子项隐藏；再点 → 恢复
let els = []; elements(el, els);
const dirBtn = els.find((n) => n.props.className === "dir" && String(n.children.join("")).includes("ledger/"));
assert.ok(dirBtn, "产物树应有 ledger 目录行");
assert.strictEqual(dirBtn.props["aria-expanded"], "true", "初始目录应展开");
dirBtn.props.onClick();
el = render(); await settle();
texts = []; flatten(el, texts);
assert.ok(texts.some((t) => t.includes("▸ ledger/")), "折叠后目录行箭头应变 ▸");
assert.ok(!texts.some((t) => t.includes("patch-ledger.jsonl")), "折叠后子文件应隐藏");
els = []; elements(el, els);
const dirBtn2 = els.find((n) => n.props.className === "dir" && String(n.children.join("")).includes("ledger/"));
assert.strictEqual(dirBtn2.props["aria-expanded"], "false", "折叠后 aria-expanded 应为 false");
dirBtn2.props.onClick();
el = render();
texts = []; flatten(el, texts);
assert.ok(texts.some((t) => t.includes("patch-ledger.jsonl")), "展开后子文件应恢复");

// ---------- 视图 5：说明 ----------
hookCells.get("root:s0").set("guide");
el = render();
texts = []; flatten(el, texts);
assert.ok(texts.some((t) => t.includes("五条规则")), "说明视图应有五条规则");
assert.ok(texts.some((t) => t.includes("patch-ledger")), "说明表格应列出阶段产物");
assert.ok(texts.some((t) => t.includes("数据落盘位置")), "说明视图应有落盘位置卡片");

// ---------- 视图 6：配置（选中项目 demo → 差异化表单；P7 说明卡；P6 执行模式） ----------
hookCells.get("root:s3").set("demo");  // setSelSlug("demo")
hookCells.get("root:s0").set("config");
el = render(); await settle(); el = render(); await settle(); el = render();
texts = []; flatten(el, texts);
assert.ok(texts.some((t) => t.includes("提示词（system）")), "配置页应渲染提示词编辑区");
assert.ok(texts.some((t) => t.includes("已自定义")), "自定义过的提示词应带标记");
assert.ok(texts.some((t) => t.includes("阶段契约 · 输入 → 输出")), "配置表单顶部应渲染阶段契约卡");
assert.ok(texts.some((t) => t === "trigger"), "P1 契约卡应展示上游输入 trigger");
assert.ok(texts.some((t) => t.includes("模型 · 思考深度")), "配置页应渲染模型/思考深度区");
assert.ok(texts.some((t) => t.includes("LLM 调用超时（分钟）")), "配置页应渲染超时输入");
assert.ok(texts.some((t) => t.includes("委托外部智能体")), "配置页应渲染委托开关");
assert.ok(texts.some((t) => t.includes("保存阶段配置")), "配置页应有保存按钮");
assert.ok(texts.some((t) => t.includes("P1 · IssueAnalyzer")), "左列应渲染阶段清单");
// 切到 P7（确定性执行）：显示无可配置说明卡
hookCells.get("root:s8").set("P7");   // setCfgStage("P7")
el = render();
texts = []; flatten(el, texts);
assert.ok(texts.some((t) => t.includes("本阶段无可配置参数")), "P7 应显示无可配置说明");
assert.ok(texts.some((t) => t.includes("无 LLM 输出契约")), "P7 契约卡应显示确定性阶段说明");
// 切到 P6：执行模式三态（与项目页 p6Mode 同源）
hookCells.get("root:s8").set("P6");
el = render();
texts = []; flatten(el, texts);
assert.ok(texts.some((t) => t.includes("执行模式 · 委托外部智能体")), "P6 应渲染执行模式单选");
assert.ok(texts.some((t) => t.includes("插件内多智能体")) && texts.some((t) => t.includes("委托 Claude Code")), "P6 执行模式应含三态");
// 切到 P8：测试命令 + 测试超时（无提示词/模型区）
hookCells.get("root:s8").set("P8");
el = render();
texts = []; flatten(el, texts);
assert.ok(texts.some((t) => t.includes("测试超时（分钟）")), "P8 应渲染测试超时");
assert.ok(texts.some((t) => t.includes("测试命令")), "P8 应渲染测试命令");
assert.ok(!texts.some((t) => t.includes("提示词（system）")), "P8 不应有提示词区");

// ---------- 视图 7：入口按钮（官方设置按钮几何）+ 悬浮层开关 ----------
const regs = {};
const ctx2 = {
  locale: { bind: () => (s) => s, register() {} },
  effect(fn) { fn(); return () => {}; },
  slots: { inject(name, fn) { fn(); }, register(spec, comp) { regs[spec.name + ":" + spec.id] = comp; } },
};
modExports.apply(ctx2);
const Footer = regs["sidebar.footer.action:issue2pr"];
const Overlay = regs["shell.overlay:issue2pr"];
assert.ok(typeof Footer === "function" && typeof Overlay === "function", "apply 应注册入口按钮与悬浮层");
if (typeof globalThis.addEventListener !== "function") globalThis.addEventListener = () => {};

// 直接调用组件函数会让 mock hooks 记到 "root" 且 key 顺延漂移；一律经 h()（uid 路径，每组件独立重置）
let f = h(Footer, { wide: true });
let fcls = []; classNames(f, fcls);
const words = (c) => String(c).split(/\s+/);
assert.ok(fcls.some((c) => words(c).includes("i2p-entry")) && !fcls.some((c) => words(c).includes("rail")), "宽列入口 = 42px 整行按钮");
assert.ok(flattenTexts(f).includes("Issue2PR"), "宽列入口显示文字标签");
f = h(Footer, { wide: false });
fcls = []; classNames(f, fcls);
assert.ok(fcls.some((c) => words(c).includes("rail")), "收起列入口 = 36px 圆形图标钮");

assert.equal(h(Overlay), null, "未开启时悬浮层渲染 null（点击穿透）");
f.props.onClick(); // 模拟点击入口
// mock 渲染不自动级联：第一遍 layoutEffect 量 rect（setRect 落 cell），第二遍才读到 rect
let ov = h(Overlay); ov = h(Overlay);
assert.ok(ov != null, "点击入口后悬浮层渲染");
let ocls = []; classNames(ov, ocls);
// 现行形态：整页工作台贴合 conversation 列（i2p-page + i2p-page-body），无遮罩非模态
assert.ok(ocls.includes("i2p-page") && ocls.includes("i2p-page-body"), "悬浮层 = 贴合主区列的整页工作台");

// ---------- 视图 7b：悬浮智能助手（悬浮球 → 面板 → 流式问答闭环） ----------
// smoke 的 h() 对函数组件立即执行：AssistantDock 的渲染结果已在 ov 树内，
// 交互后整树重渲染（h(Overlay)）即可读到新状态（hooks 按 type.__uid 独立）
const hasCls = (tree, cls) => { const out = []; classNames(tree, out); return out.some((c) => String(c).split(/\s+/).includes(cls)); };
assert.ok(hasCls(ov, "i2p-ai-fab"), "工作台右上角应有智能助手悬浮球");
assert.ok(!hasCls(ov, "i2p-ai-panel"), "默认不展开面板");
const gripClsOf = (tree, cls) => { const out = []; elements(tree, out); return out.some((n) => String(n.props.className || "").split(/\s+/).includes(cls)); };
assert.ok(!gripClsOf(ov, "i2p-ai-rz"), "面板未展开时无 resize 层");
const ovEls = []; elements(ov, ovEls);
const fab = ovEls.find((n) => String(n.props.className || "").split(/\s+/).includes("i2p-ai-fab"));
assert.ok(fab, "悬浮球应为可点击按钮");
fab.props.onClick(); // 点击悬浮球 → aiStore.set(true)
ov = h(Overlay);
assert.ok(hasCls(ov, "i2p-ai-panel"), "点击悬浮球后展开对话面板");
// 自由窗口：四边 + 四角 resize 层齐全（角 24×24 命中区）
assert.ok(gripClsOf(ov, "i2p-ai-rz"), "面板应带 resize 层");
const rzCls = (() => { const out = []; elements(ov, out); return out.filter((n) => /i2p-ai-rz/.test(String(n.props.className || ""))).map((n) => n.props.className.trim()); })();
assert.equal(rzCls.length, 8, "应有 8 个 resize 命中区（四边+四角）");
// 窗口矩形走内联 style（aiStore rect → left/top/width/height）
const ovPanel = (() => { const out = []; elements(ov, out); return out.find((n) => String(n.props.className || "").split(/\s+/).includes("i2p-ai-panel")); })();
assert.ok(ovPanel && ovPanel.props.style && ovPanel.props.style.left && ovPanel.props.style.top && ovPanel.props.style.width && ovPanel.props.style.height, "窗口矩形由 store 内联注入");
let dtexts = flattenTexts(ov);
assert.ok(dtexts.some((t) => t.includes("现在的运行到哪一步了？")), "空历史时应显示快捷问题");
assert.ok(dtexts.some((t) => t.includes("我能看到你的项目")), "面板应带能力说明");
const chipEls = []; elements(ov, chipEls);
const chip = chipEls.find((n) => String(n.props.className || "").split(/\s+/).includes("i2p-ai-chip") && flattenTexts(n).includes("现在的运行到哪一步了？"));
assert.ok(chip, "快捷问题应为可点击按钮");
chip.props.onClick(); // send(chip 文本) → fetch 流式 mock
await settle(); await settle();
ov = h(Overlay);
dtexts = flattenTexts(ov);
assert.ok(dtexts.some((t) => t.includes("现在的运行到哪一步了？")), "消息区应出现用户问题");
assert.ok(dtexts.some((t) => t.includes("待复核")), "消息区应出现流式助手回答");

function flattenTexts(node, out = []) { flatten(node, out); return out; }

// ---------- 视图 8：项目选中记忆（进入恢复 / 新建清除 / 选择写回） ----------
// 新实例：换 curComp 前缀让 hookCells 走全新 key，useState 初始函数才会重新执行（读 localStorage）
lsStore["i2p.proj"] = "demo";
curComp = "root2"; hookSeq = 0; effectSeq = 0;
let el8 = Section(); await settle();
curComp = "root2"; hookSeq = 0; effectSeq = 0;
el8 = Section();
const cls8 = []; classNames(el8, cls8);
assert.ok(cls8.some((c) => String(c).includes("proj-item on")), "进入时应恢复上次选中的项目（demo 高亮）");
const textsOf = (n) => flattenTexts(n).join("");
const els8 = []; elements(el8, els8);
const newBtn = els8.find((n) => n.props.className === "add-row" && textsOf(n).includes("新建项目"));
assert.ok(newBtn, "项目列表应有新建项目按钮");
newBtn.props.onClick(); // onSelectProject(null) → 清除记忆
assert.ok(!("i2p.proj" in lsStore), "点击新建项目应清除选中记忆");
const demoItem = els8.find((n) => String(n.props.className || "").split(" ").includes("proj-item") && textsOf(n).includes("演示"));
assert.ok(demoItem, "项目列表应有 demo 项目");
demoItem.props.onClick(); // onSelectProject("demo") → 写回记忆
assert.equal(lsStore["i2p.proj"], "demo", "点击选择项目应写回记忆");
curComp = "root"; hookSeq = 0; effectSeq = 0;

// ---------- 视图 8b：宿主重启场景（localStorage 被清空）→ 服务端 ui-state 兜底恢复 ----------
delete lsStore["i2p.proj"];            // 模拟 webview localStorage 不跨软件重启
serverUiState = { lastProject: "demo" }; // 服务端文件仍在（上次会话双写过）
curComp = "root3"; hookSeq = 0; effectSeq = 0;
let el9 = Section(); await settle();  // 挂载 effect：localStorage miss → GET /ui-state → setSelSlug("demo")
curComp = "root3"; hookSeq = 0; effectSeq = 0;
el9 = Section(); await settle();      // 等项目列表回填（失效校验需要）
curComp = "root3"; hookSeq = 0; effectSeq = 0;
el9 = Section();
const cls9 = []; classNames(el9, cls9);
assert.ok(cls9.some((c) => String(c).includes("proj-item on")), "宿主重启（localStorage 清空）后应从服务端兜底恢复选中");
curComp = "root"; hookSeq = 0; effectSeq = 0;

// ---------- 视图 9：连接台面化（仓库徽章 / 连接卡 / 健康横幅 / LLM 路由行 / 触发源存在性） ----------
// root4 实例：claude 探测失败 + 1 个阶段覆盖 → 选中 cloud（p6Mode=claude、仓库命中 gitlab 连接）
serverPreflight = { git: { ok: true, version: "git version 2.50.0" }, claude: { ok: false, path: "C:\\nope\\claude.cmd" },
  llm: { provider: "glm", model: "glm-5.2", source: "host", overrides: { P1: { provider: "a", model: "b" } } } };
curComp = "root4"; hookSeq = 0; effectSeq = 0;
const render4 = () => { curComp = "root4"; hookSeq = 0; effectSeq = 0; return Section(); };
render4(); await settle();
hookCells.get("root4:s3").set("cloud");
let elA = render4();
await settle(); elA = render4(); await settle(); elA = render4();
let at9 = flattenTexts(elA);
assert.ok(at9.some((t) => t.includes("Git 托管连接（全局 · 所有项目共用）")), "项目页应渲染 Git 托管连接区块");
assert.ok(at9.some((t) => t.includes("已连接")), "仓库命中连接应显示已连接徽章");
let acl9 = []; classNames(elA, acl9);
assert.ok(acl9.some((c) => String(c).split(" ").includes("host-badge") && String(c).includes("ok")), "已连接徽章应用 ok 样式");
assert.ok(at9.some((t) => t.includes("未探测到 claude CLI")), "p6Mode=claude 且探测失败应显示横幅");
assert.ok(at9.some((t) => t.includes("LLM 默认")), "应显示 LLM 路由行");
assert.ok(at9.some((t) => t.includes("宿主默认模型")), "路由来源应标注");
assert.ok(at9.some((t) => t.includes("1 个阶段已覆盖模型")), "阶段覆盖计数应显示");
// 连接列表行有测试/删除按钮
let ael9 = []; elements(elA, ael9);
assert.ok(ael9.some((n) => n.props.className === "btn sm" && flattenTexts(n).includes("测试")), "连接行应有测试按钮");
assert.ok(ael9.some((n) => String(n.props.className || "").includes("btn") && String(n.props["aria-label"] || "").includes("仓库") === false && flattenTexts(n).includes("删除")), "连接行应有删除按钮");
// 仓库行「测试」按钮（ls-remote）
assert.ok(ael9.some((n) => n.props["aria-label"] && String(n.props["aria-label"]).startsWith("测试仓库")), "仓库行应有测试连通按钮");

// 切到 p 项目：仓库 host 无连接 → 黄牌徽章；本地触发源存在 → 绿徽章；builtin 模式无 claude 横幅
hookCells.get("root4:s3").set("p");
elA = render4(); await settle(); elA = render4(); await settle(); elA = render4();
at9 = flattenTexts(elA);
assert.ok(at9.some((t) => t.includes("未配置连接")), "未匹配连接的 https 仓库应显示黄牌徽章");
acl9 = []; classNames(elA, acl9);
assert.ok(acl9.some((c) => String(c).split(" ").includes("host-badge") && String(c).includes("warn")), "黄牌徽章应用 warn 样式");
assert.ok(at9.some((t) => t.includes("文件存在")), "本地触发源存在应显示徽章");
assert.ok(!at9.some((t) => t.includes("未探测到 claude CLI")), "builtin 模式不显示 claude 横幅");

// root5 实例：git 探测失败 → 红色横幅
serverPreflight = { git: { ok: false, message: "ENOENT" }, claude: { ok: true, path: "C:\\bin\\claude.cmd" },
  llm: { provider: "deepseek-official", model: "deepseek-v4-pro", source: "default", overrides: {} } };
const render5 = () => { curComp = "root5"; hookSeq = 0; effectSeq = 0; return Section(); };
render5(); await settle();
hookCells.get("root5:s3").set("demo");
let elB = render5(); await settle(); elB = render5();
at9 = flattenTexts(elB);
assert.ok(at9.some((t) => t.includes("未检测到 git")), "git 缺失应显示红色横幅");
assert.ok(at9.some((t) => t.includes("插件内置兜底")), "路由来源为兜底时应标注");
curComp = "root"; hookSeq = 0; effectSeq = 0;

console.log("SMOKE-OK: 全部视图渲染通过（含配置页、入口按钮与整页工作台）");
process.exit(0); // 3s 轮询定时器会挂住进程，显式退出
