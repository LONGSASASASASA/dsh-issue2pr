// lib/infra/journal.js — 通用持续写盘留档（修复清单 20260916-001 TASK-03）
// 单写者模型：一个目录同一时刻只允许一个 journal 实例写入；目录按执行身份
// （callId / attemptId / captureId）由调用方划分，归属唯一。目录已有未闭合或
// 已封存的留档时拒绝复用；未闭合的旧留档须先 recoverJournal 封存。
//
// 文件布局（每实例一个目录）：
//   shard-NNNNNN.jsonl   — 记录分片：JSON 一行一条，单条记录不跨分片，纯 JSONL 可逐行解析。
//   stream-NNNNNN.log    — 流式分片：appendChunk 的裸字节流（stdout / 响应增量等），
//                          与记录分片分开存放，按清单顺序拼接读回完整流。
//   blob-NNNNNN-xx.json  — 超过单分片阈值的超大单条记录，独立文件，原子落盘。
//   manifest.json        — 分片清单 + 运行/封存状态，唯一完整性事实来源，原子更新。
//
// 完整性（结果语义，只由本模块按写入事实判定，调用方不得自报，防伪装完整）：
//   complete     — 正常封存且无写盘/清单错误
//   partial      — 未观察到正常结束（异常退出恢复）或存在不完整尾部
//   write_failed — 留档写入或清单落盘曾失败
//   corrupt      — 清单损坏 / 分片缺失或与清单矛盾
//   unavailable  — 无留档（manifest.json 缺失）
//   open（扩展）— 写入进行中，尚未到结束
// 不通过「文件是否存在」间接推断完整性；进行中与已结束、正常与异常结束
// 以 manifest.status（open/sealed）+ integrity 区分。
//
// flush 语义（有界写入缓冲）：流式 chunk 进入内存缓冲，触发点为
// 按大小（累计 ≥ flushBytes）与显式 flush()/appendRecord（记录前自动冲刷）；
// appendRecord 返回引用时该行已 writeSync 到文件，进程被杀不丢已报告内容。
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { basename, join } from "node:path";

export const JOURNAL_SCHEMA_VERSION = 1;
export const DEFAULT_SHARD_MAX_BYTES = 8 * 1024 * 1024;
export const DEFAULT_FLUSH_BYTES = 64 * 1024;
export const DEFAULT_REF_MAX_BYTES = 64 * 1024 * 1024;
const MANIFEST = "manifest.json";
const SHARD_RE = /^shard-(\d{6})\.jsonl$/;
const STREAM_RE = /^stream-(\d{6})\.log$/;
const BLOB_RE = /^blob-\d{6}-[0-9a-f]{12}\.json$/;
const INTEGRITIES = ["complete", "partial", "write_failed", "corrupt", "unavailable", "open"];

const nowIso = () => new Date().toISOString();
const msg = (e) => String((e && e.message) || e);
const shardName = (n) => `shard-${String(n).padStart(6, "0")}.jsonl`;
const streamName = (n) => `stream-${String(n).padStart(6, "0")}.log`;
const blobName = (seq) => `blob-${String(seq).padStart(6, "0")}-${randomUUID().replace(/-/g, "").slice(0, 12)}.json`;
const shardIndex = (file) => Number(SHARD_RE.exec(file)?.[1] ?? -1);

// manifest.json 原子写（tmp + rename）；失败时清理临时文件后抛出，由调用点决定记错方式
function persistManifestFile(dir, manifest) {
  const full = join(dir, MANIFEST);
  const tmp = full + ".tmp-" + randomUUID();
  try {
    writeFileSync(tmp, JSON.stringify(manifest, null, 2));
    renameSync(tmp, full);
  } catch (error) {
    try { rmSync(tmp, { force: true }); } catch { /* 尽力清理 */ }
    throw error;
  }
}

// 原子写任意留档文件（超大 blob 等）：内容整体 tmp+rename，要么完整在盘要么不在
function persistFile(dir, file, bytes) {
  const full = join(dir, file);
  const tmp = full + ".tmp-" + randomUUID();
  try {
    writeFileSync(tmp, bytes);
    renameSync(tmp, full);
  } catch (error) {
    try { rmSync(tmp, { force: true }); } catch { /* 尽力清理 */ }
    throw error;
  }
}

