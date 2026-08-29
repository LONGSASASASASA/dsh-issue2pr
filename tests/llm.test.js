import { test } from "node:test";
import assert from "node:assert/strict";
import { makeLlm, extractJson } from "../lib/llm.js";

function fakeCtx(outputs) {
  let i = 0;
  return { llm: { async *stream() {
    const text = outputs[Math.min(i++, outputs.length - 1)];
    yield { type: "block-start", index: 0, blockType: "text" };
    yield { type: "text-delta", index: 0, text };
    yield { type: "finish", reason: "stop" };
  } } };
}

test("extractJson：围栏 / 裸 JSON / 垃圾输入", () => {
  assert.deepEqual(extractJson('前文```json\n{"a":1}\n```后文'), { a: 1 });
  assert.deepEqual(extractJson('直接 {"b":2} 结束'), { b: 2 });
  assert.throws(() => extractJson("没有 json"), /契约解析失败/);
});

test("completeJson：required 键缺失 → 重试一次后成功", async () => {
  const llm = makeLlm(fakeCtx(['{"phenomenon":"刷新退出"}', '{"phenomenon":"刷新退出","trigger":"刷新"}']));
  const out = await llm.completeJson({ system: "s", user: "u", required: ["phenomenon", "trigger"] });
  assert.equal(out.trigger, "刷新");
});

test("completeJson：两次都失败 → 抛契约解析失败", async () => {
  const llm = makeLlm(fakeCtx(["完全不是 json"]));
  await assert.rejects(() => llm.completeJson({ system: "s", user: "u", required: ["x"] }), /契约解析失败/);
});

test("completeJson：输出为标量（非对象）→ 抛契约解析失败", async () => {
  const llm = makeLlm(fakeCtx(["42"]));
  await assert.rejects(() => llm.completeJson({ system: "s", user: "u", required: ["x"] }), /契约解析失败/);
});

test("complete：拼接 text-delta", async () => {
  const llm = makeLlm(fakeCtx(["hello world"]));
  assert.equal(await llm.complete({ system: "s", user: "u" }), "hello world");
});

// —— E2E 修复：finish chunk 的 reason 为对象时不得吞掉适配器失败 ——
function fakeCtxChunks(chunks) {
  return { llm: { async *stream() { yield* chunks; } } };
}

test("complete：finish reason 为 {kind:'error'} 且无 text → 抛 LLM 调用失败（含 failure 信息，非『返回为空』）", async () => {
  const llm = makeLlm(fakeCtxChunks([
    { type: "finish", reason: { kind: "error", failure: { code: "INVALID_CREDENTIAL", message: "no credential" } } },
  ]));
  await assert.rejects(
    () => llm.complete({ system: "s", user: "u" }),
    (e) => /LLM 调用失败/.test(e.message) && /no credential/.test(e.message) && !/返回为空/.test(e.message),
  );
});

test("complete：finish reason 为 {kind:'aborted'} → 抛 LLM 调用失败", async () => {
  const llm = makeLlm(fakeCtxChunks([
    { type: "finish", reason: { kind: "aborted", failure: { code: "ABORTED" } } },
  ]));
  await assert.rejects(() => llm.complete({ system: "s", user: "u" }), /LLM 调用失败.*ABORTED/);
});

// —— E2E 修复：路由优先取 agentDefaultModel 服务 ——
test("resolveRoute：优先用 ctx.agentDefaultModel.currentSelection()", async () => {
  let seen = null;
  const ctx = {
    agentDefaultModel: { currentSelection: () => ({ provider: "bianlian", model: "kimi/kimi-k3" }) },
    getConfig: () => ({ provider: "cfg-p", model: "cfg-m" }),
    llm: { async *stream(opts) { seen = opts; yield { type: "text-delta", index: 0, text: "ok" }; yield { type: "finish", reason: "stop" }; } },
  };
  await makeLlm(ctx).complete({ system: "s", user: "u" });
  assert.equal(seen.provider, "bianlian");
  assert.equal(seen.model, "kimi/kimi-k3");
});

test("resolveRoute：currentSelection 抛错 → 回退 getConfig 路径", async () => {
  let seen = null;
  const ctx = {
    agentDefaultModel: { currentSelection: () => { throw new Error("no service"); } },
    getConfig: (k) => (k === "agent-default-model" ? { provider: "cfg-p", model: "cfg-m" } : undefined),
    llm: { async *stream(opts) { seen = opts; yield { type: "text-delta", index: 0, text: "ok" }; yield { type: "finish", reason: "stop" }; } },
  };
  await makeLlm(ctx).complete({ system: "s", user: "u" });
  assert.equal(seen.provider, "cfg-p");
  assert.equal(seen.model, "cfg-m");
});

// —— E2E 修复：Message.content 必须是 ContentBlock[]，字符串会触发适配器 content.some 异常 ——
test("complete：messages[0].content 为 text 块数组（dsh-llm Message 契约）", async () => {
  let seen = null;
  const ctx = { llm: { async *stream(opts) { seen = opts; yield { type: "text-delta", index: 0, text: "ok" }; yield { type: "finish", reason: "stop" }; } } };
  await makeLlm(ctx).complete({ system: "s", user: "我的需求" });
  assert.equal(seen.messages.length, 1);
  assert.equal(seen.messages[0].role, "user");
  assert.ok(Array.isArray(seen.messages[0].content), "content 必须是数组");
  assert.deepEqual(seen.messages[0].content, [{ type: "text", text: "我的需求" }]);
});
test("makeLlm(ctx, hook)：LLM 调用发事件（开始『调用中』+ 结束含耗时/预览；失败含 ok:false）", async () => {
  const okEvents = [];
  const llmOk = makeLlm(fakeCtx(["hello"]), (ev) => okEvents.push(ev));
  await llmOk.complete({ system: "s", user: "你好" });
  assert.equal(okEvents.length, 2);
  assert.equal(okEvents[0].kind, "llm");
  assert.match(okEvents[0].name, /调用中/);
  assert.equal(okEvents[0].ms, null, "进行中事件无耗时");
  assert.match(okEvents[0].detail, /【prompt】你好/);
  assert.equal(okEvents[1].ok, true);
  assert.ok(typeof okEvents[1].ms === "number");
  assert.match(okEvents[1].name, /完成/);
  assert.match(okEvents[1].detail, /【prompt】你好/);
  assert.match(okEvents[1].detail, /【响应】hello/);

  const badEvents = [];
  const llmBad = makeLlm(fakeCtxChunks([{ type: "finish", reason: { kind: "error", failure: { message: "boom" } } }]), (ev) => badEvents.push(ev));
  await assert.rejects(() => llmBad.complete({ system: "s", user: "x" }), /LLM 调用失败/);
  assert.equal(badEvents.length, 2);
  assert.match(badEvents[0].name, /调用中/);
  assert.equal(badEvents[1].ok, false);
  assert.match(badEvents[1].name, /失败/);
  assert.match(badEvents[1].detail, /boom/);
});
