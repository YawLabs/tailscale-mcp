import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

function mockFetchResponse(status: number, body: unknown, headers?: Record<string, string>) {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: new Headers(headers),
  });
}

describe("deployAcl", () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = { ...process.env };
  const originalExit = process.exit;
  const originalConsoleError = console.error;
  const originalConsoleLog = console.log;

  let tmpDir: string;
  let aclFile: string;
  let exitCode: number | undefined;
  let consoleErrors: string[];
  let consoleLogs: string[];

  beforeEach(() => {
    process.env.TAILSCALE_API_KEY = "tskey-api-test";
    process.env.TAILSCALE_TAILNET = "test.ts.net";
    exitCode = undefined;
    consoleErrors = [];
    consoleLogs = [];

    // Create temp ACL file
    tmpDir = mkdtempSync(join(tmpdir(), "tailscale-mcp-test-"));
    aclFile = join(tmpDir, "acl.json");
    writeFileSync(aclFile, '{ "acls": [{ "action": "accept", "src": ["*"], "dst": ["*:*"] }] }');

    // Mock process.exit to capture instead of killing test runner
    process.exit = ((code?: number) => {
      exitCode = code ?? 0;
      throw new Error(`process.exit(${code})`);
    }) as never;

    console.error = (...args: unknown[]) => consoleErrors.push(args.join(" "));
    console.log = (...args: unknown[]) => consoleLogs.push(args.join(" "));
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    process.exit = originalExit;
    console.error = originalConsoleError;
    console.log = originalConsoleLog;
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
    try {
      unlinkSync(aclFile);
    } catch {}
  });

  it("should deploy ACL successfully (happy path)", async () => {
    const { deployAcl } = await import("./cli.js");
    const urls: string[] = [];
    let capturedIfMatch: string | null = null;
    let capturedContentType: string | null = null;
    let capturedBody: string | undefined;

    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      urls.push(url);
      const headers = init?.headers as Record<string, string> | undefined;

      // GET /acl — return ETag
      if (init?.method === "GET" || !init?.method) {
        return mockFetchResponse(200, '{ "acls": [] }', { etag: '"acl-etag-123"' });
      }

      // POST /acl/validate — Tailscale returns 200 with `{}` (or an empty body)
      // on a VALID policy, and 200 with `{"message":...}` for an invalid one.
      // Both `{}` and empty mean success; only a message/error field is failure.
      if (url.includes("/acl/validate")) {
        return mockFetchResponse(200, "");
      }

      // POST /acl — deploy
      capturedIfMatch = headers?.["If-Match"] ?? null;
      capturedContentType = headers?.["Content-Type"] ?? null;
      capturedBody = init?.body as string;
      return mockFetchResponse(200, {});
    };

    await deployAcl(aclFile);

    assert.equal(urls.length, 3);
    assert.ok(urls[0].includes("/acl"));
    assert.ok(urls[1].includes("/acl/validate"));
    assert.ok(urls[2].includes("/acl"));
    assert.equal(capturedIfMatch, '"acl-etag-123"');
    assert.equal(capturedContentType, "application/hujson");
    assert.ok(capturedBody?.includes('"acls"'));
    assert.ok(consoleLogs.some((l) => l.includes("deployed successfully")));
  });

  it("should exit 1 when file does not exist", async () => {
    const { deployAcl } = await import("./cli.js");

    await assert.rejects(async () => deployAcl("/nonexistent/acl.json"), /process\.exit/);
    assert.equal(exitCode, 1);
    assert.ok(consoleErrors.some((e) => e.includes("Failed to read")));
  });

  it("should exit 1 when GET ACL fails (no ETag)", async () => {
    const { deployAcl } = await import("./cli.js");

    globalThis.fetch = async () => mockFetchResponse(401, { message: "unauthorized" });

    await assert.rejects(async () => deployAcl(aclFile), /process\.exit/);
    assert.equal(exitCode, 1);
    assert.ok(consoleErrors.some((e) => e.includes("Failed to get current ACL")));
  });

  it("should exit 1 when GET ACL returns 200 but no ETag header", async () => {
    // Exercises the !getRes.etag half of the cli.ts:20 guard. Response is OK
    // but the ETag is missing — without it we can't safely deploy with If-Match.
    const { deployAcl } = await import("./cli.js");

    globalThis.fetch = async () => mockFetchResponse(200, '{ "acls": [] }');

    await assert.rejects(async () => deployAcl(aclFile), /process\.exit/);
    assert.equal(exitCode, 1);
    assert.ok(
      consoleErrors.some((e) => e.includes("Failed to get current ACL") && e.includes("no ETag returned")),
      `expected 'no ETag returned' in errors, got: ${JSON.stringify(consoleErrors)}`,
    );
  });

  it("should exit 1 when ACL validation fails", async () => {
    const { deployAcl } = await import("./cli.js");

    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      // First call: GET /acl — success with ETag
      if (!init?.method || init.method === "GET") {
        return mockFetchResponse(200, '{ "acls": [] }', { etag: '"etag-1"' });
      }
      // Second call: POST /acl/validate — fail
      if (url.includes("/acl/validate")) {
        return mockFetchResponse(400, { message: "invalid ACL: missing groups" });
      }
      return mockFetchResponse(200, {});
    };

    await assert.rejects(async () => deployAcl(aclFile), /process\.exit/);
    assert.equal(exitCode, 1);
    assert.ok(consoleErrors.some((e) => e.includes("ACL validation failed")));
  });

  it("should exit 1 when validate returns 200 with diagnostics body", async () => {
    const { deployAcl } = await import("./cli.js");
    let postCount = 0;

    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (!init?.method || init.method === "GET") {
        return mockFetchResponse(200, '{ "acls": [] }', { etag: '"etag-1"' });
      }
      if (init.method === "POST") {
        postCount++;
      }
      // Validate returns 200 but with diagnostics in the body — the API does
      // this for some invalid policies. deployAcl must treat it as failure.
      if (url.includes("/acl/validate")) {
        return mockFetchResponse(200, '{"message":"acl rule 0: dst tag :foo is not defined"}');
      }
      // If we reach here, deploy was called — that's the bug.
      return mockFetchResponse(200, {});
    };

    await assert.rejects(async () => deployAcl(aclFile), /process\.exit/);
    assert.equal(exitCode, 1);
    // The error should surface the extracted .message, not the raw JSON envelope.
    assert.ok(
      consoleErrors.some(
        (e) =>
          e.includes("ACL validation failed") &&
          e.includes("acl rule 0: dst tag :foo is not defined") &&
          !e.includes('{"message"'),
      ),
      `expected friendly message, got: ${JSON.stringify(consoleErrors)}`,
    );
    // Only the validate POST should have run; deploy must NOT have been called.
    assert.equal(postCount, 1);
  });

  it("should exit 1 when validate returns 200 with a non-object JSON body", async () => {
    // parseValidationError treats a JSON value that parses to a non-object
    // (array/string/number) as an unexpected diagnostic and returns the raw
    // text => deployAcl must fail closed and NOT proceed to deploy.
    const { deployAcl } = await import("./cli.js");
    let postCount = 0;

    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (!init?.method || init.method === "GET") {
        return mockFetchResponse(200, '{ "acls": [] }', { etag: '"etag-1"' });
      }
      if (init.method === "POST") {
        postCount++;
      }
      if (url.includes("/acl/validate")) {
        // A JSON array — parses successfully but is not an object.
        return mockFetchResponse(200, '["unexpected"]');
      }
      // If we reach here, deploy was called — that's the bug.
      return mockFetchResponse(200, {});
    };

    await assert.rejects(async () => deployAcl(aclFile), /process\.exit/);
    assert.equal(exitCode, 1);
    assert.ok(
      consoleErrors.some((e) => e.includes("ACL validation failed") && e.includes('["unexpected"]')),
      `expected raw non-object body surfaced, got: ${JSON.stringify(consoleErrors)}`,
    );
    // Only the validate POST should have run; deploy must NOT have been called.
    assert.equal(postCount, 1);
  });

  it("should exit 1 when validate returns 200 with an unparseable (non-JSON) body", async () => {
    // parseValidationError's JSON.parse throws on non-JSON text; the catch
    // returns the raw text => deployAcl must fail closed and NOT deploy.
    const { deployAcl } = await import("./cli.js");
    let postCount = 0;

    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (!init?.method || init.method === "GET") {
        return mockFetchResponse(200, '{ "acls": [] }', { etag: '"etag-1"' });
      }
      if (init.method === "POST") {
        postCount++;
      }
      if (url.includes("/acl/validate")) {
        // Plain text — JSON.parse throws, catch returns the raw body.
        return mockFetchResponse(200, "line 5: syntax error");
      }
      // If we reach here, deploy was called — that's the bug.
      return mockFetchResponse(200, {});
    };

    await assert.rejects(async () => deployAcl(aclFile), /process\.exit/);
    assert.equal(exitCode, 1);
    assert.ok(
      consoleErrors.some((e) => e.includes("ACL validation failed") && e.includes("line 5: syntax error")),
      `expected raw unparseable body surfaced, got: ${JSON.stringify(consoleErrors)}`,
    );
    // Only the validate POST should have run; deploy must NOT have been called.
    assert.equal(postCount, 1);
  });

  it("should treat a {} validate body as success and proceed to deploy", async () => {
    // Regression: Tailscale's /acl/validate returns 200 with `{}` on a VALID
    // policy, NOT an empty body. The earlier guard treated any non-empty body
    // as failure, so `{}` aborted the deploy with "ACL validation failed: {}".
    // A `{}` validate response must let the deploy proceed.
    const { deployAcl } = await import("./cli.js");
    let deployCalled = false;

    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (!init?.method || init.method === "GET") {
        return mockFetchResponse(200, '{ "acls": [] }', { etag: '"etag-1"' });
      }
      if (url.includes("/acl/validate")) {
        return mockFetchResponse(200, "{}");
      }
      deployCalled = true;
      return mockFetchResponse(200, {});
    };

    await deployAcl(aclFile);

    assert.ok(deployCalled, "deploy must run when validate returns {}");
    assert.ok(consoleLogs.some((l) => l.includes("deployed successfully")));
  });

  it("should exit 1 when ACL deploy fails (ETag mismatch)", async () => {
    const { deployAcl } = await import("./cli.js");

    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (!init?.method || init.method === "GET") {
        return mockFetchResponse(200, '{ "acls": [] }', { etag: '"etag-1"' });
      }
      if (url.includes("/acl/validate")) {
        return mockFetchResponse(200, "");
      }
      // Deploy fails with precondition failed
      return mockFetchResponse(412, { message: "precondition failed, invalid old hash" });
    };

    await assert.rejects(async () => deployAcl(aclFile), /process\.exit/);
    assert.equal(exitCode, 1);
    // A 412 means If-Match rejected the deploy -- the message must name the
    // concurrent-edit cause and the re-run remedy, not just echo the API body.
    assert.ok(
      consoleErrors.some(
        (e) => e.includes("ACL deploy failed") && e.includes("concurrent edit") && e.includes("Re-run"),
      ),
      `expected actionable 412 message, got: ${JSON.stringify(consoleErrors)}`,
    );
    assert.ok(consoleErrors.some((e) => e.includes("precondition failed, invalid old hash")));
  });

  it("should keep the plain error message for non-412 deploy failures", async () => {
    const { deployAcl } = await import("./cli.js");

    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (!init?.method || init.method === "GET") {
        return mockFetchResponse(200, '{ "acls": [] }', { etag: '"etag-1"' });
      }
      if (url.includes("/acl/validate")) {
        return mockFetchResponse(200, "");
      }
      return mockFetchResponse(500, { message: "internal error" });
    };

    await assert.rejects(async () => deployAcl(aclFile), /process\.exit/);
    assert.equal(exitCode, 1);
    assert.ok(
      consoleErrors.some((e) => e.includes("ACL deploy failed") && !e.includes("concurrent edit")),
      `expected plain failure message without the 412 hint, got: ${JSON.stringify(consoleErrors)}`,
    );
  });

  it("should send HuJSON content type for validation and deploy", async () => {
    const { deployAcl } = await import("./cli.js");
    const contentTypes: string[] = [];

    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const headers = init?.headers as Record<string, string> | undefined;
      if (!init?.method || init.method === "GET") {
        return mockFetchResponse(200, "{}", { etag: '"e"' });
      }
      if (headers?.["Content-Type"]) {
        contentTypes.push(headers["Content-Type"]);
      }
      // Validate must return empty body to indicate success.
      if (url.includes("/acl/validate")) {
        return mockFetchResponse(200, "");
      }
      return mockFetchResponse(200, {});
    };

    await deployAcl(aclFile);

    assert.equal(contentTypes.length, 2);
    assert.equal(contentTypes[0], "application/hujson");
    assert.equal(contentTypes[1], "application/hujson");
  });
});

