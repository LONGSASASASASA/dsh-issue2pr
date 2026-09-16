// tests/stages-p7-p8-p10.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import p7, { collectPatches, hashRepo, rollbackLedger } from "../../lib/stages/p7-patch.js";
import { verifyDelegateResult } from "../../lib/delegate/delegateVerify.js";
import { verifyPatchEvidence } from "../../lib/infra/patchEvidence.js";
import p8 from "../../lib/stages/p8-test-runner.js";
import p10 from "../../lib/stages/p10-failure.js";
import { logEvent } from "../../lib/stages/helpers.js";

const root = mkdtempSync(join(tmpdir(), "i2p-p78-"));
function gitRepo() {
  const dir = mkdtempSync(join(root, "repo-"));
  const git = (args) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
  git(["init"]); git(["config", "user.email", "t@t"]); git(["config", "user.name", "t"]);
  // Windows 系统级 core.autocrlf=true 会让 git apply 落盘时把 LF 转 CRLF，掩盖回滚恢复语义；测试仓库内归一化为 false
  git(["config", "core.autocrlf", "false"]);
  writeFileSync(join(dir, "a.txt"), "line1\n");
  git(["add", "."]); git(["commit", "-m", "init"]);
  return dir;
}

test("P7：应用 diff 并写 ledger；rollback 只反应用该 patch", async () => {
  const repoDir = gitRepo();
  const runDir = mkdtempSync(join(root, "run-"));
  mkdirSync(join(runDir, "06-implementation", "patches"), { recursive: true });
  mkdirSync(join(runDir, "ledger"), { recursive: true });
  writeFileSync(join(runDir, "06-implementation", "coder-report.json"),
    JSON.stringify({ patches: [{ patch: "06-implementation/patches/0001-a.diff" }] }));
  writeFileSync(join(runDir, "06-implementation", "patches", "0001-a.diff"),
    "--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-line1\n+line1-patched\n");
  const r = await p7({ runDir, repoDir, llm: null, reviewComment: "" });
  assert.match(readFileSync(join(repoDir, "a.txt"), "utf8"), /patched/);
  assert.ok(existsSync(join(runDir, "ledger", "patch-ledger.jsonl")));
  await rollbackLedger(runDir, repoDir, 0);
  assert.equal(readFileSync(join(repoDir, "a.txt"), "utf8"), "line1\n");
});

test("补丁清单：任务内绝对路径及两种相对路径统一，拒绝任务外与盘符相对路径", () => {
  const runDir = mkdtempSync(join(root, "run-"));
  const patchDir = join(runDir, "06-implementation", "patches");
  mkdirSync(patchDir, { recursive: true });
  const expected = "06-implementation/patches/0001-a.diff";
  const reportPath = join(runDir, "06-implementation", "coder-report.json");
  const check = patch => {
    writeFileSync(reportPath, JSON.stringify({ tasks: [{ node: "T1", patch }] }));
    return collectPatches(runDir);
  };
  for (const value of [
    join(patchDir, "0001-a.diff"), join(patchDir, "0001-a.diff").replace(/\\/g, "/"),
    expected, "patches/0001-a.diff", "patches\\0001-a.diff", "patches/../patches/0001-a.diff",
  ]) {
    assert.deepEqual(check(value), [{ patch: expected }], value);
  }
  for (const value of [
    join(dirname(runDir), "outside.diff"), join(runDir + "-sibling", "outside.diff"),
    "../../outside.diff", "C:outside.diff", "//server/share/outside.diff",
    process.platform === "win32" && runDir.toLowerCase().startsWith("c:") ? "D:/outside.diff" : "C:/outside.diff",
  ]) {
    assert.throws(() => check(value), /非法路径/, value);
  }
});

