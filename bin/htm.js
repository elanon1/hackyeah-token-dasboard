#!/usr/bin/env node
import { parseArgs } from "node:util";
import { createInterface } from "node:readline/promises";
import { resolve, join } from "node:path";
import { existsSync } from "node:fs";
import { atomicJSON, teamName } from "../src/common.js";
import {
  clientHome,
  config,
  newConfig,
  post,
  install,
  uninstall,
  hook,
  sync,
  flush,
  status,
  preview,
  enqueue,
  manualEvent,
  setPaused,
  recordError,
} from "../src/client.js";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: Object.fromEntries(
    [
      "server",
      "team",
      "project",
      "home",
      "provider",
      "port",
      "host",
      "data",
      "in",
      "out",
      "id",
    ]
      .map((k) => [k, { type: "string" }])
      .concat(
        [
          "yes",
          "key-stdin",
          "allow-http",
          "no-hooks",
          "demo",
          "dry-run",
          "help",
        ].map((k) => [k, { type: "boolean" }]),
      ),
  ),
});
const command = positionals[0] || "help";
const home = resolve(values.home || clientHome());
async function stdin(limit = 1024 * 1024) {
  let text = "";
  for await (const chunk of process.stdin) {
    text += chunk;
    if (Buffer.byteLength(text) > limit) throw new Error("Input too large");
  }
  return text;
}
async function ask(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}
async function secretPrompt() {
  if (!process.stdin.isTTY)
    throw new Error("Use --key-stdin when stdin is not a terminal.");
  process.stdout.write("Team key (hidden): ");
  process.stdin.setRawMode(true);
  process.stdin.resume();
  return new Promise((resolve, reject) => {
    let value = "";
    const done = (err) => {
      process.stdin.off("data", read);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write("\n");
      err ? reject(err) : resolve(value);
    };
    const read = (chunk) => {
      for (const c of chunk.toString()) {
        if (c === "\r" || c === "\n") return done();
        if (c === "\u0003") return done(new Error("Cancelled"));
        if (c === "\u007f" || c === "\b") value = value.slice(0, -1);
        else if (c >= " ") value += c;
      }
    };
    process.stdin.on("data", read);
  });
}
async function main() {
  if (command === "help" || values.help) {
    console.log(`Hackathon Token Meter · Claude Code + Codex CLI

Organizer:
  htm server [--port 4318] [--host 127.0.0.1] [--data .htm-data]
  htm server --demo                 Read-only demonstration

Participant (run from the hackathon project):
  htm join --server https://meter.example --team "My Team"
  htm status                       Integration health and pending reports
  htm sync --dry-run                Inspect the exact payload; no network
  htm sync                         Recover missed hooks and send a batch
  htm watch                        Sync both agents every 10 seconds
  htm flush                        Retry queued usage
  htm pause / htm resume            Control collection
  htm rekey                        Replace a rotated team key securely
  htm uninstall                    Remove our hooks and pause collection
  htm report --in 100 --out 20 --id request-123

Node >=22.13. No runtime dependencies, install scripts or provider keys.
Only activity after joining, within --project (default: current directory).
Use --key-stdin --yes for unattended setup. Secrets are never CLI arguments.
Codex: restart and review the installed commands in /hooks.
Native Windows hooks: use WSL; Node server and SDK also run on Windows.`);
    return;
  }
  if (command === "server") {
    const { createApp } = await import("../src/server.js");
    const port = Number(values.port || 4318);
    if (!Number.isInteger(port) || port < 0 || port > 65535)
      throw new Error("Invalid port");
    const dataDir = resolve(values.data || ".htm-data");
    const host = values.host || "127.0.0.1";
    const server = createApp({
      dataDir,
      demo: values.demo,
      adminKey: process.env.HTM_ADMIN_KEY,
      viewKey: process.env.HTM_VIEW_KEY,
    });
    server.listen(port, host, () => {
      console.log(
        `Dashboard: http://${host === "0.0.0.0" ? "localhost" : host}:${server.address().port}`,
      );
      if (values.demo)
        console.log("DEMO DATA · read-only · no usage is collected");
      else
        console.log(
          `Organizer and read-only keys: ${join(dataDir, "server-secrets.json")}\nKeep this file private. Use HTTPS when exposing the server to participants.`,
        );
    });
    for (const s of ["SIGINT", "SIGTERM"])
      process.once(s, () => server.close());
    return;
  }
  if (command === "join") {
    if (existsSync(join(home, "participant.json")))
      throw new Error(
        "Already configured. Use the existing team or a different --home; do not reset event identity.",
      );
    if (!values.server || !values.team)
      throw new Error("--server and --team are required");
    console.log(
      "Collect only token counts from Claude Code and Codex logs for this project, from now on.\nSend team name, counts, timestamps and anonymous deduplication IDs to your organizer.\nNo prompts, code, filenames, email or provider API keys are uploaded.\nHooks are added to your user settings; existing hooks are preserved. Uninstall at any time.",
    );
    if (
      !values.yes &&
      (await ask("Enable this collection? [y/N] ")).toLowerCase() !== "y"
    )
      throw new Error("Cancelled; nothing changed.");
    const teamKey = (
      values["key-stdin"] ? await stdin(4096) : await secretPrompt()
    ).trim();
    if (teamKey.length < 32) throw new Error("Team key is too short");
    const c = newConfig({
      server: values.server,
      team: teamName(values.team),
      teamKey,
      project: values.project || process.cwd(),
      allowHTTP: values["allow-http"],
    });
    await post(c, "/api/verify", { team: c.team });
    atomicJSON(join(home, "participant.json"), c);
    if (!values["no-hooks"]) {
      if (process.platform === "win32")
        console.log(
          "Native Windows: run htm watch, or install inside WSL for hooks.",
        );
      else install(home);
    }
    console.log(
      `Joined ${c.team}. Tracking only ${c.project}.\nRestart Claude Code and Codex. In Codex, review and trust these hooks in /hooks.\nUse htm watch if your agent version does not support hooks. Run htm status after a turn.`,
    );
    return;
  }
  if (command === "hook") {
    try {
      await hook(values.provider, JSON.parse(await stdin()), home);
    } catch (e) {
      try {
        recordError(home, e.message);
      } catch {} /* Never block or steer the coding agent. */
    }
    return;
  }
  if (command === "status") {
    console.log(JSON.stringify(status(home), null, 2));
    return;
  }
  if (command === "preview") {
    console.log(JSON.stringify(preview(home), null, 2));
    return;
  }
  if (command === "sync") {
    console.log(
      JSON.stringify(await sync(home, { dryRun: values["dry-run"] }), null, 2),
    );
    return;
  }
  if (command === "flush") {
    console.log(JSON.stringify(await flush(home), null, 2));
    return;
  }
  if (command === "install") {
    if (process.platform === "win32")
      throw new Error("Use WSL for hooks, or htm watch on native Windows.");
    console.log(install(home).join("\n"));
    return;
  }
  if (command === "uninstall") {
    uninstall(home);
    console.log(
      "Hooks removed; collection paused. Local config and counters retained for safe recovery.",
    );
    return;
  }
  if (command === "rekey") {
    const c = config(home);
    const teamKey = (
      values["key-stdin"] ? await stdin(4096) : await secretPrompt()
    ).trim();
    if (teamKey.length < 32) throw new Error("Team key is too short");
    const next = { ...c, key: teamKey };
    await post(next, "/api/verify", { team: c.team });
    atomicJSON(join(home, "participant.json"), next);
    console.log(
      "Team key updated. Event identity and queued counters preserved.",
    );
    return;
  }
  if (command === "pause" || command === "resume") {
    setPaused(home, command === "pause");
    console.log(
      command === "pause"
        ? "Collection paused."
        : "Collection resumed. Records timestamped during the pause are excluded.",
    );
    return;
  }
  if (command === "report") {
    const c = config(home);
    if (c.paused) throw new Error("Collection is paused.");
    const event = manualEvent(c, {
      inputTokens: Number(values.in),
      outputTokens: Number(values.out),
      provider: values.provider || "manual",
      eventId: values.id,
    });
    enqueue(home, [event]);
    console.log(await flush(home));
    return;
  }
  if (command === "watch") {
    console.log(
      "Watching Claude Code + Codex in the configured project. Ctrl+C to stop.",
    );
    let stop = false;
    process.once("SIGINT", () => {
      stop = true;
    });
    process.once("SIGTERM", () => {
      stop = true;
    });
    while (!stop) {
      try {
        const r = await sync(home);
        console.log(new Date().toISOString(), JSON.stringify(r));
      } catch (e) {
        console.error(e.message);
      }
      for (let i = 0; i < 10 && !stop; i++)
        await new Promise((r) => setTimeout(r, 1000));
    }
    return;
  }
  throw new Error(`Unknown command: ${command}. Run htm help.`);
}
main().catch((e) => {
  if (command !== "hook") {
    console.error(e.message);
    process.exitCode = 1;
  }
});
