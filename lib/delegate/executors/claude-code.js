// lib/delegate/executors/claude-code.js — Claude Code CLI 执行器
// 无人值守约束下的关键决策：
//   输出用 stream-json 逐帧（session_id / assistant 进度 / result 判定），不再依赖一次性 JSON——
//   is_error、0-token 这类 API 级失败（如 403 IP 白名单）必须显式识别，不能只看退出码；
//   权限档位默认 acceptEdits + 宽白名单替代裸 --dangerously-skip-permissions（bypass 一键回退旧行为）；
//   认证可选中转（claude-auth.js）：spawn 时注入 ANTHROPIC_BASE_URL/AUTH_TOKEN，绕开 IP 白名单类 403；
//   超时/停止必须杀进程树，否则孤儿 claude 继续写仓库，与下一轮 reset/apply 竞态；
//   输出实时落盘 external-exec.log（宿主/插件重启后可续读，与 delegateWatch 恢复链路衔接）。
// 发现与测试门禁见 lib/delegate/agents.js（与本模块共用 authHintOf/认证 env 组装）。
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { claudeAuthEnv, authRelayActive, writeRelaySettings, cleanupRelaySettings } from "./claude-auth.js";
import { foldClaudeOutput } from "./claude-stream.js";

export const id = "claude-code";
export const label = "Claude Code CLI";
export const kind = "cli";

// 权限档位（--permission-mode 见官方 headless 文档；白名单 token 一律不含空格，规避 shell:true 拼接破坏）
export const PERMISSION_MODES = {
    acceptEdits: {
        args: ["--permission-mode", "acceptEdits",
            "--allowedTools", "Bash", "--allowedTools", "Edit", "--allowedTools", "Write",
            "--allowedTools", "NotebookEdit", "--allowedTools", "Read", "--allowedTools", "Glob",
            "--allowedTools", "Grep", "--allowedTools", "LS", "--allowedTools", "WebFetch",
            "--allowedTools", "WebSearch", "--allowedTools", "Task"],
        label: "acceptEdits + 宽白名单（默认）",
    },
    bypass: { args: ["--dangerously-skip-permissions"], label: "bypass（旧行为）" },
    dontAsk: { args: ["--permission-mode", "dontAsk",
        "--allowedTools", "Bash(git:*)", "--allowedTools", "Edit", "--allowedTools", "Write",
        "--allowedTools", "Read", "--allowedTools", "Glob", "--allowedTools", "Grep", "--allowedTools", "LS"], label: "dontAsk + git 白名单（最严）" },
};

// —— claude CLI 进程管理（stop/删除 Run 时杀进程树，避免孤儿 claude 继续写仓库） ——
const activeExternals = new Map(); // runDir → ChildProcess

// 杀整棵进程树。shell:true 的 child 是 cmd.exe，直接 kill 只杀到壳，claude（node 子进程）会存活。
export function killTree(child) {
    if (!child || child.exitCode != null || child.signalCode) return false;
    if (process.platform === "win32") {
        spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
    } else {
        try { child.kill("SIGTERM"); } catch { /* 已退出 */ }
        setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* 已退出 */ } }, 5000).unref();
    }
    return true;
}

export function killExternal(runDir) {
    return killTree(activeExternals.get(runDir));
}

// claude 可执行文件解析：阶段配置（params.claudeBin）> 环境变量 ISSUE2PR_CLAUDE_BIN > 常见安装位置探测。
// 开源环境安装路径各异，UI「配置」可显式指定；PATH 里未必有 claude（如 npm 全局目录不在系统 PATH）。
// preflight 端点与 lib/delegate/agents.js 的发现/门禁复用本函数做健康探测。
export function claudeCommonCandidates() {
    const home = homedir();
    return process.platform === "win32"
        ? [join(home, ".npm-global", "claude.cmd"), join(home, ".npm_global", "claude.cmd"), join(home, "AppData", "Roaming", "npm", "claude.cmd"), join(home, ".local", "bin", "claude.exe")]
        : [join(home, ".local", "bin", "claude"), "/usr/local/bin/claude", "/opt/homebrew/bin/claude"];
}

