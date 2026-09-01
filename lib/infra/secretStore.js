// lib/infra/secretStore.js — 凭据存储边界
// 主配置 JSON 只保存 secretRef；系统密钥环不可用时，fallback 文件仅依赖本机权限，绝不宣称加密。
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

export const SECRET_STORAGE = {
  KEYCHAIN: "keychain",
  FILE_FALLBACK: "file-fallback",
};

export const SECRET_FALLBACK_WARNING =
  "系统密钥环不可用，已降级为本机权限保护的非加密文件存储；请勿复制或提交数据目录";
export const SECRET_FALLBACK_PRESENT_WARNING =
  "检测到残留的非加密 fallback 文件，清理完成前不得视为仅由系统密钥环保护";

const SECRET_WINDOWS_FALLBACK_WARNING =
  "系统密钥环不可用，已降级为 Windows 上的非加密文件存储；Windows ACL/chmod 权限收紧不保证，请勿复制或提交数据目录";
const SECRET_WINDOWS_FALLBACK_PRESENT_WARNING =
  "检测到残留的非加密 fallback 文件；Windows ACL/chmod 权限隔离不保证，清理完成前不得视为仅由系统密钥环保护";

const SERVICE_NAME = "dsh-issue2pr";
const storeCache = new Map();
const adapterOverrides = new Map();

function harden(path, mode) {
  try { chmodSync(path, mode); } catch { /* Windows ACL 不由 chmod 完整表达，保留 best effort */ }
}

function ensurePrivateDir(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  harden(path, 0o700);
}

/**
 * 以唯一临时文件写入私有文件并原子替换目标。

 * Args:
 *   path: 目标文件路径。
 *   content: 要写入的文本。
 *   mode: 文件权限，默认仅当前用户可读写。

 * Returns:
 *   无返回值。
 */
export function atomicWritePrivateFile(path, content, mode = 0o600) {
  const target = String(path);
  const parent = dirname(target);
  ensurePrivateDir(parent);
  const tmp = join(parent, "." + basename(target) + "." + randomUUID() + ".tmp");
  try {
    writeFileSync(tmp, String(content), { encoding: "utf8", mode });
    harden(tmp, mode);
    renameSync(tmp, target);
    harden(target, mode);
  } finally {
    if (existsSync(tmp)) {
      try { unlinkSync(tmp); } catch { /* 尽力清理临时文件 */ }
    }
  }
}

function commandRunner(options) {
  return options && options.execFileSync ? options.execFileSync : execFileSync;
}

function unavailable(reason) {
  return {
    available: () => false,
    reason,
  };
}

/**
 * 创建当前平台的系统密钥环适配器。

 * Args:
 *   options: 可注入 platform 与 execFileSync，便于离线测试。

 * Returns:
 *   同步 keychain 适配器；不可用时返回带 reason 的显式降级适配器。
 */
