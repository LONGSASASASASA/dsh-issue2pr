import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { STAGE_DEFS } from "../../lib/core/stageConfig.js";

// 组件逻辑测试：模拟 hooks 的状态、提交后 effect 与卸载清理；显示/焦点另在浏览器验证。
function studio(fetcher = async () => ({ ok: true }), clock = {}) {
  let current, exports;
  const React = {
    Fragment: "Fragment",
    createElement: (type, props, ...children) => {
      const element = { type, props: props || {}, children: children.flat(Infinity), style: {} };
      if (props && props.ref) props.ref.current = element;
      return element;
    },
    useState(initial) {
      const instance = current, index = instance.index++;
      if (!instance.cells[index]) instance.cells[index] = { value: typeof initial === "function" ? initial() : initial };
      const cell = instance.cells[index];
      return [cell.value, value => { cell.value = typeof value === "function" ? value(cell.value) : value; }];
    },
    useRef(initial) { const [cell] = React.useState(() => ({ current: initial })); return cell; },
    useCallback(fn) { return fn; },
    useEffect(fn, deps) {
      const instance = current, index = instance.index++, previous = instance.cells[index];
      if (!previous || !deps || deps.some((value, i) => !Object.is(value, previous.deps[i]))) {
        instance.effects.push(() => { previous?.cleanup?.(); instance.cells[index] = { deps, cleanup: fn() }; });
      }
    },
  };
  React.useLayoutEffect = React.useEffect;
  const storage = new Map(), requests = [], copies = [], docListeners = new Map();
  const sandbox = { structuredClone, AbortController, TextDecoder, setTimeout, clearTimeout, setInterval, clearInterval, console, URL, Blob, ...clock,
    getComputedStyle: element => ({ getPropertyValue: () => element.bg || "" }),
    document: { querySelector: selector => selector.startsWith("style[") ? {} : null, documentElement: { dataset: { i2pThemeWatch: "1" } },
      addEventListener: (type, fn) => docListeners.set(type, fn), removeEventListener: type => docListeners.delete(type) },
    confirm: () => true,
    navigator: { clipboard: { writeText: async value => { copies.push(value); } } },
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
    fetch: async (url, options) => {
      requests.push({ url, ...options });
      const result = await fetcher(url, options);
      if (result instanceof Response) return result;
      return { ok: true, json: async () => result };
    },
    window: { confirm: () => true, addEventListener() {}, removeEventListener() {},
      __ModuleLoader__: { load(def) { exports = def.factory(name => name === "react" ? React : { MarkdownText: () => null }); } } },
  };
  const source = readFileSync(new URL("../../client.js", import.meta.url), "utf8").replace("exports.apply = apply;", "exports.apply = apply; exports.test = { testActivityView, TestActivityPanel, useRunClock, stageTimingText, agentActivityView, AgentActivityPanel, useResource, StudioSettings, StudioDialog, NewTaskDialog, RunsPanel, PatchPreview, ArtifactsPanel, TaskList, ProjectsPanel, OutputPanel, useLogArtifact, RunLogPanel, stageLogText, ArtifactsDialog, RunReportCard, DeliveryPanel, WorkbenchPage, AssistantDock, panelStore, aiStore, ReadableValue, DiffContent, diffLineNumbers, formatAgentLog, timelineStripDate, timelineKeep, parseTimelineEvent, previewClamp, taskInputSummary, TimelineTable, EventDetailDialog, ExecutionsPanel, executionItems, artifactOwner, taskTitle, taskReason, evidenceState, parseLines, renderView, detectHostDark, reportSummary, gateLabel, gateStats, StageResult, SearchCandidatesCard, ArtifactContent };");
  vm.runInNewContext(source, sandbox, { filename: "client.js" });
  function mount(fn, props) {
    const instance = { index: 0, cells: [], effects: [], props, tree: null,
      render(next = instance.props) { instance.props = next; instance.index = 0; current = instance; instance.tree = fn(next); current = null; for (const effect of instance.effects.splice(0)) effect(); return instance.tree; },
      dispose() { for (const cell of instance.cells) cell?.cleanup?.(); },
    };
    instance.render(); return instance;
  }
  return { ...exports.test, mount, requests, storage, copies, docListeners };
}
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const walk = tree => tree && typeof tree === "object" ? [tree, ...(tree.children || []).flatMap(walk)] : [];
const text = tree => typeof tree === "string" || typeof tree === "number" ? String(tree) : (tree?.children || []).map(text).join("");
const button = (tree, label) => walk(tree).find(node => node.type === "button" && text(node) === label);
const field = (tree, label) => walk(walk(tree).find(node => node.type === "label" && text(node).startsWith(label))).find(node => ["input", "select", "textarea"].includes(node.type));

test("主题：识别 DSH body 深色标记，兼容旧宿主 HEX/RGB 背景及明暗切换", () => {
  const ui = studio();
  const doc = { body: { hasAttribute: key => key === "data-ds-dark-theme", bg: "" }, documentElement: { dataset: {} } };
  assert.equal(ui.detectHostDark(doc), true);
  doc.body.hasAttribute = () => false;
  for (const value of ["#151517", "#222", "rgb(20, 27, 32)"]) { doc.body.bg = value; assert.equal(ui.detectHostDark(doc), true); }
  for (const value of ["#ffffff", "#fff", "rgb(246, 247, 249)"]) { doc.body.bg = value; assert.equal(ui.detectHostDark(doc), false); }
});

test("任务列表：部分项目断线保留上次结果，失效项目筛选回退全部", async t => {
  let offline = false;
  const ui = studio(async url => { if (offline && url.includes("/alpha/")) throw new Error("offline"); return { ok: true, runs: [{ id: url.includes("/alpha/") ? "task-a" : "task-b", status: "stopped", current: "P1" }] }; });
  ui.storage.set("i2p.task-filter", '"deleted-project"');
  const page = ui.mount(ui.TaskList, { projects: [{ slug: "alpha", name: "Alpha" }, { slug: "beta", name: "Beta" }], revision: 0 }); t.after(() => page.dispose());
  await tick(); page.render(); assert.match(text(page.tree), /task-a/); assert.match(text(page.tree), /task-b/);
  assert.equal(walk(page.tree).find(n => n.props["aria-label"] === "筛选项目").props.value, "all");
  offline = true; button(page.tree, "刷新").props.onClick(); page.render(); await tick(); page.render();
  assert.match(text(page.tree), /Alpha：offline/); assert.match(text(page.tree), /task-a/); assert.match(text(page.tree), /task-b/);
});

test("资源：快速切换时取消旧请求，迟到响应不串任务；断线保留内容并可重试", async t => {
  const ui = studio(), first = deferred(), second = deferred(); let signal;
  const page = ui.mount(p => ui.useResource(p.key, p.load), { key: "a", load: s => { signal = s; return first.promise; } }); t.after(() => page.dispose());
  page.render({ key: "b", load: () => second.promise }); assert.equal(signal.aborted, true);
  second.resolve("task-b"); await tick(); assert.equal(page.render().value, "task-b");
  first.resolve("task-a"); await tick(); assert.equal(page.render().value, "task-b");
  const offline = () => Promise.reject(new Error("offline"));
  page.render({ key: "b", load: offline }).reload(); page.render(); await tick();
  assert.equal(page.render().value, "task-b"); assert.equal(page.render().error, "offline");
  page.render({ key: "b", load: async () => "reconnected" }).reload(); page.render(); await tick();
  assert.equal(page.render().value, "reconnected"); assert.equal(page.render().error, "");
});

test("资源：轮询等上次请求结束；卸载后停止调度", async () => {
  const ui = studio(), pending = deferred(); let calls = 0;
  const page = ui.mount(() => ui.useResource("poll", () => { calls++; return pending.promise; }, 5));
  await new Promise(resolve => setTimeout(resolve, 25)); assert.equal(calls, 1);
  page.dispose(); pending.resolve("late"); await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(calls, 1);
});

test("设置：多阶段及角色草稿保留；只 PUT 全局；冲突失败保留输入，重试成功清除脏状态", async t => {
  let conflict = true;
  const ui = studio(async (url, options) => url.endsWith("/settings") && options?.method === "PUT"
    ? conflict ? { ok: false, message: "版本冲突" } : { ok: true, settings: { ...JSON.parse(options.body), revision: 2 } }
    : { ok: true, exists: false });
  const props = { settings: { revision: 1, reviewMode: "every", p6Mode: "builtin", testCommand: "", stageConfig: {} },
    projects: [], defaults: { stages: STAGE_DEFS }, stage: "P1", tab: "prompts", onSaved() {}, onStage() {}, onTab() {} };
  const page = ui.mount(ui.StudioSettings, props); t.after(() => page.dispose());
  field(page.tree, "阶段提示词内容").props.onChange({ target: { value: "edited P1" } });
  page.render({ ...props, stage: "P6" }); button(page.tree, "Coder").props.onClick(); page.render();
  field(page.tree, "阶段提示词内容").props.onChange({ target: { value: "edited coder" } });
  page.render({ ...props, stage: "P1" }); assert.equal(field(page.tree, "阶段提示词内容").props.value, "edited P1");
  await button(page.tree, "保存设置").props.onClick(); page.render();
  assert.match(text(page.tree), /版本冲突/); assert.equal(field(page.tree, "阶段提示词内容").props.value, "edited P1");
  conflict = false; await button(page.tree, "保存设置").props.onClick(); page.render();
  assert.equal(button(page.tree, "保存设置").props.disabled, true);
  const saved = JSON.parse(ui.requests.filter(r => r.method === "PUT").at(-1).body);
  assert.equal(saved.stageConfig.P6.prompts.coder, "edited coder"); assert.equal(saved.stageConfig.P1.prompts[""], "edited P1");
  assert.ok(!ui.requests.some(r => r.url.includes("/projects")));
  button(page.tree, "恢复默认").props.onClick(); page.render();
  assert.equal(field(page.tree, "阶段提示词内容").props.value, STAGE_DEFS.P1.prompts[""]);
});

test("新建任务：连续提交只创建一次，失败后保留来源并可重试", async t => {
  const pending = deferred(); let attempts = 0;
  const ui = studio(() => ++attempts === 1 ? pending.promise : { ok: true, runId: "new-run" }), created = [];
  const page = ui.mount(ui.NewTaskDialog, { projects: [{ slug: "alpha", name: "Alpha", triggers: [] }], onCreated: (...args) => created.push(args) }); t.after(() => page.dispose());
  const input = walk(page.tree).find(node => node.type === "input"); input.props.onChange({ target: { value: "issue.md" } }); page.render();
  const submit = walk(page.tree).find(node => node.type === "form").props.onSubmit;
  const one = submit({ preventDefault() {} }), two = submit({ preventDefault() {} }); assert.equal(ui.requests.length, 1);
  pending.resolve({ ok: false, message: "来源不可读取" }); await Promise.all([one, two]); page.render();
  assert.match(text(page.tree), /来源不可读取/); assert.equal(walk(page.tree).find(node => node.type === "input").props.value, "issue.md"); assert.equal(created.length, 0);
  await walk(page.tree).find(node => node.type === "form").props.onSubmit({ preventDefault() {} });
  assert.deepEqual(created, [["alpha", "new-run"]]);
});

test("任务：以真实当前阶段初始化；复核携带轮次上下文，运行中禁用回滚", async t => {
  const ui = studio(async () => ({ ok: true, text: '{"patch":"a.diff"}' })), run = { id: "a", current: "P6", status: "awaiting_review", reviewMode: "every", p6Mode: "builtin", stages: { P6: { status: "awaiting_review", attempts: 2, startedAt: "2026-09-08T00:00:00Z" } } };
  const page = ui.mount(ui.RunsPanel, { slug: "alpha", runId: "a", run, tree: [], onChanged() {}, toast() {} }); t.after(() => page.dispose());
  button(page.tree, "展开流程").props.onClick(); page.render();
  assert.equal(walk(page.tree).find(n => n.props["aria-label"]?.startsWith("P6 ")).props["aria-pressed"], true, "以真实当前阶段初始化");
  button(page.tree, "收起流程").props.onClick(); page.render();
  const approve = walk(page.tree).find(node => node.type === "button" && /通过/.test(text(node)));
  assert.ok(approve); await approve.props.onClick();
  const body = JSON.parse(ui.requests.find(r => r.url.endsWith("/review")).body);
  assert.equal(body.expectedStage, "P6"); assert.equal(body.expectedAttempt, 2); assert.equal(body.expectedStartedAt, run.stages.P6.startedAt);
  const running = { ...run, status: "running", current: "P7", stages: { P7: { status: "running" } } };
  page.render({ ...page.props, run: running, tree: [{ path: "ledger/patch-ledger.jsonl", size: 20, mtimeMs: 1 }] });
  assert.ok(walk(page.tree).some(node => node.props["aria-label"] === "紧凑阶段流程"), "流程保持收起状态，节点仍可直接访问");
  button(page.tree, "展开流程").props.onClick(); page.render();
  walk(page.tree).find(node => node.type === "button" && node.props["aria-label"]?.startsWith("P7 ")).props.onClick();
  await tick(); page.render(); assert.equal(button(page.tree, "回滚").props.disabled, true);
});

test("文件：目录可折叠，失效选择回退；高亮转义 HTML，旧轮证据不算本轮通过", async t => {
  const ui = studio(async () => ({ ok: true, text: "fixture" }));
  ui.storage.set("i2p.file.alpha.a", '"gone.json"');
  const page = ui.mount(ui.ArtifactsPanel, { slug: "alpha", runId: "a", tree: [{ path: "run.json", size: 1 }, { path: "ledger/patch-ledger.jsonl", size: 1 }] }); t.after(() => page.dispose());
  assert.equal(ui.storage.get("i2p.file.alpha.a"), '"run.json"');
  const directory = walk(page.tree).find(node => node.props["aria-expanded"] === true && text(node).includes("P7 补丁应用")); assert.ok(directory);
  directory.props.onClick(); page.render(); assert.ok(!walk(page.tree).some(node => node.props.title === "ledger/patch-ledger.jsonl"));
  assert.ok(!ui.renderView('+<img src=x onerror="alert(1)">', "x.diff").includes("<img"));
  assert.ok(!ui.evidenceState({ stages: { P6: { status: "approved", startedAt: "2026-09-08T00:00:00Z" } } }, "P6", { mtimeMs: 1 }).includes("已通过"));
  assert.equal(ui.parseLines('{"patch":"a"}\nbad\n{"rollbackOf":0}')[1].lineNo, 2);
});

