// tests/stage-p6.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { advance, initRun, saveRun } from "../../lib/core/pipeline.js";
import p6 from "../../lib/stages/p6-coder.js";

const root = mkdtempSync(join(tmpdir(), "i2p-p6-"));
const repoDir = join(root, "repo");
mkdirSync(join(repoDir, "src"), { recursive: true });
writeFileSync(join(repoDir, "src", "guard.ts"), "restoreSession();");

const TASK_GRAPH = JSON.stringify({ nodes: [
  { id: "T1", title: "守卫加 await", output: "patch", deps: [] },
  { id: "T2", title: "补回归测试", output: "patch", deps: ["T1"] },
]});

function externalRepo() {
  const dir = mkdtempSync(join(root, "external-repo-"));
  const git = args => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
  git(["init"]); git(["config", "user.email", "test@example.com"]); git(["config", "user.name", "Test"]);
  writeFileSync(join(dir, "x"), "a\n");
  git(["add", "."]); git(["commit", "-m", "baseline"]);
  return dir;
}
function writeExternalReport(runDir) {
  writeFileSync(join(runDir, "06-implementation", "coder-report.json"), JSON.stringify({ tasks: [
    { node: "T1", status: "patched", patch: "06-implementation/patches/0001-T1.diff" },
    { node: "T2", status: "no_change", reason: "本节点仅核验，不需要代码变更" },
  ] }));
}
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

test("builtin：Coder 非 unified diff → 写文件前拒绝", async () => {
  const runDir = mkdtempSync(join(root, "run-"));
  writeFileSync(join(runDir, "05-task-graph.json"), TASK_GRAPH);
  const llm = {
    completeJson: async () => ({ assignments: [{ node: "T1", file: "src/guard.ts" }] }),
    complete: async () => "not-a-unified-diff",
  };

  await assert.rejects(
    () => p6({ runDir, repoDir, llm, reviewComment: "", p6Mode: "builtin" }),
    /不是 unified diff/,
  );
  const patchDir = join(runDir, "06-implementation", "patches");
  assert.equal(existsSync(patchDir) ? readdirSync(patchDir).length : 0, 0);
});

test("builtin：Coder 并发最多 2 个", async () => {
  const runDir = mkdtempSync(join(root, "run-"));
  writeFileSync(join(runDir, "05-task-graph.json"), TASK_GRAPH);
  let active = 0;
  let maxActive = 0;
  const assignments = Array.from({ length: 4 }, (_, i) => ({ node: "T" + (i + 1), file: "src/guard.ts" }));
  const llm = {
    completeJson: async (req) => String(req.user).includes("【diff 清单】")
      ? { verdict: "pass", notes: "ok" }
      : { assignments },
    complete: async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 30));
      active -= 1;
      return "--- a/src/guard.ts\n+++ b/src/guard.ts\n@@ -1 +1 @@\n-restoreSession();\n+await restoreSession();";
    },
  };

  await p6({ runDir, repoDir, llm, reviewComment: "", p6Mode: "builtin" });
  assert.equal(maxActive, 2);
});

test("session：写 session-task.md，不调 LLM", async () => {
  const runDir = mkdtempSync(join(root, "run-"));
  writeFileSync(join(runDir, "05-task-graph.json"), TASK_GRAPH);
  const llm = { completeJson: async () => { throw new Error("不应被调用"); }, complete: async () => { throw new Error("不应被调用"); } };
  const r = await p6({ runDir, repoDir, llm, reviewComment: "", p6Mode: "session" });
  assert.equal(r.artifact, "06-implementation/session-task.md");
  assert.equal(r.external, true); // 外部执行标记：advance 据此显示"等外部执行"并拦截空 patches 的 approve
  assert.ok(existsSync(join(runDir, "06-implementation", "session-task.md")));
  const task = readFileSync(join(runDir, "06-implementation", "session-task.md"), "utf8");
  assert.match(task, /patched/);
  assert.match(task, /no_change/);
  assert.match(task, /no_change.*不生成.*diff/s);
});

// —— claude 模式：生成任务包后委托 claude CLI，产物就绪进正常复核门，失败回退等人工 ——

