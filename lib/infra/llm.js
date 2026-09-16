// lib/llm.js — ctx.llm.stream 封装 + JSON 契约解析（重试一次）
// makeLlm(ctx, hook, overridesOf, journalOf)：overridesOf() 返回当前阶段的覆盖配置
// （provider/model/reasoningEffort/timeoutMs/maxTokens，来自 project.stageConfig），
// 每次调用时现取，阶段推进/配置修改即时生效。
// 路由解析 + 来源标注（source：stage=阶段覆盖 / host=宿主默认）。
// preflight 端点用它把「当前默认模型从哪来」台面化。
// 调用身份（TASK-01）：completeJson 生成 callId，每次真实请求独立 attemptId；
// 重试共享 callId 并经 retryOf 指向前一 attempt，事件钩子携带全部身份字段。
// 全过程留档（TASK-02）：journalOf() 返回留档上下文（runDir + 执行身份）时，
// 每次真实请求建独立 journal（trace/llm/<callId>/<attemptId>/）——请求发送前
// 持久化实际输入与生效参数（快照失败即中止调用，请求不发出）；响应期间流式
// 片段持续落盘；结束后保存完整正文、原始/归一化 finish reason、usage 与耗时；
// JSON 提取/解析等处理错误连同原文引用一并留档。摘要事件（hook）只带 logDir
// 引用与截断预览，不混入完整正文。悬浮助手等无 Run 场景 journalOf 为空，不留档。
import { join } from "node:path";
import { newAttemptId, newCallId } from "./ids.js";
import { createJournal } from "./journal.js";

const nowIso = () => new Date().toISOString();

export function routeInfo(ctx, ov) {
  const hasProvider = typeof ov?.provider === "string" && ov.provider.trim() !== "";
  const hasModel = typeof ov?.model === "string" && ov.model.trim() !== "";
  if (hasProvider !== hasModel) throw new Error("provider 与 model 必须成对配置，不能只覆盖其中一项");
  // 0) 阶段级覆盖最高优先（配置页按阶段指定模型）
  if (ov && ov.provider && ov.model) {
    const route = { provider: ov.provider, model: ov.model };
    if (ov.reasoningEffort) route.reasoningEffort = ov.reasoningEffort;
    return { route, source: "stage" };
  }
  // 1) 读取宿主 agentDefaultModel 服务（真实生效的默认路由）
  try {
    const service = typeof ctx.get === "function"
      ? ctx.get("agentDefaultModel")
      : ctx.agentDefaultModel;
    const sel = service && typeof service.currentSelection === "function"
      ? service.currentSelection() : undefined;
    if (sel && sel.provider && sel.model) {
      const route = { provider: sel.provider, model: sel.model };
      if (sel.reasoningEffort) route.reasoningEffort = sel.reasoningEffort; // GenerateOptions 支持该字段
      return { route, source: "host" };
    }
  } catch (error) {
    throw new Error("无法读取 DSH 当前默认模型: " + String((error && error.message) || error));
  }
  throw new Error("无法读取 DSH 当前默认模型");
}

function resolveRoute(ctx, ov) {
  return routeInfo(ctx, ov).route;
}

// TASK-04：稳定错误类别（互斥、可序列化）。同一失败点只归入一个类别；
// llm_call_failed 以 llmCause 保存 timeout / provider / cancelled / empty 等
// 具体原因；output_truncated 优先于 JSON 处理判定（文本碰巧可解析也不当成功）。
export const LLM_ERROR_CODES = [
  "llm_call_failed", "output_truncated", "json_parse_failed",
  "schema_validation_failed", "business_gate_failed",
];

