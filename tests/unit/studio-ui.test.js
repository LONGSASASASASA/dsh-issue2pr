import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { STAGE_DEFS } from "../../lib/core/stageConfig.js";

// 组件逻辑测试：模拟 hooks 的状态、提交后 effect 与卸载清理；显示/焦点另在浏览器验证。
function studio(fetcher = async () => ({ ok: true })) {
  let current, exports;
  const React = {
    Fragment: "Fragment",
    createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity) }),
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
  const storage = new Map(), requests = [], copies = [];
  const sandbox = { structuredClone, AbortController, setTimeout, clearTimeout, setInterval, clearInterval, console, URL, Blob,
    getComputedStyle: element => ({ getPropertyValue: () => element.bg || "" }),
    document: { querySelector: selector => selector.startsWith("style[") ? {} : null, documentElement: { dataset: { i2pThemeWatch: "1" } } },
    confirm: () => true,
    navigator: { clipboard: { writeText: async value => { copies.push(value); } } },
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
    fetch: async (url, options) => {
      requests.push({ url, ...options });
      const result = await fetcher(url, options);
      return { ok: true, json: async () => result };
    },
    window: { confirm: () => true, addEventListener() {}, removeEventListener() {},
      __ModuleLoader__: { load(def) { exports = def.factory(name => name === "react" ? React : { MarkdownText: () => null }); } } },
  };
  const source = readFileSync(new URL("../../client.js", import.meta.url), "utf8").replace("exports.apply = apply;", "exports.apply = apply; exports.test = { useResource, StudioSettings, NewTaskDialog, RunsPanel, PatchPreview, ArtifactsPanel, TaskList, ProjectsPanel, OutputPanel, RunReportCard, WorkbenchPage, panelStore, ReadableValue, DiffContent, diffLineNumbers, formatAgentLog, executionItems, artifactOwner, taskTitle, taskReason, evidenceState, parseLines, renderView, detectHostDark, reportSummary, gateLabel };");
  vm.runInNewContext(source, sandbox, { filename: "client.js" });
  function mount(fn, props) {
    const instance = { index: 0, cells: [], effects: [], props, tree: null,
      render(next = instance.props) { instance.props = next; instance.index = 0; current = instance; instance.tree = fn(next); current = null; for (const effect of instance.effects.splice(0)) effect(); return instance.tree; },
      dispose() { for (const cell of instance.cells) cell?.cleanup?.(); },
    };
    instance.render(); return instance;
  }
  return { ...exports.test, mount, requests, storage, copies };
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
  button(page.tree, "完整流程").props.onClick(); page.render();
  assert.equal(walk(page.tree).find(n => n.props["aria-label"]?.startsWith("P6 ")).props["aria-pressed"], true, "以真实当前阶段初始化");
  button(page.tree, "收起流程").props.onClick(); page.render();
  const approve = walk(page.tree).find(node => node.type === "button" && /通过/.test(text(node)));
  assert.ok(approve); await approve.props.onClick();
  const body = JSON.parse(ui.requests.find(r => r.url.endsWith("/review")).body);
  assert.equal(body.expectedStage, "P6"); assert.equal(body.expectedAttempt, 2); assert.equal(body.expectedStartedAt, run.stages.P6.startedAt);
  const running = { ...run, status: "running", current: "P7", stages: { P7: { status: "running" } } };
  page.render({ ...page.props, run: running, tree: [{ path: "ledger/patch-ledger.jsonl", size: 20, mtimeMs: 1 }] });
  assert.ok(!walk(page.tree).some(node => node.props["aria-label"]?.startsWith("P7 ")), "流程默认收起");
  button(page.tree, "完整流程").props.onClick(); page.render();
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
  button(page.tree, "完整流程").props.onClick(); page.render();
  walk(page.tree).find(n => n.props["aria-label"]?.startsWith("P2 ")).props.onClick(); page.render();
  assert.ok(!button(page.tree, "通过 P6 并继续")); assert.ok(button(page.tree, "返回当前复核对象"));
  button(page.tree, "返回当前复核对象").props.onClick(); page.render();
  const filesTab = walk(page.tree).find(n => n.type === "button" && /^全部产物 \d/.test(text(n)));
  filesTab.props.onClick(); page.render(); assert.ok(!button(page.tree, "通过 P6 并继续"));
  button(page.tree, "返回当前复核对象").props.onClick(); page.render();
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
  button(page.tree, "完整流程").props.onClick(); page.render();
  assert.equal(walk(page.tree).filter(n => n.props.className?.startsWith("studio-stage ")).length, 10);
  assert.ok(text(page.tree).includes("跟随当前阶段 ✓"), "默认跟随状态可见");
  walk(page.tree).find(n => n.props["aria-label"]?.startsWith("P1 ")).props.onClick(); page.render();
  assert.equal(walk(page.tree).find(n => n.props["aria-label"]?.startsWith("P1 ")).props["aria-pressed"], true, "手动选择 P1");
  button(page.tree, "收起流程").props.onClick(); page.render({ ...page.props, run: { ...run, current: "P3" } });
  assert.match(text(page.tree), /需求分析尚未开始/, "跟随已暂停：推进到 P3 仍停留在 P1");
  assert.ok(!text(page.tree).includes("正在查看"), "无提示横条");
  button(page.tree, "完整流程").props.onClick(); page.render();
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
  assert.ok(button(page.tree, "暂停跟随"), "搜索引起的内容缩短不应改变跟随偏好");
  await button(page.tree, "复制日志").props.onClick(); assert.deepEqual(ui.copies, [output]);
  button(page.tree, "暂停跟随").props.onClick(); page.render(); button(page.tree, "换行").props.onClick(); page.render();
  const again = ui.mount(ui.OutputPanel, props); t.after(() => again.dispose());
  assert.ok(button(again.tree, "恢复跟随")); assert.equal(button(again.tree, "换行").props["aria-pressed"], false);
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

