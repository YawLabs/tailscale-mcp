import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
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

      // POST /acl/validate
      if (url.includes("/acl/validate")) {
        return mockFetchResponse(200, {});
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

  it("should exit 1 when ACL deploy fails (ETag mismatch)", async () => {
    const { deployAcl } = await import("./cli.js");

    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (!init?.method || init.method === "GET") {
        return mockFetchResponse(200, '{ "acls": [] }', { etag: '"etag-1"' });
      }
      if (url.includes("/acl/validate")) {
        return mockFetchResponse(200, {});
      }
      // Deploy fails with precondition failed
      return mockFetchResponse(412, { message: "precondition failed, invalid old hash" });
    };

    await assert.rejects(async () => deployAcl(aclFile), /process\.exit/);
    assert.equal(exitCode, 1);
    assert.ok(consoleErrors.some((e) => e.includes("ACL deploy failed")));
  });

  it("should send HuJSON content type for validation and deploy", async () => {
    const { deployAcl } = await import("./cli.js");
    const contentTypes: string[] = [];

    globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string> | undefined;
      if (!init?.method || init.method === "GET") {
        return mockFetchResponse(200, "{}", { etag: '"e"' });
      }
      if (headers?.["Content-Type"]) {
        contentTypes.push(headers["Content-Type"]);
      }
      return mockFetchResponse(200, {});
    };

    await deployAcl(aclFile);

    assert.equal(contentTypes.length, 2);
    assert.equal(contentTypes[0], "application/hujson");
    assert.equal(contentTypes[1], "application/hujson");
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
});
