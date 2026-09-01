// tests/delegate-verify.test.js — A4 修正回归：委外产物验证（结构完整 + HEAD 基线应用性演练）
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { verifyDelegateResult } from "../../lib/delegate/delegateVerify.js";

const root = mkdtempSync(join(tmpdir(), "i2p-dverify-"));
function gitInit(dir) {
  mkdirSync(dir, { recursive: true });
  const git = (args) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
  git(["init"]); git(["config", "user.email", "t@t"]); git(["config", "user.name", "t"]);
  git(["config", "core.autocrlf", "false"]);
  return git;
}
// 真实可用补丁：改文件 → git diff 采集 → 还原
function makePatch(repoDir, rel, next) {
  const abs = join(repoDir, rel);
  const before = readFileSync(abs, "utf8");
  writeFileSync(abs, next);
  const diff = execFileSync("git", ["diff", "--", rel], { cwd: repoDir }).toString();
  writeFileSync(abs, before);
  return diff;
}
function mkRun() {
  const runDir = mkdtempSync(join(root, "run-"));
  mkdirSync(join(runDir, "06-implementation", "patches"), { recursive: true });
  return runDir;
}

test("P6 验证：无补丁 = 未拿到委外结果（不允许放行）", async () => {
  const runDir = mkRun();
  const v = await verifyDelegateResult({ runDir }, "P6");
  assert.equal(v.ok, false);
  assert.match(v.errors.join("；"), /未检测到补丁/);
});

test("P6 结构验证：空补丁 / 非 diff 内容 / 坏 report / 清单缺文件 逐一拦截", async () => {
  const runDir = mkRun();
  writeFileSync(join(runDir, "06-implementation", "patches", "0001.diff"), "");
  let v = await verifyDelegateResult({ runDir }, "P6");
  assert.equal(v.ok, false); assert.match(v.errors.join("；"), /内容为空/);

  writeFileSync(join(runDir, "06-implementation", "patches", "0001.diff"), "这是一段普通文本，不是补丁");
  v = await verifyDelegateResult({ runDir }, "P6");
  assert.equal(v.ok, false); assert.match(v.errors.join("；"), /不是 unified diff/);

  writeFileSync(join(runDir, "06-implementation", "patches", "0001.diff"), "--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n");
  writeFileSync(join(runDir, "06-implementation", "coder-report.json"), "{not json");
  v = await verifyDelegateResult({ runDir }, "P6");
  assert.equal(v.ok, false); assert.match(v.errors.join("；"), /coder-report\.json 不是合法 JSON/);

  // report 清单指向不存在的补丁文件（P7 应用时必炸的形态）
  writeFileSync(join(runDir, "06-implementation", "coder-report.json"),
    JSON.stringify({ patches: [{ node: "T1", patch: "06-implementation/patches/gone.diff" }] }));
  v = await verifyDelegateResult({ runDir }, "P6");
  assert.equal(v.ok, false); assert.match(v.errors.join("；"), /gone\.diff 不存在/);
});

test("P6 验证：清单路径越界返回结构化失败而非抛异常", async () => {
  const runDir = mkRun();
  writeFileSync(join(runDir, "06-implementation", "coder-report.json"),
    JSON.stringify({ patches: [{ patch: "../../outside.diff" }] }));

  const v = await verifyDelegateResult({ runDir }, "P6");

  assert.equal(v.ok, false);
  assert.match(v.errors.join("；"), /非法路径|越界/);
});

test("P6 验证：无仓库环境仅结构验证（补丁形态合法即过，不演练）", async () => {
  const runDir = mkRun();
  writeFileSync(join(runDir, "06-implementation", "patches", "0001.diff"), "--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n");
  const v = await verifyDelegateResult({ runDir }, "P6");
  assert.equal(v.ok, true);
  assert.equal(v.rehearsal, false, "无 repoDir 不做应用性演练");
});

