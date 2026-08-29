// tests/api.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync, rmSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { apply } from "../index.js";
import { __setTestHooks } from "../index.js";   // 测试注入：dataRoot / executors / llm

const root = mkdtempSync(join(tmpdir(), "i2p-api-"));

function fakeCtx() {
  const routes = [];
  return {
    effect(fn) { fn(); return () => {}; },
    logger: { info() {} },
    webServer: { register(spec) { routes.push(spec); } },
    getConfig() { return { dataRoot: root }; },
    llm: { async *stream() { yield { type: "text-delta", index: 0, text: "{}" }; yield { type: "finish", reason: "stop" }; } },
  };
}

async function call(handler, method, path, body) {
  const chunks = [];
  const req = { method, url: path,
    on(ev, fn) { if (ev === "data") {} if (ev === "end") setImmediate(fn); },
    [Symbol.asyncIterator]: undefined };
  const res = { writeHead(c) { res.status = c; }, end(d) { chunks.push(d); } };
  // 模拟 body
  if (body != null) {
    req.on = (ev, fn) => { if (ev === "data") fn(Buffer.from(JSON.stringify(body))); if (ev === "end") setImmediate(fn); };
  }
  await handler(req, res);
  return { status: res.status, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) };
}

test("API 全链路：建项目 → 发起 run → 待复核 → approve 推进", async () => {
  __setTestHooks({
    dataRoot: root,
    executors: { P1: async () => ({ artifact: "01-issue-analysis.json" }) }, // 其余阶段缺省 = 立即 approved 的空执行器
  });
  const ctx = fakeCtx();
  apply(ctx);
  const handler = ctx.webServer ? null : null;
  const h = ctx; // 从 registrations 取 handler
  const routes = [];
  // 重新收集：apply 通过 effect 同步注册
  // （实现侧保证 register 同步发生）
  const handler2 = (function () { const rs = []; const c2 = fakeCtx(); c2.webServer.register = (s) => rs.push(s); apply(c2); return rs[0].handler; })();

  let r = await call(handler2, "POST", "/issue2pr/api/projects", {
    name: "演示", slug: "demo", repos: ["r1"], triggers: [{ kind: "issue", uri: "x.md" }],
    reviewMode: "every", p6Mode: "builtin",
  });
  assert.equal(r.status, 200);

  const issueFile = join(root, "x.md");
  writeFileSync(issueFile, "刷新后偶发退出");
  r = await call(handler2, "POST", "/issue2pr/api/projects/demo/runs", { kind: "issue", uri: issueFile });
  assert.equal(r.body.ok, true);
  const runId = r.body.runId;
  assert.ok(runId);

  // 等异步推进到 awaiting_review
  await new Promise((res2) => setTimeout(res2, 300));
  r = await call(handler2, "GET", `/issue2pr/api/projects/demo/runs/${runId}`);
  assert.equal(r.body.stages.P1.status, "awaiting_review");

  r = await call(handler2, "POST", `/issue2pr/api/projects/demo/runs/${runId}/review`, { decision: "approve", comment: "" });
  assert.equal(r.body.ok, true);
  await new Promise((res2) => setTimeout(res2, 300));
  r = await call(handler2, "GET", `/issue2pr/api/projects/demo/runs/${runId}`);
  assert.equal(r.body.stages.P1.status, "approved");
});

test("API：非法 slug / 缺字段 400；artifact 防 ..", async () => {
  const handler2 = (function () { const rs = []; const c2 = fakeCtx(); c2.webServer.register = (s) => rs.push(s); apply(c2); return rs[0].handler; })();
  let r = await call(handler2, "POST", "/issue2pr/api/projects", { name: "坏", slug: "BAD" });
  assert.equal(r.status, 400);
  r = await call(handler2, "GET", "/issue2pr/api/projects/demo/runs/20260827-200000-x/artifact?path=../../secret");
  assert.equal(r.body.ok, false);
});