// 结构化 LLM 错误工厂：code 必属已定义类别，extra 只放标量（cause 除外），
// toJSON 保证 JSON.stringify 后 code/message/finishReason 等字段仍可读
// （Error 默认序列化只剩 {}，结构化错误必须显式可序列化）。
export function llmError(code, message, extra = {}) {
  if (!LLM_ERROR_CODES.includes(code)) throw new Error("未知 LLM 错误类别: " + code);
  const e = new Error(message);
  e.name = "LlmError";
  e.code = code;
  for (const [k, v] of Object.entries(extra)) if (v !== undefined) e[k] = v;
  // 可序列化白名单（TASK-07）：complete 会事后附着调用身份（callId/attemptId/logDir），
  // toJSON 从实例动态收集，保证 JSON.stringify 后贯通字段不丢
  const SER_FIELDS = ["llmCause", "provider", "model", "finishReason", "rawFinishReason",
    "textChars", "timeoutMs", "callId", "attemptId", "logDir", "logIntegrity"];
  const serError = (v) => (v instanceof Error ? { name: v.name, message: v.message, code: v.code || null } : v);
  e.toJSON = () => {
    const out = { name: "LlmError", code, message };
    for (const [k, v] of Object.entries(extra)) if (v !== undefined && out[k] === undefined) out[k] = serError(v);
    for (const k of SER_FIELDS) if (e[k] !== undefined && out[k] === undefined) out[k] = serError(e[k]);
    if (e.cause) out.cause = serError(e.cause);
    if (e.retryHistory) out.retryHistory = e.retryHistory;
    return out;
  };
  return e;
}

// 明确的 token / length / incomplete 结束原因 → 输出被截断
const TRUNCATION_RE = /length|token|incomplete|truncat/i;
// TASK-06：截断重试的输出预算硬上限（明确上限，不允许无限加预算）
export const TRUNC_RETRY_TOKEN_CEILING = 32768;

// TASK-05：声明式输出 schema 校验。schema 是纯 JSON 可序列化对象，格式修复
// 重试可直接把 schema 与具体错误发给模型（TASK-06）。类型：string/number/
// boolean/object/array；约束：required（必填键）、enum（枚举）、properties
// （对象嵌套）、items（数组元素）。返回问题数组（空 = 合常），消息以 JSON
// 路径定位（$.candidates[0].confidence），稳定可读、不截断输出内容。
export function validateSchema(value, schema, path = "$") {
  const problems = [];
  const t = schema?.type;
  const actual = Array.isArray(value) ? "array" : value === null ? "null" : typeof value;
  if (t && actual !== t) return [`${path} 应为 ${t}，实际 ${actual}`]; // 类型不符不再深入
  if (schema.enum && !schema.enum.includes(value)) {
    problems.push(`${path} 取值 ${JSON.stringify(value)} 不在枚举 [${schema.enum.join("|")}] 内`);
  }
  if (actual === "object") {
    for (const key of schema.required || []) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) problems.push(`${path}.${key} 缺失`);
    }
    for (const [key, sub] of Object.entries(schema.properties || {})) {
      if (value[key] !== undefined) problems.push(...validateSchema(value[key], sub, `${path}.${key}`));
    }
  }
  if (actual === "array" && schema.items) {
    value.forEach((item, i) => problems.push(...validateSchema(item, schema.items, `${path}[${i}]`)));
  }
  return problems;
}

export function extractJson(text) {
  const fenced = String(text).match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : (() => {
    const s = String(text);
    const i = s.indexOf("{"), j = s.lastIndexOf("}");
    if (i === -1 || j <= i) {
      // TASK-04 顺序：无对象可提取时先尝试整段 JSON.parse——裸标量（"42"、
      // "true"、数组等）能解析成功，交给后续 schema 校验判类型；
      // 解析也不成才算「不含 JSON 对象」（json_parse_failed）
      const whole = s.trim();
      try { return JSON.parse(whole); }
      catch { throw new Error("契约解析失败: 输入不含 JSON 对象"); }
    }
    return s.slice(i, j + 1);
  })();
  try { return JSON.parse(candidate); }
  catch (e) { throw new Error("契约解析失败: " + e.message); }
}

// 原始 finish reason（宿主可能是字符串或 {kind, failure?} 对象）→ 归一化短值
function normalizeFinishReason(reason) {
  if (typeof reason === "string") return reason;
  if (reason && typeof reason === "object" && typeof reason.kind === "string") return reason.kind;
  return "unavailable";
}

