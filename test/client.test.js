import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  rmSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { spawnSync } from "node:child_process";
import {
  editHooks,
  enqueue,
  flush,
  preview,
  parseFile,
  hook,
  status,
  setPaused,
} from "../src/client.js";
import { atomicJSON, hash } from "../src/common.js";
import { createApp } from "../src/server.js";
function temp(t) {
  const path = mkdtempSync(join(tmpdir(), "htm-"));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}
function event(id = "test") {
  return {
    id: hash(id),
    session: hash("session"),
    provider: "claude",
    inputTokens: 100,
    outputTokens: 20,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    occurredAt: new Date().toISOString(),
  };
}
test("Installing twice preserves unrelated hooks; uninstall removes only ours; backups private", (t) => {
  const root = temp(t),
    path = join(root, "settings.json");
  atomicJSON(path, {
    theme: "dark",
    hooks: {
      Stop: [
        { matcher: "", hooks: [{ type: "command", command: "echo existing" }] },
      ],
      PreToolUse: [{ hooks: [{ type: "command", command: "echo keep" }] }],
    },
  });
  editHooks(path, "node '/meter/bin/htm.js' hook");
  editHooks(path, "node '/meter/bin/htm.js' hook");
  let doc = JSON.parse(readFileSync(path));
  assert.equal(doc.hooks.Stop.length, 2);
  assert.equal(doc.theme, "dark");
  assert.equal(doc.hooks.PreToolUse.length, 1);
  editHooks(path, "node '/meter/bin/htm.js' hook", true);
  doc = JSON.parse(readFileSync(path));
  assert.equal(doc.hooks.Stop.length, 1);
  assert.equal(doc.hooks.Stop[0].hooks[0].command, "echo existing");
  assert.equal(doc.hooks.SubagentStop, undefined);
});
test("Outbox survives a network failure and discards no acknowledged concurrent updates", async (t) => {
  const home = temp(t);
  atomicJSON(join(home, "participant.json"), {
    server: "http://127.0.0.1:1",
    team: "Team",
    key: "x".repeat(40),
    project: home,
    since: new Date().toISOString(),
  });
  enqueue(home, [event()]);
  await assert.rejects(flush(home));
  assert.equal(preview(home).events.length, 1);
  enqueue(home, [{ ...event(), outputTokens: 40 }]);
  assert.equal(preview(home).events[0].outputTokens, 40);
  assert.equal(status(home).pending, 1);
});
test("Transcript scope/root restrictions, private-field stripping and partial line recovery", async (t) => {
  const root = temp(t),
    logs = join(root, "logs"),
    project = join(root, "project");
  mkdirSync(logs);
  mkdirSync(project);
  const path = join(logs, "session.jsonl");
  const row = {
    type: "assistant",
    cwd: project,
    timestamp: new Date().toISOString(),
    message: {
      id: "message-1",
      usage: { input_tokens: 100, output_tokens: 20 },
      content: "SECRET-CODE",
    },
  };
  writeFileSync(path, JSON.stringify(row) + '\n{"partial":');
  const c = {
    salt: "salt",
    project,
    since: "2020-01-01T00:00:00.000Z",
    claudeRoots: [logs],
    codexRoots: [logs],
  };
  const result = await parseFile(path, "claude", c);
  assert.equal(result.events.length, 1);
  assert.ok(!JSON.stringify(result.events).includes("SECRET"));
  assert.equal(
    (await parseFile(path, "claude", { ...c, project: join(root, "other") }))
      .events.length,
    0,
  );
  await assert.rejects(
    parseFile(path, "claude", { ...c, claudeRoots: [project] }),
  );
});
test("Directory aliases work while transcript symlinks cannot escape approved roots", async (t) => {
  const root = temp(t), logs = join(root, "logs"), project = join(root, "project");
  const external = join(root, "external"), alias = join(root, "alias");
  for (const path of [logs, project, external]) mkdirSync(path);
  symlinkSync(root, alias, "junction");
  const row = JSON.stringify({
    type: "assistant", cwd: join(alias, "project"), timestamp: new Date().toISOString(),
    message: { id: "alias", usage: { input_tokens: 10, output_tokens: 2 } },
  }) + "\n";
  writeFileSync(join(logs, "session.jsonl"), row);
  writeFileSync(join(external, "outside.jsonl"), row);
  symlinkSync(external, join(logs, "escape"), "junction");
  const c = { salt: "salt", project, since: "2020-01-01T00:00:00.000Z", claudeRoots: [join(alias, "logs")] };
  assert.equal((await parseFile(join(logs, "session.jsonl"), "claude", c)).events.length, 1);
  await assert.rejects(parseFile(join(logs, "escape", "outside.jsonl"), "claude", c), /outside the permitted/);
});
test("Real hook -> durable outbox -> HTTP -> server -> dashboard totals, including subagents", async (t) => {
  const root = temp(t),
    home = join(root, "client"),
    logs = join(root, "logs"),
    project = join(root, "project");
  mkdirSync(logs);
  mkdirSync(project);
  const admin = "a".repeat(40),
    view = "v".repeat(40);
  const server = createApp({
    databasePath: ":memory:",
    adminKey: admin,
    viewKey: view,
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((r) => server.close(r)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const team = await fetch(origin + "/api/admin/teams", {
    method: "POST",
    headers: {
      authorization: `Bearer ${admin}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ name: "Integration" }),
  }).then((r) => r.json());
  atomicJSON(join(home, "participant.json"), {
    server: origin,
    key: team.key,
    team: "Integration",
    project,
    since: "2020-01-01T00:00:00.000Z",
    salt: "salt",
    claudeRoots: [logs],
    codexRoots: [logs],
  });
  const main = join(logs, "main.jsonl"),
    sub = join(logs, "sub.jsonl"),
    codex = join(logs, "codex.jsonl");
  const timestamp = new Date().toISOString();
  const row = (id) => ({
    type: "assistant",
    timestamp,
    cwd: project,
    message: {
      id,
      usage: { input_tokens: 100, output_tokens: 20 },
      content: "PRIVATE",
    },
  });
  writeFileSync(main, JSON.stringify(row("main")) + "\n");
  writeFileSync(sub, JSON.stringify(row("sub")) + "\n");
  writeFileSync(
    codex,
    JSON.stringify({ type: "session_meta", payload: { cwd: project } }) +
      "\n" +
      JSON.stringify({
        timestamp,
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: {
              input_tokens: 500,
              output_tokens: 60,
              cached_input_tokens: 50,
            },
          },
        },
      }) +
      "\n",
  );
  await hook("claude", { cwd: project, transcript_path: main }, home);
  await hook(
    "claude",
    { cwd: project, transcript_path: main, agent_transcript_path: sub },
    home,
  );
  await hook("codex", { cwd: project, transcript_path: codex }, home);
  await hook("codex", { cwd: project, transcript_path: codex }, home);
  const summary = await fetch(origin + "/api/summary", {
    headers: { authorization: `Bearer ${view}` },
  }).then((r) => r.json());
  assert.equal(summary.totals.inputTokens, 700);
  assert.equal(summary.totals.outputTokens, 100);
  assert.equal(summary.totals.sessions, 3);
  assert.equal(status(home).pending, 0);
  assert.ok(status(home).codexLastHook);
});
test("Hook process is fail-open and never outputs a blocking decision", (t) => {
  const root = temp(t);
  const run = spawnSync(
    process.execPath,
    ["bin/htm.js", "hook", "--provider", "claude", "--home", root],
    { input: '{"invalid":', encoding: "utf8" },
  );
  assert.equal(run.status, 0);
  assert.equal(run.stdout, "");
});
