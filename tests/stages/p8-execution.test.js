import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import p8 from "../../lib/stages/p8-test-runner.js";
import { stopTestProcess } from "../../lib/infra/testProcess.js";

function fixture(t, source, { timeoutMs = 6000, testEnvironment } = {}) {
  const root = mkdtempSync(join(tmpdir(), "i2p-p8-execution-"));
  const runDir = join(root, "run"); mkdirSync(runDir);
  writeFileSync(join(root, "test.cjs"), source);
  const command = `"${process.execPath}" test.cjs`;
  const startedAt = new Date().toISOString();
  const run = { current: "P8", status: "running", stages: { P8: { status: "running", startedAt } } };
  writeFileSync(join(runDir, "run.json"), JSON.stringify(run));
  t.after(async () => { await stopTestProcess(runDir); rmSync(root, { recursive: true, force: true }); });
  return { root, runDir, run, rcx: { runDir, repoDir: root, run, project: { testCommand: command, testEnvironment }, stageCfgOf: () => ({ timeoutMs }) },
    report: () => JSON.parse(readFileSync(join(runDir, "07-test-report.json"), "utf8")) };
}

test("P8 非交互：标准输入立即 EOF，要求输入的程序自行返回真实错误而非超时", async t => {
  const f = fixture(t, "process.stdin.resume(); process.stdin.on('end',()=>{console.log('EOF');process.exitCode=9;});");
  await assert.rejects(p8(f.rcx), /exitCode=9/);
  assert.equal(f.report().executionStatus, "failed");
  assert.match(f.report().tail, /EOF/);
  assert.equal(f.report().passed, false);
});

test("P8 Windows CMD 修正裸 date 后真实执行后续命令", { skip: process.platform !== "win32" }, async t => {
  const f = fixture(t, "", { timeoutMs: 5000 });
  f.rcx.project.testCommand = "date && echo JEST_WOULD_RUN";
  const start = Date.now();
  await p8(f.rcx);
  assert.ok(Date.now() - start < 4000);
  assert.equal(f.report().executionStatus, "completed");
  assert.match(f.report().tail, /JEST_WOULD_RUN/);
  assert.equal(f.report().executedCommand, "date /t && echo JEST_WOULD_RUN");
  assert.equal(f.report().commandAdaptation.restored, true);
});

test("P8 CMD npm 内层 date 适配后完整跑多时区和最终检查，原文件恢复", { skip: process.platform !== "win32" }, async t => {
  const f = fixture(t, "", { timeoutMs: 25000 });
  mkdirSync(join(f.root, "node_modules", ".bin"), { recursive: true });
  // 隔离的 cross-env 等价入口：由 Node 设置 TZ 后调用真实 npm，不依赖 Git Bash。
  writeFileSync(join(f.root, "node_modules", ".bin", "cross-env.cmd"), `@"${process.execPath}" "%~dp0\\..\\env.cjs" %*\r\n`);
  writeFileSync(join(f.root, "node_modules", "env.cjs"), "const a=process.argv.slice(2),v=a.shift().split('=');const r=require('node:child_process').spawnSync(a.shift(),a,{shell:process.env.npm_config_script_shell,env:{...process.env,[v[0]]:v[1]},stdio:'inherit'});process.exitCode=r.status??1;");
  writeFileSync(join(f.root, "phase.cjs"), "const fs=require('node:fs');fs.appendFileSync('steps',process.argv[2]+':'+(process.env.TZ||'none')+'\\n');fs.copyFileSync('package.json','during-package.json');");
  const original = JSON.stringify({ scripts: {
    test: "cross-env TZ=Pacific/Auckland npm run test-tz && cross-env TZ=Europe/London npm run test-tz-plugin && node phase.cjs final",
    "test-tz": "date && node phase.cjs timezone", "test-tz-plugin": "date && node phase.cjs plugin",
    unrelated: "date",
  } }, null, 4) + "\r\n";
  writeFileSync(join(f.root, "package.json"), original);
  f.rcx.project.testCommand = "npm test";
  await p8(f.rcx);
  assert.equal(readFileSync(join(f.root, "steps"), "utf8"), "timezone:Pacific/Auckland\nplugin:Europe/London\nfinal:none\n");
  assert.equal(readFileSync(join(f.root, "package.json"), "utf8"), original);
  const during = JSON.parse(readFileSync(join(f.root, "during-package.json"), "utf8"));
  assert.equal(during.scripts["test-tz"], "date /t && node phase.cjs timezone");
  assert.equal(during.scripts.unrelated, "date");
  assert.equal(f.report().passed, true);
  assert.equal(f.report().commandAdaptation.changes.length, 2);
  assert.equal(f.report().commandAdaptation.restored, true);
  assert.match(f.report().shell, /cmd\.exe$/i);
});