test("绝对补丁路径：P6 验证、P7 应用、P11 证据与回滚使用同一相对路径", async () => {
  const repoDir = gitRepo();
  const runDir = mkdtempSync(join(root, "run-"));
  const patchPath = join(runDir, "06-implementation", "patches", "0001-a.diff");
  mkdirSync(dirname(patchPath), { recursive: true });
  writeFileSync(patchPath, "--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-line1\n+line1-patched\n");
  writeFileSync(join(runDir, "05-task-graph.json"), JSON.stringify({ nodes: [{ id: "T1" }] }));
  const reportPath = join(runDir, "06-implementation", "coder-report.json");
  const report = JSON.stringify({ tasks: [{ node: "T1", status: "patched", patch: patchPath }] });
  writeFileSync(reportPath, report);
  const verification = await verifyDelegateResult({ runDir, repoDir }, "P6");
  assert.equal(verification.ok, true, verification.errors.join("；"));
  assert.equal(verification.rehearsal, true);
  assert.equal(readFileSync(join(repoDir, "a.txt"), "utf8"), "line1\n");
  await p7({ runDir, repoDir });
  assert.equal(readFileSync(join(repoDir, "a.txt"), "utf8"), "line1-patched\n");
  const ledger = JSON.parse(readFileSync(join(runDir, "ledger", "patch-ledger.jsonl"), "utf8"));
  assert.equal(ledger.patch, "06-implementation/patches/0001-a.diff");
  const evidence = await verifyPatchEvidence({ runDir, repoDir });
  assert.equal(evidence.ok, true, evidence.errors.join("；"));
  await rollbackLedger(runDir, repoDir, 0);
  assert.equal(readFileSync(join(repoDir, "a.txt"), "utf8"), "line1\n");
  assert.equal(readFileSync(reportPath, "utf8"), report, "归一化不改写原始报告");
});

test("P8：真实执行命令，exitCode 落报告；失败抛错；完整输出落 08-test-output.txt", async () => {
  const runDir = mkdtempSync(join(root, "run-"));
  const good = await p8({ runDir, repoDir: root, project: { testCommand: "node -e \"process.stdout.write('A'.repeat(5000))\"" }, llm: null });
  const report = JSON.parse(readFileSync(join(runDir, good.artifact), "utf8"));
  assert.equal(report.passed, true);
  assert.equal(report.tail.length, 4000, "report.tail 截断为 4000 字");
  const full = readFileSync(join(runDir, "08-test-output.txt"), "utf8");
  assert.ok(full.length >= 5000, "08-test-output.txt 含完整输出（未截断）");
  assert.ok(full.startsWith("A".repeat(10)), "完整输出的开头部分也在文件中，证明未截断");
  await assert.rejects(() => p8({ runDir, repoDir: root, project: { testCommand: "node -e \"process.stdout.write('B'.repeat(200)); process.exit(1)\"" }, llm: null }), /测试失败/);
  const failOut = readFileSync(join(runDir, "08-test-output.txt"), "utf8");
  assert.ok(failOut.includes("B".repeat(200)), "失败路径完整输出同样落盘");
});

test("P10：失败六分类契约（无冲突的 LLM 分类原样保留）", async () => {
  const runDir = mkdtempSync(join(root, "run-"));
  const llm = { completeJson: async () => ({ category: "根因错误", detail: "定位偏差", action: "replan" }) };
  const r = await p10({ runDir, repoDir: root, llm, failure: { stage: "P6", error: "定位失败" }, run: { status: "failed" } });
  const saved = JSON.parse(readFileSync(join(runDir, r.artifact), "utf8"));
  assert.equal(saved.category, "根因错误");
  assert.equal(saved.action, "replan");
  assert.equal(saved.degraded, false);
});

