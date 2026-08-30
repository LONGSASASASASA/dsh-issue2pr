// lib/delegateVerify.js — 委外产物验证（审查报告 A4 修正：拿到结果 + 验证 ok 才往下流转）
// 设计原则（第一性）：流水线放行一个委托阶段前，唯一可信的依据不是"文件存在"，
// 而是"产物可用"——即下游阶段拿它当输入时不会必然失败。因此验证分两层：
//   1) 结构完整（拿到结果）：补丁清单与 P7 完全同口径（collectPatches），逐份存在、
//      非空、形如 unified diff；coder-report.json 若存在必须可解析。
//   2) 可应用性演练（验证 ok）：用临时 GIT_INDEX_FILE 从 HEAD 构建一次性索引，
//      按应用序逐份 `git apply --cached` 演练——不碰工作区、不依赖工作区是否干净，
//      语义与 P7（reset 到 HEAD 后顺序 apply）完全一致。
// 无 repoDir（纯单测裸 rcx）时退化为仅结构验证；repoDir 存在但非 git 仓库 → 显式验证失败。
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readArtifact } from "../core/store.js";
import { STAGE_DEFS } from "../core/stageConfig.js";
import { collectPatches } from "../stages/p7-patch.js";

const firstLine = (s) => String(s || "").split("\n").find((l) => l.trim()) || "";

function execGit(args, { cwd, env, input }) {
  return new Promise((resolve, reject) => {
    const child = execFile("git", args, {
      cwd, env,
      timeout: 60000, windowsHide: true, maxBuffer: 16 * 1024 * 1024,
    }, (err, stdout, stderr) => {
      if (err) { err.stderr = String(stderr || err.message); reject(err); }
      else resolve(String(stdout || ""));
    });
    child.stdin?.on?.("error", () => {}); // EPIPE 不掩盖主错误
    child.stdin.end(input == null ? "" : input); // execFile 无 input 选项，须手写 stdin
  });
}

// 形如 unified diff：git 风格（diff --git）或 patch 风格（--- / +++ 头）
function looksLikeDiff(text) {
  const t = String(text);
  return /^diff --git /m.test(t) || (/^--- /m.test(t) && /^\+\+\+ /m.test(t));
}

// —— P6 深验证：结构 +（有仓库时）应用性演练 ——
async function verifyP6(rcx) {
  const { runDir } = rcx;
  const errors = [];
  // coder-report.json 存在时必须可解析（先于清单解析：坏 JSON 在此拦截并给出可定位错误，
  // 而不是让 collectPatches/P7 在 JSON.parse 处崩出裸 SyntaxError）
  const reportPath = join(runDir, "06-implementation", "coder-report.json");
  if (existsSync(reportPath)) {
    try { JSON.parse(readFileSync(reportPath, "utf8")); }
    catch (e) { errors.push("coder-report.json 不是合法 JSON: " + String((e && e.message) || e)); }
  }
  const patches = errors.length ? [] : collectPatches(runDir); // 与 P7 应用口径 1:1：验证的就是 P7 将要应用的
  if (!patches.length) errors.push("未检测到补丁（coder-report.json 未列出补丁且 patches/*.diff 为空）——未拿到委外结果");

  const contents = [];
  for (const p of patches) {
    const text = readArtifact(runDir, p.patch);
    if (text == null) { errors.push(p.patch + " 不存在（coder-report 清单与实际文件不一致）"); contents.push(null); continue; }
    if (!String(text).trim()) { errors.push(p.patch + " 内容为空"); contents.push(null); continue; }
    if (!looksLikeDiff(text)) { errors.push(p.patch + " 不是 unified diff（缺 ---/+++ 或 diff --git 头）"); contents.push(null); continue; }
    contents.push(String(text));
  }

  // 应用性演练：仅在结构完好时执行（缺文件的演练只会产生噪音）
  let rehearsal = false;
  if (!errors.length && patches.length) {
    if (!rcx.repoDir || !existsSync(rcx.repoDir)) {
      // 无仓库环境（纯单测 / 测试钩子跳过仓库准备）：仅结构验证。
      // 生产路径 drive 在 P2-P6 前必保仓库就位；仓库目录缺失时由 P7 的
      // resetRepoClean 显式失败兜底，此处不重复拦截。
    } else {
      rehearsal = true;
      const r = await rehearseApply(rcx.repoDir, patches.map((p, i) => ({ rel: p.patch, content: contents[i] })));
      if (!r.ok) errors.push(...r.errors);
    }
  }
  return { ok: !errors.length, errors, patches: patches.length, rehearsal };
}

// —— 临时索引演练：read-tree HEAD → 顺序 apply --cached（后续补丁在前序之上验证）——
async function rehearseApply(repoDir, patches) {
  let tmp = null;
  try {
    try { await execGit(["rev-parse", "--git-dir"], { cwd: repoDir }); }
    catch (e) { return { ok: false, errors: ["无法执行应用性演练（repoDir 非 git 仓库）: " + firstLine(e.stderr || e.message)] }; }
    tmp = mkdtempSync(join(tmpdir(), "i2p-verify-"));
    const env = { ...process.env, GIT_INDEX_FILE: join(tmp, "index") };
    await execGit(["read-tree", "HEAD"], { cwd: repoDir, env }); // 一次性索引 = HEAD 基线
    const errors = [];
    for (const p of patches) {
      try {
        // 临时索引可丢弃：直接 apply 即检查（成功即变更索引，后续补丁在前序之上演练，
        // 与 P7 reset→顺序 apply 的真实语义一致）
        await execGit(["apply", "--cached", "-"], { cwd: repoDir, env, input: p.content });
      } catch (e) {
        errors.push(p.rel + " 无法应用到 HEAD 基线: " + firstLine(e.stderr || e.message));
      }
    }
    return { ok: !errors.length, errors };
  } catch (e) {
    return { ok: false, errors: ["补丁应用性演练失败: " + String((e && e.stderr) || (e && e.message) || e)] };
  } finally {
    if (tmp) { try { rmSync(tmp, { recursive: true, force: true }); } catch { /* 尽力 */ } }
  }
}

// —— 其余委托阶段轻验证：产物存在、非空；.json 契约必须可解析 ——
function verifyFileStage(rcx, stageId) {
  const output = STAGE_DEFS[stageId]?.delegateSpec?.output;
  if (!output || output.endsWith("/")) return { ok: true, errors: [], patches: 0, rehearsal: false };
  const errors = [];
  const text = readArtifact(rcx.runDir, output);
  if (text == null) errors.push(output + " 尚未产出——未拿到委外结果");
  else if (!String(text).trim()) errors.push(output + " 内容为空");
  else if (output.endsWith(".json")) {
    try { JSON.parse(String(text)); }
    catch (e) { errors.push(output + " 不是合法 JSON: " + String((e && e.message) || e)); }
  }
  return { ok: !errors.length, errors, patches: text == null ? 0 : 1, rehearsal: false };
}

// 入口：委托阶段产物验证。返回 { ok, errors[], patches, rehearsal }
// 调用方（applyReview / advance / 全自动 watcher / P7 兜底）必须 ok===true 才放行流转。
export async function verifyDelegateResult(rcx, stageId) {
  return stageId === "P6" ? await verifyP6(rcx) : verifyFileStage(rcx, stageId);
}
