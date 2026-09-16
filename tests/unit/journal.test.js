// tests/unit/journal.test.js — 通用持续写盘留档（修复清单 20260916-001 TASK-03）
// 覆盖验收：轮转、异常退出、写盘失败、索引损坏、缺失分片、跨 UTF-8 边界、超大消息。
// 故障注入全部使用真实文件系统手段（只读分片模拟写盘失败、manifest 换成目录模拟
// 清单原子写失败、手工构造半行与未登记分片模拟写一半被杀），不因难以构造而跳过。
import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJournal, readJournal, readJournalRef, recoverJournal, JOURNAL_SCHEMA_VERSION } from "../../lib/infra/journal.js";

const root = mkdtempSync(join(tmpdir(), "i2p-journal-"));
const newDir = (name) => mkdtempSync(join(root, name + "-"));
// Windows 下只读文件 rmSync 会 EPERM，清理前统一恢复写位
const rmDir = (dir) => {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    try { chmodSync(full, 0o666); } catch { /* 尽力 */ }
  }
  rmSync(dir, { recursive: true, force: true });
};
test.after(() => rmSync(root, { recursive: true, force: true }));

test("追加记录与引用回读：offset/length/sha256 字节精确，UTF-8 中文无损", () => {
  const dir = newDir("basic");
  const j = createJournal({ dir, meta: { runId: "r1", callId: "call-1", attemptId: "attempt-1" } });
  const records = [
    { seq: 1, text: "开始分析" },
    { seq: 2, text: "包含 emoji 🎯 与符号 <>&\" 的正文" },
    { seq: 3, nested: { list: ["甲", "乙", "丙"] } },
  ];
  const refs = records.map((r) => j.appendRecord(r));
  const sealed = j.seal({ status: "completed" });
  assert.equal(sealed.ok, true);
  assert.equal(sealed.integrity, "complete");
  for (const [i, ref] of refs.entries()) {
    assert.equal(ref.encoding, "utf-8");
    assert.equal(ref.schemaVersion, JOURNAL_SCHEMA_VERSION);
    const { text, bytes } = readJournalRef(dir, ref);
    assert.deepEqual(JSON.parse(text), records[i]);
    assert.equal(bytes, Buffer.byteLength(JSON.stringify(records[i]), "utf8"));
  }
  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
  assert.equal(manifest.schemaVersion, JOURNAL_SCHEMA_VERSION);
  assert.equal(manifest.status, "sealed");
  assert.equal(manifest.integrity, "complete");
  assert.deepEqual(manifest.meta, { runId: "r1", callId: "call-1", attemptId: "attempt-1" });
  rmDir(dir);
});

test("分片轮转：达到阈值切换新分片，单条记录不跨分片，历史分片不被截断", () => {
  const dir = newDir("rotate");
  const j = createJournal({ dir, shardMaxBytes: 2048 });
  const refs = [];
  for (let i = 0; i < 12; i++) refs.push(j.appendRecord({ i, pad: "数据".repeat(60) })); // 每条约 500B
  // 冻结已封分片（清单中除最后一个外都已 sealedAt），再追加验证轮转不回写、不截断历史
  const manifestNow = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
  const frozen = manifestNow.shards.slice(0, -1).map((s) => [s.file, statSync(join(dir, s.file)).size]);
  assert.ok(frozen.length >= 1, "应已有已封分片可冻结");
  for (let i = 12; i < 15; i++) refs.push(j.appendRecord({ i, pad: "数据".repeat(60) }));
  j.seal({});
  const files = readdirSync(dir).filter((n) => /^shard-\d{6}\.jsonl$/.test(n)).sort();
  assert.ok(files.length >= 3, "应产生多个分片，实际 " + files.length);
  for (const [name, size] of frozen) assert.equal(statSync(join(dir, name)).size, size, `分片 ${name} 被改动`);
  // 清单顺序 = 文件名顺序；每条记录完整落在单一分片（行边界 + 可整行回读）
  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
  assert.deepEqual(manifest.shards.map((s) => s.file), files);
  for (const [i, ref] of refs.entries()) {
    const { text } = readJournalRef(dir, ref);
    assert.equal(JSON.parse(text).i, i);
    const shardSize = statSync(join(dir, ref.path)).size;
    assert.ok(ref.offset + ref.length < shardSize, "记录终点后必须有换行留在分片内");
  }
  rmDir(dir);
});