test("文件：Markdown 代码块和脚注提供宿主必需文案，原文模式保留完整内容", () => {
  const ui = studio();
  const source = '# 任务输入\n\n```json\n{"nodes":[{"title":"修复日期差"}]}\n```\n\n说明[^1]\n\n[^1]: 保留测试范围';
  const props = { text: source, path: "06-implementation/session-task.md" };
  const markdown = walk(ui.ArtifactContent(props)).find(node => typeof node.type === "function");
  assert.equal(markdown.props.text, source);
  // 真实宿主在渲染代码块、脚注时直接读取这些必需字段，没有默认值。
  assert.equal(markdown.props.labels?.code?.copyLabel, "复制");
  assert.equal(markdown.props.labels?.code?.copiedLabel, "已复制");
  assert.equal(markdown.props.labels?.footnotes, "脚注");
  const next = walk(ui.ArtifactContent({ ...props, text: source + '\n补充' })).find(node => typeof node.type === "function");
  assert.equal(next.props.labels, markdown.props.labels, "文案引用稳定，不因正文更新丢弃宿主渲染缓存");
  const raw = ui.ArtifactContent({ ...props, raw: true });
  assert.equal(raw.type, "pre");
  assert.match(raw.props.dangerouslySetInnerHTML.__html, /```json/);
  assert.match(raw.props.dangerouslySetInnerHTML.__html, /\[\^1\]: 保留测试范围/);
});

test("整体验证：显示实际测试退出码与审查结论；异常 Gate 值不当作 React 内容", () => {
  const ui = studio();
  assert.match(ui.reportSummary("P8", '{"passed":false,"exitCode":1,"command":"npm test"}'), /测试失败 · 退出码 1 · npm test/);
  assert.match(ui.reportSummary("P9", '{"verdict":"fail","diff_scope":"范围过大"}'), /未通过 · 范围过大/);
  assert.match(ui.reportSummary("P11", "not-json"), /格式异常/);
  assert.equal(ui.gateLabel({ message: "untrusted" }), "格式异常");
  assert.equal(ui.gateLabel("pass"), "通过"); assert.equal(ui.gateLabel(undefined), "未记录");
});

test("报告结论：阶段已复核不能把失败测试显示成通过", async t => {
  const ui = studio(async () => ({ ok: true, text: '{"passed":false,"exitCode":1}' }));
  const page = ui.mount(ui.RunReportCard, { title: "测试验证", stage: "P8", path: "07-test-report.json", slug: "alpha", runId: "a",
    tree: [{ path: "07-test-report.json", mtimeMs: Date.now() }], run: { stages: { P8: { status: "approved", startedAt: "2026-09-08T00:00:00Z" } } } });
  t.after(() => page.dispose()); await tick(); page.render();
  const badge = walk(page.tree).find(node => node.props.className === "tg t-err");
  assert.equal(text(badge), "报告未通过");
  assert.match(text(page.tree), /阶段状态：本轮阶段已通过/, "状态话术单一源");
  assert.match(text(page.tree), /测试失败/);
});

test("二期S1/S2：门禁未通过红章、通过绿章；尾部汇总替代无条件成功叙事", async t => {
  const ui = studio();
  assert.equal(ui.gateStats({ value: null }), null);
  assert.equal(ui.gateStats({ value: '"pass"' }), null, "非对象报告不统计");
  assert.deepEqual(JSON.parse(JSON.stringify(ui.gateStats({ value: '{"ROOT":"pass","PATCH":"fail","TEST":"pass","DIFF":"fail","DESC":"pass","ACCEPT":"fail"}' }))), { pass: 3, fail: 3, total: 6 });
  const page = ui.mount(ui.DeliveryPanel, { run: { stages: { P11: { status: "approved", startedAt: "2026-09-08T00:00:00Z" } } },
    tree: [{ path: "11-eval-report.json", mtimeMs: Date.now() }],
    description: { value: null, error: null },
    evaluation: { value: '{"ROOT":"pass","PATCH":"fail","TEST":"pass","DIFF":"fail","DESC":"pass","ACCEPT":"fail","EXTRA":"fail"}', error: null }, toast: () => {} });
  t.after(() => page.dispose()); page.render();
  assert.equal(walk(page.tree).filter(node => node.props.className === "tg t-err").length, 3, "三个未通过门禁为红章");
  assert.equal(walk(page.tree).filter(node => node.props.className === "tg t-good").length, 3, "三个通过门禁为绿章");
  assert.equal(walk(page.tree).filter(node => node.props.className === "hint" && /未记录/.test(text(node))).length, 0, "有值门禁不再走灰提示");
  assert.match(text(page.tree), /6 项门禁：3 通过 \/ 3 未通过/);
  assert.ok(!text(page.tree).includes("本轮阶段已通过"), "存在未通过时不再输出纯成功文案");
});

test("二期C：P11 交付警示条、失败门禁证据跳转与 patchEvidence 原因直显", async t => {
  const report = { ROOT: "fail", PATCH: "fail", TEST: "pass", DIFF: "pass", DESC: "pass", ACCEPT: "fail",
    patchEvidence: { ok: false, errors: ["06-implementation/patches/0001-T1.diff 文件内容 SHA-256 与 ledger 不一致", "工作区实际 diff 与已应用 patch 预期不一致"] } };
  const opened = [], summarized = [];
  const props = status => ({ run: { id: "a", status, stages: { P11: { status: "approved", startedAt: "2026-09-08T00:00:00Z" } } },
    tree: [{ path: "04-hypotheses.json" }, { path: "ledger/patch-ledger.jsonl" }, { path: "07-test-report.json" }, { path: "10-pr-description.md" }],
    description: { value: "PR 说明正文", error: null }, evaluation: { value: JSON.stringify(report), error: null },
    toast() {}, onFile: path => opened.push(path), onSummary: () => summarized.push(1) });
  const ui = studio();
  const page = ui.mount(ui.DeliveryPanel, props("completed")); t.after(() => page.dispose());
  const banner = walk(page.tree).find(n => String(n.props.className).includes("callout") && /交付验收尚未通过/.test(text(n)));
  assert.match(text(banner), /流程已结束，交付验收尚未通过 · 3 项未通过/, "已结束任务警示条带结论与计数");
  const jumps = walk(page.tree).filter(n => n.type === "button" && text(n) === "查看证据 ↗");
  assert.equal(jumps.length, 2, "ROOT/PATCH 文件证据入口与 ACCEPT 汇总入口明确区分");
  assert.ok(button(page.tree, "查看汇总"), "ACCEPT 汇总入口仍然存在");
  jumps[0].props.onClick(); jumps[1].props.onClick(); button(page.tree, "查看汇总").props.onClick();
  assert.deepEqual(opened, ["04-hypotheses.json", "ledger/patch-ledger.jsonl"], "文件类门禁跳对应产物");
  assert.equal(summarized.length, 1, "ACCEPT 跳全流程汇总页签");
  assert.match(text(page.tree), /0001-T1\.diff 文件内容 SHA-256 与 ledger 不一致/, "PATCH 失败直显 patchEvidence 原因");
  assert.match(text(page.tree), /工作区实际 diff 与已应用 patch 预期不一致/);
  const reviewing = ui.mount(ui.DeliveryPanel, props("awaiting_review")); t.after(() => reviewing.dispose());
  const reviewBanner = walk(reviewing.tree).find(n => String(n.props.className).includes("callout") && /交付验收尚未通过/.test(text(n)));
  assert.ok(!text(reviewBanner).includes("流程已结束"), "复核中任务不宣称流程已结束");
  const missing = ui.mount(ui.DeliveryPanel, { ...props("completed"), tree: [] }); t.after(() => missing.dispose());
  const missingJumps = walk(missing.tree).filter(n => n.type === "button" && text(n) === "查看证据 ↗");
  assert.equal(missingJumps[0].props.disabled, true, "证据文件不存在时禁用跳转");
  assert.equal(button(missing.tree, "查看汇总").props.disabled, false, "汇总跳转不依赖文件存在");
});

const deliveryGates = { ROOT: "pass", PATCH: "pass", TEST: "pass", DIFF: "pass", DESC: "pass", ACCEPT: "pass" };
const deliveryRun = (status = "completed", stageStatus = "approved") => ({ id: "delivery", current: "P11", status,
  stages: { P9: { status: "approved" }, P11: { status: stageStatus, startedAt: "2026-09-14T00:00:00Z" } } });
const deliveryTree = () => ["11-eval-report.json", "10-pr-description.md"].map(path => ({ path, mtimeMs: Date.parse("2026-09-14T00:01:00Z"), size: 500 }));
const statusBadges = tree => walk(tree).filter(node => node.type?.name === "StatusBadge").map(node => node.props.status);

test("验收状态：历史 completed 读取期间中性，失败报告同步校正任务头、P11 标题和流程节点", async t => {
  const pending = deferred();
  const ui = studio(async url => url.includes("11-eval-report") ? pending.promise : { ok: true, text: "交付说明" });
  const run = deliveryRun();
  const page = ui.mount(ui.RunsPanel, { slug: "alpha", runId: run.id, run, tree: deliveryTree(), toast() {} });
  t.after(() => page.dispose());
  assert.deepEqual(statusBadges(page.tree), ["acceptance_loading", "acceptance_loading"]);
  assert.ok(!text(page.tree).includes("验收未通过"), "读取期不闪现失败");
  pending.resolve({ ok: true, text: JSON.stringify({ ...deliveryGates, PATCH: "fail", ACCEPT: "fail" }) });
  await tick(); page.render();
  assert.deepEqual(statusBadges(page.tree), ["acceptance_failed", "acceptance_failed"]);
  assert.match(text(page.tree), /流程已结束 · 验收未通过/);
  const p11 = walk(page.tree).find(node => node.props["aria-label"]?.startsWith("P11 "));
  assert.match(p11.props.className, /acceptance_failed/);
  assert.match(p11.props["aria-label"], /验收未通过/);
  assert.match(walk(page.tree).find(node => node.props["aria-label"]?.startsWith("P9 ")).props.className, /approved/, "保留前阶段已执行事实");
  assert.equal(run.status, "completed", "只校正显示，不篡改历史记录");
});

test("验收状态：只有六项通过且交付说明有效才显示通过，缺失、损坏、旧轮产物保持待确认", async t => {
  for (const [label, raw, desc, tree, expected] of [
    ["完整报告", JSON.stringify(deliveryGates), "交付说明", deliveryTree(), "acceptance_passed"],
    ["非法 JSON", "{bad", "交付说明", deliveryTree(), "acceptance_pending"],
    ["缺少门禁", '{"ROOT":"pass"}', "交付说明", deliveryTree(), "acceptance_pending"],
    ["门禁格式异常", JSON.stringify({ ...deliveryGates, TEST: {} }), "交付说明", deliveryTree(), "acceptance_pending"],
    ["没有报告", null, "交付说明", [], "acceptance_pending"],
    ["空交付说明", JSON.stringify(deliveryGates), "", deliveryTree(), "acceptance_pending"],
    ["旧轮报告", JSON.stringify(deliveryGates), "交付说明", deliveryTree().map(file => ({ ...file, mtimeMs: 1 })), "acceptance_pending"],
  ]) {
    const ui = studio(async url => ({ ok: true, text: url.includes("11-eval-report") ? raw : desc }));
    const run = deliveryRun();
    const page = ui.mount(ui.RunsPanel, { slug: "alpha", runId: run.id, run, tree, toast() {} }); t.after(() => page.dispose());
    await tick(); page.render();
    assert.deepEqual(statusBadges(page.tree), [expected, expected], label);
  }
});

test("验收状态：执行失败保留上下文，重跑中不使用旧评测；未通过或未知的 P11 不能复核放行", async t => {
  for (const [runStatus, stageStatus, gates, expectedTask, expectedStage] of [
    ["failed", "failed", { ...deliveryGates, PATCH: "fail" }, "failed", "acceptance_failed"],
    ["failed", "failed", deliveryGates, "failed", "failed"],
    ["running", "running", { ...deliveryGates, PATCH: "fail" }, "running", "running"],
    ["awaiting_review", "awaiting_review", { ...deliveryGates, ACCEPT: "fail" }, "awaiting_review", "acceptance_failed"],
    ["awaiting_review", "awaiting_review", {}, "awaiting_review", "acceptance_pending"],
    ["awaiting_review", "awaiting_review", deliveryGates, "awaiting_review", "awaiting_review"],
  ]) {
    const ui = studio(async url => ({ ok: true, text: url.includes("11-eval-report") ? JSON.stringify(gates) : "交付说明" }));
    const run = deliveryRun(runStatus, stageStatus);
    const page = ui.mount(ui.RunsPanel, { slug: "alpha", runId: run.id, run, tree: deliveryTree(), toast() {}, onChanged() {} });
    t.after(() => page.dispose()); await tick(); page.render();
    assert.deepEqual(statusBadges(page.tree), [expectedTask, expectedStage]);
    if (runStatus === "awaiting_review") {
      const approve = button(page.tree, "通过 P11 并继续");
      assert.equal(approve.props.disabled, expectedStage !== "awaiting_review");
      if (approve.props.disabled) {
        approve.props.onClick();
        assert.ok(!ui.requests.some(request => request.method === "POST"), "事件被直接调用也不发送放行请求");
        assert.equal(button(page.tree, "打回").props.disabled, false, "保留修正路径");
      }
    }
  }
});

test("验收原因：新报告逐项展示原因，未执行门禁中性显示，旧报告明确需要重新评测", t => {
  const ui = studio();
  const report = { ...deliveryGates, schemaVersion: 2, ROOT: null, PATCH: "fail", DESC: null, ACCEPT: "fail",
    reasons: { ROOT: ["补丁证据未通过，未执行模型评测"], PATCH: ["账本与实际 diff 不一致"], DESC: ["未执行说明评测"], ACCEPT: ["PATCH 未通过，不能交付"] } };
  const props = { run: deliveryRun(), tree: deliveryTree(), description: { value: "交付说明" }, evaluation: { value: JSON.stringify(report) }, toast() {} };
  const page = ui.mount(ui.DeliveryPanel, props); t.after(() => page.dispose());
  assert.equal(walk(page.tree).filter(node => node.props.className === "tg t-err").length, 2, "只把实际 fail 标红");
  assert.equal(walk(page.tree).filter(node => node.props.className === "hint" && text(node) === "未评测").length, 2);
  assert.match(text(page.tree), /账本与实际 diff 不一致/);
  assert.match(text(page.tree), /补丁证据未通过，未执行模型评测/);
  assert.match(text(page.tree), /交付验收尚未通过 · 2 项未通过/);
  assert.ok(!text(page.tree).includes("旧报告未记录原因"));
  page.render({ ...props, evaluation: { value: JSON.stringify({ ...deliveryGates, ACCEPT: "fail" }) } });
  assert.match(text(page.tree), /旧报告未记录原因，需重新评测/);
  assert.equal(button(page.tree, "查看汇总").props.disabled, false);
  page.render({ ...props, evaluation: { value: "[]" } });
  assert.match(text(page.tree), /验收结论未能确认/);
  assert.ok(!text(page.tree).includes("本轮阶段已通过"));
});

test("任务列表：没有验收文件的 completed 列表项中性显示流程已结束，不额外请求每个报告", async t => {
  const ui = studio(async () => ({ ok: true, runs: [deliveryRun()] }));
  const page = ui.mount(ui.TaskList, { projects: [{ slug: "alpha", name: "Alpha" }], revision: 0 });
  t.after(() => page.dispose()); await tick(); page.render();
  assert.deepEqual(statusBadges(page.tree), ["flow_ended"]);
  assert.ok(button(page.tree, "流程已结束"));
  assert.ok(walk(page.tree).some(node => node.props.className === "studio-run-icon flow_ended"));
  assert.ok(!ui.requests.some(request => request.url.includes("/artifact")));
});

test("二期E2：时间线新格式带日期——展示剥离日期、遥测行过滤兼容新旧格式", async () => {
  const ui = studio();
  assert.equal(ui.timelineStripDate("2026-09-10 20:54:42|tool|Read package.json"), "20:54:42|tool|Read package.json", "新格式剥离日期只显时分秒");
  assert.equal(ui.timelineStripDate("20:54:42|tool|Read package.json"), "20:54:42|tool|Read package.json", "旧格式原样保留");
  assert.equal(ui.timelineKeep("2026-09-10 20:54:42|raw|=== 委外门禁 ==="), false, "新格式遥测行被过滤");
  assert.equal(ui.timelineKeep("20:54:42|raw|--- exit=0 ---"), false, "旧格式遥测行仍被过滤");
  assert.equal(ui.timelineKeep("2026-09-10 21:08:14|tool|Bash npm test"), true, "正常事件行保留");
  assert.equal(ui.timelineKeep(""), false, "空行过滤");
});

test("二期A2/A3/A5：外部执行事件表四列渲染、行内展开、类型/异常/搜索筛选与全量升级", async t => {
  const ui = studio();
  // 解析：tool 行拆工具名与参数；非 tool 无名称显示 —；长内容预览 120 码点截断
  const tool = ui.parseTimelineEvent(ui.timelineStripDate("2026-09-10 20:54:42|tool|Read src/index.js"));
  assert.deepEqual([tool.time, tool.kind, tool.name, tool.content], ["20:54:42", "tool", "Read", "src/index.js"], "tool 行名称取工具名");
  const entry = ui.parseTimelineEvent("20:55:01|text|找到了符号选择分支");
  assert.deepEqual([entry.name, entry.content], ["—", "找到了符号选择分支"], "非 tool 行名称为 — 不造名");
  assert.equal(ui.parseTimelineEvent("not a timeline line"), null, "不合规行不产生事件");
  const long = "x".repeat(130);
  assert.equal([...ui.previewClamp(long)].length, 120, "预览 120 码点含省略号");
  assert.match(ui.previewClamp("a\n\nb   c"), /^a b c$/, "预览压缩空白换行");
  // 组件：筛选条 + 表头四列 + 行点击展开/收起
  const lines = [
    "20:54:42|tool|Read package.json",
    "20:54:50|think|先看代码结构",
    "20:55:01|text|开始修改",
    "20:55:30|result|API Error: 403 forbidden · 8 轮",
  ];
  const fulls = []; let onFull = 0;
  const page = ui.mount(ui.TimelineTable, { lines, full: { value: null }, onFull: () => onFull++, sourcePath: "06-implementation/external-exec.log", onFile: p => fulls.push(p) }); t.after(() => page.dispose());
  assert.deepEqual(walk(page.tree).find(n => n.props.className === "studio-events-head").children.map(n => text(n)), ["时间", "类型", "名称", "内容"], "四列表头");
  const rows = () => walk(page.tree).filter(n => String(n.props.className).startsWith("studio-event-row"));
  assert.equal(rows().length, 4, "全部事件成行");
  assert.match(text(rows()[0]), /^20:54:42toolReadpackage\.json$/, "时间/类型/名称/内容相邻单行");
  rows()[0].props.onClick(); page.render();
  const expanded = () => walk(page.tree).find(n => n.props.className === "studio-event-full");
  assert.match(text(expanded()), /^package\.json/, "行内展开完整内容");
  assert.equal(rows()[0].props["aria-expanded"], true);
  // 二期 A4：展开区详情入口挂弹窗
  button(page.tree, "详情 ↗").props.onClick(); page.render();
  assert.ok(walk(page.tree).some(n => n.type === ui.EventDetailDialog), "详情弹窗挂载");
  assert.equal(rows().length, 4, "普通详情打开时保留背景事件表，避免阅读位置坍塌");
  walk(page.tree).find(n => n.type === ui.EventDetailDialog).props.onClose(); page.render();
  rows()[0].props.onClick(); page.render();
  assert.equal(expanded(), undefined, "再点收起");
  // 类型下拉：think 只剩 1 行
  walk(page.tree).find(n => n.props["aria-label"] === "筛选事件类型").props.onChange({ target: { value: "think" } }); page.render();
  assert.equal(rows().length, 1); assert.match(text(rows()[0]), /先看代码结构/);
  assert.match(text(page.tree), /think · 1/, "下拉选项由已载入事件动态生成");
  walk(page.tree).find(n => n.props["aria-label"] === "筛选事件类型").props.onChange({ target: { value: "all" } }); page.render();
  // 异常开关：只剩内容含错误关键字的 result 行
  walk(page.tree).find(n => n.props["aria-pressed"] === false && text(n) === "异常").props.onClick(); page.render();
  assert.equal(rows().length, 1); assert.match(text(rows()[0]), /403 forbidden/);
  walk(page.tree).find(n => n.props["aria-pressed"] === true && text(n) === "异常").props.onClick(); page.render();
  // 搜索：输入即触发 onFull 升级全量，且过滤命中内容
  walk(page.tree).find(n => n.props["aria-label"] === "搜索事件").props.onChange({ target: { value: "package.json" } }); page.render();
  assert.equal(onFull, 5, "类型、异常的两次切换与关键词搜索均接入全量读取");
  assert.equal(rows().length, 1); assert.match(text(page.tree), /显示 1 \/ 4 行/, "筛选计数");
  // 源文件入口
  button(page.tree, "打开源文件").props.onClick();
  assert.deepEqual(fulls, ["06-implementation/external-exec.log"]);
  // 全量加载后行集切换且带全量标注（ExecutionsPanel 在 full 就绪后把 lines 切到全量行集）
  const pageFull = ui.mount(ui.TimelineTable, { lines: [...lines, "21:00:00|tool|Grep needle"], full: { value: lines.join("\n") }, onFile() {} }); t.after(() => pageFull.dispose());
  button(pageFull.tree, "专注查看").props.onClick(); pageFull.render();
  assert.match(text(pageFull.tree), /· 全量/, "历史查看显示全量标记");
  assert.equal(walk(pageFull.tree).filter(n => String(n.props.className).startsWith("studio-event-row")).length, 5, "全量行进入表格");
  const empty = ui.mount(ui.TimelineTable, { lines: [] }); t.after(() => empty.dispose());
  assert.match(text(empty.tree), /没有可显示的事件行/);
});

test("简洁观测：暂停后只统计真实新增记录，全量搜索不会增加未读，恢复跟随清除筛选", t => {
  const ui = studio(); let fullRequests = 0;
  const one = "20:00:00|tool|Read old.js", two = "20:00:01|text|正在修改", three = "20:00:02|tool|Bash npm test", four = "20:00:03|result|测试通过";
  const props = { lines: [one], observedLines: [one], live: true, onFull: () => fullRequests++, recordedAt: "2026-09-14 20:00:00", recordingNote: "记录自动刷新" };
  const page = ui.mount(ui.TimelineTable, props); t.after(() => page.dispose());
  assert.ok(button(page.tree, "暂停跟随"), "运行中默认跟随");
  assert.match(text(page.tree), /最近记录 20:00:00 · 记录自动刷新/);
  assert.ok(walk(page.tree).some(n => n.props.title === props.recordedAt), "完整日期仍可查看");
  page.render({ ...props, lines: [one, two], observedLines: [one, two] }); page.render();
  assert.ok(!walk(page.tree).some(n => n.type === "button" && /^有 \d+ 条新记录$/.test(text(n))), "跟随时新增记录自动视为已看");
  button(page.tree, "暂停跟随").props.onClick(); page.render();
  page.render({ ...props, lines: [one, two, three, four], observedLines: [one, two, three, four] }); page.render();
  assert.ok(button(page.tree, "有 2 条新记录"));
  assert.ok(button(page.tree, "跟随最新"));
  walk(page.tree).find(n => n.props["aria-label"] === "搜索事件").props.onChange({ target: { value: "test" } }); page.render();
  assert.equal(fullRequests, 1);
  page.render({ ...page.props, lines: ["19:00:00|tool|Read history.js", ...page.props.lines], full: { value: "full archive" } }); page.render();
  assert.ok(button(page.tree, "有 2 条新记录"), "全量回填历史行不冒充新记录");
  assert.equal(walk(page.tree).filter(n => String(n.props.className).startsWith("studio-event-row")).length, 1, "搜索仍命中过滤行");
  button(page.tree, "有 2 条新记录").props.onClick(); page.render();
  assert.equal(walk(page.tree).find(n => n.props["aria-label"] === "搜索事件").props.value, "");
  assert.ok(button(page.tree, "暂停跟随"));
  assert.equal(button(page.tree, "有 2 条新记录"), undefined);
  walk(page.tree).find(n => n.props["aria-label"] === "筛选事件类型").props.onChange({ target: { value: "tool" } }); page.render();
  assert.ok(button(page.tree, "跟随最新"), "类型筛选暂停跟随");
  button(page.tree, "跟随最新").props.onClick(); page.render();
  assert.equal(walk(page.tree).find(n => n.props["aria-label"] === "筛选事件类型").props.value, "all");
  button(page.tree, "异常").props.onClick(); page.render();
  assert.ok(button(page.tree, "跟随最新"), "异常筛选也暂停跟随");
});

test("简洁观测：专注查看与事件详情单层替换，返回保留筛选，事后记录不显示实时跟随", t => {
  const ui = studio(); let inspections = 0;
  const page = ui.mount(ui.TimelineTable, { lines: ["20:00:00|tool|Read a.js", "20:00:01|result|完成"], live: false, recordingNote: "结束后记录", partial: true, onInspect: () => inspections++ }); t.after(() => page.dispose());
  assert.equal(button(page.tree, "暂停跟随"), undefined);
  assert.equal(button(page.tree, "跟随最新"), undefined);
  assert.match(text(page.tree), /最近片段/); assert.match(text(page.tree), /结束后记录/);
  walk(page.tree).find(n => n.props["aria-label"] === "筛选事件类型").props.onChange({ target: { value: "tool" } }); page.render();
  button(page.tree, "专注查看").props.onClick(); page.render();
  assert.equal(inspections, 2, "筛选与专注查看均通知父阶段暂停自动切换");
  assert.equal(page.tree.type, ui.StudioDialog);
  assert.equal(page.tree.props.title, "Agent 执行记录");
  assert.ok(walk(page.tree).some(n => n.props["aria-label"] === "执行事件滚动区"));
  walk(page.tree).find(n => String(n.props.className).startsWith("studio-event-row")).props.onClick(); page.render();
  button(page.tree, "详情 ↗").props.onClick(); page.render();
  assert.equal(inspections, 3, "事件详情同样保护当前阅读阶段");
  assert.equal(page.tree.type, ui.EventDetailDialog, "事件详情替换专注弹窗");
  assert.equal(walk(page.tree).filter(n => n.type === ui.StudioDialog).length, 0, "没有第二层专注弹窗留在树中");
  page.tree.props.onClose(); page.render();
  assert.equal(page.tree.type, ui.StudioDialog, "关闭详情回到专注记录");
  assert.equal(walk(page.tree).find(n => n.props["aria-label"] === "筛选事件类型").props.value, "tool");
  page.tree.props.onClose(); page.render();
  assert.equal(walk(page.tree).filter(n => n.type === ui.StudioDialog).length, 0);
  assert.ok(button(page.tree, "专注查看"));
});

test("最近五条事件：运行与结束默认末五条，阅读时冻结窗口，新记录不顶走已展开内容", t => {
  const ui = studio();
  const lines = Array.from({ length: 69 }, (_, i) => "20:00:00|tool|Read file-" + i + ".js");
  const props = { lines, observedLines: lines, rawLines: lines.map(line => "2026-09-14 " + line), live: true };
  const page = ui.mount(ui.TimelineTable, props); t.after(() => page.dispose());
  const rows = () => walk(page.tree).filter(n => n.props.className?.startsWith("studio-event-row"));
  assert.equal(rows().length, 5); assert.match(text(rows()[0]), /file-64\.js/); assert.match(text(rows()[4]), /file-68\.js/);
  assert.match(text(page.tree), /显示 5 \/ 69 行 · 最近 5 条/);
  const more = [...lines, "20:00:01|tool|Read file-69.js"];
  page.render({ ...props, lines: more, observedLines: more }); page.render();
  assert.equal(rows().length, 5); assert.match(text(rows()[4]), /file-69\.js/);
  rows()[0].props.onClick(); page.render();
  const expanded = text(walk(page.tree).find(n => n.props.className === "studio-event-full"));
  const latest = [...more, "20:00:02|tool|Read file-70.js", "20:00:03|result|done"];
  page.render({ ...props, lines: latest, observedLines: latest }); page.render();
  assert.equal(rows().length, 5); assert.match(text(rows()[4]), /file-69\.js/, "暂停后窗口不随新增移位");
  assert.equal(text(walk(page.tree).find(n => n.props.className === "studio-event-full")), expanded);
  assert.ok(button(page.tree, "有 2 条新记录"));
  button(page.tree, "跟随最新").props.onClick(); page.render();
  assert.match(text(rows()[4]), /done/); assert.equal(rows().length, 5);
  assert.ok(!walk(page.tree).some(n => n.props.className === "studio-event-full"));
  const ended = ui.mount(ui.TimelineTable, { lines: latest, live: false }); t.after(() => ended.dispose());
  const endedRows = walk(ended.tree).filter(n => n.props.className?.startsWith("studio-event-row"));
  assert.equal(endedRows.length, 5); assert.match(text(endedRows.at(-1)), /done/);
});

test("事件历史与筛选：专注补读历史并分页，类型和异常可命中末五条之外的记录", t => {
  const ui = studio(); let requests = 0;
  const lines = Array.from({ length: 123 }, (_, i) => "20:00:00|" + (i < 6 ? "result|ERROR early-" : "tool|Read file-") + i);
  const props = { lines, observedLines: lines.slice(-8), full: { value: lines.join("\n") }, onFull: () => requests++, partial: true };
  const page = ui.mount(ui.TimelineTable, props); t.after(() => page.dispose());
  const rows = () => walk(page.tree).filter(n => n.props.className?.startsWith("studio-event-row"));
  assert.equal(rows().length, 5);
  button(page.tree, "专注查看").props.onClick(); page.render();
  assert.equal(requests, 1); assert.equal(rows().length, 23); assert.match(text(rows()[0]), /file-100/);
  const appended = [...lines, "20:00:01|tool|Read new-arrival"];
  page.render({ ...props, lines: appended, observedLines: [...props.observedLines, appended.at(-1)], full: { value: appended.join("\n") } }); page.render();
  assert.equal(rows().length, 23); assert.match(text(rows()[0]), /file-100/); assert.doesNotMatch(text(rows().at(-1)), /new-arrival/, "历史读取快照不被追加挤到下一页");
  assert.ok(button(page.tree, "有 1 条新记录"));
  button(page.tree, "上一页").props.onClick(); page.render(); assert.equal(rows().length, 50); assert.match(text(rows()[0]), /file-50/);
  button(page.tree, "上一页").props.onClick(); page.render(); assert.match(text(rows()[0]), /early-0/);
  assert.equal(button(page.tree, "上一页").props.disabled, true);
  page.tree.props.onClose(); page.render(); assert.equal(rows().length, 5);
  button(page.tree, "异常").props.onClick(); page.render();
  assert.equal(requests, 2); assert.equal(rows().length, 6, "筛选不截成最近五条"); assert.match(text(rows()[0]), /early-0/);
  button(page.tree, "异常").props.onClick(); page.render();
  walk(page.tree).find(n => n.props["aria-label"] === "筛选事件类型").props.onChange({ target: { value: "result" } }); page.render();
  assert.equal(rows().length, 6); assert.match(text(page.tree), /时间线镜像记录，内容可能已截断/);
  walk(page.tree).find(n => n.props["aria-label"] === "筛选事件类型").props.onChange({ target: { value: "all" } }); page.render();
  walk(page.tree).find(n => n.props["aria-label"] === "搜索事件").props.onChange({ target: { value: "file-" } }); page.render();
  assert.equal(rows().length, 50); assert.match(text(rows()[0]), /file-6/);
  button(page.tree, "下一页").props.onClick(); page.render(); assert.match(text(rows()[0]), /file-56/);
  assert.match(text(page.tree), /匹配 117 条/);
});

test("二期B：P2 检索候选按卡片呈现——字段相邻、置信度分档、测试候选与待探索折叠", async t => {
  const payload = { candidates: [
    { path: "package.json", role: "依赖与版本约束", evidence: "包含 yoctocolors 依赖和 engines 字段。", confidence: "high" },
    { path: "browser-symbols.js", role: "浏览器导出", evidence: "浏览器路径未使用颜色依赖。", confidence: "medium" }],
    test_candidates: ["test.js"], uncertain: ["旧版 Node.js 行为待确认"] };
  // StageResult 侧：P2 结果文件就绪后渲染候选卡片组件（而非通用 kv 表）
  const ui = studio(async () => ({ ok: true, text: JSON.stringify(payload) }));
  const page = ui.mount(ui.StageResult, { slug: "alpha", runId: "a", stage: "P2",
    tree: [{ path: "02-search-candidates.json", mtimeMs: Date.now() }],
    run: { stages: { P2: { status: "approved", startedAt: "2026-09-08T00:00:00Z", artifact: "02-search-candidates.json" } } }, onFile() {} });
  t.after(() => page.dispose());
  await tick(); page.render();
  const cardEl = walk(page.tree).find(n => n.type === ui.SearchCandidatesCard);
  assert.ok(cardEl, "P2 走候选卡片组件");
  assert.equal(cardEl.props.parsed.candidates.length, 2, "解析后的真实报告传入卡片");
  assert.ok(!walk(page.tree).some(n => String(n.props.className).split(" ").includes("kv")), "不再走通用 kv 表渲染");
  // 卡片侧：直接挂载断言字段相邻与分档
  const card = ui.mount(ui.SearchCandidatesCard, { parsed: payload }); t.after(() => card.dispose());
  const cards = walk(card.tree).filter(n => n.props.className === "studio-candidate");
  assert.equal(cards.length, 2, "两个候选卡片");
  assert.match(text(cards[0]), /package\.json/, "文件名在卡片头");
  assert.match(text(cards[0]), /依赖与版本约束/, "职责与文件相邻");
  assert.match(text(cards[0]), /包含 yoctocolors 依赖/, "证据与文件相邻");
  assert.ok(walk(cards[0]).some(n => String(n.props.className).includes("t-good") && /高/.test(text(n))), "high 显示绿色高置信度");
  assert.ok(walk(cards[1]).some(n => String(n.props.className).includes("t-warn") && /中/.test(text(n))), "medium 显示琥珀中置信度");
  assert.match(text(card.tree), /测试候选文件 · 1/, "测试候选折叠区");
  assert.match(text(card.tree), /待探索项 · 1/, "待探索项折叠区");
});

test("任务条目：待处理筛选、标题搜索和整行跳转保留正确项目与任务", async t => {
  const opened = [];
  const ui = studio(async () => ({ ok: true, runs: [
    { id: "a", status: "awaiting_review", current: "P5", trigger: { text: "# 修复切换问题\n正文" } },
    { id: "b", status: "completed", current: "P11", trigger: { uri: "https://github.com/org/repo/issues/42" } },
    { id: "c", status: "failed", current: "P6", currentError: "补丁不适用" },
  ] }));
  const page = ui.mount(ui.TaskList, { projects: [{ slug: "alpha", name: "Alpha" }], revision: 0, onOpen: (...args) => opened.push(args) });
  t.after(() => page.dispose()); await tick(); page.render();
  assert.match(text(page.tree), /修复切换问题/); assert.match(text(page.tree), /Issue #42/);
  button(page.tree, "待处理 2").props.onClick(); page.render();
  const rows = () => walk(page.tree).filter(node => node.props.className === "studio-run-row");
  assert.equal(rows().length, 2); assert.ok(!text(page.tree).includes("Issue #42"));
  walk(page.tree).find(node => node.props["aria-label"] === "搜索任务").props.onChange({ target: { value: "修复" } }); page.render();
  assert.equal(rows().length, 1); rows()[0].props.onClick(); assert.deepEqual(opened, [["alpha", "a"]]);
  button(page.tree, "清除搜索与状态筛选").props.onClick(); page.render(); assert.equal(rows().length, 3);
});

test("项目统计：请求失败不会显示零任务或已连接；保留管理和任务入口", async t => {
  const ui = studio(async () => { throw Error("offline"); });
  const page = ui.mount(ui.ProjectsPanel, { projects: [{ slug: "alpha", name: "Alpha", repos: ["git@github.com:org/repo.git"] }], revision: 0 });
  t.after(() => page.dispose()); await tick(); page.render();
  assert.match(text(page.tree), /任务统计读取失败/); assert.ok(!text(page.tree).includes("0 项任务"));
  assert.ok(!text(page.tree).includes("已连接")); assert.ok(button(page.tree, "管理"));
});

test("复核：查看其他阶段、文件或单个实例时不能提交；返回汇总后携带当前上下文", async t => {
  const ui = studio(async url => url.includes("coder-report") ? { ok: true, text: '{"tasks":[{"node":"T1","status":"no_change"}]}' } : { ok: true });
  const run = { id: "a", current: "P6", status: "awaiting_review", p6Mode: "builtin", stages: { P6: { status: "awaiting_review", attempts: 3, startedAt: "2026-09-08T00:00:00Z" } } };
  const page = ui.mount(ui.RunsPanel, { slug: "alpha", runId: "a", run, tree: [{ path: "06-implementation/coder-report.json", size: 70, mtimeMs: 1 }], toast() {}, onChanged() {} });
  t.after(() => page.dispose()); await tick(); page.render();
  assert.ok(button(page.tree, "通过 P6 并继续"));
  button(page.tree, "展开流程").props.onClick(); page.render();
  walk(page.tree).find(n => n.props["aria-label"]?.startsWith("P2 ")).props.onClick(); page.render();
  assert.ok(!button(page.tree, "通过 P6 并继续")); assert.ok(button(page.tree, "返回当前复核对象"));
  button(page.tree, "返回当前复核对象").props.onClick(); page.render();
  button(page.tree, "全部产物 1 ↗").props.onClick(); page.render();
  const fileDialog = walk(page.tree).find(n => n.type === ui.ArtifactsDialog);
  assert.ok(fileDialog); assert.ok(!button(page.tree, "通过 P6 并继续"), "文件弹窗打开期间不允许后台复核");
  assert.ok(walk(page.tree).some(n => n.type === ui.ExecutionsPanel), "执行现场持续挂载");
  fileDialog.props.onClose(); page.render(); assert.ok(button(page.tree, "通过 P6 并继续"), "关闭文件回到原阶段复核对象");
  const executions = walk(page.tree).find(n => n.props.onSelect && n.props.selection != null);
  executions.props.onSelect("T1"); page.render(); assert.ok(!button(page.tree, "通过 P6 并继续"));
  button(page.tree, "返回当前复核对象").props.onClick(); page.render();
  await button(page.tree, "通过 P6 并继续").props.onClick();
  const request = ui.requests.find(r => r.url.endsWith("/review"));
  assert.equal(JSON.parse(request.body).expectedAttempt, 3);
});

test("流程：手动选择暂停跟随，返回按钮恢复跟随；节点选择不跨访问记忆", t => {
  const ui = studio(), run = { id: "a", current: "P2", status: "running", stages: {} };
  const page = ui.mount(ui.RunsPanel, { slug: "alpha", runId: "a", run, tree: [] }); t.after(() => page.dispose());
  button(page.tree, "展开流程").props.onClick(); page.render();
  assert.equal(walk(page.tree).filter(n => n.props.className?.startsWith("studio-stage ")).length, 10);
  assert.ok(text(page.tree).includes("跟随当前阶段 ✓"), "默认跟随状态可见");
  walk(page.tree).find(n => n.props["aria-label"]?.startsWith("P1 ")).props.onClick(); page.render();
  assert.equal(walk(page.tree).find(n => n.props["aria-label"]?.startsWith("P1 ")).props["aria-pressed"], true, "手动选择 P1");
  button(page.tree, "收起流程").props.onClick(); page.render({ ...page.props, run: { ...run, current: "P3" } });
  assert.match(text(page.tree), /需求分析尚未开始/, "跟随已暂停：推进到 P3 仍停留在 P1");
  assert.ok(button(page.tree, "正在查看 P1 · 返回当前 P3 →"), "紧凑流程也能返回当前阶段");
  button(page.tree, "展开流程").props.onClick(); page.render();
  button(page.tree, "正在查看 P1 · 返回当前 P3 →").props.onClick(); page.render();
  assert.match(text(page.tree), /代码理解尚未开始/, "返回按钮回到当前阶段");
  assert.ok(text(page.tree).includes("跟随当前阶段 ✓"), "返回后恢复跟随");
});

test("文件归属：任务日志单独分组，委托输入按阶段，实例只接受明确且唯一的关联", () => {
  const ui = studio();
  assert.equal(ui.artifactOwner("trace/events.jsonl").stage, "task");
  assert.equal(ui.artifactOwner("reviews/approve-P6.json").stage, "task");
  assert.equal(ui.artifactOwner("delegate/P3-task.md").stage, "P3");
  assert.equal(ui.artifactOwner("unknown.json").stage, "other");
  const path = "06-implementation/patches/0001-T1.diff";
  assert.equal(ui.artifactOwner(path).instance, null);
  assert.equal(ui.artifactOwner(path, null, [{ node: "T1", patch: path }]).instance, "T1");
  assert.equal(ui.artifactOwner(path, null, [null, { node: "T1", patch: "patches/0001-T1.diff" }]).instance, "T1");
  assert.equal(ui.artifactOwner("custom-result.json", { stages: { P2: { artifact: "custom-result.json" } } }).stage, "P2");
  assert.equal(ui.artifactOwner("delegate/P99-task.md").stage, "other");
  assert.equal(ui.artifactOwner(path, null, [{ node: "T1", patch: path }, { node: "T2", patch: path }]).instance, null);
});

test("文件目录：搜索临时展开，清除搜索及重新挂载保留手动折叠与选中文件", async t => {
  const ui = studio(async () => ({ ok: true, text: "file content" }));
  const props = { slug: "alpha", runId: "a", tree: [{ path: "01-issue-analysis.json", size: 12 }, { path: "ledger/patch-ledger.jsonl", size: 13 }] };
  const page = ui.mount(ui.ArtifactsPanel, props); t.after(() => page.dispose()); await tick(); page.render();
  const ledger = () => walk(page.tree).find(n => n.props.title === "ledger/patch-ledger.jsonl");
  ledger().props.onClick(); page.render();
  walk(page.tree).find(n => n.props.className === "dir" && text(n).includes("P7 ")).props.onClick(); page.render();
  assert.equal(ledger(), undefined); assert.equal(ui.storage.get("i2p.file.alpha.a"), '"ledger/patch-ledger.jsonl"');
  walk(page.tree).find(n => n.props["aria-label"] === "搜索文件").props.onChange({ target: { value: "P7" } }); page.render(); assert.ok(ledger());
  walk(page.tree).find(n => n.props["aria-label"] === "搜索文件").props.onChange({ target: { value: "" } }); page.render(); assert.equal(ledger(), undefined);
  const again = ui.mount(ui.ArtifactsPanel, props); t.after(() => again.dispose());
  assert.ok(!walk(again.tree).some(n => n.props.title === "ledger/patch-ledger.jsonl"));
  assert.match(text(again.tree), /ledger\/patch-ledger.jsonl/);
});

test("输出：筛选不截断复制内容，暂停跟随与换行按任务阶段保留", async t => {
  const ui = studio(), output = "first event\nneedle result\nlast event";
  const props = { text: output, memoryKey: "output.alpha.a.P6", label: "日志", filename: "a.log", toast() {} };
  const page = ui.mount(ui.OutputPanel, props); t.after(() => page.dispose());
  walk(page.tree).find(n => n.props["aria-label"] === "搜索日志").props.onChange({ target: { value: "needle" } }); page.render();
  assert.ok(!text(page.tree).includes("first event")); assert.match(text(page.tree), /needle result/);
  assert.match(text(page.tree), /匹配 1 \/ 共 3 行/, "动态行数计数");
  walk(page.tree).find(n => n.props.role === "log").props.onScroll({ currentTarget: { scrollTop: 0, scrollHeight: 600, clientHeight: 200 } }); page.render();
  assert.ok(button(page.tree, "跟随最新"), "搜索期间暂停自动滚动，提供返回最新入口");
  await button(page.tree, "复制日志").props.onClick(); assert.deepEqual(ui.copies, [output]);
  button(page.tree, "换行").props.onClick(); page.render();
  walk(page.tree).find(n => n.props["aria-label"] === "搜索日志").props.onChange({ target: { value: "" } }); page.render();
  assert.ok(button(page.tree, "跟随最新"), "清空搜索仍保留暂停的阅读现场，显式跟随后更新窗口");
  button(page.tree, "跟随最新").props.onClick(); page.render();
  button(page.tree, "暂停跟随").props.onClick(); page.render();
  const again = ui.mount(ui.OutputPanel, props); t.after(() => again.dispose());
  assert.ok(button(again.tree, "跟随最新")); assert.equal(button(again.tree, "换行"), undefined, "五行预览固定单行，历史/搜索才提供换行选项");
  button(again.tree, "专注查看").props.onClick(); again.render(); assert.equal(button(again.tree, "换行").props["aria-pressed"], false);
});

test("外部执行：任务图中的多个节点不被当作多个 CLI 会话", () => {
  const ui = studio();
  const report = { tasks: [{ node: "T1", status: "patched" }, { node: "T2", status: "no_change" }] };
  const rows = ui.executionItems({ externalExec: { executor: "claude-code", status: "done", sessionId: "one-session" } }, report);
  assert.equal(rows.length, 1); assert.equal(rows[0].sessionId, "one-session");
  assert.equal(ui.executionItems({}, report).length, 2);
  const patches = ui.executionItems({}, { patches: [{ node: "T1", file: "a.js", patch: "patches/a.diff" }, { node: "T1", file: "b.js", patch: "patches/b.diff" }] });
  assert.equal(new Set(patches.map(item => item.id)).size, 2, "同一任务的多文件派单必须能独立选择");
  assert.equal(patches[0].patch, "06-implementation/patches/a.diff");
});

test("简洁观测：单个外部实例直接展示记录，多个内置实例保留选择列表", t => {
  const ui = studio(), selected = [];
  const props = { slug: "alpha", runId: "a", outputKey: "out", selection: "", onSelect: id => selected.push(id), onFile() {}, onInspect() {}, toast() {}, tree: [],
    coder: { value: '{"tasks":[{"node":"T1","status":"patched"},{"node":"T2","status":"no_change"}]}' }, events: { value: "" }, eventsText: "",
    run: { externalExec: { executor: "claude-code", status: "running" } } };
  const external = ui.mount(ui.ExecutionsPanel, props); t.after(() => external.dispose());
  assert.ok(walk(external.tree).some(n => n.props.className === "studio-turn"), "无显式选择也直接看到单次外部执行");
  assert.equal(button(external.tree, "← 全部实例"), undefined, "单个外部实例不需要返回空转列表");
  assert.ok(!walk(external.tree).some(n => n.props["aria-label"] === "搜索执行实例"), "无需展示只有一个实例的搜索栏");
  assert.deepEqual(selected, [], "默认内嵌展示不改变父层实例选择");
  const builtin = ui.mount(ui.ExecutionsPanel, { ...props, run: {} }); t.after(() => builtin.dispose());
  const rows = walk(builtin.tree).filter(n => n.props.className === "studio-execution-row");
  assert.equal(rows.length, 2, "内置任务节点仍可分别查看");
  assert.ok(walk(builtin.tree).some(n => n.props["aria-label"] === "搜索执行实例"));
  rows[1].props.onClick(); assert.deepEqual(selected, ["T2"]);
  builtin.render({ ...props, run: {}, selection: "T2" });
  assert.equal(walk(builtin.tree).find(n => n.type === ui.OutputPanel).props.onInspect, props.onInspect, "内置实例的专注日志也接入阶段阅读保护");
});

test("简洁观测：默认内嵌外部记录允许阶段复核，显式实例选择仍须返回阶段对象", async t => {
  const ui = studio();
  const run = { id: "a", current: "P6", status: "awaiting_review", p6Mode: "claude",
    externalExec: { executor: "claude-code", status: "done", exitCode: 1 },
    stages: { P6: { status: "awaiting_review", attempts: 2, startedAt: "2026-09-08T00:00:00Z" } } };
  const page = ui.mount(ui.RunsPanel, { slug: "alpha", runId: "a", run, tree: [], onChanged() {}, toast() {} }); t.after(() => page.dispose());
  page.render();
  assert.equal(button(page.tree, "通过 P6 并继续").props.disabled, false, "外部产物就绪允许复核，退出码不替代就绪状态");
  const record = () => walk(page.tree).find(n => n.type === ui.ExecutionsPanel);
  assert.equal(record().props.selection, "", "默认保持阶段级上下文");
  assert.ok(!walk(page.tree).some(n => n.props["aria-label"] === "节点内容"), "只有一个内容视图时不展示无切换作用的页签");
  page.render({ ...page.props, tree: [{ path: "06-implementation/coder-report.json", size: 2, mtimeMs: 1 }] });
  assert.ok(button(page.tree, "Agent 执行记录"), "存在其他视图时明确标识 Agent 记录页签");
  record().props.onSelect("external"); page.render();
  assert.equal(button(page.tree, "通过 P6 并继续"), undefined, "显式查看实例仍禁止提交阶段复核");
  assert.equal(ui.storage.get("i2p.instance.alpha/a"), '"external"');
  button(page.tree, "返回当前复核对象").props.onClick(); page.render(); page.render();
  assert.equal(record().props.selection, "", "返回后不会被单实例自动选择再次劫持");
  await button(page.tree, "通过 P6 并继续").props.onClick();
  const body = JSON.parse(ui.requests.find(r => r.url.endsWith("/review")).body);
  assert.equal(body.expectedStage, "P6"); assert.equal(body.expectedAttempt, 2); assert.equal(body.expectedStartedAt, run.stages.P6.startedAt);
  page.render({ ...page.props, run: { ...run, externalExec: { ...run.externalExec, status: "running" } } });
  assert.equal(button(page.tree, "通过 P6 并继续").props.disabled, true, "尚未就绪的外部执行仍不能通过");
});

test("简洁观测：输入优先任务目标，缺失目标时保留原文摘要", () => {
  const ui = studio();
  const task = "# 角色\n你是外部编码 Agent。\n\n# 目标\n修复登录回跳。\n保留当前路由参数。\n\n# 约束\n禁止无关重构。";
  assert.equal(ui.taskInputSummary(task), "修复登录回跳。 保留当前路由参数。");
  // 生产 buildSessionTask 的契约是 TaskGraph JSON，默认没有单独的“目标”章节。
  const sessionTask = nodes => ["# P6 会话任务包（交外部编码会话执行：workflow + superpowers）", "", "## TaskGraph", "```json", JSON.stringify({ nodes }), "```", "", "## 要求", "- 每节点记录状态 patched / no_change / failed；"].join("\n");
  const graphTask = sessionTask([{ id: "T1", title: "修复登录回跳", input: "src/router.js" }, { id: "T2", title: "补充路由回归验证", input: "tests/router.test.js" }]);
  assert.equal(ui.taskInputSummary(graphTask), "修复登录回跳；补充路由回归验证", "真实任务包提取多个节点标题，不显示固定包头和 JSON 语法");
  const missingTitle = sessionTask([{ id: "T1", input: "src/router.js" }, { id: "T2", title: null }]);
  assert.equal(ui.taskInputSummary(missingTitle), ui.previewClamp(missingTitle, 160), "节点缺少有效标题时回退原文摘要，不凭输入路径编造目标");
  assert.equal(ui.taskInputSummary("## 任务目标：\r\n验证非 TTY 场景\r\n## 输出\r\n报告"), "验证非 TTY 场景");
  assert.equal(ui.taskInputSummary("未采用标题格式\n仍需执行的任务"), "未采用标题格式 仍需执行的任务");
  assert.equal(ui.taskInputSummary(""), "");
  assert.equal([...ui.taskInputSummary("# 目标\n" + "修".repeat(200))].length, 160, "超长目标保持紧凑预览");
});

test("简洁观测：外部元信息按需展开，完整输入保留，主要输出与辅助文件分开", async t => {
  const task = "# 角色\n你是外部编码 Agent。\n# 目标\n修复登录回跳并验证路由参数。\n# 约束\n禁止提交。";
  const timeline = "2026-09-10 20:55:30|result|修复已完成\n";
  const ui = studio(async url => ({ ok: true, text: url.includes("session-task.md") ? task : url.includes("timeline.log") ? timeline : "" })), opened = []; let inspections = 0;
  const files = ["session-task.md", "external-exec.timeline.log", "external-exec.log", "coder-report.json", "patches/fix.diff", "patches/extra.patch"];
  const props = { slug: "alpha", runId: "a", outputKey: "out", selection: "", onSelect() {}, onFile: path => opened.push(path), onInspect: () => inspections++, toast() {},
    coder: { value: null }, events: { value: "" }, eventsText: "",
    run: { externalExec: { executor: "claude-code", status: "done", sessionId: "very-long-session-id-1234567890", startedAt: "2026-09-10T12:40:00Z", finishedAt: "2026-09-10T12:55:30Z", exitCode: 0 } },
    tree: files.map(name => ({ path: "06-implementation/" + name, size: 80, mtimeMs: 1 })) };
  const page = ui.mount(ui.ExecutionsPanel, props); t.after(() => page.dispose()); await tick(); page.render();
  assert.equal((text(page.tree).match(/执行结束/g) || []).length, 1, "相同外部状态只在轮次头显示一次");
  assert.ok(!text(page.tree).includes(props.run.externalExec.sessionId), "长会话 ID 不挤占主视图");
  assert.ok(!text(page.tree).includes("退出码"), "退出码放在详情内");
  const messages = walk(page.tree).filter(n => n.type === "section" && /\bstudio-message\b/.test(n.props.className || ""));
  assert.match(text(messages[0]), /修复登录回跳并验证路由参数/);
  assert.doesNotMatch(text(messages[0]), /你是外部编码 Agent|禁止提交/, "输入预览优先目标而非角色样板");
  button(page.tree, "查看完整输入").props.onClick(); page.render();
  assert.deepEqual(opened, ["06-implementation/session-task.md"], "完整输入交给公共文件阅读器，读取原始任务包");
  assert.ok(!walk(page.tree).some(n => n.type === ui.StudioDialog), "组件不再创建工具不一致的精简输入弹窗");
  button(page.tree, "实例详情").props.onClick(); page.render();
  assert.equal(inspections, 1, "实例详情打开时暂停跟随阶段，避免执行推进卸载弹窗");
  assert.equal(walk(page.tree).find(n => n.type === ui.TimelineTable).props.onInspect, props.onInspect, "事件表沿用父级阅读保护回调");
  const infoDialog = walk(page.tree).find(n => n.type === ui.StudioDialog);
  assert.match(text(infoDialog), /very-long-session-id-1234567890/);
  assert.match(text(infoDialog), /开始时间/); assert.match(text(infoDialog), /结束时间/); assert.match(text(infoDialog), /2026-09-10/); assert.match(text(infoDialog), /退出码0/);
  infoDialog.props.onClose(); page.render();
  const output = walk(page.tree).find(n => n.type === "section" && n.props.className === "studio-message" && /^输出/.test(text(n)));
  const auxiliary = walk(output).find(n => n.type === "details" && /^更多文件 3/.test(text(n)));
  assert.ok(auxiliary); assert.ok(!auxiliary.props.open, "辅助文件默认收起");
  const hiddenNodes = new Set(walk(auxiliary));
  const primary = walk(output).filter(n => n.type === "button" && !hiddenNodes.has(n));
  assert.deepEqual(primary.map(text).sort(), ["coder-report.json", "extra.patch", "fix.diff"], "主要输出只呈现报告和补丁");
  for (const name of ["session-task.md", "external-exec.timeline.log", "external-exec.log"]) assert.ok(button(auxiliary, name), "辅助文件仍可访问：" + name);
  button(output, "fix.diff").props.onClick(); button(auxiliary, "external-exec.log").props.onClick();
  assert.deepEqual(opened, ["06-implementation/session-task.md", "06-implementation/patches/fix.diff", "06-implementation/external-exec.log"]);
});

test("简洁观测：产物弹窗保留此前阶段和实例，关闭恢复现场并保持复核隔离", async t => {
  const ui = studio(async () => ({ ok: true, text: "{}" }));
  const run = { id: "a", current: "P8", status: "awaiting_review", p6Mode: "claude", externalExec: { executor: "claude-code", status: "done" },
    stages: { P6: { status: "approved" }, P8: { status: "awaiting_review", attempts: 1 } } };
  const page = ui.mount(ui.RunsPanel, { slug: "alpha", runId: "a", run, tree: [{ path: "06-implementation/coder-report.json", size: 2, mtimeMs: 1 }], toast() {}, onChanged() {} });
  t.after(() => page.dispose()); await tick(); page.render();
  walk(page.tree).find(n => n.props["aria-label"]?.startsWith("P6 ")).props.onClick(); page.render(); page.render();
  const record = () => walk(page.tree).find(n => n.type === ui.ExecutionsPanel);
  record().props.onSelect("external"); page.render();
  button(page.tree, "全部产物 1 ↗").props.onClick(); page.render();
  const fileDialog = walk(page.tree).find(n => n.type === ui.ArtifactsDialog);
  assert.ok(fileDialog); assert.equal(button(page.tree, "展开到整页"), undefined, "不再提供另一种整页文件形式");
  assert.equal(record().props.selection, "external", "弹窗打开期间保持实例正文挂载与选择");
  assert.equal(walk(page.tree).filter(n => n.type === ui.ArtifactsDialog).length, 1, "只有一个公共文件弹窗");
  assert.equal(button(page.tree, "通过 P8 并继续"), undefined);
  fileDialog.props.onClose(); page.render();
  assert.equal(walk(page.tree).find(n => n.props["aria-label"]?.startsWith("P6 ")).props["aria-pressed"], true, "返回此前查看阶段");
  assert.equal(record().props.selection, "external", "恢复显式实例上下文");
  assert.equal(button(page.tree, "通过 P8 并继续"), undefined, "返回历史实例不会开放当前 P8 复核");
  assert.ok(button(page.tree, "返回当前复核对象"));
});

test("简洁观测：同次执行刷新保留已读时间线，跨任务和重跑不沿用旧快照", async t => {
  const refresh = deferred(), nextRun = deferred(), rerun = deferred(), pending = [refresh, nextRun, rerun]; let timelineRequests = 0;
  const firstLine = "2026-09-14 20:00:00|tool|Read first-run.js\n";
  const ui = studio(async url => {
    if (!url.includes("timeline.log")) return { ok: true, text: "" };
    return timelineRequests++ === 0 ? { ok: true, text: firstLine } : pending.shift().promise;
  });
  const props = { slug: "alpha", runId: "a", outputKey: "out", selection: "", onSelect() {}, onFile() {}, toast() {},
    coder: { value: null }, events: { value: "" }, eventsText: "", run: { id: "a", status: "running", externalExec: { executor: "claude-code", status: "running", startedAt: "2026-09-14T12:00:00Z" }, stages: { P6: { attempts: 0 } } },
    tree: [{ path: "06-implementation/external-exec.timeline.log", size: 60, mtimeMs: 1 }] };
  const page = ui.mount(ui.ExecutionsPanel, props); t.after(() => page.dispose()); await tick(); page.render();
  const table = () => walk(page.tree).find(n => n.type === ui.TimelineTable);
  assert.equal(table().props.observedLines.length, 1); assert.equal(table().props.live, true);
  const firstKey = table().props.key;
  page.render({ ...props, tree: [{ ...props.tree[0], size: 100, mtimeMs: 2 }] });
  assert.equal(table().props.observedLines.length, 1, "新版本请求期间保留已读记录");
  assert.equal(table().props.key, firstKey, "刷新不重挂载时间线而丢失跟随/阅读状态");
  refresh.resolve({ ok: true, text: firstLine + "2026-09-14 20:00:01|text|继续修改\n" }); await tick(); page.render();
  assert.equal(table().props.observedLines.length, 2); assert.equal(table().props.key, firstKey);
  const bProps = { ...props, runId: "b", run: { ...props.run, id: "b" } };
  page.render(bProps);
  assert.ok(!table() || !table().props.lines.some(line => /first-run/.test(line)), "切换任务不展示先前任务快照");
  nextRun.resolve({ ok: true, text: "2026-09-14 20:01:00|tool|Read second-run.js\n" }); await tick(); page.render();
  assert.match(table().props.observedLines.join("\n"), /second-run/);
  page.render({ ...bProps, run: { ...bProps.run, externalExec: { ...bProps.run.externalExec, startedAt: "2026-09-14T12:02:00Z" }, stages: { P6: { attempts: 1 } } } });
  assert.ok(!table() || !table().props.lines.some(line => /second-run/.test(line)), "新轮请求不能继续展示上一轮缓存");
  rerun.resolve({ ok: true, text: "2026-09-14 20:02:00|tool|Read retry.js\n" }); await tick(); page.render();
  assert.match(table().props.observedLines.join("\n"), /retry/);
  assert.equal(timelineRequests, 4);
});

test("简洁观测：大时间线尾部仍以事件表展示，全量读取失败保留记录并显示失败状态", async t => {
  const ui = studio(async url => url.includes("full=1") ? { ok: false, message: "全量读取失败" } : { ok: true, text: "2026-09-14 20:00:00|tool|Read recent.js\n2026-09-14 20:00:01|text|最近记录\n" });
  const props = { slug: "alpha", runId: "a", outputKey: "out", selection: "", onSelect() {}, onFile() {}, toast() {},
    coder: { value: null }, events: { value: "" }, eventsText: "", run: { externalExec: { executor: "claude-code", status: "running" } },
    tree: [{ path: "06-implementation/external-exec.timeline.log", size: 300 * 1024, mtimeMs: 1 }] };
  const page = ui.mount(ui.ExecutionsPanel, props); t.after(() => page.dispose()); await tick(); page.render();
  const table = () => walk(page.tree).find(n => n.type === ui.TimelineTable);
  assert.ok(table(), "超过 200KB 不丢失事件表");
  assert.ok(ui.requests.some(r => r.url.includes("timeline.log") && r.url.includes("tail=1")), "大文件主动请求尾部");
  assert.equal(table().props.partial, true); assert.equal(table().props.lines.length, 2);
  const observedBefore = table().props.observedLines.join("\n");
  table().props.onFull(); page.render(); await tick(); page.render();
  assert.ok(ui.requests.some(r => r.url.includes("timeline.log") && r.url.includes("full=1")), "搜索可请求完整镜像");
  assert.equal(table().props.lines.length, 2, "全量失败后仍可阅读已加载事件");
  assert.equal(table().props.observedLines.join("\n"), observedBefore, "失败不清空用于新增计数的观测快照");
  assert.equal(table().props.full.loading, false, "失败不冒充仍在加载");
  const reader = ui.mount(ui.TimelineTable, table().props); t.after(() => reader.dispose());
  button(reader.tree, "专注查看").props.onClick(); reader.render();
  assert.ok(walk(reader.tree).some(n => n.props.resource?.error === "全量读取失败"), "全量读取错误在专注弹窗内提供重试");
});

test("简洁观测：DSH 执行中明确结束后提供记录，完成后的时间线不宣称实时", async t => {
  const ui = studio(async () => ({ ok: true, text: "2026-09-14 20:00:00|result|已完成\n" }));
  const props = { slug: "alpha", runId: "a", outputKey: "out", selection: "", onSelect() {}, onFile() {}, toast() {},
    coder: { value: null }, events: { value: "" }, eventsText: "", tree: [],
    run: { externalExec: { executor: "dsh-agent", status: "running" } } };
  const page = ui.mount(ui.ExecutionsPanel, props); t.after(() => page.dispose());
  assert.match(text(page.tree), /结束后.*记录/);
  assert.doesNotMatch(text(page.tree), /镜像未生成|实时更新|记录自动刷新/, "不把事后记录伪装成实时能力或读取故障");
  page.render({ ...props, tree: [{ path: "06-implementation/external-exec.timeline.log", size: 60, mtimeMs: 1 }], run: { externalExec: { executor: "dsh-agent", status: "done" } } });
  await tick(); page.render();
  const table = walk(page.tree).find(n => n.type === ui.TimelineTable);
  assert.equal(table.props.live, false);
  assert.match(table.props.recordingNote, /结束后/);
});

test("节点留空：未到达阶段只有等待空态，产物弹窗保留流程与空态现场", async t => {
  const ui = studio(async () => ({ ok: true, text: "{}" }));
  const run = { id: "a", current: "P2", status: "running", stages: { P2: { status: "running", startedAt: "2026-09-08T00:00:00Z" } } };
  const page = ui.mount(ui.RunsPanel, { slug: "alpha", runId: "a", run, tree: [], toast() {}, onChanged() {} }); t.after(() => page.dispose());
  button(page.tree, "展开流程").props.onClick(); page.render();
  walk(page.tree).find(n => n.props["aria-label"]?.startsWith("P5 ")).props.onClick(); page.render();
  assert.match(text(page.tree), /任务规划尚未开始，结果生成后会显示在这里。/);
  assert.match(text(page.tree), /预期产物：05-task-graph\.json/);
  assert.ok(!text(page.tree).includes("本阶段尚未生成结果"), "空态取代通用结果占位");
  assert.ok(!text(page.tree).includes("执行日志 · 0 条事件"), "无事件不渲染日志壳");
  assert.ok(!text(page.tree).includes("阶段产物 · 0"), "无产物不渲染产物壳");
  assert.ok(button(page.tree, "正在查看 P5 · 返回当前 P2 →"), "偏离状态在流程底部可见");
  button(page.tree, "收起流程").props.onClick(); page.render();
  assert.equal(button(page.tree, "全部产物 0 ↗"), undefined, "没有文件时不提供零内容产物入口");
  page.render({ ...page.props, tree: [{ path: "run.json", size: 2, mtimeMs: 1 }] });
  walk(page.tree).find(n => n.type === "button" && /^全部产物 \d+ ↗$/.test(text(n))).props.onClick(); page.render();
  assert.ok(walk(page.tree).some(n => n.type === ui.ArtifactsDialog));
  assert.ok(walk(page.tree).some(n => n.props.className === "studio-topology"), "弹窗背景保留流程现场");
  assert.match(text(page.tree), /任务规划尚未开始/, "文件弹窗不切换原阶段");
  walk(page.tree).find(n => n.type === ui.ArtifactsDialog).props.onClose(); page.render();
  button(page.tree, "展开流程").props.onClick(); page.render();
  walk(page.tree).find(n => n.props["aria-label"]?.startsWith("P11 ")).props.onClick(); page.render();
  assert.match(text(page.tree), /交付评测尚未开始/, "P11 未到只有等待空态");
  assert.ok(!text(page.tree).includes("交付与验收"), "未到 P11 不渲染交付视图");
  assert.ok(!walk(page.tree).some(n => n.props["aria-label"] === "节点内容"), "未触及节点无子页签行");
});

test("节点子页签：内容盘点带计数置顶可发现，空内容不出页签，切换即查看", async t => {
  const ui = studio(async url => url.includes(".diff") ? { ok: true, text: "diff --git a/x b/x" }
    : url.includes("events.jsonl") ? { ok: true, text: '{"stage":"P7","kind":"info","name":"检索完成","at":"2026-09-08T00:00:00Z"}\n' }
    : url.includes("patch-ledger") ? { ok: true, text: '{"patch":"06-implementation/patches/0001-T1.diff"}\n' } : { ok: true });
  const t0 = "2026-09-08T00:00:00Z";
  const run = { id: "a", current: "P7", status: "running", stages: { P6: { status: "completed", startedAt: t0 }, P7: { status: "running", startedAt: t0 } } };
  const tree = [
    { path: "06-implementation/patches/0001-T1.diff", size: 20, mtimeMs: Date.parse(t0) + 1000 },
    { path: "ledger/patch-ledger.jsonl", size: 40, mtimeMs: Date.parse(t0) },
    { path: "trace/events.jsonl", size: 60, mtimeMs: Date.parse(t0) },
  ];
  const page = ui.mount(ui.RunsPanel, { slug: "alpha", runId: "a", run, tree, toast() {}, onChanged() {} }); t.after(() => page.dispose());
  await tick(); page.render();
  const tabButtons = () => walk(page.tree).find(n => n.props["aria-label"] === "节点内容").children.filter(n => n.type === "button");
  assert.deepEqual(tabButtons().map(n => text(n)), ["补丁账本", "阶段产物 1"], "主内容页签只保留阶段业务和产物");
  assert.match(text(page.tree), /回滚/, "默认显示补丁账本");
  button(page.tree, "阶段事件 1").props.onClick(); page.render();
  const log = walk(page.tree).find(n => n.type === ui.RunLogPanel);
  assert.ok(log); assert.equal(log.props.dialog, true); assert.equal(log.props.stage, "P7");
  assert.equal(log.props.path, "trace/events.jsonl"); assert.equal(tabButtons()[0].props["aria-pressed"], true, "阶段事件通过弹窗查看，不改变原页签");
  log.props.onClose(); page.render(); tabButtons()[1].props.onClick(); page.render();
  assert.match(text(page.tree), /patch-ledger\.jsonl/, "阶段产物页签列出本阶段文件");
});

test("查看其他阶段：无提示横条，点节点即查看；点当前阶段节点切回", async t => {
  const ui = studio(async url => url.includes(".diff") ? { ok: true, text: "diff --git a/x b/x" } : { ok: true });
  const startedAt = Date.parse("2026-09-08T00:00:00Z");
  const run = { id: "a", current: "P7", status: "running",
    stages: { P6: { status: "completed", startedAt: "2026-09-08T00:00:00Z" }, P7: { status: "running", startedAt: "2026-09-08T00:00:00Z" } } };
  const tree = [{ path: "06-implementation/patches/0001-T1.diff", size: 20, mtimeMs: startedAt + 5000 }, { path: "ledger/patch-ledger.jsonl", size: 20, mtimeMs: startedAt }];
  const page = ui.mount(ui.RunsPanel, { slug: "alpha", runId: "a", run, tree, toast() {}, onChanged() {} }); t.after(() => page.dispose());
  button(page.tree, "展开流程").props.onClick(); page.render();
  walk(page.tree).find(n => n.props["aria-label"]?.startsWith("P6 ")).props.onClick(); page.render();
  assert.ok(!walk(page.tree).some(n => n.props.className === "callout studio-row wrap"), "无提示横条");
  assert.equal(walk(page.tree).find(n => n.props["aria-label"]?.startsWith("P6 ")).props["aria-pressed"], true, "查看 P6");
  walk(page.tree).find(n => n.props["aria-label"]?.startsWith("P7 ")).props.onClick(); page.render();
  assert.match(text(page.tree), /补丁账本/, "点当前阶段节点切回 P7");
});

test("整体验证：只列本轮补丁并标注上一轮残留；未执行阶段的检查收为一行", async t => {
  const ui = studio(async url => url.includes(".diff") ? { ok: true, text: "diff --git a/x b/x" } : { ok: true });
  const startedAt = Date.parse("2026-09-08T00:00:00Z");
  const run = { id: "a", stages: { P6: { status: "completed", startedAt: "2026-09-08T00:00:00Z" } } };
  const tree = [
    { path: "06-implementation/patches/0001-T1.diff", size: 20, mtimeMs: startedAt + 5000 },
    { path: "06-implementation/patches/0000-old.diff", size: 20, mtimeMs: startedAt - 5000 },
  ];
  const page = ui.mount(ui.PatchPreview, { slug: "alpha", runId: "a", run, tree, onFile() {} }); t.after(() => page.dispose());
  await tick(); page.render();
  const select = walk(page.tree).find(n => n.props["aria-label"] === "选择补丁");
  assert.equal(select.props.value, "06-implementation/patches/0001-T1.diff");
  assert.ok(!text(page.tree).includes("0000-old.diff"), "上一轮补丁不进入本轮列表");
  assert.match(text(page.tree), /上一轮补丁/);
  const stale = ui.mount(ui.PatchPreview, { slug: "alpha", runId: "a", run: { stages: {} }, tree, onFile() {} }); t.after(() => stale.dispose());
  assert.ok(!walk(stale.tree).find(n => n.props["aria-label"] === "选择补丁"), "无本轮依据时不列补丁");
  assert.match(text(stale.tree), /上一轮补丁可从「全部产物」查看/);
  const card = ui.mount(ui.RunReportCard, { title: "测试验证", stage: "P8", path: "07-test-report.json", slug: "alpha", runId: "a", tree: [], run: { stages: {} } });
  t.after(() => card.dispose());
  assert.match(text(card.tree), /P8 尚未执行/);
  assert.ok(!text(card.tree).includes("阶段状态"), "未执行阶段不渲染完整检查卡");
});

test("阶段产物子页签：目录树居左、点击打开，只含本节点文件；阶段证据侧栏已移除", async t => {
  const ui = studio(), run = { id: "a", current: "P2", status: "running", stages: { P2: { status: "running" } } };
  const tree = [
    { path: "reviews/1-approve-P1.json", size: 10 },
    { path: "02-search-candidates.json", size: 10 },
    { path: "delegate/P2-note.md", size: 10 },
  ];
  const page = ui.mount(ui.RunsPanel, { slug: "alpha", runId: "a", run, tree, toast() {}, onChanged() {} }); t.after(() => page.dispose());
  assert.ok(!text(page.tree).includes("候选文件 + 证据"), "静态阶段描述行已移除");
  assert.ok(button(page.tree, "任务详情"), "任务详情有独立入口");
  assert.ok(!walk(page.tree).some(n => n.type === "button" && text(n) === "阶段证据"), "阶段证据侧栏入口已移除");
  const tabButtons = () => walk(page.tree).find(n => n.props["aria-label"] === "节点内容").children.filter(n => n.type === "button");
  tabButtons().find(n => text(n) === "阶段产物 2").props.onClick(); page.render();
  const group = walk(page.tree).find(n => n.props.className === "studio-artifacts-group");
  assert.ok(group, "产物目录分组渲染");
  assert.ok(walk(page.tree).some(n => n.type === "div" && n.props.className === "studio-artifacts-dir" && text(n).includes("delegate")), "子目录标题居左显示");
  const fileButton = walk(page.tree).find(n => n.type === "button" && text(n).includes("P2-note.md"));
  assert.ok(fileButton, "嵌套文件可点击");
  assert.match(text(page.tree), /02-search-candidates\.json/);
  assert.ok(!text(page.tree).includes("reviews/1-approve-P1.json"), "复核记录不进入阶段产物");
  assert.ok(!text(page.tree).includes("复核历史"));
  fileButton.props.onClick(); page.render();
  const dialog = walk(page.tree).find(n => n.type === ui.ArtifactsDialog);
  assert.equal(dialog.props.initialPath, "delegate/P2-note.md", "阶段文件直接定位同一个公共弹窗中的对应文件");
  assert.ok(tabButtons().find(n => text(n) === "阶段产物 2").props["aria-pressed"], "文件弹窗不改变阶段产物页签");
  dialog.props.onClose(); page.render();
  assert.ok(tabButtons().find(n => text(n) === "阶段产物 2").props["aria-pressed"], "关闭回到原页签");
});

test("进度可视化：真实打回次数与耗时上标题，待重验标记、P10 历史记录态、复核关注点", async t => {
  const t0 = "2026-09-08T00:00:00Z";
  const ui = studio(async url => url.includes("events.jsonl") ? { ok: true, text: [
    '{"stage":"P6","kind":"info","name":"a","at":"2026-09-08T00:00:00Z"}',
    '{"stage":"P6","kind":"info","name":"b","at":"2026-09-08T00:03:00Z"}',
  ].join("\n") } : { ok: true });
  const run = { id: "a", current: "P8", status: "awaiting_review", reviewMode: "every", p6Mode: "builtin",
    executionConfig: { defaultRoute: { provider: "fixture", model: "glm-test" }, stageConfig: { P2: { provider: "openrouter", model: "qwen-max" } }, testCommand: "npm test" },
    stages: { P6: { status: "completed", attempts: 1, startedAt: t0 }, P7: { status: "completed", startedAt: t0 }, P8: { status: "awaiting_review", startedAt: t0 } } };
  const tree = [
    { path: "05-task-graph.json", size: 20, mtimeMs: 1 },
    { path: "09-failure-analysis.json", size: 20, mtimeMs: 1 },
    { path: "trace/events.jsonl", size: 200, mtimeMs: Date.parse(t0) },
  ];
  const page = ui.mount(ui.RunsPanel, { slug: "alpha", runId: "a", run, tree, toast() {}, onChanged() {} }); t.after(() => page.dispose());
  await tick(); page.render();
  const tabsNav = walk(page.tree).find(n => n.props["aria-label"] === "任务视图");
  const runtimeSpan = walk(page.tree).find(n => n.props.className === "studio-runtime-meta hint");
  assert.equal(text(runtimeSpan), "测试执行 · npm test", "没有打回记录时不补造执行轮次");
  assert.equal(tabsNav, undefined, "重复任务视图页签已移除");
  assert.ok(walk(walk(page.tree).find(n => n.props.className === "studio-section-heading")).includes(runtimeSpan), "运行元信息仍在阶段标题行");
  assert.ok(!text(runtimeSpan).includes("模型"), "P8 不显示模型");
  button(page.tree, "展开流程").props.onClick(); page.render();
  const p6 = walk(page.tree).find(n => n.props["aria-label"]?.startsWith("P6 "));
  assert.match(p6.props.title || "", /耗时 3 分/, "流程节点悬停显示阶段耗时");
  assert.match(p6.props.title || "", /内置多智能体 · 模型 glm-test/, "悬停显示执行器与模型");
  const p2 = walk(page.tree).find(n => n.props["aria-label"]?.startsWith("P2 "));
  assert.match(p2.props.title || "", /模型 qwen-max（阶段覆盖）/, "阶段覆盖模型优先显示");
  const p7 = walk(page.tree).find(n => n.props["aria-label"]?.startsWith("P7 "));
  assert.match(p7.props.title || "", /补丁管线 · 无模型调用/, "P7 显示不走模型");
  const p5 = walk(page.tree).find(n => n.props["aria-label"]?.startsWith("P5 "));
  assert.match(text(p5), /待重验/, "重跑后带旧产物的待执行节点标记待重验");
  assert.match(text(page.tree), /P10 失败分析 · 历史记录/, "P10 三态：历史记录");
  assert.match(text(page.tree), /通过后进入 P9 · 代码审查/, "复核页脚显示关注点与下一步");
  p6.props.onClick(); page.render();
  const p6Runtime = walk(page.tree).find(n => n.props.className === "studio-runtime-meta hint");
  assert.match(text(p6Runtime), /已打回 1 次/, "attempts 只代表已有打回次数");
  assert.doesNotMatch(text(p6Runtime), /第 \d+ 轮/, "不能将打回次数换算成真实执行轮次");
});

test("二期S3：紧凑与完整流程都保留失败状态和十个可点节点", async t => {
  const t0 = "2026-09-08T00:00:00Z";
  const ui = studio(async () => ({ ok: true }));
  const run = { id: "a", current: "P6", status: "failed", p6Mode: "builtin",
    stages: { P1: { status: "approved", startedAt: t0 }, P2: { status: "approved", startedAt: t0 }, P3: { status: "approved", startedAt: t0 },
      P4: { status: "approved", startedAt: t0 }, P5: { status: "approved", startedAt: t0 }, P6: { status: "failed", startedAt: t0 } } };
  const page = ui.mount(ui.RunsPanel, { slug: "alpha", runId: "a", run, tree: [], toast() {}, onChanged() {} });
  t.after(() => page.dispose()); await tick(); page.render();
  const assertFlow = label => {
    const flow = walk(page.tree).find(n => n.props["aria-label"] === label);
    assert.ok(flow, label + "存在");
    const nodes = walk(flow).filter(n => n.type === "button");
    assert.equal(nodes.length, 10, "十个主流程阶段持续可达");
    assert.equal(nodes.filter(n => /\bapproved\b/.test(n.props.className)).length, 5, "保留五个已通过阶段");
    const failed = nodes.find(n => n.props["aria-label"]?.startsWith("P6 "));
    assert.match(failed.props.className, /\bfailed\b/, "失败阶段保留失败样式");
    assert.doesNotMatch(failed.props.className, /\brunning\b/, "失败不冒充进行中");
    assert.match(failed.props["aria-label"], /失败/, "辅助技术可读失败状态");
    for (const node of nodes) assert.equal(typeof node.props.onClick, "function", "每个阶段均能切换");
  };
  assertFlow("紧凑阶段流程");
  walk(page.tree).find(n => n.props["aria-label"]?.startsWith("P2 ")).props.onClick(); page.render();
  assert.equal(walk(page.tree).find(n => n.props["aria-label"]?.startsWith("P2 ")).props["aria-pressed"], true, "收起时可选择已完成阶段");
  button(page.tree, "展开流程").props.onClick(); page.render();
  assertFlow("完整阶段流程");
  assert.equal(walk(page.tree).find(n => n.props["aria-label"]?.startsWith("P2 ")).props["aria-pressed"], true, "展开保留所选阶段");
});

test("二期S5：••• 操作菜单受控开关——Esc 与点击外部关闭，展开态保持原交互", async t => {
  const t0 = "2026-09-08T00:00:00Z";
  const ui = studio(async () => ({ ok: true }));
  const run = { id: "a", current: "P11", status: "completed", p6Mode: "builtin",
    stages: { P11: { status: "approved", startedAt: t0 } } };
  const page = ui.mount(ui.RunsPanel, { slug: "alpha", runId: "a", run, tree: [], toast() {}, onChanged() {} });
  t.after(() => page.dispose()); await tick(); page.render();
  const menu = () => walk(page.tree).find(n => n.type === "details" && String(n.props.className).includes("studio-run-actions"));
  assert.equal(menu().props.open, false, "默认关闭");
  menu().props.onToggle({ currentTarget: { open: true } }); page.render();
  assert.equal(menu().props.open, true, "展开");
  assert.ok(button(menu(), "重跑"), "重跑保留在更多菜单");
  assert.ok(button(menu(), "删除任务"), "删除保留在更多菜单");
  assert.equal(button(menu(), "任务详情"), undefined, "任务详情移到独立入口");
  ui.docListeners.get("keydown")({ key: "Escape", stopPropagation() {} }); page.render();
  assert.equal(menu().props.open, false, "Esc 关闭");
  menu().props.onToggle({ currentTarget: { open: true } }); page.render();
  ui.docListeners.get("click")({ target: null }); page.render();
  assert.equal(menu().props.open, false, "点击外部关闭");
  assert.equal(ui.docListeners.size, 0, "关闭后监听已清理");
});

test("二期S6：面板根可承接焦点（tabIndex=-1），不再聚焦「关闭」按钮", async t => {
  const ui = studio();
  const page = ui.mount(ui.WorkbenchPage, {}); t.after(() => page.dispose());
  ui.panelStore.set(true); page.render(); page.render();
  const overlay = walk(page.tree).find(n => n.props.className === "i2p-page");
  assert.ok(overlay, "工作台已渲染");
  assert.equal(overlay.props.tabIndex, -1, "面板根可编程聚焦");
});

test("二期M-A：仅保留一条可操作流程；失败条只留结论与动作", async t => {
  const t0 = "2026-09-08T00:00:00Z";
  const ui = studio(async () => ({ ok: true }));
  const run = { id: "a", current: "P6", status: "failed", p6Mode: "builtin",
    failureAnalysis: { category: "环境缺失", detail: "未检测到补丁产物", action: "查看失败分析步骤" },
    stages: { P1: { status: "approved", startedAt: t0 }, P6: { status: "failed", attempts: 0, startedAt: t0 } } };
  const page = ui.mount(ui.RunsPanel, { slug: "alpha", runId: "a", run, tree: [], toast() {}, onChanged() {} });
  t.after(() => page.dispose()); await tick(); page.render();
  const dots = () => walk(page.tree).find(n => n.props.className === "studio-progress");
  assert.equal(dots(), undefined, "收起时不再使用不可点击的小进度条");
  assert.ok(walk(page.tree).some(n => n.props["aria-label"] === "紧凑阶段流程"));
  button(page.tree, "展开流程").props.onClick(); page.render();
  assert.equal(dots(), undefined, "展开时也不叠加小进度条");
  assert.ok(!walk(page.tree).some(n => n.props["aria-label"] === "紧凑阶段流程"), "两种节点布局互斥");
  const lane = walk(page.tree).find(n => n.props.className?.startsWith("studio-return-lane"));
  assert.match(text(lane), /环境缺失 · 查看失败分析步骤/, "页面级失败条保留结论与动作");
  assert.ok(!text(lane).includes("未检测到补丁产物"), "详细描述不在页面级重复");
  button(page.tree, "收起流程").props.onClick(); page.render();
  assert.equal(dots(), undefined, "再收起仍不恢复旧小进度条");
  assert.ok(walk(page.tree).some(n => n.props["aria-label"] === "紧凑阶段流程"));
});

test("二期M-B：打回次数显式回显生效值，未设置显示默认 3", async t => {
  const ui = studio(async (url, options) => url.endsWith("/settings") && options?.method === "PUT"
    ? { ok: true, settings: { ...JSON.parse(options.body), revision: 2 } }
    : { ok: true, exists: false });
  const props = { settings: { revision: 1, reviewMode: "every", p6Mode: "builtin", testCommand: "", stageConfig: {} },
    projects: [], defaults: { stages: STAGE_DEFS }, stage: "P1", tab: "general", onSaved() {}, onStage() {}, onTab() {} };
  const page = ui.mount(ui.StudioSettings, props); t.after(() => page.dispose());
  assert.equal(field(page.tree, "最多打回次数").props.value, 3, "未设置时显示默认生效值");
  field(page.tree, "最多打回次数").props.onChange({ target: { value: "5" } }); page.render();
  assert.equal(field(page.tree, "最多打回次数").props.value, 5, "输入后回显输入值");
  field(page.tree, "最多打回次数").props.onChange({ target: { value: "" } }); page.render();
  assert.equal(field(page.tree, "最多打回次数").props.value, 3, "清空即恢复默认生效值");
  await button(page.tree, "保存设置").props.onClick(); page.render();
  assert.ok(!("maxReviewAttempts" in JSON.parse(ui.requests.filter(r => r.method === "PUT").at(-1).body)), "清空后保存不落显式字段");
});

test("二期M-C：助手占位短文案不截断提示随行，禁用发送按钮有可感知解释", async t => {
  const ui = studio(async () => ({ ok: true }));
  ui.aiStore.set(true);
  const page = ui.mount(ui.AssistantDock, {}); t.after(() => page.dispose());
  const input = walk(page.tree).find(n => n.type === "textarea");
  assert.ok((input.props.placeholder || "").length <= 15, "占位文案不超过 15 字");
  assert.match(input.props.title || "", /Enter 发送/, "Enter 操作提示常驻 title");
  const send = () => walk(page.tree).find(n => n.props.className === "i2p-ai-send");
  assert.equal(send().props.disabled, true, "空输入禁用发送");
  assert.match(send().props.title || "", /输入内容后发送/, "禁用态解释原因");
  input.props.onChange({ target: { value: "这个 Run 为什么会失败？", style: {}, scrollHeight: 60 } }); page.render();
  assert.equal(send().props.disabled, false);
  assert.match(send().props.title || "", /发送（Enter）/, "可用态恢复操作提示");
});

test("助手：流式回答的代码块和脚注沿用完整 Markdown 文案", async t => {
  const chunks = ['示例：\n\n```js\n', 'console.log("正常")\n```\n\n说明[^1]\n\n[^1]: 测试脚注'];
  const ui = studio(async url => url.endsWith("/assistant/ask")
    ? new Response(chunks.map(delta => JSON.stringify({ delta })).join('\n') + '\n') : { ok: true });
  ui.aiStore.set(true);
  const page = ui.mount(ui.AssistantDock, {}); t.after(() => page.dispose());
  walk(page.tree).find(n => n.type === "textarea").props.onChange({ target: { value: "展示代码示例", style: {}, scrollHeight: 60 } });
  page.render();
  await walk(page.tree).find(n => n.props.className === "i2p-ai-send").props.onClick();
  await tick(); page.render();
  const markdown = walk(page.tree).find(n => typeof n.type === "function" && n.props.text === chunks.join(''));
  assert.ok(markdown, "真实 NDJSON 流读取后保留全部代码块与脚注文本");
  assert.equal(markdown.props.labels?.code?.copyLabel, "复制");
  assert.equal(markdown.props.labels?.code?.copiedLabel, "已复制");
  assert.equal(markdown.props.labels?.footnotes, "脚注");
  const fileMarkdown = walk(ui.ArtifactContent({ text: chunks.join(''), path: "answer.md" })).find(n => typeof n.type === "function");
  assert.equal(markdown.props.labels, fileMarkdown.props.labels, "助手与文件阅读器共用稳定文案");
});

test("二期L-A/L-B/L-C：面包屑悬停全量 id；预览行号槽；提示词计数与覆盖标识", async t => {
  const ui = studio(async () => ({ ok: true }));
  // L-B：纯文本与 diff 预览逐行行号，json/md 结构化视图不加
  const html = ui.renderView("one\ntwo\n", "external-exec.log");
  assert.match(html, /^<span class="ln">1<\/span>one/);
  assert.match(html, /<span class="ln">2<\/span>two$/);
  assert.ok(!html.includes('class="ln">3<'), "结尾空行不编号");
  assert.ok(!ui.renderView("+<img src=x onerror=alert(1)>", "x.diff").includes("<img"), "行号不影响转义");
  assert.ok(!ui.renderView('{"a":1}', "x.json").includes('class="ln"'), "json 视图不加行号");
  // L-A：面包屑 id 按钮悬停可见全量
  const run = { id: "20260907-142755-37", current: "P2", status: "running", stages: {} };
  const page = ui.mount(ui.RunsPanel, { slug: "alpha", runId: run.id, run, tree: [], toast() {}, onChanged() {} });
  t.after(() => page.dispose()); await tick(); page.render();
  assert.equal(walk(page.tree).find(n => n.type === "button" && String(n.props.className).includes("mono")).props.title,
    run.id + " · 点击复制", "title 携带全量 id");
  // L-C：编辑后计数与覆盖标识出现，列表项带标识点
  const props = { settings: { revision: 1, reviewMode: "every", p6Mode: "builtin", testCommand: "", stageConfig: {} },
    projects: [], defaults: { stages: STAGE_DEFS }, stage: "P1", tab: "prompts", onSaved() {}, onStage() {}, onTab() {} };
  const set = ui.mount(ui.StudioSettings, props); t.after(() => set.dispose());
  assert.match(text(set.tree), /使用默认提示词/, "默认态标识");
  assert.match(text(set.tree), /\d+ 字符/, "计数常显");
  field(set.tree, "阶段提示词内容").props.onChange({ target: { value: "edited P1" } }); set.render();
  assert.match(text(set.tree), /已覆盖默认值/, "覆盖标识");
  assert.match(text(set.tree), /9 字符/, "计数跟随输入");
  const navBtn = walk(set.tree).find(n => n.type === "button" && text(n).startsWith("P1") && /需求分析/.test(text(n)));
  assert.match(text(navBtn), /P1 •/, "阶段列表项标识点");
});

test("二期N1：超过 200KB 的产物自动尾部读取，小文件仍整读", async t => {
  const ui = studio(async () => ({ ok: true, text: "line1\nline2" }));
  const big = ui.mount(ui.ArtifactsPanel, { slug: "alpha", runId: "a", tree: [{ path: "06-implementation/external-exec.log", size: 4.2 * 1024 * 1024 }] });
  t.after(() => big.dispose()); await tick(); big.render();
  assert.match(ui.requests.at(-1).url, /tail=1/, "大文件请求带 tail 参数");
  assert.match(text(big.tree), /尾部 2 行/, "行数标注为尾部");
  assert.match(text(big.tree), /仅显示尾部最近内容/, "降级提示可见");
  const small = ui.mount(ui.ArtifactsPanel, { slug: "beta", runId: "b", tree: [{ path: "small.log", size: 1024 }] });
  t.after(() => small.dispose()); await tick(); small.render();
  assert.ok(!/tail=1/.test(ui.requests.at(-1).url), "小文件不带 tail 整读");
  assert.ok(!text(small.tree).includes("仅显示尾部最近内容"), "小文件无降级提示");
});

test("工作台入口：宿主锚点缺失时回退居中布局并给出提示，不再静默空白", async t => {
  const ui = studio();
  const page = ui.mount(ui.WorkbenchPage, {}); t.after(() => page.dispose());
  assert.equal(page.tree, null, "未开启时不渲染");
  ui.panelStore.set(true); page.render();
  assert.equal(page.tree, null, "定位在渲染后异步完成");
  page.render();
  const overlay = walk(page.tree).find(n => n.props.className === "i2p-page");
  assert.ok(overlay, "锚点缺失也渲染工作台");
  assert.match(text(page.tree), /未能定位宿主主内容列/);
  assert.ok(Number.isFinite(parseFloat(overlay.props.style.width)) && parseFloat(overlay.props.style.width) > 0, "回退几何有效");
  ui.panelStore.set(false); page.render();
  assert.equal(page.tree, null, "关闭后恢复不渲染");
});

test("渲染优化：Diff 行号按 hunk 推算，日志错误行标红，深层报告折叠", (t) => {
  const ui = studio();
  const lines = [
    "diff --git a/x.js b/x.js",
    "index 111..222 100644",
    "--- a/x.js",
    "+++ b/x.js",
    "@@ -3,3 +3,4 @@ ctx",
    " const keep = 1;",
    "-const drop = 2;",
    "+const add = 3;",
    "+const add2 = 4;",
    " const tail = 5;",
  ];
  const numbers = ui.diffLineNumbers(lines);
  assert.deepEqual(numbers.slice(4).map(n => [n.old, n.new]),
    [[null, null], [3, 3], [4, null], [null, 4], [null, 5], [5, 6]], "行号按 hunk 头推算");
  const diff = ui.mount(ui.DiffContent, { text: lines.join("\n"), path: "x.diff" }); t.after(() => diff.dispose());
  const rows = walk(diff.tree).filter(n => n.props.className?.startsWith("studio-diff-line "));
  assert.equal(rows.length, lines.length);
  assert.equal(text(rows[6]), "4-const drop = 2;", "旧行号 4、新行号列空");
  const out = ui.mount(ui.OutputPanel, { text: "ok\nERROR: boom\ndone", memoryKey: "render.m2", label: "日志", filename: "a.log", toast() {} }); t.after(() => out.dispose());
  assert.match(text(out.tree), /共 3 行 · 显示最近 3 行/);
  const bad = walk(out.tree).find(n => n.props.className === "bad");
  assert.equal(text(bad), "ERROR: boom", "错误行标红");
  const foldPage = ui.mount(ui.ReadableValue, { value: { deep: 1, more: 2 }, depth: 3 }); t.after(() => foldPage.dispose());
  const fold = walk(foldPage.tree).find(n => n.type === "details" && n.props.className === "studio-json-fold");
  assert.ok(fold, "深层对象渲染为可折叠节点");
  assert.match(text(fold), /展开 2 项/);
  const keys = ui.mount(ui.ReadableValue, { value: { root_cause: "根因文本", unknown_key: "保持原名" } }); t.after(() => keys.dispose());
  assert.match(text(keys.tree), /根因/);
  assert.match(text(keys.tree), /unknown_key/, "未映射键保持原始键名");
});

test("事件详情：历史缺失只显示摘要，源文件单层返回，搜索与分区复制可用", async t => {
  const ui = studio(async url => url.includes("/artifact") ? { ok: true, text: 'RAW-FRAME {"type":"result","is_error":false}' } : { ok: true, status: "unavailable", reason: "未找到对应原始消息" });
  const event = { time: "20:55:30", kind: "tool", name: "Bash", raw: "2026-09-10 20:55:30|tool|Bash npm run verify", content: "command: npm run verify" };
  const page = ui.mount(ui.EventDetailDialog, { event, sourcePath: "06-implementation/external-exec.log",
    slug: "alpha", runId: "a", tree: [{ path: "06-implementation/external-exec.log", size: 40, mtimeMs: 1 }], toast() {} });
  t.after(() => page.dispose());
  assert.equal(page.tree.props.title, "Bash · tool", "名称优先做弹窗标题");
  assert.match(text(page.tree), /事件摘要/, "未关联时明确是摘要");
  await button(page.tree, "复制").props.onClick();
  assert.deepEqual(ui.copies, ["command: npm run verify"], "分区复制只复制本区块");
  await button(page.tree, "复制全部").props.onClick();
  assert.equal(ui.copies[1], "事件摘要\ncommand: npm run verify", "复制全部带真实区块名");
  button(page.tree, "原始 JSON").props.onClick(); await tick(); page.render();
  assert.match(text(page.tree), /未找到对应原始消息/);
  assert.equal(button(page.tree, "复制完整 JSON").props.disabled, true);
  assert.doesNotMatch(text(page.tree), /2026-09-10 20:55:30\|tool\|Bash npm run verify/, "不将镜像冒充原始 JSON");
  // 源文件单层替换为共享 ArtifactsDialog，分别挂载其公共文件阅读器验证实际读取。
  button(page.tree, "打开源文件").props.onClick(); page.render();
  assert.equal(page.tree.type, ui.ArtifactsDialog); assert.equal(page.tree.props.initialPath, "06-implementation/external-exec.log");
  assert.equal(page.tree.props.returnLabel, "← 返回事件");
  const filesDialog = ui.mount(ui.ArtifactsDialog, page.tree.props); t.after(() => filesDialog.dispose());
  assert.equal(filesDialog.tree.type, ui.StudioDialog); assert.equal(walk(filesDialog.tree).filter(n => n.type === ui.StudioDialog).length, 1);
  const panelProps = walk(filesDialog.tree).find(n => n.type === ui.ArtifactsPanel).props;
  const files = ui.mount(ui.ArtifactsPanel, panelProps); t.after(() => files.dispose());
  assert.ok(button(files.tree, "← 返回事件"), "单层替换提供返回入口");
  assert.ok(ui.requests.some(r => decodeURIComponent(r.url).includes("06-implementation/external-exec.log")), "预览请求源文件内容");
  await tick(); files.render();
  const preview = walk(files.tree).find(n => n.type === ui.ArtifactContent);
  assert.equal(preview?.props.text, 'RAW-FRAME {"type":"result","is_error":false}', "预览读取源文件内容");
  assert.equal(preview.props.raw, true, "源文件保真渲染");
  button(files.tree, "← 返回事件").props.onClick(); page.render();
  assert.ok(!walk(page.tree).some(n => n.type === ui.ArtifactContent), "返回事件关闭文件预览");
  assert.equal(button(page.tree, "原始 JSON").props["aria-pressed"], true, "回到原始 JSON 视图保持查看态");
  // 多命中：搜索 + 上下导航
  const event2 = { time: "20:56:00", kind: "tool", name: "Bash", raw: "2026-09-10 20:56:00|tool|Bash lint", content: "npm run lint\nok\nnpm run test" };
  const nav = ui.mount(ui.EventDetailDialog, { event: event2, onFile() {}, toast() {} }); t.after(() => nav.dispose());
  const search = walk(nav.tree).find(n => n.props["aria-label"] === "搜索事件详情");
  search.props.onChange({ target: { value: "run" } }); nav.render();
  assert.match(text(nav.tree), /匹配 1 \/ 2 行/, "命中计数");
  const hit = () => walk(nav.tree).find(n => n.props.className === "hit");
  assert.match(text(hit()), /npm run lint/, "首个命中高亮");
  button(nav.tree, "下一个").props.onClick(); nav.render();
  assert.match(text(hit()), /npm run test/, "下一个导航到第二命中");
  button(nav.tree, "上一个").props.onClick(); nav.render();
  assert.match(text(hit()), /npm run lint/, "上一个回到首个命中");
  search.props.onChange({ target: { value: "不存在的词" } }); nav.render();
  assert.match(text(nav.tree), /无匹配/, "无命中提示");
});

test("二期A6：外部实例输出换成事件表，无镜像旧运行回退文本输出", async t => {
  const timeline = "2026-09-10 20:54:42|tool|Read package.json\n20:55:30|result|全部完成 · 3 轮\n";
  const ui = studio(async url => url.includes("timeline.log") ? { ok: true, text: timeline } : { ok: true, text: "" });
  const props = { slug: "alpha", runId: "a", outputKey: "out", selection: "external", onSelect() {}, onFile() {}, toast() {},
    coder: { value: null, error: null }, events: { value: "", error: null }, eventsText: "",
    run: { externalExec: { executor: "claude-code", status: "done", sessionId: "s1" } } };
  const page = ui.mount(ui.ExecutionsPanel, { ...props, tree: [
    { path: "06-implementation/external-exec.timeline.log", size: 80, mtimeMs: 1 },
    { path: "06-implementation/external-exec.log", size: 80, mtimeMs: 1 }] });
  t.after(() => page.dispose());
  await tick(); page.render();
  assert.ok(walk(page.tree).some(n => n.type === ui.TimelineTable), "有时间线镜像走事件表");
  assert.ok(!walk(page.tree).some(n => n.type === ui.OutputPanel), "外部实例不再渲染纯文本输出面板");
  // 二期 A1：单轮结构——输入块（无任务包不渲染）→ 执行过程 → 输出（最终回复 + 关联产物）
  assert.ok(!text(page.tree).includes("输入"), "无任务包时不渲染输入块");
  assert.equal(walk(page.tree).find(n => n.type === ui.TimelineTable).props.lines.length, 2, "事件计数统一由表格呈现");
  assert.match(text(page.tree), /输出/, "输出块存在");
  assert.match(text(page.tree), /全部完成 · 3 轮/, "最终回复进入输出块");
  assert.ok(walk(page.tree).some(n => n.type === "details" && /^更多文件 2/.test(text(n))), "仅有辅助日志时收进更多文件");
  const legacy = ui.mount(ui.ExecutionsPanel, { ...props, tree: [{ path: "06-implementation/external-exec.log", size: 80, mtimeMs: 1 }] });
  t.after(() => legacy.dispose());
  await tick(); legacy.render();
  const legacyLog = walk(legacy.tree).find(n => n.type === ui.RunLogPanel);
  assert.ok(legacyLog, "旧运行无镜像回退共享日志阅读器");
  assert.equal(legacyLog.props.path, "06-implementation/external-exec.log");
  assert.equal(legacyLog.props.format, ui.formatAgentLog, "原始日志仍保留 stream-json 格式化");
  assert.ok(!walk(legacy.tree).some(n => n.type === ui.TimelineTable));
});

test("Agent 原始 JSON：完整参数、额外字段与关联结果保真，复制不受搜索折叠影响", async t => {
  const id = "11111111-1111-4111-8111-111111111111:1:1";
  const message = { type: "assistant", session_id: "native-session", message: { content: [
    { type: "text", text: "同一消息的另一个内容块" },
    { type: "tool_use", id: "tool-1", name: "Bash", input: { command: "x".repeat(800) + "END-PARAM", timeout: 123, extra: { hidden: "deep-needle" } } },
  ], usage: { input_tokens: 19 } }, extra_native_field: { untouched: [1, null, false] } };
  const toolResult = { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tool-1", content: "y".repeat(800) + "END-RESULT" }] }, unknown: "preserved" };
  const record = { id, blockIndex: 1, relation: "call", origin: "agent" };
  const ui = studio(async () => ({ ok: true, status: "available", event: record, message, related: [{ event: { relation: "result", blockIndex: 0 }, message: toolResult }] }));
  const page = ui.mount(ui.EventDetailDialog, { event: { time: "10:00:00", kind: "tool", name: "Bash", content: "truncated", raw: JSON.stringify(record), record }, slug: "alpha", runId: "a", tree: [], toast() {} });
  t.after(() => page.dispose()); await tick(); page.render();
  assert.match(text(page.tree), /END-PARAM/); assert.match(text(page.tree), /END-RESULT/);
  assert.doesNotMatch(text(page.tree), /同一消息的另一个内容块/, "详情聚焦点击的 block，原始 JSON 保留整条消息");
  assert.ok(ui.requests[0].url.includes("agent-event?id=" + encodeURIComponent(id)));
  button(page.tree, "原始 JSON").props.onClick(); page.render();
  await button(page.tree, "复制完整 JSON").props.onClick(); assert.deepEqual(JSON.parse(ui.copies.at(-1)), message);
  const search = walk(page.tree).find(n => n.props["aria-label"] === "搜索事件详情");
  search.props.onChange({ target: { value: "deep-needle" } }); page.render();
  assert.match(text(page.tree), /匹配 1 \/ 1 行/); assert.match(text(walk(page.tree).find(n => n.props.className === "hit")), /deep-needle/);
  await button(page.tree, "复制完整 JSON").props.onClick(); assert.deepEqual(JSON.parse(ui.copies.at(-1)), message, "搜索不能只复制命中行");
  button(page.tree, "关联工具结果 1").props.onClick(); page.render();
  await button(page.tree, "复制完整 JSON").props.onClick(); assert.deepEqual(JSON.parse(ui.copies.at(-1)), toolResult, "关联原始消息单独呈现，不添加摘要或平台包装字段");
});

test("Agent 原始 JSON：历史歧义、平台事件不伪造，读取失败可重试且迟到消息不串任务", async t => {
  const delayed = deferred(); let offline = true;
  const ui = studio(async url => {
    if (url.includes("/old/")) return delayed.promise;
    if (offline) throw new Error("offline");
    return { ok: true, status: "ambiguous", reason: "存在多条相同摘要，无法确定对应原始消息" };
  });
  const event = { time: "10:00:00", kind: "text", name: "—", content: "摘要", raw: "2026-09-14 10:00:00|text|摘要" };
  const props = { event, slug: "alpha", runId: "old", tree: [] };
  const page = ui.mount(ui.EventDetailDialog, props); t.after(() => page.dispose());
  page.render({ ...props, runId: "new" }); await tick(); page.render();
  assert.equal(ui.requests[0].signal.aborted, true);
  button(page.tree, "原始 JSON").props.onClick(); page.render();
  assert.equal(button(page.tree, "复制完整 JSON").props.disabled, true);
  const notice = walk(page.tree).find(n => n.props.resource?.error === "offline"); assert.ok(notice);
  offline = false; notice.props.resource.reload(); page.render(); await tick(); page.render();
  assert.match(text(page.tree), /存在多条相同摘要/);
  delayed.resolve({ ok: true, status: "available", message: { secret_old_task: true } }); await tick(); page.render();
  assert.equal(button(page.tree, "复制完整 JSON").props.disabled, true, "迟到旧任务 JSON 不显示");
  assert.ok(ui.requests[0].url.includes("legacyLine=" + encodeURIComponent(event.raw)));
  const requestsBefore = ui.requests.length;
  const platform = ui.mount(ui.EventDetailDialog, { ...props, event: { ...event, record: { id: "platform-id", origin: "platform", source: null } } }); t.after(() => platform.dispose());
  assert.match(text(platform.tree), /平台生成，没有对应的 Agent 原始消息/);
  assert.equal(ui.requests.length, requestsBefore, "平台事件无需查找不存在的 Agent 帧");
});

test("Agent 结构化事件优先：保持最近五条，通过 ID 查看全消息，兼容 DSH 事后记录", async t => {
  const captureId = "11111111-1111-4111-8111-111111111111";
  const records = Array.from({ length: 9 }, (_, i) => ({ id: captureId + ":" + (i + 1) + ":0", captureId, executor: "dsh-agent", at: "2026-09-14T02:00:00Z", kind: "text", text: "native-" + i, source: { offset: i, bytes: 10 }, origin: "agent" }));
  records.at(-1).kind = "result"; records.at(-1).text = "执行结束 · completed";
  const eventsPath = "06-implementation/external-exec.events.jsonl", messagesPath = "06-implementation/external-exec.messages.jsonl";
  const ui = studio(async url => ({ ok: true, text: url.includes("events.jsonl") ? records.map(JSON.stringify).join("\n") : "" }));
  const props = { slug: "alpha", runId: "a", outputKey: "out", selection: "", onSelect() {}, onFile() {}, toast() {}, coder: { value: null }, events: { value: "" }, eventsText: "",
    tree: [{ path: eventsPath, size: 1000, mtimeMs: 1 }, { path: messagesPath, size: 1000, mtimeMs: 1 }, { path: "06-implementation/external-exec.timeline.log", size: 100, mtimeMs: 1 }], run: { externalExec: { executor: "dsh-agent", status: "done" } } };
  const page = ui.mount(ui.ExecutionsPanel, props); t.after(() => page.dispose()); await tick(); page.render();
  const table = walk(page.tree).find(n => n.type === ui.TimelineTable); assert.ok(table);
  const output = walk(page.tree).find(n => n.props["aria-label"] === "执行输出");
  assert.match(text(output), /native-7/); assert.doesNotMatch(text(output), /执行结束 · completed/, "结束原因不能覆盖 DSH 最终回复");
  assert.equal(table.props.sourcePath, messagesPath); assert.equal(table.props.live, false);
  assert.ok(!ui.requests.some(r => r.url.includes("timeline.log")), "不重复读取旧摘要");
  const reader = ui.mount(ui.TimelineTable, table.props); t.after(() => reader.dispose());
  const rows = walk(reader.tree).filter(n => n.props.className === "studio-event-row");
  assert.equal(rows.length, 5); assert.match(text(rows[0]), /native-4/); assert.match(text(rows.at(-1)), /执行结束/);
  rows.at(-1).props.onClick(); reader.render(); button(reader.tree, "详情 ↗").props.onClick(); reader.render();
  const detail = walk(reader.tree).find(n => n.type === ui.EventDetailDialog);
  assert.equal(detail.props.event.record.id, records.at(-1).id); assert.match(text(reader.tree), /原始消息全部字段在详情中搜索/);
});

test("Agent DSH 原生详情：按真实宿主字段显示思考、参数和结果，刷新保留正在阅读的消息", async t => {
  const refreshed = deferred(); let calls = 0;
  const record = { id: "11111111-1111-4111-8111-111111111111:1:0", origin: "agent", relation: "call" };
  const call = { seq: 10, time: 1700000000010, type: "tool/call", data: { turn: 1, step: 0, callId: "native-call", name: "bash", arguments: '{"command":"npm test","extra":"native-parameter"}' } };
  const result = { seq: 11, type: "tool/result", data: { message: { content: [{ type: "tool-result", toolCallId: "native-call", content: [{ type: "text", text: "native-result" }], isError: false }], source: { kind: "tool", callId: "native-call" } } } };
  const ui = studio(async () => ++calls === 1 ? { ok: true, status: "available", event: record, message: call, related: [{ event: { blockIndex: 0, relation: "result" }, message: result }] } : refreshed.promise);
  const props = { slug: "alpha", runId: "a", tree: [{ path: "06-implementation/external-exec.events.jsonl", size: 100, mtimeMs: 1 }],
    event: { time: "10:00:00", kind: "tool", name: "bash", content: "摘要", record } };
  const page = ui.mount(ui.EventDetailDialog, props); t.after(() => page.dispose()); await tick(); page.render();
  assert.match(text(page.tree), /native-parameter/); assert.match(text(page.tree), /native-result/);
  page.render({ ...props, tree: [{ ...props.tree[0], size: 120, mtimeMs: 2 }] }); page.render();
  assert.equal(calls, 2); assert.match(text(page.tree), /native-parameter/, "同一事件补读关联结果时不清空正文");
  refreshed.resolve({ ok: true, status: "available", event: { ...record, blockIndex: 0 }, message: { type: "assistant/message", data: { message: { content: [{ type: "reasoning", text: "native-reasoning" }] } } }, related: [] });
  await tick(); page.render(); assert.match(text(page.tree), /native-reasoning/);
});

test("截图对齐：任务详情常驻头部，任务说明只展示真实且不重复的现象", async t => {
  const run = { id: "a", title: "修复登录回跳", current: "P2", status: "awaiting_review", stages: { P2: { status: "awaiting_review" } } };
  const ui = studio(async () => ({ ok: true, text: '{"phenomenon":"刷新后丢失登录状态"}' }));
  const props = { slug: "alpha", runId: "a", run, tree: [{ path: "01-issue-analysis.json", size: 50, mtimeMs: 1 }], toast() {}, onChanged() {} };
  const page = ui.mount(ui.RunsPanel, props); t.after(() => page.dispose()); await tick(); page.render();
  const head = walk(page.tree).find(n => n.type === "header" && n.props.className === "studio-task-head");
  const menu = walk(head).find(n => n.type === "details" && n.props.className === "studio-run-actions");
  assert.ok(button(head, "任务详情"), "头部提供常驻详情入口");
  assert.equal(button(menu, "任务详情"), undefined, "无需展开更多操作才找到详情");
  assert.ok(button(menu, "重跑")); assert.ok(button(menu, "删除任务"));
  const caption = () => walk(page.tree).find(n => n.props.className === "studio-task-caption");
  assert.equal(text(caption()), "刷新后丢失登录状态");
  button(head, "任务详情").props.onClick(); page.render();
  const dialog = walk(page.tree).find(n => n.type === ui.StudioDialog && n.props.title === "任务详情");
  assert.ok(dialog, "独立入口仍打开原有任务详情");
  assert.match(text(dialog), /复核历史/); dialog.props.onClose();
  page.render({ ...props, run: { ...run, title: "刷新后丢失登录状态" } });
  assert.equal(caption(), undefined, "说明不重复任务标题");
  const missing = ui.mount(ui.RunsPanel, { ...props, runId: "missing", run: { ...run, id: "missing" }, tree: [] });
  t.after(() => missing.dispose());
  assert.ok(!walk(missing.tree).some(n => n.props.className === "studio-task-caption"), "没有分析产物时不补占位文案");
  const malformedUi = studio(async () => ({ ok: true, text: '{"phenomenon":{"text":"不是字符串"}}' }));
  const malformed = malformedUi.mount(malformedUi.RunsPanel, props); t.after(() => malformed.dispose()); await tick(); malformed.render();
  assert.ok(!walk(malformed.tree).some(n => n.props.className === "studio-task-caption"), "非字符串现象不作为说明渲染");
});

test("截图对齐：紧凑流程默认可点，展开偏好保留且不改变当前选择", t => {
  const ui = studio(), run = { id: "a", current: "P6", status: "running", stages: { P6: { status: "running" } } };
  const props = { slug: "alpha", runId: "a", run, tree: [] };
  const page = ui.mount(ui.RunsPanel, props); t.after(() => page.dispose());
  assert.ok(walk(page.tree).some(n => n.props["aria-label"] === "紧凑阶段流程"), "沿用默认收起偏好");
  assert.equal(button(page.tree, "展开流程").props["aria-expanded"], false);
  const p2 = walk(page.tree).find(n => n.props["aria-label"]?.startsWith("P2 "));
  p2.props.onClick(); page.render();
  assert.equal(walk(page.tree).find(n => n.props["aria-label"]?.startsWith("P2 ")).props["aria-pressed"], true);
  button(page.tree, "展开流程").props.onClick(); page.render();
  assert.equal(button(page.tree, "收起流程").props["aria-expanded"], true);
  const restored = ui.mount(ui.RunsPanel, props); t.after(() => restored.dispose());
  assert.ok(walk(restored.tree).some(n => n.props["aria-label"] === "完整阶段流程"), "同任务重新挂载恢复已保存的展开偏好");
  button(restored.tree, "收起流程").props.onClick(); restored.render();
  const compact = ui.mount(ui.RunsPanel, props); t.after(() => compact.dispose());
  assert.ok(walk(compact.tree).some(n => n.props["aria-label"] === "紧凑阶段流程"), "收起偏好同样可恢复");
});

test("截图对齐：阶段头在内容区前，标题状态元信息与产物同排，节点页签下一行", async t => {
  const ui = studio(async () => ({ ok: true, text: "{}" }));
  const run = { id: "a", current: "P6", status: "awaiting_review", p6Mode: "builtin", stages: { P6: { status: "awaiting_review", attempts: 2 } } };
  const page = ui.mount(ui.RunsPanel, { slug: "alpha", runId: "a", run, tree: [{ path: "06-implementation/coder-report.json", size: 30, mtimeMs: 1 }], toast() {}, onChanged() {} });
  t.after(() => page.dispose()); await tick(); page.render();
  const bar = walk(page.tree).find(n => n.props.className === "studio-stage-bar");
  const workspace = walk(page.tree).find(n => n.props.className === "studio-workspace");
  assert.ok(bar); assert.ok(workspace);
  assert.ok(page.tree.children.indexOf(bar) >= 0 && page.tree.children.indexOf(bar) < page.tree.children.indexOf(workspace), "阶段栏独立位于 workspace 前");
  assert.ok(!walk(workspace).includes(bar), "阶段标题不嵌在内容卡片中");
  const heading = walk(bar).find(n => n.props.className === "studio-section-heading");
  const titleRow = walk(heading).find(n => n.children?.some(child => child?.type === "h2"));
  assert.ok(titleRow); assert.match(text(titleRow), /P6 · 代码实现/);
  assert.ok(titleRow.children.some(n => n?.props?.status === "awaiting_review"), "状态与标题同行");
  assert.match(text(walk(titleRow).find(n => n.props.className === "studio-runtime-meta hint")), /已打回 2 次/);
  assert.ok(button(titleRow, "全部产物 1 ↗"));
  const nodeTabs = walk(bar).find(n => n.props["aria-label"] === "节点内容");
  assert.ok(nodeTabs, "阶段仍可切换节点内容");
  assert.ok(!walk(titleRow).includes(nodeTabs), "节点页签不与标题拥挤在同一行");
  const tabsRow = walk(bar).find(n => n.props.className === "studio-stage-tabs");
  assert.ok(walk(tabsRow).includes(nodeTabs), "节点页签位于下一行");
  assert.equal(button(tabsRow, "全部产物 1"), undefined, "不再叠加任务视图页签");
  button(titleRow, "全部产物 1 ↗").props.onClick(); page.render();
  assert.ok(walk(page.tree).some(n => n.props.className === "studio-stage-bar"), "文件弹窗保留背景阶段栏");
  assert.ok(walk(page.tree).some(n => n.props["aria-label"] === "紧凑阶段流程"), "流程不被文件阅读替换");
  assert.equal(typeof walk(page.tree).find(n => n.type === ui.ArtifactsDialog).props.onClose, "function", "关闭文件弹窗回到执行现场");
});

test("截图对齐：外部执行按单轮容器呈现输入过程输出，并显示实际执行状态", async t => {
  const timeline = "2026-09-10 20:54:42|tool|Read package.json\n2026-09-10 20:55:30|result|执行完成\n";
  const ui = studio(async url => ({ ok: true, text: url.includes("session-task") ? "处理 TaskGraph 的修复任务" : url.includes("timeline.log") ? timeline : "" }));
  const props = { slug: "alpha", runId: "a", outputKey: "out", selection: "external", onSelect() {}, onFile() {}, toast() {},
    coder: { value: null, error: null }, events: { value: "", error: null }, eventsText: "",
    run: { externalExec: { executor: "claude-code", status: "running", sessionId: "s1" }, stages: { P6: { attempts: 4 } } },
    tree: ["session-task.md", "external-exec.timeline.log", "external-exec.log"].map(name => ({ path: "06-implementation/" + name, size: 80, mtimeMs: 1 })) };
  const page = ui.mount(ui.ExecutionsPanel, props); t.after(() => page.dispose()); await tick(); page.render();
  const turn = () => walk(page.tree).find(n => n.type === "article" && n.props.className === "studio-turn");
  assert.ok(turn(), "外部记录有独立单轮卡片");
  const head = () => walk(turn()).find(n => n.props.className === "studio-turn-head");
  assert.match(text(head()), /第 1 轮/);
  assert.match(text(head()), /执行中/, "显示外部执行状态");
  assert.doesNotMatch(text(head()), /第 5 轮/, "不能把阶段打回次数冒充会话轮次");
  const body = walk(turn()).find(n => n.props.className === "studio-turn-body");
  const sections = body.children.filter(n => n?.type === "section");
  assert.equal(sections.length, 3);
  assert.match(text(sections[0]), /^输入/); assert.match(text(sections[0]), /处理 TaskGraph 的修复任务/);
  assert.match(text(sections[1]), /^执行过程/); assert.ok(walk(sections[1]).some(n => n.type === ui.TimelineTable));
  assert.match(text(sections[2]), /^输出/); assert.match(text(sections[2]), /执行完成/);
  assert.ok(!walk(turn()).some(n => ["textarea", "form"].includes(n.type) || /composer/.test(n.props.className || "")), "无不受支持的补充输入控件");
  page.render({ ...props, run: { ...props.run, externalExec: { ...props.run.externalExec, status: "failed" } } });
  assert.match(text(head()), /失败/);
  assert.ok(walk(head()).some(n => /\bt-err\b/.test(n.props.className || "")), "失败外部记录保留警示色");
});

test("二期D：全部产物统一入口——单层弹窗复用文件面板，关闭恢复现场", async t => {
  const ui = studio(async () => ({ ok: true }));
  const run = { id: "a", current: "P7", status: "running", stages: { P7: { status: "running", startedAt: "2026-09-08T00:00:00Z" } } };
  const tree = [
    { path: "ledger/patch-ledger.jsonl", size: 30, mtimeMs: 1 },
    { path: "trace/events.jsonl", size: 40, mtimeMs: 1 },
    { path: "02-search-candidates.json", size: 50, mtimeMs: 1 },
  ];
  const page = ui.mount(ui.RunsPanel, { slug: "alpha", runId: "a", run, tree, toast() {}, onChanged() {} });
  t.after(() => page.dispose());
  await tick(); page.render();
  assert.equal(button(page.tree, "全部产物 3"), undefined, "主视图不再重复放置整页产物页签");
  button(page.tree, "全部产物 3 ↗").props.onClick(); page.render();
  const dialogs = () => walk(page.tree).filter(n => n.type === ui.ArtifactsDialog);
  assert.equal(dialogs().length, 1, "单层弹窗打开，无第二层");
  const sharedDialog = ui.mount(ui.ArtifactsDialog, dialogs()[0].props); t.after(() => sharedDialog.dispose());
  assert.equal(sharedDialog.tree.type, ui.StudioDialog); assert.equal(sharedDialog.tree.props.title, "全部产物 · 3 个文件");
  assert.equal(walk(sharedDialog.tree).filter(n => n.type === ui.StudioDialog).length, 1);
  const panel = walk(sharedDialog.tree).find(n => n.type === ui.ArtifactsPanel);
  assert.ok(panel, "弹窗内复用文件面板（左树右预览）");
  assert.equal(panel.props.tree, page.props.tree, "弹窗使用任务的全部文件集");
  assert.equal(panel.props.onReturn, undefined, "弹窗内不渲染返回现场按钮");
  assert.equal(button(sharedDialog.tree, "展开到整页"), undefined, "统一文件阅读方式，不提供整页跳转");
  dialogs()[0].props.onClose(); page.render();
  assert.equal(dialogs().length, 0, "关闭弹窗回到任务页");
});

test("委外日志：stream-json 帧美化输出，非 JSON 行原样保留", async t => {
  const ui = studio();
  const raw = '{"type":"result","num_turns":8}\n--- stderr ---\nplain line';
  const page = ui.mount(ui.OutputPanel, { text: ui.formatAgentLog(raw), memoryKey: "agent.m3", label: "日志", filename: "a.log", toast() {} }); t.after(() => page.dispose());
  assert.match(text(page.tree), /"num_turns": 8/, "JSON 帧美化缩进");
  assert.match(text(page.tree), /--- stderr ---/);
  assert.match(text(page.tree), /plain line/, "非 JSON 行原样保留");
});

test("执行输出：搜索自动升级全量日志", t => {
  const ui = studio();
  const page = ui.mount(ui.OutputPanel, { text: "tail-a\ntail-b", full: { value: "tail-a\ntail-b\nHISTORY-needle" }, onFull() {}, label: "日志", memoryKey: "f1", filename: "a.log", toast() {} }); t.after(() => page.dispose());
  walk(page.tree).find(n => n.props["aria-label"] === "搜索日志").props.onChange({ target: { value: "needle" } }); page.render();
  assert.match(text(page.tree), /HISTORY-needle/, "搜索命中全量中的历史行");
  assert.match(text(page.tree), /全量/, "标记全量搜索");
});

test("统一日志读取：大文件自动 tail，按需 full，刷新失败保留同轮数据并能重试", async t => {
  let offline = false, version = 1;
  const ui = studio(async url => { if (offline) throw new Error("offline"); return { ok: true, text: (url.includes("full=1") ? "history-" : "tail-") + version }; });
  const props = { slug: "alpha", runId: "a", path: "08-test-output.txt", tree: [{ path: "08-test-output.txt", size: 300000, mtimeMs: 1 }], identity: "P8.1" };
  const page = ui.mount(p => ui.useLogArtifact(p.slug, p.runId, p.path, p.tree, p.identity), props); t.after(() => page.dispose());
  await tick(); page.render();
  assert.equal(page.tree.resource.value, "tail-1"); assert.equal(page.tree.partial, true);
  assert.ok(ui.requests.every(request => request.url.includes("tail=1")), "默认不发昂贵的 full 请求");
  page.tree.onFull(); page.render(); assert.equal(page.tree.full.loading, true); await tick(); page.render();
  assert.equal(page.tree.full.value, "history-1"); assert.equal(ui.requests.filter(request => request.url.includes("full=1")).length, 1);
  offline = true;
  const refreshed = { ...props, tree: [{ ...props.tree[0], size: 310000, mtimeMs: 2 }] };
  page.render(refreshed); assert.equal(page.tree.resource.value, "tail-1", "树刷新空窗保留同轮尾部");
  assert.equal(page.tree.full.stale, true); await tick(); page.render();
  assert.equal(page.tree.resource.value, "tail-1"); assert.equal(page.tree.resource.error, "offline");
  assert.equal(page.tree.full.value, "history-1"); assert.equal(page.tree.full.error, "offline");
  offline = false; version = 2; page.tree.resource.reload(); page.tree.full.reload(); page.render(); await tick(); page.render();
  assert.equal(page.tree.resource.value, "tail-2"); assert.equal(page.tree.full.value, "history-2"); assert.equal(page.tree.full.error, "");
});

test("统一日志读取：切任务、重跑、删除与截短文件清空旧快照，迟到响应不串记录", async t => {
  let pending = null;
  const ui = studio(async (url, options) => pending ? pending.promise : { ok: true, text: url.includes("full=1") ? "old-full" : "old-preview" });
  const props = { slug: "alpha", runId: "a", path: "trace/events.jsonl", tree: [{ path: "trace/events.jsonl", size: 300000, mtimeMs: 10 }], identity: "attempt1" };
  const page = ui.mount(p => ui.useLogArtifact(p.slug, p.runId, p.path, p.tree, p.identity), props); t.after(() => page.dispose());
  await tick(); page.render(); page.tree.onFull(); page.render(); await tick(); page.render();
  assert.equal(page.tree.full.value, "old-full");
  pending = deferred(); page.render({ ...props, tree: [{ ...props.tree[0], mtimeMs: 11 }] });
  page.render({ ...props, tree: [] }); assert.equal(page.tree.resource.value, null); assert.equal(page.tree.full.value, null);
  pending.resolve({ ok: true, text: "late-deleted" }); await tick(); page.render(); assert.equal(page.tree.resource.value, null);
  pending = deferred(); page.render(props); assert.equal(page.tree.resource.value, null); assert.equal(page.tree.full.value, null);
  pending.resolve({ ok: true, text: "new-file" }); await tick(); page.render(); assert.equal(page.tree.resource.value, "new-file");
  pending = deferred(); page.render({ ...props, identity: "attempt2" }); assert.equal(page.tree.resource.value, null, "重跑不使用上一轮快照");
  pending.resolve({ ok: true, text: "attempt2" }); await tick(); page.render(); assert.equal(page.tree.resource.value, "attempt2");
  pending = deferred(); page.render({ ...props, identity: "attempt2", tree: [{ ...props.tree[0], size: 10, mtimeMs: 12 }] });
  assert.equal(page.tree.resource.value, null, "文件截短视为新日志"); assert.equal(page.tree.partial, false);
  page.render({ ...props, runId: "b" }); assert.equal(page.tree.resource.value, null, "切换任务隔离读取状态");
  assert.ok(ui.requests.at(-2).signal.aborted, "上一个任务/文件读取已取消");
  pending.resolve({ ok: true, text: "task-b" }); await tick(); page.render(); assert.equal(page.tree.resource.value, "task-b");
});

test("统一阶段日志：先按阶段过滤再搜索，全量也保留阶段边界且支持文本格式化", t => {
  const ui = studio();
  const event = (stage, detail) => JSON.stringify({ at: "2026-09-14T08:00:00Z", stage, kind: "stage.note", detail });
  const tail = event("P8", "recent test") + "\n" + event("P9", "OTHER-STAGE-needle");
  const full = event("P8", "P8-HISTORY-needle") + "\n" + tail;
  const props = { slug: "alpha", runId: "a", path: "trace/events.jsonl", tree: [], stage: "P8", label: "P8 · 阶段事件", memoryKey: "events.a.P8", filename: "a-P8.log", toast() {},
    log: { resource: { value: tail }, full: { value: full }, onFull() {}, partial: true } };
  const page = ui.mount(ui.RunLogPanel, props); t.after(() => page.dispose());
  assert.equal(page.tree.props.searchScope, "本阶段事件", "阶段事件明确全量范围仍限于本阶段");
  assert.equal(ui.requests.length, 0, "复用根日志读取，不重复请求");
  assert.match(page.tree.props.text, /recent test/); assert.doesNotMatch(page.tree.props.text, /OTHER-STAGE/);
  assert.match(page.tree.props.full.value, /P8-HISTORY-needle/); assert.doesNotMatch(page.tree.props.full.value, /OTHER-STAGE/);
  const output = ui.mount(ui.OutputPanel, page.tree.props); t.after(() => output.dispose());
  walk(output.tree).find(node => node.props["aria-label"] === "搜索日志").props.onChange({ target: { value: "needle" } }); output.render();
  assert.match(text(output.tree), /P8-HISTORY-needle/); assert.doesNotMatch(text(output.tree), /OTHER-STAGE/);
  page.render({ ...props, format: value => "formatted:" + value });
  assert.match(page.tree.props.text, /^formatted:/); assert.match(page.tree.props.full.value, /^formatted:/);
});

test("统一日志搜索：全量独立于尾部为空，复制不受筛选限制，失败显示重试及实际范围", async t => {
  const ui = studio(), fullText = "history-needle\nother historical line"; let retries = 0;
  const props = { text: "", partial: true, full: { value: fullText }, onFull() {}, label: "P8 · 阶段事件", memoryKey: "search.empty", filename: "events.log", toast() {} };
  const page = ui.mount(ui.OutputPanel, props); t.after(() => page.dispose());
  walk(page.tree).find(node => node.props["aria-label"] === "搜索日志").props.onChange({ target: { value: "needle" } }); page.render();
  assert.match(text(page.tree), /history-needle/); assert.match(text(page.tree), /匹配 1 \/ 共 2 行 · 全量/);
  assert.doesNotMatch(text(page.tree), /仅尾部最近内容/, "尾部提示不能覆盖实际全量搜索范围");
  await button(page.tree, "复制日志").props.onClick(); assert.deepEqual(ui.copies, [fullText]);
  page.render({ ...props, text: "preview-needle", full: { value: null, error: "文件超过 5MB", reload: () => retries++ } });
  assert.match(text(page.tree), /全量读取失败/); assert.match(text(page.tree), /history-needle/, "更新失败不丢失已读全量快照");
  assert.ok(button(page.tree, "复制日志"));
  const notice = walk(page.tree).find(node => node.props.resource?.error === "文件超过 5MB"); assert.ok(notice); notice.props.resource.reload(); assert.equal(retries, 1);
  const failed = ui.mount(ui.OutputPanel, { ...props, memoryKey: "search.first-error", text: "preview-needle", full: { value: null, error: "文件超过 5MB", reload() {} } }); t.after(() => failed.dispose());
  walk(failed.tree).find(node => node.props["aria-label"] === "搜索日志").props.onChange({ target: { value: "needle" } }); failed.render();
  assert.match(text(failed.tree), /已读内容/); assert.ok(button(failed.tree, "复制已读内容"), "从未读到全量时明确只搜索和复制已读片段");
});

test("统一日志交互：普通日志随工作区滚动，专注与源文件保持单层弹窗并保留搜索", t => {
  const ui = studio(); let closes = 0, inspections = 0;
  const props = { text: "first\nneedle\nlast", memoryKey: "output.focus", label: "P8 · 测试输出", filename: "output.txt", toast() {}, onFile() {}, onInspect: () => inspections++,
    artifactProps: { slug: "alpha", runId: "a", tree: [{ path: "08-test-output.txt" }], initialPath: "08-test-output.txt", initialRaw: true } };
  const page = ui.mount(ui.OutputPanel, props); t.after(() => page.dispose());
  assert.ok(!walk(page.tree).some(node => node.type === ui.StudioDialog)); assert.ok(button(page.tree, "专注查看"));
  assert.equal(walk(page.tree).find(node => node.props.role === "log").props.tabIndex, undefined, "普通文本没有独立纵向滚动焦点");
  button(page.tree, "专注查看").props.onClick(); page.render(); assert.equal(page.tree.type, ui.StudioDialog);
  assert.equal(inspections, 1, "日志专注查看通知父阶段保留阅读现场");
  walk(page.tree).find(node => node.props["aria-label"] === "搜索日志").props.onChange({ target: { value: "needle" } }); page.render();
  button(page.tree, "打开源文件").props.onClick(); page.render(); assert.equal(page.tree.type, ui.ArtifactsDialog);
  assert.equal(page.tree.props.initialPath, "08-test-output.txt"); assert.equal(page.tree.props.returnLabel, "返回日志");
  assert.equal(walk(page.tree).filter(node => node.type === ui.StudioDialog).length, 0, "文件替换日志弹窗，不嵌套");
  page.tree.props.onReturn(); page.render(); assert.equal(page.tree.type, ui.StudioDialog);
  assert.equal(walk(page.tree).find(node => node.props["aria-label"] === "搜索日志").props.value, "needle");
  button(page.tree, "打开源文件").props.onClick(); page.render(); page.tree.props.onClose(); page.render();
  assert.equal(page.tree.type, ui.StudioDialog, "文件关闭与返回一致，先回日志现场");
  page.tree.props.onClose(); page.render(); assert.ok(button(page.tree, "专注查看"));
  const dialog = ui.mount(ui.OutputPanel, { ...props, dialog: true, onClose: () => closes++ }); t.after(() => dialog.dispose());
  assert.equal(dialog.tree.type, ui.StudioDialog); dialog.tree.props.onClose(); assert.equal(closes, 1);
  const source = readFileSync(new URL("../../client.js", import.meta.url), "utf8");
  assert.doesNotMatch(source.match(/\.studio \.studio-terminal\{[^}]+\}/)[0], /max-height|overflow:auto/);
});

test("统一日志交互：暂停时提示新增记录，跟随最新清空筛选与未读数", t => {
  const ui = studio(), props = { text: "first\nsecond", memoryKey: "output.unread", label: "日志", filename: "a.log", toast() {} };
  const page = ui.mount(ui.OutputPanel, props); t.after(() => page.dispose());
  button(page.tree, "暂停跟随").props.onClick(); page.render();
  page.render({ ...props, text: props.text + "\nthird\nfourth" }); page.render();
  assert.ok(button(page.tree, "有 2 条新记录"));
  walk(page.tree).find(node => node.props["aria-label"] === "搜索日志").props.onChange({ target: { value: "first" } }); page.render();
  button(page.tree, "跟随最新").props.onClick(); page.render();
  assert.equal(walk(page.tree).find(node => node.props["aria-label"] === "搜索日志").props.value, "");
  assert.ok(!button(page.tree, "有 2 条新记录")); assert.ok(button(page.tree, "暂停跟随"));
});

test("统一日志搜索：每页50条，早期与600条之后的匹配均可读取，复制保留全量", async t => {
  const ui = studio(), value = Array.from({ length: 701 }, (_, i) => "needle-" + String(i + 1).padStart(4, "0")).join("\n");
  const page = ui.mount(ui.OutputPanel, { text: "needle-0701", full: { value }, onFull() {}, partial: true, label: "日志", memoryKey: "logs.pages", filename: "big.log", toast() {} }); t.after(() => page.dispose());
  walk(page.tree).find(node => node.props["aria-label"] === "搜索日志").props.onChange({ target: { value: "needle" } }); page.render();
  assert.match(text(page.tree), /显示第 1–50 条匹配/); assert.match(text(page.tree), /needle-0001/); assert.doesNotMatch(text(page.tree), /needle-0701/);
  button(page.tree, "下一页匹配").props.onClick(); page.render();
  assert.match(text(page.tree), /显示第 51–100 条匹配/); assert.doesNotMatch(text(page.tree), /needle-0001/);
  for (let i = 0; i < 13; i++) { button(page.tree, "下一页匹配").props.onClick(); page.render(); }
  assert.match(text(page.tree), /needle-0701/); assert.match(text(page.tree), /显示第 701–701 条匹配/);
  assert.equal(button(page.tree, "下一页匹配").props.disabled, true);
  await button(page.tree, "复制日志").props.onClick(); assert.deepEqual(ui.copies, [value]);
});

test("文本日志五行预览：追加更新最后5行不滚动页面，暂停和打开文件冻结当前窗口", async t => {
  const ui = studio(), source = count => Array.from({ length: count }, (_, i) => "record-" + String(i + 1).padStart(3, "0")).join("\n") + "\n";
  const workspace = { scrollTop: 321, addEventListener() {}, removeEventListener() {} }; let opened = 0;
  const props = { text: source(12), memoryKey: "five.follow", label: "执行日志", filename: "run.log", toast() {}, onFile: () => opened++ };
  const page = ui.mount(p => { const tree = ui.OutputPanel(p); walk(tree).find(n => n.props.ref && /studio-terminal-shell/.test(n.props.className || "")).props.ref.current.closest = () => workspace; return tree; }, props);
  t.after(() => page.dispose());
  const rows = () => walk(page.tree).find(n => n.props.role === "log").children.filter(n => n?.type === "div");
  assert.deepEqual(rows().map(text), ["record-008", "record-009", "record-010", "record-011", "record-012"]);
  assert.equal(rows()[0].props.title, "record-008", "预览单行省略时仍可悬停查看完整原行");
  assert.equal(button(page.tree, "换行"), undefined); assert.match(text(page.tree), /共 12 行 · 显示最近 5 行/);
  await button(page.tree, "复制日志").props.onClick(); assert.equal(ui.copies.at(-1), source(12), "五行窗口不截断复制范围");
  page.render({ ...props, text: source(13) }); page.render();
  assert.deepEqual(rows().map(text), ["record-009", "record-010", "record-011", "record-012", "record-013"]); assert.equal(workspace.scrollTop, 321, "新记录不滚动整个工作区");
  button(page.tree, "暂停跟随").props.onClick(); page.render();
  page.render({ ...props, text: source(15) }); page.render();
  assert.equal(text(rows().at(-1)), "record-013", "暂停后保留看到的最后5行"); assert.ok(button(page.tree, "有 2 条新记录"));
  button(page.tree, "有 2 条新记录").props.onClick(); page.render();
  assert.equal(text(rows()[0]), "record-011"); assert.equal(text(rows().at(-1)), "record-015");
  button(page.tree, "打开源文件").props.onClick(); assert.equal(opened, 1);
  page.render({ ...props, text: source(16) }); page.render();
  assert.equal(text(rows().at(-1)), "record-015", "打开文件期间后台日志不会挤走原窗口"); assert.ok(button(page.tree, "有 1 条新记录"));
  const ended = ui.mount(ui.OutputPanel, { ...props, memoryKey: "five.ended", live: false, text: source(16) }); t.after(() => ended.dispose());
  assert.equal(walk(ended.tree).find(n => n.props.role === "log").children.length, 5, "事后查看同样只预览最后5行");
});

test("文本日志历史：专注按需读取全量并定位末页，无搜索也可逐页查看早期记录", t => {
  const ui = studio(), all = count => Array.from({ length: count }, (_, i) => "history-" + String(i + 1).padStart(3, "0")).join("\n"); let fullRequests = 0;
  const props = { text: all(120).split("\n").slice(-20).join("\n"), partial: true, full: { value: null }, onFull: () => fullRequests++,
    label: "测试输出", memoryKey: "five.history", filename: "output.log", searchScope: "测试输出全文", toast() {} };
  const page = ui.mount(ui.OutputPanel, props); t.after(() => page.dispose());
  const rows = () => walk(page.tree).find(n => n.props.role === "log").children.filter(n => n?.type === "div");
  assert.equal(rows().length, 5); assert.equal(fullRequests, 0);
  button(page.tree, "专注查看").props.onClick(); page.render(); assert.equal(page.tree.type, ui.StudioDialog); assert.equal(fullRequests, 1);
  page.render({ ...props, full: { value: all(120) } });
  assert.equal(rows().length, 20); assert.match(text(page.tree), /历史记录 · 共 120 行 · 全量 · 测试输出全文 · 显示第 101–120 行/);
  assert.equal(button(page.tree, "下一页").props.disabled, true, "历史初始定位末页");
  button(page.tree, "上一页").props.onClick(); page.render(); assert.equal(rows().length, 50); assert.equal(text(rows()[0]), "history-051");
  button(page.tree, "上一页").props.onClick(); page.render(); assert.equal(text(rows()[0]), "history-001");
  assert.equal(walk(page.tree).find(n => n.props["aria-label"] === "搜索日志").props.value, "", "不用搜索也能读历史");
  page.render({ ...props, text: all(121).split("\n").slice(-20).join("\n"), full: { value: all(121) } }); page.render();
  assert.equal(text(rows()[0]), "history-001"); assert.match(text(page.tree), /历史记录 · 共 120 行/, "新增记录不改变已打开历史快照");
  assert.ok(button(page.tree, "有 1 条新记录"));
  button(page.tree, "最近 5 行").props.onClick(); page.render();
  assert.equal(page.tree.type, ui.StudioDialog); assert.equal(rows().length, 5); assert.equal(text(rows().at(-1)), "history-121");
  assert.ok(button(page.tree, "查看历史")); assert.equal(button(page.tree, "换行"), undefined);
});

test("阶段事件五行弹窗：大文件默认5行，历史全量在同一层分页且不混入其他阶段", async t => {
  const event = (stage, index) => JSON.stringify({ stage, at: "2026-09-14T12:00:00Z", kind: "note", detail: stage + "-event-" + String(index).padStart(3, "0") });
  const all = Array.from({ length: 130 }, (_, i) => event("P8", i + 1)).join("\n") + "\n" + event("P9", 999);
  const tail = all.split("\n").slice(-11).join("\n");
  const ui = studio(async url => ({ ok: true, text: url.includes("full=1") ? all : tail }));
  const props = { slug: "alpha", runId: "a", path: "trace/events.jsonl", stage: "P8", identity: "P8.1", dialog: true, onClose() {},
    tree: [{ path: "trace/events.jsonl", size: 600000, mtimeMs: 1 }], label: "P8 · 阶段事件", memoryKey: "five.events", filename: "events.log", toast() {} };
  const log = ui.mount(ui.RunLogPanel, props); t.after(() => log.dispose()); await tick(); log.render();
  const page = ui.mount(ui.OutputPanel, log.tree.props); t.after(() => page.dispose());
  const rows = () => walk(page.tree).find(n => n.props.role === "log").children.filter(n => n?.type === "div");
  assert.equal(page.tree.type, ui.StudioDialog); assert.equal(rows().length, 5); assert.match(text(rows()[0]), /P8-event-126/);
  assert.equal(ui.requests.filter(r => r.url.includes("full=1")).length, 0, "打开阶段事件不立即加载整个文件");
  assert.equal(walk(page.tree).find(n => n.props["aria-label"] === "搜索日志").props.placeholder, "搜索本阶段事件");
  assert.ok(!walk(page.tree).some(n => /browsing/.test(n.props.className || "")), "默认五行弹窗不保留历史阅读的固定大高度");
  button(page.tree, "查看历史").props.onClick(); page.render(); log.render(); await tick(); log.render(); page.render(log.tree.props);
  assert.equal(ui.requests.filter(r => r.url.includes("full=1")).length, 1); assert.equal(page.tree.type, ui.StudioDialog);
  assert.equal(walk(page.tree).filter(n => n.type === ui.StudioDialog).length, 1, "历史在同一弹窗切换");
  assert.equal(rows().length, 30); assert.match(text(page.tree), /历史记录 · 共 130 行/); assert.doesNotMatch(text(page.tree), /P9-event-999/);
  button(page.tree, "上一页").props.onClick(); page.render(); button(page.tree, "上一页").props.onClick(); page.render();
  assert.match(text(rows()[0]), /P8-event-001/);
  walk(page.tree).find(n => n.props["aria-label"] === "搜索日志").props.onChange({ target: { value: "P9-event" } }); page.render();
  assert.match(text(page.tree), /没有匹配输出/); assert.match(text(page.tree), /本阶段事件/);
  button(page.tree, "最近 5 行").props.onClick(); page.render(); assert.equal(rows().length, 5); assert.match(text(rows().at(-1)), /P8-event-130/);
});

test("文本日志五行读取失败：保留最后5行和重试，历史失败也明确已读范围", t => {
  let retries = 0;
  const ui = studio(), value = Array.from({ length: 12 }, (_, i) => "saved-" + String(i + 1).padStart(2, "0")).join("\n");
  const props = { text: value, resource: { value, error: "preview offline", reload: () => retries++ }, partial: true,
    full: { value: null, error: "full exceeds 5MB", reload: () => retries++ }, onFull() {}, label: "日志", memoryKey: "five.errors", filename: "run.log", toast() {} };
  const page = ui.mount(ui.OutputPanel, props); t.after(() => page.dispose());
  const rows = () => walk(page.tree).find(n => n.props.role === "log").children.filter(n => n?.type === "div");
  assert.equal(rows().length, 5); assert.equal(text(rows()[0]), "saved-08");
  walk(page.tree).find(n => n.props.resource?.error === "preview offline").props.resource.reload(); assert.equal(retries, 1);
  button(page.tree, "专注查看").props.onClick(); page.render();
  assert.match(text(page.tree), /历史记录 · 共 12 行 · 已读内容/); assert.match(text(page.tree), /全量读取失败/);
  assert.equal(text(rows()[0]), "saved-01", "全量失败仍可浏览已读范围内超出5行的历史");
  walk(page.tree).find(n => n.props.resource?.error === "full exceeds 5MB").props.resource.reload(); assert.equal(retries, 2);
  assert.ok(button(page.tree, "复制已读内容"));
});

test("统一文件入口：指定文件缺失明确提示，不误开其他文件；历史选中失效仍回退", async t => {
  const ui = studio(async () => ({ ok: true, text: "unrelated file" }));
  const props = { slug: "alpha", runId: "a", tree: [{ path: "run.json", size: 20, mtimeMs: 1 }], toast() {} };
  const missing = ui.mount(ui.ArtifactsPanel, { ...props, initialPath: "08-test-output.txt" }); t.after(() => missing.dispose());
  assert.ok(walk(missing.tree).some(n => n.props.title === "文件当前不存在"));
  assert.equal(ui.requests.length, 0, "指定文件不存在不加载无关 run.json");
  assert.match(text(missing.tree), /08-test-output\.txt/);
  walk(missing.tree).find(n => n.props.title === "run.json").props.onClick(); missing.render(); await tick(); missing.render();
  assert.ok(walk(missing.tree).some(n => n.type === ui.ArtifactContent && n.props.text === "unrelated file"), "仍可主动选择其他产物");
  ui.storage.set("i2p.file.alpha.a", '"gone.json"');
  const historical = ui.mount(ui.ArtifactsPanel, props); t.after(() => historical.dispose());
  assert.equal(ui.storage.get("i2p.file.alpha.a"), '"run.json"', "全部产物入口的历史选择失效可回退");
});

test("阶段运行方式：非 P6 外部委托明确标注，实际执行与启动快照优先于当前项目设置", t => {
  const ui = studio(), props = { slug: "alpha", runId: "a", tree: [], toast() {}, project: { stageConfig: { P3: { delegate: { mode: "session" }, provider: "changed", model: "changed-model" } } },
    run: { id: "a", current: "P3", status: "running", stages: { P3: { status: "running" } }, executionConfig: { defaultRoute: { provider: "saved", model: "snapshot-model" }, stageConfig: {} } } };
  const page = ui.mount(ui.RunsPanel, props); t.after(() => page.dispose());
  const runtime = () => text(walk(page.tree).find(n => n.props.className === "studio-runtime-meta hint"));
  assert.match(runtime(), /模型 snapshot-model/); assert.doesNotMatch(runtime(), /changed-model|外部会话/, "新项目默认值不改写已有启动快照");
  page.render({ ...props, run: { ...props.run, executionConfig: { ...props.run.executionConfig, stageConfig: { P3: { delegate: { mode: "session" } } } } } });
  assert.equal(runtime(), "外部会话 · 过程未采集", "P3 委托时不冒充宿主模型执行");
  page.render({ ...props, run: { ...props.run, stages: { P3: { status: "running", external: true } } } });
  assert.equal(runtime(), "外部会话 · 过程未采集", "实际阶段执行记录也能识别委托");
  page.render({ ...props, run: { ...props.run, executionConfig: undefined } });
  assert.equal(runtime(), "外部会话 · 过程未采集", "无快照历史任务兼容项目中的阶段委托设置");
});

test("阶段事件与测试输出：超大或失败日志入口不消失，共用阅读器且不把尾部时差当阶段耗时", async t => {
  let offline = false;
  const events = [
    { stage: "P8", kind: "stage.note", at: "2026-09-14T10:00:59Z", detail: "tail test event" },
    { stage: "P8", kind: "stage.done", at: "2026-09-14T10:01:00Z", detail: "tail end" },
  ].map(JSON.stringify).join("\n");
  const ui = studio(async url => { if (offline && url.includes("events.jsonl")) throw new Error("offline"); return { ok: true, text: url.includes("events.jsonl") ? events : "test output" }; });
  const run = { id: "a", current: "P8", status: "completed", stages: { P8: { status: "approved", startedAt: "2026-09-14T10:00:00Z", finishedAt: "2026-09-14T10:02:00Z" } } };
  const tree = [{ path: "trace/events.jsonl", size: 500000, mtimeMs: 1 }, { path: "08-test-output.txt", size: 500000, mtimeMs: Date.parse("2026-09-14T10:02:00Z") }];
  const props = { slug: "alpha", runId: "a", run, tree, toast() {}, onChanged() {} };
  const page = ui.mount(ui.RunsPanel, props); t.after(() => page.dispose()); await tick(); page.render();
  assert.ok(button(page.tree, "阶段事件 · 最近 2"));
  const runtime = () => text(walk(page.tree).find(n => n.props.className === "studio-runtime-meta hint"));
  assert.match(runtime(), /耗时 2 分 0 秒/, "可靠 startedAt/finishedAt 优先于尾部一秒跨度");
  const withoutFinish = { ...props, run: { ...run, stages: { P8: { ...run.stages.P8, finishedAt: undefined } } } };
  page.render(withoutFinish); assert.doesNotMatch(runtime(), /耗时/, "仅尾部事件不足以计算整个阶段耗时");
  button(page.tree, "测试输出").props.onClick(); page.render();
  const output = walk(page.tree).find(n => n.type === ui.RunLogPanel);
  assert.equal(output.props.path, "08-test-output.txt"); assert.ok(!output.props.dialog, "测试输出默认在阶段正文阅读");
  const mounted = ui.mount(ui.RunLogPanel, output.props); t.after(() => mounted.dispose()); await tick(); mounted.render();
  assert.equal(mounted.tree.type, ui.OutputPanel); assert.equal(mounted.tree.props.partial, true);
  assert.ok(ui.requests.some(r => r.url.includes("08-test-output.txt") && r.url.includes("tail=1")), "P8 大输出自动读取尾部");
  offline = true; page.render({ ...withoutFinish, tree: [{ ...tree[0], mtimeMs: 2 }, tree[1]] }); await tick(); page.render();
  assert.ok(button(page.tree, "阶段事件 · 读取失败"), "读取失败仍保留入口");
  button(page.tree, "阶段事件 · 读取失败").props.onClick(); page.render();
  const dialog = walk(page.tree).find(n => n.type === ui.RunLogPanel && n.props.dialog);
  assert.equal(dialog.props.stage, "P8"); assert.equal(dialog.props.log.resource.error, "offline");
  assert.match(dialog.props.log.resource.value, /tail test event/, "失败后保留上次事件");
  assert.equal(typeof dialog.props.log.resource.reload, "function");
  dialog.props.onClose(); page.render();
  assert.ok(walk(page.tree).find(n => n.type === ui.RunLogPanel && n.props.path === "08-test-output.txt"), "关闭阶段事件仍是原测试输出页签");
});

test("任务详情文件：复核历史替换共享弹窗，关闭先回详情再回原阶段", async t => {
  const ui = studio(async () => ({ ok: true, text: "{}" }));
  const props = { slug: "alpha", runId: "a", run: { id: "a", current: "P6", status: "awaiting_review", p6Mode: "builtin", stages: { P6: { status: "awaiting_review" } } },
    tree: [{ path: "reviews/approve-P5.json", size: 10, mtimeMs: 1 }], toast() {}, onChanged() {} };
  const page = ui.mount(ui.RunsPanel, props); t.after(() => page.dispose()); await tick(); page.render();
  button(page.tree, "任务详情").props.onClick(); page.render();
  const context = () => walk(page.tree).find(n => n.type === ui.StudioDialog && n.props.title === "任务详情");
  assert.ok(context()); assert.equal(button(page.tree, "通过 P6 并继续"), undefined, "详情阅读期间隔离后台复核");
  button(context(), "approve-P5.json").props.onClick(); page.render();
  const files = walk(page.tree).find(n => n.type === ui.ArtifactsDialog);
  assert.equal(files.props.initialPath, "reviews/approve-P5.json"); assert.equal(files.props.returnLabel, "← 返回任务详情");
  assert.equal(context(), undefined, "共享文件弹窗替换任务详情，不嵌套");
  assert.ok(walk(page.tree).some(n => n.type === ui.ExecutionsPanel), "底层执行现场持续挂载");
  files.props.onReturn(); page.render(); assert.ok(context());
  button(context(), "approve-P5.json").props.onClick(); page.render();
  walk(page.tree).find(n => n.type === ui.ArtifactsDialog).props.onClose(); page.render(); assert.ok(context(), "关闭文件也先回任务详情");
  context().props.onClose(); page.render(); assert.ok(button(page.tree, "通过 P6 并继续"), "关闭详情返回阶段复核对象");
});

test("阅读现场：外部事件与 P8 日志专注查看期间，真实阶段推进不切换或卸载原阶段", async t => {
  for (const stage of ["P6", "P8"]) {
    const ui = studio(async url => ({ ok: true, text: url.includes("timeline.log") ? "20:00:00|tool|Read inspect.js\n20:00:01|result|done" : "test line one\ntest line two" }));
    const startedAt = "2026-09-14T12:00:00Z", next = stage === "P6" ? "P7" : "P9";
    const run = { id: "a", current: stage, status: "running", p6Mode: "claude", externalExec: { executor: "claude-code", status: "running", startedAt },
      stages: { [stage]: { status: "running", startedAt, attempts: 0 } } };
    const tree = (stage === "P6" ? ["06-implementation/external-exec.timeline.log", "06-implementation/external-exec.log"] : ["08-test-output.txt"])
      .map(path => ({ path, size: 80, mtimeMs: Date.parse(startedAt) }));
    const props = { slug: "alpha", runId: "a", run, tree, toast() {}, onChanged() {} };
    const page = ui.mount(ui.RunsPanel, props); t.after(() => page.dispose()); await tick(); page.render();
    if (stage === "P8") { button(page.tree, "测试输出").props.onClick(); page.render(); }
    const parentType = stage === "P6" ? ui.ExecutionsPanel : ui.RunLogPanel;
    const parentNode = walk(page.tree).find(n => n.type === parentType);
    assert.equal(typeof parentNode.props.onInspect, "function", stage + " 正文接入暂停阶段跟随回调");
    const body = ui.mount(parentType, parentNode.props); t.after(() => body.dispose()); await tick(); body.render();
    const readerType = stage === "P6" ? ui.TimelineTable : ui.OutputPanel;
    const readerNode = walk(body.tree).find(n => n.type === readerType);
    assert.equal(readerNode.props.onInspect, parentNode.props.onInspect, "保护回调传递到实际日志/事件阅读器");
    const reader = ui.mount(readerType, readerNode.props); t.after(() => reader.dispose());
    button(reader.tree, "专注查看").props.onClick(); reader.render(); assert.equal(reader.tree.type, ui.StudioDialog);
    const progressed = { ...props, run: { ...run, current: next, stages: { ...run.stages, [stage]: { ...run.stages[stage], status: "approved" }, [next]: { status: "running", startedAt: "2026-09-14T12:05:00Z" } } } };
    page.render(progressed); page.render();
    const stillMounted = walk(page.tree).find(n => n.type === parentType);
    assert.ok(stillMounted, stage + " 正文不会因真实任务推进被其他阶段替换");
    assert.equal(stillMounted.props.key, parentNode.props.key, "阅读容器的 React key 保持稳定");
    assert.equal(walk(page.tree).find(n => n.props["aria-label"]?.startsWith(stage + " ")).props["aria-pressed"], true);
    assert.ok(button(page.tree, "正在查看 " + stage + " · 返回当前 " + next + " →"), "明确显示真实当前阶段与正在阅读阶段的区别");
    reader.tree.props.onClose(); reader.render(); page.render();
    assert.ok(walk(page.tree).some(n => n.type === parentType), "关闭专注弹窗后仍回到原阶段");
    button(page.tree, "正在查看 " + stage + " · 返回当前 " + next + " →").props.onClick(); page.render(); page.render();
    assert.equal(walk(page.tree).find(n => n.props["aria-label"]?.startsWith(next + " ")).props["aria-pressed"], true, "显式返回才能恢复跟随真实阶段");
  }
});

test("运行耗时：没有新事件也计时，重跑隔离旧轮，结束和复核等待分开", () => {
  const ui = studio(), start = "2026-09-14T08:00:00Z", now = Date.parse(start) + 125000;
  const run = { id: "clock", current: "P6", status: "running", stages: { P6: { status: "running", startedAt: start } } };
  assert.equal(ui.stageTimingText(run, "P6", [], now), "已运行 2 分 5 秒");
  assert.equal(ui.stageTimingText(run, "P6", [], now + 1000), "已运行 2 分 6 秒");
  assert.equal(ui.stageTimingText(run, "P6", [], now, true), "上次确认已运行 2 分 5 秒");
  const restarted = { ...run, stages: { P6: { status: "running", startedAt: new Date(now - 5000).toISOString(), finishedAt: start } } };
  assert.equal(ui.stageTimingText(restarted, "P6", [{ stage: "P6", at: start }], now), "已运行 5 秒");
  const review = { ...run, status: "awaiting_review", stages: { P6: { ...run.stages.P6, status: "awaiting_review", finishedAt: new Date(now - 25000).toISOString() } } };
  assert.equal(ui.stageTimingText(review, "P6", [], now), "耗时 1 分 40 秒 · 等待复核 25 秒");
  const stopped = { ...run, status: "stopped", stages: { P6: { ...run.stages.P6, status: "stopped", stoppedAt: new Date(now - 1000).toISOString() } } };
  assert.equal(ui.stageTimingText(stopped, "P6", [], now + 600000), "耗时 2 分 4 秒");
  assert.equal(ui.stageTimingText({ ...run, stages: { P6: { status: "pending" } } }, "P6", [{ stage: "P6", at: start }], now), "");
});

test("观测时钟：服务器时间校正、每秒刷新、断线冻结、重连校准与卸载清理", () => {
  let now = 1000000, interval, cleared = 0;
  class ClockDate extends Date { static now() { return now; } }
  const ui = studio(undefined, { Date: ClockDate, setInterval: fn => { interval = fn; return 1; }, clearInterval: () => { interval = null; cleared++; } });
  const run = { id: "clock", status: "running", observedAt: "2026-09-14T08:00:00Z" }, server = Date.parse(run.observedAt);
  const clock = ui.mount(p => ui.useRunClock(p.run, p.error), { run });
  assert.equal(clock.tree, server);
  now += 1000; interval(); clock.render(); assert.equal(clock.tree, server + 1000);
  clock.render({ run, error: "offline" }); assert.equal(clock.tree, server); assert.equal(interval, null);
  now += 60000; clock.render(); assert.equal(clock.tree, server, "断线期间不把未知状态显示为继续运行");
  const fresh = { ...run, observedAt: new Date(server + 62000).toISOString() };
  clock.render({ run: fresh }); assert.equal(clock.tree, server + 62000); assert.ok(interval);
  clock.render({ run: { ...fresh, status: "completed" } }); assert.equal(interval, null);
  clock.dispose(); assert.ok(cleared >= 2);
});

test("Agent 活动：心跳与可见动作分开，后台并行与退出通知显示，暂停日志不影响摘要", () => {
  const ui = studio(), start = "2026-09-14T08:00:00Z", now = Date.parse(start) + 120000;
  const run = { id: "activity", current: "P6", status: "running", p6Mode: "claude", observedAt: new Date(now).toISOString(), stages: { P6: { status: "running", startedAt: start } },
    agentActivity: { status: "available", captureId: "capture", phase: "thinking", lastSignalAt: new Date(now - 2000).toISOString(),
      lastAction: { at: start, kind: "tool_call", name: "Read" }, process: { state: "alive" },
      backgroundTasks: [{ id: "install", isBackgrounded: true, name: "安装依赖", status: "running", startedAt: new Date(now - 30000).toISOString(), command: "npm install" },
        { id: "front", isBackgrounded: false, name: "前台检查", status: "running" }] } };
  const page = ui.mount(ui.AgentActivityPanel, { run, now });
  assert.match(text(page.tree), /正在推理/); assert.match(text(page.tree), /最近信号 · 2 秒前/);
  assert.match(text(page.tree), /最近动作 · Read/); assert.match(text(page.tree), /安装依赖 · 运行中 · 已运行 30 秒/);
  assert.doesNotMatch(text(page.tree), /前台检查/);
  page.render({ run: { ...run, agentActivity: { ...run.agentActivity, lastSignalAt: new Date(now + 5000).toISOString() } }, now: now + 5000 });
  assert.match(text(page.tree), /最近信号 · 0 秒前/); assert.match(text(page.tree), /已运行 35 秒/);
  const completed = { ...run, agentActivity: { ...run.agentActivity, backgroundTasks: [{ ...run.agentActivity.backgroundTasks[0], status: "completed", finishedAt: new Date(now).toISOString(), exitCode: 0, summary: "added 1804 packages" }] } };
  page.render({ run: completed, now: now + 1000 });
  assert.match(text(page.tree), /安装依赖 · 已完成 · 30 秒/); assert.match(text(page.tree), /退出码 0/); assert.match(text(page.tree), /added 1804 packages/);
  assert.match(text(page.tree), /正在推理/, "后台任务完成不代表 Agent 已结束"); page.dispose();
});

test("Agent 活动：静默提示不判失败，断线不称存活，旧记录降级不推断推理", () => {
  const ui = studio(), start = "2026-09-14T08:00:00Z", now = Date.parse(start) + 200000;
  const run = { current: "P6", status: "running", stages: { P6: { status: "running", startedAt: start } }, agentActivity: { status: "available", phase: "thinking", lastSignalAt: start, process: { state: "alive" } } };
  let result = ui.agentActivityView(run, now);
  assert.equal(result.title, "暂未收到新活动"); assert.match(result.warning, /任务未自动停止/); assert.equal(run.status, "running");
  result = ui.agentActivityView(run, now, "offline"); assert.equal(result.title, "连接中断，正在重试"); assert.match(result.processText, /未确认/);
  result = ui.agentActivityView({ ...run, status: "stopped" }, now); assert.equal(result.title, "任务已停止");
  result = ui.agentActivityView({ ...run, agentActivity: { status: "legacy", lastLogUpdateAt: new Date(now).toISOString() } }, now);
  assert.equal(result.title, "日志仍有更新"); assert.doesNotMatch(result.title, /推理/);
});

test("P8 实时入口：开始即显示测试输出，报告生成不切走阅读，待执行节点保持留空", async t => {
  const ui = studio(async () => ({ ok: true, text: "" })), startedAt = "2026-09-14T10:00:00Z";
  const run = { id: "p8-live", status: "running", current: "P8", stages: { P8: { status: "running", startedAt } },
    testActivity: { status: "available", stageStartedAt: startedAt, captureId: "new", command: "npm test", startedAt, executionStatus: "running", lastOutputAt: null, process: { state: "alive" } } };
  const props = { slug: "alpha", runId: run.id, run, tree: [], toast() {}, onChanged() {} };
  const page = ui.mount(ui.RunsPanel, props); t.after(() => page.dispose()); await tick(); page.render();
  assert.ok(walk(page.tree).some(n => n.type === ui.TestActivityPanel));
  let reader = walk(page.tree).find(n => n.type === ui.RunLogPanel);
  assert.ok(reader, "没有输出文件时已有测试执行区，不再等报告才显示正文");
  assert.equal(reader.props.emptyText, "测试命令已启动，等待首条输出");
  assert.equal(reader.props.onFile, undefined, "文件未生成不显示无效源文件入口");
  assert.ok(!walk(page.tree).some(n => n.type === ui.StageResult));
  const tree = ["08-test-output.txt", "08-test-activity.json", "07-test-report.json"].map(path => ({ path, size: 100, mtimeMs: Date.parse(startedAt) + 2000 }));
  page.render({ ...props, tree });
  reader = walk(page.tree).find(n => n.type === ui.RunLogPanel);
  assert.ok(reader, "新报告出现不自动替换正在读的输出"); assert.equal(reader.props.tree.length, 1);
  assert.ok(button(page.tree, "阶段结果"));
  assert.equal(ui.artifactOwner("08-test-activity.json", run).stage, "P8");
  button(page.tree, "阶段结果").props.onClick(); page.render();
  assert.ok(walk(page.tree).some(n => n.type === ui.StageResult));
  const nextAt = "2026-09-14T10:01:00Z", nextRun = { ...run, stages: { P8: { status: "running", startedAt: nextAt } },
    testActivity: { ...run.testActivity, stageStartedAt: nextAt, startedAt: nextAt, captureId: "rerun" } };
  page.render({ ...props, run: nextRun, tree }); page.render();
  page.render({ ...props, run: nextRun, tree: tree.map(file => ({ ...file, mtimeMs: Date.parse(nextAt) + 2000 })) });
  assert.ok(walk(page.tree).some(n => n.type === ui.RunLogPanel), "上轮结果页签不在新报告生成时抢回当前测试输出");
  assert.ok(!walk(page.tree).some(n => n.type === ui.StageResult));
  page.render({ ...props, run: { ...run, stages: { P8: { status: "pending" } } } });
  assert.ok(!walk(page.tree).some(n => n.type === ui.TestActivityPanel || n.type === ui.RunLogPanel));
});

test("P8 活动语义：无输出不假判卡死，断线与流程停止时保留真实执行状态", () => {
  const ui = studio(), startedAt = "2026-09-14T10:00:00Z", now = Date.parse(startedAt) + 90000;
  const run = { current: "P8", status: "running", stages: { P8: { status: "running", startedAt } },
    testActivity: { status: "available", stageStartedAt: startedAt, captureId: "new", command: "npm test -- --runInBand", startedAt,
      executionStatus: "running", lastOutputAt: null, process: { state: "alive" } } };
  let view = ui.testActivityView(run, [], [], now);
  assert.equal(view.title, "测试命令执行中"); assert.match(view.note, /1 分 30 秒没有新输出/); assert.match(view.note, /暂不能.*卡住/);
  assert.equal(view.signal, "尚未收到测试输出"); assert.equal(run.status, "running");
  view = ui.testActivityView(run, [], [], now, "offline");
  assert.equal(view.title, "同步中断，正在重试"); assert.doesNotMatch(view.note, /进程仍在运行/);
  view = ui.testActivityView({ ...run, status: "stopped" }, [], [], now);
  assert.equal(view.title, "流程已停止，测试命令仍在执行", "不把停止流水线误报为命令已退出");
  view = ui.testActivityView({ ...run, testActivity: { ...run.testActivity, process: { state: "unknown" } } }, [], [], now);
  assert.equal(view.title, "测试执行状态待确认");
  for (const [executionStatus, exitCode, title] of [["completed", 0, "测试命令已通过"], ["failed", 2, "测试未通过"], ["timeout", null, "测试已超时"]]) {
    const ended = { ...run, testActivity: { ...run.testActivity, executionStatus, exitCode, finishedAt: new Date(now).toISOString(), lastOutputAt: startedAt } };
    view = ui.testActivityView(ended, [], [], now);
    assert.equal(view.title, title); assert.equal(view.emptyText, "测试已结束，没有可显示的输出");
    const panel = ui.mount(ui.TestActivityPanel, { view });
    assert.match(text(panel.tree), /npm test -- --runInBand/); assert.match(text(panel.tree), /结束：/);
    if (exitCode != null) assert.match(text(panel.tree), new RegExp("退出码 " + exitCode));
    panel.dispose();
  }
  view = ui.testActivityView({ ...run, testActivity: { ...run.testActivity, executionStatus: "completed", exitCode: 0, logError: "输出保存失败" } }, [], [], now);
  assert.equal(view.title, "测试记录保存异常", "命令退出0但记录失败不能显示顺利完成");
});

test("P8 重跑与历史：拒绝上轮输出和报告，旧任务仅显示日志时间，本轮空日志清旧内容", async t => {
  const ui = studio(async () => ({ ok: true, text: "" })), startedAt = "2026-09-14T10:00:00Z", start = Date.parse(startedAt);
  const run = { status: "running", current: "P8", stages: { P8: { status: "running", startedAt } } };
  const oldTree = ["08-test-output.txt", "07-test-report.json"].map(path => ({ path, size: 100, mtimeMs: start - 1000 }));
  let view = ui.testActivityView(run, oldTree, [{ stage: "P8", kind: "test", name: "old-command", at: new Date(start - 1000).toISOString() }], start);
  assert.equal(view.outputTree.length, 0); assert.equal(view.reportFile, undefined); assert.equal(view.command, "");
  const freshTree = oldTree.map(file => ({ ...file, mtimeMs: start + 500 }));
  view = ui.testActivityView({ ...run, testActivity: { status: "unavailable", reasonCode: "stale" } }, freshTree, [], start + 1000);
  assert.equal(view.outputFile, false, "后端判定身份不匹配时，即使旧进程又更新文件也不能展示");
  view = ui.testActivityView(run, freshTree, [], start + 1000);
  assert.match(view.signal, /日志更新时间/); assert.match(view.note, /未采集实时状态/);
  const activity = { status: "available", stageStartedAt: startedAt, captureId: "new-capture", executionStatus: "running", startedAt, process: { state: "alive" } };
  view = ui.testActivityView({ ...run, testActivity: { ...activity, outputReady: false, logError: "本轮日志创建失败" } }, freshTree, [], start + 1000);
  assert.equal(view.outputTree.length, 0, "新日志无法建立时不沿用旧文件");
  view = ui.testActivityView({ ...run, testActivity: activity }, [{ ...freshTree[0], size: 0 }], [], start + 1000);
  assert.equal(view.outputFile.size, 0); assert.equal(view.identity, "new-capture");
  const reader = ui.mount(ui.RunLogPanel, { slug: "alpha", runId: "a", path: "08-test-output.txt", tree: view.outputTree, identity: view.identity, emptyText: view.emptyText });
  t.after(() => reader.dispose()); await tick(); reader.render();
  const output = ui.mount(ui.OutputPanel, { ...reader.tree.props, memoryKey: "p8-empty" }); t.after(() => output.dispose());
  assert.match(text(output.tree), /测试命令已启动，等待首条输出/); assert.doesNotMatch(text(output.tree), /开始执行后这里/);
});
