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
import { appendAgentTimeline, appendAgentTimelineLine } from "./agent-timeline.js";
import { agentRecordPaths, createAgentRecordWriter } from "./agent-records.js";
import { createAgentActivityWriter } from "../agentActivity.js";
import { StringDecoder } from "node:string_decoder";
import { createWriteStream, existsSync, readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, relative } from "node:path";
import { claudeAuthEnv, claudeRelaySettings, authRelayActive, writeRelaySettings, cleanupRelaySettings } from "./claude-auth.js";
import { foldClaudeOutput } from "./claude-stream.js";
import { createJournal, readJournal } from "../../infra/journal.js";

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
const cancelledExternals = new Set(); // runDir → 外部主动停止标记（exit 记录区分「取消」与「自行退出」）

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
    if (activeExternals.has(runDir)) cancelledExternals.add(runDir);
    return killTree(activeExternals.get(runDir));
}

// 只检查当前进程持有的句柄；宿主重启后不按旧 PID 猜测存活状态。
export function externalProcessState(runDir) {
    const child = activeExternals.get(runDir);
    return { state: child ? child.exitCode != null || child.signalCode ? "exited" : "alive" : "unknown", checkedAt: new Date().toISOString() };
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
// prompt 走 stdin（规避 shell:true 的参数转义）。stdout/stderr 累积仅留 2MB 供失败分类预览，
// 完整历史由 onStdoutChunk/onStderrChunk 持续写盘（journal 分片轮转），退出判定读盘不依赖内存上限。
async function runClaude({ bin, repoDir, addDir, prompt, timeoutMs, onChild, env, permission, settingsPath, onStdoutChunk, onStderrChunk }) {
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
        const stdoutDecoder = new StringDecoder("utf8"), stderrDecoder = new StringDecoder("utf8");
        const finish = (r) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            if (stdout.length < 2e6) stdout += stdoutDecoder.end();
            if (stderr.length < 2e6) stderr += stderrDecoder.end();
            resolve({ ...r, stdout, stderr });
        };
        // 超时必须杀树：只 resolve 会留孤儿 claude 继续写仓库（既有 bug，本次修复）
        const timer = setTimeout(() => {
            killTree(child);
            finish({ code: -2, timeout: true, signal: null, stdout, stderr });
        }, timeoutMs);
        child.on("error", (e) => finish({ code: -1, signal: null, error: String((e && e.message) || e), stdout, stderr }));
        child.stdout?.on("data", (d) => {
            if (done) return;
            const s = stdoutDecoder.write(d);
            if (stdout.length < 2e6) stdout += s;
            if (onStdoutChunk) onStdoutChunk(d); // 原始字节交由持久化读取器增量解码，保留跨 chunk 的 UTF-8
        });
        child.stderr?.on("data", (d) => {
            if (done) return;
            const s = stderrDecoder.write(d);
            if (stderr.length < 2e6) stderr += s;
            if (onStderrChunk) onStderrChunk(d); // stderr 同样流式落盘，不再等进程结束才补写
        });
        // signal 保留被外部强制终止的痕迹（close 的第二个参数；正常退出为 null）
        child.on("close", (code, signal) => finish({ code: code == null ? -1 : code, signal: signal || null, stdout, stderr }));
        try { child.stdin.write(prompt); child.stdin.end(); }
        catch (e) { finish({ code: -1, signal: null, error: "stdin 写入失败: " + String((e && e.message) || e), stdout, stderr }); }
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

// —— journal 留档（修复清单 20260916-001 TASK-08）——
// stdout / stderr / records 三个单写者目录，与既有 external-exec.log / messages.jsonl 并行：
// stdout/stderr 走 chunk 流（有界缓冲 + 大小阈值分片轮转，完整历史不再受 2MB 内存上限约束）；
// records 承载启动快照与结束事件，每条关联 captureId / stageExecutionId。
// 留档失败不阻断执行：journal 打不开或写入失败时静默降级，退出判定回退内存形态。
const journalDirOf = (logPath, stream) => logPath ? logPath.replace(/external-exec\.log$/, `external-exec.${stream}.journal`) : null;

// 按清单顺序拼接 stdout 流分片（stream-*.log）还原完整流；
// 目录缺失/清单损坏/无流分片返回 null（调用方回退内存形态）
function readJournalStream(dir) {
    if (!dir) return null;
    try {
        const j = readJournal(dir);
        if (!j.present || j.integrity === "corrupt" || !j.manifest) return null;
        const streams = Array.isArray(j.manifest.streams) ? j.manifest.streams : [];
        if (!streams.length) return null;
        return Buffer.concat(streams.map((s) => readFileSync(join(dir, s.file)))).toString("utf8");
    } catch { return null; }
}

// 任务包快照引用（不复制全文，包装 prompt 原文已单独保存）；文件不存在时明确 null，不猜
function taskPackageRef(runDir) {
    const rel = "06-implementation/session-task.md";
    const full = runDir ? join(runDir, rel) : null;
    if (!full || !existsSync(full)) return null;
    const bytes = readFileSync(full);
    return { path: rel, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
}

// 执行一次委外任务。rcx.spawnExternal 是测试注入口（参数契约与 runClaude 一致，可返回旧形态结果）。
// 日志由本函数统一落盘：实时逐行（runClaude 流式回调）或结束后一次性（注入路径），头尾带元信息；
// 认证信息只记 preset 名，token 绝不落日志。journal 三目录（stdout/stderr/records）承担完整历史：
// stderr 流式写盘不再等结束补写，退出判定从盘上还原完整 stdout，脱离 2MB 内存上限。
async function run({ rcx, bin, repoDir, runDir, prompt, timeoutMs, params, auth, logPath, onCapture }) {
    const permission = (params && params.claudePermission) || "acceptEdits";
    const env = { ...process.env, ...claudeAuthEnv(auth) };
    const settingsPath = writeRelaySettings(auth); // 空 = 无中转，不传 --settings（用户 settings 全量生效）
    const log = logPath ? createWriteStream(logPath, { flags: "a" }) : null;
    const timelinePath = logPath ? logPath.replace(/external-exec\.log$/, "external-exec.timeline.log") : null;
    if (log) log.on("error", () => {}); // 观测文件写失败不能使正常执行崩溃
    let activity;
    const records = createAgentRecordWriter({ ...agentRecordPaths(logPath), executor: id,
        onLine: (line) => {
            appendAgentTimeline(timelinePath, line);
            try { activity?.observe(JSON.parse(line)); } catch { /* 非 JSON 由原始日志保留 */ }
        } });
    const stageState = rcx.run?.stages?.P6;
    const stageExecutionId = stageState?.stageExecutionId || null;
    if (stageState?.startedAt && runDir) {
        try { onCapture?.(records.captureId); } catch { /* 观测身份保存失败不能中断执行 */ }
        activity = createAgentActivityWriter({ runDir, captureId: records.captureId, stageStartedAt: stageState.startedAt });
    }
    // journal 三目录（单写者）：stdout/stderr chunk 流 + records 事件；打不开则整体退回既有形态
    const openJournal = (stream) => {
        const dir = journalDirOf(logPath, stream);
        if (!dir) return null;
        try {
            return createJournal({ dir, meta: { executor: id, stream, captureId: records.captureId,
                runId: rcx.run?.id || null, stage: "P6", ...(stageExecutionId ? { stageExecutionId } : {}) } });
        } catch { return null; } // 遗留未闭合目录/磁盘问题：留档降级，不阻断执行
    };
    const stdoutJournal = openJournal("stdout"), stderrJournal = openJournal("stderr"), recordsJournal = openJournal("records");
    const identity = { captureId: records.captureId, ...(stageExecutionId ? { stageExecutionId } : {}) };
    const safeRecord = (obj) => { try { recordsJournal?.appendRecord({ ...identity, ...obj }); } catch { /* 留档失败不阻断执行 */ } };
    const chunkTo = (j, d) => { try { j?.appendChunk(d); } catch { /* 流留档失败不阻断执行 */ } };
    if (log) {
        log.write("=== claude-code " + new Date().toISOString() + " ===\n"
            + "bin=" + bin + "\npermission=" + permission + "\nauth=" + (authRelayActive(auth) ? String(auth && auth.preset) : "none") + "\n--- stdout ---\n");
    }
    appendAgentTimelineLine(timelinePath, "init", "收到任务包（session-task.md）· 委托 " + (authRelayActive(auth) ? String(auth && auth.preset) + " 中转" : "直连") + " 执行");
    records.appendPlatform("init", "收到任务包（session-task.md）· Claude Code 执行");
    // 启动快照（spawn 前）：实际发送的包装 prompt 全文、任务包引用、生效参数与可获得的模型信息
    safeRecord({ kind: "start", at: new Date().toISOString(), bin, permission,
        spawnArgs: ["-p", "--output-format", "stream-json", "--verbose",
            ...(PERMISSION_MODES[permission] || PERMISSION_MODES.acceptEdits).args,
            "--add-dir", '"' + runDir + '"', ...(settingsPath ? ["--settings", "(临时文件，已删除)"] : [])],
        settingsUsed: Boolean(settingsPath), timeoutMs: timeoutMs ?? null,
        authPreset: authRelayActive(auth) ? String(auth && auth.preset) : "none",
        // 实际生效模型：glm 中转经 --settings 注入映射；custom 网关自选、直连由 CLI 决定，系统不可得 → null
        model: claudeRelaySettings(auth)?.env?.ANTHROPIC_MODEL || env.ANTHROPIC_MODEL || null,
        prompt: String(prompt || ""), taskPackage: taskPackageRef(runDir) });
    let streamed = false, stderrStreamed = false;
    let r;
    let outcome = null;
    try {
        r = await (rcx.spawnExternal || runClaude)({ // 测试注入点
            bin, repoDir, addDir: runDir, prompt, timeoutMs, env, permission, settingsPath,
            onStdoutChunk: (s) => { streamed = true; if (log && !log.destroyed) log.write(s); records.push(s); chunkTo(stdoutJournal, s); },
            onStderrChunk: (s) => { stderrStreamed = true; chunkTo(stderrJournal, s); },
            onChild: (c) => activeExternals.set(runDir, c),
        });
        // 注入路径可能整段返回（未流式）：同样补进盘，保证 journal 是完整 stdout 来源
        if (!streamed && r.stdout) { if (log && !log.destroyed) log.write(r.stdout); records.push(r.stdout); chunkTo(stdoutJournal, r.stdout); }
        if (!stderrStreamed && r.stderr) chunkTo(stderrJournal, r.stderr);
    } finally {
        records.flush();
        const cancelled = runDir ? cancelledExternals.delete(runDir) : false;
        for (const j of [stdoutJournal, stderrJournal]) { try { j?.flush(); } catch { /* 冲刷失败由 seal 记录 */ } }
        safeRecord({ kind: "exit", at: new Date().toISOString(), code: r?.code ?? null, signal: r?.signal || null,
            timeout: Boolean(r?.timeout), cancelled, error: r?.error || null });
        const exitReason = "exit " + (r?.code ?? "?") + (r?.timeout ? " timeout" : "") + (cancelled ? " cancelled" : "");
        const exitStatus = r && r.code === 0 && !r.timeout && !r.error ? "completed" : "failed";
        const sealed = {
            stdout: stdoutJournal?.seal({ status: exitStatus, reason: exitReason }),
            stderr: stderrJournal?.seal({ status: exitStatus, reason: exitReason }),
            records: recordsJournal?.seal({ status: exitStatus, reason: exitReason }),
        };
        // 退出判定读盘：从 journal 分片还原完整 stdout 折叠解析；内存 2MB 截断版仅作盘不可读时回退
        const disk = readJournalStream(journalDirOf(logPath, "stdout"));
        // 补全①：journal 目录（runDir 相对）随 outcome 暴露——失败时 p6 层把引用附着到结构化错误，
        // P10/UI 从 errorInfo.logRefs 可回溯完整 stdout/stderr/records 留档；journal 未建立时为 null，不虚构
        const journalRelDir = (stream, opened) => {
            if (!opened) return null;
            try { return relative(runDir, journalDirOf(logPath, stream)).split(/[\\/]/).join("/"); } catch { return null; }
        };
        outcome = r
            ? Object.assign(normalizeOutcome({ ...r, stdout: disk ?? r.stdout }, auth), {
                journal: { stdoutSource: disk !== null ? "disk" : "memory",
                    stdout: sealed.stdout?.integrity ?? "unavailable",
                    stderr: sealed.stderr?.integrity ?? "unavailable",
                    records: sealed.records?.integrity ?? "unavailable",
                    dirs: { records: journalRelDir("records", Boolean(recordsJournal)),
                        stdout: journalRelDir("stdout", Boolean(stdoutJournal)),
                        stderr: journalRelDir("stderr", Boolean(stderrJournal)) } } })
            : normalizeOutcome({ code: -1, stdout: "", stderr: "", error: "执行器异常退出" }, auth);
        await activity?.finish(outcome);
        await activity?.dispose();
        activeExternals.delete(runDir);
        cleanupRelaySettings(settingsPath); // 临时文件含 token，跑完即删
        if (log && !log.destroyed) {
            log.write("\n--- stderr ---\n" + (r?.stderr || "") + "\n--- exit=" + (r?.code ?? "?") + (r?.timeout ? " timeout=true" : "") + (cancelled ? " cancelled=true" : "") + (r?.error ? " error=" + r.error : "") + " ---\n");
            // 等 flush 完成再返回：宿主/插件重启续读依赖日志完整性，且测试可立即断言文件存在
            await new Promise((res) => { log.once("error", res); log.end(() => { log.removeListener("error", res); res(); }); });
        }
        appendAgentTimelineLine(timelinePath, "exit", "执行结束，退出码 " + (r?.code ?? "?") + (r?.timeout ? "（超时回收）" : ""));
        records.appendPlatform("exit", "执行结束，退出码 " + (r?.code ?? "?") + (r?.timeout ? "（超时回收）" : ""));
    }
    return outcome;
}

const executor = { id, label, kind, run, stop: killExternal };
export default executor;
