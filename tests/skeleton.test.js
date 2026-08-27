// tests/skeleton.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { apply, name, inject } from "../index.js";

function fakeCtx() {
  const routes = [];
  return {
    registrations: routes,
    effect(fn) { fn(); return () => {}; },
    logger: { info() {} },
    webServer: { register(spec) { routes.push(spec); } },
  };
}

test("骨架：导出 name/inject，apply 注册 /issue2pr 前缀路由", () => {
  assert.equal(name, "dsh-issue2pr");
  assert.deepEqual(inject, ["webServer"]);
  const ctx = fakeCtx();
  apply(ctx);
  assert.equal(ctx.registrations.length, 1);
  assert.equal(ctx.registrations[0].kind, "prefix");
  assert.equal(ctx.registrations[0].path, "/issue2pr");
  assert.equal(typeof ctx.registrations[0].handler, "function");
});

test("骨架：GET /issue2pr/api/ping 返回 ok", async () => {
  const ctx = fakeCtx();
  apply(ctx);
  const handler = ctx.registrations[0].handler;
  const req = { method: "GET", url: "/issue2pr/api/ping", on() {} };
  const chunks = [];
  const res = { writeHead() {}, end(d) { chunks.push(d); } };
  await handler(req, res);
  const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  assert.deepEqual(body, { ok: true, plugin: "dsh-issue2pr" });
});