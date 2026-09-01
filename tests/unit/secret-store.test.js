import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  getSecretStore, setSecretStoreAdapter, clearSecretStoreAdapter,
  createNativeKeychain, SecretStore,
} from "../../lib/infra/secretStore.js";

const roots = [];

afterEach(() => {
  for (const root of roots.splice(0)) clearSecretStoreAdapter(root);
});

test("SecretStore：keychain 不可用时显式降级到权限收紧的非加密文件", () => {
  const root = mkdtempSync(join(tmpdir(), "i2p-secret-"));
  roots.push(root);
  setSecretStoreAdapter(root, { available: () => false, reason: "测试中禁用系统密钥环" });

  const store = getSecretStore(root);
  const saved = store.set("issue2pr:test:one", "secret-value");

  assert.equal(saved.mode, "file-fallback");
  assert.equal(saved.encrypted, false);
  assert.match(saved.warning, /非加密/);
  assert.equal(store.get("issue2pr:test:one").value, "secret-value");
  const secretDir = join(root, "secrets");
  const secretFiles = readdirSync(secretDir);
  assert.equal(secretFiles.some((name) => name.endsWith(".tmp")), false);
  assert.ok(secretFiles.some((name) => readFileSync(join(secretDir, name), "utf8") === "secret-value"));
  if (process.platform !== "win32") {
    assert.equal(statSync(secretDir).mode & 0o777, 0o700);
    assert.equal(statSync(join(secretDir, secretFiles[0])).mode & 0o777, 0o600);
  }
});

test("SecretStore：可用 keychain 优先，文件回退不产生", () => {
  const root = mkdtempSync(join(tmpdir(), "i2p-secret-keychain-"));
  roots.push(root);
  const records = new Map();
  const adapter = {
    available: () => true,
    set: (service, account, value) => records.set(service + ":" + account, value),
    get: (service, account) => records.get(service + ":" + account) || null,
    delete: (service, account) => records.delete(service + ":" + account),
  };
  setSecretStoreAdapter(root, adapter);

  const store = getSecretStore(root);
  const saved = store.set("issue2pr:test:keychain", "keychain-value");

  assert.equal(saved.mode, "keychain");
  assert.equal(saved.encrypted, true);
  assert.equal(store.get("issue2pr:test:keychain").value, "keychain-value");
  assert.equal(readdirSync(root).includes("secrets"), false);
});

test("SecretStore：默认 native keychain 不可用时返回可解释状态，不假称已加密", () => {
  const adapter = createNativeKeychain({ platform: "win32" });
  assert.equal(adapter.available(), false);
  assert.match(adapter.reason, /Credential Manager|可用|不可用/);
});

test("SecretStore：Windows fallback 明确说明 ACL 权限收紧不保证", () => {
  const root = mkdtempSync(join(tmpdir(), "i2p-secret-win-warning-"));
  const store = new SecretStore(root, {
    platform: "win32",
    keychain: { available: () => false },
  });

  const saved = store.set("issue2pr:test:win-warning", "secret-value");

  assert.match(saved.warning, /Windows/);
  assert.match(saved.warning, /ACL|权限/);
  assert.match(saved.warning, /不保证|无法保证/);
});

test("SecretStore：fallback 文件写入采用唯一临时文件并可删除", () => {
  const root = mkdtempSync(join(tmpdir(), "i2p-secret-delete-"));
  roots.push(root);
  setSecretStoreAdapter(root, null);
  const store = getSecretStore(root);
  store.set("issue2pr:test:delete", "to-delete");
  assert.equal(store.delete("issue2pr:test:delete"), true);
  assert.equal(store.get("issue2pr:test:delete"), null);
});

test("SecretStore：keychain 成功但旧 fallback 清理失败时保留显式 warning", () => {
  const root = mkdtempSync(join(tmpdir(), "i2p-secret-cleanup-warning-"));
  const ref = "issue2pr:test:cleanup-warning";
  const digest = createHash("sha256").update(ref, "utf8").digest("hex");
  const secretDir = join(root, "secrets");
  mkdirSync(secretDir, { recursive: true });
  writeFileSync(join(secretDir, digest + ".secret"), "old-value");
  const records = new Map();
  const keychain = {
    available: () => true,
    set: (service, account, value) => records.set(service + ":" + account, value),
    get: (service, account) => records.get(service + ":" + account) || null,
  };
  const store = new SecretStore(root, {
    keychain,
    unlinkFile: () => { throw new Error("文件被占用"); },
  });

  const saved = store.set(ref, "new-value");

  assert.equal(saved.mode, "keychain");
  assert.equal(saved.encrypted, true);
  assert.match(saved.warning, /fallback|清理失败|非加密/);
  assert.match(store.describe(ref).warning, /fallback|清理失败|非加密/);
});