// 响应事件里的标量字段全录（type/index/blockType 等），对象字段按 finish 分支单独处理；
// 宿主事件不含认证内容，序列化前仍只挑白名单类型，防意外深对象
const scalarFields = (obj) => Object.fromEntries(
  Object.entries(obj || {}).filter(([, v]) => ["string", "number", "boolean"].includes(typeof v)));

// 单次真实请求的留档句柄：目录 trace/llm/<callId>/<attemptId>（身份即路径，单写者）。
// 请求快照无法持久化 → 构造/首条记录抛错，由调用方中止（请求尚未发出）；
// 请求发出后的留档故障只记 fault（不中断模型流），封存时如实标记 write_failed。
function openAttemptLog(journalOf, meta, request) {
  const scope = typeof journalOf === "function" ? journalOf() : null;
  if (!scope || !scope.runDir) return null;
  const relDir = `trace/llm/${meta.callId}/${meta.attemptId}`;
  const journal = createJournal({
    dir: join(scope.runDir, "trace", "llm", meta.callId, meta.attemptId),
    meta: {
      runId: scope.runId || null, stage: scope.stage || null,
      stageExecutionId: scope.stageExecutionId || null,
      provider: meta.provider, model: meta.model,
      ...(meta.reasoningEffort ? { reasoningEffort: meta.reasoningEffort } : {}),
      maxTokens: meta.maxTokens, ...(meta.timeoutMs ? { timeoutMs: meta.timeoutMs } : {}),
      callId: meta.callId, attemptId: meta.attemptId, attempt: meta.attempt,
      ...(meta.retryOf ? { retryOf: meta.retryOf } : {}),
      ...(meta.retryReason ? { retryReason: String(meta.retryReason).slice(0, 200) } : {}),
    },
  });
  let fault = null;
  const note = (e) => { if (!fault) fault = { code: e?.code || "EIO", message: String((e && e.message) || e) }; };
  const record = (obj) => { try { return journal.appendRecord(obj); } catch (e) { note(e); return null; } };
  return {
    relDir,
    // 请求快照：不捕获——失败必须让调用中止（清单 TASK-03 语义）
    request() { return journal.appendRecord({ kind: "request", at: nowIso(), ...request }); },
    delta(text) { try { journal.appendChunk(text); } catch (e) { note(e); } },
    event(fields) { record({ kind: "event", at: nowIso(), ...fields }); },
    response(text) { return record({ kind: "response", at: nowIso(), text }); },
    process(info) { record({ kind: "process", at: nowIso(), ...info }); },
    finish({ status, ms, error, extra }) {
      let integrity = null, problems = null;
      record({ kind: "finish", at: nowIso(), status, ms: Math.round(ms), ...(extra || {}) });
      const sealed = journal.seal({ status, ...(error ? { error } : {}) });
      integrity = sealed.integrity; problems = sealed.problems;
      return { integrity: fault ? "write_failed" : integrity, problems, fault };
    },
  };
}

