// tests/preview.mjs — 生成 preview.html（浏览器视觉验证用，不入 npm test）。
// 内联真实 client.js + React 18.3.1（CDN）+ 宿主 dsw 令牌模拟 + /issue2pr/api fetch mock。
// 运行：node tests/preview.mjs && 用浏览器打开 tests/preview.html
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const client = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "client.js"), "utf8");

const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Issue2PR 预览（宿主模拟）</title>
<script src="https://unpkg.com/react@18.3.1/umd/react.production.min.js"></script>
<script src="https://unpkg.com/react-dom@18.3.1/umd/react-dom.production.min.js"></script>
<style>
  /* 模拟宿主主题令牌（DSH dsw-alias-*）：浅色 */
  :root{
    --dsw-alias-bg-base:#ffffff;
    --dsw-alias-bg-layer-2:#ffffff;
    --dsw-alias-bg-mask-1:rgba(9,12,20,.45);
    --dsw-mask-blur:blur(2px);
    --dsw-shadow-lv3:0 18px 60px rgba(9,12,20,.3);
    --dsw-alias-label-primary:#17181f;
    --dsw-alias-label-secondary:#414351;
    --dsw-alias-label-tertiary:#82848f;
    --dsw-alias-label-caption:#9b9da8;
    --dsw-alias-border-l1:#e5e6ec;
    --dsw-alias-border-l2:#d8dae3;
    --dsw-alias-state-business-primary:#2a5ddc;
    --dsw-alias-interactive-bg-hover:rgba(9,12,20,.055);
    --dsw-alias-state-success-primary:#1c7c43;
    --dsw-alias-state-success-tertiary:rgba(28,124,67,.12);
    --dsw-alias-state-warn-label:#9a6700;
    --dsw-alias-state-warn-tertiary:rgba(154,103,0,.12);
    --dsw-alias-state-error-primary:#d5463a;
    --dsw-specific-sidebar-nav-item-active:rgba(9,12,20,.09);
    --dsw-specific-sidebar-fill:#f7f7f9;
    font-family:-apple-system,'Segoe UI','PingFang SC','Microsoft YaHei',system-ui,sans-serif;
  }
  html[data-theme="dark"]{
    --dsw-alias-bg-base:#16171d;
    --dsw-alias-bg-layer-2:#1d1e26;
    --dsw-alias-label-primary:#eceef4;
    --dsw-alias-label-secondary:#b7bac6;
    --dsw-alias-label-tertiary:#7c7f8c;
    --dsw-alias-label-caption:#63666f;
    --dsw-alias-border-l1:#2a2c37;
    --dsw-alias-border-l2:#343745;
    --dsw-alias-state-business-primary:#7ba4ff;
    --dsw-alias-interactive-bg-hover:rgba(255,255,255,.07);
    --dsw-alias-state-success-primary:#5ec98a;
    --dsw-alias-state-success-tertiary:rgba(94,201,138,.14);
    --dsw-alias-state-warn-label:#e3b341;
    --dsw-alias-state-warn-tertiary:rgba(227,179,65,.14);
    --dsw-alias-state-error-primary:#f08a80;
    --dsw-specific-sidebar-nav-item-active:rgba(255,255,255,.10);
    --dsw-specific-sidebar-fill:#131419;
  }
  html,body{margin:0;padding:0;background:#20222b;color:#17181f;height:100%}
  .stage{display:flex;height:100vh;overflow:hidden}
  .side{width:252px;flex:none;background:var(--dsw-specific-sidebar-fill);
    border-right:1px solid var(--dsw-alias-border-l1);display:flex;flex-direction:column;padding:6px 12px}
  .side .grow{flex:1}
  .side .footerActions{display:flex}
  .side .settingsArea{display:flex}
  .rail{width:56px;flex:none;background:var(--dsw-specific-sidebar-fill);
    border-right:1px solid var(--dsw-alias-border-l1);display:flex;flex-direction:column;
    align-items:center;padding:6px 6px}
  .rail .footArea{margin-top:auto;display:flex}
  .fake-settings{box-sizing:border-box;cursor:pointer;width:calc(100% + 4px);height:42px;
    color:var(--dsw-alias-label-primary);background:0 0;border:none;border-radius:12px;
    display:flex;align-items:center;gap:8px;margin:4px -2px;padding:0 10px 0 8px;font:inherit;font-size:14px}
  .fake-settings:hover{background:var(--dsw-alias-interactive-bg-hover)}
  .fake-settings.rail{border-radius:50%;justify-content:center;width:36px;height:36px;margin:8px 0 10px;padding:0}
  .fake-label{padding:18px 8px;color:var(--dsw-alias-label-tertiary);font-size:12px}
  .themebar{position:fixed;top:10px;right:12px;z-index:3000;display:flex;gap:8px}
  .themebar button{cursor:pointer;border:1px solid #555;border-radius:8px;background:#2b2d3a;color:#eee;padding:5px 12px;font-size:12px}
</style>
</head>
<body>
<div class="stage">
  <div class="side">
    <div class="fake-label">宿主侧边栏（宽列）</div>
    <div class="grow"></div>
    <div class="footerActions" id="foot-wide"></div>
    <div class="settingsArea">
      <button class="fake-settings">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
        <span>设置</span>
      </button>
    </div>
  </div>
  <div class="rail">
    <div class="fake-label" style="writing-mode:vertical-rl">收起</div>
    <div class="footArea" id="foot-rail"></div>
    <button class="fake-settings rail" aria-label="设置">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
    </button>
  </div>
  <div id="overlay-mount" style="position:relative;flex:1;min-width:0"></div>
</div>
<div class="themebar">
  <button onclick="document.documentElement.dataset.theme='light'">浅色</button>
  <button onclick="document.documentElement.dataset.theme='dark'">深色</button>
  <button onclick="reopen()">重开悬浮层</button>
</div>
<script>
// —— /issue2pr/api fetch mock（数据集：两个项目、一个待复核 P5 的 run） ——
const iso = (s) => new Date(Date.parse("2026-08-29T02:00:00Z") + s * 1000).toISOString();
const projects = [
  { name: "支付网关", slug: "pay-gw", repos: [{ uri: "https://git.corp/pay/gateway.git" }],
    triggers: [{ kind: "issue", uri: "D:\\\\issues\\\\1234-退款重复.md" }, { kind: "requirement", uri: "D:\\\\specs\\\\v2-对账.md" }],
    reviewMode: "key-only", p6Mode: "builtin", testCommand: "npm test" },
  { name: "官网", slug: "site", repos: [{ uri: "https://github.com/corp/site.git" }],
    triggers: [{ kind: "issue", uri: "https://github.com/corp/site/issues/88" }],
    reviewMode: "every", p6Mode: "session", testCommand: "" },
];
const runSummary = { id: "20260829-100215-tuikuan-chongfu", status: "awaiting_review", current: "P5",
  trigger: { kind: "issue", uri: "D:\\\\issues\\\\1234-退款重复.md" }, createdAt: iso(0) };
const runDetail = { ...runSummary, project: "pay-gw", reviewMode: "key-only", p6Mode: "builtin",
  stages: {
    P1: { status: "approved", startedAt: iso(0), finishedAt: iso(14), artifact: "01-issue-analysis.json" },
    P2: { status: "approved", startedAt: iso(14), finishedAt: iso(52), artifact: "02-search-candidates.json" },
    P3: { status: "approved", startedAt: iso(52), finishedAt: iso(131), artifact: "03-code-understanding.md" },
    P4: { status: "approved", startedAt: iso(131), finishedAt: iso(160), artifact: "04-hypotheses.json" },
    P5: { status: "awaiting_review", attempts: 1, startedAt: iso(160) },
    P6: { status: "pending", attempts: 0 }, P7: { status: "pending", attempts: 0 },
    P8: { status: "pending", attempts: 0 }, P9: { status: "pending", attempts: 0 },
    P10: { status: "pending", attempts: 0 }, P11: { status: "pending", attempts: 0 },
  } };
const tree = [
  { path: "run.json", size: 1840, mtimeMs: 1 },
  { path: "01-issue-analysis.json", size: 612, mtimeMs: 1 },
  { path: "02-search-candidates.json", size: 1420, mtimeMs: 1 },
  { path: "03-code-understanding.md", size: 5210, mtimeMs: 1 },
  { path: "04-hypotheses.json", size: 890, mtimeMs: 1 },
  { path: "05-task-graph.json", size: 1104, mtimeMs: 2 },
  { path: "reviews/20260829-100517-reject-P5.json", size: 180, mtimeMs: 1 },
  { path: "trace/spans.jsonl", size: 760, mtimeMs: 1 },
  { path: "trace/events.jsonl", size: 3120, mtimeMs: 2 },
];
const events = [
  { at: iso(0), stage: "P1", kind: "stage", name: "P1 开始", detail: "IssueAnalyzer", ms: null, ok: true },
  { at: iso(0), stage: "P1", kind: "llm", name: "deepseek-v4-pro", ms: 14200, ok: true,
    detail: "prompt 812 字 → 响应 46 字\\n【prompt】【Issue 全文】# 退款重复 用户重复点击退款按钮后产生两笔退款单…\\n——\\n【响应】{\\"phenomenon\\":\\"重复点击产生两笔退款单\\",\\"risk_level\\":\\"medium\\"}" },
  { at: iso(14), stage: "P1", kind: "stage", name: "P1 完成", detail: "scope=refund/service,refund/api", ms: 14000, ok: true },
  { at: iso(14), stage: "P2", kind: "stage", name: "P2 开始", detail: "Search Layer", ms: null, ok: true },
  { at: iso(15), stage: "P2", kind: "tool", name: "listRepoFiles", detail: "扫描仓库文件清单：214 个文件（忽略 .git/node_modules/dist）", ms: 620, ok: true },
  { at: iso(16), stage: "P2", kind: "llm", name: "deepseek-v4-pro", ms: 36000, ok: true,
    detail: "prompt 9600 字 → 响应 720 字\\n【prompt】【Issue 契约】…【仓库文件清单】refund/service/RefundService.ts…\\n——\\n【响应】{\\"candidates\\":[{\\"path\\":\\"refund/service/RefundService.ts\\",\\"confidence\\":\\"high\\"}]}" },
  { at: iso(52), stage: "P2", kind: "stage", name: "P2 完成", detail: "候选 3 个", ms: 38000, ok: true },
  { at: iso(52), stage: "P3", kind: "stage", name: "P3 开始", detail: "Code Understanding", ms: null, ok: true },
  { at: iso(53), stage: "P3", kind: "tool", name: "readRepoFile × 6", detail: "读取候选文件：RefundService.ts（213 行）/ routes.ts（98 行）/ idempotency.ts（45 行）…", ms: 310, ok: true },
  { at: iso(54), stage: "P3", kind: "llm", name: "deepseek-v4-pro", ms: 77000, ok: true,
    detail: "prompt 14200 字 → 响应 1800 字\\n【prompt】【候选文件内容】### refund/service/RefundService.ts…\\n——\\n【响应】## 关键函数\\nRefundService.create(): 幂等键 = userId+orderId，缺 refundSeq…" },
  { at: iso(131), stage: "P3", kind: "stage", name: "P3 完成", detail: "报告 1800 字", ms: 79000, ok: true },
  { at: iso(131), stage: "P4", kind: "stage", name: "P4 开始", detail: "Hypothesis", ms: null, ok: true },
  { at: iso(132), stage: "P4", kind: "llm", name: "deepseek-v4-pro", ms: 28000, ok: true,
    detail: "prompt 2600 字 → 响应 340 字\\n【prompt】【代码理解报告】…\\n——\\n【响应】{\\"hypotheses\\":[{\\"id\\":\\"A\\",\\"title\\":\\"幂等键粒度不足\\"}]}" },
  { at: iso(160), stage: "P4", kind: "stage", name: "P4 完成", detail: "假设 1 个", ms: 29000, ok: true },
  { at: iso(160), stage: "P5", kind: "stage", name: "P5 开始", detail: "Planner", ms: null, ok: true },
  { at: iso(161), stage: "P5", kind: "llm", name: "deepseek-v4-pro", ms: 29000, ok: true,
    detail: "prompt 1100 字 → 响应 560 字\\n【prompt】【根因假设】…\\n——\\n【响应】{\\"nodes\\":[{\\"id\\":\\"T1\\",\\"title\\":\\"请求级幂等键\\"},{\\"id\\":\\"T2\\",\\"title\\":\\"补并发测试\\"}]}" },
  { at: iso(190), stage: "P5", kind: "stage", name: "P5 完成 · 待复核", detail: "2 节点", ms: 29000, ok: true },
  { at: iso(320), stage: "P5", kind: "stage", name: "P5 复核打回", detail: "T2 缺少幂等键过期策略的验证任务，补一个节点。", ms: null, ok: true },
  { at: iso(321), stage: "P5", kind: "llm", name: "deepseek-v4-pro", ms: 31000, ok: true,
    detail: "prompt 1400 字 → 响应 620 字（打回意见已注入）\\n【prompt】…【人工复核打回意见，必须修正】T2 缺少幂等键过期策略的验证任务\\n——\\n【响应】{\\"nodes\\":[T1,T2,T3-expiry]}" },
];
const eventsText = events.map((e) => JSON.stringify(e)).join("\\n") + "\\n";
const artifacts = {
  "01-issue-analysis.json": JSON.stringify({ phenomenon: "用户重复点击退款按钮后产生两笔退款单", trigger: "弱网下按钮未禁用，双击窗口约 800ms", scope: ["refund/service", "refund/api"], success_criteria: ["重复点击只产生一笔退款单", "第二笔请求返回 DUPLICATE 幂等错误"], constraints: ["不改数据库 schema"], risk_level: "medium" }, null, 2),
  "02-search-candidates.json": JSON.stringify({ candidates: [
    { path: "refund/service/RefundService.ts", role: "退款核心服务", evidence: "issue 提到的幂等键逻辑在此实现", confidence: "high" },
    { path: "refund/api/routes.ts", role: "HTTP 入口", evidence: "按钮双击到达的端点", confidence: "high" },
    { path: "refund/service/idempotency.ts", role: "幂等工具", evidence: "疑似键生成缺陷", confidence: "medium" } ],
    test_candidates: ["refund/service/refund.test.ts"], uncertain: ["前端按钮防抖是否已存在"] }, null, 2),
  "03-code-understanding.md": "# 调用链分析\\n\\n## 关键函数\\n- RefundService.create(): 幂等键 = userId+orderId，缺 refundSeq\\n\\n## 调用方\\n- routes.ts POST /refund → create()\\n\\n## 潜在修改点\\n- create() 幂等窗口内并发请求未互斥；建议引入请求级幂等键。",
  "04-hypotheses.json": JSON.stringify({ hypotheses: [ { id: "A", title: "幂等键粒度不足", evidence: "同一订单两次退款请求键相同但窗口外", verify_file: "refund/service/refund.test.ts", verify_method: "并发双击模拟测试" } ] }, null, 2),
  "05-task-graph.json": JSON.stringify({ nodes: [
    { id: "T1", title: "请求级幂等键", input: "04-hypotheses.json", output: "patches/0001", deps: [], success_criteria: "并发双击只落一笔", risk: "low" },
    { id: "T2", title: "补并发测试", input: "T1", output: "patches/0002", deps: ["T1"], success_criteria: "测试红→绿", risk: "low" } ],
    review_gate: "T1", pr_gate: "T2" }, null, 2),
  "reviews/20260829-100517-reject-P5.json": JSON.stringify({ stage: "P5", decision: "reject", comment: "T2 缺少幂等键过期策略的验证任务，补一个节点。", at: iso(320) }),
  "trace/spans.jsonl": '{"at":"' + iso(14) + '","span":"P1","ms":14000,"decision":"scope=refund/service,refund/api"}\\n{"at":"' + iso(160) + '","span":"P5","ms":29000,"decision":"2 节点"}\\n',
  "trace/events.jsonl": eventsText,
  "run.json": JSON.stringify(runDetail, null, 2),
};
window.fetch = (url) => {
  const u = String(url);
  let body = { ok: true };
  const m = u.match(/\\/runs\\/([^/]+)\\/artifact\\?path=(.+)$/);
  if (m) {
    const p = decodeURIComponent(m[2]);
    body = artifacts[p] != null ? { ok: true, text: artifacts[p] } : { ok: false, message: "产物不存在: " + p };
  } else if (/\\/runs\\/[^/]+\\/tree$/.test(u)) body = { ok: true, files: tree };
  else if (/\\/runs\\/[^/]+$/.test(u)) body = runDetail;
  else if (/\\/runs$/.test(u)) body = { ok: true, runs: [runSummary] };
  else if (/\\/projects$/.test(u)) body = { ok: true, projects };
  return Promise.resolve({ json: () => Promise.resolve(body) });
};

// —— 宿主 ModuleLoader 模拟：载入真实 client.js ——
let modExports = null;
window.__ModuleLoader__ = { load(def) { modExports = def.factory((id) => { if (id === "react") return React; throw new Error("unknown: " + id); }); } };
</script>
<script>
${client}
</script>
<script>
const regs = {};
const ctx = {
  locale: { bind: () => (s) => s, register() {} },
  effect(fn) { fn(); return () => {}; },
  slots: { inject(name, fn) { fn(); }, register(spec, comp) { regs[spec.name + ":" + spec.id] = comp; } },
};
modExports.apply(ctx);
const e18 = ReactDOM.createRoot(document.getElementById("foot-wide"));
e18.render(React.createElement(regs["sidebar.footer.action:issue2pr"], { wide: true }));
const eR = ReactDOM.createRoot(document.getElementById("foot-rail"));
eR.render(React.createElement(regs["sidebar.footer.action:issue2pr"], { wide: false }));
window.reopen = () => {
  // 直接挂 OverlayEntry 并触发开启
  const root = ReactDOM.createRoot(document.getElementById("overlay-mount"));
  root.render(React.createElement(regs["shell.overlay:issue2pr"]));
  setTimeout(() => {
    document.querySelector(".i2p-entry").click();
  }, 30);
};
reopen();
</script>
</body>
</html>
`;

writeFileSync(join(dirname(fileURLToPath(import.meta.url)), "preview.html"), html);
console.log("written tests/preview.html");
