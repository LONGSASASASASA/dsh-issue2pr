// tests/stage-config.test.js — 阶段级配置模型：合并/提示词覆盖/校验/委托任务包/就绪判定/路由覆盖
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  STAGE_DEFS, stageCfgOf, sysOf, paramsOf, routeOverridesOf, validateStageConfig,
  stageDelegated, buildDelegateTask, delegateReady,
} from "../lib/stageConfig.js";
import { maybeDelegate } from "../lib/stages/helpers.js";

const root = mkdtempSync(join(tmpdir(), "i2p-scfg-"));

test("STAGE_DEFS：11 阶段齐全，P7 无可配能力，P8 含测试命令能力", () => {
  assert.equal(Object.keys(STAGE_DEFS).length, 11);
  assert.deepEqual(STAGE_DEFS.P7.caps, {});
  assert.equal(STAGE_DEFS.P8.caps.test, true);
  assert.ok(STAGE_DEFS.P6.prompts.coder);
  assert.ok(STAGE_DEFS.P11.prompts.desc && STAGE_DEFS.P11.prompts.gate);
});

test("stageCfgOf：无配置回落默认；部分覆盖逐字段生效", () => {
  const base = stageCfgOf(null, "P1");
  assert.equal(base.prompts[""], STAGE_DEFS.P1.prompts[""]);
  assert.equal(base.provider, "");
  const proj = { stageConfig: { P1: { prompts: { "": "自定义" }, model: "m1", provider: "p1", reasoningEffort: "high", timeoutMs: 120000, maxTokens: 4096 } } };
  const cfg = stageCfgOf(proj, "P1");
  assert.equal(cfg.prompts[""], "自定义");
  assert.equal(cfg.provider, "p1");
  assert.equal(cfg.model, "m1");
  assert.equal(cfg.reasoningEffort, "high");
  assert.equal(cfg.timeoutMs, 120000);
  assert.equal(cfg.maxTokens, 4096);
  // 其他阶段不受影响
  assert.equal(stageCfgOf(proj, "P2").prompts[""], STAGE_DEFS.P2.prompts[""]);
});

test("sysOf：rcx.stageCfgOf 覆盖；裸 rcx 回落内置默认", () => {
  const rcx = { stageCfgOf: () => ({ prompts: { "": "覆盖版" }, delegate: { mode: "off" } }) };
  assert.equal(sysOf(rcx, "P1"), "覆盖版");
  assert.equal(sysOf({ stageCfgOf: () => null }, "P1"), STAGE_DEFS.P1.prompts[""]);
  assert.equal(sysOf({}, "P1"), STAGE_DEFS.P1.prompts[""]);
  assert.equal(sysOf({}, "P6", "coder"), STAGE_DEFS.P6.prompts.coder);
});

test("params：专属参数合并——无配置回落默认、覆盖生效、非法值回落、裸 rcx 安全", () => {
  // 无配置 = 默认
  const base = stageCfgOf(null, "P3");
  assert.equal(base.params.deepReadFiles, 6);
  assert.equal(base.params.fileChars, 6000);
  // 覆盖逐键生效，未覆盖键保持默认
  const proj = { stageConfig: { P3: { params: { deepReadFiles: 10 } } } };
  const cfg = stageCfgOf(proj, "P3");
  assert.equal(cfg.params.deepReadFiles, 10);
  assert.equal(cfg.params.fileChars, 6000);
  // 数字型：0/负数/NaN 回落默认；字符串型：空串回落默认
  const bad = stageCfgOf({ stageConfig: { P3: { params: { deepReadFiles: 0, fileChars: -1 } }, P6: { params: { claudeBin: "" } } } }, "P3");
  assert.equal(bad.params.deepReadFiles, 6);
  assert.equal(bad.params.fileChars, 6000);
  const p6 = stageCfgOf({ stageConfig: { P6: { params: { claudeBin: "" } } } }, "P6");
  assert.equal(p6.params.claudeBin, "");
  assert.equal(p6.params.claudeTimeoutMin, 120);
  const p6on = stageCfgOf({ stageConfig: { P6: { params: { claudeBin: "D:\\bin\\claude.cmd", claudeTimeoutMin: 30 } } } }, "P6");
  assert.equal(p6on.params.claudeBin, "D:\\bin\\claude.cmd");
  assert.equal(p6on.params.claudeTimeoutMin, 30);
  // 裸 rcx（单测无 stageCfgOf）：paramsOf 回落 STAGE_DEFS 默认
  assert.equal(paramsOf({}, "P2").repoScanMax, 400);
  assert.equal(paramsOf({}, "P9").diffChars, 1200);
  // stageCfgOf 注入时 paramsOf 透传合并结果
  const rcx = { stageCfgOf: () => ({ params: { repoScanMax: 99 } }) };
  assert.equal(paramsOf(rcx, "P2").repoScanMax, 99);
});

test("routeOverridesOf：透传合并后的路由与执行覆盖", () => {
  const rcx = { stageCfgOf: () => ({ provider: "prov", model: "mdl", reasoningEffort: "low", timeoutMs: 60000, maxTokens: 2048, prompts: {}, delegate: {} }) };
  assert.deepEqual(routeOverridesOf(rcx), { provider: "prov", model: "mdl", reasoningEffort: "low", timeoutMs: 60000, maxTokens: 2048 });
});

