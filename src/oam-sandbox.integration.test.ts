import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

/**
 * The `--permission` sandbox on a REAL oam.
 *
 * launcher.test.ts reads sandboxFlags() as text and pins OAM_BIN to the Node
 * running the suite, so no test there can reach an oam -- deliberately, so the
 * suite behaves the same on every box. That left the grant list unexercised
 * against the runtime that enforces it, and is how a list missing SYSTEMROOT,
 * TEMP and USERPROFILE shipped: oam 0.18.0 builds a child's environment from
 * the FILTERED process.env, libuv's Windows additions included, and the
 * `tailscale` CLI is spawned without an `env` option.
 *
 * These cases run only where an oam at or above the launcher's floor is found
 * (OAM_BIN, else `oam` on PATH), and skip visibly otherwise -- the same gate
 * yaw-mcp's oam-runtime-contract suite uses.
 */

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const launcherSource = readFileSync(resolve(repoRoot, "bin/tailscale-mcp.mjs"), "utf-8");
const isWin = process.platform === "win32";

function parseVersion(text: string): number[] | null {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(text);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function atLeast(v: number[], min: number[]): boolean {
  for (let i = 0; i < min.length; i++) {
    if (v[i] !== min[i]) return v[i] > min[i];
  }
  return true;
}

const floorMatch = /const OAM_MIN = \[\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\]/.exec(launcherSource);
assert.ok(floorMatch, "could not read OAM_MIN from bin/tailscale-mcp.mjs");
const OAM_MIN = floorMatch.slice(1, 4).map(Number);

/** A usable oam at or above the floor, or null. */
function probeOam(): string | null {
  for (const candidate of [process.env.OAM_BIN, "oam"]) {
    if (!candidate) continue;
    try {
      const out = execFileSync(candidate, ["--version"], {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 10_000,
        windowsHide: true,
      });
      const version = parseVersion(out);
      if (version && atLeast(version, OAM_MIN)) return candidate;
    } catch {
      // Not there, or will not run: try the next one.
    }
  }
  return null;
}

/**
 * The launcher's real grant list, extracted as launcher.test.ts does, computed
 * for the environment oam will be given -- on Windows the grant follows that
 * environment's spelling of each name.
 */
function sandboxFlags(env: NodeJS.ProcessEnv = process.env): string[] {
  const match = launcherSource.match(/function sandboxFlags\(\) \{[\s\S]*?\n\}/);
  assert.ok(match, "could not extract sandboxFlags() from bin/tailscale-mcp.mjs");
  const factory = new Function("process", `${match[0]}; return sandboxFlags();`) as (p: {
    env: NodeJS.ProcessEnv;
    platform: string;
  }) => string[];
  return factory({ env: { ...env, TAILSCALE_MCP_SANDBOX: "1" }, platform: process.platform });
}

/** The names a child printed with `cmd /c set` or `env`, upper-cased. */
function childNames(stdout: string): Set<string> {
  return new Set(
    stdout
      .split(/\r?\n/)
      .map((line) => line.slice(0, line.indexOf("=")).toUpperCase())
      .filter(Boolean),
  );
}

const oam = probeOam();
const SKIP = !oam && `no oam ${OAM_MIN.join(".")} or newer found (OAM_BIN, or oam on PATH)`;

describe("the sandbox grant on a real oam", { skip: SKIP }, () => {
  const dir = mkdtempSync(join(tmpdir(), "tailscale-mcp-sandbox-"));
  after(() => rmSync(dir, { recursive: true, force: true }));

  it("hands a child spawned without `env` the variables it needs to start", () => {
    // The same shape as src/local-cli.ts: execFile with no `env`, so the child
    // inherits the server's process.env as the sandbox filtered it. The child
    // prints its own environment -- `cmd /c set` on Windows, `env` elsewhere.
    const probe = join(dir, "child-env.mjs");
    writeFileSync(
      probe,
      [
        'import { execFileSync } from "node:child_process";',
        isWin
          ? 'process.stdout.write(execFileSync("cmd.exe", ["/d", "/c", "set"], { encoding: "utf-8" }));'
          : 'process.stdout.write(execFileSync("env", [], { encoding: "utf-8" }));',
      ].join("\n"),
    );
    const env = { ...process.env, TAILSCALE_MCP_SANDBOX_PROBE_SECRET: "x" };
    const r = spawnSync(oam as string, [...sandboxFlags(env), "run", probe], {
      encoding: "utf-8",
      env,
      timeout: 60_000,
      windowsHide: true,
    });
    assert.equal(r.status, 0, `oam exited ${r.status}: ${r.stderr}`);
    const names = childNames(r.stdout);
    // Only names that are set in THIS process can arrive; an unset one is
    // absent whatever the grant says.
    const expected = isWin ? ["PATH", "SYSTEMROOT", "TEMP", "USERPROFILE", "WINDIR", "SYSTEMDRIVE"] : ["PATH", "HOME"];
    const present = expected.filter((name) => process.env[name] !== undefined);
    assert.ok(present.includes("PATH"), "PATH is set wherever this suite runs");
    for (const name of present) {
      assert.ok(names.has(name), `${name} did not reach the child; it saw: ${[...names].sort().join(", ")}`);
    }
    // And the sandbox is still a sandbox: a variable set for oam but not
    // granted stays out of the child, as it stays out of the server.
    assert.ok(!names.has("TAILSCALE_MCP_SANDBOX_PROBE_SECRET"), [...names].sort().join(", "));
  });

  it("admits Windows' own spellings (Path, SystemRoot, windir) to the child", { skip: !isWin }, () => {
    // oam matches an env grant exactly, case included. An MCP client started
    // from Explorer passes these on as Path, SystemRoot, SystemDrive and windir,
    // not upper-cased as a Git Bash shell (and so this suite, usually) has them;
    // a grant spelt SYSTEMROOT alone let neither Path nor SystemRoot through.
    const probe = join(dir, "child-env-native.mjs");
    writeFileSync(
      probe,
      [
        'import { execFileSync } from "node:child_process";',
        'process.stdout.write(execFileSync("cmd.exe", ["/d", "/c", "set"], { encoding: "utf-8" }));',
      ].join("\n"),
    );
    const native: Record<string, string> = {};
    const spelling: Record<string, string> = {
      PATH: "Path",
      SYSTEMROOT: "SystemRoot",
      SYSTEMDRIVE: "SystemDrive",
      WINDIR: "windir",
    };
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined) native[spelling[key.toUpperCase()] ?? key] = value;
    }
    const r = spawnSync(oam as string, [...sandboxFlags(native), "run", probe], {
      encoding: "utf-8",
      env: native,
      timeout: 60_000,
      windowsHide: true,
    });
    assert.equal(r.status, 0, `oam exited ${r.status}: ${r.stderr}`);
    const names = childNames(r.stdout);
    for (const name of Object.keys(spelling)) {
      assert.ok(names.has(name), `${name} did not reach the child; it saw: ${[...names].sort().join(", ")}`);
    }
  });

  it("refuses fetch to api.tailscale.com on any port but 443", () => {
    // The grant is port-scoped since the 0.18.0 floor. Refused before anything
    // is dialled, so this needs no network.
    const probe = join(dir, "net.mjs");
    writeFileSync(
      probe,
      [
        "try {",
        '  await fetch("http://api.tailscale.com:8080/", { signal: AbortSignal.timeout(5000) });',
        '  console.log("ADMITTED");',
        "} catch (err) {",
        '  console.log(err?.code ?? err?.cause?.code ?? "OTHER");',
        "}",
      ].join("\n"),
    );
    const r = spawnSync(oam as string, [...sandboxFlags(process.env), "run", probe], {
      encoding: "utf-8",
      env: process.env,
      timeout: 60_000,
      windowsHide: true,
    });
    assert.equal(r.stdout.trim(), "ERR_ACCESS_DENIED", `stdout: ${r.stdout} stderr: ${r.stderr}`);
  });
});
