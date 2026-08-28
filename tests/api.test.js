// tests/api.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
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