// —— TASK-07：结构化错误贯通 P10 确定性分类 ——
test("TASK-07：断言证据约束扩展到全部阶段——无证据的「实现错误」不采信", async () => {
  const runDir = mkdtempSync(join(root, "run-"));
  const llm = { completeJson: async () => ({ category: "实现错误", detail: "diff 与意图不符", action: "rollback" }) };
  const r = await p10({ runDir, repoDir: root, llm, failure: { stage: "P6", error: "Reviewer 拒绝" }, run: { status: "failed" } });
  const saved = JSON.parse(readFileSync(join(runDir, r.artifact), "utf8"));
  assert.equal(saved.category, "原因未确定", "无断言证据/门禁结论时不得判实现错误");
  assert.equal(saved.action, "escalate");
  assert.equal(saved.degraded, false);
  assert.match(saved.analysis, /diff 与意图不符/, "LLM 解释降为补充 analysis");
});

test("TASK-07：有效业务门禁结论（Reviewer fail）→ 确定性「实现错误」，LLM 只可补充", async () => {
  const runDir = mkdtempSync(join(root, "run-"));
  const llm = { completeJson: async () => ({ category: "根因错误", detail: "补充解释", action: "replan" }) };
  const r = await p10({
    runDir, repoDir: root, llm,
    failure: {
      stage: "P9", error: "Reviewer 门控未过: diff 范围不完整",
      structuredError: { code: "business_gate_failed", message: "Reviewer 门控未过: diff 范围不完整",
        stage: "P9", gate: "P9-reviewer", verdict: "fail" },
    },
    run: { status: "failed" },
  });
  const saved = JSON.parse(readFileSync(join(runDir, r.artifact), "utf8"));
  assert.equal(saved.category, "实现错误", "门禁 fail 是有效业务结论，走业务验收失败路径");
  assert.equal(saved.action, "escalate");
  assert.match(saved.detail, /P9-reviewer/);
  assert.equal(saved.degraded, false);
  assert.match(saved.analysis, /补充解释/, "LLM 输出仅作为补充解释保留");
});

test("TASK-07：模型协议错误 → 系统确定性「模型协议错误」，不得伪装成业务验收失败", async () => {
  const runDir = mkdtempSync(join(root, "run-"));
  const llm = { completeJson: async () => ({ category: "实现错误", detail: "补丁质量差", action: "rollback" }) };
  for (const [code, message, finishReason] of [
    ["json_parse_failed", "契约解析失败：第 3 字符处意外结束", null],
    ["schema_validation_failed", "$.candidates[0].confidence 不在枚举内", null],
    ["output_truncated", "输出因 length 截断", "length"],
  ]) {
    const r = await p10({
      runDir, repoDir: root, llm,
      failure: {
        stage: "P2", error: message,
        structuredError: { code, message, stage: "P2", finishReason, callId: "call-1",
          logRefs: ["trace/llm/call-1/attempt-1"] },
      },
      run: { status: "failed" },
    });
    const saved = JSON.parse(readFileSync(join(runDir, r.artifact), "utf8"));
    assert.equal(saved.category, "模型协议错误", code);
    assert.equal(saved.action, "escalate", code);
    assert.match(saved.detail, /不是业务验收结论/, code);
    assert.equal(saved.degraded, false);
    assert.ok(saved.evidence.structuredError.code === code, "原始结构化错误随报告保留");
  }
});

test("TASK-07：模型调用失败按 llmCause 确定性分类，不进入业务验收失败路径", async () => {
  const runDir = mkdtempSync(join(root, "run-"));
  const llm = { completeJson: async () => ({ category: "实现错误", detail: "改判", action: "rollback" }) };
  for (const [llmCause, expectCategory] of [
    ["timeout", "模型调用超时"], ["provider", "模型服务错误"],
    ["cancelled", "模型调用取消"], ["empty", "模型返回为空"], ["unknown", "模型调用失败"],
  ]) {
    const r = await p10({
      runDir, repoDir: root, llm,
      failure: {
        stage: "P4", error: "调用失败",
        structuredError: { code: "llm_call_failed", llmCause, message: "调用失败", stage: "P4" },
      },
      run: { status: "failed" },
    });
    const saved = JSON.parse(readFileSync(join(runDir, r.artifact), "utf8"));
    assert.equal(saved.category, expectCategory, llmCause);
    assert.equal(saved.action, "escalate", llmCause);
    assert.equal(saved.degraded, false);
  }
});

