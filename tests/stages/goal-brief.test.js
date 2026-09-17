// tests/goal-brief.test.js — 20260917-001：全局目标投影（goalBriefOf）与分层注入
// 决策层（P3/P4/P5/P6 派单）完整投影；执行层（P6 coder）轻量形态；委外完整投影+边界。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { goalBriefOf } from "../../lib/stages/helpers.js";
import p3 from "../../lib/stages/p3-code-understanding.js";
import p4 from "../../lib/stages/p4-hypothesis.js";
import p5 from "../../lib/stages/p5-planner.js";
import p6 from "../../lib/stages/p6-coder.js";

const root = mkdtempSync(join(tmpdir(), "i2p-goal-"));
const repoDir = join(root, "repo");
mkdirSync(join(repoDir, "src"), { recursive: true });
writeFileSync(join(repoDir, "src", "guard.ts"), "export function routerGuard(){ restoreSession(); }");

const CONTRACT = {
  goal: "修复登录后刷新偶发退出的问题，使会话恢复测试通过",
  phenomenon: "刷新后偶发退出",
  trigger: "登录后刷新",
  scope: ["Auth", "Session"],
  success_criteria: ["刷新后不再退出", "现有登录测试全部通过"],
  constraints: ["不破坏登录主流程"],
  non_goals: ["不重构认证模块"],
  risk_level: "medium",
};
function runDirWith(contract) {
  const runDir = mkdtempSync(join(root, "run-"));
  if (contract !== null) writeFileSync(join(runDir, "01-issue-analysis.json"), JSON.stringify(contract));
  return runDir;
}

test("goalBriefOf：完整投影含目标/标准/约束/非目标/边界，确定性输出", () => {
  const rcx = { runDir: runDirWith(CONTRACT) };
  const brief = goalBriefOf(rcx);
  assert.match(brief, /【全局目标（背景，仅供理解与验收对照）】/);
  assert.match(brief, /目标：修复登录后刷新偶发退出的问题/);
  assert.match(brief, /成功标准：\n1\. 刷新后不再退出/);
  assert.match(brief, /约束：\n1\. 不破坏登录主流程/);
  assert.match(brief, /非目标：\n1\. 不重构认证模块/);
  assert.match(brief, /边界：本目标仅供理解与验收对照，不扩大执行范围/);
  assert.match(brief, /一律记录上报/);
  assert.equal(brief, goalBriefOf(rcx), "纯机械拼接，同输入同输出");
  assert.doesNotMatch(brief, /你的目标/, "授权式措辞不得出现");
});

test("goalBriefOf：条数超限截断并标注", () => {
  const rcx = { runDir: runDirWith({ ...CONTRACT,
    success_criteria: Array.from({ length: 9 }, (_, i) => "标准" + (i + 1)),
    constraints: Array.from({ length: 9 }, (_, i) => "约束" + (i + 1)) }) };
  const brief = goalBriefOf(rcx);
  assert.match(brief, /8\. 标准8/);
  assert.doesNotMatch(brief, /标准9/);
  assert.match(brief, /（成功标准已截断 1 条）/);
  assert.match(brief, /（约束已截断 1 条）/);
});

test("goalBriefOf：2K 字符硬顶截断标注", () => {
  const rcx = { runDir: runDirWith({ ...CONTRACT, goal: "长".repeat(2200) }) };
  const brief = goalBriefOf(rcx);
  assert.ok(brief.length <= 2000 + "\n（投影超 2000 字，已截断）".length);
  assert.match(brief, /（投影超 2000 字，已截断）$/);
});

test("goalBriefOf：轻量形态只有目标一句+边界，不含标准/约束明细", () => {
  const brief = goalBriefOf({ runDir: runDirWith(CONTRACT) }, { light: true });
  assert.match(brief, /目标：修复登录后刷新偶发退出的问题/);
  assert.match(brief, /边界：/);
  assert.doesNotMatch(brief, /成功标准：/);
  assert.doesNotMatch(brief, /约束：/);
  assert.doesNotMatch(brief, /非目标：/);
});

test("goalBriefOf：旧 run 无 goal 字段兜底（phenomenon+scope）；01 缺失/损坏返回空串", () => {
  const legacy = { ...CONTRACT };
  delete legacy.goal;
  const brief = goalBriefOf({ runDir: runDirWith(legacy) });
  assert.match(brief, /目标（goal 缺失，兜底生成）：刷新后偶发退出；影响模块 Auth、Session/);
  const broken = mkdtempSync(join(root, "run-"));
  writeFileSync(join(broken, "01-issue-analysis.json"), "{oops");
  assert.equal(goalBriefOf({ runDir: broken }), "");
  assert.equal(goalBriefOf({ runDir: runDirWith(null) }), "");
});

