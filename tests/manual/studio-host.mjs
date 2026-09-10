// 受控 UI 联调：借用运行中的 DSH 前端，插件 API 使用隔离目录和确定性执行器。
// node tests/manual/studio-host.mjs [DSH URL] [端口]
// 不启动模型，不读写业务任务；浏览器打开输出地址。结束后 Ctrl+C。
import http from "node:http";
import net from "node:net";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { apply, __setTestHooks } from "../../index.js";
import { defaultSettings, saveSettings, saveProject, writeArtifact, runDirOf } from "../../lib/core/store.js";
import { STAGES, initRun, saveRun } from "../../lib/core/pipeline.js";

const upstream = new URL(process.argv[2] || "http://127.0.0.1:3080");
if (upstream.protocol !== "http:" || !["localhost", "127.0.0.1"].includes(upstream.hostname)) throw new Error("仅支持本机 HTTP DSH");
// Keep QA writes outside the linked plugin tree so host source watchers cannot reload the page on ui-state writes.
const root = mkdtempSync(join(tmpdir(), "issue2pr-studio-qa-"));
const issue = join(root, "ui-check.md"); writeFileSync(issue, "# 受控 UI 验证\n检查配置、复核、文件与任务切换。");
saveSettings(root, { ...defaultSettings(), reviewMode: "every" });
for (const slug of ["ui-alpha", "ui-beta"]) saveProject(root, { name: slug === "ui-alpha" ? "UI 验证项目 A" : "UI 验证项目 B", slug, repos: ["https://example.test/" + slug + ".git"], triggers: [{ kind: "issue", uri: issue }], reviewMode: "auto", p6Mode: "session" });
// Seed only the isolated QA store. These records exercise layout and interactions without running a model.
const seedFiles = {
  "01-issue-analysis.json": { phenomenon: "受控样例：长标题任务在窄窗口中需要保持可读", trigger: "切换任务或调整窗口宽度", scope: ["client.js", "tests/unit/studio-ui.test.js"], success_criteria: ["文件与任务对应正确", "窄窗口无内容遮挡"], constraints: ["测试数据不用于业务结论"], risk_level: "low" },
  "02-search-candidates.json": { candidates: [{ path: "client.js", reason: "包含工作台组件", confidence: 0.9 }] },
  "03-code-understanding.md": "# 受控代码理解\n\n这是 UI 验证样例，用于检查文档排版。\n\n## 关注区域\n\n- 页面容器\n- 文件目录与预览\n- 复核上下文\n",
  "04-hypotheses.json": { hypotheses: [{ title: "受控假设", evidence: "样例记录", verification: "浏览器布局检查" }] },
  "05-task-graph.json": { nodes: [{ id: "T1", title: "还原页面结构", input: "任务契约", output: "界面组件", deps: [], success_criteria: "文件浏览可返回原现场", risk: "low" }, { id: "T2", title: "验证窗口适配", input: "T1", output: "检查记录", deps: ["T1"], success_criteria: "无横向溢出", risk: "low" }] },
  "06-implementation/coder-report.json": { tasks: [{ node: "T1", status: "patched", reason: "受控样例补丁，未应用到业务仓库", patch: "06-implementation/patches/0001-T1.diff" }, { node: "T2", status: "no_change", reason: "受控样例检查，无代码修改" }] },
  "06-implementation/session-task.md": "# 受控任务包\n\n仅供 UI 验证，不启动真实执行器。",
  "06-implementation/patches/0001-T1.diff": "diff --git a/example.js b/example.js\n--- a/example.js\n+++ b/example.js\n@@ -1 +1 @@\n-const view = 'old';\n+const view = 'v9';\n",
  "ledger/patch-ledger.jsonl": '{"patch":"06-implementation/patches/0001-T1.diff","fixture":true}\n',
  "07-test-report.json": { passed: false, exitCode: 1, command: "fixture-only", summary: "受控样例，不代表实际测试结论" },
  "08-test-output.txt": "受控测试输出：示例失败，无真实命令执行。",
  "08-review-report.json": { verdict: "fail", diff_scope: "受控样例待人工核对", api_safety: "受控样例", test_coverage: "受控样例" },
  "10-pr-description.md": "# 受控交付预览\n\n这是 UI 样例，没有创建远程 PR。\n\n## 修改\n\n- 页面布局\n- 文件浏览\n\n## 验证\n\n样例报告标为失败，不作为业务验收依据。\n",
  "11-eval-report.json": { ROOT: "pass", PATCH: "pass", TEST: "fail", DIFF: "pass", DESC: "pass", ACCEPT: "fail", fixture: true },
};
for (const [suffix, current, status, mode] of [["plan", "P5", "awaiting_review", "builtin"], ["external", "P6", "awaiting_review", "claude"], ["failed", "P6", "failed", "builtin"], ["completed", "P11", "completed", "builtin"], ["stopped", "P3", "stopped", "builtin"]]) {
  const run = initRun({ runId: "20260908-000001-qa-" + suffix, slug: "ui-alpha", trigger: { kind: "issue", uri: issue, text: "# 受控样例 · " + suffix + " · 验证任务执行、文件来源与长内容布局" }, reviewMode: "every", p6Mode: mode });
  const runDir = runDirOf(root, "ui-alpha", run.id);
  run.current = current; run.status = status;
  run.executionConfig = { ...defaultSettings(), reviewMode: "every", p6Mode: mode, defaultRoute: { provider: "fixture", model: "ui-test-model" } };
  for (const stage of STAGES) {
    if (stage.id === "P10") continue;
    const reached = STAGES.findIndex(item => item.id === stage.id) <= STAGES.findIndex(item => item.id === current);
    if (!reached) continue;
    run.stages[stage.id] = { status: stage.id === current ? status : "approved", startedAt: "2026-09-08T00:00:00Z", attempts: 1, artifact: stage.artifact };
    for (const [path, content] of Object.entries(seedFiles)) {
      if (path !== stage.artifact && !(stage.artifact.endsWith("/") && path.startsWith(stage.artifact)) && !(stage.id === "P8" && path === "08-test-output.txt") && !(stage.id === "P11" && path === "11-eval-report.json")) continue;
      writeArtifact(runDir, path, typeof content === "string" ? content : JSON.stringify(content, null, 2));
    }
  }
  if (suffix === "failed") { run.stages.P6.error = "受控失败：实例 T1 的输出需要重新核对"; run.failureAnalysis = { category: "implementation", detail: "这是测试记录", action: "escalate" }; writeArtifact(runDir, "09-failure-analysis.json", JSON.stringify(run.failureAnalysis)); }
  if (suffix === "external") {
    run.externalExec = { executor: "claude-code", status: "running", startedAt: "2026-09-08T00:00:00Z", sessionId: "fixture-session" };
    writeArtifact(runDir, "06-implementation/external-exec.log", Array.from({ length: 120 }, (_, i) => `[fixture ${i + 1}] ${i % 5 === 0 ? "检查文件" : "执行事件"} · 受控输出，不启动真实 Agent`).join("\n"));
  }
  writeArtifact(runDir, "trace/events.jsonl", Array.from({ length: 30 }, (_, i) => JSON.stringify({ at: "2026-09-08T00:00:00Z", stage: current, kind: "info", name: "受控事件 " + i, detail: "页面验证记录 · 不代表真实模型执行", ok: true })).join("\n"));
  saveRun(runDir, run);
}
const executors = Object.fromEntries(STAGES.map(stage => [stage.id, async rcx => {
  await new Promise(resolve => setTimeout(resolve, 500));
  const file = stage.id === "P1" ? "01-issue-analysis.json" : stage.id === "P5" ? "05-task-graph.json" : "qa-" + stage.id + ".json";
  writeArtifact(rcx.runDir, file, JSON.stringify({ fixture: true, stage: stage.id, reviewMode: rcx.run.reviewMode, command: rcx.project.testCommand, message: "受控执行器结果，非真实模型结论" }, null, 2));
  if (stage.id === "P6") {
    writeArtifact(rcx.runDir, "06-implementation/coder-report.json", JSON.stringify({ tasks: [{ node: "T1", status: "no_change", reason: "UI 联调无需代码修改" }] }));
  }
  if (stage.id === "P11") {
    writeArtifact(rcx.runDir, "10-pr-description.md", "# 受控交付预览\n\n用于验证文件渲染与复制，未创建远程 PR。");
    writeArtifact(rcx.runDir, "11-eval-report.json", JSON.stringify({ pass: false, gates: [], summary: "模拟执行器不产生真实测试结论" }));
  }
  return { artifact: file, summary: "受控 UI 联调 · " + stage.id };
}]));
__setTestHooks({ dataRoot: root, executors,
  runGit: (_args, _opts, cb) => cb(null, "fixture branch\n"),
  runWhich: (_args, _opts, cb) => cb(new Error("fixture: CLI unavailable")),
  opener: (_cmd, _args, _opts, cb) => cb(null),
});
let api;
apply({ effect(fn) { fn(); }, logger: console, webServer: { register(spec) { api = spec.handler; } },
  get: name => name === "agentDefaultModel" ? { currentSelection: () => ({ provider: "fixture", model: "ui-test-model" }) } : undefined,
  llm: { async *stream() { yield { type: "text-delta", text: "这是受控 UI 联调的模拟助手回答。" }; } },
});
const server = http.createServer((req, res) => {
  if (req.url.startsWith("/issue2pr/api/")) return void api(req, res);
  const target = http.request({ hostname: upstream.hostname, port: upstream.port, path: req.url, method: req.method,
    headers: { ...req.headers, host: upstream.host, ...(req.headers.origin ? { origin: upstream.origin } : {}) } }, response => { res.writeHead(response.statusCode, response.headers); response.pipe(res); });
  target.on("error", error => { res.writeHead(502); res.end("DSH 未启动：" + error.message); });
  req.pipe(target);
});
server.on("upgrade", (req, socket, head) => {
  const target = net.connect(Number(upstream.port || 80), upstream.hostname, () => {
    target.write(req.method + " " + req.url + " HTTP/1.1\r\n" + Object.entries({ ...req.headers, host: upstream.host, origin: upstream.origin }).map(([k, v]) => k + ": " + v).join("\r\n") + "\r\n\r\n");
    if (head.length) target.write(head);
    socket.pipe(target); target.pipe(socket);
  });
  target.on("error", () => socket.destroy()); socket.on("error", () => target.destroy());
});
server.listen(Number(process.argv[3] || 3187), "127.0.0.1", () => {
  console.log("受控 UI 联调：http://127.0.0.1:" + server.address().port);
  console.log("仅此地址的 Issue2PR API 使用测试数据：" + root);
});
