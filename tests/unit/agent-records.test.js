import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { agentRecordPaths, createAgentRecordWriter } from "../../lib/delegate/executors/agent-records.js";
import { frameToEntries, dshEventToEntries } from "../../lib/delegate/executors/agent-timeline.js";

const fixture = () => agentRecordPaths(join(mkdtempSync(join(tmpdir(), "i2p-records-")), "external-exec.log"));
const lines = (path) => readFileSync(path, "utf8").trim().split("\n").map(JSON.parse);

test("Agent 原始 JSON 保留未知字段，多 block 摘要同源，工具结果用实际 tool_use_id 关联", () => {
    const paths = fixture(), writer = createAgentRecordWriter({ ...paths, executor: "claude-code" });
    const assistant = { type: "assistant", uuid: "msg-1", session_id: "session", future: { untouched: [1, "中文", null] },
        message: { id: "message-1", usage: { output_tokens: 33 }, content: [
            { type: "thinking", thinking: "思考" },
            { type: "tool_use", id: "call-1", name: "Read", input: { file_path: "完整路径", extra: "x".repeat(1000) } },
            { type: "text", text: "完成" },
        ] } };
    const result = { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "call-1", is_error: false, content: [{ type: "text", text: "完整结果".repeat(200) }] }] }, unknown: true };
    const telemetry = { type: "system", subtype: "status", stats: { all: "kept" } };
    writer.appendFrame(assistant); writer.appendFrame(result); writer.appendFrame(telemetry);
    assert.deepEqual(lines(paths.messagesPath), [assistant, result, telemetry]);
    const events = lines(paths.eventsPath), bytes = readFileSync(paths.messagesPath);
    assert.equal(events.length, 4, "遥测完整留档，但不必占用摘要列表");
    assert.deepEqual(events.slice(0, 3).map((e) => e.blockIndex), [0, 1, 2]);
    assert.deepEqual(events[0].source, events[2].source, "同帧多个块指向同一条完整消息");
    assert.equal(events[1].toolUseId, "call-1"); assert.equal(events[1].relation, "call");
    assert.equal(events[3].toolUseId, "call-1"); assert.equal(events[3].relation, "result");
    assert.equal(new Set(events.map((e) => e.id)).size, events.length);
    for (const event of events) {
        const raw = bytes.subarray(event.source.offset, event.source.offset + event.source.bytes);
        assert.equal(createHash("sha256").update(raw).digest("hex"), event.source.sha256);
        assert.deepEqual(JSON.parse(raw), event.relation === "result" ? result : assistant);
        assert.equal(event.captureId, writer.captureId); assert.equal(event.origin, "agent");
    }
    assert.deepEqual(frameToEntries(result), [], "旧镜像格式不增加工具结果行，历史关联投影稳定");
});

test("流式缓冲跨行、跨 UTF-8 字符边界，尾帧无换行也保真；坏行不伪造 JSON", () => {
    const paths = fixture(), observed = [];
    const writer = createAgentRecordWriter({ ...paths, executor: "claude-code", onLine: (line) => observed.push(line) });
    const first = { type: "assistant", message: { content: [{ type: "text", text: "中文😀多字节" }] }, extra: "yes" };
    const last = { type: "result", result: "最后一帧" };
    const raw = Buffer.from(JSON.stringify(first) + "\r\nnot-json\n" + JSON.stringify(last));
    for (let i = 0; i < raw.length; i++) writer.push(raw.subarray(i, i + 1));
    writer.flush(); writer.flush();
    assert.deepEqual(lines(paths.messagesPath), [first, last]);
    assert.equal(lines(paths.eventsPath).length, 2);
    assert.deepEqual(observed, [JSON.stringify(first), "not-json", JSON.stringify(last)]);
    writer.push(JSON.stringify(last) + "\n");
    assert.equal(lines(paths.messagesPath).length, 2, "执行结束后不接收延迟到达的数据");
});

