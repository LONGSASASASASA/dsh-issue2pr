import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, statSync, appendFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { readAgentEvent, AGENT_MESSAGE_LIMIT } from "../../lib/delegate/agentEventReader.js";
import { frameToEntries, dshEventToEntries } from "../../lib/delegate/executors/agent-timeline.js";
import { createAgentRecordWriter } from "../../lib/delegate/executors/agent-records.js";

const CAPTURE = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const MESSAGE_FILE = "external-exec.messages.jsonl", INDEX_FILE = "external-exec.events.jsonl";

function fixture(t) {
    const runDir = mkdtempSync(join(tmpdir(), "i2p-agent-event-")), dir = join(runDir, "06-implementation");
    mkdirSync(dir);
    t.after(() => rmSync(runDir, { recursive: true, force: true }));
    const events = [];
    let offset = 0, seq = 0;
    function add(message, { captureId = CAPTURE, executor = "claude-code" } = {}) {
        const buffer = Buffer.from(JSON.stringify(message));
        const source = { offset, bytes: buffer.length, sha256: createHash("sha256").update(buffer).digest("hex") };
        appendFileSync(join(dir, MESSAGE_FILE), buffer); appendFileSync(join(dir, MESSAGE_FILE), "\n");
        offset += buffer.length + 1; seq++;
        const entries = executor === "dsh-agent" ? dshEventToEntries(message) : frameToEntries(message, { includeToolResults: true });
        const added = entries.map((entry, index) => ({ id: `${captureId}:${seq}:${entry.blockIndex ?? index}`, captureId,
            executor, origin: "agent", at: "2026-09-14 12:00:00", ...entry, source }));
        events.push(...added);
        save();
        return added;
    }
    function save() { writeFileSync(join(dir, INDEX_FILE), events.map(event => JSON.stringify(event)).join("\n") + "\n"); }
    function legacy(messages, line = "12:00:00|text|你好", extra = "") {
        writeFileSync(join(dir, "external-exec.timeline.log"), line + "\n");
        writeFileSync(join(dir, "external-exec.log"), "=== claude-code 2026-09-14T04:00:00Z ===\nbin=claude\n--- stdout ---\n"
            + messages.map(message => typeof message === "string" ? message : JSON.stringify(message)).join("\n")
            + "\n--- stderr ---\n" + extra + "\n--- exit=0 ---\n");
        return line;
    }
    return { runDir, dir, events, add, save, legacy };
}

const assistant = text => ({ type: "assistant", session_id: "real-session", uuid: "real-message", message: {
    id: "message-id", role: "assistant", content: [{ type: "text", text }], usage: { input_tokens: 25, output_tokens: 13 },
}, extra_field: { untouched: [1, true, null] } });

test("原始消息：真实采集器跨 chunk 留档后可直接读取，平台事件不冒充 Agent JSON", async t => {
    const f = fixture(t), message = assistant("完整正文😀"), writer = createAgentRecordWriter({
        messagesPath: join(f.dir, MESSAGE_FILE), eventsPath: join(f.dir, INDEX_FILE), executor: "claude-code", captureId: CAPTURE,
    });
    writer.appendPlatform("init", "启动外部进程");
    const buffer = Buffer.from(JSON.stringify(message) + "\n"), split = buffer.indexOf(Buffer.from("😀")) + 1;
    writer.push(buffer.subarray(0, split)); writer.push(buffer.subarray(split)); writer.flush();
    const events = readFileSync(join(f.dir, INDEX_FILE), "utf8").trim().split("\n").map(line => JSON.parse(line));
    assert.equal((await readAgentEvent(f.runDir, { id: events[0].id })).status, "unavailable");
    const actual = await readAgentEvent(f.runDir, { id: events[1].id });
    assert.equal(actual.status, "available"); assert.deepEqual(actual.message, message);
});