test("claude：执行成功产出 patches/report → externalExec=done（含 stats），过程面板记录进度事件", async () => {
  const runDir = mkdtempSync(join(root, "run-"));
  writeFileSync(join(runDir, "05-task-graph.json"), TASK_GRAPH);
  const llm = { completeJson: async () => { throw new Error("不应被调用"); }, complete: async () => { throw new Error("不应被调用"); } };
  const run = { id: "r1", stages: {} };
  const spawnExternal = async (opts) => {
    assert.match(opts.prompt, /patched/);
    assert.match(opts.prompt, /no_change/);
    assert.match(opts.prompt, /no_change.*不生成.*diff/s);
    const nap = (ms) => new Promise((res) => setTimeout(res, ms));
    await nap(80); // 采样器先观察到 0 patch
    mkdirSync(join(runDir, "06-implementation", "patches"), { recursive: true });
    writeFileSync(join(runDir, "06-implementation", "patches", "0001-T1.diff"), "--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n");
    writeExternalReport(runDir);
    await nap(60); // 留时间给采样器捕捉 1/2
    return { code: 0, stdout: '{"num_turns":5,"total_cost_usd":0.42,"duration_ms":63000,"result":"已全部完成"}', stderr: "" };
  };
  const r = await p6({ runDir, repoDir: externalRepo(), run, llm, reviewComment: "", p6Mode: "claude", spawnExternal, externalProgressIntervalMs: 10 });
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
  assert.match(ev, /Claude Code patch 产出 1/);
  assert.match(ev, /Claude Code 执行完成[^\n]*耗时 1 分钟[^\n]*5 轮[^\n]*\$0\.42/);
});

test("claude：stream-json 输出 → externalExec 记 sessionId 与归一 stats（执行器折叠）", async () => {
  const runDir = mkdtempSync(join(root, "run-"));
  writeFileSync(join(runDir, "05-task-graph.json"), TASK_GRAPH);
  const run = { id: "r5", stages: {} };
  const spawnExternal = async () => {
    mkdirSync(join(runDir, "06-implementation", "patches"), { recursive: true });
    writeFileSync(join(runDir, "06-implementation", "patches", "0001-T1.diff"), "--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n");
    writeExternalReport(runDir);
    return {
      code: 0, stderr: "",
      stdout: [
        JSON.stringify({ type: "system", subtype: "init", session_id: "sess-stream-1" }),
        JSON.stringify({ type: "result", subtype: "success", session_id: "sess-stream-1", is_error: false, result: "完成",
          duration_ms: 90000, num_turns: 7, total_cost_usd: 0.88, usage: { input_tokens: 900, output_tokens: 200 } }),
      ].join("\n"),
    };
  };
  const r = await p6({ runDir, repoDir: externalRepo(), run, llm: {}, reviewComment: "", p6Mode: "claude", spawnExternal });
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
  const r = await p6({ runDir, repoDir: externalRepo(), run, llm: {}, reviewComment: "", p6Mode: "claude", spawnExternal });
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
    writeFileSync(join(runDir, "06-implementation", "patches", "0001-T1.diff"), "--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n");
    writeExternalReport(runDir);
    return { code: 0, sessionId: "session-dsh-1", stats: { turns: 2, durationMs: 30000, result: "完成" }, resultText: "完成", toolCalls: ["write", "bash"], stopReason: "completed" };
  };
  const r = await p6({ runDir, repoDir: externalRepo(), run, llm: {}, reviewComment: "", p6Mode: "dsh", spawnExternal });
  assert.equal(r.external, undefined);
  assert.equal(run.externalExec.executor, "dsh-agent");
  assert.equal(run.externalExec.sessionId, "session-dsh-1");
  assert.equal(run.externalExec.stats.turns, 2);
  assert.match(r.summary, /DSH 原生智能体/);
  const ev = readFileSync(join(runDir, "trace", "events.jsonl"), "utf8");
  assert.match(ev, /DSH 原生智能体 执行完成[^\n]*工具 2 次/);
});

