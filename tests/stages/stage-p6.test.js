// tests/stage-p6.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import p6 from "../../lib/stages/p6-coder.js";

const root = mkdtempSync(join(tmpdir(), "i2p-p6-"));
const repoDir = join(root, "repo");
mkdirSync(join(repoDir, "src"), { recursive: true });
writeFileSync(join(repoDir, "src", "guard.ts"), "restoreSession();");

const TASK_GRAPH = JSON.stringify({ nodes: [
  { id: "T1", title: "守卫加 await", output: "patch", deps: [] },
  { id: "T2", title: "补回归测试", output: "patch", deps: ["T1"] },
]});

function llmSequence(seq) {
  let i = 0;
  const calls = [];
  return {
    completeJson: async (req) => { calls.push({ kind: "json", ...req }); return JSON.parse(seq[Math.min(i++, seq.length - 1)]); },
    complete: async (req) => { calls.push({ kind: "text", ...req }); return "--- a/src/guard.ts\n+++ b/src/guard.ts\n@@ -1 +1 @@\n-restoreSession();\n+await restoreSession();"; },
    calls,
  };
}

test("builtin：每节点一份 diff + coder-report，planner/coder/reviewer 都发生", async () => {
  const runDir = mkdtempSync(join(root, "run-"));
  writeFileSync(join(runDir, "05-task-graph.json"), TASK_GRAPH);
  const llm = llmSequence([
    '{"assignments":[{"node":"T1","file":"src/guard.ts"},{"node":"T2","file":"tests/x.test.ts"}]}', // planner
    '{"verdict":"pass","notes":"最小 diff"}',                                                          // reviewer
  ]);
  const r = await p6({ runDir, repoDir, llm, reviewComment: "", p6Mode: "builtin" });
  assert.equal(r.artifact, "06-implementation/");
  const patches = readdirSync(join(runDir, "06-implementation", "patches"));
  assert.equal(patches.length, 2);
  assert.match(patches[0], /^0001-.*\.diff$/);
  const report = JSON.parse(readFileSync(join(runDir, "06-implementation", "coder-report.json"), "utf8"));
  assert.equal(report.mode, "builtin");
  assert.equal(report.reviewer.verdict, "pass");
  // reviewer 必须收到 diff 文本内容（而非仅 patch 路径清单）——P6 门控可信
  const reviewerCall = llm.calls.find((c) => c.kind === "json" && String(c.user).includes("【diff 清单】"));
  assert.ok(reviewerCall, "应发生 reviewer 调用");
  assert.match(reviewerCall.user, /restoreSession/, "reviewer prompt 应包含 coder 产出的 diff 内容特征串");
});

test("builtin：reviewer fail → 抛错（交给 P10）", async () => {
  const runDir = mkdtempSync(join(root, "run-"));
  writeFileSync(join(runDir, "05-task-graph.json"), TASK_GRAPH);
  const llm = llmSequence(['{"assignments":[{"node":"T1","file":"src/guard.ts"}]}', '{"verdict":"fail","notes":"越权修改"}']);
  await assert.rejects(() => p6({ runDir, repoDir, llm, reviewComment: "", p6Mode: "builtin" }), /越权修改/);
});

test("session：写 session-task.md，不调 LLM", async () => {
  const runDir = mkdtempSync(join(root, "run-"));
  writeFileSync(join(runDir, "05-task-graph.json"), TASK_GRAPH);
  const llm = { completeJson: async () => { throw new Error("不应被调用"); }, complete: async () => { throw new Error("不应被调用"); } };
  const r = await p6({ runDir, repoDir, llm, reviewComment: "", p6Mode: "session" });
  assert.equal(r.artifact, "06-implementation/session-task.md");
  assert.equal(r.external, true); // 外部执行标记：advance 据此显示"等外部执行"并拦截空 patches 的 approve
  assert.ok(existsSync(join(runDir, "06-implementation", "session-task.md")));
});

// —— claude 模式：生成任务包后委托 claude CLI，产物就绪进正常复核门，失败回退等人工 ——