test("节点留空：未到达阶段只有等待空态，不渲染零内容区块；文件页隐藏流程图，交付未到只有空态", async t => {
  const ui = studio(async () => ({ ok: true, text: "{}" }));
  const run = { id: "a", current: "P2", status: "running", stages: { P2: { status: "running", startedAt: "2026-09-08T00:00:00Z" } } };
  const page = ui.mount(ui.RunsPanel, { slug: "alpha", runId: "a", run, tree: [], toast() {}, onChanged() {} }); t.after(() => page.dispose());
  button(page.tree, "完整流程").props.onClick(); page.render();
  walk(page.tree).find(n => n.props["aria-label"]?.startsWith("P5 ")).props.onClick(); page.render();
  assert.match(text(page.tree), /任务规划尚未开始，结果生成后会显示在这里。/);
  assert.match(text(page.tree), /预期产物：05-task-graph\.json/);
  assert.ok(!text(page.tree).includes("本阶段尚未生成结果"), "空态取代通用结果占位");
  assert.ok(!text(page.tree).includes("执行日志 · 0 条事件"), "无事件不渲染日志壳");
  assert.ok(!text(page.tree).includes("阶段产物 · 0"), "无产物不渲染产物壳");
  assert.ok(button(page.tree, "正在查看 P5 · 返回当前 P2 →"), "偏离状态在流程底部可见");
  button(page.tree, "收起流程").props.onClick(); page.render();
  walk(page.tree).find(n => n.type === "button" && /^全部产物 \d/.test(text(n))).props.onClick(); page.render();
  assert.ok(!walk(page.tree).some(n => n.props.className === "studio-topology"), "文件页不显示流程图");
  button(page.tree, "执行过程").props.onClick(); page.render();
  button(page.tree, "完整流程").props.onClick(); page.render();
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
  assert.deepEqual(tabButtons().map(n => text(n)), ["补丁账本", "执行日志 1", "阶段产物 1"], "子页签带计数且空内容不出页签");
  assert.match(text(page.tree), /回滚/, "默认显示补丁账本");
  tabButtons()[1].props.onClick(); page.render();
  assert.equal(tabButtons()[1].props["aria-pressed"], true, "切换到执行日志页签");
  assert.ok(walk(page.tree).some(n => n.type === ui.OutputPanel), "日志页签挂载输出面板");
  tabButtons()[2].props.onClick(); page.render();
  assert.match(text(page.tree), /patch-ledger\.jsonl/, "阶段产物页签列出本阶段文件");
});

test("查看其他阶段：无提示横条，点节点即查看；点当前阶段节点切回", async t => {
  const ui = studio(async url => url.includes(".diff") ? { ok: true, text: "diff --git a/x b/x" } : { ok: true });
  const startedAt = Date.parse("2026-09-08T00:00:00Z");
  const run = { id: "a", current: "P7", status: "running",
    stages: { P6: { status: "completed", startedAt: "2026-09-08T00:00:00Z" }, P7: { status: "running", startedAt: "2026-09-08T00:00:00Z" } } };
  const tree = [{ path: "06-implementation/patches/0001-T1.diff", size: 20, mtimeMs: startedAt + 5000 }, { path: "ledger/patch-ledger.jsonl", size: 20, mtimeMs: startedAt }];
  const page = ui.mount(ui.RunsPanel, { slug: "alpha", runId: "a", run, tree, toast() {}, onChanged() {} }); t.after(() => page.dispose());
  button(page.tree, "完整流程").props.onClick(); page.render();
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
  assert.match(text(stale.tree), /上一轮补丁可在文件页查看/);
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
  assert.ok(button(page.tree, "任务详情"), "任务详情在更多菜单中");
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
});

test("进度可视化：轮次与耗时上标题，待重验标记、P10 历史记录态、复核关注点", async t => {
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
  const runtimeSpan = tabsNav.children.find(n => n.props.className === "hint");
  assert.equal(text(runtimeSpan), "第 1 轮 · 测试执行 · npm test", "运行信息显示在执行过程后面");
  assert.ok(!text(runtimeSpan).includes("模型"), "P8 不显示模型");
  button(page.tree, "完整流程").props.onClick(); page.render();
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
  assert.match(text(out.tree), /共 3 行 · 显示最近 600 行/);
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
