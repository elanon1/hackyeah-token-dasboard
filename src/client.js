import {
  createReadStream,
  readFileSync,
  statSync,
  realpathSync,
  readdirSync,
  existsSync,
  copyFileSync,
  cpSync,
  unlinkSync,
  chmodSync,
} from "node:fs";
import { join, resolve, dirname } from "node:path";
import { homedir } from "node:os";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import {
  atomicJSON,
  readJSON,
  privateDir,
  inside,
  endpoint,
  key,
  fingerprint,
  validateEvent,
} from "./common.js";
import { database, transaction } from "./database.js";
import { createParser } from "./parsers.js";

export const clientHome = () =>
  process.env.HTM_HOME || join(homedir(), ".config", "hackathon-token-meter");
export function config(home = clientHome()) {
  return readJSON(join(home, "participant.json"));
}
function withinDirectory(root, path) {
  try {
    return inside(realpathSync(root), realpathSync(path));
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return false;
    throw error;
  }
}
function clientDB(home) {
  const db = database(join(home, "outbox.sqlite"));
  db.exec(`CREATE TABLE IF NOT EXISTS outbox(id TEXT PRIMARY KEY,payload TEXT NOT NULL,sent TEXT);
    CREATE TABLE IF NOT EXISTS status(id TEXT PRIMARY KEY,value TEXT NOT NULL);`);
  return db;
}
export async function post(c, path, payload) {
  const res = await fetch(`${endpoint(c.server, c.allowHTTP)}${path}`, {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(2500),
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${c.key}`,
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok)
    throw new Error(
      `Server returned ${res.status}. Check connectivity, team name and key; events remain queued.`,
    );
  return res.json();
}
export async function parseFile(
  path,
  provider,
  c,
  { requireScope = true } = {},
) {
  const real = realpathSync(path);
  const roots = provider === "claude" ? c.claudeRoots : c.codexRoots;
  if (!roots.some((root) => withinDirectory(root, real)))
    throw new Error("Transcript is outside the permitted agent directories.");
  const stat = statSync(real);
  if (!stat.isFile() || stat.size > 128 * 1024 * 1024)
    throw new Error(
      "Transcript is not a regular file or exceeds the 128 MiB safety limit.",
    );
  const parser = createParser(provider, {
    salt: c.salt,
    source: real,
    since: c.since,
    exclusions: c.exclusions,
  });
  const input = createReadStream(real, { encoding: "utf8" });
  const lines = createInterface({ input, crlfDelay: Infinity });
  const timer = setTimeout(
    () => input.destroy(new Error("Transcript scan timed out")),
    5000,
  );
  try {
    for await (const line of lines) {
      if (line.length > 8 * 1024 * 1024)
        throw new Error("Transcript line exceeds the safety limit.");
      try {
        parser.add(JSON.parse(line));
      } catch {
        /* Partial final JSONL writes are retried next time. */
      }
    }
  } finally {
    clearTimeout(timer);
    lines.close();
    input.destroy();
  }
  const result = parser.result();
  if (requireScope && (!result.cwd || !withinDirectory(c.project, result.cwd)))
    return { ...result, events: [], outOfScope: true };
  for (const e of result.events) validateEvent(e);
  return result;
}
export function enqueue(home, events) {
  const db = clientDB(home);
  try {
    transaction(db, () => {
      const get = db.prepare("SELECT payload FROM outbox WHERE id=?");
      const put = db.prepare(
        "INSERT INTO outbox(id,payload,sent) VALUES(?,?,NULL) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,sent=NULL WHERE outbox.payload<>excluded.payload",
      );
      for (const event of events) {
        validateEvent(event);
        const prior = get.get(event.id);
        let value = { ...event };
        if (prior) {
          const old = JSON.parse(prior.payload);
          for (const k of [
            "inputTokens",
            "outputTokens",
            "cacheReadTokens",
            "cacheWriteTokens",
          ])
            value[k] = Math.max(old[k], value[k]);
          value.occurredAt = old.occurredAt;
        }
        put.run(value.id, JSON.stringify(value));
      }
    });
  } finally {
    db.close();
  }
}
export async function flush(home = clientHome()) {
  const c = config(home);
  const db = clientDB(home);
  let count = 0;
  try {
    // One bounded batch per hook. Watch/flush can drain the rest without delaying the agent.
    const rows = db
      .prepare(
        "SELECT id,payload FROM outbox WHERE sent IS NULL ORDER BY id LIMIT 100",
      )
      .all();
    if (rows.length) {
      await post(c, "/api/events", {
        team: c.team,
        events: rows.map((r) => JSON.parse(r.payload)),
      });
      transaction(db, () => {
        const mark = db.prepare(
          "UPDATE outbox SET sent=? WHERE id=? AND payload=?",
        );
        for (const r of rows)
          mark.run(new Date().toISOString(), r.id, r.payload);
      });
      count = rows.length;
    }
    db.prepare(
      "INSERT INTO status VALUES('lastSync',?) ON CONFLICT(id) DO UPDATE SET value=excluded.value",
    ).run(new Date().toISOString());
    db.prepare("DELETE FROM status WHERE id='error'").run();
    return {
      sent: count,
      pending: db
        .prepare("SELECT COUNT(*) n FROM outbox WHERE sent IS NULL")
        .get().n,
    };
  } catch (e) {
    db.prepare(
      "INSERT INTO status VALUES('error',?) ON CONFLICT(id) DO UPDATE SET value=excluded.value",
    ).run(e.message);
    throw e;
  } finally {
    db.close();
  }
}
export function status(home = clientHome()) {
  const c = config(home);
  const db = clientDB(home);
  try {
    return {
      team: c.team,
      server: c.server,
      project: c.project,
      since: c.since,
      paused: !!c.paused,
      pending: db
        .prepare("SELECT COUNT(*) n FROM outbox WHERE sent IS NULL")
        .get().n,
      events: db.prepare("SELECT COUNT(*) n FROM outbox").get().n,
      ...Object.fromEntries(
        db
          .prepare("SELECT * FROM status")
          .all()
          .map((r) => [r.id, r.value]),
      ),
    };
  } finally {
    db.close();
  }
}
export function preview(home = clientHome()) {
  const c = config(home);
  const db = clientDB(home);
  try {
    return {
      team: c.team,
      events: db
        .prepare("SELECT payload FROM outbox WHERE sent IS NULL LIMIT 100")
        .all()
        .map((r) => JSON.parse(r.payload)),
    };
  } finally {
    db.close();
  }
}
export async function hook(provider, payload, home = clientHome()) {
  const c = config(home);
  if (c.paused) return;
  if (
    typeof payload.cwd !== "string" ||
    !withinDirectory(c.project, payload.cwd)
  )
    return;
  const path = payload.agent_transcript_path || payload.transcript_path;
  if (typeof path !== "string" || !path.endsWith(".jsonl")) return;
  // Hook cwd is authoritative when subagent logs omit cwd; roots still constrained.
  const result = await parseFile(path, provider, c, { requireScope: false });
  enqueue(home, result.events);
  const db = clientDB(home);
  try {
    db.prepare(
      "INSERT INTO status VALUES(?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value",
    ).run(`${provider}LastHook`, new Date().toISOString());
    db.prepare(
      "INSERT INTO status VALUES(?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value",
    ).run(
      `${provider}Parser`,
      result.recognized
        ? `${result.recognized} records; ${result.malformed} unsupported`
        : "No supported usage records yet",
    );
  } finally {
    db.close();
  }
  await flush(home);
}
function* files(root, depth = 0) {
  if (depth > 8 || !existsSync(root)) return;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const path = join(root, entry.name);
    if (entry.isDirectory()) yield* files(path, depth + 1);
    else if (entry.isFile() && entry.name.endsWith(".jsonl")) yield path;
  }
}
export async function sync(home = clientHome(), { dryRun = false } = {}) {
  const c = config(home);
  if (c.paused) return { paused: true };
  let count = 0;
  let unsupported = 0;
  for (const [provider, roots] of [
    ["claude", c.claudeRoots],
    ["codex", c.codexRoots],
  ])
    for (const root of roots)
      for (const path of files(root)) {
        if (statSync(path).mtimeMs < Date.parse(c.since)) continue;
        const r = await parseFile(path, provider, c);
        count += r.events.length;
        unsupported += r.malformed;
        enqueue(home, r.events);
      }
  return dryRun
    ? { ...preview(home), unsupported }
    : { scannedEvents: count, unsupported, ...(await flush(home)) };
}
function quote(s) {
  return `'${s.replaceAll("'", "'\\''")}'`;
}
export function hookEntries(c, home) {
  const node = process.execPath;
  const script = join(home, "runtime", "bin", "htm.js");
  return ["claude", "codex"].map((provider) => ({
    provider,
    path:
      provider === "claude"
        ? join(c.claudeConfig, "settings.json")
        : join(c.codexConfig, "hooks.json"),
    command: `${quote(node)} --disable-warning=ExperimentalWarning ${quote(script)} hook --provider ${provider} --home ${quote(home)}`,
  }));
}
export function editHooks(path, command, remove = false) {
  const document = readJSON(path, {});
  if (
    document.hooks &&
    (typeof document.hooks !== "object" || Array.isArray(document.hooks))
  )
    throw new Error("Unrecognized hooks configuration; no changes made.");
  document.hooks ||= {};
  for (const event of ["Stop", "SubagentStop", "SessionEnd"]) {
    const groups = document.hooks[event] || [];
    if (!Array.isArray(groups) || groups.some((g) => !Array.isArray(g.hooks)))
      throw new Error("Unrecognized hooks configuration; no changes made.");
    const cleaned = groups
      .map((group) => ({
        ...group,
        hooks: group.hooks.filter((h) => h.command !== command),
      }))
      .filter((g) => g.hooks.length);
    if (!remove)
      cleaned.push({
        hooks: [
          {
            type: "command",
            command,
            timeout: event === "SessionEnd" ? 3 : 15,
            ...(event === "SessionEnd" ? {} : { async: true }),
          },
        ],
      });
    if (cleaned.length) document.hooks[event] = cleaned;
    else delete document.hooks[event];
  }
  if (existsSync(path)) {
    const backup = `${path}.htm-backup-${Date.now()}`;
    copyFileSync(path, backup);
    chmodSync(backup, 0o600);
  }
  atomicJSON(path, document);
}
export function install(home = clientHome()) {
  const c = config(home);
  privateDir(join(home, "runtime"));
  const root = fileURLToPath(new URL("../", import.meta.url));
  for (const dir of ["bin", "src"])
    cpSync(join(root, dir), join(home, "runtime", dir), { recursive: true });
  copyFileSync(
    join(root, "package.json"),
    join(home, "runtime", "package.json"),
  );
  const entries = hookEntries(c, home);
  // Preflight both documents before writing either one.
  for (const e of entries) {
    const d = readJSON(e.path, {});
    if (d.hooks && (typeof d.hooks !== "object" || Array.isArray(d.hooks)))
      throw new Error("Invalid hooks configuration");
    for (const event of ["Stop", "SubagentStop", "SessionEnd"])
      if (
        d.hooks?.[event] &&
        (!Array.isArray(d.hooks[event]) ||
          d.hooks[event].some((g) => !Array.isArray(g.hooks)))
      )
        throw new Error("Invalid hook group");
  }
  for (const e of entries) editHooks(e.path, e.command);
  atomicJSON(join(home, "installed-hooks.json"), entries);
  return entries.map((e) => e.path);
}
export function uninstall(home = clientHome()) {
  const entries = readJSON(join(home, "installed-hooks.json"), []);
  for (const e of entries)
    if (existsSync(e.path)) editHooks(e.path, e.command, true);
  if (existsSync(join(home, "installed-hooks.json")))
    unlinkSync(join(home, "installed-hooks.json"));
  setPaused(home, true);
}
export function setPaused(home, paused) {
  const c = config(home);
  const now = new Date().toISOString();
  if (paused && !c.paused) {
    c.paused = true;
    c.pausedAt = now;
  }
  if (!paused && c.paused) {
    c.exclusions = [...(c.exclusions || []), [c.pausedAt || c.since, now]];
    c.paused = false;
    delete c.pausedAt;
  }
  atomicJSON(join(home, "participant.json"), c);
}
export function recordError(home, message) {
  const db = clientDB(home);
  try {
    db.prepare(
      "INSERT INTO status VALUES('error',?) ON CONFLICT(id) DO UPDATE SET value=excluded.value",
    ).run(message);
  } finally {
    db.close();
  }
}
export function newConfig({
  server,
  team,
  teamKey,
  project,
  allowHTTP = false,
}) {
  const agentRoot = (path) =>
    existsSync(path) ? realpathSync(path) : resolve(path);
  const claudeConfig = agentRoot(
    process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"),
  );
  const codexConfig = agentRoot(
    process.env.CODEX_HOME || join(homedir(), ".codex"),
  );
  return {
    version: 1,
    server: endpoint(server, allowHTTP),
    team,
    key: teamKey,
    project: realpathSync(project),
    allowHTTP,
    salt: key(),
    since: new Date().toISOString(),
    claudeConfig,
    codexConfig,
    claudeRoots: [agentRoot(join(claudeConfig, "projects"))],
    codexRoots: [agentRoot(join(codexConfig, "sessions"))],
  };
}
export function manualEvent(
  c,
  { inputTokens, outputTokens, provider = "manual", eventId },
) {
  if (!eventId)
    throw new Error("Pass a stable --id so retries cannot double count.");
  const e = {
    id: fingerprint(c.salt, "manual", eventId),
    session: fingerprint(c.salt, "manual-session"),
    provider,
    inputTokens,
    outputTokens,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    occurredAt: new Date().toISOString(),
  };
  return validateEvent(e);
}