export function createNativeKeychain(options = {}) {
  const platform = options.platform || process.platform;
  const run = commandRunner(options);
  if (platform === "win32") {
    return unavailable("Windows Credential Manager 需要额外原生适配器，当前无新增依赖，已显式降级");
  }
  if (platform === "darwin") {
    let state;
    const available = () => {
      if (state !== undefined) return state;
      try {
        run("security", ["-h"], { stdio: "ignore" });
        state = true;
      } catch { state = false; }
      return state;
    };
    return {
      available,
      reason: "macOS Keychain",
      get: (service, account) => {
        if (!available()) return null;
        try {
          return String(run("security", ["find-generic-password", "-s", service, "-a", account, "-w"], {
            encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
          })).replace(/\r?\n$/, "");
        } catch { return null; }
      },
      set: (service, account, value) => {
        if (!available()) throw new Error("macOS Keychain 不可用");
        // security 的 -w 无参数形式从 stdin 读取，避免把秘密放进命令 argv。
        run("security", ["add-generic-password", "-U", "-s", service, "-a", account, "-w"], {
          input: String(value), encoding: "utf8", stdio: ["pipe", "ignore", "pipe"],
        });
      },
      delete: (service, account) => {
        if (!available()) return;
        try { run("security", ["delete-generic-password", "-s", service, "-a", account], { stdio: "ignore" }); }
        catch { /* 不存在视为已删除 */ }
      },
    };
  }
  if (platform === "linux") {
    let state;
    const available = () => {
      if (state !== undefined) return state;
      try {
        run("secret-tool", ["--version"], { stdio: "ignore" });
        state = true;
      } catch { state = false; }
      return state;
    };
    return {
      available,
      reason: "Linux Secret Service",
      get: (service, account) => {
        if (!available()) return null;
        try {
          return String(run("secret-tool", ["lookup", "service", service, "account", account], {
            encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
          })).replace(/\r?\n$/, "");
        } catch { return null; }
      },
      set: (service, account, value) => {
        if (!available()) throw new Error("Linux Secret Service 不可用");
        // secret-tool 从 stdin 读取密码，秘密不进入 argv。
        run("secret-tool", ["store", "--label", SERVICE_NAME, "service", service, "account", account], {
          input: String(value), encoding: "utf8", stdio: ["pipe", "ignore", "pipe"],
        });
      },
      delete: () => { /* secret-tool 没有跨发行版一致的删除命令，fallback 仍会清理 */ },
    };
  }
  return unavailable("当前平台没有内置 keychain 适配器，已显式降级");
}

function adapterAvailable(adapter) {
  if (!adapter) return false;
  try {
    return typeof adapter.available === "function" ? adapter.available() === true : adapter.available !== false;
  } catch { return false; }
}

function result(mode, encrypted, warning = "") {
  return { mode, encrypted, warning };
}

function fallbackPath(root, ref) {
  const digest = createHash("sha256").update(String(ref), "utf8").digest("hex");
  return join(root, "secrets", digest + ".secret");
}

/**
 * 管理单个 secretRef 的 keychain-first 存取。

 * Args:
 *   root: 插件数据根目录。
 *   options: 可注入同步 keychain 适配器与日志函数。

 * Returns:
 *   SecretStore 实例。
 */
export class SecretStore {
  constructor(root, options = {}) {
    this.root = String(root || "");
    if (!this.root) throw new Error("SecretStore root 不能为空");
    this.fallbackDir = join(this.root, "secrets");
    this.platform = options.platform || process.platform;
    this.keychain = Object.prototype.hasOwnProperty.call(options, "keychain")
      ? options.keychain : createNativeKeychain({ platform: this.platform });
    this.log = typeof options.log === "function" ? options.log : () => {};
    this.unlinkFile = typeof options.unlinkFile === "function" ? options.unlinkFile : unlinkSync;
    this.keychainState = null;
  }

  fallbackWarning() {
    return this.platform === "win32" ? SECRET_WINDOWS_FALLBACK_WARNING : SECRET_FALLBACK_WARNING;
  }

  fallbackPresentWarning() {
    return this.platform === "win32"
      ? SECRET_WINDOWS_FALLBACK_PRESENT_WARNING : SECRET_FALLBACK_PRESENT_WARNING;
  }

  keychainAvailable() {
    if (this.keychainState !== null) return this.keychainState;
    this.keychainState = adapterAvailable(this.keychain);
    return this.keychainState;
  }

  markKeychainUnavailable(error) {
    this.keychainState = false;
    const detail = error && error.message ? String(error.message) : "适配器不可用";
    this.log("SecretStore 已降级到非加密文件存储: " + detail);
  }

  /**
   * 读取 secret。

   * Args:
   *   ref: 逻辑 secretRef。

   * Returns:
   *   `{ value, mode, encrypted, warning }`，不存在时返回 null。
   */
  get(ref) {
    const account = String(ref || "");
    if (!account) return null;
    const path = fallbackPath(this.root, account);
    if (this.keychainAvailable() && typeof this.keychain.get === "function") {
      try {
        const value = this.keychain.get(SERVICE_NAME, account);
        if (typeof value === "string") {
          const warning = existsSync(path) ? this.fallbackPresentWarning() : "";
          return { value, ...result(SECRET_STORAGE.KEYCHAIN, true, warning) };
        }
      } catch (error) { this.markKeychainUnavailable(error); }
    }
    if (!existsSync(path)) return null;
    try {
      const value = readFileSync(path, "utf8");
      return { value, ...result(SECRET_STORAGE.FILE_FALLBACK, false, this.fallbackWarning()) };
    } catch (error) {
      this.log("SecretStore fallback 读取失败: " + String(error && error.message || error));
      return null;
    }
  }

