import { DatabaseSync } from "node:sqlite";
import { chmodSync } from "node:fs";
import { dirname } from "node:path";
import { privateDir } from "./common.js";

export function database(path) {
  if (path !== ":memory:") privateDir(dirname(path));
  const db = new DatabaseSync(path);
  if (path !== ":memory:") chmodSync(path, 0o600);
  db.exec(
    "PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;",
  );
  return db;
}
export function transaction(db, fn) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}
export function serverDatabase(path) {
  const db = database(path);
  db.exec(`CREATE TABLE IF NOT EXISTS teams (
    id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, key_hash TEXT NOT NULL UNIQUE,
    active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS events (
    team_id TEXT NOT NULL REFERENCES teams(id), id TEXT NOT NULL, session TEXT NOT NULL,
    provider TEXT NOT NULL, input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL,
    cache_read_tokens INTEGER NOT NULL, cache_write_tokens INTEGER NOT NULL,
    occurred_at TEXT NOT NULL, received_at TEXT NOT NULL, PRIMARY KEY(team_id,id));
    CREATE INDEX IF NOT EXISTS events_time ON events(occurred_at);
    CREATE INDEX IF NOT EXISTS events_team ON events(team_id);`);
  return db;
}
export const upsertEventSQL = `INSERT INTO events VALUES(?,?,?,?,?,?,?,?,?,?)
  ON CONFLICT(team_id,id) DO UPDATE SET
  input_tokens=MAX(events.input_tokens,excluded.input_tokens),
  output_tokens=MAX(events.output_tokens,excluded.output_tokens),
  cache_read_tokens=MAX(events.cache_read_tokens,excluded.cache_read_tokens),
  cache_write_tokens=MAX(events.cache_write_tokens,excluded.cache_write_tokens),
  received_at=excluded.received_at
  WHERE events.session=excluded.session AND events.provider=excluded.provider`;
