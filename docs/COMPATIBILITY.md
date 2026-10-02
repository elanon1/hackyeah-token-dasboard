# Claude Code and Codex compatibility

## Claude Code

User settings: `${CLAUDE_CONFIG_DIR:-~/.claude}/settings.json`.

Installed events: `Stop`, `SubagentStop`, `SessionEnd`. Subagent collection uses `agent_transcript_path`, which points to the child log rather than the parent's transcript. The adapter accepts assistant messages with `message.id` and `message.usage` and takes the maximum observed usage for repeated/streamed versions of the same message.

Input = `input_tokens + cache_read_input_tokens + cache_creation_input_tokens`. Output = `output_tokens`. Cache columns are subsets of input, not additions to totals.

## Codex CLI

User hooks: `${CODEX_HOME:-~/.codex}/hooks.json`. The installer merges this JSON file and never rewrites `config.toml`, `notify`, sandbox settings, or permission rules.

Restart Codex, run `/hooks`, inspect and trust the exact installed hooks. Recent Codex releases support these hooks; for versions without them, use `htm watch`. Native Windows users can use the watcher or WSL hooks.

The adapter recognizes JSONL `event_msg` / `token_count` entries with `payload.info.total_token_usage`. It computes monotonic differences, excluding the baseline before enrollment. Repeated/stale cumulative notifications add zero. Rate-limit notifications with `info: null` are ignored. `last_token_usage` is not summed because it is not a cumulative session counter.

Input = `input_tokens`, with `cached_input_tokens` already included. Output = `output_tokens`; reasoning tokens are not added again. Counter resets are not guessed at. Local session files are scanned under `$CODEX_HOME/sessions`.

## Verification boundaries

The automated test suite uses synthetic records matching these schemas and exercises actual hook processing, network submission, SQLite persistence and dashboard aggregation. It does **not** sign in to a real Claude or Codex account, spend tokens, or certify an exact installed client release. Before the event, complete a short turn in both real tools, inspect `htm status` and `htm sync --dry-run`, and confirm the dashboard increase. Restart tools after installing hooks. Check diagnostics when a provider updates.

This integrates **Claude Code and Codex CLI**, not the ChatGPT or Claude web applications. Log files can omit billable provider-internal work; no estimate is substituted for missing data. Interrupted/unfinished subagents without a final usage record may not be counted. Local hooks are best effort, with an explicit watcher/scan fallback.

Official references (checked 2026-10-02):

- https://code.claude.com/docs/en/hooks
- https://learn.chatgpt.com/docs/hooks
- https://developers.openai.com/codex/config-reference/
- https://github.com/openai/codex (rollout protocol/source; verify against your installed version)
