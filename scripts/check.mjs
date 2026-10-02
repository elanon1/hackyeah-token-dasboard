import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
for (const dir of ["bin", "src", "public", "scripts", "test"])
  for (const file of readdirSync(dir))
    if (/\.[cm]?js$/.test(file)) {
      const result = spawnSync(process.execPath, ["--check", join(dir, file)], {
        stdio: "inherit",
      });
      if (result.status !== 0) process.exit(result.status || 1);
    }
const p = JSON.parse(readFileSync("package.json"));
if (p.dependencies || p.scripts.postinstall || p.scripts.prepare)
  throw new Error("Keep the runtime dependency-free and install-script-free.");
for (const file of ["src/client.js", "src/parsers.js", "src/server.js"])
  if (!readFileSync(file, "utf8")) throw new Error(`Missing ${file}`);
console.log("Syntax and package safety checks passed.");
