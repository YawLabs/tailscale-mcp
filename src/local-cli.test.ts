import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

// Module-loaded import (vs the dynamic import pattern used in handlers.test.ts
// for the fetch-based tools): the local-cli runner is self-contained and
// doesn't read env at module-load time, so a single import is fine.
import { __setExecFileForTests, runTailscaleCli } from "./local-cli.js";
import { localCliTools } from "./tools/local-cli.js";

// Minimal execFile signature shape: (file, args, options, callback).
// We only ever use this 4-arg overload from the runner.
type ExecFileSpy = (
  file: string,
  args: readonly string[],
  options: { timeout?: number; maxBuffer?: number },
  callback: (
    err: (Error & { code?: string | number; killed?: boolean }) | null,
    stdout: string,
    stderr: string,
  ) => void,
) => void;

interface CapturedCall {
  file: string;
  args: readonly string[];
  options: { timeout?: number; maxBuffer?: number };
}

function findToolByName<T extends { name: string }>(tools: ReadonlyArray<T>, name: string): T {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`Tool not found: ${name}`);
  return tool;
}

describe("Local CLI runner (runTailscaleCli)", () => {
  const originalEnv = { ...process.env };
  let captured: CapturedCall | null = null;

  beforeEach(() => {
    captured = null;
  });

  afterEach(() => {
    __setExecFileForTests(null);
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
  });

  function installFakeExec(spy: ExecFileSpy): void {
    // execFile has several overload shapes. Cast through unknown so the test
    // doesn't depend on the exact compile-time signature.
    __setExecFileForTests(spy as unknown as Parameters<typeof __setExecFileForTests>[0]);
  }

  it("returns rawBody on success when parseJson is not set", async () => {
    installFakeExec((file, args, options, cb) => {
      captured = { file, args, options };
      setImmediate(() => cb(null, "1.74.1\n", ""));
    });
    const res = await runTailscaleCli(["version"]);
    assert.equal(res.ok, true);
    assert.equal(res.rawBody, "1.74.1\n");
    assert.equal(res.exitCode, 0);
    assert.equal(captured?.file, "tailscale");
    assert.deepEqual(captured?.args, ["version"]);
  });

  it("parses stdout as JSON when parseJson is true", async () => {
    installFakeExec((_file, _args, _options, cb) => {
      setImmediate(() => cb(null, JSON.stringify({ BackendState: "Running", MagicDNSSuffix: "tail-foo.ts.net" }), ""));
    });
    const res = await runTailscaleCli<{ BackendState: string }>(["status", "--json"], { parseJson: true });
    assert.equal(res.ok, true);
    assert.equal(res.data?.BackendState, "Running");
  });

  it("returns a friendly error + rawBody when JSON parse fails", async () => {
    installFakeExec((_file, _args, _options, cb) => {
      setImmediate(() => cb(null, "not json at all", ""));
    });
    const res = await runTailscaleCli(["status", "--json"], { parseJson: true });
    assert.equal(res.ok, false);
    assert.match(res.error ?? "", /Failed to parse JSON/);
    assert.equal(res.rawBody, "not json at all");
  });

  it("surfaces stderr (trimmed) on non-zero exit code", async () => {
    installFakeExec((_file, _args, _options, cb) => {
      const err = Object.assign(new Error("Command failed"), { code: 1 });
      setImmediate(() => cb(err, "", "  failed to connect\n  "));
    });
    const res = await runTailscaleCli(["ping", "100.64.0.1"]);
    assert.equal(res.ok, false);
    assert.equal(res.error, "failed to connect");
    assert.equal(res.exitCode, 1);
  });

  it("falls back to err.message when code is non-numeric and stderr is empty", async () => {
    installFakeExec((_file, _args, _options, cb) => {
      // No numeric `code` (string code, like a generic spawn failure) AND no
      // stderr: error must fall back to err.message, with no exitCode surfaced.
      const err = Object.assign(new Error("spawn EACCES"), { code: "EACCES" });
      setImmediate(() => cb(err, "", ""));
    });
    const res = await runTailscaleCli(["ping", "100.64.0.1"]);
    assert.equal(res.ok, false);
    assert.equal(res.error, "spawn EACCES");
    assert.equal(res.exitCode, undefined);
  });

  it("returns an install-hint error on ENOENT (binary missing)", async () => {
    installFakeExec((_file, _args, _options, cb) => {
      const err = Object.assign(new Error("spawn tailscale ENOENT"), { code: "ENOENT" });
      setImmediate(() => cb(err, "", ""));
    });
    const res = await runTailscaleCli(["status"]);
    assert.equal(res.ok, false);
    assert.match(res.error ?? "", /Could not find the 'tailscale' binary/);
    assert.match(res.error ?? "", /tailscale\.com\/download/);
    assert.match(res.error ?? "", /TAILSCALE_BINARY/);
    // No exit code on ENOENT — the process never ran.
    assert.equal(res.exitCode, undefined);
  });

  it("returns a timeout error when execFile reports killed=true", async () => {
    installFakeExec((_file, _args, _options, cb) => {
      const err = Object.assign(new Error("Command was killed"), { killed: true, signal: "SIGTERM" });
      setImmediate(() => cb(err, "", ""));
    });
    const res = await runTailscaleCli(["ping", "100.64.0.1"], { timeoutMs: 100 });
    assert.equal(res.ok, false);
    assert.match(res.error ?? "", /timed out after 100ms/);
  });

  it("respects TAILSCALE_BINARY override", async () => {
    process.env.TAILSCALE_BINARY = "/opt/custom/tailscale";
    installFakeExec((file, _args, _options, cb) => {
      captured = { file, args: [], options: {} };
      setImmediate(() => cb(null, "ok", ""));
    });
    await runTailscaleCli(["version"]);
    assert.equal(captured?.file, "/opt/custom/tailscale");
  });

  it("passes through the configured timeout to execFile options", async () => {
    installFakeExec((_file, _args, options, cb) => {
      captured = { file: "", args: [], options };
      setImmediate(() => cb(null, "ok", ""));
    });
    await runTailscaleCli(["status"], { timeoutMs: 7500 });
    assert.equal(captured?.options.timeout, 7500);
  });
});