test("P8 CMD 临时脚本在测试失败、超时、取消后恢复，保留真实结果", { skip: process.platform !== "win32" }, async t => {
  for (const kind of ["failed", "timeout", "cancelled"]) {
    const f = fixture(t, "require('node:fs').writeFileSync('ready','');" + (kind === "failed" ? "process.exitCode=7;" : "setTimeout(()=>{},20000);"), { timeoutMs: kind === "timeout" ? 2500 : 15000 });
    const original = '{"scripts":{"test":"date && node test.cjs && node final.cjs"}}\r\n';
    writeFileSync(join(f.root, "package.json"), original);
    writeFileSync(join(f.root, "final.cjs"), "require('node:fs').writeFileSync('final','bad');");
    f.rcx.project.testCommand = "npm test";
    const execution = p8(f.rcx).then(() => null, error => error);
    if (kind === "cancelled") {
      const deadline = Date.now() + 10000;
      while (!existsSync(join(f.root, "ready")) && Date.now() < deadline) await delay(25);
      assert.ok(existsSync(join(f.root, "ready")));
      await stopTestProcess(f.runDir);
    }
    assert.ok(await execution instanceof Error);
    assert.equal(f.report().executionStatus, kind);
    if (kind === "failed") assert.equal(f.report().exitCode, 7);
    assert.equal(f.report().passed, false);
    assert.equal(f.report().cleanupError, undefined);
    assert.equal(f.report().commandAdaptation.restored, true);
    assert.equal(readFileSync(join(f.root, "package.json"), "utf8"), original);
    assert.equal(existsSync(join(f.root, "final")), false);
  }
});

test("P8 环境预检：平台不匹配、Shell 缺失或类型不支持时不执行命令", async t => {
  for (const testEnvironment of [
    { platform: process.platform === "win32" ? "linux" : "win32", shell: "" },
    { platform: "host", shell: join(tmpdir(), "missing-shell-issue2pr", "bash.exe") },
    { platform: "host", shell: process.execPath },
  ]) {
    const f = fixture(t, "require('node:fs').writeFileSync('executed','bad');", { testEnvironment });
    await assert.rejects(p8(f.rcx), /测试环境不兼容/);
    assert.equal(existsSync(join(f.root, "executed")), false);
    assert.equal(f.report().executionStatus, "environment_error");
    assert.equal(f.report().exitCode, null);
    assert.equal(f.report().platform, process.platform);
    assert.ok(f.report().error);
  }
});

test("P8 取消回收子孙进程，不留继续写文件的后台测试", async t => {
  const f = fixture(t, `const {spawn}=require('node:child_process');
const fs=require('node:fs');
const child=spawn(process.execPath,['worker.cjs'],{stdio:'inherit'});
fs.writeFileSync('child.pid',String(child.pid));
setTimeout(()=>{},10000);`);
  writeFileSync(join(f.root, "worker.cjs"), "require('node:fs').writeFileSync('worker.ready',''); setTimeout(()=>{},10000);");
  const execution = p8(f.rcx).then(() => null, error => error);
  const deadline = Date.now() + 5000;
  while (!existsSync(join(f.root, "worker.ready")) && Date.now() < deadline) await delay(20);
  assert.ok(existsSync(join(f.root, "worker.ready")));
  const pid = Number(readFileSync(join(f.root, "child.pid"), "utf8"));
  await stopTestProcess(f.runDir);
  assert.match((await execution).message, /测试取消/);
  assert.equal(f.report().executionStatus, "cancelled");
  assert.equal(f.report().cleanupError, undefined);
  assert.throws(() => process.kill(pid, 0), error => error.code === "ESRCH");
});

const posixShell = process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : "/bin/sh";
test("P8 旧执行快照缺环境字段时不继承项目后来修改的环境", async t => {
  const f = fixture(t, "console.log('original host environment');", { testEnvironment: {
    platform: process.platform === "win32" ? "linux" : "win32", shell: "",
  } });
  f.run.executionConfig = { revision: 1 };
  await p8(f.rcx);
  assert.equal(f.report().passed, true);
  assert.deepEqual(f.report().requestedEnvironment, { platform: "host", shell: "" });
});

test("P8 显式 Shell 传入 npm 内部脚本，完整执行日期、多时区和最终检查链", { skip: !existsSync(posixShell) }, async t => {
  const f = fixture(t, "", { timeoutMs: 20000, testEnvironment: { platform: process.platform, shell: posixShell } });
  writeFileSync(join(f.root, "phase.cjs"), "const fs=require('node:fs');fs.appendFileSync('steps',process.argv[2]+':'+(process.env.TZ||'none')+'\\n');fs.writeFileSync('script-shell',process.env.npm_config_script_shell);");
  writeFileSync(join(f.root, "tz.cjs"), "const result=require('node:child_process').spawnSync(process.execPath,['phase.cjs',process.argv[3]],{env:{...process.env,TZ:process.argv[2]},stdio:'inherit'});process.exitCode=result.status??1;");
  writeFileSync(join(f.root, "package.json"), JSON.stringify({ scripts: {
    test: "npm run tz1 && npm run tz2 && npm run coverage",
    tz1: "date && node tz.cjs Europe/London tz1",
    tz2: "date && node tz.cjs America/New_York tz2",
    coverage: "node phase.cjs coverage",
  } }));
  f.rcx.project.testCommand = "npm test";
  await p8(f.rcx);
  assert.equal(f.report().passed, true);
  assert.equal(readFileSync(join(f.root, "steps"), "utf8"), "tz1:Europe/London\ntz2:America/New_York\ncoverage:none\n");
  assert.equal(readFileSync(join(f.root, "script-shell"), "utf8"), f.report().shell);
});
