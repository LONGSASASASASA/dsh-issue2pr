// lib/stages/helpers.js — 各阶段通用辅助（读触发文档 / 列仓库文件 / 读文件 / 取上游产物 / 过程事件 / 委托外部）
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import { appendArtifactLine, writeArtifact } from "../core/store.js";
import { stageDelegated, buildDelegateTask } from "../core/stageConfig.js";
import { matchConnection } from "../infra/connections.js";

// 过程事件：追加到 runDir/trace/events.jsonl（UI 阶段详情按 stage 过滤展示）。
// kind：stage | llm | git | test | tool | info；detail 截断 2000 字防膨胀。
// 身份字段（TASK-01）：stageExecutionId 从当前阶段执行状态解析（区分阶段重跑）；
// callId / attemptId / attempt / retryOf / retryReason 由 LLM 事件钩子传入（区分调用重试）。
// TASK-10：摘要事件补完整日志引用（logRef = journal 目录）与留档完整性（logIntegrity），
// 正文全文不进摘要——从 logRef 可回溯完整请求/响应。
const boundedId = (v) => (typeof v === "string" && v ? v.slice(0, 64) : null);
const LOG_INTEGRITIES = ["complete", "partial", "write_failed", "corrupt", "open"];
export function logEvent(rcx, ev) {
  if (!rcx || !rcx.runDir) return;
  try {
    const stage = (rcx.run && rcx.run.current) || null;
    const stageExecId = stage ? (rcx.run?.stages?.[stage]?.stageExecutionId || null) : null;
    appendArtifactLine(rcx.runDir, "trace/events.jsonl", {
      at: new Date().toISOString(),
      stage,
      ...(stageExecId ? { stageExecutionId: stageExecId } : {}),
      kind: ev.kind || "info",
      name: String(ev.name || "").slice(0, 200),
      detail: String(ev.detail == null ? "" : ev.detail).slice(0, 2000),
      ms: typeof ev.ms === "number" ? Math.round(ev.ms) : null,
      ok: ev.ok !== false,
      ...(boundedId(ev.callId) ? { callId: boundedId(ev.callId) } : {}),
      ...(boundedId(ev.attemptId) ? { attemptId: boundedId(ev.attemptId) } : {}),
      ...(Number.isInteger(ev.attempt) ? { attempt: ev.attempt } : {}),
      ...(boundedId(ev.retryOf) ? { retryOf: boundedId(ev.retryOf) } : {}),
      ...(ev.retryReason ? { retryReason: String(ev.retryReason).slice(0, 200) } : {}),
      ...(typeof ev.logDir === "string" && ev.logDir ? { logRef: ev.logDir.slice(0, 200) } : {}),
      ...(LOG_INTEGRITIES.includes(ev.logIntegrity) ? { logIntegrity: ev.logIntegrity } : {}),
    });
  } catch { /* 事件写盘失败不影响主流程 */ }
}

