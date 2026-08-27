// tests/stages-p1-p2.test.js — Task 5：stages 框架 + P1 IssueAnalyzer + P2 Search
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import p1 from "../lib/stages/p1-issue-analyzer.js";
import p2 from "../lib/stages/p2-search.js";
import { readTriggerText, listRepoFiles, readRepoFile } from "../lib/stages/helpers.js";

const root = mkdtempSync(join(tmpdir(), "i2p-stg-"));
const repoDir = join(root, "repo");
mkdirSync(join(repoDir, "src", "auth"), { recursive: true });
writeFileSync(join(repoDir, "src", "auth", "session.ts"), "export function restoreSession(){}");
writeFileSync(join(repoDir, "package.json"), "{}");
const issueFile = join(root, "issue.md");
writeFileSync(issueFile, "登录后刷新页面偶发退出");

function fakeLlm(outputs) {
  let i = 0;
  const pick = () => outputs[Math.min(i++, outputs.length - 1)];
  return {
    complete: async () => pick(),
    completeJson: async ({ required }) => {
      const out = JSON.parse(pick());
      for (const k of required) if (!(k in out)) throw new Error("契约解析失败: 缺字段 " + k);
      return out;
    },
  };
}

test("helpers：readTriggerText 读本地文件；listRepoFiles 排除 .git", async () => {
  assert.match(await readTriggerText({ trigger: { uri: issueFile } }), /偶发退出/);
  const files = listRepoFiles(repoDir);
  assert.ok(files.includes("src/auth/session.ts"));
  assert.ok(!files.some((f) => f.includes(".git")));
});

test("helpers：readRepoFile 拒绝 .. 逃逸与绝对路径，正常相对路径照读", () => {
  assert.equal(readRepoFile(repoDir, "../outside.txt"), "(非法路径)");
  assert.equal(readRepoFile(repoDir, "..\\..\\etc\\passwd"), "(非法路径)");
  assert.equal(readRepoFile(repoDir, "src/../secret.ts"), "(非法路径)");
  assert.equal(readRepoFile(repoDir, "C:\\Windows\\win.ini"), "(非法路径)");
  assert.equal(readRepoFile(repoDir, "/etc/hosts"), "(非法路径)");
  assert.match(readRepoFile(repoDir, "src/auth/session.ts"), /restoreSession/);
});

test("P1：产出 01-issue-analysis.json 且契约键齐全", async () => {
  const runDir = mkdtempSync(join(root, "run-"));
  const llm = fakeLlm(['{"phenomenon":"刷新后偶发退出","trigger":"登录后刷新","scope":["Auth","Session"],"success_criteria":["刷新后不再退出"],"constraints":["不破坏登录主流程"],"risk_level":"medium"}']);
  const rcx = { runDir, repoDir, trigger: { kind: "issue", uri: issueFile }, llm, reviewComment: "" };
  const r = await p1(rcx);
  assert.equal(r.artifact, "01-issue-analysis.json");
  const saved = JSON.parse(readFileSync(join(runDir, "01-issue-analysis.json"), "utf8"));
  assert.equal(saved.risk_level, "medium");
});

test("P2：基于 P1 契约产出候选文件清单", async () => {
  const runDir = mkdtempSync(join(root, "run-"));
  writeFileSync(join(runDir, "01-issue-analysis.json"), JSON.stringify({ scope: ["Auth"] }));
  const llm = fakeLlm(['{"candidates":[{"path":"src/auth/session.ts","role":"Session 核心","evidence":"scope 命中 Auth","confidence":"high"}],"test_candidates":[],"uncertain":["router 守卫"]}']);
  const rcx = { runDir, repoDir, llm, reviewComment: "" };
  const r = await p2(rcx);
  assert.equal(r.artifact, "02-search-candidates.json");
  const saved = JSON.parse(readFileSync(join(runDir, r.artifact), "utf8"));
  assert.equal(saved.candidates[0].path, "src/auth/session.ts");
});