  /**
   * 保存 secret，优先写入系统 keychain。

   * Args:
   *   ref: 逻辑 secretRef。
   *   value: 要保存的秘密。

   * Returns:
   *   实际存储模式与安全说明。
   */
  set(ref, value) {
    const account = String(ref || "");
    if (!account) throw new Error("secretRef 不能为空");
    const secret = String(value ?? "");
    if (!secret) {
      this.delete(account);
      return result("none", false);
    }
    if (this.keychainAvailable() && typeof this.keychain.set === "function") {
      try {
        this.keychain.set(SERVICE_NAME, account, secret);
        const oldPath = fallbackPath(this.root, account);
        let warning = "";
        if (existsSync(oldPath)) {
          try { this.unlinkFile(oldPath); }
          catch (error) {
            warning = this.fallbackPresentWarning() + "（清理失败）";
            this.log("SecretStore fallback 清理失败: " + String(error && error.message || error));
          }
        }
        return result(SECRET_STORAGE.KEYCHAIN, true, warning);
      } catch (error) { this.markKeychainUnavailable(error); }
    }
    const path = fallbackPath(this.root, account);
    atomicWritePrivateFile(path, secret, 0o600);
    return result(SECRET_STORAGE.FILE_FALLBACK, false, this.fallbackWarning());
  }

  /**
   * 删除 secret 的 keychain 与 fallback 副本。

   * Args:
   *   ref: 逻辑 secretRef。

   * Returns:
   *   是否至少清理了一个存储位置。
   */
  delete(ref) {
    const account = String(ref || "");
    if (!account) return false;
    let removed = false;
    if (this.keychainAvailable() && typeof this.keychain.delete === "function") {
      try { this.keychain.delete(SERVICE_NAME, account); removed = true; }
      catch (error) { this.markKeychainUnavailable(error); }
    }
    const path = fallbackPath(this.root, account);
    if (existsSync(path)) {
      try { this.unlinkFile(path); removed = true; } catch { /* 尽力清理 */ }
    }
    return removed;
  }

  /**
   * 返回当前存储能力，供 API/UI 诚实展示降级状态。

   * Args:
   *   ref: 可选 secretRef。

   * Returns:
   *   `{ mode, encrypted, warning }`。
   */
  describe(ref = "") {
    const current = ref ? this.get(ref) : null;
    if (current) return result(current.mode, current.encrypted, current.warning);
    if (this.keychainAvailable()) return result(SECRET_STORAGE.KEYCHAIN, true);
    return result(SECRET_STORAGE.FILE_FALLBACK, false, this.fallbackWarning());
  }
}

export function secretRefFor(scope, id) {
  return "issue2pr:" + encodeURIComponent(String(scope || "secret")) + ":" + encodeURIComponent(String(id || "default"));
}

/**
 * 获取指定数据根目录的 SecretStore 单例。

 * Args:
 *   root: 插件数据根目录。

 * Returns:
 *   可复用的 SecretStore 实例。
 */
export function getSecretStore(root) {
  const key = String(root || "");
  if (!storeCache.has(key)) {
    const keychain = adapterOverrides.has(key) ? adapterOverrides.get(key) : createNativeKeychain();
    storeCache.set(key, new SecretStore(key, { keychain }));
  }
  return storeCache.get(key);
}

// 测试/宿主扩展注入点：root 级别隔离，避免并行测试互相污染。
export function setSecretStoreAdapter(root, adapter) {
  const key = String(root || "");
  adapterOverrides.set(key, adapter);
  storeCache.delete(key);
}

export function clearSecretStoreAdapter(root) {
  const key = String(root || "");
  adapterOverrides.delete(key);
  storeCache.delete(key);
}
