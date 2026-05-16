import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

// Resolve via import.meta.url so the test works regardless of process.cwd() --
// `npm test` runs from the repo root today, but a future runner invoking
// dist/release-metadata.test.js directly would otherwise hit ENOENT silently.
// __dirname for the compiled test is dist/, so the repo root is one level up.
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function readJson(rel: string): Record<string, unknown> {
  return JSON.parse(readFileSync(resolve(repoRoot, rel), "utf-8")) as Record<string, unknown>;
}

describe("release metadata", () => {
  // server.json is what the Official MCP Registry reads at publish time. It
  // carries the version twice (top-level + packages[].version) and is bumped
  // separately from package.json by release.sh -- without this test, a manual
  // edit that updates one but not the other would ship a desynced registry
  // entry.
  it("server.json top-level version matches package.json", () => {
    const pkg = readJson("package.json");
    const server = readJson("server.json");
    assert.equal(
      server.version,
      pkg.version,
      `server.json version (${String(server.version)}) must match package.json version (${String(pkg.version)})`,
    );
  });

  it("server.json packages[].version all match package.json", () => {
    const pkg = readJson("package.json");
    const server = readJson("server.json");
    const packages = server.packages as Array<{ version: string; identifier?: string }> | undefined;
    assert.ok(Array.isArray(packages) && packages.length > 0, "server.json must declare at least one package");
    for (const entry of packages) {
      assert.equal(
        entry.version,
        pkg.version,
        `server.json packages entry (${entry.identifier ?? "<unnamed>"}) version (${entry.version}) ` +
          `must match package.json version (${String(pkg.version)})`,
      );
    }
  });

  it("mcpName in package.json matches server.json name", () => {
    // Catches a different drift mode: registry publish keys the package by
    // `name`, and the npm consumer looks at `mcpName`. They must agree or
    // discovery and install land on different identifiers.
    const pkg = readJson("package.json");
    const server = readJson("server.json");
    assert.equal(pkg.mcpName, server.name, "package.json mcpName must equal server.json name");
  });
});
