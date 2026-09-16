import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { correctCmdDate, prepareCmdDate } from "../../lib/infra/cmdDate.js";
import { runTestProcess } from "../../lib/infra/testProcess.js";

function fixture(t, scripts) {
  const cwd = mkdtempSync(join(tmpdir(), "i2p-cmd-date-")), runDir = join(cwd, "run");
  mkdirSync(runDir);
  const original = Buffer.from(JSON.stringify({ name: "fixture", scripts, custom: "保留原文格式" }, null, 4) + "\r\n");
  writeFileSync(join(cwd, "package.json"), original);
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  return { cwd, runDir, original, command: "npm test", environment: { platform: "win32", shell: "cmd.exe", cwd } };
}

test("CMD date 仅修正独立裸命令，保留分隔符、大小写与空白", () => {
  assert.equal(correctCmdDate(" date && npm test || @DATE\r\ndate"), " date /t && npm test || @DATE /t\r\ndate /t");
  for (const command of ["date /t", "date 2026-09-15", "echo date", 'node -e "console.log(\'date && date\')"',
    'echo "date & date"', "echo date ^& date", "update && node date.js", "(date && npm test)",
    "date > timestamp.txt", "date & echo %SHELL%", "rem date && date", "cmd /c \"date\""]) {
    assert.equal(correctCmdDate(command), command, command);
  }
});

test("CMD npm 测试调用链包含子脚本与生命周期，适配记录可审计，恢复逐字节一致", t => {
  const f = fixture(t, { pretest: "date", test: "cross-env TZ=Pacific/Auckland npm run test-tz && npm run test-tz-plugin && node coverage.cjs",
    "pretest-tz": "date", "test-tz": "date && node timezone.cjs", "posttest-tz": "date /t",
    "test-tz-plugin": "date && node plugin.cjs", unrelated: "date", literal: 'echo "date"' });
  const adaptation = prepareCmdDate(f), pkg = JSON.parse(readFileSync(join(f.cwd, "package.json"), "utf8"));
  assert.equal(pkg.scripts["test-tz"], "date /t && node timezone.cjs");
  assert.equal(pkg.scripts["test-tz-plugin"], "date /t && node plugin.cjs");
  assert.equal(pkg.scripts.pretest, "date /t");
  assert.equal(pkg.scripts["pretest-tz"], "date /t");
  assert.equal(pkg.scripts.unrelated, "date");
  assert.equal(adaptation.info.changes.length, 4);
  assert.ok(existsSync(join(f.runDir, adaptation.info.artifact)));
  assert.throws(() => prepareCmdDate(f), /尚未恢复/);
  adaptation.restore();
  assert.deepEqual(readFileSync(join(f.cwd, "package.json")), f.original);
  assert.equal(adaptation.info.restored, true);
  assert.equal(existsSync(join(f.runDir, "trace/cmd-date-pending.json")), false);
});

test("非 CMD、非 Windows、切换目录或其他 npm 工作区不猜测改写", t => {
  const f = fixture(t, { test: "date && node test.cjs" });
  for (const override of [{ environment: { ...f.environment, platform: "linux" } },
    { environment: { ...f.environment, shell: "bash.exe" } }, { command: "cd other && npm test" },
    { command: "npm --prefix other test" }, { command: "npm run test --workspace other" }]) {
    const adaptation = prepareCmdDate({ ...f, ...override });
    assert.equal(adaptation.info, undefined);
    assert.deepEqual(readFileSync(join(f.cwd, "package.json")), f.original);
  }
});

test("恢复遇到外部修改时保留新内容和原文备份，阻止重复执行", t => {
  const f = fixture(t, { test: "date && node test.cjs" });
  const adaptation = prepareCmdDate(f);
  const edited = readFileSync(join(f.cwd, "package.json"), "utf8") + "\n";
  writeFileSync(join(f.cwd, "package.json"), edited);
  assert.throws(() => adaptation.restore(), /其他操作修改/);
  assert.equal(readFileSync(join(f.cwd, "package.json"), "utf8"), edited);
  const journal = JSON.parse(readFileSync(join(f.runDir, "trace/cmd-date-pending.json"), "utf8"));
  assert.deepEqual(readFileSync(join(f.runDir, journal.backup)), f.original);
  assert.throws(() => prepareCmdDate(f), /尚未恢复/);
});

test("进程回收未确认时不覆盖运行中的脚本；删除任务后收尾不重建任务目录", t => {
  const f = fixture(t, { test: "date && node test.cjs" }), adaptation = prepareCmdDate(f);
  assert.throws(() => adaptation.restore("taskkill failed"), /进程回收未确认/);
  assert.equal(adaptation.info.restored, false);
  rmSync(f.runDir, { recursive: true, force: true });
  adaptation.restore();
  assert.deepEqual(readFileSync(join(f.cwd, "package.json")), f.original);
  assert.equal(existsSync(f.runDir), false);
});

test("等待旧执行结束期间已取消的测试不再适配文件或启动进程", async t => {
  const f = fixture(t, { test: "date && node test.cjs" });
  const result = await runTestProcess({ ...f, timeoutMs: 1000, shouldCancel: () => "已被新执行替代",
    onChild: () => assert.fail("不应启动旧执行") });
  assert.equal(result.executionStatus, "cancelled");
  assert.deepEqual(readFileSync(join(f.cwd, "package.json")), f.original);
  assert.equal(existsSync(join(f.runDir, "trace")), false);
});