test("TASK-10 分片读取：轮转后的索引/消息分片跨片定位与关联，sourcePath 指向实际分片", async t => {
    const f = fixture(t), writer = createAgentRecordWriter({
        messagesPath: join(f.dir, MESSAGE_FILE), eventsPath: join(f.dir, INDEX_FILE), executor: "claude-code", captureId: CAPTURE, rotateBytes: 200,
    });
    const call = assistant("调用工具"); call.message.content = [{ type: "tool_use", id: "tool-x", name: "Read", input: { file_path: "a.js" } }];
    const resultFrame = { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tool-x", content: "跨分片结果" }] } };
    const tail = assistant("第三条普通消息");
    writer.appendFrame(call); writer.appendFrame(resultFrame); writer.appendFrame(tail);
    const msgShards = readdirSync(f.dir).filter(n => /^external-exec\.messages(?:\.\d{6})?\.jsonl$/.test(n));
    const evShards = readdirSync(f.dir).filter(n => /^external-exec\.events(?:\.\d{6})?\.jsonl$/.test(n));
    assert.ok(msgShards.length >= 2, "messages 已轮转"); assert.ok(evShards.length >= 2, "events 已轮转");
    assert.equal(evShards.includes("external-exec.events.jsonl"), true, "首片沿用既有文件名");
    const all = evShards.flatMap(name => readFileSync(join(f.dir, name), "utf8").trim().split("\n").filter(Boolean).map(JSON.parse));
    const callEvent = all.find(e => e.toolUseId === "tool-x" && e.relation === "call");
    const resultEvent = all.find(e => e.toolUseId === "tool-x" && e.relation === "result");
    assert.notEqual(callEvent.source.file, resultEvent.source.file, "调用与结果落在不同分片（跨片场景）");
    const actual = await readAgentEvent(f.runDir, { id: callEvent.id });
    assert.equal(actual.status, "available"); assert.deepEqual(actual.message, call);
    assert.equal(actual.sourcePath, "06-implementation/" + callEvent.source.file, "sourcePath 指向实际分片");
    assert.deepEqual(actual.related.map(r => r.message), [resultFrame], "跨分片关联工具结果");
    const reverse = await readAgentEvent(f.runDir, { id: resultEvent.id });
    assert.equal(reverse.status, "available");
    assert.equal(reverse.sourcePath, "06-implementation/" + resultEvent.source.file);
    assert.deepEqual(reverse.related.map(r => r.message), [call], "反向跨片关联也成立");
    const plain = all.find(e => e.text === "第三条普通消息");
    const third = await readAgentEvent(f.runDir, { id: plain.id });
    assert.equal(third.status, "available"); assert.deepEqual(third.message, tail);
});

test("TASK-10 分片清单：损坏或登记分片缺失时明确不可用，清单缺失按文件名枚举兜底", async t => {
    const f = fixture(t), writer = createAgentRecordWriter({
        messagesPath: join(f.dir, MESSAGE_FILE), eventsPath: join(f.dir, INDEX_FILE), executor: "claude-code", captureId: CAPTURE, rotateBytes: 200,
    });
    writer.appendFrame(assistant("第一条消息"));
    writer.appendFrame(assistant("第二条消息"));
    const evShards = readdirSync(f.dir).filter(n => /^external-exec\.events(?:\.\d{6})?\.jsonl$/.test(n));
    assert.ok(evShards.length >= 2, "已轮转出多个分片");
    const firstEvent = readFileSync(join(f.dir, "external-exec.events.jsonl"), "utf8").trim().split("\n").map(JSON.parse)[0];
    const manifestPath = join(f.dir, "external-exec.events.manifest.json");
    const validManifest = readFileSync(manifestPath, "utf8");
    // 1) 清单损坏 → 明确报错，不静默降级
    writeFileSync(manifestPath, "{broken json");
    const broken = await readAgentEvent(f.runDir, { id: firstEvent.id });
    assert.equal(broken.status, "unavailable"); assert.match(broken.reason, /分片清单.*JSON/);
    // 2) 清单登记的分片在盘上缺失 → 留档不完整，明确报错
    writeFileSync(manifestPath, validManifest);
    const listed = JSON.parse(validManifest).files.map(x => x.file);
    const later = listed.find(n => n !== "external-exec.events.jsonl");
    rmSync(join(f.dir, later));
    const missing = await readAgentEvent(f.runDir, { id: firstEvent.id });
    assert.equal(missing.status, "unavailable"); assert.match(missing.reason, /分片缺失/);
    // 3) 清单缺失（写失败/被清理）→ 按文件名顺序枚举兜底，读取仍可用
    rmSync(manifestPath);
    const fallback = await readAgentEvent(f.runDir, { id: firstEvent.id });
    assert.equal(fallback.status, "available"); assert.deepEqual(fallback.message.message.content[0].text, "第一条消息");
});

test("原始消息：多 block 事件定位同一个完整 JSON，所有字段与 Unicode 内容保真", async t => {
    const f = fixture(t), message = assistant("你好😀".repeat(250));
    message.message.content.push({ type: "tool_use", id: "tool-1", name: "Read", input: { file_path: "C:\\源文件.js", extra: "完整参数".repeat(150) } });
    const events = f.add(message);
    assert.equal(events.length, 2);
    for (const event of events) {
        const result = await readAgentEvent(f.runDir, { id: event.id });
        assert.equal(result.status, "available");
        assert.deepEqual(result.message, message);
        assert.deepEqual(result.event, event);
        assert.equal(result.sourcePath, "06-implementation/" + MESSAGE_FILE);
        assert.equal(result.message.captureId, undefined);
    }
});

test("原始消息：关联真实工具调用和多个结果，不跨 captureId 或关联无 ID 的消息", async t => {
    const f = fixture(t), call = assistant("执行 Read");
    call.message.content = [{ type: "tool_use", id: "tool-1", name: "Read", input: { file_path: "file.js" } }];
    const event = f.add(call)[0];
    const result = text => ({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tool-1", content: text }] } });
    const a = result("first complete result"), b = result("second complete result");
    f.add(a); const bEvent = f.add(b)[0]; f.add(result("other capture result"), { captureId: OTHER });
    f.add({ type: "user", message: { content: [{ type: "tool_result", content: "unknown tool" }] } });
    const actual = await readAgentEvent(f.runDir, { id: event.id });
    assert.equal(actual.status, "available"); assert.deepEqual(actual.related.map(item => item.message), [a, b]);
    const reverse = await readAgentEvent(f.runDir, { id: bEvent.id });
    assert.deepEqual(reverse.related.map(item => item.message), [call]);
    f.events.push(bEvent); f.save();
    const duplicate = await readAgentEvent(f.runDir, { id: event.id });
    assert.deepEqual(duplicate.related.map(item => item.message), [a]); assert.match(duplicate.relatedReason, /ID 重复/);
    appendFileSync(join(f.dir, INDEX_FILE), "{\"id\":");
    const corrupt = await readAgentEvent(f.runDir, { id: event.id });
    assert.equal(corrupt.status, "available"); assert.deepEqual(corrupt.related, []); assert.match(corrupt.relatedReason, /索引已损坏/);
});

test("原始消息：相同执行内工具 ID 重复时不猜测关联", async t => {
    const f = fixture(t), call = assistant("");
    call.message.content = [{ type: "tool_use", id: "repeat", name: "Read", input: { file_path: "a" } }];
    const event = f.add(call)[0]; f.add(call);
    f.add({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "repeat", content: "ambiguous" }] } });
    const actual = await readAgentEvent(f.runDir, { id: event.id });
    assert.equal(actual.status, "available"); assert.deepEqual(actual.related, []); assert.match(actual.relatedReason, /无法唯一关联/);
});

