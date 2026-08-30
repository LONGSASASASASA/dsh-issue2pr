// tests/e2e-live.mjs — 端到端实测（直接打 3080 端口真实宿主，不入 npm test）
// 验证：① 删除项目 ② 停止/删除 Run 即时落盘 ③ trace/events.jsonl 过程事件
import { mkdtempSync, writeFileSync, existsSync, readFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";

const API = "http://127.0.0.1:3080/issue2pr/api";
const j = (r) => r.json();
const post = (p, b) => fetch(API + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b || {}) }).then(j);
const get = (p) => fetch(API + p).then(j);
const del = (p) => fetch(API + p, { method: "DELETE" }).then(j);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const tmp = mkdtempSync(join(tmpdir(), "i2p-e2e-"));
// 本地裸仓库当 clone 源（不依赖外网）
const src = join(tmp, "src.git");
mkdirSync(src);
await new Promise((res, rej) => execFile("git", ["init", "--bare", "-q", src], {}, (e) => (e ? rej(e) : res())));
const issue = join(tmp, "issue.md");
writeFileSync(issue, "# 测试 Issue\n\n修复登录页在深色模式下的对比度问题。");

const results = [];
const check = (name, ok, detail) => { results.push([ok ? "PASS" : "FAIL", name, detail || ""]); console.log((ok ? "  ✔ " : "  ✖ ") + name + (detail ? " — " + detail : "")); };

const slug = "e2e-" + Date.now();
console.log("=== 1. 建项目（slug=" + slug + "）===");
let r = await post("/projects", {
  name: "端到端", slug, repos: [{ uri: src }], triggers: [{ kind: "issue", uri: issue }],
  reviewMode: "every", p6Mode: "builtin", testCommand: "",
});
check("POST /projects", r.ok === true, r.message || "");

console.log("=== 2. 发起 Run ===");
r = await post(`/projects/${slug}/runs`, { kind: "issue", uri: issue });
check("POST /runs", r.ok === true, r.message || "");
const runId = r.runId;

// 等 drive 起步：clone + P1 LLM 调用进行中
let run = null;
for (let i = 0; i < 40; i++) {
  await sleep(500);
  run = await get(`/projects/${slug}/runs/${runId}`);
  if (run.id && (run.status === "running" || run.status === "awaiting_review" || run.status === "failed")) break;
}
check("run 进入活跃状态", run && run.id === runId && ["running", "awaiting_review", "failed"].includes(run.status), "status=" + (run && run.status));

// 多等 4s 让 P1 的 LLM 调用进入飞行状态，验证「调用中」事件已可见
await sleep(4000);

console.log("=== 3. 停止 Run（验证即时落盘）===");
const t0 = Date.now();
r = await post(`/projects/${slug}/runs/${runId}/stop`, {});
const stopMs = Date.now() - t0;
check("POST /stop 响应 ok", r.ok === true, r.message + "（" + stopMs + "ms）");
run = await get(`/projects/${slug}/runs/${runId}`);
check("停止后立即 GET = stopped", run.status === "stopped" || run.status === "awaiting_review" === false && run.status === "stopped", "status=" + run.status);
// 等待可能飞行中的执行器结束，确认不被复活
await sleep(2500);
run = await get(`/projects/${slug}/runs/${runId}`);
check("2.5s 后仍为 stopped（无复活）", run.status === "stopped", "status=" + run.status);

console.log("=== 4. trace/events.jsonl 过程事件 ===");
r = await get(`/projects/${slug}/runs/${runId}/tree`);
const trace = (r.files || []).find((f) => f.path === "trace/events.jsonl");
if (trace) {
  r = await get(`/projects/${slug}/runs/${runId}/artifact?path=${encodeURIComponent("trace/events.jsonl")}`);
  const evs = String(r.text).split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const kinds = [...new Set(evs.map((e) => e.kind))];
  check("事件已写入", evs.length > 0, evs.length + " 条，kind=" + kinds.join("/"));
  const inFlight = evs.find((e) => e.kind === "llm" && /调用中/.test(e.name));
  check("LLM 调用进行中即可见（『调用中』事件）", !!inFlight, inFlight ? inFlight.name : "未捕获（LLM 可能已快速完成）");
  console.log("    事件样例:");
  evs.slice(-6).forEach((e) => console.log("    · [" + e.kind + "] " + (e.stage || "?") + " " + e.name.slice(0, 50)));
} else {
  check("事件文件存在", false, "trace/events.jsonl 不在产物树中");
}

console.log("=== 5. 删除 Run ===");
r = await del(`/projects/${slug}/runs/${runId}`);
check("DELETE run", r.ok === true, r.message || "");
const runDir = join(process.env.USERPROFILE || "", ".dsh", "issue2pr", "projects", slug, "runs", runId);
check("run 目录已移除", !existsSync(runDir));
r = await get(`/projects/${slug}/runs/${runId}`);
check("GET run → 404", r.ok === false);

console.log("=== 6. 删除项目 ===");
r = await del(`/projects/${slug}?confirm=${slug}`);
check("DELETE project", r.ok === true, r.message || "");
const projDir = join(process.env.USERPROFILE || "", ".dsh", "issue2pr", "projects", slug);
check("项目目录已移除（含 repo 克隆）", !existsSync(projDir));
r = await get("/projects");
check("项目列表无残留", !(r.projects || []).some((p) => p.slug === slug));

rmSync(tmp, { recursive: true, force: true });
const fails = results.filter((x) => x[0] === "FAIL");
console.log("\n==== 结果: " + (results.length - fails.length) + "/" + results.length + " 通过 ====");
process.exit(fails.length ? 1 : 0);