test("超大单条：超过分片阈值走独立 blob 文件，原子落盘且可整读", () => {
  const dir = newDir("blob");
  const j = createJournal({ dir, shardMaxBytes: 4096 });
  const big = { kind: "response", text: "超".repeat(60000) }; // 约 180KB，远超 4KB 阈值
  const bigRef = j.appendRecord(big);
  assert.equal(bigRef.format, "blob");
  assert.match(bigRef.path, /^blob-\d{6}-[0-9a-f]{12}\.json$/);
  assert.equal(readdirSync(dir).filter((n) => n.startsWith("shard-")).length, 0, "超大记录不应开分片");
  const normalRef = j.appendRecord({ kind: "note" });
  assert.equal(normalRef.format, "record");
  assert.equal(normalRef.path, "shard-000001.jsonl");
  j.seal({});
  assert.deepEqual(JSON.parse(readJournalRef(dir, bigRef).text), big);
  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
  assert.equal(manifest.blobs.length, 1);
  assert.equal(manifest.blobs[0].bytes, Buffer.byteLength(JSON.stringify(big) + "\n", "utf8"));
  rmDir(dir);
});

test("跨 UTF-8 边界：chunk 在多字节字符中间切开与分片边界切换仍字节精确", () => {
  const dir = newDir("utf8");
  const j = createJournal({ dir, shardMaxBytes: 2048, flushBytes: 1024 });
  const stream = "流水文本：汉字与 emoji 🚀混合输出，用于验证多字节边界。".repeat(30);
  const bytes = Buffer.from(stream, "utf8");
  // 故意在多字节字符中间切两段（字节 7 落在某个汉字中间）
  j.appendChunk(bytes.subarray(0, 7));
  j.appendChunk(bytes.subarray(7));
  j.flush();
  const rec = j.appendRecord({ after: "流结束后" });
  j.seal({});
  // 流分片字节拼接后 fatal 解码必须还原原文（流与记录分开存放，各自完整）
  const files = readdirSync(dir).filter((n) => /^stream-\d{6}\.log$/.test(n)).sort();
  const onDisk = Buffer.concat(files.map((f) => readFileSync(join(dir, f))));
  const head = onDisk.subarray(0, bytes.length);
  assert.equal(head.toString("utf8"), stream, "流式字节必须原样落盘");
  const { text } = readJournalRef(dir, rec);
  assert.deepEqual(JSON.parse(text), { after: "流结束后" });
  // 多条记录跨分片轮转后逐条回读（fatal decode 不炸）
  const dir2 = newDir("utf8-recs");
  const j2 = createJournal({ dir: dir2, shardMaxBytes: 2048 });
  const refs = [];
  for (let i = 0; i < 10; i++) refs.push(j2.appendRecord({ i, text: "内容🀀边界测试".repeat(40) }));
  j2.seal({});
  for (const [i, ref] of refs.entries()) assert.equal(JSON.parse(readJournalRef(dir2, ref).text).i, i);
  rmDir(dir); rmDir(dir2);
});