describe("Local CLI tool handlers", () => {
  let lastArgs: readonly string[] | null = null;

  beforeEach(() => {
    lastArgs = null;
  });

  afterEach(() => {
    __setExecFileForTests(null);
  });

  function installFakeExec(stdoutByArgs: (args: readonly string[]) => string): void {
    const spy: ExecFileSpy = (_file, args, _options, cb) => {
      lastArgs = args;
      setImmediate(() => cb(null, stdoutByArgs(args), ""));
    };
    __setExecFileForTests(spy as unknown as Parameters<typeof __setExecFileForTests>[0]);
  }

  describe("tailscale_local_status", () => {
    it("invokes `tailscale status --json` and returns the parsed payload as data", async () => {
      installFakeExec(() => JSON.stringify({ BackendState: "Running" }));
      const tool = findToolByName(localCliTools, "tailscale_local_status");
      // tool.handler is typed as the union of all handler signatures (some
      // take input, some don't). Cast to the no-arg variant at the call site.
      const handler = tool.handler as () => Promise<{ ok: boolean; data: { BackendState: string } }>;
      const res = await handler();
      assert.deepEqual(lastArgs, ["status", "--json"]);
      assert.equal(res.ok, true);
      assert.equal(res.data.BackendState, "Running");
    });
  });

  describe("tailscale_ping", () => {
    it("invokes `tailscale ping <target>` with no count flag by default", async () => {
      installFakeExec(() => "pong 1ms via direct\n");
      const tool = findToolByName(localCliTools, "tailscale_ping");
      const handler = tool.handler as (input: { target: string; count?: number }) => Promise<{ ok: boolean }>;
      const res = await handler({ target: "100.64.0.1" });
      assert.deepEqual(lastArgs, ["ping", "100.64.0.1"]);
      assert.equal(res.ok, true);
    });

    it("includes -c <count> when provided", async () => {
      installFakeExec(() => "pong 1ms\npong 2ms\n");
      const tool = findToolByName(localCliTools, "tailscale_ping");
      const handler = tool.handler as (input: { target: string; count?: number }) => Promise<{ ok: boolean }>;
      await handler({ target: "my-laptop", count: 3 });
      assert.deepEqual(lastArgs, ["ping", "-c", "3", "my-laptop"]);
    });

    it("accepts a MagicDNS-style FQDN", async () => {
      installFakeExec(() => "pong\n");
      const tool = findToolByName(localCliTools, "tailscale_ping");
      const handler = tool.handler as (input: { target: string }) => Promise<{ ok: boolean }>;
      const res = await handler({ target: "my-laptop.tail-foo.ts.net" });
      assert.equal(res.ok, true);
    });

    it("accepts an IPv6 address (contains colons)", async () => {
      installFakeExec(() => "pong\n");
      const tool = findToolByName(localCliTools, "tailscale_ping");
      const handler = tool.handler as (input: { target: string }) => Promise<{ ok: boolean }>;
      const res = await handler({ target: "fd7a:115c::1" });
      assert.equal(res.ok, true);
      // Final positional arg is the target -- prove the colon survived
      // validation (the hostname regex rejects ':', but net.isIP catches it).
      assert.equal(lastArgs?.[lastArgs.length - 1], "fd7a:115c::1");
    });

    it("rejects shell metacharacters in the target", async () => {
      const tool = findToolByName(localCliTools, "tailscale_ping");
      const handler = tool.handler as (input: { target: string }) => Promise<unknown>;
      // Backticks, pipes, semicolons, dollar-parens, spaces -- all blockers.
      for (const bad of ["a;rm -rf /", "$(whoami)", "`whoami`", "host | cat", "host with space", "host&"]) {
        await assert.rejects(
          () => handler({ target: bad }),
          /Invalid ping target/,
          `should reject ${JSON.stringify(bad)}`,
        );
      }
    });

    it("rejects empty / overly long targets", async () => {
      const tool = findToolByName(localCliTools, "tailscale_ping");
      const handler = tool.handler as (input: { target: string }) => Promise<unknown>;
      await assert.rejects(() => handler({ target: "" }), /Invalid ping target/);
      await assert.rejects(() => handler({ target: "a".repeat(254) }), /Invalid ping target/);
    });

    it("rejects malformed labels (leading/trailing hyphen, empty label, oversized label)", async () => {
      // Previous regex `[a-zA-Z0-9._-]+` accepted ".foo", "foo.", "foo..bar",
      // "-foo", "foo-" -- all malformed per RFC 1123. Stricter per-label
      // validation surfaces the user mistake at the schema layer instead
      // of waiting for `tailscale ping` to error out.
      const tool = findToolByName(localCliTools, "tailscale_ping");
      const handler = tool.handler as (input: { target: string }) => Promise<unknown>;
      const malformed = [
        "-foo", // label starts with hyphen
        "foo-", // label ends with hyphen
        ".foo", // leading dot -> empty first label
        "foo.", // trailing dot -> empty last label
        "foo..bar", // consecutive dots -> empty middle label
        ".", // just a dot
        `${"a".repeat(64)}.example`, // first label > 63 chars
        "_", // single-underscore label -- RFC 1123 single-char must be alphanumeric
        "_foo", // label starts with underscore
        "foo_", // label ends with underscore
        "_._", // both labels underscore-only
      ];
      for (const bad of malformed) {
        await assert.rejects(
          () => handler({ target: bad }),
          /Invalid ping target/,
          `should reject ${JSON.stringify(bad)}`,
        );
      }
    });

    it("accepts a single-character label and a 63-character label (boundary)", async () => {
      installFakeExec(() => "pong\n");
      const tool = findToolByName(localCliTools, "tailscale_ping");
      const handler = tool.handler as (input: { target: string }) => Promise<{ ok: boolean }>;
      // Single-char label: 'a' is a valid hostname.
      assert.equal((await handler({ target: "a" })).ok, true);
      // 63 chars is the per-label max; total length is well under 253.
      assert.equal((await handler({ target: "a".repeat(63) })).ok, true);
    });

    it("accepts underscores in the middle of a label, rejects them at the edges", async () => {
      // MagicDNS occasionally uses underscores inside hostnames, so they must
      // be allowed in the middle of a label. RFC 1123 single-char labels must
      // be alphanumeric -- a label that starts or ends with `_` is malformed.
      installFakeExec(() => "pong\n");
      const tool = findToolByName(localCliTools, "tailscale_ping");
      const handler = tool.handler as (input: { target: string }) => Promise<{ ok: boolean }>;
      assert.equal((await handler({ target: "foo_bar" })).ok, true);
      assert.equal((await handler({ target: "a_b.example" })).ok, true);
    });
  });

  describe("tailscale_netcheck", () => {
    it("invokes `tailscale netcheck --format=json` and parses the result", async () => {
      installFakeExec(() => JSON.stringify({ UDP: true, IPv4: true, MappingVariesByDestIP: false }));
      const tool = findToolByName(localCliTools, "tailscale_netcheck");
      const handler = tool.handler as () => Promise<{ ok: boolean; data: { UDP: boolean } }>;
      const res = await handler();
      assert.deepEqual(lastArgs, ["netcheck", "--format=json"]);
      assert.equal(res.ok, true);
      assert.equal(res.data.UDP, true);
    });
  });

  describe("tailscale_local_version", () => {
    it("invokes `tailscale version` and returns the text verbatim as rawBody", async () => {
      installFakeExec(() => "1.74.1\n  tailscale commit: abc123\n  go version: go1.23\n");
      const tool = findToolByName(localCliTools, "tailscale_local_version");
      const handler = tool.handler as () => Promise<{ ok: boolean; rawBody: string }>;
      const res = await handler();
      assert.deepEqual(lastArgs, ["version"]);
      assert.equal(res.ok, true);
      assert.match(res.rawBody, /1\.74\.1/);
    });
  });
});