test("原始消息：DSH 返回原生事件整对象并按实际工具标识关联", async t => {
    const f = fixture(t);
    const call = { seq: 5, type: "tool/call", time: 1757812800000, data: { callId: "native-tool", name: "Read", arguments: '{"path":"a.js"}', host_extra: true } };
    const result = { seq: 6, type: "tool/result", time: 1757812800100, data: { message: { role: "tool", source: { kind: "tool", callId: "native-tool" },
        content: [{ type: "tool-result", toolCallId: "native-tool", isError: false, content: [{ type: "text", text: "whole source", extra: [1, 2] }] }] } } };
    const assistantEvent = { seq: 4, type: "assistant/message", time: 1757812800000, data: { message: { role: "assistant", usage: { totalTokens: 55 }, content: [
        { type: "reasoning", text: "完整思考内容" }, { type: "tool-call", toolCallId: "native-tool", toolName: "Read", arguments: '{"path":"a.js"}' },
    ] } } };
    const assistantEntries = f.add(assistantEvent, { executor: "dsh-agent" });
    const event = f.add(call, { executor: "dsh-agent" })[0]; f.add(result, { executor: "dsh-agent" });
    const actual = await readAgentEvent(f.runDir, { id: event.id });
    assert.equal(actual.status, "available"); assert.deepEqual(actual.message, call); assert.deepEqual(actual.related[0].message, result);
    for (const entry of assistantEntries) {
        const original = await readAgentEvent(f.runDir, { id: entry.id });
        assert.equal(original.status, "available"); assert.deepEqual(original.message, assistantEvent);
    }
});

