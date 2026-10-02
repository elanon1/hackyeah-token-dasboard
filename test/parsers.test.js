import test from "node:test";
import assert from "node:assert/strict";
import { createParser } from "../src/parsers.js";
import { endpoint, validateEvent, inside } from "../src/common.js";

const before = "2026-01-01T09:00:00.000Z",
  since = "2026-01-01T10:00:00.000Z",
  after = "2026-01-01T11:00:00.000Z";
const options = {
  salt: "test-only-salt",
  source: "/agent/session.jsonl",
  since,
};
const claude = (id, input, output, time = after) => ({
  type: "assistant",
  timestamp: time,
  cwd: "/hackathon",
  requestId: "req-private",
  message: {
    id,
    content: [{ type: "text", text: "TOP_SECRET_SOURCE_CODE" }],
    usage: {
      input_tokens: input,
      output_tokens: output,
      cache_read_input_tokens: 40,
      cache_creation_input_tokens: 10,
    },
  },
});
const codex = (input, output, cached, time = after) => ({
  timestamp: time,
  type: "event_msg",
  payload: {
    type: "token_count",
    info: {
      total_token_usage: {
        input_tokens: input,
        output_tokens: output,
        cached_input_tokens: cached,
        reasoning_output_tokens: 10,
      },
      last_token_usage: { input_tokens: 99999999 },
    },
  },
});
test("Claude: cache included once, streamed duplicates updated, private text excluded", () => {
  const p = createParser("claude", options);
  p.add(claude("old", 500, 100, before));
  p.add(claude("new", 100, 0));
  p.add(claude("new", 100, 25));
  p.add(claude("new", 100, 25));
  const { events } = p.result();
  assert.equal(events.length, 1);
  assert.equal(events[0].inputTokens, 150);
  assert.equal(events[0].outputTokens, 25);
  assert.equal(events[0].cacheReadTokens, 40);
  assert.ok(!JSON.stringify(events).includes("TOP_SECRET"));
  assert.ok(!JSON.stringify(events).includes("/agent"));
  validateEvent(events[0]);
});
test("Codex: cumulative deltas, baseline exclusion, duplicate/rate-limit/stale notifications", () => {
  const p = createParser("codex", options);
  p.add(codex(1000, 100, 400, before));
  p.add(codex(1100, 150, 420));
  p.add(codex(1100, 150, 420));
  p.add(codex(1050, 120, 410));
  p.add({ type: "event_msg", payload: { type: "token_count", info: null } });
  p.add(codex(1250, 180, 440, "2026-01-01T12:00:00.000Z"));
  const { events } = p.result();
  assert.equal(events.length, 2);
  assert.equal(
    events.reduce((s, e) => s + e.inputTokens, 0),
    250,
  );
  assert.equal(
    events.reduce((s, e) => s + e.outputTokens, 0),
    80,
  );
  assert.equal(
    events.reduce((s, e) => s + e.cacheReadTokens, 0),
    40,
  );
});
test("Codex: reasoning output is not added twice", () => {
  const p = createParser("codex", options);
  p.add(codex(100, 30, 20));
  assert.equal(p.result().events[0].outputTokens, 30);
});
test("No historical import and no paused-period import for either adapter", () => {
  const opts = {
    ...options,
    exclusions: [[after, "2026-01-01T12:00:00.000Z"]],
  };
  const a = createParser("claude", opts);
  a.add(claude("a", 100, 10));
  assert.equal(a.result().events.length, 0);
  const c = createParser("codex", opts);
  c.add(codex(100, 10, 20));
  c.add(codex(130, 15, 25, "2026-01-01T12:30:00.000Z"));
  assert.equal(c.result().events[0].inputTokens, 30);
});
test("Unknown and malformed schemas fail closed", () => {
  const p = createParser("codex", options);
  p.add(codex(-100, 10, 0));
  p.add({ type: "message", tokens: 999 });
  assert.equal(p.result().events.length, 0);
  assert.equal(p.result().malformed, 1);
});
test("Transport rejects credentials, paths, insecure remote HTTP and malformed payloads", () => {
  assert.throws(() => endpoint("http://example.com"));
  assert.throws(() => endpoint("https://user:pass@example.com"));
  assert.throws(() => endpoint("https://example.com/private"));
  assert.equal(endpoint("http://localhost:4318"), "http://localhost:4318");
  const p = createParser("claude", options);
  p.add(claude("safe", 10, 20));
  const e = p.result().events[0];
  assert.throws(() => validateEvent({ ...e, prompt: "secret" }));
  assert.throws(() => validateEvent({ ...e, inputTokens: 0 }));
  assert.throws(() => validateEvent({ ...e, outputTokens: NaN }));
});
