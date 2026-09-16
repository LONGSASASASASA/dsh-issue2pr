import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { apply, __setTestHooks } from "../../index.js";
import { saveProject, runDirOf } from "../../lib/core/store.js";
import { saveRun } from "../../lib/core/pipeline.js";
import p8 from "../../lib/stages/p8-test-runner.js";

test("P8 HTTP 实时链路：命令未结束即读取 stdout/stderr 和活动，停止流水线不伪报命令退出", { timeout: 20_000 }, async t => {
    const root = mkdtempSync(join(tmpdir(), "i2p-p8-http-")), release = join(root, "release");
    let server, execution;
    t.after(async () => {
        writeFileSync(release, "release");
        try { await execution; }
        finally {
            if (server?.listening) await new Promise(resolve => server.close(resolve));
            __setTestHooks(null); rmSync(root, { recursive: true, force: true });
        }
    });
    __setTestHooks({ dataRoot: root });
    const routes = [];
    apply({ effect(fn) { fn(); }, logger: { info() {} }, webServer: { register(spec) { routes.push(spec); } } });
    saveProject(root, { slug: "p8-demo", name: "P8", repos: ["https://example.test/p8.git"], triggers: [], reviewMode: "every", p6Mode: "builtin" });
    const id = "20260914-190000-p8", runDir = runDirOf(root, "p8-demo", id), startedAt = new Date().toISOString();
    const run = { id, status: "running", current: "P8", stages: { P8: { status: "running", startedAt } } };
    saveRun(runDir, run);
    const original = readFileSync(join(runDir, "run.json"), "utf8");
    writeFileSync(join(root, "slow.cjs"), `const fs = require('node:fs');
process.stdout.write('stdout: 中文开始\\n');
process.stderr.write('stderr: 测试诊断\\n');
const end = Date.now() + 12000;
const timer = setInterval(() => {
  if (!fs.existsSync('release') && Date.now() < end) return;
  clearInterval(timer); process.stdout.write('stdout: 结束\\n');
}, 50);`);
    server = createServer((req, res) => routes[0].handler(req, res));
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${server.address().port}/issue2pr/api/projects/p8-demo/runs/${id}`;
    const get = async suffix => {
        const response = await fetch(base + (suffix || ""));
        assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "no-store");
        return response.json();
    };
    let finished = false;
    execution = p8({ runDir, repoDir: root, run, project: { testCommand: "node slow.cjs" } }).then(() => null, error => error).finally(() => { finished = true; });
    let detail, output;
    const deadline = Date.now() + 7000;
    do {
        detail = await get();
        if (detail.testActivity?.outputBytes > 0) {
            output = await get("/artifact?path=08-test-output.txt");
            if (output.text.includes("stderr: 测试诊断")) break;
        }
        await delay(50);
    } while (Date.now() < deadline);
    assert.equal(finished, false, "不等命令结束才能看到内容");
    assert.equal(detail.testActivity.status, "available");
    assert.equal(detail.testActivity.executionStatus, "running");
    assert.equal(detail.testActivity.command, "node slow.cjs");
    assert.equal(detail.testActivity.process.state, "alive"); assert.ok(Date.parse(detail.testActivity.lastOutputAt));
    assert.match(output.text, /stdout: 中文开始/); assert.match(output.text, /stderr: 测试诊断/);
    const tree = await get("/tree"); assert.ok(tree.files.some(file => file.path === "08-test-output.txt" && file.size > 0));
    assert.equal(readFileSync(join(runDir, "run.json"), "utf8"), original, "流式输出不反复写 run.json");
    const stop = await fetch(base + "/stop", { method: "POST" }); assert.equal(stop.status, 200);
    assert.match((await execution).message, /测试取消/);
    detail = await get(); assert.equal(detail.status, "stopped");
    assert.equal(detail.testActivity.executionStatus, "cancelled");
    assert.notEqual(detail.testActivity.process.state, "alive");
    output = await get("/artifact?path=08-test-output.txt"); assert.equal(output.text.match(/stdout: 中文开始/g).length, 1);
    assert.doesNotMatch(output.text, /stdout: 结束/, "停止会终止命令，不继续执行后续步骤");
    const report = await get("/artifact?path=07-test-report.json"); assert.equal(JSON.parse(report.text).passed, false);
    const next = { ...run, stages: { P8: { status: "running", startedAt: new Date(Date.now() + 1).toISOString() } } };
    saveRun(runDir, next);
    detail = await get(); assert.equal(detail.testActivity.status, "unavailable"); assert.equal(detail.testActivity.reasonCode, "stale");
    assert.equal(detail.testActivity.command, undefined, "旧命令不挂到新阶段");
});
