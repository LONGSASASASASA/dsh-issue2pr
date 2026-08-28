/**
 * dsh-issue2pr — node 半：REST API + 驱动循环（随 dsh web 同生共死）。
 * 路由与 spec §7 对齐：projects / runs（嵌套）/ review / rollback / tree / artifact。
 * 数据读写一律走 lib/store.js 与 lib/pipeline.js，不重复造轮子。
 */
import { join } from "node:path";
import { existsSync, readdirSync } from "node:fs";
import {
  defaultDataRoot, saveProject, loadProject, listProjects,
  createRun, runDirOf, readArtifact, listRunTree,
} from "./lib/store.js";
import { initRun, saveRun, loadRun, advance, applyReview, STAGES } from "./lib/pipeline.js";
import { makeLlm } from "./lib/llm.js";
import { buildExecutors } from "./lib/stages/index.js";
import { rollbackLedger } from "./lib/stages/p7-patch.js";
import { readTriggerText } from "./lib/stages/helpers.js";

export const name = "dsh-issue2pr";
export const inject = ["webServer"];

// —— 测试注入（仅本插件测试用）：覆盖内部默认值 dataRoot / executors ——
let __testHooks = null;
export function __setTestHooks(hooks) { __testHooks = hooks || null; }

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

// —— 执行器解析：测试注入缺省 = 立即 approved 的空执行器；生产走 buildExecutors() ——
function executorsOf() {
  if (__testHooks && __testHooks.executors) {
    const map = {};
    for (const s of STAGES) map[s.id] = __testHooks.executors[s.id] || (async () => ({}));
    return map;
  }
  return buildExecutors();
}

// —— rcx 组装（简报指定形态）；project 每次刷新，保证读取最新配置 ——
function buildRcx(ctx, root, runDir, run) {
  return {
    runDir, run,
    project: loadProject(root, run.project),
    repoDir: join(root, "projects", run.project, "repo"),
    trigger: run.trigger,
    llm: makeLlm(ctx),
    p6Mode: run.p6Mode,
    executors: executorsOf(),
    log() {},
  };
}

// —— 单 run 一把锁防并发；rcx 跨 drive/review 共享（打回意见 reviewComment 跨循环传递） ——
const runSessions = new Map();

function sessionFor(runDir) {
  if (!runSessions.has(runDir)) runSessions.set(runDir, { lock: Promise.resolve(), rcx: null });
  return runSessions.get(runDir);
}

// 推进循环：仅 run.status==="running" 时调用 advance（awaiting_review 停手等 applyReview）；
// 阶段失败自动调 P10 executor 写分类产物后停（v1：不自动 replan）。
function drive(ctx, root, runDir) {
  const s = sessionFor(runDir);
  const task = s.lock.then(async () => {
    for (;;) {
      const run = loadRun(runDir);
      if (!run || run.status !== "running") return;
      const rcx = s.rcx || (s.rcx = buildRcx(ctx, root, runDir, run));
      rcx.run = run; // 刷新为最新落盘状态（reviewComment 保留在 rcx 上）
      await advance(rcx);
      if (run.status === "failed") {
        try {
          await rcx.executors.P10({ ...rcx, failure: { stage: run.current, error: run.stages[run.current]?.error } });
        } catch { /* P10 自身失败不阻断主流程 */ }
        return;
      }
    }
  });
  s.lock = task.then(() => {}, () => {}); // 失败不污染锁链
  return s.lock;
}

