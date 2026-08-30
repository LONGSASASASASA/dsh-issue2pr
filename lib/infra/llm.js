// lib/llm.js — ctx.llm.stream 封装 + JSON 契约解析（重试一次）
// makeLlm(ctx, hook, overridesOf)：overridesOf() 返回当前阶段的覆盖配置
// （provider/model/reasoningEffort/timeoutMs/maxTokens，来自 project.stageConfig），
// 每次调用时现取，阶段推进/配置修改即时生效。
const DEFAULT_ROUTE = { provider: "deepseek-official", model: "deepseek-v4-pro" };

// 路由解析 + 来源标注（source：stage=阶段覆盖 / host=宿主默认 / plugin=插件配置 / default=插件兜底）。
// preflight 端点用它把「当前默认模型从哪来」台面化。
export function routeInfo(ctx, ov) {
  // 0) 阶段级覆盖最高优先（配置页按阶段指定模型）
  if (ov && ov.provider && ov.model) {
    const route = { provider: ov.provider, model: ov.model };
    if (ov.reasoningEffort) route.reasoningEffort = ov.reasoningEffort;
    return { route, source: "stage" };
  }
  // 1) 首选宿主 agentDefaultModel 服务（真实生效的默认路由），服务可能不存在，需 try/catch
  try {
    const sel = ctx.agentDefaultModel && typeof ctx.agentDefaultModel.currentSelection === "function"
      ? ctx.agentDefaultModel.currentSelection() : undefined;
    if (sel && sel.provider && sel.model) {
      const route = { provider: sel.provider, model: sel.model };
      if (sel.reasoningEffort) route.reasoningEffort = sel.reasoningEffort; // GenerateOptions 支持该字段
      return { route, source: "host" };
    }
  } catch {}
  // 2) 次级回退：插件配置 agent-default-model（向后兼容既有测试）
  try {
    const cfg = typeof ctx.getConfig === "function" ? ctx.getConfig("agent-default-model") : undefined;
    if (cfg && cfg.provider && cfg.model) return { route: { provider: cfg.provider, model: cfg.model }, source: "plugin" };
  } catch {}
  // 3) 最终兜底
  return { route: DEFAULT_ROUTE, source: "default" };
}

function resolveRoute(ctx, ov) {
  return routeInfo(ctx, ov).route;
}

export function extractJson(text) {
  const fenced = String(text).match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : (() => {
    const s = String(text);
    const i = s.indexOf("{"), j = s.lastIndexOf("}");
    if (i === -1 || j <= i) throw new Error("契约解析失败: 输出不含 JSON 对象");
    return s.slice(i, j + 1);
  })();
  try { return JSON.parse(candidate); }
  catch (e) { throw new Error("契约解析失败: " + e.message); }
}

export function makeLlm(ctx, hook, overridesOf) {
  const takeOverrides = () => (typeof overridesOf === "function" ? overridesOf() : null) || {};
  async function complete({ system, user, maxTokens = 8192, signal } = {}) {
    const ov = takeOverrides();
    const route = resolveRoute(ctx, ov);
    const effMaxTokens = ov.maxTokens > 0 ? Math.floor(ov.maxTokens) : maxTokens;
    const timeoutMs = ov.timeoutMs > 0 ? ov.timeoutMs : 0;
    const t0 = Date.now();
    // 事件预览：prompt 头 + 响应头，截断防膨胀
    const preview = (s, n) => {
      const str = String(s == null ? "" : s).replace(/\s+/g, " ").trim();
      return str.length > n ? str.slice(0, n) + "…" : str;
    };
    // 开打即记「调用中」：LLM 单次调用可达分钟级，进行中就要在阶段详情可见
    hook?.({ kind: "llm", name: route.model + " · 调用中", ms: null, ok: true,
      detail: `【prompt】${preview(user, 300)}` });
    // 流式累积包成 Promise，外层与超时 race（宿主 stream 的 signal 中断不可依赖，
    // 超时直接拒绝，让阶段失败可感知可重试，而不是无限挂起）
    const streamP = (async () => {
      let text = "";
      for await (const chunk of ctx.llm.stream({
        provider: route.provider, model: route.model,
        // 路由若带 reasoningEffort 则一并传给 stream（GenerateOptions 支持该字段）
        ...(route.reasoningEffort ? { reasoningEffort: route.reasoningEffort } : {}),
        // dsh-llm 的 Message.content 是 ContentBlock[]（types/message.d.ts:126），字符串会触发适配器 content.some 异常
        system, messages: [{ role: "user", content: [{ type: "text", text: user }] }], maxTokens: effMaxTokens, signal,
      })) {
        if (chunk.type === "text-delta") text += chunk.text;
        if (chunk.type === "finish") {
          // dsh-llm 的 finish reason 是对象（{kind,failure?}），同时兼容字符串
          const kind = typeof chunk.reason === "string" ? chunk.reason : chunk.reason?.kind;
          if (kind === "error" || kind === "aborted") {
            // failure 可能是对象，取最有信息量的字段；都没有就用 kind
            const detail = chunk.reason?.failure?.message || chunk.reason?.failure?.code || kind;
            throw new Error("LLM 调用失败: " + detail);
          }
        }
      }
      if (!text.trim()) throw new Error("LLM 返回为空");
      return text;
    })();
    let timer = null;
    const timeoutP = timeoutMs > 0
      ? new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`LLM 调用超时（${timeoutMs}ms，可在「配置」页调整该阶段的超时时间）`)), timeoutMs);
      })
      : null;
    try {
      const text = await (timeoutP ? Promise.race([streamP, timeoutP]) : streamP);
      hook?.({ kind: "llm", name: route.model + " · 完成", ms: Date.now() - t0, ok: true,
        detail: `prompt ${String(user || "").length} 字 → 响应 ${text.length} 字\n【prompt】${preview(user, 300)}\n——\n【响应】${preview(text, 500)}` });
      return text;
    } catch (e) {
      hook?.({ kind: "llm", name: route.model + " · 失败", ms: Date.now() - t0, ok: false,
        detail: `prompt ${String(user || "").length} 字\n【prompt】${preview(user, 300)}\n——\n【错误】${String((e && e.message) || e)}` });
      throw e;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  // 流式单次调用（悬浮智能助手用）：messages 为简化形态 [{role, text}]，
  // 内部转 ContentBlock 数组；每个 text-delta 回调 onDelta，返回完整文本。
  // 路由解析与 finish 错误判定与 complete 一致，但不带超时 race 与事件钩子
  // （助手调用不属于任何 Run，不写 events.jsonl；中断由调用方 signal 控制）
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

  async function completeJson({ system, user, required = [], maxTokens, signal } = {}) {
    let lastErr = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      const prompt = attempt === 0 ? user
        : user + `\n\n【上次输出无法解析：${lastErr}。请只输出一个合法 JSON 对象，不要输出任何其他文字。】`;
      try {
        const out = extractJson(await complete({ system, user: prompt, maxTokens, signal }));
        if (typeof out !== "object" || out === null || Array.isArray(out)) throw new Error("契约解析失败: 输出不是 JSON 对象");
        const missing = required.filter((k) => !(k in out));
        if (missing.length) throw new Error("契约解析失败: 缺字段 " + missing.join(","));
        return out;
      } catch (e) { lastErr = (e && e.message) || String(e); }
    }
    throw new Error(lastErr);
  }

  return { complete, completeJson, streamText };
}
