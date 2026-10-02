# Security model

The collector is an ordinary local process with the participant's file permissions. It is auditable JavaScript with zero runtime dependencies and no package install scripts. A participant can pin and inspect a commit before installing. This is risk reduction, not a sandbox or an independent security audit.

## Boundaries

- HTTPS required off loopback; insecure LAN transport requires explicit opt-in. Redirects are rejected, so credentials cannot silently follow a moved endpoint.
- Independent random 256-bit team write credentials, organizer key, and read-only viewer key.
- Team identity bound to credential server-side; supplied names cannot impersonate another team.
- SHA-256 team-key storage; organizer/view comparisons use fixed-size constant-time digest comparison.
- Strict payload allowlist, integer limits, body/batch limits, prepared SQL, transaction-level batch validation, rate limits, and idempotent maximum-count updates.
- No eval, remote commands, remote hooks, provider-key reading, access-token introspection, or third-party scripts.
- Browser renders names through `textContent`; CSV fields are quoted and formula-prefixed text escaped. CSP disables third-party scripts and framing.
- Durable outbox survives network failures. Acknowledgements only mark the exact sent version of a record; concurrent increases remain queued.
- Hook failures exit successfully and never output a stop/block decision. `htm status` reports local diagnostics. `SessionEnd` can be killed by a client's short timeout; use `htm sync` or `htm watch` after interruptions.
- Kubernetes: one unprivileged replica, read-only root filesystem/source, dropped capabilities, no service-account token, explicit resource limits, PVC preserved on app removal.

## Limits

Participants can edit their own logs or fabricate counters with their own team key. This tool is not a billing source, identity system, or anti-cheat solution. A stolen team key can inflate that team's metrics until revoked. Protect keys and rotate after an event.

An organizer key controls all teams. Display only the read-only key on shared/projector devices. Everyone with that key can see team-level data. Keep the server secret file and SQLite volume private and backed up. Do not expose the raw development server over remote HTTP.

The on-disk agent log format is not a stable provider API. Unknown records are skipped and diagnostics show unsupported usage. Missing events, log rotation/truncation, counter resets, clock skew, copied/forked transcripts, or changed provider schemas can cause under/overcounts. Do a short test with the exact client versions before your event. Both API-key and subscription-based CLI sessions are supported only insofar as they write the expected usage records.

Use a dedicated event data directory and preserve each participant's collector identity throughout the event. Do not run two enrollments over the same logs; they have different salts. The fallback watcher performs a bounded full-file scan and is intended for hackathon-scale logs, not indefinite monitoring.

For vulnerability reports, contact the repository owner privately through their GitHub profile. Do not put credentials, participant logs or exploitable deployment details into a public issue.