function readManifestIfAny(dir) {
  const full = join(dir, MANIFEST);
  if (!existsSync(full)) return null;
  try {
    const value = JSON.parse(readFileSync(full, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) return "corrupt";
    if (value.schemaVersion !== JOURNAL_SCHEMA_VERSION) return "corrupt";
    if (value.status !== "open" && value.status !== "sealed") return "corrupt";
    return value;
  } catch { return "corrupt"; }
}

// 循环写直到写完；半写正是「写一半」故障的来源，必须显式处理
function writeAll(fd, buffer) {
  let written = 0;
  while (written < buffer.length) {
    const n = writeSync(fd, buffer, written, buffer.length - written);
    if (n <= 0) throw new Error("writeSync 返回 " + n + "，写入未推进");
    written += n;
  }
}

// 从 fd 的 position 起读 length 字节进新 Buffer；读不满即抛（引用校验语境下不允许短读）
function readExact(fd, position, length) {
  const buffer = Buffer.alloc(length);
  let read = 0;
  while (read < length) {
    const n = readSync(fd, buffer, read, length - read, position + read);
    if (!n) throw new Error("读取不完整（期望 " + length + " 字节，实得 " + read + "）");
    read += n;
  }
  return buffer;
}

export function createJournal({ dir, shardMaxBytes = DEFAULT_SHARD_MAX_BYTES, flushBytes = DEFAULT_FLUSH_BYTES, meta = {} } = {}) {
  if (typeof dir !== "string" || !dir.trim()) throw new Error("journal dir 必填");
  if (!Number.isSafeInteger(shardMaxBytes) || shardMaxBytes < 1024) throw new Error("shardMaxBytes 至少 1024 字节");
  if (!Number.isSafeInteger(flushBytes) || flushBytes < 1) throw new Error("flushBytes 至少 1 字节");
  mkdirSync(dir, { recursive: true });
  const existing = readManifestIfAny(dir);
  if (existing === "corrupt") throw new Error("目标目录存在损坏的留档清单（manifest.json），拒绝写入");
  if (existing?.status === "open") throw new Error("目标目录已有未闭合留档，先 recoverJournal 封存后再另开目录");
  if (existing) throw new Error("目标目录已有已封存留档，单写者归属，拒绝复用目录");
  const stray = readdirSync(dir).filter((n) => SHARD_RE.test(n) || STREAM_RE.test(n) || BLOB_RE.test(n));
  if (stray.length) throw new Error("目标目录存在未登记的留档分片，拒绝写入: " + stray[0]);

  const manifest = {
    schemaVersion: JOURNAL_SCHEMA_VERSION, kind: "journal", status: "open",
    createdAt: nowIso(), meta, shards: [], streams: [], blobs: [], lastSeq: 0,
  };
  let shardFd = null, shardBytes = 0, seq = 0;
  let streamFd = null, streamBytes = 0;
  let chunkParts = [], chunkBuffered = 0;
  let journalError = null;    // 分片/blob 写盘失败（含打开失败）
  let manifestError = null;   // 清单原子写失败
  let sealedResult = null;

  const curShard = () => manifest.shards[manifest.shards.length - 1];

  function persistManifest() {
    manifest.updatedAt = nowIso();
    try { persistManifestFile(dir, manifest); manifestError = null; }
    catch (error) {
      // 清单落盘失败不中断主数据流：记录错误，下个触发点重试；封存时终判
      manifestError = { code: error?.code || "EIO", message: msg(error), at: nowIso() };
    }
  }

  function failWrite(error) {
    journalError = { code: error?.code || "EIO", message: msg(error), at: nowIso() };
    for (const fd of [shardFd, streamFd]) { try { if (fd != null) closeSync(fd); } catch { /* 尽力 */ } }
    shardFd = null; streamFd = null; // 分片尾部可能存在半写，交由 recoverJournal 判定，不截断
  }

  function assertWritable() {
    if (sealedResult) { const e = new Error("留档已封存，拒绝追加"); e.code = "JOURNAL_SEALED"; throw e; }
    if (journalError) {
      const e = new Error("留档写入已失败，拒绝继续追加: " + journalError.message);
      e.code = "JOURNAL_WRITE_FAILED"; e.lastError = journalError; throw e;
    }
  }

  function ensureShard() {
    if (shardFd != null) return;
    const file = shardName(manifest.shards.length + 1);
    let fd;
    try { fd = openSync(join(dir, file), "a"); }
    catch (error) { failWrite(error); throw error; }
    try {
      shardBytes = fstatSync(fd).size; // "a" 追加不截断；防御性记录真实大小
      manifest.shards.push({ file, bytes: shardBytes, records: 0, openedAt: nowIso() });
      shardFd = fd;
    } catch (error) {
      try { closeSync(fd); } catch { /* 尽力 */ }
      failWrite(error); throw error;
    }
  }

  function rotateShard() {
    curShard().sealedAt = nowIso();
    try { closeSync(shardFd); } catch (error) { failWrite(error); throw error; }
    shardFd = null; shardBytes = 0;
    ensureShard();
    persistManifest(); // 轮转即落清单：异常退出后已封分片可被读取端核对
  }

  function ensureStream() {
    if (streamFd != null) return;
    const file = streamName(manifest.streams.length + 1);
    let fd;
    try { fd = openSync(join(dir, file), "a"); }
    catch (error) { failWrite(error); throw error; }
    try {
      streamBytes = fstatSync(fd).size;
      manifest.streams.push({ file, bytes: streamBytes, openedAt: nowIso() });
      streamFd = fd;
    } catch (error) {
      try { closeSync(fd); } catch { /* 尽力 */ }
      failWrite(error); throw error;
    }
  }

  function rotateStream() {
    manifest.streams[manifest.streams.length - 1].sealedAt = nowIso();
    try { closeSync(streamFd); } catch (error) { failWrite(error); throw error; }
    streamFd = null; streamBytes = 0;
    ensureStream();
    persistManifest();
  }

  function flushChunks() {
    if (!chunkParts.length) return;
    const buffer = Buffer.concat(chunkParts);
    chunkParts = []; chunkBuffered = 0;
    ensureStream();
    // 流字节写入独立 stream 分片（记录分片保持纯 JSONL）；达到阈值同样轮转
    if (streamBytes > 0 && streamBytes + buffer.length > shardMaxBytes) rotateStream();
    try { writeAll(streamFd, buffer); }
    catch (error) { failWrite(error); throw error; }
    streamBytes += buffer.length;
    manifest.streams[manifest.streams.length - 1].bytes = streamBytes;
  }

  function baseRef(path, offset, length, sha256, format) {
    return { path, offset, length, sha256, encoding: "utf-8", format, seq, schemaVersion: JOURNAL_SCHEMA_VERSION };
  }

  function appendRecord(record) {
    assertWritable();
    let line;
    try { line = Buffer.from(JSON.stringify(record) + "\n", "utf8"); }
    catch (error) { throw error; } // 序列化失败（循环引用等）是数据问题，不计入写盘失败
    flushChunks(); // 记录与流式文本保持时间顺序
    seq += 1;
    manifest.lastSeq = seq;
    const body = line.subarray(0, line.length - 1); // sha/length 不含行尾换行，与既有 source 先例一致
    const sha256 = createHash("sha256").update(body).digest("hex");
    let ref;
    if (body.length > shardMaxBytes) {
      // 超大单条：独立 blob 文件，原子落盘，不进分片
      const file = blobName(seq);
      try {
        persistFile(dir, file, line);
        manifest.blobs.push({ file, bytes: line.length, seq, at: nowIso() });
        ref = baseRef(file, 0, body.length, sha256, "blob");
      } catch (error) { failWrite(error); throw error; }
    } else {
      ensureShard();
      if (shardBytes > 0 && shardBytes + line.length > shardMaxBytes) rotateShard();
      const offset = shardBytes;
      try { writeAll(shardFd, line); }
      catch (error) { failWrite(error); throw error; }
      shardBytes += line.length;
      const shard = curShard();
      shard.bytes = shardBytes; shard.records += 1;
      ref = baseRef(shard.file, offset, body.length, sha256, "record");
    }
    // 每条记录落盘即更新清单：任何已报告落盘的记录在异常退出后都能从清单定位，
    // 「执行期间就更新状态」不靠积累阈值（留档记录是低频关键事件，代价可接受）
    persistManifest();
    return ref;
  }

  function appendChunk(chunk) {
    assertWritable();
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), "utf8");
    if (!buffer.length) return;
    chunkParts.push(buffer); chunkBuffered += buffer.length;
    if (chunkBuffered >= flushBytes) flushChunks();
  }

  function flush() { assertWritable(); flushChunks(); }

  // 封存：不抛错（不得覆盖调用方原始业务异常）；返回 { ok, integrity, problems }
  // 两类错误分开保留：businessError（调用方业务异常）与 journalError/manifestError（留档自身故障）
  function seal({ status = "completed", reason = null, error = null } = {}) {
    if (sealedResult) return sealedResult;
    const problems = [];
    // 封存前已发生的留档故障必须体现在结果里：integrity 与 ok 不得互相矛盾
    if (journalError) problems.push("留档写入曾失败: " + journalError.message);
    if (manifestError) problems.push("清单写入曾失败: " + manifestError.message);
    try { flushChunks(); }
    catch (e) { problems.push("封存前冲刷分片失败: " + msg(e)); }
    for (const [name, fd] of [["记录分片", shardFd], ["流式分片", streamFd]]) {
      if (fd != null) {
        try { closeSync(fd); } catch (e) { problems.push("关闭" + name + "句柄失败: " + msg(e)); }
      }
    }
    shardFd = null; streamFd = null;
    if (curShard() && !curShard().sealedAt) curShard().sealedAt = nowIso();
    const curStream = manifest.streams[manifest.streams.length - 1];
    if (curStream && !curStream.sealedAt) curStream.sealedAt = nowIso();
    manifest.status = "sealed";
    manifest.sealedAt = nowIso();
    manifest.closedStatus = String(status);
    if (reason) manifest.closedReason = String(reason);
    if (error) manifest.businessError = { message: msg(error), ...(error?.code ? { code: String(error.code) } : {}) };
    if (journalError) manifest.journalError = journalError;
    if (manifestError) manifest.manifestError = manifestError;
    manifest.integrity = (journalError || manifestError) ? "write_failed" : "complete";
    persistManifest();
    if (manifestError) problems.push("清单落盘失败: " + manifestError.message + "（分片内容仍在盘，清单保持 open，需 recover 封存）");
    sealedResult = {
      ok: problems.length === 0, dir, integrity: manifest.integrity,
      status: manifest.closedStatus, problems,
      journalError, businessError: error ? manifest.businessError : null,
    };
    return sealedResult;
  }

  function state() {
    return {
      dir, status: sealedResult ? "sealed" : "open",
      integrity: sealedResult ? sealedResult.integrity : ((journalError || manifestError) ? "write_failed" : "open"),
      records: seq, shards: manifest.shards.length, streams: manifest.streams.length, blobs: manifest.blobs.length,
      bytes: manifest.shards.reduce((sum, s) => sum + s.bytes, 0)
        + manifest.streams.reduce((sum, s) => sum + s.bytes, 0),
      chunkBuffered, journalError, manifestError, sealedResult,
    };
  }

  persistManifest(); // 建立即落清单：目录一出现即有身份与 open 状态可查
  return { appendRecord, appendChunk, flush, seal, state };
}

