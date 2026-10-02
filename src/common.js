import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import {
  mkdirSync,
  writeFileSync,
  renameSync,
  chmodSync,
  readFileSync,
} from "node:fs";
import { dirname, relative, isAbsolute } from "node:path";

export const VERSION = "0.1.0";
export const LIMIT = 1_000_000_000_000;
export const key = () => randomBytes(32).toString("base64url");
export const hash = (value) => createHash("sha256").update(value).digest("hex");
export const fingerprint = (salt, ...parts) =>
  createHmac("sha256", salt).update(JSON.stringify(parts)).digest("hex");
export const equalKey = (a, b) =>
  typeof a === "string" &&
  typeof b === "string" &&
  timingSafeEqual(Buffer.from(hash(a)), Buffer.from(hash(b)));
export const inside = (root, path) => {
  const r = relative(root, path);
  return (
    r === "" ||
    (!r.startsWith(".." + (process.platform === "win32" ? "\\" : "/")) &&
      r !== ".." &&
      !isAbsolute(r))
  );
};
export function privateDir(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
}
export function atomicJSON(path, value) {
  privateDir(dirname(path));
  const temp = `${path}.${process.pid}.${randomBytes(5).toString("hex")}.tmp`;
  writeFileSync(temp, JSON.stringify(value, null, 2) + "\n", {
    mode: 0o600,
    flag: "wx",
  });
  renameSync(temp, path);
  chmodSync(path, 0o600);
}
export function readJSON(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    if (e.code === "ENOENT" && fallback !== undefined) return fallback;
    throw e;
  }
}
export function endpoint(value, allowHTTP = false) {
  const u = new URL(value);
  if (u.username || u.password || u.search || u.hash || u.pathname !== "/")
    throw new Error(
      "Use a server origin without credentials, path, query or fragment.",
    );
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
  if (
    u.protocol !== "https:" &&
    !(u.protocol === "http:" && (local || allowHTTP))
  )
    throw new Error(
      "HTTPS is required. Use --allow-http only for a trusted local network.",
    );
  return u.origin;
}
export function teamName(value) {
  if (typeof value !== "string") throw new Error("Team name is required.");
  const name = value.normalize("NFKC").trim();
  if (
    name.length < 1 ||
    name.length > 64 ||
    /[\u0000-\u001f\u007f]/u.test(name)
  )
    throw new Error("Team name must contain 1–64 printable characters.");
  return name;
}
export const number = (value) =>
  Number.isSafeInteger(value) && value >= 0 && value <= LIMIT;
export function validateEvent(e) {
  const allowed = [
    "id",
    "session",
    "provider",
    "inputTokens",
    "outputTokens",
    "cacheReadTokens",
    "cacheWriteTokens",
    "occurredAt",
  ];
  if (
    !e ||
    typeof e !== "object" ||
    Array.isArray(e) ||
    Object.keys(e).some((k) => !allowed.includes(k))
  )
    throw new Error("Unexpected event fields. Only counters are accepted.");
  if (!/^[a-f0-9]{64}$/.test(e.id) || !/^[a-f0-9]{64}$/.test(e.session))
    throw new Error("Invalid anonymous event ID.");
  if (!["claude", "codex", "manual"].includes(e.provider))
    throw new Error("Unsupported provider.");
  for (const field of [
    "inputTokens",
    "outputTokens",
    "cacheReadTokens",
    "cacheWriteTokens",
  ])
    if (!number(e[field])) throw new Error("Invalid token count.");
  if (e.cacheReadTokens + e.cacheWriteTokens > e.inputTokens)
    throw new Error("Cache is a subset of input.");
  if (
    typeof e.occurredAt !== "string" ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(e.occurredAt) ||
    !Number.isFinite(Date.parse(e.occurredAt)) ||
    Date.parse(e.occurredAt) > Date.now() + 300_000
  )
    throw new Error("Invalid event timestamp.");
  return e;
}