// —— TASK-01：委外留档身份关联（captureId ↔ runId/stage/stageExecutionId，claude 与 dsh 同口径） ——
test("TASK-01：委外 captureId 与本轮阶段执行身份关联（claude / dsh）", async () => {
  for (const mode of ["claude", "dsh"]) {
    const runDir = mkdtempSync(join(root, "run-"));
    writeFileSync(join(runDir, "05-task-graph.json"), TASK_GRAPH);
    const run = { id: "run-id-1", stages: { P6: {
      startedAt: "2026-09-16T10:00:00.000Z", stageExecutionId: "P6-20260916-100000-abcdef123456" } } };
    const spawnExternal = async () => {
      mkdirSync(join(runDir, "06-implementation", "patches"), { recursive: true });
      writeFileSync(join(runDir, "06-implementation", "patches", "0001-T1.diff"), "--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n");
      writeExternalReport(runDir);
      return mode === "claude"
        ? { code: 0, stdout: '{"result":"ok"}', stderr: "" }
        : { code: 0, sessionId: "s1", stats: { turns: 1 }, resultText: "ok", toolCalls: [], stopReason: "completed" };
    };
    await p6({ runDir, repoDir: externalRepo(), run, llm: {}, reviewComment: "", p6Mode: mode, spawnExternal });
    assert.equal(run.externalExec.stage, "P6", mode);
    assert.equal(run.externalExec.runId, "run-id-1", mode);
    assert.equal(run.externalExec.stageExecutionId, "P6-20260916-100000-abcdef123456", mode);
    assert.equal(run.externalExec.stageStartedAt, "2026-09-16T10:00:00.000Z", mode);
    assert.ok(run.externalExec.captureId, mode + " 执行器须回写 captureId");
  }
});

test("dsh：智能体异常结束无产物 → failed 回退等人工", async () => {
  const runDir = mkdtempSync(join(root, "run-"));
  writeFileSync(join(runDir, "05-task-graph.json"), TASK_GRAPH);
  const run = { id: "r8", stages: {} };
  const spawnExternal = async () => ({ code: 1, stopReason: "error", resultText: "工具执行被拒", toolCalls: [] });
  const r = await p6({ runDir, repoDir: externalRepo(), run, llm: {}, reviewComment: "", p6Mode: "dsh", spawnExternal });
  assert.equal(r.external, true);
  assert.equal(run.externalExec.status, "failed");
  assert.match(run.externalExec.error, /error/);
  assert.match(run.externalExec.error, /工具执行被拒/);
});

