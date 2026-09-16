// 无人值守测试执行：明确 Shell、关闭输入、持续输出、统一取消和进程树回收。
import { spawn } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { basename, isAbsolute, resolve } from "node:path";
import { prepareCmdDate } from "./cmdDate.js";

const active = new Map();

export function resolveTestEnvironment(value = {}, cwd) {
  const platform = value.platform || "host";
  if (!["host", "win32", "linux", "darwin"].includes(platform)) throw new Error("不支持的测试平台: " + platform);
  if (platform !== "host" && platform !== process.platform) {
    throw new Error(`测试要求 ${platform}，当前宿主为 ${process.platform}；请在匹配的平台运行，不会自动切换环境`);
  }
  if (!cwd || !statSync(cwd).isDirectory()) throw new Error("测试工作目录不存在: " + cwd);
  const shell = value.shell || (process.platform === "win32" ? process.env.ComSpec || "C:\\Windows\\System32\\cmd.exe" : "/bin/sh");
  if (typeof shell !== "string" || !isAbsolute(shell)) throw new Error("测试 Shell 必须是可执行文件的绝对路径");
  if (!/^(cmd|sh|bash|dash|zsh)(\.exe)?$/i.test(basename(shell))) {
    throw new Error("测试 Shell 仅支持 cmd 或 sh 兼容 Shell（如 Bash）；请配置对应可执行文件路径");
  }
  if (!statSync(shell).isFile()) throw new Error("测试 Shell 不是文件: " + shell);
  accessSync(shell, process.platform === "win32" ? constants.F_OK : constants.X_OK);
  return { platform: process.platform, shell: resolve(shell), cwd: resolve(cwd) };
}

async function killProcessTree(child) {
  if (!child?.pid) return null;
  if (process.platform !== "win32") {
    try { process.kill(-child.pid, "SIGKILL"); }
    catch (error) { if (error.code !== "ESRCH") return "进程组回收失败: " + error.message; }
    return null;
  }
  return new Promise(resolveKill => {
    const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    let done = false;
    const finish = error => { if (done) return; done = true; clearTimeout(timer); resolveKill(error); };
    const timer = setTimeout(() => { killer.kill(); finish("进程树回收超时"); }, 5000);
    killer.once("error", error => finish("进程树回收失败: " + error.message));
    killer.once("close", code => finish(code === 0 || child.exitCode !== null || child.signalCode ? null : "taskkill 回收失败，退出码 " + code));
  });
}

export async function stopTestProcess(runDir, reason = "用户停止") {
  const execution = active.get(resolve(runDir));
  if (!execution) return false;
  await execution.cancel(reason);
  const result = await execution.done;
  if (result.cleanupError) throw new Error(result.cleanupError);
  return true;
}

export async function stopAllTestProcesses() {
  const results = await Promise.allSettled([...active.keys()].map(key => stopTestProcess(key, "宿主停止")));
  return results;
}

export async function runTestProcess({ runDir, command, environment, timeoutMs, onOutput, onChild, shouldCancel }) {
  const key = resolve(runDir);
  await stopTestProcess(key, "被新的测试执行替代");
  const cancelled = shouldCancel?.();
  if (cancelled) return { executionStatus: "cancelled", exitCode: null, signal: null, ms: 0, error: cancelled };
  const env = { ...process.env, CI: process.env.CI || "true" };
  // npm 的子脚本也使用同一个 Shell，不能仅替换最外层命令解释器。
  for (const name of Object.keys(env)) if (name.toLowerCase() === "npm_config_script_shell") delete env[name];
  env.npm_config_script_shell = environment.shell;
  let child, finish, timer, poll, closeTimer, stopping, status, reason, spawnError, cleanupError;
  let closed = false, settled = false, code = null, signal = null;
  let adaptation;
  const started = Date.now();
  const done = new Promise(resolveDone => { finish = resolveDone; });
  const settle = (force = false) => {
    if (settled || stopping && !closed && !force) return;
    settled = true;
    clearTimeout(timer); clearInterval(poll); clearTimeout(closeTimer);
    try { adaptation?.restore(cleanupError); }
    catch (error) { cleanupError = [cleanupError, String(error.message || error)].filter(Boolean).join("；"); }
    if ((!cleanupError || closed) && active.get(key)?.done === done) active.delete(key);
    finish({ executionStatus: status || (spawnError ? "spawn_failed" : code === 0 ? "completed" : "failed"),
      exitCode: Number.isInteger(code) ? code : null, signal, ms: Date.now() - started,
      ...(reason || spawnError ? { error: reason || spawnError } : {}), ...(cleanupError ? { cleanupError } : {}),
      ...(adaptation?.info ? { commandAdaptation: adaptation.info, executedCommand: adaptation.command } : {}) });
  };
  const terminate = (kind, message) => {
    if (settled) return Promise.resolve();
    if (stopping) return stopping;
    status = kind; reason = message;
    stopping = (async () => {
      cleanupError = await killProcessTree(child);
      // 必须等待杀树命令和输出管道都结束，避免重跑与旧进程写文件竞争。
      if (closed) settle();
      else closeTimer = setTimeout(() => {
        cleanupError ||= "进程回收后未确认输出管道关闭";
        child?.stdout?.destroy(); child?.stderr?.destroy();
        // 回收失败时保留活动记录，后续重跑必须等旧进程真实关闭，不能假称已清理。
        settle(true);
      }, 1000);
    })();
    return stopping;
  };
  active.set(key, { done, cancel: message => terminate("cancelled", message) });
  try {
    try { adaptation = prepareCmdDate({ command, environment, runDir: key }); }
    catch (error) { status = "environment_error"; throw error; }
    if (adaptation.info) onOutput?.("[Windows CMD 兼容] 裸 date 已改为 date /t；适配记录：" + adaptation.info.artifact + "\n");
    child = spawn(adaptation.command, { cwd: environment.cwd, env, shell: environment.shell,
      stdio: ["ignore", "pipe", "pipe"], windowsHide: true, detached: process.platform !== "win32" });
    onChild?.(child);
    for (const stream of [child.stdout, child.stderr]) {
      stream?.setEncoding("utf8");
      stream?.on("data", text => onOutput?.(text));
    }
    child.once("error", error => { spawnError = error.message; });
    child.once("close", (exitCode, exitSignal) => {
      closed = true; code = exitCode; signal = exitSignal;
      if (settled) { if (active.get(key)?.done === done) active.delete(key); return; }
      if (stopping) stopping.then(settle); else settle();
    });
    timer = setTimeout(() => { void terminate("timeout", `测试超过 ${timeoutMs}ms，已请求终止进程树`); }, timeoutMs);
    poll = setInterval(() => {
      const cancellation = shouldCancel?.();
      if (cancellation) void terminate("cancelled", cancellation);
    }, 100);
    poll.unref?.();
  } catch (error) { spawnError = error.message; closed = true; settle(); }
  return done;
}
