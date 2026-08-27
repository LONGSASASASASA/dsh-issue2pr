// lib/llm.js — ctx.llm.stream 封装 + JSON 契约解析（重试一次）
const DEFAULT_ROUTE = { provider: "deepseek-official", model: "deepseek-v4-pro" };

function resolveRoute(ctx) {
  try {
    const cfg = typeof ctx.getConfig === "function" ? ctx.getConfig("agent-default-model") : undefined;
    if (cfg && cfg.provider && cfg.model) return { provider: cfg.provider, model: cfg.model };
  } catch {}
  return DEFAULT_ROUTE;
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

export function makeLlm(ctx) {
  async function complete({ system, user, maxTokens = 8192, signal } = {}) {
    const route = resolveRoute(ctx);
    let text = "";
    for await (const chunk of ctx.llm.stream({
      provider: route.provider, model: route.model,
      system, messages: [{ role: "user", content: user }], maxTokens, signal,
    })) {
      if (chunk.type === "text-delta") text += chunk.text;
      if (chunk.type === "finish" && chunk.reason === "error") throw new Error("LLM 调用失败");
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

  return { complete, completeJson };
}