test("重复执行与相同消息不会共用 event ID，字节引用不受已有文件内容影响", () => {
    const paths = fixture();
    writeFileSync(paths.messagesPath, "interrupted previous JSON");
    const one = createAgentRecordWriter({ ...paths, executor: "claude-code" });
    const two = createAgentRecordWriter({ ...paths, executor: "claude-code" });
    const frame = { type: "result", result: "相同内容" };
    one.appendPlatform("init", "平台启动"); one.appendFrame(frame); one.appendFrame(frame); two.appendFrame(frame);
    const events = lines(paths.eventsPath), bytes = readFileSync(paths.messagesPath);
    assert.equal(events[0].source, null); assert.equal(events[0].origin, "platform");
    assert.equal(new Set(events.map((e) => e.id)).size, 4);
    assert.notEqual(one.captureId, two.captureId);
    assert.equal(new Set(events.slice(1).map((e) => e.source.offset)).size, 3);
    for (const { source } of events.slice(1)) {
        assert.deepEqual(JSON.parse(bytes.subarray(source.offset, source.offset + source.bytes)), frame);
        assert.equal(bytes[source.offset - 1], 10, "截断旧行与新消息隔开");
    }
});

test("原始消息写失败不抛出，也不创建指向未落盘消息的摘要", () => {
    const paths = fixture(); mkdirSync(paths.messagesPath);
    const writer = createAgentRecordWriter({ ...paths, executor: "claude-code" });
    assert.equal(writer.appendFrame({ type: "result", result: "结果" }), false);
    assert.equal(existsSync(paths.eventsPath), false);
    assert.doesNotThrow(() => writer.push('{"type":"result","result":"结果"}\n'));
    writer.appendPlatform("notice", "留存失败");
    assert.equal(lines(paths.eventsPath)[0].source, null);
});

test("索引中断末行保留证据并隔开，新执行的完整事件仍可单独解析", () => {
    const paths = fixture();
    const interrupted = '{"id":"interrupted';
    writeFileSync(paths.eventsPath, interrupted);
    const writer = createAgentRecordWriter({ ...paths, executor: "claude-code" });
    writer.appendFrame({ type: "result", result: "新的完整结果" });
    const stored = readFileSync(paths.eventsPath, "utf8").trim().split("\n");
    assert.equal(stored[0], interrupted, "保留故障证据，不截删旧索引");
    const complete = JSON.parse(stored[1]);
    assert.equal(complete.captureId, writer.captureId);
    assert.equal(complete.text, "新的完整结果");
});

test("TASK-10 分片轮转：超阈值滚动新分片，source.file 指向实际分片，清单登记全部分片", () => {
    const paths = fixture();
    const writer = createAgentRecordWriter({ ...paths, executor: "claude-code", rotateBytes: 120 });
    const frameOf = (n) => ({ type: "result", result: "消息" + n + "-" + "x".repeat(90) });
    writer.appendFrame(frameOf(1)); // 首片沿用既有文件名
    writer.appendFrame(frameOf(2)); // 超阈值 → 000002
    writer.appendFrame(frameOf(3)); // 再超 → 000003
    const dir = dirname(paths.messagesPath);
    for (const name of ["external-exec.messages.jsonl", "external-exec.messages.000002.jsonl", "external-exec.messages.000003.jsonl"]) {
        assert.ok(existsSync(join(dir, name)), "messages 分片存在: " + name);
    }
    // events 索引同样轮转；逐分片读回全部事件，核对 source.file/offset/bytes 指向实际分片
    const evNames = readdirSync(dir).filter((n) => /^external-exec\.events(?:\.\d{6})?\.jsonl$/.test(n))
        .sort((a, b) => (Number(/\.(\d{6})\.jsonl$/.exec(a)?.[1] || 1) - Number(/\.(\d{6})\.jsonl$/.exec(b)?.[1] || 1)));
    assert.equal(evNames[0], "external-exec.events.jsonl", "首片沿用既有文件名（旧读取端兼容）");
    assert.ok(evNames.length >= 2, "索引已轮转出多个分片");
    const events = evNames.flatMap((name) => readFileSync(join(dir, name), "utf8").trim().split("\n").filter(Boolean).map(JSON.parse));
    assert.equal(events.length, 3);
    for (const event of events) {
        const shard = readFileSync(join(dir, event.source.file));
        const raw = shard.subarray(event.source.offset, event.source.offset + event.source.bytes);
        assert.equal(createHash("sha256").update(raw).digest("hex"), event.source.sha256, "字节引用指向实际分片");
        assert.deepEqual(JSON.parse(raw).result, event.text, "摘要文本与分片原文一致");
    }
    // 分片清单：登记全部 messages 分片（含轮转片），原子落盘为 JSON
    const manifest = JSON.parse(readFileSync(join(dir, "external-exec.messages.manifest.json"), "utf8"));
    assert.equal(manifest.kind, "agent-record-shards");
    assert.deepEqual(manifest.files.map((f) => f.file).sort(),
        ["external-exec.messages.000002.jsonl", "external-exec.messages.000003.jsonl", "external-exec.messages.jsonl"], "清单登记全部分片");
    assert.equal(manifest.status, "open");
});