test("P3/P4/P5：决策层 prompt 头部注入完整投影；旧 run（无 01）不注入不报错", async () => {
  const seen = {};
  const llm = {
    complete: async ({ user }) => { seen.p3 = user; return "# 报告"; },
    completeJson: async ({ user, required }) => {
      seen[required.includes("hypotheses") ? "p4" : "p5"] = user;
      return required.includes("hypotheses")
        ? { hypotheses: [{ id: "A", title: "t", evidence: "e", verify_file: "f", verify_method: "m" }] }
        : { nodes: [{ id: "T1", title: "t", input: "i", output: "o", deps: [], success_criteria: "s", risk: "low" }] };
    },
  };
  const runDir = runDirWith(CONTRACT);
  writeFileSync(join(runDir, "02-search-candidates.json"), JSON.stringify({ candidates: [{ path: "src/guard.ts" }] }));
  await p3({ runDir, repoDir, llm, reviewComment: "" });
  writeFileSync(join(runDir, "03-code-understanding.md"), "# 报告");
  await p4({ runDir, repoDir, llm, reviewComment: "" });
  writeFileSync(join(runDir, "04-hypotheses.json"), '{"hypotheses":[{"id":"A"}]}');
  await p5({ runDir, repoDir, llm, reviewComment: "" });
  for (const key of ["p3", "p4", "p5"]) {
    assert.match(seen[key], /【全局目标（背景，仅供理解与验收对照）】/, key);
    assert.match(seen[key], /成功标准：/, key);
    assert.match(seen[key], /^【全局目标/, key + "：投影在 prompt 头部");
  }
  // 旧 run 兼容：无 01 时三阶段照常执行（既有用例已覆盖产物正确性，这里只验不注入不抛错）
  const legacyDir = runDirWith(null);
  writeFileSync(join(legacyDir, "02-search-candidates.json"), JSON.stringify({ candidates: [{ path: "src/guard.ts" }] }));
  await p3({ runDir: legacyDir, repoDir, llm, reviewComment: "" });
  assert.doesNotMatch(seen.p3, /【全局目标/);
});

test("P6 builtin：派单完整投影，coder 轻量形态（无标准/约束明细）", async () => {
  const runDir = runDirWith(CONTRACT);
  writeFileSync(join(runDir, "05-task-graph.json"), JSON.stringify({ nodes: [{ id: "T1", title: "守卫加 await", deps: [] }] }));
  const calls = [];
  const llm = {
    completeJson: async (req) => {
      calls.push({ kind: "json", user: req.user });
      return String(req.user).includes("【diff 清单】")
        ? { verdict: "pass", notes: "ok" }
        : { assignments: [{ node: "T1", file: "src/guard.ts", note: "加 await" }] };
    },
    complete: async (req) => { calls.push({ kind: "text", user: req.user });
      return "--- a/src/guard.ts\n+++ b/src/guard.ts\n@@ -1 +1 @@\n-restoreSession();\n+await restoreSession();"; },
  };
  await p6({ runDir, repoDir, llm, reviewComment: "", p6Mode: "builtin" });
  const planner = calls.find((c) => c.kind === "json" && !String(c.user).includes("【diff 清单】"));
  const coder = calls.find((c) => c.kind === "text");
  assert.match(planner.user, /成功标准：/, "派单是方向性映射，用完整投影");
  assert.match(coder.user, /目标：修复登录后刷新偶发退出的问题/, "coder 轻量形态含目标一句");
  assert.match(coder.user, /边界：/, "coder 轻量形态含边界声明");
  assert.doesNotMatch(coder.user, /成功标准：/, "coder 不得看到标准明细（防扩权）");
  assert.doesNotMatch(coder.user, /约束：/);
});

test("P6 session/claude：任务包与执行 prompt 均含完整投影（委外可见全仓库，边界必带）", async () => {
  const runDir = runDirWith(CONTRACT);
  writeFileSync(join(runDir, "05-task-graph.json"), JSON.stringify({ nodes: [{ id: "T1", title: "守卫加 await", deps: [] }] }));
  const llm = { completeJson: async () => { throw new Error("不应被调用"); }, complete: async () => { throw new Error("不应被调用"); } };
  await p6({ runDir, repoDir, llm, reviewComment: "", p6Mode: "session" });
  const task = readFileSync(join(runDir, "06-implementation", "session-task.md"), "utf8");
  assert.match(task, /【全局目标（背景，仅供理解与验收对照）】/);
  assert.match(task, /非目标：\n1\. 不重构认证模块/);
  assert.match(task, /边界：/);

  // claude 自动委外：执行 prompt 与任务包同口径
  const gitDir = mkdtempSync(join(root, "gitrepo-"));
  const git = (args) => execFileSync("git", args, { cwd: gitDir, stdio: "pipe" });
  git(["init"]); git(["config", "user.email", "t@t"]); git(["config", "user.name", "t"]);
  writeFileSync(join(gitDir, "x"), "a\n");
  git(["add", "."]); git(["commit", "-m", "baseline"]);
  const runDir2 = runDirWith(CONTRACT);
  writeFileSync(join(runDir2, "05-task-graph.json"), JSON.stringify({ nodes: [{ id: "T1", title: "守卫加 await", deps: [] }] }));
  let prompt = "";
  const spawnExternal = async (opts) => {
    prompt = opts.prompt;
    mkdirSync(join(runDir2, "06-implementation", "patches"), { recursive: true });
    writeFileSync(join(runDir2, "06-implementation", "patches", "0001-T1.diff"), "--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n");
    writeFileSync(join(runDir2, "06-implementation", "coder-report.json"),
      JSON.stringify({ tasks: [{ node: "T1", status: "patched", patch: "06-implementation/patches/0001-T1.diff" }] }));
    return { code: 0, stdout: '{"result":"ok"}', stderr: "" };
  };
  await p6({ runDir: runDir2, repoDir: gitDir, run: { id: "r", stages: {} }, llm, reviewComment: "", p6Mode: "claude", spawnExternal });
  assert.match(prompt, /全局目标（背景，仅供理解与验收对照）/);
  assert.match(prompt, /成功标准：/, "委外用完整投影");
  assert.match(prompt, /边界：/);
});
