import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import {
  atomicJSON,
  readJSON,
  key,
  hash,
  equalKey,
  teamName,
  validateEvent,
} from "./common.js";
import { serverDatabase, transaction, upsertEventSQL } from "./database.js";
import { demoSummary } from "./demo.js";

const publicDir = fileURLToPath(new URL("../public/", import.meta.url));
const assets = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
  ["/style.css", ["style.css", "text/css; charset=utf-8"]],
  ["/favicon.svg", ["favicon.svg", "image/svg+xml"]],
  ...[400, 700, 900].map((weight) => [
    `/montserrat-${weight}.ttf`,
    [`montserrat-${weight}.ttf`, "font/ttf"],
  ]),
]);
const security = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store",
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  "X-Frame-Options": "DENY",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
};
const aggregate = `COALESCE(SUM(e.input_tokens),0) inputTokens,COALESCE(SUM(e.output_tokens),0) outputTokens,COALESCE(SUM(e.cache_read_tokens),0) cacheReadTokens,COALESCE(SUM(e.cache_write_tokens),0) cacheWriteTokens,COUNT(DISTINCT e.session) sessions`;
async function body(req) {
  if (!req.headers["content-type"]?.startsWith("application/json"))
    throw Object.assign(new Error("Use application/json"), { status: 415 });
  let bytes = 0;
  const chunks = [];
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > 65536)
      throw Object.assign(new Error("Payload too large"), { status: 413 });
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("Invalid JSON");
  }
}
export function createApp({
  dataDir = ".htm-data",
  demo = false,
  adminKey,
  viewKey,
  databasePath,
} = {}) {
  let secrets;
  if (!demo && (!adminKey || !viewKey)) {
    const path = join(dataDir, "server-secrets.json");
    secrets = readJSON(path, null);
    if (!secrets) {
      secrets = { adminKey: key(), viewKey: key() };
      atomicJSON(path, secrets);
    }
  }
  adminKey ||= secrets?.adminKey;
  viewKey ||= secrets?.viewKey;
  if (
    !demo &&
    (adminKey.length < 32 || viewKey.length < 32 || adminKey === viewKey)
  )
    throw new Error(
      "Use separate admin and view keys of at least 32 characters.",
    );
  const db = demo
    ? null
    : serverDatabase(databasePath || join(dataDir, "usage.sqlite"));
  const limits = new Map();
  function throttle(identity, limit) {
    const now = Date.now();
    let b = limits.get(identity);
    if (!b || now - b.start > 60_000) {
      b = { start: now, count: 0 };
      limits.set(identity, b);
    }
    if (limits.size > 10000)
      for (const [k, v] of limits) if (now - v.start > 60_000) limits.delete(k);
    if (limits.size > 10000 || ++b.count > limit)
      throw Object.assign(new Error("Too many requests; retry in one minute"), {
        status: 429,
      });
  }
  function send(res, status, value) {
    res.writeHead(status, {
      ...security,
      "Content-Type": "application/json; charset=utf-8",
      ...(status === 429 ? { "Retry-After": "60" } : {}),
    });
    res.end(JSON.stringify(value));
  }
  const handler = async (req, res) => {
    try {
      const url = new URL(req.url, "http://localhost");
      const route = url.pathname;
      if (req.method === "GET" && assets.has(route)) {
        const [file, type] = assets.get(route);
        res.writeHead(200, { ...security, "Content-Type": type });
        res.end(readFileSync(join(publicDir, file)));
        return;
      }
      if (req.method === "GET" && route === "/api/health")
        return send(res, 200, {
          ok: true,
          demo,
          version: "0.1.0",
          sourceRevision: /^[a-f0-9]{40}$/.test(
            process.env.HTM_SOURCE_COMMIT || "",
          )
            ? process.env.HTM_SOURCE_COMMIT
            : null,
        });
      throttle("ip:" + req.socket.remoteAddress, 600);
      const token = req.headers.authorization?.replace(/^Bearer /, "") || "";
      const admin = !!adminKey && equalKey(token, adminKey);
      const viewer = admin || (!!viewKey && equalKey(token, viewKey));
      if (req.method === "GET" && route === "/api/summary") {
        const provider = url.searchParams.get("provider") || "all";
        if (!["all", "claude", "codex", "manual"].includes(provider))
          throw new Error("Invalid provider");
        if (demo) return send(res, 200, demoSummary(provider));
        if (!viewer)
          return send(res, 401, {
            error: "Enter a dashboard view key or organizer key.",
          });
        const p = provider === "all" ? null : provider;
        const teams = db
          .prepare(
            `SELECT t.id,t.name,t.active,${aggregate},MAX(e.received_at) lastSeen,COALESCE(SUM(CASE WHEN e.provider='claude' THEN e.input_tokens+e.output_tokens ELSE 0 END),0) claude,COALESCE(SUM(CASE WHEN e.provider='codex' THEN e.input_tokens+e.output_tokens ELSE 0 END),0) codex FROM teams t LEFT JOIN events e ON e.team_id=t.id AND (? IS NULL OR e.provider=?) GROUP BY t.id ORDER BY inputTokens+outputTokens DESC`,
          )
          .all(p, p);
        const totals = db
          .prepare(
            `SELECT ${aggregate} FROM events e WHERE (? IS NULL OR provider=?)`,
          )
          .get(p, p);
        const since = new Date(Date.now() - 24 * 3600_000).toISOString();
        const timeline = db
          .prepare(
            `SELECT substr(occurred_at,1,13)||':00:00.000Z' hour,SUM(input_tokens) inputTokens,SUM(output_tokens) outputTokens FROM events WHERE occurred_at>=? AND (? IS NULL OR provider=?) GROUP BY substr(occurred_at,1,13) ORDER BY hour`,
          )
          .all(since, p, p);
        return send(res, 200, {
          demo: false,
          teams,
          totals,
          timeline,
          provider,
          admin,
          generatedAt: new Date().toISOString(),
        });
      }
      if (demo)
        return send(res, 403, {
          error:
            "Demo mode is read-only. Start your own server to collect usage.",
        });
      if (
        req.method === "POST" &&
        ["/api/events", "/api/verify"].includes(route)
      ) {
        throttle("key:" + hash(token), 120);
        const team = db
          .prepare("SELECT * FROM teams WHERE key_hash=? AND active=1")
          .get(hash(token));
        if (!team)
          return send(res, 401, { error: "Invalid or paused team key." });
        const payload = await body(req);
        if (payload.team !== team.name)
          return send(res, 403, {
            error: "This key belongs to a different team.",
          });
        if (route === "/api/verify")
          return send(res, 200, { team: team.name, version: "0.1.0" });
        if (
          Object.keys(payload).some((k) => !["team", "events"].includes(k)) ||
          !Array.isArray(payload.events) ||
          payload.events.length < 1 ||
          payload.events.length > 100
        )
          throw new Error("Expected team and 1–100 events.");
        for (const e of payload.events) validateEvent(e);
        const statement = db.prepare(upsertEventSQL);
        const now = new Date().toISOString();
        transaction(db, () => {
          for (const e of payload.events)
            statement.run(
              team.id,
              e.id,
              e.session,
              e.provider,
              e.inputTokens,
              e.outputTokens,
              e.cacheReadTokens,
              e.cacheWriteTokens,
              e.occurredAt,
              now,
            );
        });
        return send(res, 200, { accepted: payload.events.length });
      }
      if (route.startsWith("/api/admin/")) {
        if (!admin) return send(res, 401, { error: "Organizer key required." });
        if (req.method === "POST" && route === "/api/admin/teams") {
          const payload = await body(req);
          const name = teamName(payload.name);
          const teamKey = key();
          const id = randomUUID();
          try {
            db.prepare("INSERT INTO teams VALUES(?,?,?,1,?)").run(
              id,
              name,
              hash(teamKey),
              new Date().toISOString(),
            );
          } catch (e) {
            if (e.code?.includes("SQLITE"))
              return send(res, 409, { error: "Team name already exists." });
            throw e;
          }
          return send(res, 201, { id, name, key: teamKey });
        }
        const match = route.match(
          /^\/api\/admin\/teams\/([a-f0-9-]{36})\/(rotate|status)$/,
        );
        if (req.method === "POST" && match) {
          const t = db.prepare("SELECT id FROM teams WHERE id=?").get(match[1]);
          if (!t) return send(res, 404, { error: "Team not found." });
          if (match[2] === "rotate") {
            const teamKey = key();
            db.prepare("UPDATE teams SET key_hash=? WHERE id=?").run(
              hash(teamKey),
              t.id,
            );
            return send(res, 200, { key: teamKey });
          }
          const payload = await body(req);
          if (typeof payload.active !== "boolean")
            throw new Error("Expected active boolean");
          db.prepare("UPDATE teams SET active=? WHERE id=?").run(
            Number(payload.active),
            t.id,
          );
          return send(res, 200, { ok: true });
        }
      }
      return send(res, 404, { error: "Not found." });
    } catch (e) {
      send(res, e.status || 400, {
        error: e.code?.includes("SQLITE")
          ? "Storage operation failed."
          : e.message,
      });
    }
  };
  const server = createServer(handler);
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  server.on("close", () => db?.close());
  return server;
}