test("有界写入缓冲：未达阈值留在内存，flush/超阈值/记录前自动冲刷落盘", () => {
  const dir = newDir("buffer");
  const j = createJournal({ dir, flushBytes: 4096 });
  j.appendChunk("hello ");
  j.appendChunk("stream");
  assert.equal(j.state().chunkBuffered, 12, "小片段应留在有界缓冲");
  assert.equal(j.state().streams, 0, "未 flush 不应打开流分片");
  j.flush();
  assert.equal(j.state().chunkBuffered, 0);
  const streamFile = readdirSync(dir).find((n) => n.startsWith("stream-"));
  assert.ok(streamFile && readFileSync(join(dir, streamFile), "utf8") === "hello stream", "flush 后应在盘");
  // 超过阈值的 chunk 自动冲刷
  j.appendChunk("x".repeat(5000));
  assert.equal(j.state().chunkBuffered, 0, "超阈值自动落盘");
  assert.ok(statSync(join(dir, streamFile)).size >= 5012);
  // 记录追加前先自动冲刷；流与记录分属不同文件，记录分片保持纯 JSONL
  j.appendChunk("tail-text");
  const rec = j.appendRecord({ final: true });
  j.seal({});
  const streamContent = readFileSync(join(dir, streamFile), "utf8");
  assert.ok(streamContent.endsWith("tail-text"), "流文本完整追加在流分片");
  const shardFile = readdirSync(dir).find((n) => n.startsWith("shard-"));
  const shardLines = readFileSync(join(dir, shardFile), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(shardLines.length, 1, "记录分片只含 JSON 行，不混入流文本");
  assert.deepEqual(shardLines[0], { final: true });
  assert.deepEqual(JSON.parse(readJournalRef(dir, rec).text), { final: true });
  rmDir(dir);
});

test("封存语义：正常 complete、幂等、封存后拒绝追加", () => {
  const dir = newDir("seal");
  const j = createJournal({ dir });
  j.appendRecord({ a: 1 });
  const first = j.seal({ status: "completed" });
  assert.equal(j.seal({ status: "completed" }), first, "seal 幂等，返回同一结果");
  assert.throws(() => j.appendRecord({ b: 2 }), (e) => e.code === "JOURNAL_SEALED");
  assert.throws(() => j.appendChunk("x"), (e) => e.code === "JOURNAL_SEALED");
  assert.equal(readJournal(dir).integrity, "complete");
  rmDir(dir);
});

test("写盘失败注入（只读分片模拟）：追加报错、后续拒绝、seal 标记 write_failed 且两类错误并存", () => {
  const dir = newDir("writefail");
  const j = createJournal({ dir, shardMaxBytes: 1024 });
  const okRef = j.appendRecord({ i: 1, pad: "首条" });
  // 预创建下一个分片并置只读：轮转时 openSync("a") 在 Windows 上 EPERM，等价模拟 ENOSPC 类写盘失败
  const next = join(dir, "shard-000002.jsonl");
  writeFileSync(next, "");
  chmodSync(next, 0o444);
  // 三条各约 580B（< 1024 不走 blob）：第 3 条累计超阈值触发轮转 → 打开只读分片失败
  j.appendRecord({ i: 2, pad: "二".repeat(280) });
  assert.throws(() => j.appendRecord({ i: 3, pad: "三".repeat(280) }), (e) => ["EPERM", "EACCES", "EISDIR"].includes(e.code));
  assert.equal(j.state().integrity, "write_failed");
  assert.throws(() => j.appendRecord({ i: 3 }), (e) => e.code === "JOURNAL_WRITE_FAILED" && e.lastError != null);
  // seal 不得抛（不覆盖业务异常），并把留档故障与业务异常分开保留
  const business = new Error("业务验收失败：测试未通过");
  business.code = "BUSINESS_FAIL";
  const sealed = j.seal({ status: "failed", error: business });
  assert.equal(sealed.ok, false);
  assert.equal(sealed.integrity, "write_failed");
  assert.equal(sealed.journalError.code, "EPERM");
  assert.equal(sealed.businessError.code, "BUSINESS_FAIL");
  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
  assert.equal(manifest.journalError.code, "EPERM");
  assert.equal(manifest.businessError.code, "BUSINESS_FAIL");
  // 首条内容不受写失败影响，仍可回读
  assert.deepEqual(JSON.parse(readJournalRef(dir, okRef).text), { i: 1, pad: "首条" });
  rmDir(dir);
});

test("清单写失败注入（manifest.json 换成目录）：seal 不抛、报告 write_failed、分片内容仍在盘", () => {
  const dir = newDir("manifestfail");
  const j = createJournal({ dir, shardMaxBytes: 2048 });
  j.appendRecord({ i: 1, pad: "一".repeat(100) });
  // 删掉清单文件换成同名目录：原子写 rename(tmp, manifest.json) 目标为目录 → 失败
  rmSync(join(dir, "manifest.json"));
  mkdirSync(join(dir, "manifest.json"));
  for (let i = 2; i <= 8; i++) j.appendRecord({ i, pad: "二".repeat(600) }); // 触发轮转 → 清单落盘失败
  assert.equal(j.state().manifestError != null, true, "清单失败应被记录");
  const sealed = j.seal({ status: "failed" });
  assert.equal(sealed.ok, false);
  assert.equal(sealed.integrity, "write_failed");
  assert.ok(sealed.problems.some((p) => p.includes("清单落盘失败")), sealed.problems.join(";"));
  // 分片内容仍在盘（清单路径被目录占据 → 读取端明确 corrupt，而不是伪装完整）
  const shards = readdirSync(dir).filter((n) => n.startsWith("shard-"));
  assert.ok(shards.length >= 2);
  assert.equal(readJournal(dir).integrity, "corrupt");
  rmDir(dir);
});

test("索引损坏：坏 JSON、schemaVersion 不符、status 非法均明确 corrupt", () => {
  const dir = newDir("corrupt");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "manifest.json"), "{ 不是 JSON");
  assert.equal(readJournal(dir).integrity, "corrupt");
  assert.match(readJournal(dir).problems[0], /不是有效 JSON/);
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({ schemaVersion: 99, status: "open" }));
  let r = readJournal(dir);
  assert.equal(r.integrity, "corrupt");
  assert.match(r.problems[0], /schemaVersion/);
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({ schemaVersion: JOURNAL_SCHEMA_VERSION, status: "weird", shards: [] }));
  r = readJournal(dir);
  assert.equal(r.integrity, "corrupt");
  assert.match(r.problems[0], /status 非法/);
  // 损坏目录拒绝 createJournal 写入，也拒绝自动恢复
  assert.throws(() => createJournal({ dir }), /损坏/);
  assert.equal(recoverJournal(dir).recovered, false);
  rmDir(dir);
});

