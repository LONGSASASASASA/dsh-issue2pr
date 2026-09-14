// tests/stages-p9-p11.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import p9 from "../../lib/stages/p9-reviewer.js";
import p11, { verifyPatchEvidence } from "../../lib/stages/p11-pr-builder.js";
import p7 from "../../lib/stages/p7-patch.js";
import { MAIN_FLOW, initRun, saveRun, loadRun, advance } from "../../lib/core/pipeline.js";

const root = mkdtempSync(join(tmpdir(), "i2p-p911-"));
function runDir() {
  const d = mkdtempSync(join(root, "run-"));
  mkdirSync(join(d, "06-implementation", "patches"), { recursive: true });
  writeFileSync(join(d, "06-implementation", "patches", "0001-a.diff"), "--- a/a\n+++ b/a\n@@ -1 +1 @@\n-x\n+y\n");
  writeFileSync(join(d, "07-test-report.json"), JSON.stringify({ passed: true, exitCode: 0 }));
  writeFileSync(join(d, "01-issue-analysis.json"), JSON.stringify({
    phenomenon: "刷新退出", success_criteria: ["将 a 中 old 替换为 new"], constraints: ["仅修改 a，保持其他行为不变"],
  }));
  writeFileSync(join(d, "04-hypotheses.json"), JSON.stringify({
    hypotheses: [{ id: "H1", title: "旧值导致刷新退出", evidence: "a:1 当前为 old", verify_file: "a", verify_method: "读取 a:1 并运行回归测试" }],
  }));
  writeFileSync(join(d, "06-implementation", "coder-report.json"), JSON.stringify({ mode: "builtin", patches: [{ node: "T1", file: "a", patch: "06-implementation/patches/0001-a.diff" }] }));
  return d;
}
const passLlm = {
  completeJson: async () => ({ diff_scope: "最小", api_security: "无风险", tests: "已补强", verdict: "pass",
    ROOT: "pass", PATCH: "pass", TEST: "pass", DIFF: "pass", DESC: "pass", ACCEPT: "pass" }),
  complete: async () => "# PR：修复刷新退出\n\n## 修改\n- 将 a 中 old 替换为 new",
};

function realRepo() {
  const dir = mkdtempSync(join(root, "repo-"));
  const git = (args) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
  git(["init"]); git(["config", "user.email", "t@t"]); git(["config", "user.name", "t"]);
  git(["config", "core.autocrlf", "false"]);
  writeFileSync(join(dir, "a"), "old\n");
  git(["add", "."]); git(["commit", "-m", "init"]);
  return dir;
}

function patchRun(repoDir, replacement = "new") {
  const d = runDir();
  mkdirSync(join(d, "ledger"), { recursive: true });
  writeFileSync(join(d, "06-implementation", "patches", "0001-a.diff"),
    "--- a/a\n+++ b/a\n@@ -1 +1 @@\n-old\n+" + replacement + "\n");
  return p7({ runDir: d, repoDir, llm: null }).then(() => d);
}

async function readyP11Fixture(replacement) {
  const repoDir = realRepo();
  const d = await patchRun(repoDir, replacement);
  writeFileSync(join(d, "08-review-report.json"), JSON.stringify({
    verdict: "pass", diff_scope: "仅修改 a", api_security: "无接口变更", tests: "回归测试通过",
  }));
  return { runDir: d, repoDir, llm: passLlm, reviewComment: "" };
}

const readEval = (d) => JSON.parse(readFileSync(join(d, "11-eval-report.json"), "utf8"));

test("P9：三维门控产出 08-review-report.json", async () => {
  const d = runDir();
  let captured = "";
  const llm = { ...passLlm, completeJson: async (q) => { captured = q.user; return passLlm.completeJson(q); } };
  const r = await p9({ runDir: d, llm, reviewComment: "" });
  assert.equal(r.artifact, "08-review-report.json");
  const saved = JSON.parse(readFileSync(join(d, r.artifact), "utf8"));
  assert.equal(saved.verdict, "pass");
  // 修复轮：真实 diff 内容必须进入 prompt（Diff 范围裁决不许盲审）
  assert.match(captured, /【实际补丁（完整性见各文件标注）】/);
  assert.match(captured, /完整补丁/);
  assert.match(captured, /0001-a\.diff/);
  assert.match(captured, /\+y/);
});