test("原始消息：新执行偏移直接读取末尾单条，不因整个消息文件超过 5MB 而失败", async t => {
    const f = fixture(t); f.add(assistant("x".repeat(AGENT_MESSAGE_LIMIT + 100)));
    const message = assistant("最后一条完整记录"), event = f.add(message)[0];
    assert.ok(event.source.offset > AGENT_MESSAGE_LIMIT);
    const actual = await readAgentEvent(f.runDir, { id: event.id });
    assert.equal(actual.status, "available"); assert.deepEqual(actual.message, message);
    const tooLarge = await readAgentEvent(f.runDir, { id: f.events[0].id });
    assert.equal(tooLarge.status, "unavailable"); assert.match(tooLarge.reason, /5MB/); assert.equal(tooLarge.message, undefined);
});

test("原始消息：校验字节边界、摘要投影、captureId、内容摘要和截断，来源错误不冒充完整 JSON", async t => {
    for (const mutate of [
        f => { f.events[0].source.sha256 = "0".repeat(64); f.save(); },
        f => { f.events[0].source.offset = 1; f.save(); },
        f => { f.events[0].source.bytes -= 1; f.save(); },
        f => { f.events[0].text = "被改写的摘要"; f.save(); },
        f => { f.events[0].captureId = OTHER; f.save(); },
        f => { writeFileSync(join(f.dir, MESSAGE_FILE), JSON.stringify(assistant("hello"))); },
        f => { writeFileSync(join(f.dir, MESSAGE_FILE), JSON.stringify(assistant("world")) + "\n"); },
        f => { f.events[0].source.offset = Number.MAX_SAFE_INTEGER; f.save(); },
        f => { const bad = Buffer.from("{invalid}"); f.events[0].source.bytes = bad.length; f.events[0].source.sha256 = createHash("sha256").update(bad).digest("hex");
            writeFileSync(join(f.dir, MESSAGE_FILE), Buffer.concat([bad, Buffer.from("\n")])); f.save(); },
    ]) {
        const f = fixture(t), event = f.add(assistant("hello"))[0]; mutate(f);
        const actual = await readAgentEvent(f.runDir, { id: event.id });
        assert.equal(actual.status, "unavailable"); assert.equal(actual.message, undefined); assert.ok(actual.reason);
    }
});

test("原始消息：平台事件、索引缺失/损坏/重复及未知执行器明确不可用", async t => {
    const f = fixture(t), event = f.add(assistant("hello"))[0];
    f.events.push({ id: `${CAPTURE}:2:0`, captureId: CAPTURE, executor: "claude-code", origin: "platform", kind: "exit", text: "退出", source: null }); f.save();
    assert.match((await readAgentEvent(f.runDir, { id: `${CAPTURE}:2:0` })).reason, /平台执行事件/);
    assert.equal((await readAgentEvent(f.runDir, { id: `${CAPTURE}:99:0` })).status, "unavailable");
    f.events.push(event); f.save(); assert.equal((await readAgentEvent(f.runDir, { id: event.id })).status, "ambiguous");
    f.events.pop(); f.events[0].executor = "unknown"; f.save(); assert.equal((await readAgentEvent(f.runDir, { id: event.id })).status, "unavailable");
    f.events[0].executor = "claude-code"; f.save();
    appendFileSync(join(f.dir, INDEX_FILE), "broken JSON\n");
    assert.equal((await readAgentEvent(f.runDir, { id: event.id })).status, "available");
    assert.match((await readAgentEvent(f.runDir, { id: `${CAPTURE}:99:0` })).reason, /索引已损坏/);
});

test("原始消息：拒绝不合法 ID 和混合查询，不将请求值当路径或偏移", async t => {
    const f = fixture(t);
    for (const query of [{}, { id: "../external-exec.log" }, { id: "a\u0000b" }, { id: "x".repeat(1000) }, { id: `${CAPTURE}:1:0`, legacyLine: "12:00:00|text|hello" }, { legacyLine: "12:00:00|text|hello\nother" }]) {
        await assert.rejects(readAgentEvent(f.runDir, query), /非法|只能/);
    }
});