test("API：同秒同触发源重复 POST /runs → 第二次 409（Run 已存在）", async () => {
  __setTestHooks({ dataRoot: root, executors: {} });
  const handler2 = (function () { const rs = []; const c2 = fakeCtx(); c2.webServer.register = (s) => rs.push(s); apply(c2); return rs[0].handler; })();
  let r = await call(handler2, "POST", "/issue2pr/api/projects", {
    name: "冲突", slug: "dup", repos: ["r"], triggers: [{ kind: "issue", uri: "dup.md" }],
    reviewMode: "every", p6Mode: "builtin",
  });
  assert.equal(r.status, 200);
  const dupFile = join(root, "dup.md");
  writeFileSync(dupFile, "重复触发同一触发源");
  // runId 秒级精度：快速连续 POST，直到两请求落进同一秒（第二次同 runId 必 409）
  let seen409 = false;
  for (let i = 0; i < 20 && !seen409; i++) {
    const a = await call(handler2, "POST", "/issue2pr/api/projects/dup/runs", { kind: "issue", uri: dupFile });
    assert.equal(a.status, 200);
    const b = await call(handler2, "POST", "/issue2pr/api/projects/dup/runs", { kind: "issue", uri: dupFile });
    if (b.status === 409) {
      seen409 = true;
      assert.equal(b.body.ok, false);
      assert.match(b.body.message, /Run 已存在/);
    } else {
      assert.equal(b.status, 200); // 落入下一秒则创建新 run，继续下一轮
    }
  }
  assert.ok(seen409, "连续 POST 应能在同秒内观测到 409");
});
function handlerOf() {
  const rs = []; const c2 = fakeCtx(); c2.webServer.register = (s) => rs.push(s); apply(c2); return rs[0].handler;
}
async function mkRun(h, slug, file, body) {
  writeFileSync(join(root, file), "stop/rerun/delete 测试触发文档");
  const r = await call(h, "POST", `/issue2pr/api/projects/${slug}/runs`, { kind: "issue", uri: join(root, file) });
  assert.equal(r.status, 200);
  return r.body.runId;
}

test("API：stop 停止待复核 run；rerun 回退重跑；delete 删除目录", async () => {
  __setTestHooks({ dataRoot: root, executors: {} }); // 全阶段立即 approved（key 门 awaiting_review）
  const h = handlerOf();
  let r = await call(h, "POST", "/issue2pr/api/projects", {
    name: "控制", slug: "ctrl", repos: ["r"], triggers: [{ kind: "issue", uri: "c.md" }],
    reviewMode: "key-only", p6Mode: "builtin",
  });
  assert.equal(r.status, 200);
  const runId = await mkRun(h, "ctrl", "c.md");
  await new Promise((res2) => setTimeout(res2, 200));
  const runDir = join(root, "projects", "ctrl", "runs", runId);

  // stop：非 running/awaiting_review 拒绝；待复核可停
  r = await call(h, "GET", `/issue2pr/api/projects/ctrl/runs/${runId}`);
  const st0 = r.body.status;
  r = await call(h, "POST", `/issue2pr/api/projects/ctrl/runs/${runId}/stop`, {});
  if (st0 === "awaiting_review" || st0 === "running") {
    assert.equal(r.body.ok, true);
    r = await call(h, "GET", `/issue2pr/api/projects/ctrl/runs/${runId}`);
    assert.equal(r.body.status, "stopped");
    // 已停止再 stop → 400
    r = await call(h, "POST", `/issue2pr/api/projects/ctrl/runs/${runId}/stop`, {});
    assert.equal(r.status, 400);
    // rerun：非法阶段 400；合法阶段 → running 且该阶段 pending
    r = await call(h, "POST", `/issue2pr/api/projects/ctrl/runs/${runId}/rerun`, { stage: "P1" });
    assert.equal(r.body.ok, true);
    r = await call(h, "GET", `/issue2pr/api/projects/ctrl/runs/${runId}`);
    assert.equal(r.body.status, "running");
    // running 中 rerun → 400（先停止）
    r = await call(h, "POST", `/issue2pr/api/projects/ctrl/runs/${runId}/rerun`, { stage: "P1" });
    assert.equal(r.status, 400);
    await new Promise((res2) => setTimeout(res2, 200));
    await call(h, "POST", `/issue2pr/api/projects/ctrl/runs/${runId}/stop`, {});
    r = await call(h, "GET", `/issue2pr/api/projects/ctrl/runs/${runId}`);
    assert.equal(r.body.status, "stopped");
    r = await call(h, "POST", `/issue2pr/api/projects/ctrl/runs/${runId}/rerun`, { stage: "XX" });
    assert.equal(r.status, 400);
  }
  // stop 未运行态（completed/failed）→ 400
  r = await call(h, "POST", `/issue2pr/api/projects/ctrl/runs/${runId}/stop`, {});
  if (st0 === "completed" || st0 === "stopped") assert.equal(r.status, 400);

  // delete：目录移除，GET 404
  r = await call(h, "DELETE", `/issue2pr/api/projects/ctrl/runs/${runId}`);
  assert.equal(r.body.ok, true);
  assert.equal(existsSync(runDir), false);
  r = await call(h, "GET", `/issue2pr/api/projects/ctrl/runs/${runId}`);
  assert.equal(r.status, 404);
  rmSync(join(root, "projects", "ctrl"), { recursive: true, force: true });
});