test("P6 应用性演练：合法补丁对 HEAD 基线可应用 → ok；不可应用补丁 → 显式拦截", async () => {
  const repoDir = mkdtempSync(join(root, "repo-"));
  const git = gitInit(repoDir);
  writeFileSync(join(repoDir, "a.txt"), "line1\n");
  git(["add", "."]); git(["commit", "-m", "init"]);

  const runDir = mkRun();
  const diff = makePatch(repoDir, "a.txt", "line1-fixed\n");
  writeFileSync(join(runDir, "06-implementation", "patches", "0001-T1.diff"), diff);
  let v = await verifyDelegateResult({ runDir, repoDir }, "P6");
  assert.equal(v.ok, true, "合法补丁应通过演练");
  assert.equal(v.rehearsal, true);
  assert.equal(v.patches, 1);

  // 上下文不匹配（对不存在的文件打补丁）→ 演练失败并给出 git 原始原因
  const bad = diff.replace(/a\.txt/g, "no-such-file.txt").replace(/b\.txt/g, "no-such-file.txt");
  const runDir2 = mkRun();
  writeFileSync(join(runDir2, "06-implementation", "patches", "0001-T1.diff"), bad);
  v = await verifyDelegateResult({ runDir: runDir2, repoDir }, "P6");
  assert.equal(v.ok, false);
  assert.match(v.errors.join("；"), /无法应用到 HEAD 基线/);
});

test("P6 应用性演练：多补丁按序在前序之上验证（P7 同语义）——后继补丁单独存在时应失败", async () => {
  const repoDir = mkdtempSync(join(root, "repo-seq-"));
  const git = gitInit(repoDir);
  writeFileSync(join(repoDir, "a.txt"), "line1\n");
  git(["add", "."]); git(["commit", "-m", "init"]);

  // patch1: line1 → line1-A（对 HEAD 可应用）
  const p1 = makePatch(repoDir, "a.txt", "line1-A\n");
  // patch2: line1-A → line1-A-B（只对「patch1 已应用」的状态可应用）
  const p2raw = (() => {
    // 先把 patch1 暂存进 index，git diff（index ↔ 工作区）即得「以 patch1 已应用为基」的补丁
    execFileSync("git", ["apply", "--cached", "-"], { cwd: repoDir, input: p1, stdio: ["pipe", "pipe", "pipe"] });
    writeFileSync(join(repoDir, "a.txt"), "line1-A-B\n");
    const d = execFileSync("git", ["diff", "--", "a.txt"], { cwd: repoDir }).toString();
    execFileSync("git", ["reset", "-q", "--hard"], { cwd: repoDir, stdio: "pipe" }); // index+工作区还原 HEAD
    return d;
  })();

  // 单独给 patch2：对 HEAD 不可应用 → 拦截（不因「文件存在」放行）
  const runAlone = mkRun();
  writeFileSync(join(runAlone, "06-implementation", "patches", "0002-T2.diff"), p2raw);
  const vAlone = await verifyDelegateResult({ runDir: runAlone, repoDir }, "P6");
  assert.equal(vAlone.ok, false, "后继补丁脱离前序应验证失败");

  // 按应用序给 patch1 + patch2：在前序之上演练 → 通过
  const runSeq = mkRun();
  writeFileSync(join(runSeq, "06-implementation", "patches", "0001-T1.diff"), p1);
  writeFileSync(join(runSeq, "06-implementation", "patches", "0002-T2.diff"), p2raw);
  const vSeq = await verifyDelegateResult({ runDir: runSeq, repoDir }, "P6");
  assert.equal(vSeq.ok, true, "按序演练应通过");
  assert.equal(vSeq.patches, 2);
});

test("P6 演练：repoDir 存在但非 git 仓库 → 显式失败（生产不变式破坏不放行）", async () => {
  const notGit = mkdtempSync(join(root, "notgit-"));
  const runDir = mkRun();
  writeFileSync(join(runDir, "06-implementation", "patches", "0001.diff"), "--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n");
  const v = await verifyDelegateResult({ runDir, repoDir: notGit }, "P6");
  assert.equal(v.ok, false);
  assert.match(v.errors.join("；"), /无法执行应用性演练/);
});

test("其余委托阶段轻验证：缺产物 / 空内容 / 坏 JSON 拦截；合法产物放行", async () => {
  const runDir = mkRun();
  let v = await verifyDelegateResult({ runDir }, "P1");
  assert.equal(v.ok, false); assert.match(v.errors.join("；"), /尚未产出/);

  writeFileSync(join(runDir, "01-issue-analysis.json"), "");
  v = await verifyDelegateResult({ runDir }, "P1");
  assert.equal(v.ok, false); assert.match(v.errors.join("；"), /内容为空/);

  writeFileSync(join(runDir, "01-issue-analysis.json"), "{oops");
  v = await verifyDelegateResult({ runDir }, "P1");
  assert.equal(v.ok, false); assert.match(v.errors.join("；"), /不是合法 JSON/);

  writeFileSync(join(runDir, "01-issue-analysis.json"), "{\"phenomenon\":\"ok\"}");
  v = await verifyDelegateResult({ runDir }, "P1");
  assert.equal(v.ok, true);
});