describe("validateAcl", () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = { ...process.env };
  const originalExit = process.exit;
  const originalConsoleError = console.error;
  const originalConsoleLog = console.log;

  let tmpDir: string;
  let aclFile: string;
  let exitCode: number | undefined;
  let consoleErrors: string[];
  let consoleLogs: string[];

  beforeEach(() => {
    process.env.TAILSCALE_API_KEY = "tskey-api-test";
    process.env.TAILSCALE_TAILNET = "test.ts.net";
    exitCode = undefined;
    consoleErrors = [];
    consoleLogs = [];

    tmpDir = mkdtempSync(join(tmpdir(), "tailscale-mcp-test-"));
    aclFile = join(tmpDir, "acl.json");
    writeFileSync(aclFile, '{ "acls": [{ "action": "accept", "src": ["*"], "dst": ["*:*"] }] }');

    process.exit = ((code?: number) => {
      exitCode = code ?? 0;
      throw new Error(`process.exit(${code})`);
    }) as never;

    console.error = (...args: unknown[]) => consoleErrors.push(args.join(" "));
    console.log = (...args: unknown[]) => consoleLogs.push(args.join(" "));
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    process.exit = originalExit;
    console.error = originalConsoleError;
    console.log = originalConsoleLog;
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
    try {
      unlinkSync(aclFile);
    } catch {}
  });

  it("should validate successfully and never touch the live ACL", async () => {
    const { validateAcl } = await import("./cli.js");
    const urls: string[] = [];

    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      urls.push(url);
      if (url.includes("/acl/validate")) {
        return mockFetchResponse(200, "{}");
      }
      // Any other endpoint reached (GET /acl, deploy POST) is a contract
      // violation: validate-acl must be safe to run without deploy rights.
      throw new Error(`unexpected request: ${init?.method ?? "GET"} ${url}`);
    };

    await validateAcl(aclFile);

    assert.equal(urls.length, 1);
    assert.ok(urls[0].includes("/acl/validate"));
    assert.ok(consoleLogs.some((l) => l.includes("ACL policy is valid")));
  });

  it("should exit 1 with the diagnostic when the policy is invalid", async () => {
    const { validateAcl } = await import("./cli.js");

    globalThis.fetch = async () => mockFetchResponse(200, '{"message":"acl rule 0: dst tag :foo is not defined"}');

    await assert.rejects(async () => validateAcl(aclFile), /process\.exit/);
    assert.equal(exitCode, 1);
    assert.ok(
      consoleErrors.some(
        (e) => e.includes("ACL validation failed") && e.includes("acl rule 0: dst tag :foo is not defined"),
      ),
      `expected validation diagnostic, got: ${JSON.stringify(consoleErrors)}`,
    );
  });

  it("should exit 1 when the validate request itself fails", async () => {
    const { validateAcl } = await import("./cli.js");

    globalThis.fetch = async () => mockFetchResponse(400, { message: "invalid ACL: missing groups" });

    await assert.rejects(async () => validateAcl(aclFile), /process\.exit/);
    assert.equal(exitCode, 1);
    assert.ok(consoleErrors.some((e) => e.includes("ACL validation failed")));
  });

  it("should exit 1 when file does not exist", async () => {
    const { validateAcl } = await import("./cli.js");

    await assert.rejects(async () => validateAcl("/nonexistent/acl.json"), /process\.exit/);
    assert.equal(exitCode, 1);
    assert.ok(consoleErrors.some((e) => e.includes("Failed to read")));
  });
});