export async function readTriggerText(rcx) {
  const uri = rcx.trigger.uri;
  if (/^https?:\/\//.test(uri)) {
    const conns = Array.isArray(rcx.connections) ? rcx.connections : [];
    // GitHub issue → API 抓取标题+正文（公开仓库无需 token）。
    // API 失败（私有仓库 404 / 限流 403）时直接报错——降级抓 HTML 页面只会给
    // P1 喂进导航页噪音；让失败在发起 Run 时就可见、可定位。
    const gh = uri.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)/);
    if (gh) {
      const [, owner, repo, num] = gh;
      // token 来源：项目页「Git 托管连接」的 github.com 连接优先，本机环境变量兜底；
      // 匿名 API 限流仅 60 次/小时/IP，极易 403
      const ghConn = matchConnection(uri, conns);
      const ghToken = (ghConn && ghConn.kind === "github" && ghConn.token) || process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
      let resp;
      try {
        resp = await fetch(`https://api.github.com/repos/${owner}/${repo}/issues/${num}`, {
          headers: {
            Accept: "application/vnd.github+json",
            "User-Agent": "dsh-issue2pr",
            ...(ghToken ? { Authorization: "Bearer " + ghToken } : {}),
          },
        });
      } catch (e) { throw new Error("GitHub API 请求失败: " + String((e && e.message) || e)); }
      if (!resp.ok) {
        const hint = resp.status === 404 ? "（仓库不存在或为私有仓库；私有仓库可在项目页「Git 托管连接」配置 GitHub 凭据，或改用本地导出的 issue 文档）"
          : resp.status === 403 ? `（API 限流${ghToken ? "（含认证请求）" : "，可在项目页「Git 托管连接」配置 GitHub token（或设置 GITHUB_TOKEN 环境变量）提升额度"}，稍后重试或改用本地文档）` : "";
        throw new Error(`GitHub issue 获取失败 (HTTP ${resp.status})${hint}: ${uri}`);
      }
      const data = await resp.json();
      return `# ${data.title || "(无标题)"}\n\n${data.body || "(无正文)"}`;
    }
    // GitLab issue（gitlab.com 或自建实例）→ /api/v4 抓取；私有仓库需「Git 托管连接」的 token
    const gl = uri.match(/^https?:\/\/([^/]+)\/([^/]+)\/([^/]+)\/-\/issues\/(\d+)/);
    if (gl) {
      const [, glHost, ns, name, glNum] = gl;
      const glConn = matchConnection(uri, conns);
      const glToken = (glConn && glConn.kind === "gitlab" && glConn.token) || "";
      let resp;
      try {
        resp = await fetch(`https://${glHost}/api/v4/projects/${encodeURIComponent(ns + "/" + name)}/issues/${glNum}`, {
          headers: { "User-Agent": "dsh-issue2pr", ...(glToken ? { Authorization: "Bearer " + glToken } : {}) },
        });
      } catch (e) { throw new Error("GitLab API 请求失败: " + String((e && e.message) || e)); }
      if (!resp.ok) {
        const hint = resp.status === 404 ? "（仓库不存在或无权限；可在项目页「Git 托管连接」配置该 GitLab 的 Access Token，或改用本地导出的 issue 文档）"
          : (resp.status === 401 || resp.status === 403) ? "（凭据缺失或无效，可在项目页「Git 托管连接」配置该 GitLab 的 Access Token）" : "";
        throw new Error(`GitLab issue 获取失败 (HTTP ${resp.status})${hint}: ${uri}`);
      }
      const data = await resp.json();
      return `# ${data.title || "(无标题)"}\n\n${data.description || "(无正文)"}`;
    }
    // 通用 HTTP fetch
    const resp = await fetch(uri, { headers: { "User-Agent": "dsh-issue2pr" } });
    if (!resp.ok) throw new Error(`获取触发文档失败 (${resp.status}): ${uri}`);
    return await resp.text();
  }
  if (!existsSync(uri)) throw new Error("触发文档不存在: " + uri);
  return readFileSync(uri, "utf8");
}

const IGNORE = new Set([".git", "node_modules", "dist", ".next", "coverage"]);
export function listRepoFiles(repoDir, max = 400) {
  const out = [];
  (function walk(dir) {
    if (out.length >= max || !existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      if (IGNORE.has(name)) continue;
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else { out.push(full.slice(repoDir.length + 1).split(sep).join("/")); if (out.length >= max) return; }
    }
  })(repoDir);
  return out;
}

export function readRepoFile(repoDir, rel, maxChars = 6000) {
  // 防路径逃逸（Task 7 修复）：含 .. 段或绝对路径的 rel 直接占位返回，不读仓库外文件
  const relStr = String(rel);
  if (relStr.split(/[\\/]+/).includes("..") || /^([a-zA-Z]:)?[\\/]/.test(relStr)) return "(非法路径)";
  const full = join(repoDir, rel);
  if (!existsSync(full)) return `<文件不存在: ${rel}>`;
  return readFileSync(full, "utf8").slice(0, maxChars);
}

export function requireArtifact(runDir, rel, readArtifact) {
  const text = readArtifact(runDir, rel);
  if (text == null) throw new Error("缺少上游产物: " + rel);
  return text;
}

// 委托外部智能体：开放委托的阶段在执行器开头调用；返回 external 结果（advance
// 据此停复核门等外部产出），未开启委托返回 null 走本机执行。
// P6 任务包路径沿用 06-implementation/session-task.md（与既有 UI 提示/存量 run 兼容）
export async function maybeDelegate(rcx, stageId) {
  if (!stageDelegated(rcx, stageId)) return null;
  const rel = stageId === "P6" ? "06-implementation/session-task.md" : `delegate/${stageId}-task.md`;
  const task = await buildDelegateTask(rcx, stageId);
  writeArtifact(rcx.runDir, rel, task);
  logEvent(rcx, { kind: "info", name: stageId + " 委托外部智能体：任务包已生成",
    detail: rel + " 已写入；外部智能体产出就绪后，回复核门通过继续" });
  return { artifact: rel, summary: "任务包已生成，等待外部智能体执行", external: true };
}