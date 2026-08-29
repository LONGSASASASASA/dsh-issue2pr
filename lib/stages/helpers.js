// lib/stages/helpers.js — 各阶段通用辅助（读触发文档 / 列仓库文件 / 读文件 / 取上游产物 / 过程事件）
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import { appendArtifactLine } from "../store.js";

// 过程事件：追加到 runDir/trace/events.jsonl（UI 阶段详情按 stage 过滤展示）。
// kind：stage | llm | git | test | tool | info；detail 截断 2000 字防膨胀。
export function logEvent(rcx, ev) {
  if (!rcx || !rcx.runDir) return;
  try {
    appendArtifactLine(rcx.runDir, "trace/events.jsonl", {
      at: new Date().toISOString(),
      stage: (rcx.run && rcx.run.current) || null,
      kind: ev.kind || "info",
      name: String(ev.name || "").slice(0, 200),
      detail: String(ev.detail == null ? "" : ev.detail).slice(0, 2000),
      ms: typeof ev.ms === "number" ? Math.round(ev.ms) : null,
      ok: ev.ok !== false,
    });
  } catch { /* 事件写盘失败不影响主流程 */ }
}

export async function readTriggerText(rcx) {
  const uri = rcx.trigger.uri;
  if (/^https?:\/\//.test(uri)) {
    // GitHub issue → API 抓取标题+正文（公开仓库无需 token）。
    // API 失败（私有仓库 404 / 限流 403）时直接报错——降级抓 HTML 页面只会给
    // P1 喂进导航页噪音；让失败在发起 Run 时就可见、可定位。
    const gh = uri.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)/);
    if (gh) {
      const [, owner, repo, num] = gh;
      let resp;
      try {
        resp = await fetch(`https://api.github.com/repos/${owner}/${repo}/issues/${num}`, {
          headers: { Accept: "application/vnd.github+json", "User-Agent": "dsh-issue2pr" },
        });
      } catch (e) { throw new Error("GitHub API 请求失败: " + String((e && e.message) || e)); }
      if (!resp.ok) {
        const hint = resp.status === 404 ? "（仓库不存在或为私有仓库，可改用本地导出的 issue 文档）"
          : resp.status === 403 ? "（可能触发 API 限流，稍后重试或改用本地文档）" : "";
        throw new Error(`GitHub issue 获取失败 (HTTP ${resp.status})${hint}: ${uri}`);
      }
      const data = await resp.json();
      return `# ${data.title || "(无标题)"}\n\n${data.body || "(无正文)"}`;
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