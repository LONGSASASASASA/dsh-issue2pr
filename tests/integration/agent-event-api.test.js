import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { apply, __setTestHooks } from "../../index.js";
import { saveProject, runDirOf, writeArtifact } from "../../lib/core/store.js";

test("Agent 原始 JSON HTTP API：完整字段、历史读取、不可用及路径/查询验证", async t => {
    const root = mkdtempSync(join(tmpdir(), "i2p-agent-http-"));
    t.after(() => { __setTestHooks(null); rmSync(root, { recursive: true, force: true }); });
    __setTestHooks({ dataRoot: root });
    const routes = [];
    apply({ effect(fn) { fn(); }, logger: { info() {} }, webServer: { register(spec) { routes.push(spec); } } });
    saveProject(root, { slug: "raw-demo", name: "Raw", repos: ["https://example.test/raw.git"], triggers: [], reviewMode: "every", p6Mode: "builtin" });
    const run = "20260914-120000-raw", runDir = runDirOf(root, "raw-demo", run), captureId = "11111111-1111-4111-8111-111111111111";
    const message = { type: "assistant", session_id: "session-1", uuid: "original-uuid", message: { role: "assistant", content: [{ type: "text", text: "完整正文" }], usage: { output_tokens: 8 } }, retained: { arbitrary: true } };
    const bytes = Buffer.from(JSON.stringify(message)), id = captureId + ":1:0";
    writeArtifact(runDir, "run.json", JSON.stringify({ id: run, status: "completed" }));
    writeArtifact(runDir, "06-implementation/external-exec.messages.jsonl", Buffer.concat([bytes, Buffer.from("\n")]));
    writeArtifact(runDir, "06-implementation/external-exec.events.jsonl", JSON.stringify({ id, captureId, executor: "claude-code", origin: "agent", kind: "text", text: "完整正文", blockIndex: 0,
        source: { offset: 0, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") } }) + "\n");
    const legacyLine = "12:00:00|text|完整正文";
    writeArtifact(runDir, "06-implementation/external-exec.timeline.log", legacyLine + "\n");
    writeArtifact(runDir, "06-implementation/external-exec.log", "=== claude-code 2026-09-14T04:00:00Z ===\n--- stdout ---\n" + bytes.toString() + "\n--- stderr ---\n--- exit=0 ---\n");
    const server = createServer((req, res) => routes[0].handler(req, res));
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    t.after(async () => { await new Promise(resolve => server.close(resolve)); });
    const base = `http://127.0.0.1:${server.address().port}/issue2pr/api/projects/raw-demo/runs/${run}/agent-event`;
    const get = async suffix => { const res = await fetch(base + suffix); return { status: res.status, cache: res.headers.get("cache-control"), body: await res.json() }; };

    let result = await get("?id=" + encodeURIComponent(id));
    assert.equal(result.status, 200); assert.equal(result.cache, "no-store"); assert.deepEqual(result.body.message, message);
    result = await get("?legacyLine=" + encodeURIComponent(legacyLine));
    assert.equal(result.status, 200); assert.equal(result.body.legacy, true); assert.deepEqual(result.body.message, message);
    result = await get("?id=" + encodeURIComponent(captureId + ":99:0"));
    assert.equal(result.status, 200); assert.equal(result.body.status, "unavailable"); assert.equal(result.body.message, undefined);
    for (const query of ["", "?id=../../outside", "?id=" + id + "&offset=0", "?id=" + id + "&path=../secret", "?id=" + id + "&id=" + id,
        "?id=" + id + "&legacyLine=" + encodeURIComponent(legacyLine), "?legacyLine=" + encodeURIComponent(legacyLine + "\nextra")]) {
        result = await get(query); assert.equal(result.status, 400, query); assert.equal(result.body.ok, false);
    }
    const missing = await fetch(base.replace(run, "20260914-120000-missing") + "?id=" + encodeURIComponent(id));
    assert.equal(missing.status, 404);
    const invalid = await fetch(base.replace("raw-demo/runs/" + run, "raw-demo/runs/%2e%2e%2foutside") + "?id=" + encodeURIComponent(id));
    assert.equal(invalid.status, 400);
});
