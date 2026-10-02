import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createApp } from "../src/server.js";
import { hash } from "../src/common.js";
const admin = "admin-only-for-tests-01234567890123456789",
  view = "viewer-only-for-tests-01234567890123456";
async function app(t, demo = false) {
  const server = createApp({
    databasePath: ":memory:",
    adminKey: admin,
    viewKey: view,
    demo,
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((r) => server.close(r)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return async (path, key, body) => {
    const res = await fetch(origin + path, {
      method: body ? "POST" : "GET",
      headers: {
        ...(key ? { authorization: `Bearer ${key}` } : {}),
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, headers: res.headers, body: await res.json() };
  };
}
const event = (id = "e", input = 100, output = 20) => ({
  id: hash(id),
  session: hash("session"),
  provider: "claude",
  inputTokens: input,
  outputTokens: output,
  cacheReadTokens: 10,
  cacheWriteTokens: 0,
  occurredAt: new Date().toISOString(),
});
test("End-to-end authorization, idempotency, atomic validation, filters, key rotation", async (t) => {
  const api = await app(t);
  assert.equal((await api("/api/summary")).status, 401);
  assert.equal(
    (await api("/api/admin/teams", view, { name: "Nope" })).status,
    401,
  );
  const a = await api("/api/admin/teams", admin, { name: "Alpha" });
  assert.equal(a.status, 201);
  const b = await api("/api/admin/teams", admin, { name: "Beta" });
  const e = event();
  assert.equal(
    (await api("/api/events", a.body.key, { team: "Beta", events: [e] }))
      .status,
    403,
  );
  assert.equal(
    (await api("/api/events", a.body.key, { team: "Alpha", events: [e] }))
      .status,
    200,
  );
  await Promise.all(
    Array.from({ length: 8 }, () =>
      api("/api/events", a.body.key, { team: "Alpha", events: [e] }),
    ),
  );
  let result = await api("/api/summary", view);
  assert.equal(result.body.totals.inputTokens, 100);
  assert.equal(result.body.totals.outputTokens, 20);
  assert.equal(result.body.teams.length, 2);
  assert.equal(result.body.admin, false);
  await api("/api/events", a.body.key, {
    team: "Alpha",
    events: [{ ...e, outputTokens: 40 }],
  });
  const invalid = await api("/api/events", a.body.key, {
    team: "Alpha",
    events: [event("new", 500), { ...event("bad"), prompt: "DO NOT STORE" }],
  });
  assert.equal(invalid.status, 400);
  result = await api("/api/summary", admin);
  assert.equal(result.body.totals.outputTokens, 40);
  assert.equal(result.body.totals.inputTokens, 100);
  assert.ok(!JSON.stringify(result.body).includes(a.body.key));
  assert.equal(
    (await api("/api/summary?provider=codex", view)).body.totals.inputTokens,
    0,
  );
  assert.equal(
    (await api("/api/events", view, { team: "Alpha", events: [e] })).status,
    401,
  );
  await api(`/api/admin/teams/${a.body.id}/status`, admin, { active: false });
  assert.equal(
    (await api("/api/verify", a.body.key, { team: "Alpha" })).status,
    401,
  );
  await api(`/api/admin/teams/${a.body.id}/status`, admin, { active: true });
  const rotate = await api(`/api/admin/teams/${a.body.id}/rotate`, admin, {});
  assert.equal(
    (await api("/api/verify", a.body.key, { team: "Alpha" })).status,
    401,
  );
  assert.equal(
    (await api("/api/verify", rotate.body.key, { team: "Alpha" })).status,
    200,
  );
  assert.equal(result.headers.get("x-content-type-options"), "nosniff");
  assert.ok(
    result.headers.get("content-security-policy").includes("script-src 'self'"),
  );
});
test("Demo is explicitly labelled, readable and cannot accept participant reports", async (t) => {
  const api = await app(t, true);
  const result = await api("/api/summary");
  assert.equal(result.body.demo, true);
  assert.equal(result.body.teams.length, 6);
  assert.equal(
    (await api("/api/events", null, { team: "Test", events: [event()] }))
      .status,
    403,
  );
});
test("Team names treated as data, oversized/invalid counts rejected", async (t) => {
  const api = await app(t);
  const name = "<img src=x onerror=alert(1)>";
  const team = await api("/api/admin/teams", admin, { name });
  assert.equal(team.status, 201);
  assert.equal((await api("/api/summary", view)).body.teams[0].name, name);
  assert.equal(
    (
      await api("/api/events", team.body.key, {
        team: name,
        events: [{ ...event(), outputTokens: 1.2 }],
      })
    ).status,
    400,
  );
});
