// lib/agents.js — 委外智能体（Claude Code CLI）发现与测试门禁
// 背景：claude CLI 只在 Run 的 P6 阶段才真实调用，认证类错误（403 IP 白名单等）
// 到那时才暴露，浪费一轮委托。发现 + 门禁都前置到「绑定」时：
//   发现：项目配置 > 环境变量 > 常见安装位置 > npm 全局目录 > PATH 查找（五种来源，去重合并）
//   门禁：定位 → --version（可运行）→ headless 微任务（真实过一遍认证，403 在此拦截）
// 全部探测函数可注入（index.js 传 __testHooks 版本），单测不依赖本机 claude。
import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolveClaudeBin, claudeCommonCandidates } from "../stages/p6-coder.js";

export const AGENT_SOURCE_LABELS = {
  configured: "项目配置",
  env: "环境变量",
  common: "常见安装位置",
  npm: "npm 全局目录",
  path: "PATH 查找",
};

// 去重键：Windows 路径不分大小写，分隔符归一
function pathKey(p) {
  return String(p).replace(/[\\/]+/g, "/").replace(/\/+$/, "").toLowerCase();
}

// —— 真实探测 runner（生产路径；测试经 __testHooks 注入替换） ——
// Windows 上 claude 通常是 .cmd，execFile 无 shell 会 EINVAL，统一走 shell:true 的 spawn。
// 与 p6-coder runClaude 同策略：路径含空格属既有已知限制。
function shCollect(bin, args, timeoutMs) {
  return new Promise((resolve) => {
    let child;
    try { child = spawn(bin, args, { shell: true, windowsHide: true }); }
    catch (e) { return resolve({ code: -1, error: String((e && e.message) || e), stdout: "", stderr: "" }); }
    let stdout = "", stderr = "", done = false;
    const finish = (r) => { if (done) return; done = true; clearTimeout(timer); resolve(r); };
    const timer = setTimeout(() => finish({ code: -2, timeout: true, stdout, stderr }), timeoutMs);
    child.on("error", (e) => finish({ code: -1, error: String((e && e.message) || e), stdout, stderr }));
    child.stdout?.on("data", (d) => { stdout += d; });
    child.stderr?.on("data", (d) => { stderr += d; });
    child.on("close", (code) => finish({ code: code == null ? -1 : code, stdout, stderr }));
  });
}

export function realRunVersion(bin, opts, cb) {
  shCollect(bin, ["--version"], 15000).then((r) => {
    if (r.code !== 0) return cb(new Error(String(r.stderr || r.error || ("退出码 " + r.code)).slice(0, 300)), "", r.stderr);
    cb(null, r.stdout, r.stderr);
  });
}