test("P9：只载入补丁节选时明确上下文边界，不声称原文件损坏", async () => {
  const d = runDir();
  const patch = readFileSync(join(d, "06-implementation", "patches", "0001-a.diff"), "utf8");
  let captured = "";
  await p9({ runDir: d, llm: { ...passLlm, completeJson: async (q) => {
    captured = q.user;
    return passLlm.completeJson(q);
  } }, stageCfgOf: () => ({ params: { diffChars: 20 } }), reviewComment: "" });

  assert.match(captured, /上下文节选/);
  assert.ok(captured.includes("20/" + patch.length));
  assert.match(captured, /原文件未截断/);
  assert.ok(!captured.includes(patch), "不会把整个原文件误当成本次上下文");
});

test("P9：verdict=fail 抛错", async () => {
  const d = runDir();
  const failLlm = { ...passLlm, completeJson: async () => ({ diff_scope: "越权", api_security: "-", tests: "-", verdict: "fail" }) };
  await assert.rejects(() => p9({ runDir: d, llm: failLlm, reviewComment: "" }), /Reviewer 门控未过/);
});

test("P11：产出 PR 说明 + eval Gate 六项", async () => {
  const repo = realRepo();
  const d = await patchRun(repo);
  writeFileSync(join(d, "08-review-report.json"), JSON.stringify({ verdict: "pass" }));
  const r = await p11({ runDir: d, repoDir: repo, llm: passLlm, reviewComment: "" });
  assert.equal(r.artifact, "10-pr-description.md");
  assert.match(readFileSync(join(d, "10-pr-description.md"), "utf8"), /修复刷新退出/);
  const evalReport = JSON.parse(readFileSync(join(d, "11-eval-report.json"), "utf8"));
  for (const g of ["ROOT", "PATCH", "TEST", "DIFF", "DESC", "ACCEPT"]) assert.equal(evalReport[g], "pass");
});

test("P11：客观门禁依据真实证据，模型自报 fail 不能推翻通过的补丁、测试和审查", async () => {
  const rcx = await readyP11Fixture();
  const captured = {};
  rcx.reviewComment = "核对实际补丁，修正文档同步遗漏的说明";
  rcx.llm = {
    complete: async (q) => { captured.desc = q.user; return passLlm.complete(q); },
    completeJson: async (q) => {
      captured.gate = q.user;
      return { ROOT: "pass", PATCH: "fail", TEST: "fail", DIFF: "fail", DESC: "pass", ACCEPT: "pass" };
    },
  };
  await p11(rcx);
  const report = readEval(rcx.runDir);
  for (const key of ["PATCH", "TEST", "DIFF"]) assert.equal(report[key], "pass", key + " 取自客观证据");
  assert.equal(report.patchEvidence.ok, true);
  assert.match(report.reasons.PATCH.join("；"), /SHA-256/);
  assert.match(report.reasons.TEST.join("；"), /passed=true.*exitCode=0/);
  assert.match(report.reasons.DIFF.join("；"), /verdict=pass/);
  for (const prompt of Object.values(captured)) {
    for (const path of ["01-issue-analysis.json", "04-hypotheses.json", "07-test-report.json", "08-review-report.json", "ledger/patch-ledger.jsonl"]) {
      assert.ok(prompt.includes(readFileSync(join(rcx.runDir, path), "utf8")), "提示词包含真实产物 " + path);
    }
    assert.ok(prompt.includes(readFileSync(join(rcx.runDir, "06-implementation", "patches", "0001-a.diff"), "utf8")));
    assert.match(prompt, /完整补丁/);
    assert.ok(prompt.includes(rcx.reviewComment));
  }
  assert.ok(captured.gate.includes(readFileSync(join(rcx.runDir, "10-pr-description.md"), "utf8")));
});

test("P11：长补丁上下文明确为节选，校验仍针对完整文件", async () => {
  const rcx = await readyP11Fixture("new-" + "x".repeat(18000) + "-PATCH-END");
  const prompts = [];
  rcx.llm = {
    complete: async (q) => { prompts.push(q.user); return passLlm.complete(q); },
    completeJson: async (q) => { prompts.push(q.user); return passLlm.completeJson(q); },
  };
  await p11(rcx);
  const patch = readFileSync(join(rcx.runDir, "06-implementation", "patches", "0001-a.diff"), "utf8");
  for (const prompt of prompts) {
    assert.ok(prompt.includes("16000/" + patch.length));
    assert.match(prompt, /原文件未截断，证据校验基于完整文件/);
    assert.ok(!prompt.includes("-PATCH-END"));
  }
  assert.equal(readEval(rcx.runDir).patchEvidence.ok, true);
  assert.match(patch, /-PATCH-END/);
});

