// CMD 的裸 date 会要求输入。只适配明确的命令片段，不改参数、引号或复杂 Shell 语法。
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, rmSync, realpathSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { writeArtifact } from "../core/store.js";

function segments(command) {
  const parts = [];
  let start = 0, quote = null;
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (c === "^") { i++; continue; }
    if (quote) { if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'") { quote = c; continue; }
    // 分组、重定向和动态展开不猜语义；保留原命令交由真实执行器报告。
    if ("()<>%!".includes(c)) return [];
    if ("&|\r\n".includes(c)) {
      parts.push({ start, end: i, text: command.slice(start, i) });
      if (command[i + 1] === c) i++;
      start = i + 1;
    }
  }
  if (quote) return [];
  parts.push({ start, end: command.length, text: command.slice(start) });
  if (parts.some(p => /^\s*(?:@?rem\b|::)/i.test(p.text))) return [];
  return parts;
}

export function correctCmdDate(command) {
  const replacements = segments(command).filter(p => /^\s*@?date\s*$/i.test(p.text));
  let result = command;
  for (const part of replacements.reverse()) {
    result = result.slice(0, part.start) + part.text.replace(/date/i, "$& /t") + result.slice(part.end);
  }
  return result;
}

function npmScripts(command) {
  const names = [];
  if (segments(command).some(p => /^\s*@?(?:cd|chdir|pushd|popd)\b/i.test(p.text))) return names;
  for (const part of segments(command)) {
    const words = part.text.trim().match(/"[^"\r\n]*"|[^\s"]+/g) || [];
    if (/^@?call$/i.test(words[0] || "")) words.shift();
    if (/^cross-env(?:\.cmd)?$/i.test(words[0] || "")) {
      words.shift();
      while (/^[A-Za-z_][\w]*=/.test(words[0] || "")) words.shift();
    }
    if (!/^@?npm(?:\.cmd)?$/i.test(words[0] || "")) continue;
    if (words.some(w => /^--(?:prefix|workspace|workspaces|script-shell)(?:=|$)|^-w(?:$|=)/i.test(w))) continue;
    if (/^(test|t|tst)$/.test(words[1] || "")) names.push("test");
    else if (["run", "run-script"].includes(words[1]) && /^[\w:.-]+$/.test(words[2] || "")) names.push(words[2]);
  }
  return names;
}

const pendingPath = "trace/cmd-date-pending.json";

export function prepareCmdDate({ command, environment, runDir }) {
  // 先阻止遗留适配被当作源码：原文备份始终在任务目录，禁止覆盖外部新增修改。
  if (existsSync(join(runDir, pendingPath))) {
    throw new Error("上次 CMD 测试脚本适配尚未恢复，请先核对 trace/cmd-date-pending.json 中的原文备份与 package.json");
  }
  if (environment.platform !== "win32" || !/^cmd(?:\.exe)?$/i.test(basename(environment.shell))) {
    return { command, restore() {} };
  }
  const corrected = correctCmdDate(command), changes = [];
  if (corrected !== command) changes.push({ source: "testCommand", before: command, after: corrected });
  const packagePath = join(environment.cwd, "package.json"), roots = npmScripts(command);
  let original, adapted, pkg;
  if (roots.length && existsSync(packagePath)) {
    original = readFileSync(packagePath);
    pkg = JSON.parse(original.toString("utf8").replace(/^\uFEFF/, ""));
    const seen = new Set(), queue = [...roots];
    while (queue.length) {
      const name = queue.shift();
      if (seen.has(name)) continue;
      seen.add(name);
      // npm 自动执行 pre/post 生命周期；不扫描无关脚本或 node_modules。
      if (roots.includes(name)) queue.push("pre" + name, "post" + name);
      const before = pkg.scripts?.[name];
      if (typeof before !== "string") continue;
      const nested = npmScripts(before);
      for (const child of nested) { roots.push(child); queue.push(child); }
      const after = correctCmdDate(before);
      if (after !== before) changes.push({ source: "package.json", script: name, before, after });
    }
    const scriptChanges = changes.filter(c => c.script);
    if (scriptChanges.length) {
      if (realpathSync(packagePath).toLowerCase() !== resolve(packagePath).toLowerCase()) throw new Error("package.json 通过链接指向其他位置，拒绝临时改写测试脚本");
      for (const change of scriptChanges) pkg.scripts[change.script] = change.after;
      adapted = Buffer.from(JSON.stringify(pkg, null, 2) + "\n");
    }
  }
  if (!changes.length) return { command, restore() {} };
  const artifact = `trace/test-command-adaptations/${randomUUID()}.json`;
  const record = { platform: environment.platform, shell: environment.shell, changes, status: "prepared" };
  writeArtifact(runDir, artifact, JSON.stringify(record, null, 2));
  const info = { artifact, changes, restored: !adapted };
  const restore = (cleanupError) => {
    if (adapted) {
      if (cleanupError) throw new Error("进程回收未确认，暂不恢复 package.json；原文备份保留在 " + pendingPath);
      if (!readFileSync(packagePath).equals(adapted)) throw new Error("测试期间 package.json 被其他操作修改，未覆盖新内容；请根据 " + pendingPath + " 恢复适配");
      writeArtifact(environment.cwd, "package.json", original);
      rmSync(join(runDir, pendingPath), { force: true });
    }
    info.restored = true;
    record.status = "restored";
    if (existsSync(runDir)) writeArtifact(runDir, artifact, JSON.stringify(record, null, 2));
  };
  if (adapted) {
    const backup = artifact.replace(/\.json$/, ".package-original.json");
    writeArtifact(runDir, backup, original);
    writeArtifact(runDir, pendingPath, JSON.stringify({ packagePath, backup, artifact }, null, 2));
    try { writeArtifact(environment.cwd, "package.json", adapted); }
    catch (error) {
      // 原子替换失败时，目标仍为原文才撤销恢复标记。
      if (readFileSync(packagePath).equals(original)) rmSync(join(runDir, pendingPath));
      throw error;
    }
  }
  return { command: corrected, info, restore };
}
