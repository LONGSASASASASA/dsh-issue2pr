// lib/infra/relayAuth.js — claude CLI 认证中转 token（全局一份，<dataRoot>/relay-auth.json）
// relay-auth.json 只保存 secretRef/存储模式；秘密由 SecretStore keychain-first 管理。
// preset/baseUrl 属项目配置（stageConfig.P6.params），token 全局共享：一套中转凭据多项目复用。
import { readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { atomicWritePrivateFile, getSecretStore, secretRefFor } from "./secretStore.js";

const relayFile = (root) => join(root || "", "relay-auth.json");
const RELAY_REF = secretRefFor("relay", "default");

function migrateLegacy(root, token) {
    const store = getSecretStore(root);
    const saved = store.set(RELAY_REF, token);
    const metadata = { version: 2, secretRef: RELAY_REF, secretStorage: saved.mode };
    if (saved.warning) metadata.secretWarning = saved.warning;
    try { atomicWritePrivateFile(relayFile(root), JSON.stringify(metadata, null, 2)); }
    catch { /* 下次读取重试迁移，当前调用仍返回内存中的 token */ }
    return token;
}

export function loadRelayToken(root) {
    try {
        const j = JSON.parse(readFileSync(relayFile(root), "utf8"));
        if (typeof j.token === "string" && j.token) return migrateLegacy(root, j.token);
        const ref = typeof j.secretRef === "string" && j.secretRef ? j.secretRef : RELAY_REF;
        const loaded = getSecretStore(root).get(ref);
        return loaded ? loaded.value : "";
    } catch { return ""; }
}

export function saveRelayToken(root, token) {
    const value = String(token || "").trim();
    const store = getSecretStore(root);
    if (!value) {
        store.delete(RELAY_REF);
        try { unlinkSync(relayFile(root)); } catch { /* 已不存在 */ }
        return;
    }
    const saved = store.set(RELAY_REF, value);
    const metadata = { version: 2, secretRef: RELAY_REF, secretStorage: saved.mode };
    if (saved.warning) metadata.secretWarning = saved.warning;
    atomicWritePrivateFile(relayFile(root), JSON.stringify(metadata, null, 2));
}

export function relayAuthExists(root) {
    return Boolean(loadRelayToken(root));
}

export function relayAuthInfo(root) {
    try {
        const j = JSON.parse(readFileSync(relayFile(root), "utf8"));
        const ref = typeof j.secretRef === "string" && j.secretRef ? j.secretRef : RELAY_REF;
        const info = getSecretStore(root).describe(ref);
        return { exists: Boolean(loadRelayToken(root)), storage: info.mode, encrypted: info.encrypted, warning: info.warning };
    } catch {
        const info = getSecretStore(root).describe(RELAY_REF);
        return { exists: false, storage: info.mode, encrypted: info.encrypted, warning: info.warning };
    }
}
