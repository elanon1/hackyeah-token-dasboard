import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
test("Runtime has no dependencies or install scripts; dashboard has no external asset requests", () => {
  const p = JSON.parse(readFileSync("package.json"));
  assert.equal(p.dependencies, undefined);
  for (const k of ["preinstall", "install", "postinstall", "prepare"])
    assert.equal(p.scripts[k], undefined);
  const html = readFileSync("public/index.html", "utf8");
  assert.ok(!/<script[^>]+src="https?:/i.test(html));
  assert.ok(!/<link[^>]+href="https?:/i.test(html));
  const app = readFileSync("public/app.js", "utf8");
  assert.ok(!app.includes(".innerHTML"));
  assert.ok(!app.includes("localStorage"));
  assert.ok(!app.includes("sessionStorage"));
});