test("原始消息：拒绝固定来源文件软链接到任务外部", async t => {
    const f = fixture(t), external = mkdtempSync(join(tmpdir(), "i2p-agent-outside-"));
    t.after(() => rmSync(external, { recursive: true, force: true }));
    const event = f.add(assistant("inside"))[0], outsideFile = join(external, MESSAGE_FILE);
    writeFileSync(outsideFile, readFileSync(join(f.dir, MESSAGE_FILE)));
    writeFileSync(join(external, INDEX_FILE), readFileSync(join(f.dir, INDEX_FILE)));
    // Windows junction 不需要创建文件软链接所需的管理员权限。
    rmSync(f.dir, { recursive: true, force: true });
    try { symlinkSync(external, f.dir, process.platform === "win32" ? "junction" : "dir"); }
    catch (error) { if (["EPERM", "EACCES"].includes(error.code)) { t.skip("当前 Windows 用户无文件软链接权限"); return; } throw error; }
    const actual = await readAgentEvent(f.runDir, { id: event.id });
    assert.equal(actual.status, "unavailable"); assert.match(actual.reason, /任务目录/);
});

test("历史原始消息：只接受现有镜像原行，以旧投影严格匹配，读取不改写历史文件", async t => {
    const f = fixture(t), message = assistant("你好"), legacyLine = f.legacy([message], "2026-09-14 12:00:00|text|你好", JSON.stringify(assistant("stderr must be ignored")));
    const files = ["external-exec.timeline.log", "external-exec.log"].map(name => join(f.dir, name));
    const before = files.map(path => ({ content: readFileSync(path), mtime: statSync(path).mtimeMs }));
    const actual = await readAgentEvent(f.runDir, { legacyLine });
    assert.equal(actual.status, "available"); assert.equal(actual.legacy, true); assert.deepEqual(actual.message, message);
    assert.deepEqual(files.map(path => ({ content: readFileSync(path), mtime: statSync(path).mtimeMs })), before);
    assert.equal((await readAgentEvent(f.runDir, { legacyLine: legacyLine.replace("12:00:00", "12:00:01") })).status, "unavailable");
});

test("历史原始消息：相同摘要不同完整内容、重复帧均报歧义，不用时间猜测", async t => {
    const f = fixture(t), prefix = "x".repeat(500), line = "12:00:00|text|" + prefix;
    f.legacy([assistant(prefix + "A"), assistant(prefix + "B")], line);
    assert.equal((await readAgentEvent(f.runDir, { legacyLine: line })).status, "ambiguous");
    f.legacy([assistant(prefix), assistant(prefix)], line);
    assert.equal((await readAgentEvent(f.runDir, { legacyLine: line })).status, "ambiguous");
});

test("历史原始消息：没有结束标记和换行时完整末帧仍可读，损坏末帧不能被忽略后误报唯一", async t => {
    const f = fixture(t), message = assistant("你好"), legacyLine = f.legacy([message]);
    const header = "=== claude-code 2026-09-14T04:00:00Z ===\n--- stdout ---\n";
    writeFileSync(join(f.dir, "external-exec.timeline.log"), legacyLine);
    writeFileSync(join(f.dir, "external-exec.log"), header + JSON.stringify(message));
    let actual = await readAgentEvent(f.runDir, { legacyLine });
    assert.equal(actual.status, "available"); assert.deepEqual(actual.message, message);
    writeFileSync(join(f.dir, "external-exec.log"), header + JSON.stringify(message) + "\n{\"type\":\"assistant\",\"message\":");
    actual = await readAgentEvent(f.runDir, { legacyLine });
    assert.equal(actual.status, "unavailable"); assert.match(actual.reason, /截断或损坏/);
    writeFileSync(join(f.dir, "external-exec.log"), header + JSON.stringify(message) + "\n" + JSON.stringify(message));
    assert.equal((await readAgentEvent(f.runDir, { legacyLine })).status, "ambiguous");
});

test("历史原始消息：DSH 旧记录、stderr 伪帧、平台摘要和超限帧不伪造 JSON", async t => {
    const f = fixture(t), message = assistant("你好"), legacyLine = f.legacy([], "12:00:00|text|你好", JSON.stringify(message));
    assert.equal((await readAgentEvent(f.runDir, { legacyLine })).status, "unavailable");
    f.legacy([message]); writeFileSync(join(f.dir, "external-exec.log"), readFileSync(join(f.dir, "external-exec.log"), "utf8").replace("=== claude-code ", "=== dsh-agent "));
    assert.equal((await readAgentEvent(f.runDir, { legacyLine })).status, "unavailable");
    f.legacy([assistant("x".repeat(AGENT_MESSAGE_LIMIT + 1)), message]);
    const actual = await readAgentEvent(f.runDir, { legacyLine });
    assert.equal(actual.status, "unavailable"); assert.match(actual.reason, /5MB/);
});