test("TASK-10 分片轮转：跨执行从最后一个分片续写，不清空历史分片", () => {
    const paths = fixture();
    const first = createAgentRecordWriter({ ...paths, executor: "claude-code", rotateBytes: 120 });
    first.appendFrame({ type: "result", result: "第一轮-" + "y".repeat(100) });
    first.appendFrame({ type: "result", result: "第一轮第二条-" + "y".repeat(100) });
    const dir = dirname(paths.messagesPath);
    const before = readdirSync(dir).filter((n) => n.startsWith("external-exec.messages"));
    const second = createAgentRecordWriter({ ...paths, executor: "claude-code", rotateBytes: 120 });
    second.appendFrame({ type: "result", result: "第二轮-" + "z".repeat(100) });
    const after = readdirSync(dir).filter((n) => n.startsWith("external-exec.messages"));
    assert.ok(after.length >= before.length && after.includes("external-exec.messages.000002.jsonl"), "历史分片保留");
    // 第二轮的第一条落在最后一个现存分片（续写），不重开首片
    const events = readdirSync(dir).filter((n) => /^external-exec\.events(?:\.\d{6})?\.jsonl$/.test(n))
        .flatMap((name) => readFileSync(join(dir, name), "utf8").trim().split("\n").filter(Boolean).map(JSON.parse));
    const secondEvent = events.find((e) => e.text?.startsWith("第二轮"));
    assert.ok(secondEvent.source.file.length >= "external-exec.messages.jsonl".length, "source.file 指向续写分片");
    const shard = readFileSync(join(dir, secondEvent.source.file));
    assert.deepEqual(JSON.parse(shard.subarray(secondEvent.source.offset, secondEvent.source.offset + secondEvent.source.bytes)),
        { type: "result", result: "第二轮-" + "z".repeat(100) }, "第二轮消息可按 source 定位");
});

test("DSH 原生消息与工具事件摘要保留关联字段，未知事件保留可追溯摘要", () => {
    assert.deepEqual(dshEventToEntries({ type: "tool/call", data: { turn: 1, step: 0, callId: "tool-1", name: "Read", arguments: '{"path":"src/main.js"}' } }),
        [{ kind: "tool", text: "Read src/main.js", toolUseId: "tool-1", relation: "call" }]);
    const result = dshEventToEntries({ type: "tool/result", data: { message: { source: { kind: "tool", callId: "tool-1" }, content: [
        { type: "tool-result", toolCallId: "tool-1", isError: true, content: [{ type: "text", text: "文件读取失败" }] },
    ] } } })[0];
    assert.equal(result.toolUseId, "tool-1"); assert.equal(result.relation, "result");
    assert.equal(result.kind, "error"); assert.equal(result.text, "文件读取失败"); assert.equal(result.blockIndex, 0);
    const message = dshEventToEntries({ type: "assistant/message", data: { message: { content: [
        { type: "reasoning", text: "实际原生思考块" }, { type: "tool-call", id: "tool-1", name: "Read", arguments: '{"path":"src/main.js"}' },
    ] } } });
    assert.deepEqual(message.map((e) => [e.kind, e.blockIndex]), [["think", 0], ["tool", 1]]);
    assert.equal(message[1].toolUseId, "tool-1");
    assert.equal(message[1].relation, undefined, "关联只认实际 tool/call，assistant 工具请求不重复计作调用");
    assert.equal(dshEventToEntries({ type: "future/event", data: { complete: true } })[0].kind, "raw");
});
