// lib/delegate/executors/claude-auth.js — claude CLI 认证中转（relay）配置组装
// 背景：本机 claude CLI 直用 Anthropic 兼容端点 + 带 IP 白名单的应用 Key 时，公司网络出口
// 漂移会间歇触发 403 拦截。中转 = 让 CLI 改打另一套 Anthropic 兼容端点（GLM Coding Plan /
// 自建网关），厂商端点不做 Key 级 IP 白名单校验，403 根治。
//
// 实测关键约束（claude 2.1.251，2026-08-30）：
//   ① 用户级 ~/.claude/settings.json 的 env 块会覆盖进程环境变量——只靠 spawn env 注入
//      中转变量会被用户配置压掉，必须经 --settings <临时文件> 注入（--settings 层优先级更高）；
//   ② 用户 settings 里的模型映射（如百炼端点的 deepseek-*/kimi-*）残留会让请求 404/1214
//      （modelCode 不存在）——glm 预设必须连 ANTHROPIC_MODEL / ANTHROPIC_DEFAULT_*_MODEL
//      / CLAUDE_CODE_SUBAGENT_MODEL 一起覆盖成 GLM 模型名。
// 执行器只吃组装好的 { preset, baseUrl, token, model }；存储见 lib/infra/relayAuth.js 与
// stageConfig.P6.params。

import { randomUUID } from "node:crypto";
import { rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const GLM_ANTHROPIC_BASE_URL = "https://open.bigmodel.cn/api/anthropic";
export const GLM_RELAY_MODEL_DEFAULT = "glm-5.3";

// 需要一并覆盖的模型映射键：用户 settings 可能映射了别家端点的模型名（如 deepseek-v4-pro），
// 中转端点不认识这些名字；缺一个都会在对应场景（子代理/后台任务）报 modelCode 不存在。
const MODEL_ENV_KEYS = [
    "ANTHROPIC_MODEL",
    "ANTHROPIC_DEFAULT_SONNET_MODEL", "ANTHROPIC_DEFAULT_SONNET_MODEL_NAME",
    "ANTHROPIC_DEFAULT_OPUS_MODEL", "ANTHROPIC_DEFAULT_OPUS_MODEL_NAME",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL", "ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME",
    "ANTHROPIC_DEFAULT_FABLE_MODEL", "ANTHROPIC_DEFAULT_FABLE_MODEL_NAME",
    "CLAUDE_CODE_SUBAGENT_MODEL",
];

// 组装 spawn 增量环境变量；preset 缺失/none/字段不全时返回空对象（完全继承现有环境，向后兼容）。
// ANTHROPIC_API_KEY 必须显式置空：官方 CLI 在 -p 模式优先使用它，残留值会让请求仍打原端点。
export function claudeAuthEnv(auth) {
    const preset = auth && auth.preset;
    const token = (auth && auth.token) || "";
    if (preset === "glm" && token) {
        return {
            ANTHROPIC_BASE_URL: GLM_ANTHROPIC_BASE_URL,
            ANTHROPIC_AUTH_TOKEN: token,
            ANTHROPIC_API_KEY: "",
            CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
        };
    }
    if (preset === "custom" && token && auth.baseUrl) {
        return {
            ANTHROPIC_BASE_URL: auth.baseUrl,
            ANTHROPIC_AUTH_TOKEN: token,
            ANTHROPIC_API_KEY: "",
        };
    }
    return {};
}

// 中转是否实际生效（决定 401/403 的提示指向：token 配置 vs Anthropic Console 白名单）
export function authRelayActive(auth) {
    return Object.keys(claudeAuthEnv(auth)).length > 0;
}

// 组装 --settings JSON 内容：中转 env（含 glm 预设的模型映射覆盖）。
// custom 预设不动模型映射——网关后端自选模型，覆盖反而会破坏其配置。
export function claudeRelaySettings(auth) {
    const env = claudeAuthEnv(auth);
    if (!Object.keys(env).length) return null;
    if (auth.preset === "glm") {
        const model = auth.model || GLM_RELAY_MODEL_DEFAULT;
        for (const key of MODEL_ENV_KEYS) env[key] = model;
    }
    return { env };
}

// 写 --settings 临时文件到系统 tmpdir（不在 runDir 产物树内，token 不进任何可导出产物），
// 返回绝对路径；调用方结束后必须 cleanupRelaySettings 删除。
export function writeRelaySettings(auth) {
    const settings = claudeRelaySettings(auth);
    if (!settings) return "";
    const path = join(tmpdir(), "i2p-claude-relay-" + randomUUID() + ".json");
    writeFileSync(path, JSON.stringify(settings), { mode: 0o600 });
    return path;
}

export function cleanupRelaySettings(path) {
    if (!path) return;
    try { rmSync(path, { force: true }); } catch { /* 尽力清理，失败不影响主流程 */ }
}