// —— 补全②：开工前环境失败（failRun 结构化 environment_error）确定性归类「环境缺失」 ——
test("补全：clone 等开工前失败（environment_error）→ 确定性「环境缺失」，LLM 改判不采信", async () => {
  const runDir = mkdtempSync(join(root, "run-"));
  const llm = { completeJson: async () => ({ category: "实现错误", detail: "补丁写坏了仓库", action: "rollback" }) };
  const r = await p10({
    runDir, repoDir: root, llm,
    failure: {
      stage: "P1", error: "仓库准备失败: git clone 失败: remote: Authentication failed",
      structuredError: { code: "environment_error", message: "仓库准备失败: git clone 失败: remote: Authentication failed", stage: "P1", logRefs: [], retryHistory: [] },
    },
    run: { status: "failed" },
  });
  const saved = JSON.parse(readFileSync(join(runDir, r.artifact), "utf8"));
  assert.equal(saved.category, "环境缺失", "开工前环境失败不再落「原因未确定」");
  assert.equal(saved.action, "escalate");
  assert.equal(saved.degraded, false);
  assert.match(saved.detail, /不是业务验收失败/);
  assert.match(saved.analysis, /补丁写坏了仓库/, "LLM 解释降为补充 analysis");
});

// —— 补全①：委外执行器观测事实（spawn/timeout）是系统确定性结论，LLM 不得覆盖 ——
test("补全：委外 failureKind spawn/timeout → 确定性「环境缺失/执行超时」，留档引用随证据保留", async () => {
  for (const [failureKind, expectCategory] of [
    ["spawn", "环境缺失"],
    ["timeout", "执行超时"],
  ]) {
    const runDir = mkdtempSync(join(root, "run-"));
    const llm = { completeJson: async () => ({ category: "实现错误", detail: "模型改判", action: "rollback" }) };
    const r = await p10({
      runDir, repoDir: root, llm,
      failure: {
        stage: "P6", error: "P6 执行未完成",
        structuredError: { code: "stage_failed", message: "P6 执行未完成", stage: "P6", failureKind,
          logIntegrity: "complete",
          logRefs: ["06-implementation/external-exec.records.journal", "06-implementation/external-exec.stdout.journal"] },
      },
      run: { status: "failed" },
    });
    const saved = JSON.parse(readFileSync(join(runDir, r.artifact), "utf8"));
    assert.equal(saved.category, expectCategory, failureKind);
    assert.equal(saved.action, "escalate", failureKind);
    assert.equal(saved.degraded, false, failureKind);
    assert.match(saved.analysis, /模型改判/, failureKind + "：LLM 输出仅作补充");
    assert.deepEqual(saved.evidence.structuredError.logRefs,
      ["06-implementation/external-exec.records.journal", "06-implementation/external-exec.stdout.journal"],
      failureKind + "：journal 引用随证据保留");
  }
});

test("TASK-07：P10 自身 LLM 再失败时保留原始诊断与留档引用（降级不丢证据）", async () => {
  const runDir = mkdtempSync(join(root, "run-"));
  const llm = { completeJson: async () => { throw new Error("LLM 调用失败: Authentication Fails"); } };
  const r = await p10({
    runDir, repoDir: root, llm,
    failure: {
      stage: "P2", error: "输出截断",
      structuredError: { code: "output_truncated", message: "输出截断", stage: "P2",
        finishReason: "length", callId: "call-7", logRefs: ["trace/llm/call-7/attempt-1"] },
    },
    run: { status: "failed" },
  });
  const saved = JSON.parse(readFileSync(join(runDir, r.artifact), "utf8"));
  assert.equal(saved.degraded, true, "P10 自身失败 → 降级");
  assert.equal(saved.category, "模型协议错误", "系统确定性分类不受 P10 自身失败影响");
  assert.match(saved.detail, /输出截断/, "原始诊断保留");
  assert.deepEqual(saved.evidence.structuredError.logRefs, ["trace/llm/call-7/attempt-1"], "原始日志引用保留");
  assert.match(saved.analysisError, /Authentication Fails/);
  assert.match(r.summary, /降级/);
});

