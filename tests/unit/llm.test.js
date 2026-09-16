import { test } from "node:test";
import assert from "node:assert/strict";
import { makeLlm, extractJson, routeInfo } from "../../lib/infra/llm.js";

function fakeCtx(outputs) {
  let i = 0;
  return {
    get: (name) => name === "agentDefaultModel"
      ? { currentSelection: () => ({ provider: "test-provider", model: "test-model" }) }
      : undefined,
    llm: { async *stream() {
      const text = outputs[Math.min(i++, outputs.length - 1)];
      yield { type: "block-start", index: 0, blockType: "text" };
      yield { type: "text-delta", index: 0, text };
      yield { type: "finish", reason: "stop" };
    } },
  };
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

test("completeJson：LLM 调用失败不重试", async () => {
  let calls = 0;
  const ctx = {
    get: (name) => name === "agentDefaultModel"
      ? { currentSelection: () => ({ provider: "test-provider", model: "test-model" }) }
      : undefined,
    llm: { async *stream() {
      calls += 1;
      yield { type: "finish", reason: { kind: "error", failure: { message: "Authentication Fails" } } };
    } },
  };
  const llm = makeLlm(ctx);
  await assert.rejects(() => llm.completeJson({ system: "s", user: "u", required: ["x"] }), /Authentication Fails/);
  assert.equal(calls, 1);
});

test("completeJson：输出为标量（非对象）→ 抛契约解析失败", async () => {
  const llm = makeLlm(fakeCtx(["42"]));
  await assert.rejects(() => llm.completeJson({ system: "s", user: "u", required: ["x"] }), /契约解析失败/);
});

test("complete：拼接 text-delta", async () => {
  const llm = makeLlm(fakeCtx(["hello world"]));
  assert.equal(await llm.complete({ system: "s", user: "u" }), "hello world");
});

test("complete：超时会主动中断底层 stream", async () => {
  let aborted = false;
  const ctx = {
    get: (name) => name === "agentDefaultModel"
      ? { currentSelection: () => ({ provider: "test-provider", model: "test-model" }) }
      : undefined,
    llm: { async *stream({ signal }) {
      await new Promise((resolve) => {
        if (signal.aborted) {
          aborted = true;
          resolve();
          return;
        }
        signal.addEventListener("abort", () => {
          aborted = true;
          resolve();
        }, { once: true });
      });
      throw new Error("stream aborted");
    } },
  };
  const llm = makeLlm(ctx, null, () => ({ timeoutMs: 20 }));

  await assert.rejects(() => llm.complete({ system: "s", user: "u" }), /LLM 调用超时/);
  assert.equal(aborted, true);
});

// —— E2E 修复：finish chunk 的 reason 为对象时不得吞掉适配器失败 ——
function fakeCtxChunks(chunks) {
  return {
    get: (name) => name === "agentDefaultModel"
      ? { currentSelection: () => ({ provider: "test-provider", model: "test-model" }) }
      : undefined,
    llm: { async *stream() { yield* chunks; } },
  };
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

// —— E2E 修复：路由取宿主 agentDefaultModel 服务 ——
test("resolveRoute：使用 ctx.get('agentDefaultModel').currentSelection()", async () => {
  let seen = null;
  const ctx = {
    get: (name) => name === "agentDefaultModel"
      ? { currentSelection: () => ({ provider: "zai", model: "glm-5.3" }) }
      : undefined,
    llm: { async *stream(opts) { seen = opts; yield { type: "text-delta", index: 0, text: "ok" }; yield { type: "finish", reason: "stop" }; } },
  };
  await makeLlm(ctx).complete({ system: "s", user: "u" });
  assert.equal(seen.provider, "zai");
  assert.equal(seen.model, "glm-5.3");
});

test("routeInfo：宿主默认模型不可用时显式报错", () => {
  assert.throws(() => routeInfo({}, {}), /无法读取 DSH 当前默认模型/);
});

test("routeInfo：阶段覆盖只配置 provider 或 model 时显式报错", () => {
  assert.throws(() => routeInfo({}, { provider: "only-provider" }), /provider.*model|成对/);
  assert.throws(() => routeInfo({}, { model: "only-model" }), /provider.*model|成对/);
});

// —— E2E 修复：Message.content 必须是 ContentBlock[]，字符串会触发适配器 content.some 异常 ——
test("complete：messages[0].content 为 text 块数组（dsh-llm Message 契约）", async () => {
  let seen = null;
  const ctx = {
    get: (name) => name === "agentDefaultModel"
      ? { currentSelection: () => ({ provider: "test-provider", model: "test-model" }) }
      : undefined,
    llm: { async *stream(opts) { seen = opts; yield { type: "text-delta", index: 0, text: "ok" }; yield { type: "finish", reason: "stop" }; } },
  };
  await makeLlm(ctx).complete({ system: "s", user: "我的需求" });
  assert.equal(seen.messages.length, 1);
  assert.equal(seen.messages[0].role, "user");
  assert.ok(Array.isArray(seen.messages[0].content), "content 必须是数组");
  assert.deepEqual(seen.messages[0].content, [{ type: "text", text: "我的需求" }]);
});
// —— TASK-01：调用身份（重试共享 callId / 实际请求独立 attemptId / retryOf 链） ——
test("completeJson：重试共享 callId，attemptId 独立且 retryOf 指向前次 + 带 retryReason", async () => {
  const events = [];
  const llm = makeLlm(fakeCtx(['{"phenomenon":"刷新退出"}', '{"phenomenon":"刷新退出","trigger":"刷新"}']),
    (ev) => events.push(ev));
  await llm.completeJson({ system: "s", user: "u", required: ["phenomenon", "trigger"] });
  assert.equal(new Set(events.map((e) => e.callId)).size, 1, "同一逻辑调用的重试共享 callId");
  const first = events.find((e) => e.attempt === 1);
  const second = events.find((e) => e.attempt === 2);
  assert.ok(first && second, "两次真实请求都发出事件");
  assert.notEqual(first.attemptId, second.attemptId, "attemptId 区分实际请求");
  assert.equal(second.retryOf, first.attemptId, "retryOf 反向指向前一 attemptId");
  assert.equal(first.retryOf, undefined, "首次请求无 retryOf");
  assert.match(second.retryReason, /契约解析失败/, "重试事件携带原因");
  assert.equal(first.retryReason, undefined);
});

test("complete：独立调用自动生成身份（attempt=1，无 retryOf）", async () => {
  const events = [];
  const llm = makeLlm(fakeCtx(["ok"]), (ev) => events.push(ev));
  await llm.complete({ system: "s", user: "u" });
  assert.match(events[0].callId, /^call-[0-9a-f]{12}$/);
  assert.match(events[0].attemptId, /^attempt-[0-9a-f]{12}$/);
  assert.equal(events[0].attempt, 1);
  assert.equal(events[0].retryOf, undefined);
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

// —— TASK-02：内置 LLM 全过程留档 ——
import { mkdtempSync, readdirSync, readFileSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readJournal, readJournalRef } from "../../lib/infra/journal.js";

const newRunDir = () => mkdtempSync(join(tmpdir(), "i2p-llm-log-"));
// 读出一次 attempt 留档的全部 JSON 记录（按写入顺序）
const readRecords = (runDir, logDir) => {
  const dir = join(runDir, ...logDir.split("/"));
  const shards = readdirSync(dir).filter((n) => /^shard-\d{6}\.jsonl$/.test(n)).sort();
  return shards.flatMap((f) => readFileSync(join(dir, f), "utf8").trim().split("\n").map((l) => JSON.parse(l)));
};

test("TASK-02 complete：请求快照→流式增量→完整正文→结束元数据全程留档，可按 callId/attemptId 回溯", async () => {
  const runDir = newRunDir();
  const events = [];
  const longText = "完整响应正文内容，".repeat(200); // 长于预览阈值，验证摘要不混入全文
  const llm = makeLlm(fakeCtx([longText]), (ev) => events.push(ev),
    null, () => ({ runDir, runId: "run-1", stage: "P1", stageExecutionId: "P1-20260916-000000-abcdef123456" }));
  await llm.complete({ system: "系统提示", user: "用户输入", callId: "call-fixed001", attemptId: "attempt-fixed01" });
  const logDir = "trace/llm/call-fixed001/attempt-fixed01";
  assert.equal(events[0].logDir, logDir, "摘要事件带留档目录引用");
  const r = readJournal(join(runDir, ...logDir.split("/")));
  assert.equal(r.integrity, "complete");
  assert.equal(r.manifest.meta.callId, "call-fixed001");
  assert.equal(r.manifest.meta.attemptId, "attempt-fixed01");
  assert.equal(r.manifest.meta.stage, "P1");
  assert.equal(r.manifest.meta.stageExecutionId, "P1-20260916-000000-abcdef123456");
  assert.equal(r.manifest.meta.provider, "test-provider");
  const records = readRecords(runDir, logDir);
  const request = records.find((x) => x.kind === "request");
  assert.equal(request.system, "系统提示");
  assert.equal(request.user, "用户输入");
  assert.deepEqual(Object.keys(request.params).sort(), ["maxTokens", "model", "provider"], "只记允许字段，不含任何认证信息");
  const response = records.find((x) => x.kind === "response");
  assert.equal(response.text, longText, "留档保存完整正文");
  const finish = records.find((x) => x.kind === "finish");
  assert.equal(finish.status, "completed");
  assert.equal(finish.finishReason, "stop");
  assert.equal(finish.rawFinishReason, "stop");
  assert.equal(finish.usage, "unavailable", "宿主未暴露 usage 时明确标记");
  assert.ok(typeof finish.ms === "number");
  // 摘要不混入完整正文：事件只含截断预览（有界），留档才是全文载体
  assert.ok(!JSON.stringify(events).includes(longText), "事件不得包含完整正文");
  assert.match(events[1].detail, /…/, "长响应预览必须截断");
  rmSync(runDir, { recursive: true, force: true });
});

test("TASK-02 请求快照无法持久化 → 中止调用（请求不发出），报留档故障", async () => {
  const notADir = join(newRunDir(), "occupied");
  writeFileSync(notADir, "占位文件，使 mkdir 失败");
  let streamCalls = 0;
  const ctx = {
    get: () => ({ currentSelection: () => ({ provider: "p", model: "m" }) }),
    llm: { async *stream() { streamCalls += 1; yield { type: "text-delta", text: "x" }; } },
  };
  const llm = makeLlm(ctx, null, null, () => ({ runDir: join(notADir, "trace", "llm", "c", "a") }));
  await assert.rejects(() => llm.complete({ system: "s", user: "u" }),
    (e) => e.code === "JOURNAL_FAULT" && /留档故障/.test(e.message));
  assert.equal(streamCalls, 0, "请求必须未发出");
});

test("TASK-02 请求发出后留档故障不中断业务流：正常返回文本，完整性如实标记 write_failed", async () => {
  const runDir = newRunDir();
  const ctx = {
    get: () => ({ currentSelection: () => ({ provider: "p", model: "m" }) }),
    llm: { async *stream() {
      yield { type: "text-delta", text: "第一段" };
      // 请求已发出：把 manifest.json 换成目录，制造后续清单原子写失败
      const base = join(runDir, "trace", "llm");
      const callName = readdirSync(base)[0];
      const attemptName = readdirSync(join(base, callName))[0];
      const target = join(base, callName, attemptName, "manifest.json");
      rmSync(target);
      mkdirSync(target);
      yield { type: "text-delta", text: "第二段" };
      yield { type: "finish", reason: "stop" };
    } },
  };
  const events = [];
  const llm = makeLlm(ctx, (ev) => events.push(ev), null, () => ({ runDir, runId: "r", stage: "P2", stageExecutionId: "se" }));
  const text = await llm.complete({ system: "s", user: "u" });
  assert.equal(text, "第一段第二段", "留档故障不得中断响应收集");
  assert.equal(events[1].logIntegrity, "write_failed", "摘要事件如实带完整性");
});

test("TASK-02 completeJson：处理错误连同原文引用留档，重试两个 attempt 各自独立目录", async () => {
  const runDir = newRunDir();
  const llm = makeLlm(fakeCtx(["完全不是 json", '{"ok":1}']), null,
    null, () => ({ runDir, runId: "r", stage: "P3", stageExecutionId: "se" }));
  const out = await llm.completeJson({ system: "s", user: "u", required: ["ok"] });
  assert.deepEqual(out, { ok: 1 });
  const callDir = join(runDir, "trace", "llm");
  const callId = readdirSync(callDir)[0];
  // attemptId 是随机十六进制，目录名排序 ≠ 执行顺序：按 manifest.meta.attempt 稳定定序
  const attempts = readdirSync(join(callDir, callId))
    .map((name) => ({ name, n: JSON.parse(readFileSync(join(callDir, callId, name, "manifest.json"), "utf8")).meta.attempt }))
    .sort((a, b) => a.n - b.n)
    .map((x) => x.name);
  assert.equal(attempts.length, 2, "重试各建独立 attempt 目录");
  const firstRecords = readRecords(runDir, `trace/llm/${callId}/${attempts[0]}`);
  const bad = firstRecords.find((x) => x.kind === "process" && x.ok === false);
  assert.ok(bad, "首个 attempt 必须留有处理失败记录");
  assert.match(bad.error, /契约解析失败/);
  assert.ok(bad.inputRef && bad.inputRef.sha256, "处理错误带原文引用");
  // 原文引用可回溯到该次响应正文（inputRef 指向整条 response 记录）
  const back = readJournalRef(join(callDir, callId, attempts[0]), bad.inputRef);
  assert.equal(JSON.parse(back.text).text, "完全不是 json");
  const secondRecords = readRecords(runDir, `trace/llm/${callId}/${attempts[1]}`);
  assert.ok(secondRecords.find((x) => x.kind === "process" && x.ok === true), "第二次处理成功也留档");
  const r = readJournal(join(callDir, callId, attempts[0]));
  assert.equal(r.integrity, "complete");
  rmSync(runDir, { recursive: true, force: true });
});

test("TASK-02 无留档上下文（悬浮助手等）不留档，调用行为不变", async () => {
  const runDir = newRunDir();
  const llm = makeLlm(fakeCtx(["ok"]));
  assert.equal(await llm.complete({ system: "s", user: "u" }), "ok");
  assert.equal(readdirSync(runDir).length, 0, "不产生任何留档目录");
  rmSync(runDir, { recursive: true, force: true });
});

// —— TASK-04：固定处理顺序 + 稳定错误类别 ——
test("TASK-04 finish reason 为 length → output_truncated，文本碰巧可解析也不当成功", async () => {
  let calls = 0;
  const ctx = {
    get: () => ({ currentSelection: () => ({ provider: "p", model: "m" }) }),
    llm: { async *stream() {
      calls += 1;
      yield { type: "text-delta", index: 0, text: '{"ok":1}' }; // 完整可解析的 JSON
      yield { type: "finish", reason: { kind: "length" } }; // 但因 token 上限被截断
    } },
  };
  const llm = makeLlm(ctx);
  await assert.rejects(() => llm.completeJson({ system: "s", user: "u", required: ["ok"] }),
    (e) => e.code === "output_truncated" && /截断/.test(e.message) && e.finishReason === "length");
  // TASK-06：截断走预算提升重试（唯一一次），总请求不超过 2 次
  assert.equal(calls, 2, "截断允许一次预算提升重试");
});

test("TASK-04 截断判定在保存正文之后：response 记录与 truncation-check 处理记录均可回溯", async () => {
  const runDir = newRunDir();
  const ctx = {
    get: () => ({ currentSelection: () => ({ provider: "p", model: "m" }) }),
    llm: { async *stream() {
      yield { type: "text-delta", index: 0, text: "被截断的半截正文" };
      yield { type: "finish", reason: { kind: "max_tokens" } };
    } },
  };
  const llm = makeLlm(ctx, null, null, () => ({ runDir, runId: "r", stage: "P1", stageExecutionId: "se" }));
  await assert.rejects(() => llm.complete({ system: "s", user: "u" }), (e) => e.code === "output_truncated");
  const callDir = join(runDir, "trace", "llm");
  const callId = readdirSync(callDir)[0];
  const attemptId = readdirSync(join(callDir, callId))[0];
  const records = readRecords(runDir, `trace/llm/${callId}/${attemptId}`);
  const response = records.find((x) => x.kind === "response");
  assert.equal(response.text, "被截断的半截正文", "正文先落盘，截断判定不吞响应");
  const check = records.find((x) => x.kind === "process" && x.step === "truncation-check");
  assert.ok(check && check.ok === false && check.errorCode === "output_truncated" && check.inputRef?.sha256,
    "截断判定留档并带原文引用");
  const finish = records.find((x) => x.kind === "finish");
  assert.equal(finish.status, "failed");
  assert.equal(finish.finishReason, "max_tokens", "finish reason 可回溯");
  rmSync(runDir, { recursive: true, force: true });
});

test("TASK-04 调用失败细因稳定：provider / cancelled / empty / timeout 归入 llm_call_failed 且互斥", async () => {
  const mk = (chunks) => makeLlm(fakeCtxChunks(chunks));
  await assert.rejects(() => mk([{ type: "finish", reason: { kind: "error", failure: { message: "boom" } } }]).complete({ system: "s", user: "u" }),
    (e) => e.code === "llm_call_failed" && e.llmCause === "provider");
  await assert.rejects(() => mk([{ type: "finish", reason: { kind: "aborted", failure: { code: "ABORTED" } } }]).complete({ system: "s", user: "u" }),
    (e) => e.code === "llm_call_failed" && e.llmCause === "cancelled");
  await assert.rejects(() => mk([{ type: "finish", reason: "stop" }]).complete({ system: "s", user: "u" }),
    (e) => e.code === "llm_call_failed" && e.llmCause === "empty");
  // 超时：既有消息不变，补 code / llmCause
  const timeoutLlm = makeLlm({
    get: () => ({ currentSelection: () => ({ provider: "p", model: "m" }) }),
    llm: { async *stream({ signal }) {
      await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
      throw new Error("stream aborted");
    } },
  }, null, () => ({ timeoutMs: 20 }));
  await assert.rejects(() => timeoutLlm.complete({ system: "s", user: "u" }),
    (e) => e.code === "llm_call_failed" && e.llmCause === "timeout");
});

test("TASK-04 未分类流异常统一归 llm_call_failed：未知原因 unknown，调用方取消 cancelled，原始 cause 保留", async () => {
  const unknown = makeLlm({
    get: () => ({ currentSelection: () => ({ provider: "p", model: "m" }) }),
    llm: { async *stream() { yield { type: "text-delta", text: "x" }; throw new Error("network reset"); } },
  });
  await assert.rejects(() => unknown.complete({ system: "s", user: "u" }),
    (e) => e.code === "llm_call_failed" && e.llmCause === "unknown" && e.cause?.message === "network reset");
  const cancelled = makeLlm({
    get: () => ({ currentSelection: () => ({ provider: "p", model: "m" }) }),
    llm: { async *stream({ signal }) { if (signal.aborted) throw new Error("AbortError: caller cancelled"); } },
  });
  await assert.rejects(() => cancelled.complete({ system: "s", user: "u", signal: AbortSignal.abort() }),
    (e) => e.code === "llm_call_failed" && e.llmCause === "cancelled");
});

test("TASK-04 json_parse_failed 与 schema_validation_failed 稳定互斥且可序列化", async () => {
  const parse = makeLlm(fakeCtx(["完全不是 json"])); // 两次都解析失败
  await assert.rejects(() => parse.completeJson({ system: "s", user: "u", required: ["x"] }),
    (e) => e.code === "json_parse_failed" && /契约解析失败/.test(e.message));
  const scalar = makeLlm(fakeCtx(["42"])); // 两次都不是对象
  await assert.rejects(() => scalar.completeJson({ system: "s", user: "u", required: ["x"] }),
    (e) => e.code === "schema_validation_failed");
  const missing = makeLlm(fakeCtx(['{"a":1}'])); // 两次都缺 required 字段
  await assert.rejects(() => missing.completeJson({ system: "s", user: "u", required: ["a", "b"] }),
    (e) => e.code === "schema_validation_failed" && /缺字段 b/.test(e.message));
  // 可序列化：JSON.stringify(Error 默认只剩 {}），结构化错误必须显式带出 code/message
  const ser = makeLlm(fakeCtx(["nope"]));
  await assert.rejects(() => ser.completeJson({ system: "s", user: "u", required: ["x"] }), (e) => {
    const round = JSON.parse(JSON.stringify(e));
    return round.code === "json_parse_failed" && /契约解析失败/.test(round.message) && round.name === "LlmError";
  });
});

// —— TASK-05：结构化调用 schema 校验 ——
import { validateSchema } from "../../lib/infra/llm.js";

test("TASK-05 validateSchema：类型 / 枚举 / 嵌套缺失 / 数组元素类型逐项定位", () => {
  const schema = { // P1 形态：数组元素 + 枚举 + 必填嵌套
    type: "object",
    required: ["phenomenon", "scope", "risk_level"],
    properties: {
      phenomenon: { type: "string" },
      scope: { type: "array", items: { type: "string" } },
      risk_level: { type: "string", enum: ["low", "medium", "high"] },
    },
  };
  assert.deepEqual(validateSchema({ phenomenon: "x", scope: ["a"], risk_level: "low" }, schema), [], "合法输出零问题");
  assert.deepEqual(validateSchema({ phenomenon: 42, scope: "不是数组", risk_level: "临界" }, schema), [
    "$.phenomenon 应为 string，实际 number",
    "$.scope 应为 array，实际 string",
    '$.risk_level 取值 "临界" 不在枚举 [low|medium|high] 内',
  ], "类型与枚举错误路径定位稳定");
  assert.deepEqual(validateSchema({ scope: [], risk_level: "low" }, schema), [
    "$.phenomenon 缺失",
  ], "必填字段缺失");
  assert.deepEqual(validateSchema({ phenomenon: "x", scope: ["a", 7], risk_level: "low" }, schema), [
    "$.scope[1] 应为 string，实际 number",
  ], "数组元素类型校验带下标");
  // 深嵌套（P11 reasons 形态）
  const deep = { type: "object", required: ["reasons"], properties: { reasons: { type: "object",
    required: ["ROOT"], properties: { ROOT: { type: "array", items: { type: "string" } } } } } };
  assert.deepEqual(validateSchema({ reasons: { ROOT: ["依据", 3] } }, deep), ["$.reasons.ROOT[1] 应为 string，实际 number"]);
});

test("TASK-05 completeJson：schema 违规 → schema_validation_failed 并触发格式修复重试", async () => {
  // 首次枚举非法，第二次合法 → 重试成功
  const fix = makeLlm(fakeCtx(['{"verdict":"ok","notes":"x"}', '{"verdict":"pass","notes":"修复后"}']));
  const out = await fix.completeJson({ system: "s", user: "u", required: ["verdict"],
    schema: { type: "object", required: ["verdict"], properties: {
      verdict: { type: "string", enum: ["pass", "fail"] }, notes: { type: "string" } } } });
  assert.deepEqual(out, { verdict: "pass", notes: "修复后" });
  // 两次都违规 → 最终 schema_validation_failed，消息带 JSON 路径
  const bad = makeLlm(fakeCtx(['{"verdict":"ok"}']));
  await assert.rejects(() => bad.completeJson({ system: "s", user: "u", required: ["verdict"],
    schema: { type: "object", required: ["verdict"], properties: {
      verdict: { type: "string", enum: ["pass", "fail"] } } } }),
    (e) => e.code === "schema_validation_failed" && /\$\.verdict/.test(e.message) && /枚举/.test(e.message));
});

test("TASK-05 completeJson：合法输出带 schema 继续通过（P1 契约实测）", async () => {
  const llm = makeLlm(fakeCtx(['{"phenomenon":"刷新退出","trigger":"刷新","scope":["auth"],"success_criteria":["不再退出"],"constraints":["不改动公开 API"],"risk_level":"medium"}']));
  const out = await llm.completeJson({ system: "s", user: "u",
    required: ["phenomenon", "trigger", "scope", "success_criteria", "constraints", "risk_level"],
    schema: { type: "object",
      required: ["phenomenon", "trigger", "scope", "success_criteria", "constraints", "risk_level"],
      properties: {
        phenomenon: { type: "string" }, trigger: { type: "string" },
        scope: { type: "array", items: { type: "string" } },
        success_criteria: { type: "array", items: { type: "string" } },
        constraints: { type: "array", items: { type: "string" } },
        risk_level: { type: "string", enum: ["low", "medium", "high"] },
      } } });
  assert.equal(out.risk_level, "medium");
});

// —— TASK-06：有限重试机制 ——
test("TASK-06 格式修复重试只带 schema+错误+上次原文，不再次发送原业务长 prompt", async () => {
  const seen = [];
  const ctx = {
    get: () => ({ currentSelection: () => ({ provider: "p", model: "m" }) }),
    llm: { async *stream(opts) {
      seen.push(opts);
      yield { type: "text-delta", index: 0, text: seen.length === 1 ? "坏的输出" : '{"verdict":"pass"}' };
      yield { type: "finish", reason: "stop" };
    } },
  };
  const llm = makeLlm(ctx);
  const out = await llm.completeJson({ system: "业务系统提示", user: "这是一段很长的业务 prompt：请分析登录后刷新退出问题……（原文）",
    required: ["verdict"],
    schema: { type: "object", required: ["verdict"], properties: { verdict: { type: "string", enum: ["pass", "fail"] } } } });
  assert.equal(out.verdict, "pass");
  assert.equal(seen.length, 2, "恰好两次真实请求");
  const repairMessages = seen[1].messages;
  const repairUser = repairMessages[0].content[0].text;
  assert.ok(!repairUser.includes("很长的业务 prompt"), "修复请求不得携带原业务 prompt");
  assert.ok(repairUser.includes('"verdict"') && repairUser.includes("pass|fail") === false, "修复请求带目标 schema");
  assert.match(repairUser, /【上次输出存在的具体问题】/, "修复请求带具体错误");
  assert.match(repairUser, /【上次原始输出】\n坏的输出/, "修复请求带上次原始输出");
});

test("TASK-06 截断预算重试：预算翻倍不超硬上限，retryReason 记录预算变化，仍截断则失败带重试链", async () => {
  const seen = [];
  const ctx = {
    get: () => ({ currentSelection: () => ({ provider: "p", model: "m" }) }),
    llm: { async *stream(opts) {
      seen.push(opts);
      yield { type: "text-delta", index: 0, text: '{"ok":1}' };
      yield { type: "finish", reason: { kind: "length" } };
    } },
  };
  const events = [];
  const llm = makeLlm(ctx, (ev) => events.push(ev));
  await assert.rejects(() => llm.completeJson({ system: "s", user: "u", required: ["ok"] }),
    (e) => e.code === "output_truncated" && Array.isArray(e.retryHistory) && e.retryHistory.length === 2
      && e.retryHistory[1].retryKind === "budget_raise");
  assert.equal(seen.length, 2);
  assert.equal(seen[0].maxTokens, 8192, "首次预算为默认");
  assert.equal(seen[1].maxTokens, 16384, "重试预算翻倍");
  assert.match(events.find((e) => e.attempt === 2).retryReason, /8192 → 16384/, "预算变化可追溯");
});

test("TASK-06 预算已达硬上限 → 截断不再重试（总 1 次请求）；阶段配置预算同样受显式上限约束", async () => {
  let calls = 0;
  const ctx = {
    get: () => ({ currentSelection: () => ({ provider: "p", model: "m" }) }),
    llm: { async *stream() {
      calls += 1;
      yield { type: "text-delta", index: 0, text: "x" };
      yield { type: "finish", reason: { kind: "length" } };
    } },
  };
  const llm = makeLlm(ctx, null, () => ({ maxTokens: 32768 })); // 已在硬上限
  await assert.rejects(() => llm.completeJson({ system: "s", user: "u", required: ["ok"] }),
    (e) => e.code === "output_truncated" && e.retryHistory.length === 1);
  assert.equal(calls, 1, "无法提升预算时不重试");
});

test("TASK-06 连续格式失败：总请求恰 2 次，最终错误保留完整 retryHistory 且可序列化", async () => {
  let calls = 0;
  const ctx = {
    get: () => ({ currentSelection: () => ({ provider: "p", model: "m" }) }),
    llm: { async *stream() {
      calls += 1;
      yield { type: "text-delta", index: 0, text: calls === 1 ? "完全不是 json" : '{"verdict":"也许"}' };
      yield { type: "finish", reason: "stop" };
    } },
  };
  const llm = makeLlm(ctx);
  await assert.rejects(() => llm.completeJson({ system: "s", user: "业务", required: ["verdict"],
    schema: { type: "object", required: ["verdict"], properties: { verdict: { type: "string", enum: ["pass", "fail"] } } } }),
    (e) => {
      assert.equal(calls, 2, "总请求上限 2 次");
      assert.equal(e.code, "schema_validation_failed", "最终错误是第二次的具体错误");
      const round = JSON.parse(JSON.stringify(e));
      assert.equal(round.retryHistory.length, 2);
      assert.equal(round.retryHistory[0].code, "json_parse_failed");
      assert.equal(round.retryHistory[1].retryKind, "format_repair");
      assert.equal(round.retryHistory[1].code, "schema_validation_failed");
      return true;
    });
});

test("TASK-06 timeout / provider 错误不进入任何重试（总 1 次请求）", async () => {
  let calls = 0;
  const ctx = {
    get: () => ({ currentSelection: () => ({ provider: "p", model: "m" }) }),
    llm: { async *stream() {
      calls += 1;
      yield { type: "finish", reason: { kind: "error", failure: { message: "quota" } } };
    } },
  };
  await assert.rejects(() => makeLlm(ctx).completeJson({ system: "s", user: "u", required: ["x"] }),
    (e) => e.code === "llm_call_failed");
  assert.equal(calls, 1);
});
