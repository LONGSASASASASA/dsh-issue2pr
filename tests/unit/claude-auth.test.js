// tests/unit/claude-auth.test.js — 认证中转 env 组装与 relay-auth token 存取
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GLM_ANTHROPIC_BASE_URL, claudeAuthEnv, authRelayActive, claudeRelaySettings, writeRelaySettings, cleanupRelaySettings, GLM_RELAY_MODEL_DEFAULT } from "../../lib/delegate/executors/claude-auth.js";
import { loadRelayToken, saveRelayToken } from "../../lib/infra/relayAuth.js";

test("claudeAuthEnv：glm 预设 → BASE_URL/AUTH_TOKEN + API_KEY 显式置空", () => {
    const env = claudeAuthEnv({ preset: "glm", token: "sk-test" });
    assert.equal(env.ANTHROPIC_BASE_URL, GLM_ANTHROPIC_BASE_URL);
    assert.equal(env.ANTHROPIC_AUTH_TOKEN, "sk-test");
    // API_KEY 置空是硬要求：-p 模式优先用它，残留值会让请求仍打 Anthropic 原端点
    assert.equal(env.ANTHROPIC_API_KEY, "");
    assert.equal(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, "1");
    assert.equal(authRelayActive({ preset: "glm", token: "sk-test" }), true);
});

test("claudeAuthEnv：custom 预设需要 baseUrl+token 齐备；缺一即回退空（继承环境）", () => {
    assert.deepEqual(claudeAuthEnv({ preset: "custom", baseUrl: "https://gw.example.com/api/anthropic", token: "t" }), {
        ANTHROPIC_BASE_URL: "https://gw.example.com/api/anthropic",
        ANTHROPIC_AUTH_TOKEN: "t",
        ANTHROPIC_API_KEY: "",
    });
    assert.deepEqual(claudeAuthEnv({ preset: "custom", token: "t" }), {});
    assert.equal(authRelayActive({ preset: "custom", token: "t" }), false);
});

test("claudeAuthEnv：none / 缺 token / 未知 preset → 空对象（向后兼容）", () => {
    assert.deepEqual(claudeAuthEnv(null), {});
    assert.deepEqual(claudeAuthEnv({ preset: "none" }), {});
    assert.deepEqual(claudeAuthEnv({ preset: "glm", token: "" }), {});
    assert.deepEqual(claudeAuthEnv({ preset: "glmm", token: "x" }), {});
    assert.equal(authRelayActive(null), false);
});

test("relayAuth：token 保存/读取往返；损坏文件回落空串", () => {
    const root = mkdtempSync(join(tmpdir(), "i2p-relay-"));
    assert.equal(loadRelayToken(root), "");
    saveRelayToken(root, "sk-roundtrip");
    assert.equal(loadRelayToken(root), "sk-roundtrip");
    // 落盘为 relay-auth.json（与 connections.json 同级凭据文件模式）
    const j = JSON.parse(readFileSync(join(root, "relay-auth.json"), "utf8"));
    assert.equal(j.token, "sk-roundtrip");
    writeFileSync(join(root, "relay-auth.json"), "{oops");
    assert.equal(loadRelayToken(root), "");
});

test("claudeAuthEnv：token 不含在 env 键名外的额外字段（spawn env 面最小化）", () => {
    const env = claudeAuthEnv({ preset: "glm", token: "t", baseUrl: "should-be-ignored" });
    assert.deepEqual(Object.keys(env).sort(), ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC"]);
});

test("claudeRelaySettings：glm → 连模型映射一并覆盖（用户 settings 的别家模型名会 1214）", () => {
    const settings = claudeRelaySettings({ preset: "glm", token: "t" });
    const env = settings.env;
    assert.equal(env.ANTHROPIC_BASE_URL, GLM_ANTHROPIC_BASE_URL);
    assert.equal(env.ANTHROPIC_MODEL, GLM_RELAY_MODEL_DEFAULT);
    assert.equal(env.ANTHROPIC_DEFAULT_SONNET_MODEL, GLM_RELAY_MODEL_DEFAULT);
    assert.equal(env.ANTHROPIC_DEFAULT_HAIKU_MODEL, GLM_RELAY_MODEL_DEFAULT);
    assert.equal(env.CLAUDE_CODE_SUBAGENT_MODEL, GLM_RELAY_MODEL_DEFAULT);
    assert.equal(env.ANTHROPIC_API_KEY, "");
    // 自定义模型名可覆盖
    assert.equal(claudeRelaySettings({ preset: "glm", token: "t", model: "glm-5.3[1m]" }).env.ANTHROPIC_MODEL, "glm-5.3[1m]");
});

test("claudeRelaySettings：custom 不动模型映射（网关后端自选模型）；无中转 → null", () => {
    const custom = claudeRelaySettings({ preset: "custom", baseUrl: "https://gw.example.com", token: "t" });
    assert.equal(custom.env.ANTHROPIC_MODEL, undefined);
    assert.equal(custom.env.ANTHROPIC_BASE_URL, "https://gw.example.com");
    assert.equal(claudeRelaySettings({ preset: "none" }), null);
    assert.equal(claudeRelaySettings(null), null);
});

test("writeRelaySettings/cleanup：临时文件写入 tmpdir、可重复清理", () => {
    const path = writeRelaySettings({ preset: "glm", token: "sk-x" });
    assert.ok(path, "应返回路径");
    assert.ok(path.includes("i2p-claude-relay-"), "应在 tmpdir 且带可识别前缀");
    const content = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(content.env.ANTHROPIC_AUTH_TOKEN, "sk-x");
    cleanupRelaySettings(path);
    cleanupRelaySettings(path); // 幂等
    assert.equal(existsSync(path), false);
    assert.equal(writeRelaySettings({ preset: "none" }), ""); // 无中转不落文件
});