test("P10：LLM 认证失败时保留基础失败报告并降级返回", async () => {
  const runDir = mkdtempSync(join(root, "run-"));
  const llm = { completeJson: async () => { throw new Error("LLM 调用失败: Authentication Fails"); } };
  const r = await p10({
    runDir,
    repoDir: root,
    llm,
    failure: { stage: "P1", error: "Authentication Fails" },
    run: { status: "failed" },
  });
  const saved = JSON.parse(readFileSync(join(runDir, r.artifact), "utf8"));
  assert.equal(saved.action, "escalate");
  assert.equal(saved.degraded, true);
  assert.match(saved.detail, /P1.*Authentication Fails/);
  assert.match(r.summary, /降级/);
});

test("P10：run.status 非 failed 时跳过，不写产物", async () => {
  const runDir = mkdtempSync(join(root, "run-"));
  const llm = { completeJson: async () => { throw new Error("不应被调用"); } };
  const r = await p10({ runDir, repoDir: root, llm, failure: { stage: "P8", error: "测试失败" }, run: { status: "running" } });
  assert.equal(r.artifact, null);
  assert.equal(existsSync(join(runDir, "09-failure-analysis.json")), false);
});
test("P7：session 模式回退——无 coder-report.json 时扫 patches/ 目录按序应用", async () => {
  const repoDir = gitRepo();
  const runDir = mkdtempSync(join(root, "run-"));
  mkdirSync(join(runDir, "06-implementation", "patches"), { recursive: true });
  mkdirSync(join(runDir, "ledger"), { recursive: true });
  writeFileSync(join(runDir, "06-implementation", "patches", "0001-a.diff"),
    "--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-line1\n+line1-session\n");
  const r = await p7({ runDir, repoDir, llm: null, reviewComment: "" });
  assert.match(r.summary, /1 份 patch/);
  assert.match(readFileSync(join(repoDir, "a.txt"), "utf8"), /session/);
  const ledger = readFileSync(join(runDir, "ledger", "patch-ledger.jsonl"), "utf8").trim().split("\n");
  const firstLedger = JSON.parse(ledger[0]);
  assert.equal(firstLedger.patch, "06-implementation/patches/0001-a.diff");
  assert.match(firstLedger.patchSha256, /^[a-f0-9]{64}$/);
  assert.equal(firstLedger.sha256, firstLedger.patchSha256);
});

test("P7：无任何 patch 时明确报错", async () => {
  const runDir = mkdtempSync(join(root, "run-"));
  await assert.rejects(() => p7({ runDir, repoDir: root, llm: null }), /无 patch 可应用/);
});

test("P7：git hash 失败返回明确 null，不使用 nogit 伪哈希", async () => {
  const notGit = mkdtempSync(join(root, "not-git-"));
  assert.equal(await hashRepo(notGit), null);
});

test("P7：patch 清单路径越界时拒绝读取 Run 目录外文件", async () => {
  const repoDir = gitRepo();
  const runDir = mkdtempSync(join(root, "run-"));
  mkdirSync(join(runDir, "06-implementation", "patches"), { recursive: true });
  const outside = join(dirname(runDir), "outside.diff");
  writeFileSync(outside, "--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-line1\n+escaped\n");
  writeFileSync(join(runDir, "06-implementation", "coder-report.json"),
    JSON.stringify({ patches: [{ patch: "../../outside.diff" }] }));

  await assert.rejects(() => p7({ runDir, repoDir, llm: null }), /非法路径/);
});