test("P11：ACCEPT 未通过保留具体原因，并让真实阶段流水线失败", async () => {
  const rcx = await readyP11Fixture();
  rcx.llm = { ...passLlm, completeJson: async () => ({
    ROOT: "pass", DESC: "pass", ACCEPT: "fail", reasons: { ACCEPT: ["需求要求更新版本文档，但补丁未修改 docs/version.md"] },
  }) };
  const run = initRun({ runId: "p11-accept-fail", slug: "test", trigger: {}, reviewMode: "auto", p6Mode: "builtin" });
  for (const id of MAIN_FLOW) if (id !== "P11") run.stages[id].status = "approved";
  saveRun(rcx.runDir, run);
  await advance({ ...rcx, run, executors: { P11: p11 } });

  const report = readEval(rcx.runDir);
  assert.equal(report.ACCEPT, "fail");
  assert.deepEqual(report.reasons.ACCEPT, ["需求要求更新版本文档，但补丁未修改 docs/version.md"]);
  assert.equal(run.status, "failed");
  assert.equal(run.stages.P11.status, "failed");
  assert.match(run.stages.P11.error, /docs\/version\.md/);
  assert.equal(loadRun(rcx.runDir).status, "failed");
});

test("P11：ROOT 或 DESC 不通过时，模型不能单独宣称 ACCEPT 通过", async (t) => {
  const rcx = await readyP11Fixture();
  for (const key of ["ROOT", "DESC"]) await t.test(key, async () => {
    rcx.llm = { ...passLlm, completeJson: async () => ({
      ROOT: "pass", DESC: "pass", ACCEPT: "pass", [key]: "fail", reasons: { [key]: [key + " 缺少可核对依据"] },
    }) };
    await assert.rejects(() => p11(rcx), /验收未通过/);
    const report = readEval(rcx.runDir);
    assert.equal(report[key], "fail");
    assert.equal(report.ACCEPT, "fail");
    assert.ok(report.reasons.ACCEPT.some((reason) => reason.includes(key)));
  });
});

test("P11：缺失或非法语义验收结论不得放行", async (t) => {
  const rcx = await readyP11Fixture();
  for (const [name, result, field] of [
    ["缺 ROOT", { DESC: "pass", ACCEPT: "pass" }, "ROOT"],
    ["DESC 为布尔值", { ROOT: "pass", DESC: true, ACCEPT: "pass" }, "DESC"],
    ["ACCEPT 值无效", { ROOT: "pass", DESC: "pass", ACCEPT: "PASS" }, "ACCEPT"],
    ["null 顶层", null, "ROOT"],
    ["数组顶层", ["pass", "pass", "pass"], "ROOT"],
  ]) await t.test(name, async () => {
    rcx.llm = { ...passLlm, completeJson: async () => result };
    await assert.rejects(() => p11(rcx), /验收未通过/);
    const report = readEval(rcx.runDir);
    assert.equal(report[field], null);
    assert.notEqual(report.ACCEPT, "pass");
    assert.match(report.reasons[field].join("；"), /有效 pass\|fail/);
  });
});

test("P11：生成或评测模型异常不能保留上轮全 pass", async (t) => {
  const rcx = await readyP11Fixture();
  for (const method of ["complete", "completeJson"]) await t.test(method, async () => {
    writeFileSync(join(rcx.runDir, "11-eval-report.json"), JSON.stringify({
      ROOT: "pass", PATCH: "pass", TEST: "pass", DIFF: "pass", DESC: "pass", ACCEPT: "pass",
    }));
    rcx.llm = { ...passLlm, [method]: async () => { throw new Error("模型服务暂不可用"); } };
    await assert.rejects(() => p11(rcx), /模型服务暂不可用/);
    const report = readEval(rcx.runDir);
    assert.equal(report.ROOT, null);
    assert.equal(report.DESC, null);
    assert.equal(report.ACCEPT, null);
    assert.equal(report.PATCH, "pass");
    assert.match(report.reasons.ACCEPT.join("；"), /模型服务暂不可用/);
  });
});