test("缺失分片：封存后分片被删 → corrupt 并指名缺失文件", () => {
  const dir = newDir("missing");
  const j = createJournal({ dir, shardMaxBytes: 2048 });
  for (let i = 0; i < 6; i++) j.appendRecord({ i, pad: "x".repeat(600) });
  j.seal({});
  const victim = readdirSync(dir).filter((n) => n.startsWith("shard-"))[0];
  rmSync(join(dir, victim));
  const r = readJournal(dir);
  assert.equal(r.integrity, "corrupt");
  assert.ok(r.problems.some((p) => p.includes(victim) && p.includes("缺失")), r.problems.join(";"));
  rmDir(dir);
});

test("异常退出恢复：半行尾与未登记分片被采纳，partial 且历史可回读，不删任何内容", () => {
  const dir = newDir("recover");
  const j = createJournal({ dir, meta: { callId: "call-9" } });
  const refs = [j.appendRecord({ i: 1 }), j.appendRecord({ i: 2 }), j.appendRecord({ i: 3 })];
  // 模拟进程被杀：不 seal（清单停在 open）；手工构造「轮转后新分片已写但清单未登记」
  // 与「写一半被杀的半行」——半行只可能出现在正在写的最后一个分片
  const half = Buffer.from('{"broken": "写一半被杀的半行，没有换行', "utf8");
  writeFileSync(join(dir, "shard-000002.jsonl"), Buffer.concat([
    Buffer.from(JSON.stringify({ i: 4, note: "轮转后已写完整行" }) + "\n", "utf8"), half,
  ]));
  const sizeBefore = statSync(join(dir, "shard-000002.jsonl")).size;
  // open 状态读取：运行态，不误报 complete，也不因清单滞后报 corrupt
  const live = readJournal(dir);
  assert.equal(live.status, "open");
  assert.equal(live.integrity, "open");
  const recovered = recoverJournal(dir);
  assert.equal(recovered.recovered, true);
  assert.equal(recovered.integrity, "partial");
  assert.equal(recovered.manifest.closedReason, "unobserved_end");
  assert.deepEqual(recovered.manifest.recovery.adoptedShards, ["shard-000002.jsonl"]);
  assert.equal(recovered.manifest.recovery.trailingBytes, half.length, "半行字节数应被精确记录");
  // 分片内容一字节未动（半行保留在盘，不截断不删除）
  assert.equal(statSync(join(dir, "shard-000002.jsonl")).size, sizeBefore);
  // 历史完整记录仍可回读
  for (const [i, ref] of refs.entries()) assert.equal(JSON.parse(readJournalRef(dir, ref).text).i, i + 1);
  // 恢复后清单封存：同目录不可复用（单写者）
  assert.equal(readJournal(dir).status, "sealed");
  assert.throws(() => createJournal({ dir }), /拒绝复用/);
  rmDir(dir);
});