test("API：DELETE /projects/:slug（confirm 校验 + 有活跃 run 拒绝）", async () => {
  __setTestHooks({ dataRoot: root, executors: {} });
  const h = handlerOf();
  let r = await call(h, "POST", "/issue2pr/api/projects", {
    name: "删我", slug: "delme", repos: ["r"], triggers: [{ kind: "issue", uri: "d.md" }],
    reviewMode: "key-only", p6Mode: "builtin",
  });
  assert.equal(r.status, 200);
  const runId = await mkRun(h, "delme", "d.md");
  await new Promise((res2) => setTimeout(res2, 200));

  // 缺 confirm → 400
  r = await call(h, "DELETE", "/issue2pr/api/projects/delme");
  assert.equal(r.status, 400);
  // confirm 不匹配 → 400
  r = await call(h, "DELETE", "/issue2pr/api/projects/delme?confirm=other");
  assert.equal(r.status, 400);

  // 停掉 run 后删除成功
  await call(h, "POST", `/issue2pr/api/projects/delme/runs/${runId}/stop`, {});
  r = await call(h, "DELETE", "/issue2pr/api/projects/delme?confirm=delme");
  assert.equal(r.body.ok, true);
  assert.equal(existsSync(join(root, "projects", "delme")), false);
  r = await call(h, "GET", "/issue2pr/api/projects");
  assert.equal(r.body.projects.find((x) => x.slug === "delme"), undefined);
});

test("API：open 目录端点返回 ok（opener 注入为空函数，不真弹资源管理器）", async () => {
  __setTestHooks({ dataRoot: root, executors: {}, opener: (cmd, args, opts, cb) => cb(null) });
  const h = handlerOf();
  await call(h, "POST", "/issue2pr/api/projects", {
    name: "开", slug: "opn", repos: ["r"], triggers: [{ kind: "issue", uri: "o.md" }],
    reviewMode: "auto", p6Mode: "builtin",
  });
  const runId = await mkRun(h, "opn", "o.md");
  const r = await call(h, "POST", `/issue2pr/api/projects/opn/runs/${runId}/open`, {});
  assert.equal(r.body.ok, true);
  rmSync(join(root, "projects", "opn"), { recursive: true, force: true });
});

test("API：rollback 在 run 运行中/待复核时拒绝；停止后放行校验", async () => {
  __setTestHooks({ dataRoot: root, executors: {} });
  const h = handlerOf();
  let r = await call(h, "POST", "/issue2pr/api/projects", {
    name: "回滚守卫", slug: "rb", repos: ["r"], triggers: [{ kind: "issue", uri: "rb.md" }],
    reviewMode: "key-only", p6Mode: "builtin",
  });
  assert.equal(r.status, 200);
  const runId = await mkRun(h, "rb", "rb.md");
  await new Promise((res2) => setTimeout(res2, 200));

  // 伪造 ledger：一行 applied 记录（run 处于 awaiting_review/running 时应拒绝回滚）
  const runDir = join(root, "projects", "rb", "runs", runId);
  writeFileSync(join(runDir, "ledger", "patch-ledger.jsonl"),
    JSON.stringify({ patch: "06-implementation/patches/x.diff", appliedAt: new Date().toISOString() }) + "\n");
  r = await call(h, "GET", `/issue2pr/api/projects/rb/runs/${runId}`);
  const busy = r.body.status === "running" || r.body.status === "awaiting_review";
  r = await call(h, "POST", `/issue2pr/api/projects/rb/runs/${runId}/rollback`, { lineNo: 0 });
  if (busy) {
    assert.equal(r.status, 400);
    assert.match(r.body.message, /请先停止再回滚/);
    // 停止后再回滚：不再被守卫拦截（patch 文件缺失走到回滚失败，同样 400 但信息不同）
    await call(h, "POST", `/issue2pr/api/projects/rb/runs/${runId}/stop`, {});
    r = await call(h, "POST", `/issue2pr/api/projects/rb/runs/${runId}/rollback`, { lineNo: 0 });
    assert.notEqual(r.body.message, undefined);
  }
});

