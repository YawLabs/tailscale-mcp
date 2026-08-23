import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const launcherSource = readFileSync(resolve(repoRoot, "bin/tailscale-mcp.mjs"), "utf-8");

/**
 * Evaluate the REAL `sandboxFlags` source with an injected `process`.
 *
 * Why not import the launcher: its module body runs at import time (it resolves
 * a runtime and either spawns oam or imports the server), so importing it from
 * a test would launch a server. Making it importable would mean gating that
 * body behind an `import.meta.url === argv[1]` check -- a behaviour change to a
 * shipped runtime artifact whose failure mode (guard reads false under an npm
 * shim or symlink, launcher silently does nothing) is worse than the gap being
 * closed here.
 *
 * Extracting the source keeps the production file untouched while still
 * exercising the real logic rather than a copy that can drift. If the extraction
 * ever fails, that is a loud assertion, not a silent skip.
 */
function loadSandboxFlags(env: Record<string, string | undefined>): string[] {
  const match = launcherSource.match(/function sandboxFlags\(\) \{[\s\S]*?\n\}/);
  assert.ok(match, "could not extract sandboxFlags() from bin/tailscale-mcp.mjs -- was it renamed or reformatted?");
  const factory = new Function("process", `${match[0]}; return sandboxFlags();`) as (p: {
    env: Record<string, string | undefined>;
  }) => string[];
  return factory({ env });
}

describe("launcher sandboxFlags()", () => {
  it("grants nothing unless TAILSCALE_MCP_SANDBOX is exactly '1'", () => {
    // Exact-string contract, matching TAILSCALE_LOCAL_CLI's. A loose truthiness
    // check here would silently sandbox anyone who set the var to "0".
    for (const value of [undefined, "", "0", "true", "yes", "TRUE"]) {
      assert.deepEqual(
        loadSandboxFlags({ TAILSCALE_MCP_SANDBOX: value }),
        [],
        `TAILSCALE_MCP_SANDBOX=${JSON.stringify(value)} must not enable the sandbox`,
      );
    }
  });

  it("emits --permission first, since oam rejects it after the run subcommand", () => {
    // Ordering is load-bearing: these are oam PROCESS-level flags and must
    // precede `run`. The call site spreads this array before "run".
    const flags = loadSandboxFlags({ TAILSCALE_MCP_SANDBOX: "1" });
    assert.equal(flags[0], "--permission");
  });

  it("restricts net to the Tailscale hosts and nothing else", () => {
    const flags = loadSandboxFlags({ TAILSCALE_MCP_SANDBOX: "1" });
    const net = flags.find((f) => f.startsWith("--allow-net="));
    assert.ok(net, "expected an --allow-net grant");
    const hosts = net.slice("--allow-net=".length).split(",");
    assert.deepEqual(hosts, ["api.tailscale.com", "login.tailscale.com"]);
  });

  it("grants child-process, which the local-CLI tools require", () => {
    // Paired with TAILSCALE_LOCAL_CLI in the env allow-list: granting one
    // without the other is the bug fixed in 9f507bd.
    const flags = loadSandboxFlags({ TAILSCALE_MCP_SANDBOX: "1" });
    assert.ok(flags.includes("--allow-child-process"));
  });

  it("grants PATH plus a non-empty TAILSCALE_* env allow-list", () => {
    const flags = loadSandboxFlags({ TAILSCALE_MCP_SANDBOX: "1" });
    const envFlag = flags.find((f) => f.startsWith("--allow-env="));
    assert.ok(envFlag, "expected an --allow-env grant");
    const names = envFlag.slice("--allow-env=".length).split(",");
    assert.ok(names.includes("PATH"), "PATH is required for the local-CLI tools to find the binary");
    assert.ok(names.includes("TAILSCALE_LOCAL_CLI"), "regression guard for 9f507bd");
    assert.deepEqual([...names].sort(), names, "keep the list alphabetised so omissions are easy to spot");
  });

  it("does not grant filesystem access", () => {
    const flags = loadSandboxFlags({ TAILSCALE_MCP_SANDBOX: "1" });
    assert.ok(
      !flags.some((f) => f.startsWith("--allow-read") || f.startsWith("--allow-write") || f === "--allow-fs"),
      `filesystem must stay denied, got: ${flags.join(" ")}`,
    );
  });
});
