// tests/agents.test.js — 委外智能体发现 + 测试门禁
// 背景 bug：claude CLI 认证失败（403 IP access denied by API-Key restrictions）只在 Run 的
// P6 委托时才暴露。本文件覆盖：多方式发现（配置/env/常见位置/npm 前缀/PATH）、
// 门禁三步（定位/版本/认证微任务）、API 端点与 POST /projects 保存门禁兜底。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { apply, __setTestHooks } from "../../index.js";
import { discoverAgents, testAgentGate } from "../../lib/delegate/agents.js";

const root = mkdtempSync(join(tmpdir(), "i2p-agents-"));

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

function handlerOf() {
  const rs = [];
  const c = fakeCtx();
  c.webServer.register = (s) => rs.push(s);
  apply(c);
  return rs[0].handler;
}

async function call(handler, method, path, body) {
  const chunks = [];
  const req = { method, url: path, on(ev, fn) { if (ev === "end") setImmediate(fn); } };
  const res = { writeHead(c) { res.status = c; }, end(d) { chunks.push(d); } };
  if (body != null) {
    req.on = (ev, fn) => { if (ev === "data") fn(Buffer.from(JSON.stringify(body))); if (ev === "end") setImmediate(fn); };
  }
  await handler(req, res);
  return { status: res.status, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) };
}

/* ==================== 单元：discoverAgents ==================== */

test("agents：discoverAgents — 五来源合并去重，configured 居首，resolved 跟随 cfgBin", async () => {
  const npmJoined = process.platform === "win32" ? "C:\\fake-npmg\\claude.cmd" : "C:\\fake-npmg/bin/claude";
  const out = await discoverAgents({
    cfgBin: "C:\\fake-cfg\\claude.cmd",
    envBin: "C:\\fake-env\\claude.cmd",
    runNpmPrefix: (args, opts, cb) => cb(null, "C:\\fake-npmg\n"),
    runWhich: (args, opts, cb) => cb(null, npmJoined + "\r\nC:\\fake-path2\\claude.exe\r\n"),
  });
  const paths = out.agents.map((a) => a.path);
  assert.equal(paths[0], "C:\\fake-cfg\\claude.cmd", "项目配置候选居首");
  assert.equal(out.agents[0].source, "configured");
  assert.equal(out.agents[0].label, "项目配置");
  assert.ok(paths.includes("C:\\fake-env\\claude.cmd"), "环境变量来源");
  assert.ok(paths.includes(npmJoined), "npm 全局前缀来源");
  assert.ok(paths.includes("C:\\fake-path2\\claude.exe"), "PATH 来源（多条全收）");
  assert.equal(paths.filter((p) => p.toLowerCase() === npmJoined.toLowerCase()).length, 1,
    "npm 与 PATH 命中同一文件须去重");
  assert.equal(out.resolved, "C:\\fake-cfg\\claude.cmd", "resolved = cfgBin 优先");
});

test("agents：discoverAgents — runWhich/runNpmPrefix 缺省时只出常见安装位置来源", async () => {
  const out = await discoverAgents({ cfgBin: "", envBin: "" });
  assert.ok(out.agents.every((a) => a.source === "common"), "无注入时仅常见安装位置");
  assert.ok(typeof out.resolved === "string" && out.resolved.length > 0);
});

/* ==================== 单元：testAgentGate ==================== */

test("agents：门禁三步全绿 → ok（version 解析 + 认证回执）", async () => {
  const bin = join(root, "gate-ok.cmd");
  writeFileSync(bin, "");
  const r = await testAgentGate({
    bin,
    runners: {
      runVersion: (b, o, cb) => cb(null, "1.0.66 (Claude Code)\n"),
      runPrompt: (b, o, cb) => cb(null, { code: 0, stdout: '{"result":"OK","num_turns":1}', stderr: "" }),
    },
  });
  assert.equal(r.ok, true);
  assert.equal(r.version, "1.0.66 (Claude Code)");
  assert.deepEqual(r.steps.map((s) => s.ok), [true, true, true]);
  assert.deepEqual(r.steps.map((s) => s.name), ["定位", "版本", "认证"]);
  assert.match(r.message, /门禁通过/);
});

test("agents：门禁 — 路径不存在 → 定位步失败", async () => {
  const r = await testAgentGate({ bin: "C:\\nope\\claude.cmd", runners: {} });
  assert.equal(r.ok, false);
  assert.equal(r.steps[0].ok, false);
  assert.match(r.message, /文件不存在/);
});

test("agents：门禁 — 裸名 claude PATH 未命中 → 定位失败；命中则透传 which 结果", async () => {
  let r = await testAgentGate({ bin: "claude", runners: { runWhich: (a, o, cb) => cb(new Error("nf"), "") } });
  assert.equal(r.ok, false);
  assert.match(r.message, /PATH 中未找到/);
  r = await testAgentGate({
    bin: "claude",
    runners: {
      runWhich: (a, o, cb) => cb(null, "C:\\hit\\claude.cmd\n"),
      runVersion: (b, o, cb) => cb(new Error("退出码 1")),
      runPrompt: () => { throw new Error("不应到达"); },
    },
  });
  assert.equal(r.ok, false);
  assert.match(r.message, /--version 失败/, "版本步失败即短路");
  assert.equal(r.steps[0].detail, "PATH 命中 C:\\hit\\claude.cmd");
});

