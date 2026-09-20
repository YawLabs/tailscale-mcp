import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

// Module-loaded import (vs the dynamic import pattern used in handlers.test.ts
// for the fetch-based tools): the local-cli runner is self-contained and
// doesn't read env at module-load time, so a single import is fine.
import { __localCliInternals, __setExecFileForTests, runTailscaleCli } from "./local-cli.js";
import { localCliTools } from "./tools/local-cli.js";

// Minimal execFile signature shape: (file, args, options, callback).
// We only ever use this 4-arg overload from the runner.
type ExecFileSpy = (
  file: string,
  args: readonly string[],
  options: { timeout?: number; maxBuffer?: number },
  callback: (
    // `code` includes null on purpose: a timeout kill really does arrive with
    // code null (probed against Node 22), and NodeJS.ErrnoException's
    // `string | undefined` understates that. Keeping the spy narrower than
    // reality would force fixtures to misrepresent the errors they simulate.
    err: (Error & { code?: string | number | null; killed?: boolean }) | null,
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
  let clearedBinary: string | undefined;

  beforeEach(() => {
    captured = null;
    // TAILSCALE_BINARY is a first-class supported config of this very package,
    // so an operator (or a sibling describe below, which sets it to
    // process.execPath) can legitimately have it exported. The default-binary
    // assertion in this block pins getBinaryPath's `|| "tailscale"` fallback;
    // without this delete an ambient override wins and the test fails for a
    // reason that has nothing to do with the code under test. Snapshot it so
    // the afterEach can put it back -- see there for why the restore loop
    // alone cannot.
    clearedBinary = process.env.TAILSCALE_BINARY;
    delete process.env.TAILSCALE_BINARY;
  });

  afterEach(() => {
    __setExecFileForTests(null);
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
    // The loop walks the CURRENT keys of process.env, so a key the beforeEach
    // DELETED is not among them and never gets restored -- an ambient
    // TAILSCALE_BINARY would stay gone for every later test in this process,
    // including any that relies on the operator's own binary. Reinstate it by
    // hand, and only when it was actually set, so an unset var stays unset
    // rather than becoming the string "undefined".
    if (clearedBinary !== undefined) process.env.TAILSCALE_BINARY = clearedBinary;
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

  it("reports a maxBuffer overflow with an actionable output-size message", async () => {
    // Fixture mirrors what Node 22 actually emits for an overflow, probed
    // directly: a RangeError with code ERR_CHILD_PROCESS_STDIO_MAXBUFFER and
    // `killed`/`signal` BOTH undefined. An earlier version of this test set
    // `killed: true` on the assumption that the overflow kills the child -- it
    // does not, so that fixture asserted against a shape Node never produces.
    //
    // Pre-fix, the overflow fell through to the generic non-zero arm and
    // surfaced Node's bare "stdout maxBuffer length exceeded", naming neither
    // the command nor the limit nor the remedy.
    installFakeExec((_file, _args, _options, cb) => {
      const err = Object.assign(new RangeError("stdout maxBuffer length exceeded"), {
        code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
      });
      setImmediate(() => cb(err, "", ""));
    });
    const res = await runTailscaleCli(["status", "--json"], { parseJson: true });
    assert.equal(res.ok, false);
    assert.match(res.error ?? "", /exceeded the 10 MB output limit/);
    assert.match(res.error ?? "", /no output was captured/);
    // Names the command so the operator knows which call blew the limit.
    assert.match(res.error ?? "", /tailscale status --json/);
    assert.ok(!/timed out/.test(res.error ?? ""), `must not be reported as a timeout, got: ${res.error}`);
    assert.ok(
      !/maxBuffer length exceeded/.test(res.error ?? ""),
      `should replace Node's bare message, got: ${res.error}`,
    );
  });

  it("still reports a genuine timeout as a timeout", async () => {
    // The real timeout shape (probed): `killed: true`, `signal: "SIGTERM"`,
    // and `code` null -- no maxBuffer code. Must keep the timeout wording.
    installFakeExec((_file, _args, _options, cb) => {
      const err = Object.assign(new Error("Command was killed"), {
        code: null,
        killed: true,
        signal: "SIGTERM",
      });
      setImmediate(() => cb(err, "", ""));
    });
    const res = await runTailscaleCli(["status"], { timeoutMs: 250 });
    assert.equal(res.ok, false);
    assert.match(res.error ?? "", /timed out after 250ms/);
    assert.ok(!/output limit/.test(res.error ?? ""));
    assert.equal(res.exitCode, undefined, "a timeout kill produces no exit code");
  });

  it("coerces a Buffer stdout to a string", async () => {
    // local-cli.ts defends against non-string stdout with an explicit String()
    // coercion whose comment cites "a future env-level encoding override or a
    // test injecting Buffer". Nothing injected one, so the defence was unproven.
    installFakeExec((_file, _args, _options, cb) => {
      setImmediate(() => cb(null, Buffer.from("1.74.1\n") as unknown as string, ""));
    });
    const res = await runTailscaleCli(["version"]);
    assert.equal(res.ok, true);
    assert.equal(res.rawBody, "1.74.1\n");
    assert.equal(typeof res.rawBody, "string");
  });

  it("parses JSON from a Buffer stdout", async () => {
    installFakeExec((_file, _args, _options, cb) => {
      setImmediate(() => cb(null, Buffer.from(JSON.stringify({ BackendState: "Running" })) as unknown as string, ""));
    });
    const res = await runTailscaleCli<{ BackendState: string }>(["status", "--json"], { parseJson: true });
    assert.equal(res.ok, true);
    assert.equal(res.data?.BackendState, "Running");
  });

  it("maps a null stdout to the empty string, not the literal 'null'", async () => {
    // The nullish guard exists precisely because String(null) is "null", which
    // would be handed back as if the binary had printed it.
    installFakeExec((_file, _args, _options, cb) => {
      setImmediate(() => cb(null, null as unknown as string, null as unknown as string));
    });
    const res = await runTailscaleCli(["version"]);
    assert.equal(res.ok, true);
    assert.equal(res.rawBody, "");
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

describe("Local CLI binary discovery", () => {
  const { resolveBinary, describeMissingBinary, binaryCandidates, looksLikeWsl } = __localCliInternals;
  const originalBinary = process.env.TAILSCALE_BINARY;
  const nothingExists = () => false;

  beforeEach(() => {
    // Same reason as the runner block: a real TAILSCALE_BINARY in the
    // contributor's environment is legitimate and would win every lookup here.
    delete process.env.TAILSCALE_BINARY;
  });

  afterEach(() => {
    if (originalBinary === undefined) delete process.env.TAILSCALE_BINARY;
    else process.env.TAILSCALE_BINARY = originalBinary;
  });

  it("finds the macOS app-bundle CLI, which no PATH entry points at", () => {
    // The case that makes this more than a nicety: the default macOS install
    // adds nothing to PATH, so a bare lookup finds nothing however Tailscale
    // was installed, and a client launched from the Dock cannot even see the
    // shell alias the docs suggest.
    const bundle = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";
    assert.equal(
      resolveBinary("darwin", (p) => p === bundle),
      bundle,
    );
    assert.equal(
      resolveBinary("darwin", (p) => p === "/opt/homebrew/bin/tailscale"),
      "/opt/homebrew/bin/tailscale",
    );
    // Order matters: with both present the bundle wins, because that is the
    // copy the running GUI daemon belongs to.
    assert.equal(
      resolveBinary("darwin", () => true),
      bundle,
    );
  });

  it("falls back to the bare name so a PATH install still resolves", () => {
    for (const platform of ["darwin", "linux", "win32"]) {
      assert.equal(resolveBinary(platform, nothingExists), "tailscale", `${platform} must keep the PATH fallback`);
    }
  });

  it("prefers TAILSCALE_BINARY over every candidate, and probes nothing when it is set", () => {
    process.env.TAILSCALE_BINARY = "/opt/custom/tailscale";
    let probes = 0;
    const counting = () => {
      probes++;
      return true;
    };
    assert.equal(resolveBinary("darwin", counting), "/opt/custom/tailscale");
    assert.equal(probes, 0, "an explicit override must not be second-guessed by a stat");
  });

  it("never offers tailscale.exe to a Linux process", () => {
    // In WSL that is the only tailscale in reach, Linux cannot exec it, and it
    // answers for the Windows host's tailnet -- so a silent fallthrough would
    // make every tool in this group describe the wrong machine.
    for (const candidate of binaryCandidates("linux")) {
      assert.ok(!candidate.endsWith(".exe"), `${candidate} would report the Windows daemon's tailnet`);
    }
    assert.ok(binaryCandidates("linux").length > 0, "the Linux list is what keeps the .exe out; it cannot be empty");
  });

  it("keeps the three facts an operator needs in every ENOENT message", () => {
    // The assertions the existing runner-level ENOENT case makes, held across
    // all four branches so a platform-specific message cannot quietly drop the
    // escape hatch or the download link.
    const messages = [
      describeMissingBinary("tailscale", false, "linux", false),
      describeMissingBinary("tailscale", false, "darwin", false),
      describeMissingBinary("tailscale", false, "linux", true),
    ];
    for (const message of messages) {
      assert.match(message, /Could not find the 'tailscale' binary/);
      assert.match(message, /tailscale\.com\/download/);
      assert.match(message, /TAILSCALE_BINARY/);
    }
  });

  it("stops blaming PATH when TAILSCALE_BINARY is what failed, and echoes the value", () => {
    // The old message told an operator who had already set TAILSCALE_BINARY to
    // set TAILSCALE_BINARY, blamed a PATH that was never consulted, and never
    // printed the value that did not resolve.
    const message = describeMissingBinary("C:/nope/tailscale.exe", true, "win32", false);
    assert.match(message, /C:\/nope\/tailscale\.exe/, "the failing value is the whole diagnosis");
    assert.match(message, /PATH was never consulted/);
    assert.match(message, /MSYS/, "the /c/... spelling is the sharp edge on Windows");
    assert.ok(!/https:\/\/tailscale\.com\/download/.test(message), "a bad path is not an install problem");
  });

  it("warns a WSL user that tailscale.exe answers for the Windows host", () => {
    const message = describeMissingBinary("tailscale", false, "linux", true);
    assert.match(message, /WINDOWS host's tailnet/);
    assert.match(message, /tailscaled/, "a Linux-side daemon is the actual remedy");
  });

  it("detects WSL from the environment and /proc/version, and nowhere else", () => {
    const wslProc = () => "Linux version 5.15.0-microsoft-standard-WSL2";
    const plainProc = () => "Linux version 6.8.0-generic";
    const originalDistro = process.env.WSL_DISTRO_NAME;
    delete process.env.WSL_DISTRO_NAME;
    try {
      assert.equal(looksLikeWsl("linux", wslProc), true);
      assert.equal(looksLikeWsl("linux", plainProc), false);
      // macOS and Windows never read /proc at all.
      assert.equal(looksLikeWsl("darwin", wslProc), false);
      assert.equal(looksLikeWsl("win32", wslProc), false);
      process.env.WSL_DISTRO_NAME = "Ubuntu";
      assert.equal(looksLikeWsl("linux", plainProc), true, "the distro variable is set in every WSL shell");
    } finally {
      if (originalDistro === undefined) delete process.env.WSL_DISTRO_NAME;
      else process.env.WSL_DISTRO_NAME = originalDistro;
    }
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

  /** Same spy, for the handlers that compose their own message on a failure. */
  function installFailingExec(err: Error & { code?: string | number | null; killed?: boolean }): void {
    const spy: ExecFileSpy = (_file, args, _options, cb) => {
      lastArgs = args;
      setImmediate(() => cb(err, "", ""));
    };
    __setExecFileForTests(spy as unknown as Parameters<typeof __setExecFileForTests>[0]);
  }

  describe("tailscale_local_status", () => {
    // tool.handler is typed as the union of all handler signatures (some take
    // input, some don't). Cast to this tool's variant at the call site; the
    // input is optional, so a bare call has to keep type-checking too.
    type StatusHandler = (input?: { peers?: boolean; activeOnly?: boolean }) => Promise<{
      ok: boolean;
      data?: { BackendState: string };
      error?: string;
    }>;
    const statusHandler = (): StatusHandler =>
      findToolByName(localCliTools, "tailscale_local_status").handler as StatusHandler;

    it("invokes `tailscale status --json` and returns the parsed payload as data", async () => {
      installFakeExec(() => JSON.stringify({ BackendState: "Running" }));
      // Called with NO argument at all, which is what the handler's default
      // parameter is for: the narrowing inputs must not make the bare call a
      // type error here or a crash on `input.peers` at runtime.
      const res = await statusHandler()();
      assert.deepEqual(lastArgs, ["status", "--json"]);
      assert.equal(res.ok, true);
      assert.equal(res.data?.BackendState, "Running");
    });

    it("adds --peers=false when peers is false", async () => {
      // The `=` form, not a separate value: Go's flag package does not read
      // `--peers false` as a boolean flag plus its value.
      installFakeExec(() => JSON.stringify({ BackendState: "Running" }));
      await statusHandler()({ peers: false });
      assert.deepEqual(lastArgs, ["status", "--json", "--peers=false"]);
    });

    it("adds nothing when peers is true, which is the CLI's own default", async () => {
      installFakeExec(() => JSON.stringify({ BackendState: "Running" }));
      await statusHandler()({ peers: true });
      assert.deepEqual(lastArgs, ["status", "--json"]);
    });

    it("adds --active when activeOnly is true", async () => {
      installFakeExec(() => JSON.stringify({ BackendState: "Running" }));
      await statusHandler()({ activeOnly: true });
      assert.deepEqual(lastArgs, ["status", "--json", "--active"]);
    });

    it("adds nothing when activeOnly is false", async () => {
      installFakeExec(() => JSON.stringify({ BackendState: "Running" }));
      await statusHandler()({ activeOnly: false });
      assert.deepEqual(lastArgs, ["status", "--json"]);
    });

    it("sends both flags when both inputs are given", async () => {
      installFakeExec(() => JSON.stringify({ BackendState: "Running" }));
      await statusHandler()({ peers: false, activeOnly: true });
      assert.deepEqual(lastArgs, ["status", "--json", "--peers=false", "--active"]);
    });

    it("names the narrowing inputs when the output limit is what failed", async () => {
      // Fixture shape taken from the runner's own overflow test above: Node 22
      // emits a RangeError with code ERR_CHILD_PROCESS_STDIO_MAXBUFFER and no
      // `killed`. The runner's message ends "narrow the query if the command
      // supports it" -- this command now does, so the handler says with what.
      installFailingExec(
        Object.assign(new RangeError("stdout maxBuffer length exceeded"), {
          code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
        }),
      );
      const res = await statusHandler()({});
      assert.equal(res.ok, false);
      assert.match(res.error ?? "", /exceeded the 10 MB output limit/);
      assert.match(res.error ?? "", /Retry with peers:false or activeOnly:true\./);
    });

    it("names peers:false, and only peers:false, on a timeout", async () => {
      // The premise this case used to carry -- "a timeout is not something
      // --peers=false or --active fixes" -- was half wrong, and contradicted
      // the tool's own description two lines away. `--peers=false` swaps in the
      // peerless status call BEFORE any peer is serialized, so it cuts the work
      // that made the call slow; `--active` filters peers already in hand, so
      // it cannot. A timeout is also the failure a big tailnet reaches first on
      // slow hardware, where the 10 MB buffer is nowhere near full, so leaving
      // the branch unhinted left the one narrowing that helps unsaid.
      installFailingExec(
        Object.assign(new Error("Command was killed"), { code: null, killed: true, signal: "SIGTERM" }),
      );
      const res = await statusHandler()({});
      assert.equal(res.ok, false);
      assert.match(res.error ?? "", /timed out after/);
      assert.match(res.error ?? "", /retry with peers:false/);
      assert.ok(
        !/activeOnly/.test(res.error ?? ""),
        `--active cannot make a slow call finish, so it must not be suggested here, got: ${res.error}`,
      );
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

// Everything above injects a fake execFile, so the actual spawn boundary --
// argv handling, exit codes, stream buffering, and above all the error SHAPES
// Node really produces -- was never exercised. That gap was not theoretical:
// the maxBuffer fixture in this file asserted `killed: true` across two commits
// because no test forced it to agree with reality.
//
// The `tailscale` binary is not present on CI runners or most dev machines, so
// these drive the Node binary already running the suite via TAILSCALE_BINARY
// and `-e` scripts. runTailscaleCli does not care what the binary is; what is
// under test is how it handles the process boundary.
describe("Local CLI runner (real child process)", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    // Explicitly drop any injected fake -- these must hit the real execFile.
    __setExecFileForTests(null);
    process.env.TAILSCALE_BINARY = process.execPath;
  });

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
  });

  it("returns stdout verbatim as rawBody on a clean exit", async () => {
    const res = await runTailscaleCli(["-e", "process.stdout.write('1.74.1\\n')"]);
    assert.equal(res.ok, true);
    assert.equal(res.rawBody, "1.74.1\n");
    assert.equal(res.exitCode, 0);
  });

  it("parses real JSON stdout", async () => {
    const res = await runTailscaleCli<{ BackendState: string }>(
      ["-e", "process.stdout.write(JSON.stringify({BackendState:'Running'}))"],
      { parseJson: true },
    );
    assert.equal(res.ok, true);
    assert.equal(res.data?.BackendState, "Running");
  });

  it("reports a JSON parse failure with the raw output attached", async () => {
    const res = await runTailscaleCli(["-e", "process.stdout.write('not json at all')"], { parseJson: true });
    assert.equal(res.ok, false);
    assert.match(res.error ?? "", /Failed to parse JSON/);
    assert.equal(res.rawBody, "not json at all");
  });

  it("surfaces stderr and the real exit code on a non-zero exit", async () => {
    const res = await runTailscaleCli(["-e", "process.stderr.write('failed to connect\\n'); process.exit(7)"]);
    assert.equal(res.ok, false);
    assert.equal(res.error, "failed to connect");
    assert.equal(res.exitCode, 7, "the numeric exit code must survive the real spawn");
  });

  it("returns the install hint when the binary genuinely does not exist", async () => {
    process.env.TAILSCALE_BINARY = join(tmpdir(), "definitely-not-a-real-tailscale-binary");
    const res = await runTailscaleCli(["version"]);
    assert.equal(res.ok, false);
    assert.match(res.error ?? "", /Could not find the 'tailscale' binary/);
    assert.equal(res.exitCode, undefined, "no exit code -- the process never ran");
  });

  it("kills and reports a real timeout", async () => {
    const res = await runTailscaleCli(["-e", "setTimeout(() => {}, 30000)"], { timeoutMs: 300 });
    assert.equal(res.ok, false);
    assert.match(res.error ?? "", /timed out after 300ms/);
    assert.ok(!/output limit/.test(res.error ?? ""));
  });

  it("reports a real maxBuffer overflow with the output-size message", async () => {
    // ~12 MB against the 10 MB cap, through Node's actual overflow path rather
    // than a hand-built error. This is the test that would have caught the
    // wrong `killed: true` fixture.
    const res = await runTailscaleCli([
      "-e",
      "const c = 'x'.repeat(1024 * 1024); for (let i = 0; i < 12; i++) process.stdout.write(c);",
    ]);
    assert.equal(res.ok, false);
    assert.match(res.error ?? "", /exceeded the 10 MB output limit/);
    assert.ok(!/timed out/.test(res.error ?? ""), `overflow must not read as a timeout, got: ${res.error}`);
  });
});

// The two subcommands below landed in tailscale 1.102.1. They are exercised
// through the injected-exec path (not a real child process) for the same reason
// the other handler tests are: the binary on a dev box or CI runner is usually
// older than that, so a real invocation would test the local install's version
// rather than this package's argv construction.
describe("Local CLI tools requiring tailscale >= 1.102.1", () => {
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
    __setExecFileForTests(spy as unknown as Parameters<typeof __setExecFileForTests>[0]);
  }

  it("tailscale_local_whoami invokes `tailscale whoami` with no extra flags", async () => {
    installFakeExec((file, args, options, cb) => {
      captured = { file, args, options };
      setImmediate(() => cb(null, "you are someone\n", ""));
    });
    const tool = findToolByName(localCliTools, "tailscale_local_whoami");
    // handler is typed as the union of every local-cli handler signature; cast
    // to the no-arg variant at the call site (same pattern as the tests above).
    const handler = tool.handler as () => Promise<{ ok: boolean; rawBody?: string }>;
    const res = await handler();
    // No --json: the flag's availability is unverified across client versions,
    // and passing an unsupported flag would turn a working text response into a
    // hard failure.
    assert.deepEqual(captured?.args, ["whoami"]);
    assert.equal(res.ok, true);
    assert.equal(res.rawBody, "you are someone\n");
  });

  it("tailscale_local_service_list invokes `tailscale service list`", async () => {
    installFakeExec((file, args, options, cb) => {
      captured = { file, args, options };
      setImmediate(() => cb(null, "svc:foo\n", ""));
    });
    const tool = findToolByName(localCliTools, "tailscale_local_service_list");
    const handler = tool.handler as () => Promise<{ ok: boolean }>;
    const res = await handler();
    assert.deepEqual(captured?.args, ["service", "list"]);
    assert.equal(res.ok, true);
  });

  it("surfaces an older client's `unknown subcommand` error verbatim", async () => {
    // The failure an operator on <1.102.1 actually hits. It must reach the agent
    // unmangled so "your client is too old" is distinguishable from "the command
    // ran and failed" -- that is why there is no client-version pre-check in the
    // tool itself.
    installFakeExec((_file, _args, _options, cb) => {
      const err = Object.assign(new Error("Command failed"), { code: 1 });
      setImmediate(() => cb(err, "", "tailscale: unknown subcommand: whoami"));
    });
    const tool = findToolByName(localCliTools, "tailscale_local_whoami");
    const handler = tool.handler as () => Promise<{ ok: boolean; error?: string; exitCode?: number }>;
    const res = await handler();
    assert.equal(res.ok, false);
    assert.match(res.error ?? "", /unknown subcommand: whoami/);
    assert.equal(res.exitCode, 1);
  });

  it("every local CLI tool is marked read-only and non-destructive", () => {
    // Iterates the exported array rather than a hand-listed pair. This started
    // as a check on the two newest tools, which left the other four unpinned --
    // and readOnlyHint is the sole gate for TAILSCALE_READONLY (filterTools
    // drops any tool whose hint is not exactly `true`), so a one-character flip
    // on any of them would silently widen what a read-only deployment exposes.
    // Every tool in this module shells out to the local binary for status and
    // diagnostics only, so read-only is true by construction today; if a
    // mutating local-CLI tool is ever added, this is the assertion that forces
    // the annotation to be a deliberate decision rather than an inherited one.
    for (const tool of localCliTools) {
      assert.equal(tool.annotations.readOnlyHint, true, `${tool.name} must be read-only`);
      assert.equal(tool.annotations.destructiveHint, false, `${tool.name} must not be destructive`);
    }
  });

  it("every local CLI tool runs on the default 30s timeout budget", async () => {
    // No handler in tools/local-cli.ts passes options.timeoutMs, so all six run
    // on local-cli.ts's DEFAULT_TIMEOUT_MS. Every other timeout test in this file
    // names its own value, which left the default's VALUE unpinned: a 30_000 ->
    // 3_000 typo, or a new handler that supplies its own tight budget, would ship
    // green and surface only in production, as `tailscale netcheck --format=json`
    // timing out. That command probes DERP regions serially and is the slowest of
    // the six, so the default is sized for it rather than for status. (Its
    // multi-second envelope is Tailscale's documented behavior, not a figure
    // measured in this repo.)
    const optionsSeen: Array<{ timeout?: number }> = [];
    installFakeExec((_file, _args, options, cb) => {
      optionsSeen.push(options);
      setImmediate(() => cb(null, "{}", ""));
    });

    for (const tool of localCliTools) {
      // No handler here reads `target` except tailscale_ping, and it throws on
      // an invalid one before reaching execFile, which would show up as a short
      // optionsSeen below. tailscale_local_status reads its own inputs off the
      // same object and finds neither, which is the default argv.
      const handler = tool.handler as (input: { target: string }) => Promise<{ ok: boolean }>;
      await handler({ target: "100.64.0.1" });
    }

    assert.equal(
      optionsSeen.length,
      localCliTools.length,
      "every tool must reach execFile -- one that short-circuits leaves its budget unasserted",
    );
    for (const [i, tool] of localCliTools.entries()) {
      const timeout = optionsSeen[i]?.timeout;
      // Floor plus exact pin: the floor survives a deliberate 30s -> 45s widening
      // while still failing the typo, and the equality makes any change to the
      // number a deliberate edit rather than a silent one.
      assert.ok(
        typeof timeout === "number" && timeout >= 15_000,
        `${tool.name} must keep a budget wide enough for a slow netcheck, got ${timeout}`,
      );
      assert.equal(timeout, 30_000, `${tool.name} must run on DEFAULT_TIMEOUT_MS`);
    }
  });
});