test("P11：真实测试或审查失败保持 fail，不接受模型全 pass 自报", async (t) => {
  const rcx = await readyP11Fixture();
  const testPath = join(rcx.runDir, "07-test-report.json");
  const reviewPath = join(rcx.runDir, "08-review-report.json");
  const originalTest = readFileSync(testPath, "utf8");
  const originalReview = readFileSync(reviewPath, "utf8");
  for (const [key, path, report] of [
    ["TEST", testPath, { passed: false, exitCode: 1 }],
    ["TEST", testPath, { passed: true, exitCode: 1 }],
    ["DIFF", reviewPath, { verdict: "fail", diff_scope: "遗漏调用方" }],
  ]) await t.test(key + " " + JSON.stringify(report), async () => {
    writeFileSync(testPath, originalTest);
    writeFileSync(reviewPath, originalReview);
    writeFileSync(path, JSON.stringify(report));
    let called = false;
    rcx.llm = {
      complete: async () => { called = true; return passLlm.complete(); },
      completeJson: async () => { called = true; return passLlm.completeJson(); },
    };
    await assert.rejects(() => p11(rcx), /验收未通过/);
    const saved = readEval(rcx.runDir);
    assert.equal(saved[key], "fail");
    assert.equal(saved.ACCEPT, "fail");
    assert.equal(saved.ROOT, null);
    assert.equal(saved.DESC, null);
    assert.equal(called, false, "前置真实失败应直接阻止模型验收");
  });
});

test("P11：外部 eval 自报 pass 但实际仓库有额外改动时强制 PATCH/DIFF fail", async () => {
  const repo = realRepo();
  const d = await patchRun(repo);
  writeFileSync(join(repo, "a"), "unexpected\n");

  await assert.rejects(
    () => p11({ runDir: d, repoDir: repo, llm: passLlm, reviewComment: "" }),
    /证据校验未通过/,
  );
  const evalReport = JSON.parse(readFileSync(join(d, "11-eval-report.json"), "utf8"));
  assert.equal(evalReport.PATCH, "fail");
  assert.equal(evalReport.DIFF, "fail");
  assert.equal(evalReport.TEST, "pass", "补丁失败不应连带把已有测试结果改为 fail");
  assert.equal(evalReport.ROOT, null, "尚未执行的语义评测显示未评测");
  assert.equal(evalReport.DESC, null);
  assert.equal(evalReport.ACCEPT, "fail");
  assert.match(evalReport.reasons.ROOT.join("；"), /尚未执行/);
  assert.ok(evalReport.patchEvidence.errors.length > 0);
});

test("P11：patch 文件被篡改时按 ledger SHA-256 拒绝放行", async () => {
  const repo = realRepo();
  const d = await patchRun(repo);
  writeFileSync(join(d, "06-implementation", "patches", "0001-a.diff"),
    "--- a/a\n+++ b/a\n@@ -1 +1 @@\n-old\n+tampered\n");

  await assert.rejects(
    () => p11({ runDir: d, repoDir: repo, llm: passLlm, reviewComment: "" }),
    /SHA-256|证据校验未通过/,
  );
  const evalReport = JSON.parse(readFileSync(join(d, "11-eval-report.json"), "utf8"));
  assert.equal(evalReport.PATCH, "fail");
});

test("P11：证据校验缺少 repoDir 时失败闭合，不得静默跳过", async () => {
  const repo = realRepo();
  const d = await patchRun(repo);

  const evidence = await verifyPatchEvidence({ runDir: d });

  assert.equal(evidence.ok, false);
  assert.equal(evidence.skipped, false);
  assert.match(evidence.errors.join("；"), /repoDir/);
});

test("P11：patch 清单路径越界时返回结构化证据失败", async () => {
  const repo = realRepo();
  const d = runDir();
  mkdirSync(join(d, "ledger"), { recursive: true });
  writeFileSync(join(d, "06-implementation", "coder-report.json"), JSON.stringify({
    patches: [{ patch: "../../outside.diff" }],
  }));
  writeFileSync(join(d, "ledger", "patch-ledger.jsonl"), JSON.stringify({
    patch: "06-implementation/../../outside.diff", status: "applied", sha256: "0".repeat(64),
  }) + "\n");

  const evidence = await verifyPatchEvidence({ runDir: d, repoDir: repo });

  assert.equal(evidence.ok, false);
  assert.match(evidence.errors.join("；"), /非法路径|越界/);
});