test("recoverInterruptedRuns：遗留 running 的 run 置为 stopped 并标 interruptedAt", async () => {
  const { recoverInterruptedRuns } = await import("../index.js");
  const recRoot = mkdtempSync(join(tmpdir(), "i2p-rec-"));
  const runDir = join(recRoot, "projects", "p1", "runs", "20260829-120000-x");
  mkdirSync(runDir, { recursive: true });
  const run = {
    id: "20260829-120000-x", project: "p1", status: "running", current: "P3",
    stages: { P3: { status: "running", attempts: 0 }, P4: { status: "pending", attempts: 0 } },
  };
  writeFileSync(join(runDir, "run.json"), JSON.stringify(run));
  recoverInterruptedRuns(recRoot);
  const after = JSON.parse(readFileSync(join(runDir, "run.json"), "utf8"));
  assert.equal(after.status, "stopped");
  assert.equal(after.stages.P3.status, "stopped");
  assert.ok(after.interruptedAt);
  // 幂等：再次运行不改动
  recoverInterruptedRuns(recRoot);
  const again = JSON.parse(readFileSync(join(runDir, "run.json"), "utf8"));
  assert.equal(again.status, "stopped");
});

test("failRun：running 的 run 落盘 failed + 阶段 error；非 running 不动", async () => {
  const { failRun } = await import("../index.js");
  const frRoot = mkdtempSync(join(tmpdir(), "i2p-fail-"));
  const runDir = join(frRoot, "projects", "px", "runs", "20260829-130000-y");
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, "run.json"), JSON.stringify({
    id: "20260829-130000-y", project: "px", status: "running", current: "P1",
    stages: { P1: { status: "running", attempts: 0 } },
  }));
  const run = failRun(runDir, "P1", "仓库克隆失败: git clone 失败");
  assert.equal(run.status, "failed");
  const onDisk = JSON.parse(readFileSync(join(runDir, "run.json"), "utf8"));
  assert.equal(onDisk.status, "failed");
  assert.equal(onDisk.stages.P1.status, "failed");
  assert.match(onDisk.stages.P1.error, /仓库克隆失败/);
  // 已 stopped 的 run 再调 failRun 不改状态
  const again = failRun(runDir, "P1", "再失败");
  assert.equal(again.status, "failed");
  assert.equal(again.stages.P1.error, onDisk.stages.P1.error);
});

test("saveProject：repos 字符串形态规范化为 { uri } 落盘", async () => {
  const { saveProject, loadProject } = await import("../lib/store.js");
  const spRoot = mkdtempSync(join(tmpdir(), "i2p-sp-"));
  saveProject(spRoot, {
    name: "规范化", slug: "norm", repos: ["https://x.git"], triggers: [],
    reviewMode: "every", p6Mode: "builtin",
  });
  const p = loadProject(spRoot, "norm");
  assert.deepEqual(p.repos, [{ uri: "https://x.git" }]);
});

test("API：P6 session 模式 — GET 带 externalProgress，空 patches 拒绝 approve，产出后放行", async () => {
  __setTestHooks({
    dataRoot: root,
    executors: { P6: async () => ({ artifact: "06-implementation/session-task.md", summary: "任务包已生成，等待外部 DSH 会话执行", external: true }) },
  });
  const handler2 = (function () { const rs = []; const c2 = fakeCtx(); c2.webServer.register = (s) => rs.push(s); apply(c2); return rs[0].handler; })();
  let r = await call(handler2, "POST", "/issue2pr/api/projects", {
    name: "会话", slug: "sess", repos: ["r1"], triggers: [{ kind: "issue", uri: "x.md" }],
    reviewMode: "key-only", p6Mode: "session",
  });
  assert.equal(r.status, 200);
  const issueFile = join(root, "sess-issue.md");
  writeFileSync(issueFile, "会话模式验证");
  r = await call(handler2, "POST", "/issue2pr/api/projects/sess/runs", { kind: "issue", uri: issueFile });
  const runId = r.body.runId;
  const runDir = join(root, "projects", "sess", "runs", runId);

  await new Promise((res2) => setTimeout(res2, 300)); // P1-P4 直过，停 P5
  r = await call(handler2, "POST", `/issue2pr/api/projects/sess/runs/${runId}/review`, { decision: "approve", comment: "" });
  assert.equal(r.body.ok, true);
  await new Promise((res2) => setTimeout(res2, 300)); // P6 external → awaiting_review
  r = await call(handler2, "GET", `/issue2pr/api/projects/sess/runs/${runId}`);
  assert.equal(r.body.stages.P6.status, "awaiting_review");
  assert.equal(r.body.stages.P6.external, true);
  assert.deepEqual(r.body.externalProgress, { patches: 0, tasks: null, report: false });

  // 空 patches：通过被拦（放行会让 P7 无 patch 可用而失败）
  r = await call(handler2, "POST", `/issue2pr/api/projects/sess/runs/${runId}/review`, { decision: "approve", comment: "" });
  assert.equal(r.status, 400);
  assert.match(r.body.message, /session 模式/);

  // 外部会话产出任务图 + patch：进度更新，通过放行
  writeFileSync(join(runDir, "05-task-graph.json"), JSON.stringify({ nodes: [{ id: "T1" }, { id: "T2" }, { id: "T3" }] }));
  mkdirSync(join(runDir, "06-implementation", "patches"), { recursive: true });
  writeFileSync(join(runDir, "06-implementation", "patches", "0001-T1.diff"), "--- a/x\n+++ b/x\n");
  r = await call(handler2, "GET", `/issue2pr/api/projects/sess/runs/${runId}`);
  assert.deepEqual(r.body.externalProgress, { patches: 1, tasks: 3, report: false });
  r = await call(handler2, "POST", `/issue2pr/api/projects/sess/runs/${runId}/review`, { decision: "approve", comment: "" });
  assert.equal(r.body.ok, true);
});

