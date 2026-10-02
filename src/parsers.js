// Local-only adapters. Never forward a transcript object or user-controlled text.
import { fingerprint, number } from "./common.js";

const zero = () => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
});
function counter(u, field) {
  const v = u[field] ?? 0;
  if (!number(v)) throw new Error("Unsupported usage counter");
  return v;
}
const max = (a, b) =>
  Object.fromEntries(Object.keys(a).map((k) => [k, Math.max(a[k], b[k])]));
export function createParser(
  provider,
  { salt, source, since, exclusions = [] },
) {
  if (!["claude", "codex"].includes(provider))
    throw new Error("Unsupported provider");
  const session = fingerprint(salt, provider, source);
  const events = new Map();
  let previous = zero();
  let recognized = 0;
  let malformed = 0;
  let cwd;
  const cutoff = Date.parse(since);
  const included = (time) =>
    Number.isFinite(time) &&
    time >= cutoff &&
    !exclusions.some(
      ([start, end]) => time >= Date.parse(start) && time < Date.parse(end),
    );
  return {
    add(row) {
      if (row.type === "session_meta" && typeof row.payload?.cwd === "string")
        cwd = row.payload.cwd;
      if (provider === "claude" && typeof row.cwd === "string") cwd = row.cwd;
      try {
        const time = Date.parse(row.timestamp);
        if (provider === "claude") {
          const u = row.type === "assistant" && row.message?.usage;
          if (!u || typeof row.message.id !== "string") return;
          recognized++;
          if (!included(time)) return;
          const counts = {
            inputTokens:
              counter(u, "input_tokens") +
              counter(u, "cache_read_input_tokens") +
              counter(u, "cache_creation_input_tokens"),
            outputTokens: counter(u, "output_tokens"),
            cacheReadTokens: counter(u, "cache_read_input_tokens"),
            cacheWriteTokens: counter(u, "cache_creation_input_tokens"),
          };
          if (!Object.values(counts).every(number))
            throw new Error("Counter overflow");
          // A message can be serialized more than once as its streaming usage grows.
          const id = fingerprint(salt, provider, row.message.id);
          const old = events.get(id);
          events.set(id, {
            id,
            session,
            provider,
            ...(old
              ? max(
                  Object.fromEntries(
                    Object.keys(counts).map((k) => [k, old[k]]),
                  ),
                  counts,
                )
              : counts),
            occurredAt: old?.occurredAt || new Date(time).toISOString(),
          });
        } else {
          if (row.type !== "event_msg" || row.payload?.type !== "token_count")
            return;
          const u = row.payload.info?.total_token_usage;
          if (!u) return; // Rate-limit-only notification; never infer zero usage.
          recognized++;
          const current = {
            inputTokens: counter(u, "input_tokens"),
            outputTokens: counter(u, "output_tokens"),
            cacheReadTokens: counter(u, "cached_input_tokens"),
            cacheWriteTokens: 0,
          };
          if (current.cacheReadTokens > current.inputTokens)
            throw new Error("Invalid cache count");
          // Cumulative counters are high-water marks. Repeated/stale notifications add zero.
          const peak = max(previous, current);
          const delta = Object.fromEntries(
            Object.keys(current).map((k) => [k, peak[k] - previous[k]]),
          );
          previous = peak;
          if (!included(time) || !Object.values(delta).some(Boolean)) return;
          // Per-cumulative-position identity survives replays and concurrent hooks.
          const id = fingerprint(salt, provider, source, peak);
          events.set(id, {
            id,
            session,
            provider,
            ...delta,
            occurredAt: new Date(time).toISOString(),
          });
        }
      } catch {
        malformed++;
      }
    },
    result() {
      return { events: [...events.values()], recognized, malformed, cwd };
    },
  };
}
