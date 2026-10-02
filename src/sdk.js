import { key, fingerprint, endpoint, validateEvent } from "./common.js";
export async function reportUsage({
  server,
  team,
  teamKey,
  eventId,
  sessionId = "manual",
  inputTokens,
  outputTokens,
  provider = "manual",
  occurredAt = new Date().toISOString(),
}) {
  if (!eventId) throw new Error("eventId is required for idempotency.");
  const e = validateEvent({
    id: fingerprint(teamKey, "sdk", eventId),
    session: fingerprint(teamKey, "sdk-session", sessionId),
    provider,
    inputTokens,
    outputTokens,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    occurredAt,
  });
  const res = await fetch(`${endpoint(server)}/api/events`, {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(5000),
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${teamKey}`,
    },
    body: JSON.stringify({ team, events: [e] }),
  });
  if (!res.ok) throw new Error(`Usage report failed (${res.status})`);
  return res.json();
}
