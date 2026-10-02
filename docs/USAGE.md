# HackYeah Token Dashboard

Privacy-first token scoreboard for **Claude Code and Codex CLI**. A dependency-free npm package, opt-in local collector, authenticated API, SQLite storage, and a responsive live dashboard.

**Project:** https://github.com/elanon1/hackyeah-token-dasboard  
**Deployment target:** https://hackyeah.elcloud.pl  
**GitOps:** `elanon1/argocd`, `gitops/apps/hackyeah-token-dashboard`.

## What it does

- Tracks team input/output tokens, with cache reads/writes shown separately (already included in input).
- Installs async `Stop` and `SubagentStop` hooks for **both** Claude Code and Codex; `SessionEnd` is a final bounded attempt.
- Includes a foreground watcher for older clients or missed hooks, and an API/SDK for manual counters.
- Deduplicates replayed usage locally and on the server. An offline outbox retries safely.
- Limits collection to a selected project and records timestamped after enrollment. No historical import by default.
- Shows live team totals, tool filters, a 24-hour chart, CSV export and a projector view.
- Gives the organizer team creation, key rotation and pause controls. Viewer keys cannot write. Team keys cannot read the dashboard or write for another team.

This reports usage **present in local logs**, not a provider bill or tamper-proof competition score. Missing telemetry (including provider-internal/compaction usage omitted from logs) cannot be recovered. See [compatibility](COMPATIBILITY.md).

## Participant: one command

Requires **Node.js 22.13+** (Node 24 LTS recommended). Obtain a team name and team key from the organizer. In your hackathon project:

```sh
npx --yes --package=https://github.com/elanon1/hackyeah-token-dasboard/archive/refs/heads/main.tar.gz htm join --server https://hackyeah.elcloud.pl --team "My Team"
```

Read the collection notice, opt in, and paste the team key at the **hidden prompt**. The key does not go into your shell history. The organizer's dashboard generates the same command pinned to the deployed commit; prefer that command over `main`.

**Restart both coding tools. In Codex, open `/hooks` and review/trust the new hook definitions.** Do not disable Codex's trust checks. Run a turn in each tool, then check `htm status`.

The command copies a small self-contained runtime to `~/.config/hackathon-token-meter/runtime`, so hooks keep working when the temporary npx cache is cleaned. It merges existing hook settings and makes private backups. It does **not** install a background daemon, proxy your AI requests, change approvals, or need OpenAI/Anthropic credentials.

For convenient subsequent commands, install the package once:

```sh
npm install -g --ignore-scripts https://github.com/elanon1/hackyeah-token-dasboard/archive/refs/heads/main.tar.gz
htm status
htm sync --dry-run   # See the exact outgoing counters. No HTTP request.
htm sync             # Recover missed usage and send one batch.
htm watch            # Foreground fallback for both tools; Ctrl+C stops it.
htm pause
htm resume
htm uninstall        # Remove only this project's hooks; pause collection.
```

Native Windows: use `htm watch`, or install/run inside WSL for hooks. Server and SDK are cross-platform. `--project /path/to/hackathon` changes the scope. `CLAUDE_CONFIG_DIR`, `CODEX_HOME` and `HTM_HOME` are honored. One enrollment tracks one server/team; do not enroll the same log files twice under different homes.

After a key rotation: `htm rekey`. Queue identity is preserved. Use `--key-stdin --yes` for noninteractive enrollment, with a secret manager supplying stdin (never a key in the command line). Plain HTTP is allowed only on loopback unless the participant explicitly chooses `--allow-http` for a trusted LAN.

## Organizer: local server

```sh
git clone https://github.com/elanon1/hackyeah-token-dasboard.git
cd hackyeah-token-dasboard
npm ci --ignore-scripts
npm start
```

Open http://localhost:4318. The first start creates `.htm-data/server-secrets.json` with separate organizer and read-only view keys. Read that file locally and paste the organizer key into the dashboard. Never commit it.

1. Open **Organizer**, create a team, and give that team its one-time displayed key and generated install command.
2. Give the separate `viewKey` to the presentation computer. It cannot manage teams or submit usage.
3. Watch totals update every five seconds. Use **Projector view** or **Export CSV**.

`npm run demo` starts an explicitly labelled, read-only demonstration with synthetic data. Real servers always start empty. For containers: `docker compose up -d --build`. Read keys with `docker compose exec meter cat /data/server-secrets.json`. HTTPS must be provided by your reverse proxy for remote participants.

## Kubernetes / Argo CD

Deployment definitions live in the separate private `argocd` repo. They use your Traefik ingress and `letsencrypt-dns` issuer for `hackyeah.elcloud.pl`. One replica and `Recreate` strategy protect the SQLite volume. Keys are generated on the persistent volume; no secrets are committed.

```sh
kubectl -n hackyeah get pods,pvc,ingress
kubectl -n hackyeah exec deployment/hackyeah-token-dashboard -- cat /data/server-secrets.json
```

Keep the output private. Log in with `adminKey`; use `viewKey` on the projector. A deployment commit is not proof of cluster health: check the Argo application, pod readiness, certificate and `/api/health`.

Source files are mounted read-only from an immutable, content-addressed ConfigMap into the **digest-pinned official Node image**. This small, dependency-free app needs no custom registry credentials, package installation, runtime source download or build in the cluster. The manifest includes the source commit and checksum. [Deployment details](DEPLOYMENT.md).

## Send explicit counts

```sh
htm report --in 1200 --out 350 --id unique-request-123
```

`--id` must be stable for retries and unique for distinct requests. Repeated reports update the maximum counters for that event; they do not sum twice.

```js
import { reportUsage } from "hackathon-token-meter";
await reportUsage({
  server: "https://hackyeah.elcloud.pl",
  team: "My Team",
  teamKey: process.env.HTM_TEAM_KEY,
  eventId: "request-123",
  inputTokens: 1200,
  outputTokens: 350,
});
```

The module name applies after installing this package (from GitHub or an npm tarball). SDK callers own retry persistence. [HTTP API](API.md).

## Privacy and trust

Only team name, provider, counters, timestamps and anonymous deduplication/session hashes leave the machine. Local transcripts **can contain prompts and code**; parsing and filtering happen locally. There is no third-party analytics, CDN, external font, postinstall script or runtime npm dependency. Source and tests are inspectable.

Read [PRIVACY.md](../PRIVACY.md) and [SECURITY.md](../SECURITY.md) before the event. This is self-reported telemetry, not anti-cheat: someone who owns a team key can fabricate that team's counts. It must not determine prizes without independent verification.

## Development and npm release

```sh
npm run check
npm test
npm pack --ignore-scripts
```

Tests cover both log adapters, scope boundaries, payload privacy, subagents, replay/concurrency, paused-period exclusion, offline queue durability, key authorization/rotation, and API-to-dashboard totals. CI runs Node 22/24 on Linux/macOS/Windows. The `test/` fixtures are synthetic; no private conversations are checked in.

The package is ready to install from GitHub immediately after this repository is populated. **Publishing to npm is a separate operation requiring ownership of the npm package name and an authorized npm account.** No registry publication is assumed. A manual Trusted Publishing workflow is provided; configure the npm package and GitHub `npm` environment before running it. Pin the commit or verify the tarball checksum for event-wide installs.

MIT licensed.
