// lib/repoState.js — 仓库工作区基线与 per-Run worktree 管理（审查报告 A1/A3 修复）
// 目录职责：
//   projects/<slug>/repo            基线克隆（git clone --depth 1 一次，作为只读基准）
//   projects/<slug>/worktrees/<id>  每 Run 独立 worktree（P7 应用补丁 / P8 测试 / 外部智能体都在这里工作）
// per-Run worktree 让同项目并发 Run 的仓库状态互不污染；Run 删除时一并移除。
// worktree 创建失败时兜底回退基线 repo（配合 drive 的项目级互斥，仍保证不交错写）。
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

function execGit(args, cwd, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd, timeout: timeoutMs, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) { err.stderr = String(stderr || err.message); reject(err); }
      else resolve(String(stdout || ""));
    });
  });
}

export function baseRepoDir(root, slug) { return join(root, "projects", slug, "repo"); }
export function runRepoDir(root, slug, runId) { return join(root, "projects", slug, "worktrees", runId); }

// 工作区重置回 HEAD 基线：清掉已应用补丁（跟踪文件修改）与未跟踪文件。
// 不加 -x：保留 .gitignore 忽略的目录（如 node_modules，避免测试依赖反复安装）。
export async function resetRepoClean(repoDir) {
  try {
    await execGit(["reset", "--hard", "HEAD"], repoDir, 60000);
    await execGit(["clean", "-fd"], repoDir, 60000);
  } catch (e) {
    throw new Error("仓库基线重置失败(git reset/clean): " + String((e && e.stderr) || (e && e.message) || e));
  }
}

// 确保 per-Run worktree 存在（幂等）。返回实际使用的仓库目录：
// 成功 → worktree 路径；基线仓库未就绪 / 创建失败 → 兜底返回基线 repo 路径（绝不抛错，由调用方日志呈现）。
export async function ensureWorktree(root, slug, runId, log) {
  const base = baseRepoDir(root, slug);
  const wt = runRepoDir(root, slug, runId);
  if (existsSync(join(wt, ".git"))) return wt; // worktree 的 .git 是文件，existsSync 同样命中
  if (!existsSync(join(base, ".git"))) return base; // 基线尚未克隆（克隆失败路径由调用方处理）
  try {
    await execGit(["worktree", "add", "--detach", wt, "HEAD"], base);
    log?.({ kind: "git", name: "git worktree add", detail: "Run 独立工作区: " + wt });
    return wt;
  } catch (e) {
    log?.({ kind: "git", name: "git worktree add 失败（兜底共用基线仓库）", ok: false,
      detail: String((e && e.stderr) || (e && e.message) || e).slice(0, 500) });
    return base;
  }
}

// Run 删除时尽力移除其 worktree（失败不抛：孤儿 worktree 可由 git worktree prune 收敛）
export async function removeWorktree(root, slug, runId) {
  const base = baseRepoDir(root, slug);
  const wt = runRepoDir(root, slug, runId);
  if (!existsSync(wt) || !existsSync(join(base, ".git"))) return;
  try { await execGit(["worktree", "remove", "--force", wt], base); } catch { /* 尽力 */ }
  try { await execGit(["worktree", "prune"], base); } catch { /* 尽力 */ }
}