test("agents：门禁 — 403 IP 白名单（用户实测错误）→ 失败 + IP 白名单提示", async () => {
  const bin = join(root, "gate-403.cmd");
  writeFileSync(bin, "");
  const r = await testAgentGate({
    bin,
    runners: {
      runVersion: (b, o, cb) => cb(null, "1.0.66"),
      runPrompt: (b, o, cb) => cb(null, {
        code: 1, stdout: "",
        stderr: "Failed to authenticate. API Error: 403 IP access denied by API-Key restrictions.",
      }),
    },
  });
  assert.equal(r.ok, false);
  assert.equal(r.steps[2].name, "认证");
  assert.equal(r.steps[2].ok, false);
  assert.match(r.message, /403/);
  assert.match(r.hint, /IP 访问限制|IP 白名单/);
});

test("agents：门禁 — headless JSON is_error → 判失败；超时 → 网络提示", async () => {
  const bin = join(root, "gate-iso.cmd");
  writeFileSync(bin, "");
  let r = await testAgentGate({
    bin,
    runners: {
      runVersion: (b, o, cb) => cb(null, "1.0.66"),
      runPrompt: (b, o, cb) => cb(null, { code: 0, stdout: '{"is_error":true,"result":"denied"}', stderr: "" }),
    },
  });
  assert.equal(r.ok, false, "is_error=true 即使退出码 0 也判失败");
  r = await testAgentGate({
    bin,
    runners: {
      runVersion: (b, o, cb) => cb(null, "1.0.66"),
      runPrompt: (b, o, cb) => cb(null, { code: -2, timeout: true, stdout: "", stderr: "" }),
    },
  });
  assert.equal(r.ok, false);
  assert.match(r.message, /超时/);
  assert.match(r.hint, /网络/);
});

/* ==================== API：/agents/* + 保存门禁 ==================== */

test("API：agents/discover — 来源标注；?slug= 项目配置候选居首", async () => {
  const npmJoined = process.platform === "win32" ? "C:\\fake-npmg\\claude.cmd" : "C:\\fake-npmg/bin/claude";
  __setTestHooks({
    dataRoot: root, executors: {},
    runWhich: (a, o, cb) => cb(null, "C:\\fake-path\\claude.cmd\n"),
    runNpmPrefix: (a, o, cb) => cb(null, "C:\\fake-npmg\n"),
  });
  const h = handlerOf();
  let r = await call(h, "POST", "/issue2pr/api/projects", {
    name: "发现", slug: "ag-disc", repos: ["r"], triggers: [], reviewMode: "every", p6Mode: "builtin",
    stageConfig: { P6: { params: { claudeBin: "C:\\fake-cfg\\claude.cmd" } } },
  });
  assert.equal(r.status, 200, "builtin 模式不触发保存门禁");
  r = await call(h, "GET", "/issue2pr/api/agents/discover?slug=ag-disc");
  assert.equal(r.body.ok, true);
  assert.equal(r.body.agents[0].path, "C:\\fake-cfg\\claude.cmd");
  assert.equal(r.body.agents[0].source, "configured");
  const paths = r.body.agents.map((a) => a.path);
  assert.ok(paths.includes(npmJoined), "npm 前缀来源");
  assert.ok(paths.includes("C:\\fake-path\\claude.cmd"), "PATH 来源");
});

test("API：agents/test — 403 → ok:false + hint；成功 → ok:true + version", async () => {
  const bin = join(root, "gate-api.cmd");
  writeFileSync(bin, "");
  __setTestHooks({
    dataRoot: root, executors: {},
    agentProbes: {
      runWhich: (a, o, cb) => cb(new Error("nf"), ""),
      runVersion: (b, o, cb) => cb(null, "1.0.66 (Claude Code)"),
      runPrompt: (b, o, cb) => cb(null, { code: 1, stdout: "", stderr: "API Error: 403 IP access denied by API-Key restrictions." }),
    },
  });
  let h = handlerOf();
  let r = await call(h, "POST", "/issue2pr/api/agents/test", { bin });
  assert.equal(r.status, 200, "门禁失败也回 200（与 connections/test 同约定）");
  assert.equal(r.body.ok, false);
  assert.match(r.body.gate.message, /403/);
  assert.match(r.body.gate.hint, /IP/);
  // 成功路径
  __setTestHooks({
    dataRoot: root, executors: {},
    agentProbes: {
      runVersion: (b, o, cb) => cb(null, "1.0.66 (Claude Code)"),
      runPrompt: (b, o, cb) => cb(null, { code: 0, stdout: '{"result":"OK"}', stderr: "" }),
    },
  });
  h = handlerOf();
  r = await call(h, "POST", "/issue2pr/api/agents/test", { bin });
  assert.equal(r.body.ok, true);
  assert.equal(r.body.gate.version, "1.0.66 (Claude Code)");
});