test("validateStageConfig：合法配置通过；未知阶段/字段类型错误被拒", () => {
  assert.equal(validateStageConfig(undefined)[0], true);
  assert.equal(validateStageConfig({ P1: { prompts: { "": "x" }, timeoutMs: 1, delegate: { mode: "session", agent: "a", brief: "b" } } })[0], true);
  assert.equal(validateStageConfig({ P99: {} })[0], false);
  assert.equal(validateStageConfig({ P1: { timeoutMs: -1 } })[0], false);
  assert.equal(validateStageConfig({ P1: { prompts: { "": 1 } } })[0], false);
  assert.equal(validateStageConfig({ P1: { delegate: { mode: "claude" } } })[0], false);
  // params：合法（数字/字符串）通过；未知键、类型不符、非正数被拒
  assert.equal(validateStageConfig({ P3: { params: { deepReadFiles: 12 } } })[0], true);
  assert.equal(validateStageConfig({ P6: { params: { claudeBin: "C:\\claude.cmd" } } })[0], true);
  assert.equal(validateStageConfig({ P2: { params: { noSuchParam: 1 } } })[0], false);
  assert.equal(validateStageConfig({ P3: { params: { deepReadFiles: "8" } } })[0], false);
  assert.equal(validateStageConfig({ P6: { params: { claudeBin: 7 } } })[0], false);
  assert.equal(validateStageConfig({ P3: { params: { deepReadFiles: 0 } } })[0], false);
});

test("stageDelegated：P6 读 rcx 或 run 上的 p6Mode；其余阶段读 stageCfgOf；裸 rcx 安全回落", () => {
  assert.equal(stageDelegated({ p6Mode: "session" }, "P6"), true);
  assert.equal(stageDelegated({ run: { p6Mode: "claude" } }, "P6"), true);
  assert.equal(stageDelegated({ run: { p6Mode: "builtin" } }, "P6"), false);
  const delegated = { stageCfgOf: () => ({ delegate: { mode: "session" }, prompts: {} }) };
  assert.equal(stageDelegated(delegated, "P9"), true);
  assert.equal(stageDelegated({}, "P9"), false); // 无 stageCfgOf 不抛错
  assert.equal(stageDelegated({}, "P7"), false); // P7 无委托能力
});

test("delegateReady：非 P6 看产物文件；P6 看 patches/coder-report 口径", () => {
  const runDir = mkdtempSync(join(root, "ready-"));
  assert.equal(delegateReady(runDir, "P1"), false);
  writeFileSync(join(runDir, "01-issue-analysis.json"), "{}");
  assert.equal(delegateReady(runDir, "P1"), true);
  const runDir2 = mkdtempSync(join(root, "ready6-"));
  assert.equal(delegateReady(runDir2, "P6"), false);
  mkdirSync(join(runDir2, "06-implementation", "patches"), { recursive: true });
  writeFileSync(join(runDir2, "06-implementation", "patches", "0001-T1.diff"), "--- a/x\n+++ b/x\n");
  assert.equal(delegateReady(runDir2, "P6"), true);
});

test("maybeDelegate：off 返回 null 走本机；session 生成任务包并 external", async () => {
  const trig = join(root, "issue.md");
  writeFileSync(trig, "# 标题\n\n正文需求");
  const runDir = mkdtempSync(join(root, "dlg-"));
  const baseRcx = { runDir, run: { current: "P1" }, trigger: { kind: "issue", uri: trig }, repoDir: "/tmp/x" };
  const off = Object.assign({}, baseRcx, { stageCfgOf: () => ({ prompts: {}, delegate: { mode: "off", agent: "", brief: "" } }) });
  assert.equal(await maybeDelegate(off, "P1"), null);

  const on = Object.assign({}, baseRcx, {
    stageCfgOf: () => ({ prompts: {}, delegate: { mode: "session", agent: "claude-code", brief: "注意产出 JSON" } }),
  });
  const r = await maybeDelegate(on, "P1");
  assert.equal(r.external, true);
  const rel = join(runDir, "delegate", "P1-task.md");
  assert.ok(existsSync(rel));
  const text = readFileSync(rel, "utf8");
  assert.match(text, /P1 IssueAnalyzer · 外部智能体任务包/);
  assert.match(text, /01-issue-analysis\.json/);           // 输出产物
  assert.match(text, /# 标题[\s\S]*正文需求/);              // 触发原文
  assert.match(text, /claude-code/);                        // 指定智能体
  assert.match(text, /注意产出 JSON/);                      // 附加要求
});

test("buildDelegateTask：打回意见注入任务包（重跑带意见场景）", async () => {
  const trig = join(root, "issue2.md");
  writeFileSync(trig, "需求");
  const runDir = mkdtempSync(join(root, "dlg2-"));
  const rcx = {
    runDir, trigger: { kind: "issue", uri: trig }, repoDir: "/tmp/y",
    reviewComment: "上次范围太大",
    stageCfgOf: () => ({ prompts: {}, delegate: { mode: "session", agent: "", brief: "" } }),
  };
  const text = await buildDelegateTask(rcx, "P1");
  assert.match(text, /上次范围太大/);
});
