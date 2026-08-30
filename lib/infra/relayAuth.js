// lib/infra/relayAuth.js — claude CLI 认证中转 token（全局一份，<dataRoot>/relay-auth.json）
// 明文落盘，与 connections.json（git token）同级安全；返回给 UI 一律打码。
// preset/baseUrl 属项目配置（stageConfig.P6.params），token 全局共享：一套中转凭据多项目复用。
import { existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";

const relayFile = (root) => join(root || "", "relay-auth.json");

export function loadRelayToken(root) {
    try {
        const j = JSON.parse(readFileSync(relayFile(root), "utf8"));
        return typeof j.token === "string" ? j.token : "";
    } catch { return ""; }
}

export function saveRelayToken(root, token) {
    const tmp = relayFile(root) + ".tmp";
    writeFileSync(tmp, JSON.stringify({ token: String(token || "") }, null, 2));
    renameSync(tmp, relayFile(root)); // 原子替换，与 connections.json 同策略
}

export function relayAuthExists(root) {
    return existsSync(relayFile(root));
}