test("API：agents/test executor=dsh-agent — dshGate 钩子分派；无钩子时真实路径报服务不可用", async () => {
  __setTestHooks({
    dataRoot: root, executors: {},
    dshGate: { ok: true, gate: { ok: true, executor: "dsh-agent", message: "门禁通过（fake）", steps: [] } },
  });
  let r = await call(handlerOf(), "POST", "/issue2pr/api/agents/test", { executor: "dsh-agent" });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.gate.executor, "dsh-agent");
  // 无钩子走真实 testDshGate：fakeCtx 无 agents 服务 → 可操作失败
  __setTestHooks({ dataRoot: root, executors: {} });
  r = await call(handlerOf(), "POST", "/issue2pr/api/agents/test", { executor: "dsh-agent" });
  assert.equal(r.body.ok, false);
  assert.match(r.body.gate.message, /ctx\.agents/);
});

test("API：agents/test 认证中转 — 表单 token 优先，留空回落已存 relay-auth token", async () => {
  const seen = [];
  __setTestHooks({
    dataRoot: root, executors: {},
    agentProbes: {
      runVersion: (b, o, cb) => cb(null, "1.0.66 (Claude Code)"),
      runPrompt: (b, o, cb) => { seen.push(o && o.auth); cb(null, { code: 0, stdout: '{"result":"OK"}', stderr: "" }); },
    },
  });
  const h = handlerOf();
  let r = await call(h, "PUT", "/issue2pr/api/relay-auth", { token: "sk-relay-saved-token" });
  assert.equal(r.body.ok, true);
  assert.ok(r.body.masked && r.body.masked.length < "sk-relay-saved-token".length, "返回打码（比原文短）");
  r = await call(h, "POST", "/issue2pr/api/agents/test", { auth: { preset: "glm", token: "" } });
  assert.equal(r.body.ok, true);
  assert.equal(seen[seen.length - 1].token, "sk-relay-saved-token", "留空回落已存 token（门禁测保存后的真实路径）");
  r = await call(h, "POST", "/issue2pr/api/agents/test", { auth: { preset: "glm", token: "sk-form-new-token" } });
  assert.equal(seen[seen.length - 1].token, "sk-form-new-token", "表单新 token 优先");
  // GET 打码不泄露 + DELETE 清除
  r = await call(h, "GET", "/issue2pr/api/relay-auth");
  assert.equal(r.body.exists, true);
  assert.ok(!String(r.body.masked).includes("sk-relay-saved-token"), "打码不得包含完整 token");
  r = await call(h, "DELETE", "/issue2pr/api/relay-auth");
  assert.equal(r.body.exists, false);
  r = await call(h, "POST", "/issue2pr/api/agents/test", { auth: { preset: "glm", token: "" } });
  assert.equal(seen[seen.length - 1].token, "", "清除后回落空（= 继承环境）");
});

test("API：POST /projects 保存门禁 — 无 agentProbes 跳过（兼容）；注入后失败 400 / 通过 200", async () => {
  // 既有测试路径：钩子存在但未注入 agentProbes → 门禁跳过，不依赖本机 claude
  __setTestHooks({ dataRoot: root, executors: {} });
  let h = handlerOf();
  let r = await call(h, "POST", "/issue2pr/api/projects", {
    name: "门禁兼容", slug: "ag-compat", repos: ["r"], triggers: [], reviewMode: "every", p6Mode: "claude",
  });
  assert.equal(r.status, 200, "未注入 agentProbes 时跳过保存门禁");
  // 注入且 --version 失败 → 400 拦截
  __setTestHooks({
    dataRoot: root, executors: {},
    agentProbes: { runVersion: (b, o, cb) => cb(new Error("spawn claude ENOENT")) },
  });
  h = handlerOf();
  r = await call(h, "POST", "/issue2pr/api/projects", {
    name: "门禁拦截", slug: "ag-block", repos: ["r"], triggers: [], reviewMode: "every", p6Mode: "claude",
  });
  assert.equal(r.status, 400);
  assert.match(r.body.message, /门禁/);
  assert.match(r.body.message, /委外智能体/);
  // 注入且通过 → 200
  __setTestHooks({
    dataRoot: root, executors: {},
    agentProbes: { runVersion: (b, o, cb) => cb(null, "1.0.66") },
  });
  h = handlerOf();
  r = await call(h, "POST", "/issue2pr/api/projects", {
    name: "门禁通过", slug: "ag-pass", repos: ["r"], triggers: [], reviewMode: "every", p6Mode: "claude",
  });
  assert.equal(r.status, 200);
  for (const slug of ["ag-disc", "ag-compat", "ag-block", "ag-pass"]) {
    rmSync(join(root, "projects", slug), { recursive: true, force: true });
  }
});