// claude 委托产出的 report：tasks 字段 + patch 路径相对 06-implementation/（P7 需归一化后按序应用）
test("P7：claude 委托 report（tasks 格式 · 短路径）→ 归一化按序应用", async () => {
  const repoDir = gitRepo();
  const runDir = mkdtempSync(join(root, "run-"));
  mkdirSync(join(runDir, "06-implementation", "patches"), { recursive: true });
  mkdirSync(join(runDir, "ledger"), { recursive: true });
  writeFileSync(join(runDir, "06-implementation", "patches", "0001-a.diff"),
    "--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-line1\n+line1-step1\n");
  writeFileSync(join(runDir, "06-implementation", "patches", "0002-a.diff"),
    "--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-line1-step1\n+line1-step2\n"); // 叠加式：基于 0001 已应用状态
  writeFileSync(join(runDir, "06-implementation", "coder-report.json"),
    JSON.stringify({ mode: "claude-code", tasks: [
      { node: "T1", patch: "patches/0001-a.diff" },
      { node: "T2", patch: "patches/0002-a.diff" },
    ], summary: "叠加式两步" }));
  const r = await p7({ runDir, repoDir, llm: null, reviewComment: "" });
  assert.match(r.summary, /2 份 patch/);
  assert.match(readFileSync(join(repoDir, "a.txt"), "utf8"), /line1-step2/);
  const ledger = readFileSync(join(runDir, "ledger", "patch-ledger.jsonl"), "utf8").trim().split("\n");
  assert.equal(JSON.parse(ledger[0]).patch, "06-implementation/patches/0001-a.diff");
  assert.equal(JSON.parse(ledger[1]).patch, "06-implementation/patches/0002-a.diff");
});