test("P11：ledger 中当前清单之外的活动应用记录必须被拒绝", async () => {
  const repo = mkdtempSync(join(root, "repo-extra-ledger-"));
  const git = (args) => execFileSync("git", args, { cwd: repo, stdio: "pipe" });
  git(["init"]); git(["config", "user.email", "t@t"]); git(["config", "user.name", "t"]);
  git(["config", "core.autocrlf", "false"]);
  writeFileSync(join(repo, "a"), "a-old\n");
  writeFileSync(join(repo, "b"), "b-old\n");
  git(["add", "."]); git(["commit", "-m", "init"]);

  const d = mkdtempSync(join(root, "run-extra-ledger-"));
  mkdirSync(join(d, "06-implementation", "patches"), { recursive: true });
  mkdirSync(join(d, "ledger"), { recursive: true });
  writeFileSync(join(d, "06-implementation", "patches", "0001-a.diff"),
    "--- a/a\n+++ b/a\n@@ -1 +1 @@\n-a-old\n+a-new\n");
  writeFileSync(join(d, "06-implementation", "patches", "0002-b.diff"),
    "--- a/b\n+++ b/b\n@@ -1 +1 @@\n-b-old\n+b-extra\n");
  writeFileSync(join(d, "06-implementation", "coder-report.json"), JSON.stringify({
    patches: [
      { patch: "06-implementation/patches/0001-a.diff" },
      { patch: "06-implementation/patches/0002-b.diff" },
    ],
  }));
  await p7({ runDir: d, repoDir: repo, llm: null });

  // 模拟外部结果把额外文件恢复到 HEAD；最终工作区 diff 看似干净，但 ledger 仍声明它已应用。
  git(["checkout", "--", "b"]);
  writeFileSync(join(d, "06-implementation", "coder-report.json"), JSON.stringify({
    patches: [{ patch: "06-implementation/patches/0001-a.diff" }],
  }));

  const evidence = await verifyPatchEvidence({ runDir: d, repoDir: repo });

  assert.equal(evidence.ok, false);
  assert.match(evidence.errors.join("；"), /ledger|额外|清单/);
});

test("P11：P7 重跑替换 patch 后只校验最新批次，不误判历史 ledger", async () => {
  const repo = realRepo();
  const d = await patchRun(repo);
  // 本轮先应用 0001-a，再模拟 P6 重跑生成只包含 0002-b 的新 patch。
  writeFileSync(join(d, "06-implementation", "patches", "0001-a.diff"),
    "--- a/a\n+++ b/a\n@@ -1 +1 @@\n-old\n+new-a\n");
  writeFileSync(join(d, "06-implementation", "patches", "0002-b.diff"),
    "--- a/a\n+++ b/a\n@@ -1 +1 @@\n-old\n+new-b\n");
  writeFileSync(join(d, "06-implementation", "coder-report.json"), JSON.stringify({
    patches: [{ patch: "06-implementation/patches/0001-a.diff" }],
  }));
  await p7({ runDir: d, repoDir: repo, llm: null });
  writeFileSync(join(d, "06-implementation", "coder-report.json"), JSON.stringify({
    patches: [{ patch: "06-implementation/patches/0002-b.diff" }],
  }));
  await p7({ runDir: d, repoDir: repo, llm: null });

  const evidence = await verifyPatchEvidence({ runDir: d, repoDir: repo });

  assert.equal(evidence.ok, true);
});

test("P11：ledger 空行不改变旧 rollbackOf 的逻辑行号", async () => {
  const repo = realRepo();
  const d = await patchRun(repo);
  const ledgerPath = join(d, "ledger", "patch-ledger.jsonl");
  const applied = readFileSync(ledgerPath, "utf8").trim();
  execFileSync("git", ["reset", "--hard", "HEAD"], { cwd: repo, stdio: "pipe" });
  writeFileSync(ledgerPath, "\n" + applied + "\n" + JSON.stringify({
    rollbackOf: 0, status: "rolled_back",
  }) + "\n");

  const evidence = await verifyPatchEvidence({ runDir: d, repoDir: repo });

  assert.equal(evidence.ok, false);
  assert.match(evidence.errors.join("；"), /没有对应的最新 applied/);
});