// —— 读取端（只读，不改盘）——
function corruptResult(problems) {
  return { ok: true, present: true, status: "corrupt", integrity: "corrupt", problems, shards: [], streams: [], blobs: [] };
}

export function readJournal(dir) {
  const full = join(dir, MANIFEST);
  if (!existsSync(full)) {
    return { ok: true, present: false, status: "missing", integrity: "unavailable",
      problems: ["留档不存在（manifest.json 缺失）"], shards: [], streams: [], blobs: [] };
  }
  let manifest;
  try { manifest = JSON.parse(readFileSync(full, "utf8")); }
  catch (e) { return corruptResult(["manifest.json 不是有效 JSON: " + msg(e)]); }
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest))
    return corruptResult(["manifest.json 不是 JSON 对象"]);
  if (manifest.schemaVersion !== JOURNAL_SCHEMA_VERSION)
    return corruptResult([`清单 schemaVersion=${manifest.schemaVersion} 不受支持（当前 ${JOURNAL_SCHEMA_VERSION}）；journal 为本轮新增留档，无版本旧文件不在兼容范围`]);
  if (manifest.status !== "open" && manifest.status !== "sealed")
    return corruptResult(["清单 status 非法: " + manifest.status]);

  const problems = [];
  let integrity = manifest.status === "open"
    ? "open"
    : (manifest.integrity && INTEGRITIES.includes(manifest.integrity) ? manifest.integrity : "partial");
  const shards = [];
  for (const s of Array.isArray(manifest.shards) ? manifest.shards : []) {
    if (!s || !SHARD_RE.test(String(s.file || ""))) { integrity = "corrupt"; problems.push("清单含非法分片名: " + String(s?.file)); continue; }
    const path = join(dir, s.file);
    if (!existsSync(path)) { integrity = "corrupt"; problems.push(`分片缺失: ${s.file}`); shards.push({ ...s, actualBytes: null }); continue; }
    const actual = statSync(path).size;
    if (manifest.status === "sealed" && actual !== s.bytes) {
      integrity = "corrupt";
      problems.push(`分片 ${s.file} 实际 ${actual} 字节与封存清单 ${s.bytes} 字节不符`);
    } else if (manifest.status === "open" && actual < s.bytes) {
      // open 期间清单可能滞后于分片（实际更多），但绝不允许更少——更少即内容被删
      integrity = "corrupt";
      problems.push(`分片 ${s.file} 实际 ${actual} 字节少于清单记录 ${s.bytes} 字节`);
    }
    shards.push({ ...s, actualBytes: actual });
  }
  const streams = [];
  for (const s of Array.isArray(manifest.streams) ? manifest.streams : []) {
    if (!s || !STREAM_RE.test(String(s.file || ""))) { integrity = "corrupt"; problems.push("清单含非法流分片名: " + String(s?.file)); continue; }
    const path = join(dir, s.file);
    if (!existsSync(path)) { integrity = "corrupt"; problems.push(`流分片缺失: ${s.file}`); streams.push({ ...s, actualBytes: null }); continue; }
    const actual = statSync(path).size;
    if (manifest.status === "sealed" && actual !== s.bytes) {
      integrity = "corrupt";
      problems.push(`流分片 ${s.file} 实际 ${actual} 字节与封存清单 ${s.bytes} 字节不符`);
    } else if (manifest.status === "open" && actual < s.bytes) {
      integrity = "corrupt";
      problems.push(`流分片 ${s.file} 实际 ${actual} 字节少于清单记录 ${s.bytes} 字节`);
    }
    streams.push({ ...s, actualBytes: actual });
  }
  const blobs = [];
  for (const b of Array.isArray(manifest.blobs) ? manifest.blobs : []) {
    if (!b || !BLOB_RE.test(String(b.file || ""))) { integrity = "corrupt"; problems.push("清单含非法 blob 名: " + String(b?.file)); continue; }
    const path = join(dir, b.file);
    if (!existsSync(path)) { integrity = "corrupt"; problems.push(`超大记录文件缺失: ${b.file}`); blobs.push({ ...b, actualBytes: null }); continue; }
    const actual = statSync(path).size;
    if (actual !== b.bytes) { integrity = "corrupt"; problems.push(`blob ${b.file} 实际 ${actual} 字节与清单 ${b.bytes} 字节不符`); }
    blobs.push({ ...b, actualBytes: actual });
  }
  return { ok: true, present: true, status: manifest.status, integrity, manifest, shards, streams, blobs, problems };
}

