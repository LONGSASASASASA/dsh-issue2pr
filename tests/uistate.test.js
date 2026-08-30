// tests/uistate.test.js — 选中记忆与失败分析写回
// 背景 bug：切宿主标签销毁重建插件 webview 后，运行页现场丢失（阶段全显「未开始」）；
// 且 Run 后台失败时失败分析只落 09-failure-analysis.json、run.json 不记，UI 无从展示。
// 本文件覆盖：ui-state 的 lastRunBySlug 按键合并/校验/清除、failureAnalysis 写回 run.json。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { apply, __setTestHooks } from "../index.js";
import { writeArtifact } from "../lib/store.js";

const root = mkdtempSync(join(tmpdir(), "i2p-uistate-"));

function fakeCtx() {
  const rs = [];
  const c = {
    effect(fn) { fn(); return () => {}; },
    logger: { info() {} },
    webServer: { register(spec) { rs.push(spec); } },
    getConfig() { return { dataRoot: root }; },
    llm: { async *stream() { yield { type: "text-delta", index: 0, text: "{}" }; yield { type: "finish", reason: "stop" }; } },
  };
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

test("ui-state：lastRunBySlug 按键合并；非法 slug/runId 忽略；null 清除；其他字段保留", async () => {
  __setTestHooks({ dataRoot: root, executors: {} });
  const h = fakeCtx();

  // 写入两个项目的 lastRun + lastProject + 面板几何
  let r = await call(h, "POST", "/issue2pr/api/ui-state", {
    lastProject: "alpha",
    lastRunBySlug: { alpha: "20260830-132616-1" },
    aiW: 461,
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.state.lastRunBySlug.alpha, "20260830-132616-1");

  // 第二次 POST 只带另一个项目：按键合并，不整体覆盖
  r = await call(h, "POST", "/issue2pr/api/ui-state", { lastRunBySlug: { beta: "20260830-140000-my-run" } });
  assert.equal(r.body.state.lastRunBySlug.alpha, "20260830-132616-1", "合并：alpha 保留");
  assert.equal(r.body.state.lastRunBySlug.beta, "20260830-140000-my-run");
  assert.equal(r.body.state.lastProject, "alpha", "lastProject 不受影响");
  assert.equal(r.body.state.aiW, 461, "面板几何不受影响");

  // 非法条目：slug 带空格、runId 形态不对 → 忽略；合法键可更新
  r = await call(h, "POST", "/issue2pr/api/ui-state", {
    lastRunBySlug: { "BAD SLUG": "20260830-120000-x", gamma: "not-a-run-id", beta: "20260831-010101-z" },
  });
  assert.equal(r.body.state.lastRunBySlug["BAD SLUG"], undefined, "非法 slug 不入");
  assert.equal(r.body.state.lastRunBySlug.gamma, undefined, "非法 runId 不入");
  assert.equal(r.body.state.lastRunBySlug.beta, "20260831-010101-z", "合法键可更新");

  // null = 清除该项目的记忆
  r = await call(h, "POST", "/issue2pr/api/ui-state", { lastRunBySlug: { alpha: null } });
  assert.equal(r.body.state.lastRunBySlug.alpha, undefined, "null 清除 alpha");
  assert.equal(r.body.state.lastRunBySlug.beta, "20260831-010101-z", "beta 不受牵连");

  // GET 原样返回
  r = await call(h, "GET", "/issue2pr/api/ui-state");
  assert.deepEqual(r.body.state.lastRunBySlug, { beta: "20260831-010101-z" });
});

test("run 失败 → P10 产物写回 run.json 的 failureAnalysis（GET 详情可见）", async () => {
  __setTestHooks({
    dataRoot: root,
    executors: {
      P1: async () => { throw new Error("LLM 返回为空"); }, // P1 即失败
      P10: async (rcx) => {
        writeArtifact(rcx.runDir, "09-failure-analysis.json",
          JSON.stringify({ category: "实现错误", detail: "空响应通常是解析缺陷", action: "rollback" }, null, 2));
        return { artifact: "09-failure-analysis.json", summary: "实现错误→rollback" };
      },
    },
  });
  const h = fakeCtx();

  let r = await call(h, "POST", "/issue2pr/api/projects", {
    name: "失败分析", slug: "fa-proj", repos: ["r1"], triggers: [{ kind: "issue", uri: "fa.md" }],
    reviewMode: "every", p6Mode: "builtin",
  });
  assert.equal(r.status, 200);

  const issueFile = join(root, "fa.md");
  writeFileSync(issueFile, "触发文本");
  r = await call(h, "POST", "/issue2pr/api/projects/fa-proj/runs", { kind: "issue", uri: issueFile });
  assert.equal(r.body.ok, true);
  const runId = r.body.runId;

  // 等异步推进：advance 失败 → P10 写产物 → recordFailureAnalysis 合并进 run.json
  let run = null;
  for (let i = 0; i < 20 && !(run && run.failureAnalysis); i++) {
    await new Promise((res2) => setTimeout(res2, 100));
    r = await call(h, "GET", `/issue2pr/api/projects/fa-proj/runs/${runId}`);
    run = r.body;
  }
  assert.equal(run.status, "failed", "P1 失败 → run 失败");
  assert.ok(run.failureAnalysis, "failureAnalysis 已写回 run.json");
  assert.equal(run.failureAnalysis.category, "实现错误");
  assert.equal(run.failureAnalysis.action, "rollback");
  assert.ok(run.failureAnalysis.at, "带时间戳");

  rmSync(join(root, "projects", "fa-proj"), { recursive: true, force: true });
});
