// tests/repo-state.test.js — 仓库基线重置与 per-Run worktree（审查报告 A1/A3 修复）
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { baseRepoDir, runRepoDir, resetRepoClean, ensureWorktree, removeWorktree } from "../lib/repoState.js";

const root = mkdtempSync(join(tmpdir(), "i2p-repostate-"));
function gitInit(dir) {
  mkdirSync(dir, { recursive: true });
  const git = (args) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
  git(["init"]); git(["config", "user.email", "t@t"]); git(["config", "user.name", "t"]);
  git(["config", "core.autocrlf", "false"]); // 与 p7 测试同因：避免行尾转换掩盖语义
  return git;
}

test("resetRepoClean：回滚跟踪修改、清未跟踪文件、保留 .gitignore 目录", async () => {
  const dir = mkdtempSync(join(root, "reset-"));
  const git = gitInit(dir);
  writeFileSync(join(dir, "a.txt"), "line1\n");
  writeFileSync(join(dir, ".gitignore"), "node_modules\n");
  git(["add", "."]); git(["commit", "-m", "init"]);
  // 模拟补丁已应用 + 未跟踪残留 + 测试依赖目录
  writeFileSync(join(dir, "a.txt"), "line1-patched\n");
  writeFileSync(join(dir, "patch-new-file.txt"), "untracked");
  mkdirSync(join(dir, "node_modules"), { recursive: true });
  writeFileSync(join(dir, "node_modules", "keep.txt"), "dep");
  await resetRepoClean(dir);
  assert.equal(readFileSync(join(dir, "a.txt"), "utf8"), "line1\n", "跟踪文件回到 HEAD 基线");
  assert.equal(existsSync(join(dir, "patch-new-file.txt")), false, "未跟踪残留被清除");
  assert.equal(existsSync(join(dir, "node_modules", "keep.txt")), true, ".gitignore 目录保留（不重复装依赖）");
});

test("resetRepoClean：非 git 目录报清晰错误（不静默）", async () => {
  const dir = mkdtempSync(join(root, "notgit-"));
  await assert.rejects(() => resetRepoClean(dir), /仓库基线重置失败/);
});

test("ensureWorktree：基线缺失兜底返回基线路径；有基线则建 per-Run worktree（幂等），删除 Run 一并移除", async () => {
  const root2 = mkdtempSync(join(root, "wt-"));
  const slug = "p", runId = "r1";
  // 基线不存在：不抛错，返回基线路径（克隆失败路径由 drive 处理）
  assert.equal(await ensureWorktree(root2, slug, runId), baseRepoDir(root2, slug));
  // 建真实基线仓库
  const git = gitInit(baseRepoDir(root2, slug));
  writeFileSync(join(baseRepoDir(root2, slug), "a.txt"), "line1\n");
  git(["add", "."]); git(["commit", "-m", "init"]);
  const logs = [];
  const wt = await ensureWorktree(root2, slug, runId, (ev) => logs.push(ev));
  assert.equal(wt, runRepoDir(root2, slug, runId), "返回 worktree 路径");
  assert.ok(existsSync(join(wt, ".git")), "worktree 就位");
  assert.equal(readFileSync(join(wt, "a.txt"), "utf8"), "line1\n", "worktree 是基线 HEAD 的检出");
  assert.ok(logs.some((e) => /worktree add/.test(e.name)), "记录事件");
  assert.equal(await ensureWorktree(root2, slug, runId), wt, "幂等：已存在直接复用");
  // worktree 内脏改不影响基线（A3 隔离证据）
  writeFileSync(join(wt, "a.txt"), "dirty\n");
  assert.equal(readFileSync(join(baseRepoDir(root2, slug), "a.txt"), "utf8"), "line1\n", "基线不被 worktree 污染");
  await removeWorktree(root2, slug, runId);
  assert.equal(existsSync(join(wt, ".git")), false, "Run 删除后 worktree 移除");
  await removeWorktree(root2, slug, runId); // 再删不抛
});
