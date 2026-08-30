// lib/delegate/executors/index.js — 委外执行器注册表与统一契约
// 执行器 = 委外执行的具体通道（CLI 子进程 / 宿主原生智能体）。阶段层（p6-coder）只负责
// 任务包构建与产物验收（patches/report 硬标准不变），执行细节全部下沉到执行器。
//
// 统一契约：
//   id     唯一标识（落档 run.json externalExec.executor，报告/coder-report 的 mode 同源）
//   label  UI 显示名
//   kind   "cli"（spawn 子进程）| "dsh"（宿主原生智能体，进程内）
//   run(runCtx)   执行一次委外任务；runCtx: { rcx, bin?, repoDir, runDir, prompt, timeoutMs }
//   stop(runDir)  停止该 runDir 上的外部执行（杀进程树 / 取消智能体），返回是否发起了停止
import claudeCode from "./claude-code.js";
import dshAgent from "./dsh-agent.js";

const EXECUTORS = new Map([
    ["claude-code", claudeCode],
    ["dsh-agent", dshAgent],
]);

export function resolveExecutor(id) {
    return EXECUTORS.get(id || "claude-code") || null;
}

// 停止一个 Run 上的所有外部执行（stop/删除 Run/删除项目时调用）。
// 逐执行器广播而非按 run.json 记录分派：切换执行器后的残留进程同样要能被杀掉。
export function stopExternals(runDir) {
    let hit = false;
    for (const ex of EXECUTORS.values()) hit = ex.stop(runDir) || hit;
    return hit;
}
