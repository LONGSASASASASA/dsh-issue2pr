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
globalThis.fetch = (url) => {
  const u = String(url);
  let body = { ok: true };
  if (/\/stage-defaults/.test(u)) {
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
  } else if (/\/projects$/.test(u)) {
    body = { ok: true, projects: [
      { name: "P 项目", slug: "p", repos: [{ uri: "https://p.git" }], triggers: [{ kind: "issue", uri: "D:\\x.md" }],
        reviewMode: "every", p6Mode: "builtin", testCommand: "" },
      { name: "演示", slug: "demo", repos: [{ uri: "https://x.git" }], triggers: [],
        reviewMode: "every", p6Mode: "builtin", testCommand: "",
        stageConfig: { P1: { prompts: { "": "自定义 P1 提示词" } } } },
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

console.log("SMOKE-OK: 全部视图渲染通过（含配置页、入口按钮与整页工作台）");
process.exit(0); // 3s 轮询定时器会挂住进程，显式退出
