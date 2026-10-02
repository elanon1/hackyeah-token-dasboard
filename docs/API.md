# HTTP API

Base URL: your server origin. Use TLS off loopback. Authentication: `Authorization: Bearer <key>`. JSON requests have `Content-Type: application/json`. Keys are never URL parameters.

| Endpoint                           | Key                 | Behavior                                         |
| ---------------------------------- | ------------------- | ------------------------------------------------ |
| `GET /api/health`                  | None                | Version, deployment source revision, demo flag   |
| `GET /api/summary?provider=all`    | Viewer or organizer | Team totals and last-24-hour time buckets        |
| `POST /api/verify`                 | Team                | Verify `{ "team": "Exact Team Name" }`           |
| `POST /api/events`                 | Team                | Validate and store a batch of counter records    |
| `POST /api/admin/teams`            | Organizer           | Create `{ "name": "My Team" }`, returns key once |
| `POST /api/admin/teams/:id/rotate` | Organizer           | Return replacement team key once                 |
| `POST /api/admin/teams/:id/status` | Organizer           | Set `{ "active": false }` to pause writes        |

Supported filters: `all`, `claude`, `codex`, `manual`. Team names are normalized NFKC at creation, 1–64 characters, case-sensitive. The matching name is supplied on enrollment and every report.

Event payload:

```json
{
  "team": "My Team",
  "events": [
    {
      "id": "64-character lowercase hex HMAC",
      "session": "64-character lowercase hex HMAC",
      "provider": "claude",
      "inputTokens": 1200,
      "outputTokens": 350,
      "cacheReadTokens": 300,
      "cacheWriteTokens": 100,
      "occurredAt": "2026-10-02T12:00:00.000Z"
    }
  ]
}
```

IDs in the example are descriptive placeholders, not valid IDs. Use `reportUsage` or `htm report` to generate valid reports. `id` must remain stable for the same provider event, including retries. Counters for an existing ID are absolute maxima, not increments. Distinct events require distinct IDs. The server's primary key is `(team_id, id)`; a second team cannot overwrite the first.

1–100 events per batch, maximum body 64 KiB. Counts must be nonnegative safe integers no larger than 10^12. Cache reads + writes cannot exceed input. Unknown fields, fractional/negative/overflow counts and timestamps more than five minutes in the future are rejected. A malformed event rejects the entire batch; valid neighbors are not partially applied.

200 acknowledges the submitted batch, including already-stored records. Retry the identical batch after transient failures; do not invent new IDs. 401/403 require fixing credentials/team binding; 429 should be retried after `Retry-After`. Hooks keep queued reports until an acknowledgement. Read responses never contain team keys or raw transcript IDs.