export function makeLlm(ctx, hook, overridesOf, journalOf) {
  const takeOverrides = () => (typeof overridesOf === "function" ? overridesOf() : null) || {};
  async function complete({ system, user, maxTokens, signal,
    callId = newCallId(), attemptId = newAttemptId(), attempt = 1, retryOf = null, retryReason = null,
    postProcess = null } = {}) {
    const ov = takeOverrides();
    const route = resolveRoute(ctx, ov);
    // 显式入参优先于阶段配置（调用方明确意图 > 配置默认）；均缺省回落 8192。
    // TASK-06 截断预算重试靠显式入参提升预算并绕过阶段配置上限。
    const effMaxTokens = maxTokens > 0 ? Math.floor(maxTokens)
      : (Number(ov.maxTokens) > 0 ? Math.floor(ov.maxTokens) : 8192);
    const timeoutMs = ov.timeoutMs > 0 ? ov.timeoutMs : 0;
    const abortController = new AbortController();
    let detachCallerAbort = null;
    if (signal) {
      const forwardAbort = () => abortController.abort(signal.reason);
      if (signal.aborted) forwardAbort();
      else {
        signal.addEventListener("abort", forwardAbort, { once: true });
        detachCallerAbort = () => signal.removeEventListener("abort", forwardAbort);
      }
    }
    const t0 = Date.now();
    // 事件预览：prompt 头 + 响应头，截断防膨胀
    const preview = (s, n) => {
      const str = String(s == null ? "" : s).replace(/\s+/g, " ").trim();
      return str.length > n ? str.slice(0, n) + "…" : str;
    };
    // TASK-02：请求发送前持久化实际传入宿主的 system/user 与生效参数（不含
    // API Key、认证对象、请求头、环境变量等任何认证信息）。快照无法落盘 =
    // 留档故障，中止本次调用（请求不发出）。
    let log = null;
    try {
      log = openAttemptLog(journalOf, {
        provider: route.provider, model: route.model,
        ...(route.reasoningEffort ? { reasoningEffort: route.reasoningEffort } : {}),
        maxTokens: effMaxTokens, timeoutMs,
        callId, attemptId, attempt, retryOf, retryReason,
      }, { params: {
          provider: route.provider, model: route.model,
          ...(route.reasoningEffort ? { reasoningEffort: route.reasoningEffort } : {}),
          maxTokens: effMaxTokens, ...(timeoutMs > 0 ? { timeoutMs } : {}),
        }, system: String(system == null ? "" : system), user: String(user == null ? "" : user) });
      log?.request();
    } catch (e) {
      const error = new Error("留档故障，已中止本次 LLM 调用（请求未发出）: " + String((e && e.message) || e));
      error.code = "JOURNAL_FAULT"; error.cause = e;
      throw error;
    }
    // 开打即记「调用中」：LLM 单次调用可达分钟级，进行中就要在阶段详情可见
    hook?.({ kind: "llm", name: route.model + " · 调用中", ms: null, ok: true,
      callId, attemptId, attempt, ...(retryOf ? { retryOf } : {}),
      ...(retryReason ? { retryReason: String(retryReason).slice(0, 200) } : {}),
      ...(log ? { logDir: log.relDir } : {}),
      detail: `【prompt】${preview(user, 300)}` });
    let finishMeta = null;
    // 流式累积包成 Promise，外层与超时 race；超时时主动中断底层 stream。
    const streamP = (async () => {
      let text = "";
      for await (const chunk of ctx.llm.stream({
        provider: route.provider, model: route.model,
        // 路由若带 reasoningEffort 则一并传给 stream（GenerateOptions 支持该字段）
        ...(route.reasoningEffort ? { reasoningEffort: route.reasoningEffort } : {}),
        // dsh-llm 的 Message.content 是 ContentBlock[]（types/message.d.ts:126），字符串会触发适配器 content.some 异常
        system, messages: [{ role: "user", content: [{ type: "text", text: user }] }], maxTokens: effMaxTokens,
        signal: abortController.signal,
      })) {
        if (chunk.type === "text-delta") {
          text += chunk.text;
          log?.delta(chunk.text); // 响应过程持续落盘（有界缓冲）
        } else if (chunk.type === "finish") {
          // dsh-llm 的 finish reason 是对象（{kind,failure?}），同时兼容字符串
          const kind = typeof chunk.reason === "string" ? chunk.reason : chunk.reason?.kind;
          finishMeta = {
            rawFinishReason: chunk.reason ?? null,
            finishReason: normalizeFinishReason(chunk.reason),
            // usage 宿主暴露才有；未暴露明确标记，不推测
            usage: chunk.usage ?? "unavailable",
          };
          log?.event({ type: "finish", ...(chunk.reason !== undefined ? { reason: chunk.reason } : {}),
            ...(chunk.usage ? { usage: chunk.usage } : {}) });
          if (kind === "error" || kind === "aborted") {
            // failure 可能是对象，取最有信息量的字段；都没有就用 kind
            const detail = chunk.reason?.failure?.message || chunk.reason?.failure?.code || kind;
            throw llmError("llm_call_failed", "LLM 调用失败: " + detail, {
              llmCause: kind === "aborted" ? "cancelled" : "provider",
              provider: route.provider, model: route.model,
              finishReason: normalizeFinishReason(chunk.reason),
            });
          }
        } else {
          log?.event({ type: String(chunk.type || "unknown"), ...scalarFields(chunk) });
        }
      }
      if (!text.trim()) {
        throw llmError("llm_call_failed", "LLM 返回为空", {
          llmCause: "empty", provider: route.provider, model: route.model,
          finishReason: finishMeta?.finishReason || "unavailable",
        });
      }
      return text;
    })();
    let timer = null;
    const timeoutP = timeoutMs > 0
      ? new Promise((_, reject) => {
        timer = setTimeout(() => {
          const error = llmError("llm_call_failed",
            `LLM 调用超时（${timeoutMs}ms，可在「配置」页调整该阶段的超时时间）`,
            { llmCause: "timeout", provider: route.provider, model: route.model, timeoutMs });
          abortController.abort(error);
          reject(error);
        }, timeoutMs);
      })
      : null;
    try {
      const text = await (timeoutP ? Promise.race([streamP, timeoutP]) : streamP);
      // 固定顺序（TASK-04）：1) 保存响应正文与结束元数据
      const respRef = log?.response(text) || null;
      // 2) 判断输出截断：明确的 token/length/incomplete 结束原因优先于 JSON 处理，
      //    即使文本碰巧可解析也不当作完整成功结果
      if (TRUNCATION_RE.test(String(finishMeta?.finishReason || ""))) {
        const truncated = llmError("output_truncated",
          `输出被截断（finish reason: ${finishMeta.finishReason}），结果不完整，不能当作成功输出`,
          { finishReason: finishMeta.finishReason, provider: route.provider, model: route.model, textChars: text.length });
        log?.process({ step: "truncation-check", ok: false, errorCode: "output_truncated",
          ...(respRef ? { inputRef: respRef } : {}) });
        throw truncated;
      }
      log?.process({ step: "truncation-check", ok: true });
      let result = text;
      if (postProcess) {
        try {
          result = postProcess(text);
          log?.process({ step: "post-process", ok: true, ...(respRef ? { inputRef: respRef } : {}) });
        } catch (e) {
          log?.process({ step: "post-process", ok: false,
            error: String((e && e.message) || e), ...(e?.code ? { errorCode: e.code } : {}),
            ...(respRef ? { inputRef: respRef } : {}) });
          throw e; // 外层统一封存失败状态
        }
      }
      const fin = log?.finish({ status: "completed", ms: Date.now() - t0,
        extra: { ...(finishMeta || { rawFinishReason: null, finishReason: "unavailable", usage: "unavailable" }), textChars: text.length } });
      hook?.({ kind: "llm", name: route.model + " · 完成", ms: Date.now() - t0, ok: true,
        callId, attemptId, attempt,
        ...(log ? { logDir: log.relDir } : {}), ...(fin?.integrity ? { logIntegrity: fin.integrity } : {}),
        detail: `prompt ${String(user || "").length} 字 → 响应 ${text.length} 字\n【prompt】${preview(user, 300)}\n——\n【响应】${preview(text, 500)}` });
      return result;
    } catch (rawError) {
      // 未分类失败（流迭代异常、适配器错误、调用方取消等）统一归 llm_call_failed，
      // 保留原始 cause；已分类错误（含 JOURNAL_FAULT 与五类稳定类别）原样透传
      const e = rawError?.code ? rawError : llmError("llm_call_failed",
        "LLM 调用失败: " + String((rawError && rawError.message) || rawError), {
          llmCause: abortController.signal.aborted ? "cancelled" : "unknown",
          provider: route.provider, model: route.model,
          finishReason: finishMeta?.finishReason || "unavailable",
        });
      if (e !== rawError) e.cause = rawError;
      // TASK-07：错误对象带上调用与留档身份（pipeline 层据此构造结构化错误贯通 run.json）
      if (e && typeof e === "object") {
        e.callId = callId;
        e.attemptId = attemptId;
        if (log && !e.logDir) e.logDir = log.relDir;
      }
      // 请求已发出：留档只做收尾（如实标记失败/留档故障），不吞原始业务异常
      const fin = log?.finish({ status: "failed", ms: Date.now() - t0, error: e,
        extra: finishMeta || { rawFinishReason: null, finishReason: "unavailable", usage: "unavailable" } });
      // TASK-10：错误对象携带留档完整性（P10/UI 据此区分「留档不完整」，不伪装成完整留档）
      if (fin && typeof e === "object" && fin.integrity && !e.logIntegrity) e.logIntegrity = fin.integrity;
      hook?.({ kind: "llm", name: route.model + " · 失败", ms: Date.now() - t0, ok: false,
        callId, attemptId, attempt,
        ...(log ? { logDir: log.relDir } : {}), ...(fin?.integrity ? { logIntegrity: fin.integrity } : {}),
        detail: `prompt ${String(user || "").length} 字\n【prompt】${preview(user, 300)}\n——\n【错误】${String((e && e.message) || e)}` });
      throw e;
    } finally {
      if (timer) clearTimeout(timer);
      if (detachCallerAbort) detachCallerAbort();
    }
  }

  // 流式单次调用（悬浮智能助手用）：messages 为简化形态 [{role, text}]，
  // 内部转 ContentBlock 数组；每个 text-delta 回调 onDelta，返回完整文本。
  // 路由解析与 finish 错误判定与 complete 一致，但不带超时 race 与事件钩子，
  // 也不留档（助手调用不属于任何 Run，不写 trace/；中断由调用方 signal 控制）
  async function streamText({ system, messages = [], maxTokens = 8192, signal, onDelta } = {}) {
    const route = resolveRoute(ctx, takeOverrides());
    let text = "";
    for await (const chunk of ctx.llm.stream({
      provider: route.provider, model: route.model,
      ...(route.reasoningEffort ? { reasoningEffort: route.reasoningEffort } : {}),
      system,
      messages: messages.map(({ role, text: t }) => ({ role, content: [{ type: "text", text: String(t || "") }] })),
      maxTokens, signal,
    })) {
      if (chunk.type === "text-delta") {
        text += chunk.text;
        if (typeof onDelta === "function") onDelta(chunk.text);
      }
      if (chunk.type === "finish") {
        const kind = typeof chunk.reason === "string" ? chunk.reason : chunk.reason?.kind;
        if (kind === "error" || kind === "aborted") {
          const detail = chunk.reason?.failure?.message || chunk.reason?.failure?.code || kind;
          throw new Error("LLM 调用失败: " + detail);
        }
      }
    }
    if (!text.trim()) throw new Error("LLM 返回为空");
    return text;
  }

  // TASK-06：有限重试。一次逻辑调用最多 2 次真实模型请求，所有错误分支共用总上限：
  //   - 首次失败为 JSON/schema 格式错误 → 唯一一次「格式修复」重试：独立修复指令，
  //     只携带目标 schema、具体错误与上次原始输出，不再次发送原业务长 prompt；
  //   - 首次失败为输出截断 → 在 TRUNC_RETRY_TOKEN_CEILING 硬上限内提高一次输出
  //     预算后重发原业务请求（截断不是格式问题，仍需完整业务上下文），预算变化
  //     记入 retryReason 与留档 params.maxTokens；
  //   - timeout / provider 服务错误 / 调用失败 / 取消等不重试；有效业务 fail 是
  //     合法结论（枚举内），不进入重试路径；
  //   - 第二次请求仍失败 → 保持失败不补造，最终错误携带完整 retryHistory。
  async function completeJson({ system, user, required = [], schema = null, maxTokens, signal } = {}) {
    const callId = newCallId();
    const retryHistory = [];
    let lastRawText = "";
    const withHistory = (e) => {
      e.retryHistory = retryHistory;
      return e;
    };
    // 处理步骤在 complete 内留档（process 记录 + 原文引用 inputRef）；
    // gate 先捕获原始文本供格式修复重试引用
    const gate = (text) => {
      lastRawText = text;
      let obj;
      try { obj = extractJson(text); }
      catch (e) { throw llmError("json_parse_failed", e.message); }
      if (typeof obj !== "object" || obj === null || Array.isArray(obj)) throw llmError("schema_validation_failed", "契约解析失败: 输出不是 JSON 对象");
      const missing = required.filter((k) => !(k in obj));
      if (missing.length) throw llmError("schema_validation_failed", "契约解析失败: 缺字段 " + missing.join(","));
      if (schema) {
        const problems = validateSchema(obj, schema);
        if (problems.length) throw llmError("schema_validation_failed", "契约解析失败: " + problems.join("；"));
      }
      return obj;
    };

    const attempt1Id = newAttemptId();
    try {
      return await complete({ system, user, maxTokens, signal, callId, attemptId: attempt1Id, attempt: 1, postProcess: gate });
    } catch (first) {
      retryHistory.push({ attempt: 1, attemptId: attempt1Id, code: first?.code || null,
        message: String(first?.message || first).slice(0, 500),
        ...(first?.finishReason ? { finishReason: first.finishReason } : {}) });
      const attempt2Id = newAttemptId();
      const note = (reason) => ({ attempt: 2, attemptId: attempt2Id, code: null, retryKind: reason });
      if (first?.code === "output_truncated") {
        // 截断 → 预算提升重试（唯一一次）：重发原业务 prompt，预算翻倍但不超过硬上限
        const ov = takeOverrides();
        const firstBudget = Number(ov?.maxTokens) > 0 ? Math.floor(ov.maxTokens)
          : (maxTokens > 0 ? Math.floor(maxTokens) : 8192);
        const retryBudget = Math.min(TRUNC_RETRY_TOKEN_CEILING, firstBudget * 2);
        if (retryBudget <= firstBudget) throw withHistory(first); // 已在上限，无法提升
        retryHistory.push(note("budget_raise"));
        try {
          return await complete({ system, user, maxTokens: retryBudget, signal, callId, attemptId: attempt2Id, attempt: 2,
            retryOf: attempt1Id, postProcess: gate,
            retryReason: `输出截断（${first.finishReason}），输出预算 ${firstBudget} → ${retryBudget} 后重试` });
        } catch (second) {
          retryHistory[1].code = second?.code || null;
          retryHistory[1].message = String(second?.message || second).slice(0, 500);
          throw withHistory(second);
        }
      }
      if (first?.code !== "json_parse_failed" && first?.code !== "schema_validation_failed") throw first;
      // 格式修复重试（唯一一次）：独立修复指令，不携带原业务长 prompt
      retryHistory.push(note("format_repair"));
      const repairSystem = "你是 JSON 输出修复器。修正给定模型输出的格式问题，只输出一个合法 JSON 对象，不输出任何其他文字、解释或代码围栏。";
      const repairUser = [
        "【目标输出 schema】",
        JSON.stringify(schema || { type: "object", required }, null, 2),
        "",
        "【上次输出存在的具体问题】",
        String(first.message),
        "",
        "【上次原始输出】",
        lastRawText,
        "",
        "【要求】在保留原有语义信息的前提下修正上述问题，只输出符合 schema 的合法 JSON 对象。",
      ].join("\n");
      try {
        return await complete({ system: repairSystem, user: repairUser, signal, callId, attemptId: attempt2Id, attempt: 2,
          retryOf: attempt1Id, retryReason: String(first.message).slice(0, 200), postProcess: gate });
      } catch (second) {
        retryHistory[1].code = second?.code || null;
        retryHistory[1].message = String(second?.message || second).slice(0, 500);
        throw withHistory(second);
      }
    }
  }

  return { complete, completeJson, streamText };
}
