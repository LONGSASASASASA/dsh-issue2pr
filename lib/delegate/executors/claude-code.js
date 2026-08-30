// lib/delegate/executors/claude-code.js — Claude Code CLI 执行器
// 从 lib/stages/p6-coder.js 迁入（行为等价）：bin 解析、spawn、超时、进程树管理。
// 认证复用本机 claude CLI 登录态；发现与测试门禁见 lib/delegate/agents.js。
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const id = "claude-code";
export const label = "Claude Code CLI";
export const kind = "cli";

// —— claude CLI 进程管理（stop/删除 Run 时杀进程树，避免孤儿 claude 继续写仓库） ——
const activeExternals = new Map(); // runDir → ChildProcess

export function killExternal(runDir) {
    const child = activeExternals.get(runDir);
    if (!child || child.exitCode != null) return false;
    if (process.platform === "win32") {
        // shell:true 的 child 是 cmd.exe，须按进程树杀，否则 claude（node 子进程）存活
        spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
    } else {
        try { child.kill("SIGTERM"); } catch { /* 已退出 */ }
    }
    return true;
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

// 无人值守跑 claude：-p headless；skip-permissions 无交互放行；--add-dir 允许写 run 产物目录（cwd 是仓库）。
// prompt 走 stdin（规避 shell:true 的参数转义）；输出各留档 2MB 上限。
async function runClaude({ bin, repoDir, addDir, prompt, timeoutMs, onChild }) {
    const args = ["-p", "--output-format", "json", "--dangerously-skip-permissions", "--add-dir", '"' + addDir + '"'];
    return await new Promise((resolve) => {
        let child;
        try {
            child = spawn(bin, args, { cwd: repoDir, shell: true, windowsHide: true });
        } catch (e) { return resolve({ code: -1, error: String((e && e.message) || e) }); }
        if (onChild) onChild(child);
        let stdout = "", stderr = "", done = false;
        const finish = (r) => { if (done) return; done = true; clearTimeout(timer); resolve(r); };
        const timer = setTimeout(() => finish({ code: -2, timeout: true, stdout, stderr }), timeoutMs);
        child.on("error", (e) => finish({ code: -1, error: String((e && e.message) || e), stdout, stderr }));
        child.stdout?.on("data", (d) => { if (stdout.length < 2e6) stdout += d; });
        child.stderr?.on("data", (d) => { if (stderr.length < 2e6) stderr += d; });
        child.on("close", (code) => finish({ code: code == null ? -1 : code, stdout, stderr }));
        try { child.stdin.write(prompt); child.stdin.end(); }
        catch (e) { finish({ code: -1, error: "stdin 写入失败: " + String((e && e.message) || e) }); }
    });
}

// 执行一次委外任务。rcx.spawnExternal 是测试注入口（参数契约与本模块 runClaude 一致）。
// activeExternals 登记在 executor 内：spawn 失败/超时/完成都确保清除，killExternal 才不会误杀已结束进程。
async function run({ rcx, bin, repoDir, runDir, prompt, timeoutMs }) {
    const runner = rcx.spawnExternal || runClaude; // 测试注入点
    try {
        return await runner({
            bin, repoDir, addDir: runDir, prompt, timeoutMs,
            onChild: (c) => activeExternals.set(runDir, c),
        });
    } finally {
        activeExternals.delete(runDir);
    }
}

const executor = { id, label, kind, run, stop: killExternal };
export default executor;
