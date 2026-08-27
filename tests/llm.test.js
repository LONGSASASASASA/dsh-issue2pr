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