// 按引用读回原文：字节精确（offset/length/sha256）、行边界与 UTF-8 fatal 校验；
// 上限触发时明确报错，不截断返回
export function readJournalRef(dir, ref, { maxBytes = DEFAULT_REF_MAX_BYTES } = {}) {
  if (!ref || typeof ref !== "object") throw new Error("引用必须是对象");
  const { path, offset, length, sha256 } = ref;
  const format = ref.format || "record";
  if (typeof path !== "string" || basename(path) !== path || !(SHARD_RE.test(path) || STREAM_RE.test(path) || BLOB_RE.test(path)))
    throw new Error("引用 path 非法（仅允许 journal 目录内的分片/blob 文件名）: " + String(path));
  if (ref.encoding && ref.encoding !== "utf-8") throw new Error("仅支持 utf-8 引用");
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 1)
    throw new Error("引用 offset/length 非法");
  if (length > maxBytes) throw new Error(`引用内容 ${length} 字节超过读取上限 ${maxBytes} 字节，拒绝截断返回（可调 maxBytes 读取）`);
  if (!/^[a-f0-9]{64}$/i.test(String(sha256 || ""))) throw new Error("引用 sha256 非法");
  const full = join(dir, path);
  if (!existsSync(full)) throw new Error("引用来源文件不存在: " + path);
  const size = statSync(full).size;
  if (offset + length > size) throw new Error("引用超出文件范围，来源可能未写完整或已被改动");
  const fd = openSync(full, "r");
  try {
    if (format === "record") {
      // JSON 行不跨分片：起点（非文件头时）前一字节与终点后一字节都必须是换行
      if (offset > 0 && readExact(fd, offset - 1, 1)[0] !== 10) throw new Error("引用起点不在行边界");
      if (offset + length === size) throw new Error("记录缺少行尾换行，写入可能未完成（半写）");
      if (readExact(fd, offset + length, 1)[0] !== 10) throw new Error("引用终点不在行边界");
    } else if (format === "stream") {
      // 流分片是裸字节流：无行边界语义，仅做范围与校验和核对
    } else {
      // blob 文件 = 单条记录一行：引用覆盖整行，换行后必须即文件尾
      if (offset !== 0) throw new Error("blob 引用必须从文件头开始");
      if (offset + length === size) throw new Error("记录缺少行尾换行，写入可能未完成（半写）");
      if (readExact(fd, offset + length, 1)[0] !== 10) throw new Error("引用终点不在行边界");
      if (offset + length + 1 !== size) throw new Error("blob 文件在记录行之后还有多余内容");
    }
    const buffer = readExact(fd, offset, length);
    if (createHash("sha256").update(buffer).digest("hex") !== sha256)
      throw new Error("引用 sha256 校验失败，来源文件可能已改动");
    let text;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(buffer); }
    catch (e) { throw new Error("引用内容不是有效 UTF-8（可能跨多字节字符边界被改动）: " + msg(e)); }
    return { text, bytes: length, ref: { ...ref, dir } };
  } finally { try { closeSync(fd); } catch { /* 尽力 */ } }
}