export function resolveClaudeBin(cfgBin) {
    if (cfgBin) return cfgBin;
    if (process.env.ISSUE2PR_CLAUDE_BIN) return process.env.ISSUE2PR_CLAUDE_BIN;
    return claudeCommonCandidates().find((p) => existsSync(p)) || "claude";
}

// 无人值守跑 claude：-p headless + stream-json 逐帧；--add-dir 允许写 run 产物目录（cwd 是仓库）。
// 中转经 --settings 临时文件注入（用户 settings.json 的 env 块会覆盖进程 env，实测 2.1.251）。
// prompt 走 stdin（规避 shell:true 的参数转义）；stdout 累积留档 2MB 上限。
async function runClaude({ bin, repoDir, addDir, prompt, timeoutMs, onChild, env, permission, settingsPath, onStdoutChunk }) {
    const mode = PERMISSION_MODES[permission] || PERMISSION_MODES.acceptEdits;
    const args = ["-p", "--output-format", "stream-json", "--verbose", ...mode.args, "--add-dir", '"' + addDir + '"'];
    if (settingsPath) args.push("--settings", '"' + settingsPath + '"');
    return await new Promise((resolve) => {
        let child;
        try {
            child = spawn(bin, args, { cwd: repoDir, shell: true, windowsHide: true, env: env || process.env });
        } catch (e) { return resolve({ code: -1, error: String((e && e.message) || e) }); }
        if (onChild) onChild(child);
        let stdout = "", stderr = "", done = false;
        const finish = (r) => { if (done) return; done = true; clearTimeout(timer); resolve(r); };
        // 超时必须杀树：只 resolve 会留孤儿 claude 继续写仓库（既有 bug，本次修复）
        const timer = setTimeout(() => {
            killTree(child);
            finish({ code: -2, timeout: true, stdout, stderr });
        }, timeoutMs);
        child.on("error", (e) => finish({ code: -1, error: String((e && e.message) || e), stdout, stderr }));
        child.stdout?.on("data", (d) => {
            const s = String(d);
            if (stdout.length < 2e6) stdout += s;
            if (onStdoutChunk) onStdoutChunk(s);
        });
        child.stderr?.on("data", (d) => { if (stderr.length < 2e6) stderr += d; });
        child.on("close", (code) => finish({ code: code == null ? -1 : code, stdout, stderr }));
        try { child.stdin.write(prompt); child.stdin.end(); }
        catch (e) { finish({ code: -1, error: "stdin 写入失败: " + String((e && e.message) || e), stdout, stderr }); }
    });
}

// 认证/网络类错误 → 可操作提示（用户实测：403 IP access denied by API-Key restrictions）。
// relay 生效时 401/403 指向中转 token；否则指向 Anthropic Console 白名单 / CLI 登录态。
export function authHintOf(text, relay = false) {
    const t = String(text || "");
    if (relay && /40[13]|authenticat|unauthorized|forbidden|invalid|permission denied/i.test(t)) {
        return "中转认证未通过：检查「项目」页保存的中转 token 是否有效/有额度，与所选预设（GLM / 自定义 baseUrl）是否匹配，然后重跑测试门禁。";
    }
    if (/403|ip access denied|api[- ]?key restriction/i.test(t)) {
        return "API Key 有 IP 访问限制：当前出口 IP 不在白名单（常见于公司代理 / VPN 出口漂移）。可在「项目」页配置认证中转（GLM 预设 / 自定义网关）根治，或到 Anthropic Console 调整该 Key 的 IP 白名单后重测。";
    }
    if (/401|authenticat|not logged in|please log ?in|login required/i.test(t)) {
        return "claude CLI 未登录或凭据失效：在终端运行 claude 完成登录（或检查 ANTHROPIC_API_KEY 环境变量），也可改用认证中转；完成后重跑测试门禁。";
    }
    if (/429|rate limit/i.test(t)) return "触发限流：请稍后重测。";
    if (/timeout|etimedout|econnrefused|enotfound|network/i.test(t)) {
        return "网络不可达：检查代理 / 防火墙对 API 端点的放行情况后重测。";
    }
    return "";
}