// 认证微任务：-p headless 一次极小真实调用（一轮、几十 token，费用可忽略）。
// prompt 走 stdin（shell:true 下参数不转义，与 p6 委托同策略）。
export function realRunPrompt(bin, opts, cb) {
  const timeoutMs = Number(opts && opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : 120000;
  let child;
  try { child = spawn(bin, ["-p", "--output-format", "json"], { shell: true, windowsHide: true }); }
  catch (e) { return void cb(new Error(String((e && e.message) || e))); }
  let stdout = "", stderr = "", done = false;
  const finish = (r) => { if (done) return; done = true; clearTimeout(timer); cb(null, r); };
  const timer = setTimeout(() => finish({ code: -2, timeout: true, stdout, stderr }), timeoutMs);
  child.on("error", (e) => finish({ code: -1, error: String((e && e.message) || e), stdout, stderr }));
  child.stdout?.on("data", (d) => { if (stdout.length < 1e6) stdout += d; });
  child.stderr?.on("data", (d) => { if (stderr.length < 1e6) stderr += d; });
  child.on("close", (code) => finish({ code: code == null ? -1 : code, stdout, stderr }));
  try { child.stdin.write("Reply with exactly: OK"); child.stdin.end(); }
  catch (e) { finish({ code: -1, error: "stdin 写入失败: " + String((e && e.message) || e), stdout, stderr }); }
}

export function realRunWhich(args, opts, cb) {
  execFile(process.platform === "win32" ? "where" : "which", args, { ...opts, windowsHide: true }, cb);
}

export function realRunNpmPrefix(args, opts, cb) {
  // Windows 的 npm 是 npm.cmd，须 shell 才能拉起
  execFile("npm", args, { ...opts, shell: process.platform === "win32" }, cb);
}

// —— 发现：五种来源合并去重，逐条标注来源与存在性 ——
export async function discoverAgents({ cfgBin = "", envBin = process.env.ISSUE2PR_CLAUDE_BIN || "", runWhich, runNpmPrefix } = {}) {
  const agents = [];
  const seen = new Set();
  const push = (path, source) => {
    const t = String(path || "").trim();
    if (!t) return;
    const k = pathKey(t);
    if (seen.has(k)) return;
    seen.add(k);
    agents.push({ path: t, source, label: AGENT_SOURCE_LABELS[source] || source, exists: existsSync(t) });
  };
  if (cfgBin) push(cfgBin, "configured");
  if (envBin) push(envBin, "env");
  for (const p of claudeCommonCandidates()) push(p, "common");
  // npm 全局前缀：自定义 npm 全局目录（如 D:\npm-global）的第一手来源
  if (runNpmPrefix) {
    const prefix = await new Promise((r) => runNpmPrefix(["config", "get", "prefix"], { timeout: 8000 }, (err, stdout) =>
      r(err ? "" : String(stdout || "").trim().split(/\r?\n/).filter(Boolean).pop() || "")));
    if (prefix) push(prefix + (process.platform === "win32" ? "\\claude.cmd" : "/bin/claude"), "npm");
  }
  // PATH 查找：where/which 可能多条命中，全部收录
  if (runWhich) {
    await new Promise((r) => runWhich(["claude"], { timeout: 5000 }, (err, stdout) => {
      if (!err && stdout) String(stdout).split(/\r?\n/).map((s) => s.trim()).filter(Boolean).forEach((p) => push(p, "path"));
      r();
    }));
  }
  return { agents, resolved: resolveClaudeBin(cfgBin) };
}

// —— 认证类错误 → 可操作提示（用户实测：403 IP access denied by API-Key restrictions） ——
function authHintOf(text) {
  const t = String(text || "");
  if (/403|ip access denied|api[- ]?key restriction/i.test(t)) {
    return "API Key 有 IP 访问限制：当前出口 IP 不在白名单（常见于公司代理 / VPN）。请到 Anthropic Console 调整该 Key 的 IP 白名单，或更换网络出口 / 无限制 Key 后重测。";
  }
  if (/401|authenticat|not logged in|please log ?in|login required/i.test(t)) {
    return "claude CLI 未登录或凭据失效：在终端运行 claude 完成登录（或检查 ANTHROPIC_API_KEY 环境变量），完成后重测。";
  }
  if (/429|rate limit/i.test(t)) return "触发限流：请稍后重测。";
  if (/timeout|etimedout|econnrefused|enotfound|network/i.test(t)) {
    return "网络不可达：检查代理 / 防火墙对 api.anthropic.com 的放行情况后重测。";
  }
  return "";
}

// 从输出里挑出最像错误的一行（claude 的报错通常在 stderr 或 stdout 尾部）
function errorLineOf({ stderr, stdout, code }) {
  const lines = String(stderr || "").split(/\r?\n/).concat(String(stdout || "").split(/\r?\n/));
  const hit = lines.find((l) => /error|failed|denied|invalid|not logged|40[134]/i.test(l) && l.trim());
  return (hit || lines.find((l) => l.trim()) || ("退出码 " + code)).trim().slice(0, 300);
}

// —— 测试门禁：定位 → 版本 → 认证微任务，三步全绿才算通过 ——
// runners 可注入（单测）：{ runWhich, runVersion, runPrompt }
export async function testAgentGate({ bin = "", runners = {}, timeoutMs = 120000 } = {}) {
  const R = {
    runWhich: runners.runWhich || realRunWhich,
    runVersion: runners.runVersion || realRunVersion,
    runPrompt: runners.runPrompt || realRunPrompt,
  };
  const steps = [];
  const t0 = Date.now();
  const fail = (message, hint) => ({ ok: false, bin, steps, message, hint: hint || "", ms: Date.now() - t0 });

  const target = String(bin || "").trim() || resolveClaudeBin("");
  let path = target;

  // 1) 定位：显式路径查存在性；裸名 claude 走 PATH
  {
    const t1 = Date.now();
    let detail = "";
    let ok = true;
    if (!/^claude(\.cmd|\.exe)?$/i.test(target) || existsSync(target)) {
      if (existsSync(target)) detail = "已定位 " + target;
      else { ok = false; detail = "文件不存在: " + target; }
    } else {
      const hits = await new Promise((r) => R.runWhich([target], { timeout: 5000 }, (err, stdout) =>
        r(err ? null : String(stdout || "").split(/\r?\n/).map((s) => s.trim()).filter(Boolean))));
      if (hits && hits.length) { path = hits[0]; detail = "PATH 命中 " + path; }
      else { ok = false; detail = "PATH 中未找到 claude 命令（可改用完整路径，或确认安装）"; }
    }
    steps.push({ name: "定位", ok, detail, ms: Date.now() - t1 });
    if (!ok) return fail(detail);
  }

  // 2) 版本：--version 可运行（拦路径写错 / 损坏的安装）
  let version = "";
  {
    const t1 = Date.now();
    const r = await new Promise((res) => R.runVersion(path, {}, (err, stdout, stderr) => res({ err, stdout, stderr })));
    version = String(r.stdout || "").trim().split(/\r?\n/)[0] || "";
    const ok = !r.err;
    steps.push({ name: "版本", ok, detail: ok ? (version || "无版本输出") : String((r.err && r.err.message) || r.stderr || "运行失败").slice(0, 300), ms: Date.now() - t1 });
    if (!ok) return fail("claude CLI 无法运行（--version 失败）: " + steps[steps.length - 1].detail);
  }

  // 3) 认证：headless 微任务真实过一遍凭据（403 IP 白名单 / 未登录在此拦截）
  {
    const t1 = Date.now();
    const r = await new Promise((res) => R.runPrompt(path, { timeoutMs }, (err, out) => res({ err, out })));
    if (r.err) {
      const msg = String((r.err && r.err.message) || r.err);
      steps.push({ name: "认证", ok: false, detail: msg.slice(0, 300), ms: Date.now() - t1 });
      return fail("认证微任务未能执行: " + msg.slice(0, 300), authHintOf(msg));
    }
    const out = r.out || {};
    let ok = out.code === 0;
    let result = "";
    if (ok) {
      try {
        const j = JSON.parse(String(out.stdout || "").trim());
        if (j && typeof j === "object" && j.is_error) { ok = false; result = String(j.result || ""); }
        else result = String((j && j.result) || "");
      } catch { /* 非 JSON 输出但退出 0：视为通过（版本差异） */ }
    }
    const text = (out.stderr || "") + "\n" + (out.stdout || "");
    steps.push({
      name: "认证", ok,
      detail: ok ? ("模型回执: " + (result || "（空）").slice(0, 80)) : (out.timeout ? "微任务超时" : errorLineOf(out)),
      ms: Date.now() - t1,
    });
    if (!ok) {
      return fail("claude 认证/调用未通过: " + steps[steps.length - 1].detail, authHintOf(text + " " + (out.timeout ? "timeout" : "")));
    }
    return { ok: true, bin, path, version, steps, message: "门禁通过（" + (version || "版本未知") + " · 认证正常）", ms: Date.now() - t0 };
  }
}
