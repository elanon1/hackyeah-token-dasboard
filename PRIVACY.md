# Privacy: what leaves a participant's computer

Collection is opt-in. The join command describes the destination and scope, then asks for consent before writing settings or reading session logs. Enrollment verifies a team key against the organizer's server.

## Fixed allowlist

Each report contains `team` and an array of records with exactly:

- `provider`: `claude`, `codex`, or explicitly reported `manual`.
- `inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheWriteTokens`.
- `occurredAt`: the local log record's timestamp.
- `id` and `session`: HMAC-SHA-256 hashes used to deduplicate and count sessions.

No prompt, answer, tool argument, source code, model response text, filename, directory, email, OS username, hostname, provider credential, or raw session identifier is uploaded. The server rejects extra event fields. The team name is intentionally visible to the organizer and authorized dashboard viewers.

## Local access

Hooks receive a local JSON event which may itself contain private text. They use only `cwd`, `transcript_path`, and `agent_transcript_path` and then discard the event. Only `.jsonl` paths under the configured agent log directories are accepted. Symlink escapes are resolved and rejected. The selected project must match the hook's working directory.

The optional watcher enumerates the local agent log directories and parses records to discover their working directory. Unrelated projects are discarded locally. A hook can use its supplied working directory for subagent transcripts that omit that metadata. No remote server can request files or execute commands through the collector.

Claude usage messages and Codex cumulative token counters are converted into anonymous counter-only records. Historical usage before enrollment is excluded. Paused intervals are excluded by record timestamps after resuming; an in-flight turn whose counters arrive after resume can contain work started during the pause. Stop both coding tools if an exact privacy cutoff is necessary.

The collector stores its team credential, endpoint, project path, random identity salt and settings locally with private file permissions, plus an SQLite counter-only outbox. The hook installer copies its runtime into the same private directory and backs up hook settings. It preserves unrelated hooks. These backups may contain your existing private configuration; their mode is restricted to `0600` on POSIX.

## Stop and remove

`htm pause` stops further collection. `htm uninstall` removes only the registered commands and pauses the collector. Stop `htm watch` with Ctrl+C. Configuration and queued records remain locally for deliberate recovery; after uninstalling, remove the collector directory if you want to erase them. Ask the organizer to revoke your team's key and erase server data if needed. Previously sent data is not remotely deleted by uninstalling.

## Server and retention

The organizer self-hosts the server and controls its SQLite database and backups. There is no telemetry sent to the project author. Network infrastructure may observe IP addresses and request times. This app does not persist IP addresses or log request bodies/authorization headers. Reverse proxies must be configured not to log authorization headers. Each process keeps a bounded in-memory rate-limit map.

Dashboard keys stay in page memory and are cleared on reload; they are not saved to cookies, browser storage, query strings, or analytics. Team keys are stored hashed on the server and displayed once at creation/rotation. Organizer/view keys live in a private file on the server's persistent disk or can be supplied through environment variables. The Montserrat font is bundled locally under its open-source license; the browser does not contact Google Fonts.

Default server retention is until the organizer deletes or archives the event database. Decide and communicate an event retention period; do not promise automatic deletion. To erase all event data, stop the server and remove its SQLite database and WAL/SHM files (and any backups), then restart. Keep or rotate server keys deliberately.