test("P8：过程事件落 trace/events.jsonl（开始 + 结束，含耗时与 ok）", async () => {
  const runDir = mkdtempSync(join(root, "run-"));
  await p8({ runDir, repoDir: root, project: { testCommand: "node -e \"\"" }, llm: null });
  const lines = readFileSync(join(runDir, "trace", "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(lines[0].kind, "test");
  assert.match(lines[0].name, /node -e/);
  assert.equal(lines.at(-1).ok, true);
  assert.ok(typeof lines.at(-1).ms === "number");
});

test("TASK-10：logEvent 摘要事件携带完整日志引用与留档完整性，正文不进摘要", () => {
  const runDir = mkdtempSync(join(root, "run-"));
  const rcx = { runDir, run: { current: "P3", stages: { P3: { stageExecutionId: "P3-20260916-010203-abcdabcdabcd" } } } };
  logEvent(rcx, { kind: "llm", name: "模型 · 失败", ok: false, callId: "call-x", attemptId: "att-y", attempt: 2,
    retryOf: "att-z", retryReason: "输出截断", logDir: "trace/llm/call-x/att-y", logIntegrity: "partial" });
  logEvent(rcx, { kind: "llm", name: "模型 · 完成", logDir: "trace/llm/call-x/att-w", logIntegrity: "complete" });
  logEvent(rcx, { kind: "llm", name: "旧形态", logIntegrity: "bogus-value", logDir: "" });
  const rows = readFileSync(join(runDir, "trace", "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(rows.length, 3);
  assert.equal(rows[0].stageExecutionId, "P3-20260916-010203-abcdabcdabcd");
  assert.equal(rows[0].logRef, "trace/llm/call-x/att-y", "完整日志目录引用进摘要");
  assert.equal(rows[0].logIntegrity, "partial");
  assert.equal(rows[1].logRef, "trace/llm/call-x/att-w");
  assert.equal(rows[1].logIntegrity, "complete");
  assert.equal("logRef" in rows[2], false, "空 logDir 不写字段（旧形态兼容）");
  assert.equal("logIntegrity" in rows[2], false, "未知完整性值不落字段，不虚构");
  for (const key of ["text", "response", "system", "user"]) assert.ok(!(key in rows[0]), "摘要不携带正文全文");
});

test("P7：git apply 成功/失败都记过程事件", async () => {
  const repoDir = gitRepo();
  const runDir = mkdtempSync(join(root, "run-"));
  mkdirSync(join(runDir, "06-implementation", "patches"), { recursive: true });
  writeFileSync(join(runDir, "06-implementation", "patches", "0001-ok.diff"),
    "--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-line1\n+line1-ok\n");
  const rcx = { runDir, repoDir, llm: null, run: { current: "P7" } };
  await p7(rcx);
  writeFileSync(join(runDir, "06-implementation", "patches", "0002-bad.diff"),
    "--- a/nope.txt\n+++ b/nope.txt\n@@ -1 +1 @@\n-x\n+y\n");
  writeFileSync(join(runDir, "06-implementation", "coder-report.json"),
    JSON.stringify({ patches: [{ patch: "06-implementation/patches/0002-bad.diff" }] }));
  await assert.rejects(() => p7(rcx), /Patch 应用失败/);
  const evs = readFileSync(join(runDir, "trace", "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.ok(evs.some((e) => e.kind === "git" && e.ok === true), "成功 apply 记事件");
  assert.ok(evs.some((e) => e.kind === "git" && e.ok === false), "失败 apply 记事件");
  assert.ok(evs.every((e) => e.stage === "P7"), "事件携带阶段号");
});

test("A1/A2 修复：P7 重跑前自动重置工作区（打回/回退后 re-apply 不再必败）", async () => {
  const repoDir = gitRepo();
  const runDir = mkdtempSync(join(root, "run-"));
  mkdirSync(join(runDir, "06-implementation", "patches"), { recursive: true });
  mkdirSync(join(runDir, "ledger"), { recursive: true });
  writeFileSync(join(runDir, "06-implementation", "coder-report.json"),
    JSON.stringify({ patches: [{ patch: "06-implementation/patches/0001-a.diff" }] }));
  writeFileSync(join(runDir, "06-implementation", "patches", "0001-a.diff"),
    "--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-line1\n+line1-patched\n");
  await p7({ runDir, repoDir, llm: null, reviewComment: "" });
  assert.match(readFileSync(join(repoDir, "a.txt"), "utf8"), /patched/);
  // 旧实现：工作区仍是 patched 状态，直接 re-apply 必失败（git apply --check 报 already exists）
  await p7({ runDir, repoDir, llm: null, reviewComment: "" });
  assert.match(readFileSync(join(repoDir, "a.txt"), "utf8"), /patched/, "基线重置后重新应用一次");
  const ledger = readFileSync(join(runDir, "ledger", "patch-ledger.jsonl"), "utf8").trim().split("\n");
  assert.equal(ledger.length, 2, "两次应用各记一行 ledger");
});

test("B2：重复回滚同一 ledger 行幂等，并记录 rolled_back 状态", async () => {
  const repoDir = gitRepo();
  const runDir = mkdtempSync(join(root, "run-"));
  mkdirSync(join(runDir, "06-implementation", "patches"), { recursive: true });
  mkdirSync(join(runDir, "ledger"), { recursive: true });
  writeFileSync(join(runDir, "06-implementation", "patches", "0001-a.diff"),
    "--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-line1\n+line1-b2\n");
  writeFileSync(join(runDir, "06-implementation", "coder-report.json"),
    JSON.stringify({ patches: [{ patch: "06-implementation/patches/0001-a.diff" }] }));

  await p7({ runDir, repoDir, llm: null });
  const first = await rollbackLedger(runDir, repoDir, 0);
  const second = await rollbackLedger(runDir, repoDir, 0);

  assert.equal(first.status, "rolled_back");
  assert.equal(second.status, "already_rolled_back");
  assert.equal(readFileSync(join(repoDir, "a.txt"), "utf8"), "line1\n");
  const lines = readFileSync(join(runDir, "ledger", "patch-ledger.jsonl"), "utf8")
    .trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(lines.length, 2, "重复请求不得追加第二条回滚动作");
  assert.deepEqual(lines[1].status, "rolled_back");
  assert.equal(lines[1].rollbackOf, 0);
});

test("B2：工作区已被其他改动时回滚前置校验失败且不写回滚记录", async () => {
  const repoDir = gitRepo();
  const runDir = mkdtempSync(join(root, "run-"));
  mkdirSync(join(runDir, "06-implementation", "patches"), { recursive: true });
  mkdirSync(join(runDir, "ledger"), { recursive: true });
  writeFileSync(join(runDir, "06-implementation", "patches", "0001-a.diff"),
    "--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-line1\n+line1-b2-check\n");
  writeFileSync(join(runDir, "06-implementation", "coder-report.json"),
    JSON.stringify({ patches: [{ patch: "06-implementation/patches/0001-a.diff" }] }));

  await p7({ runDir, repoDir, llm: null });
  writeFileSync(join(repoDir, "a.txt"), "user-edit\n");

  await assert.rejects(
    () => rollbackLedger(runDir, repoDir, 0),
    /回滚前置校验失败/,
  );
  assert.equal(readFileSync(join(repoDir, "a.txt"), "utf8"), "user-edit\n");
  const lines = readFileSync(join(runDir, "ledger", "patch-ledger.jsonl"), "utf8")
    .trim().split("\n");
  assert.equal(lines.length, 1, "前置校验失败不得追加回滚状态");
  assert.equal(readdirSync(join(runDir, "ledger")).length, 1);
});

test("B2：patch 文件被篡改时回滚前按 SHA-256 拒绝", async () => {
  const repoDir = gitRepo();
  const runDir = mkdtempSync(join(root, "run-tampered-"));
  mkdirSync(join(runDir, "06-implementation", "patches"), { recursive: true });
  mkdirSync(join(runDir, "ledger"), { recursive: true });
  writeFileSync(join(runDir, "06-implementation", "patches", "0001-a.diff"),
    "--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-line1\n+line1-original\n");
  writeFileSync(join(runDir, "06-implementation", "coder-report.json"), JSON.stringify({
    patches: [{ patch: "06-implementation/patches/0001-a.diff" }],
  }));
  await p7({ runDir, repoDir, llm: null });
  writeFileSync(join(runDir, "06-implementation", "patches", "0001-a.diff"), "not a patch\n");

  await assert.rejects(() => rollbackLedger(runDir, repoDir, 0), /SHA-256/);
  assert.equal(readFileSync(join(repoDir, "a.txt"), "utf8"), "line1-original\n");
});

test("B2：回滚只允许当前最新 P7 batch，历史 ledger 行明确拒绝", async () => {
  const repoDir = gitRepo();
  const runDir = mkdtempSync(join(root, "run-old-batch-"));
  mkdirSync(join(runDir, "06-implementation", "patches"), { recursive: true });
  mkdirSync(join(runDir, "ledger"), { recursive: true });
  writeFileSync(join(runDir, "06-implementation", "patches", "0001-a.diff"),
    "--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-line1\n+line1-first\n");
  writeFileSync(join(runDir, "06-implementation", "coder-report.json"), JSON.stringify({
    patches: [{ patch: "06-implementation/patches/0001-a.diff" }],
  }));
  await p7({ runDir, repoDir, llm: null });
  writeFileSync(join(runDir, "06-implementation", "patches", "0002-a.diff"),
    "--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-line1\n+line1-second\n");
  writeFileSync(join(runDir, "06-implementation", "coder-report.json"), JSON.stringify({
    patches: [{ patch: "06-implementation/patches/0002-a.diff" }],
  }));
  await p7({ runDir, repoDir, llm: null });

  await assert.rejects(() => rollbackLedger(runDir, repoDir, 0), /当前.*批次|活动批次/);
  assert.equal(readFileSync(join(repoDir, "a.txt"), "utf8"), "line1-second\n");
});