// 失败分类（成功返回 null）。排序：spawn 错误 > 超时 > result.is_error > 非零退出 > 0-token 空结果。
function classifyFailure(r, folded, auth) {
    const relay = authRelayActive(auth);
    const text = String(r.stderr || "") + "\n" + String(folded.resultText || "");
    if (r.error) return { kind: "spawn", message: r.error, hint: "" };
    if (r.timeout) return { kind: "timeout", message: "超时被终止（进程树已杀）", hint: "" };
    if (folded.resultIsError) {
        return { kind: "result-error", message: "claude 返回错误结果：" + (folded.resultText || "(空)").slice(0, 300), hint: authHintOf(text, relay) };
    }
    if (r.code !== 0) {
        return { kind: "exit", message: "退出码 " + r.code + (r.stderr ? "：" + String(r.stderr).slice(0, 300) : ""), hint: authHintOf(text, relay) };
    }
    if (folded.zeroUsage && !folded.resultText) {
        return { kind: "empty", message: "执行结束但 0 token 0 输出（疑似 API 级失败，如认证/网络错误）", hint: authHintOf(text, relay) };
    }
    return null;
}

// 归一执行结果：注入测试的旧形态与 stream-json 真跑输出统一到同一口径，p6 阶段层不再自行解析。
export function normalizeOutcome(r, auth) {
    const folded = foldClaudeOutput(r.stdout);
    return {
        ...r,
        sessionId: folded.sessionId,
        stats: folded.stats,
        resultIsError: folded.resultIsError,
        resultText: folded.resultText,
        lastAssistantText: folded.lastAssistantText,
        failure: classifyFailure(r, folded, auth),
    };
}

// 执行一次委外任务。rcx.spawnExternal 是测试注入口（参数契约与 runClaude 一致，可返回旧形态结果）。
// 日志由本函数统一落盘：实时逐行（runClaude 流式回调）或结束后一次性（注入路径），头尾带元信息；
// 认证信息只记 preset 名，token 绝不落日志。
async function run({ rcx, bin, repoDir, runDir, prompt, timeoutMs, params, auth, logPath }) {
    const permission = (params && params.claudePermission) || "acceptEdits";
    const env = { ...process.env, ...claudeAuthEnv(auth) };
    const settingsPath = writeRelaySettings(auth); // 空 = 无中转，不传 --settings（用户 settings 全量生效）
    const log = logPath ? createWriteStream(logPath, { flags: "a" }) : null;
    if (log) {
        log.write("=== claude-code " + new Date().toISOString() + " ===\n"
            + "bin=" + bin + "\npermission=" + permission + "\nauth=" + (authRelayActive(auth) ? String(auth && auth.preset) : "none") + "\n--- stdout ---\n");
    }
    let streamed = false;
    let r;
    try {
        r = await (rcx.spawnExternal || runClaude)({ // 测试注入点
            bin, repoDir, addDir: runDir, prompt, timeoutMs, env, permission, settingsPath,
            onStdoutChunk: (s) => { streamed = true; if (log) log.write(s); },
            onChild: (c) => activeExternals.set(runDir, c),
        });
        if (log && !streamed && r.stdout) log.write(r.stdout);
    } finally {
        activeExternals.delete(runDir);
        cleanupRelaySettings(settingsPath); // 临时文件含 token，跑完即删
        if (log) {
            log.write("\n--- stderr ---\n" + (r?.stderr || "") + "\n--- exit=" + (r?.code ?? "?") + (r?.timeout ? " timeout=true" : "") + (r?.error ? " error=" + r.error : "") + " ---\n");
            // 等 flush 完成再返回：宿主/插件重启续读依赖日志完整性，且测试可立即断言文件存在
            await new Promise((res) => { log.end(res); });
        }
    }
    return normalizeOutcome(r, auth);
}

const executor = { id, label, kind, run, stop: killExternal };
export default executor;