describe("CLI subcommands", () => {
  it("should print version with --version flag", () => {
    const result = execFileSync("node", ["dist/index.js", "--version"], {
      encoding: "utf-8",
      timeout: 10_000,
    }).trim();
    assert.ok(result.length > 0);
    assert.match(result, /^\d+\.\d+\.\d+$/);
  });

  it("should print version with 'version' subcommand", () => {
    const result = execFileSync("node", ["dist/index.js", "version"], {
      encoding: "utf-8",
      timeout: 10_000,
    }).trim();
    assert.match(result, /^\d+\.\d+\.\d+$/);
  });

  it("should exit 1 with usage message when deploy-acl has no file arg", () => {
    try {
      execFileSync("node", ["dist/index.js", "deploy-acl"], {
        encoding: "utf-8",
        timeout: 10_000,
      });
      assert.fail("Should have exited with code 1");
    } catch (err: unknown) {
      const e = err as { status: number; stderr: string };
      assert.equal(e.status, 1);
      assert.ok(e.stderr.includes("Usage:"));
    }
  });

  it("should exit 1 with usage message when validate-acl has no file arg", () => {
    try {
      execFileSync("node", ["dist/index.js", "validate-acl"], {
        encoding: "utf-8",
        timeout: 10_000,
      });
      assert.fail("Should have exited with code 1");
    } catch (err: unknown) {
      const e = err as { status: number; stderr: string };
      assert.equal(e.status, 1);
      assert.ok(e.stderr.includes("Usage:") && e.stderr.includes("validate-acl"));
    }
  });

  it("should exit 1 when deploy-acl file does not exist", () => {
    try {
      execFileSync("node", ["dist/index.js", "deploy-acl", "/nonexistent/file.json"], {
        encoding: "utf-8",
        timeout: 10_000,
        env: { ...process.env, TAILSCALE_API_KEY: "tskey-api-test" },
      });
      assert.fail("Should have exited with code 1");
    } catch (err: unknown) {
      const e = err as { status: number; stderr: string };
      assert.equal(e.status, 1);
      assert.ok(e.stderr.includes("Failed to read"));
    }
  });

  it("should warn on stderr for an unrecognized argument and still start the server", async () => {
    // Two-sided contract of the unknown-arg branch: (1) the warning names the
    // bad argument so a typo'd subcommand doesn't look like a hang, and (2)
    // the process does NOT exit -- MCP clients may pass extra flags, so the
    // server must still come up (the "ready (" banner is the startup signal).
    // Spawn async, watch stderr for both markers, then kill the child.
    await new Promise<void>((resolve, reject) => {
      const child = execFile("node", ["dist/index.js", "deployacl"], { timeout: 10_000 });
      let stderr = "";
      let settled = false;
      const settle = (err?: Error) => {
        if (settled) return;
        settled = true;
        child.kill();
        if (err) reject(err);
        else resolve();
      };
      child.stderr?.setEncoding("utf8");
      child.stderr?.on("data", (chunk: string) => {
        stderr += chunk;
        if (stderr.includes('unrecognized argument "deployacl"') && stderr.includes("ready (")) {
          settle();
        }
      });
      child.on("error", (err) => settle(err));
      child.on("exit", () => {
        settle(new Error(`server exited before the warning + ready banner appeared; stderr so far: ${stderr}`));
      });
    });
  });
});
