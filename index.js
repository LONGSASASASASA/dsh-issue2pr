/**
 * dsh-issue2pr — node 半：REST API + 流水线状态机（随 dsh web 同生共死）。
 * 本任务仅含骨架：/issue2pr/api/ping。后续任务在 handleApi 内扩展路由。
 */
export const name = "dsh-issue2pr";
export const inject = ["webServer"];

export function sendJson(res, code, obj) {
  const data = Buffer.from(JSON.stringify(obj), "utf8");
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Content-Length": data.length });
  res.end(data);
}

export function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); } catch (e) { reject(e); } });
    req.on("error", reject);
  });
}

async function handleApi(req, res) {
  const url = new URL(req.url, "http://localhost");
  try {
    if (req.method === "GET" && url.pathname === "/issue2pr/api/ping") {
      return sendJson(res, 200, { ok: true, plugin: "dsh-issue2pr" });
    }
    sendJson(res, 404, { ok: false, message: "not found" });
  } catch (e) {
    sendJson(res, 500, { ok: false, message: "出错: " + String((e && e.message) || e) });
  }
}

export function apply(ctx) {
  ctx.effect(() => ctx.webServer.register({ kind: "prefix", path: "/issue2pr", handler: handleApi }), "issue2pr: api routes");
  ctx.logger?.info?.("issue2pr: API ready at /issue2pr/api/*");
}