// —— 补全①：委外失败（已有部分产物 → 显式抛错）附着留档引用与失败事实，贯通 st.errorInfo ——
test("补全：委外执行失败抛错携带 journal 引用/failureKind/完整性，摘要事件带 logRef（claude / dsh）", async () => {
  for (const mode of ["claude", "dsh"]) {
    const runDir = mkdtempSync(join(root, "run-"));
    writeFileSync(join(runDir, "05-task-graph.json"), TASK_GRAPH);
    const run = { id: "r-fix1", stages: {} };
    const spawnExternal = async () => {
      mkdirSync(join(runDir, "06-implementation", "patches"), { recursive: true });
      writeFileSync(join(runDir, "06-implementation", "patches", "0001-T1.diff"), "--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n");
      return mode === "claude"
        ? { code: 1, stdout: "", stderr: "boom: not logged in" }
        : { code: 1, stopReason: "error", resultText: "工具执行被拒", toolCalls: [] };
    };
    const failure = await p6({ runDir, repoDir: externalRepo(), run, llm: {}, reviewComment: "", p6Mode: mode, spawnExternal })
      .then(() => null, (e) => e);
    assert.ok(failure, mode + "：已有部分产物必须显式失败");
    // 失败事实（执行器自身观测）与留档引用附着在抛错上，由 advance 的 structuredErrorOf 透传进 st.errorInfo
    assert.equal(failure.failureKind, mode === "claude" ? "exit" : "agent", mode);
    assert.ok(Array.isArray(failure.logDirs) && failure.logDirs.length, mode + "：抛错携带留档目录");
    assert.equal(failure.logIntegrity, "complete", mode + "：journal 已正常封存");
    if (mode === "claude") {
      assert.equal(failure.logDirs[0], "06-implementation/external-exec.records.journal", "claude：records journal（异常判定所在）排首");
      assert.ok(failure.logDirs.some((d) => d === "06-implementation/external-exec.stdout.journal"), "claude：stdout journal 在引用内");
      for (const d of failure.logDirs) assert.ok(!d.includes("\\"), "引用统一 / 分隔（Windows relative 归一）");
    } else {
      assert.match(failure.logDirs[0], /^06-implementation\/dsh-journal-/, "dsh：原生会话 journal 目录在引用内");
    }
    // 摘要事件（异常日志线索）携带完整日志引用与留档完整性，从 events.jsonl 可定位 journal 原文
    const events = readFileSync(join(runDir, "trace", "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const failEv = events.find((e) => /执行未完成/.test(e.name));
    assert.ok(failEv, mode + "：失败摘要事件存在");
    assert.ok(failEv.logRef, mode + "：事件携带 logRef");
    assert.equal(failEv.logIntegrity, "complete", mode + "：事件携带留档完整性");
    assert.equal(failEv.ok, false);
  }
});

test("claude：执行失败无产物 → externalExec=failed，external=true 回退等人工", async () => {
  const runDir = mkdtempSync(join(root, "run-"));
  writeFileSync(join(runDir, "05-task-graph.json"), TASK_GRAPH);
  const run = { id: "r2", stages: {} };
  const spawnExternal = async () => ({ code: 1, stdout: "", stderr: "boom: not logged in" });
  const r = await p6({ runDir, repoDir: externalRepo(), run, llm: {}, reviewComment: "", p6Mode: "claude", spawnExternal });
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
  const r = await p6({ runDir, repoDir: externalRepo(), run, llm: {}, reviewComment: "", p6Mode: "claude", spawnExternal });
  assert.equal(r.external, true);
  assert.equal(run.externalExec.status, "skipped");
  assert.match(run.externalExec.error, /ENOENT/);
});

for (const scenario of [
  { name: "429 中断且只有部分补丁", code: 1, error: true, report: false },
  { name: "退出码 0 但 result.is_error，已有完整报告", code: 0, error: true, report: true },
  { name: "退出码 0 但没有完成报告", code: 0, error: false, report: false },
  { name: "非零退出码且已有完整报告", code: 1, error: false, report: true },
]) {
  test("P6 自动门禁：" + scenario.name + "，保留产物且不进入 P7", async () => {
    const runDir = mkdtempSync(join(root, "interrupted-"));
    const repo = externalRepo();
    const run = initRun({ runId: "20260915-100000-test", slug: "test", trigger: { uri: "issue.md" }, reviewMode: "auto", p6Mode: "claude" });
    for (const id of ["P1", "P2", "P3", "P4", "P5"]) run.stages[id].status = "approved";
    run.current = "P6";
    saveRun(runDir, run);
    writeFileSync(join(runDir, "05-task-graph.json"), TASK_GRAPH);
    const patchPath = join(runDir, "06-implementation", "patches", "0001-T1.diff");
    const patch = "--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n";
    let p7Calls = 0;
    await advance({ runDir, run, repoDir: repo, p6Mode: "claude", llm: {},
      executors: { P6: p6, P7: async () => { p7Calls += 1; throw new Error("不应到达 P7"); } },
      spawnExternal: async () => {
        mkdirSync(join(runDir, "06-implementation", "patches"), { recursive: true });
        writeFileSync(patchPath, patch);
        if (scenario.report) writeExternalReport(runDir);
        return { code: scenario.code, stderr: "", stdout: JSON.stringify({ type: "result", is_error: scenario.error,
          result: scenario.error ? "API Error: 429 [1308] 已达到 5 小时的使用上限" : "完成" }) };
      },
    });
    assert.equal(run.current, "P6");
    assert.equal(run.stages.P6.status, "failed");
    assert.equal(run.status, "failed");
    assert.equal(run.externalExec.status, "failed");
    assert.equal(p7Calls, 0);
    assert.equal(readFileSync(patchPath, "utf8"), patch);
    assert.equal(readFileSync(join(repo, "x"), "utf8"), "a\n", "验证不应用补丁到工作区");
    if (scenario.error) assert.match(run.stages.P6.error, /429.*1308/);
    if (!scenario.report) assert.match(run.stages.P6.error, /缺少 coder-report/);
    const events = readFileSync(join(runDir, "trace", "events.jsonl"), "utf8");
    assert.doesNotMatch(events, /Claude Code 执行完成|P6 完成|patch \+ report/);
  });
}
