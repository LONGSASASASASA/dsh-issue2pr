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
import { verifyPatchEvidence } from "../infra/patchEvidence.js";

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
export function looksLikeDiff(text) {
  const t = String(text);
  return /^diff --git /m.test(t) || (/^--- /m.test(t) && /^\+\+\+ /m.test(t));
}

function validateP6TaskReport(runDir, report) {
  if (!report || !Object.prototype.hasOwnProperty.call(report, "tasks")) return [];
  if (!Array.isArray(report.tasks)) return ["coder-report.json tasks 必须是数组"];

  const errors = [];
  const results = new Map();
  for (const task of report.tasks) {
    const node = String(task?.node || "").trim();
    if (!node) {
      errors.push("coder-report.json tasks 存在缺少 node 的任务结果");
      continue;
    }
    if (results.has(node)) {
      errors.push("coder-report.json tasks 存在重复任务结果: " + node);
      continue;
    }
    results.set(node, task);

    const status = task?.status;
    if (!["patched", "no_change", "failed"].includes(status)) {
      errors.push(node + " status 无效（仅允许 patched|no_change|failed）");
    } else if (status === "patched" && (typeof task.patch !== "string" || !task.patch.trim())) {
      errors.push(node + " status=patched 但未声明 patch");
    } else if (status === "no_change") {
      if (typeof task.reason !== "string" || !task.reason.trim()) {
        errors.push(node + " status=no_change 但未说明原因");
      }
      if (typeof task.patch === "string" && task.patch.trim()) {
        errors.push(node + " status=no_change 不应声明 patch");
      }
    } else if (status === "failed") {
      errors.push(node + " status=failed" + (task.reason ? ": " + task.reason : ""));
    }
  }

  const graphText = readArtifact(runDir, "05-task-graph.json");
  if (graphText != null) {
    try {
      const graph = JSON.parse(String(graphText));
      const expected = Array.isArray(graph.nodes)
        ? graph.nodes.map((node) => String(node?.id || "").trim()).filter(Boolean)
        : [];
      const expectedSet = new Set(expected);
      for (const node of expected) {
        if (!results.has(node)) errors.push("coder-report.json 缺少任务结果: " + node);
      }
      for (const node of results.keys()) {
        if (expected.length && !expectedSet.has(node)) errors.push("coder-report.json 包含未知任务结果: " + node);
      }
    } catch (error) {
      errors.push("05-task-graph.json 不是合法 JSON: " + String(error?.message || error));
    }
  }
  return errors;
}

// —— P6 深验证：结构 +（有仓库时）应用性演练 ——
async function verifyP6(rcx) {
  const { runDir } = rcx;
  const errors = [];
  // coder-report.json 存在时必须可解析（先于清单解析：坏 JSON 在此拦截并给出可定位错误，
  // 而不是让 collectPatches/P7 在 JSON.parse 处崩出裸 SyntaxError）
  const reportPath = join(runDir, "06-implementation", "coder-report.json");
  let report = null;
  if (existsSync(reportPath)) {
    try {
      report = JSON.parse(readFileSync(reportPath, "utf8"));
      errors.push(...validateP6TaskReport(runDir, report));
    }
    catch (e) { errors.push("coder-report.json 不是合法 JSON: " + String((e && e.message) || e)); }
  }
  let patches = [];
  if (!errors.length) {
    try {
      patches = collectPatches(runDir); // 与 P7 应用口径 1:1：验证的就是 P7 将要应用的
    } catch (error) {
      errors.push("补丁清单验证失败: " + String(error?.message || error));
    }
  }
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

const P11_EVAL_KEYS = ["ROOT", "PATCH", "TEST", "DIFF", "DESC", "ACCEPT"];

async function verifyP11(rcx) {
  const evidence = await verifyPatchEvidence(rcx);
  const errors = [...evidence.errors];
  const description = readArtifact(rcx.runDir, "10-pr-description.md");
  if (description == null) errors.push("10-pr-description.md 尚未产出——未拿到委外结果");
  else if (!String(description).trim()) errors.push("10-pr-description.md 内容为空");

  const evalText = readArtifact(rcx.runDir, "11-eval-report.json");
  let evalReport = null;
  if (evalText == null) {
    errors.push("11-eval-report.json 尚未产出——未拿到委外结果");
  } else if (!String(evalText).trim()) {
    errors.push("11-eval-report.json 内容为空");
  } else {
    try {
      evalReport = JSON.parse(String(evalText));
    } catch (error) {
      errors.push("11-eval-report.json 不是合法 JSON: " + String(error.message || error));
    }
    if (evalReport && (typeof evalReport !== "object" || Array.isArray(evalReport))) {
      errors.push("11-eval-report.json 顶层必须是对象");
      evalReport = null;
    }
    if (evalReport) {
      for (const key of P11_EVAL_KEYS) {
        if (evalReport[key] !== "pass" && evalReport[key] !== "fail") {
          errors.push("11-eval-report.json 缺少有效 " + key + " 结论（仅允许 pass|fail）");
        } else if (evalReport[key] !== "pass") {
          errors.push("11-eval-report.json " + key + " 门控未通过");
        }
      }
    }
  }
  return {
    ok: errors.length === 0,
    errors,
    patches: Array.isArray(evidence.patches) ? evidence.patches.length : 0,
    rehearsal: !evidence.skipped,
    patchEvidence: evidence,
  };
}

// 入口：委托阶段产物验证。返回 { ok, errors[], patches, rehearsal }
// 调用方（applyReview / advance / 全自动 watcher / P7 兜底）必须 ok===true 才放行流转。
export async function verifyDelegateResult(rcx, stageId) {
  if (stageId === "P6") return await verifyP6(rcx);
  if (stageId === "P11") return await verifyP11(rcx);
  return verifyFileStage(rcx, stageId);
}