async function handleApi(ctx, root, req, res) {
  const url = new URL(req.url, "http://localhost");
  const parts = url.pathname.split("/").filter(Boolean);
  const m = req.method;
  try {
    if (m === "GET" && parts.join("/") === "issue2pr/api/ping") {
      return sendJson(res, 200, { ok: true, plugin: "dsh-issue2pr" });
    }
    if (parts[0] !== "issue2pr" || parts[1] !== "api" || parts[2] !== "projects") {
      return sendJson(res, 404, { ok: false, message: "not found" });
    }
    const slug = parts[3];
    const p = parts[4];

    // —— /issue2pr/api/projects（集合，无 slug） ——
    if (!slug) {
      if (m === "GET") return sendJson(res, 200, { ok: true, projects: listProjects(root) });
      if (m === "POST") {
        const body = await readBody(req);
        try { saveProject(root, body); }
        catch (e) { return sendJson(res, 400, { ok: false, message: (e && e.message) || String(e) }); }
        return sendJson(res, 200, { ok: true, project: body });
      }
      return sendJson(res, 404, { ok: false, message: "not found" });
    }
    if (!/^[a-z0-9-]+$/.test(slug)) return sendJson(res, 400, { ok: false, message: "非法 slug" });

    const project = loadProject(root, slug);
    const runsDir = join(root, "projects", slug, "runs");

    // —— /issue2pr/api/projects/:slug/runs（集合） ——
    if (p === "runs" && !parts[5]) {
      if (m === "GET") {
        // 扫 runs/*/run.json，出摘要
        const runs = existsSync(runsDir)
          ? readdirSync(runsDir).map((id) => {
              const r = loadRun(join(runsDir, id));
              return r ? { id: r.id, status: r.status, current: r.current, trigger: r.trigger, createdAt: r.createdAt } : null;
            }).filter(Boolean).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
          : [];
        return sendJson(res, 200, { ok: true, runs });
      }
      if (m === "POST") {
        if (!project) return sendJson(res, 404, { ok: false, message: "项目不存在" });
        const body = await readBody(req);
        const { kind, uri } = body || {};
        if ((kind !== "issue" && kind !== "requirement") || typeof uri !== "string" || !uri.trim()) {
          return sendJson(res, 400, { ok: false, message: "kind 仅允许 issue|requirement 且 uri 必填" });
        }
        const trigger = { kind, uri };
        let text;
        try { text = await readTriggerText({ trigger }); } // 读触发文本
        catch (e) { return sendJson(res, 400, { ok: false, message: (e && e.message) || String(e) }); }
        let created;
        try { created = createRun(root, slug, trigger); } // 同秒同触发源重复发起 → Run 已存在 → 409
        catch (e) { return sendJson(res, 409, { ok: false, message: (e && e.message) || String(e) }); }
        const { runId, runDir } = created;
        const run = initRun({ runId, slug, trigger: { ...trigger, text }, reviewMode: project.reviewMode, p6Mode: project.p6Mode });
        run.status = "running"; // 发起即进入运行态（drive 只在 running 时推进）
        saveRun(runDir, run);
        sendJson(res, 200, { ok: true, runId });
        setImmediate(() => drive(ctx, root, runDir)); // 同步返回后异步推进
        return;
      }
      return sendJson(res, 404, { ok: false, message: "not found" });
    }

    // —— /issue2pr/api/projects/:slug/runs/:runId[/action] ——
    if (p === "runs" && parts[5]) {
      const runId = parts[5];
      let runDir;
      try { runDir = runDirOf(root, slug, runId); }
      catch (e) { return sendJson(res, 400, { ok: false, message: (e && e.message) || String(e) }); }
      const action = parts[6];

      if (!action && m === "GET") {
        const run = loadRun(runDir);
        if (!run) return sendJson(res, 404, { ok: false, message: "run 不存在" });
        return sendJson(res, 200, run); // 直接吐 run.json
      }

      if (action === "review" && m === "POST") {
        const run = loadRun(runDir);
        if (!run) return sendJson(res, 404, { ok: false, message: "run 不存在" });
        const s = sessionFor(runDir);
        const rcx = s.rcx || (s.rcx = buildRcx(ctx, root, runDir, run));
        rcx.run = run;
        const body = await readBody(req);
        const [ok, msg] = applyReview(rcx, { decision: body?.decision, comment: body?.comment });
        if (!ok) return sendJson(res, 400, { ok: false, message: msg });
        sendJson(res, 200, { ok: true, message: msg });
        if (run.status === "running") setImmediate(() => drive(ctx, root, runDir)); // approve/reject 后继续推进
        return;
      }

      if (action === "rollback" && m === "POST") {
        const body = await readBody(req);
        const lineNo = Number(body?.lineNo);
        if (!Number.isInteger(lineNo) || lineNo < 0) return sendJson(res, 400, { ok: false, message: "lineNo 必须是合法行号" });
        try {
          rollbackLedger(runDir, join(root, "projects", slug, "repo"), lineNo);
        } catch (e) { return sendJson(res, 400, { ok: false, message: "回滚失败: " + String((e && e.message) || e) }); }
        return sendJson(res, 200, { ok: true });
      }

      if (action === "tree" && m === "GET") {
        if (!existsSync(runDir)) return sendJson(res, 404, { ok: false, message: "run 不存在" });
        return sendJson(res, 200, { ok: true, files: listRunTree(runDir) });
      }

      if (action === "artifact" && m === "GET") {
        const rel = url.searchParams.get("path") || "";
        let text;
        try { text = readArtifact(runDir, rel); } // safeJoin 防 ..
        catch (e) { return sendJson(res, 400, { ok: false, message: (e && e.message) || String(e) }); }
        if (text == null) return sendJson(res, 404, { ok: false, message: "产物不存在: " + rel });
        if (Buffer.byteLength(text, "utf8") > 200 * 1024) return sendJson(res, 400, { ok: false, message: "文件超过 200KB 上限" });
        return sendJson(res, 200, { ok: true, text });
      }

      return sendJson(res, 404, { ok: false, message: "not found" });
    }

    sendJson(res, 404, { ok: false, message: "not found" });
  } catch (e) {
    sendJson(res, 500, { ok: false, message: "出错: " + String((e && e.message) || e) });
  }
}

export function apply(ctx) {
  const root = __testHooks?.dataRoot || ctx.getConfig?.("issue2pr")?.dataRoot || defaultDataRoot();
  ctx.effect(() => ctx.webServer.register({
    kind: "prefix", path: "/issue2pr", handler: (req, res) => handleApi(ctx, root, req, res),
  }), "issue2pr: api routes");
  ctx.logger?.info?.(`issue2pr: API ready at /issue2pr/api/projects/* (dataRoot=${root})`);
}