test("claude：执行成功产出 patches/report → externalExec=done（含 stats），过程面板记录进度事件", async () => {
  const runDir = mkdtempSync(join(root, "run-"));
  writeFileSync(join(runDir, "05-task-graph.json"), TASK_GRAPH);
  const llm = { completeJson: async () => { throw new Error("不应被调用"); }, complete: async () => { throw new Error("不应被调用"); } };
  const run = { id: "r1", stages: {} };
  const spawnExternal = async (opts) => {
    const nap = (ms) => new Promise((res) => setTimeout(res, ms));
    await nap(80); // 采样器先观察到 0 patch
    mkdirSync(join(runDir, "06-implementation", "patches"), { recursive: true });
    writeFileSync(join(runDir, "06-implementation", "patches", "0001-T1.diff"), "--- a/x\n+++ b/x\n");
    writeFileSync(join(runDir, "06-implementation", "coder-report.json"), '{"mode":"claude-code"}');
    await nap(60); // 留时间给采样器捕捉 1/2
    return { code: 0, stdout: '{"num_turns":5,"total_cost_usd":0.42,"duration_ms":63000,"result":"已全部完成"}', stderr: "" };
  };
  const r = await p6({ runDir, repoDir, run, llm, reviewComment: "", p6Mode: "claude", spawnExternal, externalProgressIntervalMs: 10 });
  assert.equal(r.artifact, "06-implementation/");
  assert.equal(r.external, undefined); // 实施已完成，走正常待复核（不再是"等外部执行"）
  assert.match(r.summary, /1 份 patch/);
  assert.equal(run.externalExec.status, "done");
  assert.equal(run.externalExec.executor, "claude-code");
  // claude headless 统计解析进 externalExec（UI 状态卡展示耗时/轮次/费用）
  assert.equal(run.externalExec.stats.turns, 5);
  assert.equal(run.externalExec.stats.costUsd, 0.42);
  assert.match(r.summary, /耗时 1 分钟/);
  assert.ok(existsSync(join(runDir, "06-implementation", "session-task.md"))); // 任务包仍生成（人工接管兜底）
  assert.ok(existsSync(join(runDir, "06-implementation", "external-exec.log"))); // 执行输出留档
  // 过程事件：进度采样 + 完成（UI 阶段详情"过程"面板数据源）
  const ev = readFileSync(join(runDir, "trace", "events.jsonl"), "utf8");
  assert.match(ev, /Claude Code 进度 1\/2/);
  assert.match(ev, /Claude Code 执行完成[^\n]*耗时 1 分钟[^\n]*5 轮[^\n]*\$0\.42/);
});

test("claude：stream-json 输出 → externalExec 记 sessionId 与归一 stats（执行器折叠）", async () => {
  const runDir = mkdtempSync(join(root, "run-"));
  writeFileSync(join(runDir, "05-task-graph.json"), TASK_GRAPH);
  const run = { id: "r5", stages: {} };
  const spawnExternal = async () => {
    mkdirSync(join(runDir, "06-implementation", "patches"), { recursive: true });
    writeFileSync(join(runDir, "06-implementation", "patches", "0001-T1.diff"), "--- a/x\n+++ b/x\n");
    writeFileSync(join(runDir, "06-implementation", "coder-report.json"), '{"mode":"claude-code"}');
    return {
      code: 0, stderr: "",
      stdout: [
        JSON.stringify({ type: "system", subtype: "init", session_id: "sess-stream-1" }),
        JSON.stringify({ type: "result", subtype: "success", session_id: "sess-stream-1", is_error: false, result: "完成",
          duration_ms: 90000, num_turns: 7, total_cost_usd: 0.88, usage: { input_tokens: 900, output_tokens: 200 } }),
      ].join("\n"),
    };
  };
  const r = await p6({ runDir, repoDir, run, llm: {}, reviewComment: "", p6Mode: "claude", spawnExternal });
  assert.equal(r.external, undefined);
  assert.equal(run.externalExec.sessionId, "sess-stream-1"); // 为 --resume 重试留钩
  assert.equal(run.externalExec.stats.turns, 7);
  assert.equal(run.externalExec.stats.costUsd, 0.88);
  assert.match(r.summary, /7 轮/);
});

test("claude：is_error=true（403 类）→ failed 且错误信息含 result 文本与认证引导", async () => {
  const runDir = mkdtempSync(join(root, "run-"));
  writeFileSync(join(runDir, "05-task-graph.json"), TASK_GRAPH);
  const run = { id: "r6", stages: {} };
  const spawnExternal = async () => ({
    code: 0, stderr: "",
    stdout: JSON.stringify({ type: "result", is_error: true, result: "API Error: 403 ip access denied", usage: { input_tokens: 0, output_tokens: 0 } }),
  });
  const r = await p6({ runDir, repoDir, run, llm: {}, reviewComment: "", p6Mode: "claude", spawnExternal });
  assert.equal(r.external, true); // 回退等人工
  assert.equal(run.externalExec.status, "failed");
  assert.match(run.externalExec.error, /403/); // 不再漏判：exit 0 但 is_error 也算失败
  assert.match(run.externalExec.error, /认证|白名单|中转/); // 可操作引导
});