test("API：stage-defaults 返回能力表与默认提示词（配置页数据源）", async () => {
  const handler = (function () { const rs = []; const c2 = fakeCtx(); c2.webServer.register = (s) => rs.push(s); apply(c2); return rs[0].handler; })();
  const r = await call(handler, "GET", "/issue2pr/api/stage-defaults");
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.defaults.llmTimeoutMs, 300000);
  assert.equal(Object.keys(r.body.defaults.stages).length, 11);
  const p6 = r.body.defaults.stages.P6;
  assert.equal(p6.caps.route, true);
  assert.ok(p6.prompts.planner && p6.prompts.coder && p6.prompts.reviewer);
  assert.deepEqual(r.body.defaults.stages.P7.caps, {});
  assert.ok(r.body.defaults.stages.P8.caps.test);
});

test("API：ui-state 兜底存储 — POST 写入 / GET 回读 / 非法 slug 拒绝 / null 清除", async () => {
  const handler = (function () { const rs = []; const c2 = fakeCtx(); c2.webServer.register = (s) => rs.push(s); apply(c2); return rs[0].handler; })();
  let r = await call(handler, "GET", "/issue2pr/api/ui-state");
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.state.lastProject, undefined); // 初始无文件 → 空 state
  r = await call(handler, "POST", "/issue2pr/api/ui-state", { lastProject: "demo" });
  assert.equal(r.body.ok, true);
  assert.equal(r.body.state.lastProject, "demo");
  r = await call(handler, "GET", "/issue2pr/api/ui-state");
  assert.equal(r.body.state.lastProject, "demo");
  // 非法 slug（大写/路径形态）拒收 → 清为 null，防 ui-state.json 被写成任意路径
  r = await call(handler, "POST", "/issue2pr/api/ui-state", { lastProject: "../Evil" });
  assert.equal(r.body.state.lastProject, null);
  // 清除：lastProject 显式 null
  r = await call(handler, "POST", "/issue2pr/api/ui-state", { lastProject: "x" });
  r = await call(handler, "POST", "/issue2pr/api/ui-state", { lastProject: null });
  assert.equal(r.body.state.lastProject, null);
  assert.equal(JSON.parse(readFileSync(join(root, "ui-state.json"), "utf8")).lastProject, null);
});

test("API：项目保存带 stageConfig 落盘并可回读；非法阶段被拒", async () => {
  const handler = (function () { const rs = []; const c2 = fakeCtx(); c2.webServer.register = (s) => rs.push(s); apply(c2); return rs[0].handler; })();
  let r = await call(handler, "POST", "/issue2pr/api/projects", {
    name: "带配置", slug: "cfg", repos: ["r1"], triggers: [{ kind: "issue", uri: "x.md" }],
    reviewMode: "every", p6Mode: "claude",
    stageConfig: { P1: { prompts: { "": "自定义 P1 提示词" }, model: "m1", provider: "p1", timeoutMs: 60000 }, P9: { delegate: { mode: "session", agent: "codex", brief: "x" } } },
  });
  assert.equal(r.status, 200);
  r = await call(handler, "GET", "/issue2pr/api/projects");
  const proj = r.body.projects.find((p2) => p2.slug === "cfg");
  assert.equal(proj.p6Mode, "claude");
  assert.equal(proj.stageConfig.P1.prompts[""], "自定义 P1 提示词");
  assert.equal(proj.stageConfig.P9.delegate.mode, "session");

  r = await call(handler, "POST", "/issue2pr/api/projects", {
    name: "非法", slug: "bad", repos: ["r1"], triggers: [], reviewMode: "every", p6Mode: "builtin",
    stageConfig: { P99: {} },
  });
  assert.equal(r.status, 400);
  assert.match(r.body.message, /P99/);
});
