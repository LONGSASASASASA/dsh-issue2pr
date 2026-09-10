import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apply, __setTestHooks, delegateWatchTick } from "../../index.js";
import { defaultSettings, loadSettings, saveSettings, saveProject, loadProject, executionProject } from "../../lib/core/store.js";
import { loadRun, saveRun } from "../../lib/core/pipeline.js";
import { buildAssistantContext } from "../../lib/assistant.js";

const roots = [];
afterEach(() => { __setTestHooks(null); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function rootOf() { const root = mkdtempSync(join(tmpdir(), "i2p-settings-")); roots.push(root); return root; }
const project = slug => ({ name: slug, slug, repos: ["test-repo"], triggers: [], reviewMode: "auto", p6Mode: "session", testCommand: "legacy test", stageConfig: { P1: { prompts: { "": "legacy prompt" } } } });
async function call(handler, method, path, body) {
  let result;
  await handler({ method, url: "/issue2pr/api" + path, on(event, fn) {
    if (event === "data" && body !== undefined) fn(Buffer.from(JSON.stringify(body)));
    if (event === "end") setImmediate(fn);
  } }, { writeHead(status) { result = { status }; }, end(data) { result.body = JSON.parse(data); } });
  return result;
}
function harness(root, executors = {}) {
  __setTestHooks({ dataRoot: root, executors });
  let handler;
  const selection = { provider: "first", model: "model-a", reasoningEffort: "high" }, calls = [];
  apply({ effect(fn) { fn(); }, logger: { info() {} }, webServer: { register(spec) { handler = spec.handler; } },
    get: name => name === "agentDefaultModel" ? { currentSelection: () => ({ ...selection }) } : undefined,
    llm: { async *stream(options) { calls.push(options); yield { type: "text-delta", text: "ok" }; } } });
  return { handler, selection, calls };
}
async function start(handler, root, slug, source) {
  const file = join(root, source + ".md"); writeFileSync(file, "fixture issue");
  const result = await call(handler, "POST", "/projects/" + slug + "/runs", { kind: "issue", uri: file });
  assert.equal(result.status, 200, result.body.message);
  return { id: result.body.runId, dir: join(root, "projects", slug, "runs", result.body.runId), path: "/projects/" + slug + "/runs/" + result.body.runId };
}
async function waitPaused(handler, run) {
  for (let i = 0; i < 100; i++) {
    const value = (await call(handler, "GET", run.path)).body;
    if (value.status !== "running") return value;
    await new Promise(resolve => setTimeout(resolve, 15));
  }
  assert.fail("run did not pause");
}

test("全局设置：默认值、验证、白名单与版本冲突保持原文件", async () => {
  const root = rootOf(), { handler } = harness(root);
  assert.deepEqual((await call(handler, "GET", "/settings")).body.settings, defaultSettings());
  assert.equal(existsSync(join(root, "settings.json")), false);
  const saved = await call(handler, "PUT", "/settings", { ...defaultSettings(), reviewMode: "every", repos: ["must-not-copy"], token: "must-not-copy" });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.settings.revision, 1);
  assert.equal(saved.body.settings.token, undefined);
  assert.equal(saved.body.settings.repos, undefined);
  assert.equal((await call(handler, "PUT", "/settings", defaultSettings())).status, 409);
  for (const patch of [{ reviewMode: "invalid" }, { p6Mode: "invalid" }, { stageConfig: { P1: { provider: "only" } } }, { maxReviewAttempts: 0 }, { testCommand: null }]) {
    assert.equal((await call(handler, "PUT", "/settings", { ...saved.body.settings, ...patch })).status, 400);
    assert.deepEqual(loadSettings(root), saved.body.settings);
  }
});

test("新任务跨项目使用全局配置；保存后的普通推进和重跑保持提示词、测试命令及默认模型快照", async () => {
  const root = rootOf(), seen = [];
  const execute = async rcx => {
    seen.push({ id: rcx.run.id, stage: rcx.run.current, config: rcx.stageCfgOf(), command: rcx.project.testCommand });
    await rcx.llm.complete({ user: "fixture" });
    return {};
  };
  const { handler, selection, calls } = harness(root, { P1: execute, P2: execute });
  for (const slug of ["alpha", "beta"]) saveProject(root, project(slug));
  const initial = saveSettings(root, { ...defaultSettings(), reviewMode: "every", testCommand: "npm test", stageConfig: { P1: { prompts: { "": "snapshot prompt" } } } });
  const a = await start(handler, root, "alpha", "first");
  let state = await waitPaused(handler, a);
  assert.equal(state.reviewMode, "every"); assert.equal(state.p6Mode, "builtin");
  assert.equal(state.executionConfig.revision, initial.revision);
  assert.equal(seen[0].config.prompts[""], "snapshot prompt");
  assert.equal(seen[0].command, "npm test");
  selection.provider = "second"; selection.model = "model-b";
  saveSettings(root, { ...initial, testCommand: "new test", stageConfig: { P1: { prompts: { "": "new prompt" } } } });
  saveProject(root, { ...project("alpha"), testCommand: "project changed" });
  const stale = await call(handler, "POST", a.path + "/review", { decision: "approve", expectedStage: "P6" });
  assert.equal(stale.status, 409);
  assert.equal(loadRun(a.dir).current, "P1");
  assert.equal((await call(handler, "POST", a.path + "/review", { decision: "approve", expectedStage: "P1", expectedStatus: "awaiting_review", expectedAttempt: state.stages.P1.attempts, expectedStartedAt: state.stages.P1.startedAt })).status, 200);
  state = await waitPaused(handler, a); assert.equal(state.current, "P2");
  assert.equal((await call(handler, "POST", a.path + "/stop")).status, 200);
  assert.equal((await call(handler, "POST", a.path + "/rerun", { stage: "P1" })).status, 200);
  await waitPaused(handler, a);
  for (const entry of seen) assert.equal(entry.command, "npm test");
  assert.equal(seen.at(-1).config.prompts[""], "snapshot prompt");
  assert.ok(calls.every(options => options.provider === "first" && options.model === "model-a" && options.reasoningEffort === "high"));
  const b = await start(handler, root, "beta", "second"); await waitPaused(handler, b);
  assert.equal(loadRun(b.dir).executionConfig.testCommand, "new test");
  assert.equal(calls.at(-1).model, "model-b");
  assert.equal(seen.at(-1).config.prompts[""], "new prompt");
  const context = buildAssistantContext(root, { nav: "runs", slug: "alpha", runId: a.id });
  assert.match(context, /启动快照 v1/); assert.match(context, /默认模型=model-a/);
});

test("历史任务无快照继续读取项目；新任务空覆盖不混入旧项目配置", () => {
  const root = rootOf(); saveProject(root, project("legacy"));
  const p = loadProject(root, "legacy");
  assert.deepEqual(executionProject(p, {}), p);
  const effective = executionProject({ ...p, maxReviewAttempts: 1 }, { executionConfig: defaultSettings() });
  assert.deepEqual(effective.stageConfig, {});
  assert.equal(effective.testCommand, ""); assert.equal(effective.maxReviewAttempts, undefined);
  assert.deepEqual(effective.repos, p.repos);
});

test("历史任务重跑仍使用旧项目执行参数", async () => {
  const root = rootOf(), observed = [];
  const { handler } = harness(root, { P1: async rcx => { observed.push(rcx.project.testCommand); return {}; } });
  saveProject(root, { ...project("legacy"), reviewMode: "every", p6Mode: "builtin" });
  const task = await start(handler, root, "legacy", "legacy"); await waitPaused(handler, task);
  const run = loadRun(task.dir); delete run.executionConfig; run.status = "stopped"; run.reviewMode = "every"; saveRun(task.dir, run);
  await call(handler, "POST", task.path + "/rerun", { stage: "P1" }); await waitPaused(handler, task);
  assert.equal(observed.at(-1), "legacy test");
});

test("委外监听持续采用任务中的阶段委托快照；全局与项目改动不改变等待方式", async () => {
  const root = rootOf(), { handler } = harness(root);
  saveProject(root, project("watch"));
  const initial = saveSettings(root, { ...defaultSettings(), reviewMode: "auto", stageConfig: { P11: { delegate: { mode: "session" } } } });
  const task = await start(handler, root, "watch", "watch"); await waitPaused(handler, task);
  const run = loadRun(task.dir); run.current = "P11"; run.status = "awaiting_review"; run.stages.P11 = { status: "awaiting_review", external: true }; saveRun(task.dir, run);
  saveSettings(root, { ...initial, stageConfig: {} });
  const ctx = { logger: { info() {} } };
  assert.equal(await delegateWatchTick(ctx, root, task.dir), "waiting");
  assert.equal(await delegateWatchTick(ctx, root, task.dir), "waiting", "监听刷新后仍保留启动时委托方式");
  delete run.executionConfig; saveRun(task.dir, run);
  assert.equal(await delegateWatchTick(ctx, root, task.dir), "idle", "旧任务回到项目配置，P11 未启用委托");
});