test("dsh：p6Mode=dsh 经 dsh-agent 执行器 → externalExec.executor=dsh-agent，产物就绪走正常复核", async () => {
  const runDir = mkdtempSync(join(root, "run-"));
  writeFileSync(join(runDir, "05-task-graph.json"), TASK_GRAPH);
  const run = { id: "r7", stages: {} };
  const spawnExternal = async (opts) => {
    assert.ok(opts.repoDir && opts.prompt && opts.timeoutMs > 0, "执行器应收到完整 runCtx");
    mkdirSync(join(runDir, "06-implementation", "patches"), { recursive: true });
    writeFileSync(join(runDir, "06-implementation", "patches", "0001-T1.diff"), "--- a/x\n+++ b/x\n");
    writeFileSync(join(runDir, "06-implementation", "coder-report.json"), '{"mode":"dsh-agent"}');
    return { code: 0, sessionId: "session-dsh-1", stats: { turns: 2, durationMs: 30000, result: "完成" }, resultText: "完成", toolCalls: ["write", "bash"], stopReason: "completed" };
  };
  const r = await p6({ runDir, repoDir, run, llm: {}, reviewComment: "", p6Mode: "dsh", spawnExternal });
  assert.equal(r.external, undefined);
  assert.equal(run.externalExec.executor, "dsh-agent");
  assert.equal(run.externalExec.sessionId, "session-dsh-1");
  assert.equal(run.externalExec.stats.turns, 2);
  assert.match(r.summary, /DSH 原生智能体/);
  const ev = readFileSync(join(runDir, "trace", "events.jsonl"), "utf8");
  assert.match(ev, /DSH 原生智能体 执行完成[^\n]*工具 2 次/);
});

test("dsh：智能体异常结束无产物 → failed 回退等人工", async () => {
  const runDir = mkdtempSync(join(root, "run-"));
  writeFileSync(join(runDir, "05-task-graph.json"), TASK_GRAPH);
  const run = { id: "r8", stages: {} };
  const spawnExternal = async () => ({ code: 1, stopReason: "error", resultText: "工具执行被拒", toolCalls: [] });
  const r = await p6({ runDir, repoDir, run, llm: {}, reviewComment: "", p6Mode: "dsh", spawnExternal });
  assert.equal(r.external, true);
  assert.equal(run.externalExec.status, "failed");
  assert.match(run.externalExec.error, /error/);
  assert.match(run.externalExec.error, /工具执行被拒/);
});

test("claude：执行失败无产物 → externalExec=failed，external=true 回退等人工", async () => {
  const runDir = mkdtempSync(join(root, "run-"));
  writeFileSync(join(runDir, "05-task-graph.json"), TASK_GRAPH);
  const run = { id: "r2", stages: {} };
  const spawnExternal = async () => ({ code: 1, stdout: "", stderr: "boom: not logged in" });
  const r = await p6({ runDir, repoDir, run, llm: {}, reviewComment: "", p6Mode: "claude", spawnExternal });
  assert.equal(r.artifact, "06-implementation/session-task.md");
  assert.equal(r.external, true);
  assert.equal(run.externalExec.status, "failed");
  assert.match(run.externalExec.error, /boom/);
  assert.ok(existsSync(join(runDir, "06-implementation", "external-exec.log")));
});

test("claude：spawn 报错（如未安装）→ externalExec=skipped，external=true", async () => {
  const runDir = mkdtempSync(join(root, "run-"));
  writeFileSync(join(runDir, "05-task-graph.json"), TASK_GRAPH);
  const run = { id: "r3", stages: {} };
  const spawnExternal = async () => ({ code: -1, error: "spawn claude ENOENT" });
  const r = await p6({ runDir, repoDir, run, llm: {}, reviewComment: "", p6Mode: "claude", spawnExternal });
  assert.equal(r.external, true);
  assert.equal(run.externalExec.status, "skipped");
  assert.match(run.externalExec.error, /ENOENT/);
});