// 异常退出恢复：把 open 留档封存为「未观察到正常结束」的 partial（或保留 write_failed），
// 采纳清单未登记的分片/blob（不删不改任何已写内容），原子改写 manifest。
export function recoverJournal(dir, { reason = null } = {}) {
  const before = readJournal(dir);
  if (!before.present) return { ...before, recovered: false };
  if (before.integrity === "corrupt")
    return { ...before, recovered: false, problems: [...before.problems, "清单损坏，拒绝自动恢复（分片内容保留原样）"] };
  if (before.status !== "open") return { ...before, recovered: false };

  const manifest = before.manifest;
  const registered = new Set(manifest.shards.map((s) => s.file));
  const adoptedShards = readdirSync(dir).filter((n) => SHARD_RE.test(n) && !registered.has(n))
    .sort((a, b) => shardIndex(a) - shardIndex(b));
  for (const file of adoptedShards) manifest.shards.push({ file, bytes: statSync(join(dir, file)).size, records: null, adoptedAt: nowIso() });
  manifest.streams ||= [];
  const registeredStreams = new Set(manifest.streams.map((s) => s.file));
  const adoptedStreams = readdirSync(dir).filter((n) => STREAM_RE.test(n) && !registeredStreams.has(n))
    .sort((a, b) => Number(STREAM_RE.exec(a)[1]) - Number(STREAM_RE.exec(b)[1]));
  for (const file of adoptedStreams) manifest.streams.push({ file, bytes: statSync(join(dir, file)).size, adoptedAt: nowIso() });
  const registeredBlobs = new Set(manifest.blobs.map((b) => b.file));
  const adoptedBlobs = readdirSync(dir).filter((n) => BLOB_RE.test(n) && !registeredBlobs.has(n)).sort();
  for (const file of adoptedBlobs) manifest.blobs.push({ file, bytes: statSync(join(dir, file)).size, seq: null, at: nowIso(), adopted: true });

  // 尾部不完整检测：最后一个分片（按序号）末字节非换行 → 计算半写字节数，只记录不删除
  let trailingBytes = 0;
  const lastShard = [...manifest.shards].sort((a, b) => shardIndex(a.file) - shardIndex(b.file)).at(-1);
  if (lastShard && existsSync(join(dir, lastShard.file))) {
    const full = join(dir, lastShard.file);
    const size = statSync(full).size;
    if (size) {
      const fd = openSync(full, "r");
      try {
        const want = Math.min(size, 64 * 1024);
        const tail = readExact(fd, size - want, want);
        const lastNewline = tail.lastIndexOf(10);
        trailingBytes = lastNewline === -1 ? size : size - (size - want + lastNewline + 1);
      } finally { try { closeSync(fd); } catch { /* 尽力 */ } }
    }
  }
  manifest.status = "sealed";
  manifest.sealedAt = nowIso();
  manifest.closedReason = reason || "unobserved_end";
  manifest.integrity = manifest.journalError || manifest.manifestError ? "write_failed" : "partial";
  manifest.recovery = { at: nowIso(), kind: "unobserved_end", trailingBytes, adoptedShards, adoptedStreams, adoptedBlobs };
  try { persistManifestFile(dir, manifest); }
  catch (e) {
    return { ...before, recovered: false,
      problems: [...before.problems, "恢复清单写入失败: " + msg(e) + "（分片内容保留原样）"] };
  }
  return { ...readJournal(dir), recovered: true };
}