test("引用防御：越界路径、伪造 sha、超出读取上限均明确报错且不截断", () => {
  const dir = newDir("refguard");
  const j = createJournal({ dir });
  j.appendRecord({ secret: "首行占位，保证第二条记录的 offset > 0" });
  const ref = j.appendRecord({ secret: "正文" });
  j.appendRecord({ secret: "末行垫背，保证 offset 偏移后不越出文件范围" });
  j.seal({});
  assert.throws(() => readJournalRef(dir, { ...ref, path: "../escape.jsonl" }), /path 非法/);
  assert.throws(() => readJournalRef(dir, { ...ref, path: "C:\\\\evil.jsonl" }), /path 非法/);
  assert.throws(() => readJournalRef(dir, { ...ref, sha256: "0".repeat(64) }), /sha256 校验失败/);
  assert.throws(() => readJournalRef(dir, ref, { maxBytes: 4 }), /超过读取上限/);
  assert.throws(() => readJournalRef(dir, { ...ref, offset: ref.offset + 2 }), /起点不在行边界/);
  assert.throws(() => readJournalRef(dir, { ...ref, offset: 1e12 }), /超出文件范围/);
  rmDir(dir);
});

test("单写者归属：open 遗留要求先恢复，封存目录与游离分片目录拒绝写入", () => {
  const dir = newDir("writer");
  const j = createJournal({ dir });
  j.appendRecord({ a: 1 }); // 清单 open，实例仍在
  assert.throws(() => createJournal({ dir }), /先 recoverJournal/);
  j.seal({});
  assert.throws(() => createJournal({ dir }), /拒绝复用/);
  const stray = newDir("stray");
  mkdirSync(stray, { recursive: true });
  writeFileSync(join(stray, "shard-000001.jsonl"), "{}\n"); // 无清单的游离分片
  assert.throws(() => createJournal({ dir: stray }), /未登记/);
  rmDir(dir); rmDir(stray);
});

test("无留档目录：明确 unavailable，不以文件存在性推断完整性", () => {
  const dir = newDir("absent");
  const r = readJournal(dir);
  assert.equal(r.present, false);
  assert.equal(r.integrity, "unavailable");
  assert.equal(recoverJournal(dir).recovered, false);
  rmDir(dir);
});
