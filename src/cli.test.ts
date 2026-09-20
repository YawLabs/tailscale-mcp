import assert from "node:assert/strict";
import { execFile, execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

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
    // Remove the whole mkdtemp directory, not just the ACL file inside it.
    // beforeEach mints a fresh dir per test, so unlinking only the file left
    // an empty directory behind on every case -- ~19 per `npm test`, forever,
    // in the OS temp dir.
    //
    // Guarded: if mkdtempSync itself threw, tmpDir is undefined and a bare
    // rmSync would throw ERR_INVALID_ARG_TYPE from afterEach, burying the real
    // setup failure behind a teardown error. `force: true` covers the
    // already-gone case but not the never-assigned one.
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  it("should deploy ACL successfully (happy path)", async () => {
    const { deployAcl } = await import("./cli.js");
    const urls: string[] = [];
    let capturedIfMatch: string | null = null;
    let capturedContentType: string | null = null;
    let capturedBody: string | undefined;
    let validateBody: string | undefined;

    // Overwrite the shared JSON fixture with real HuJSON: the leading `//`
    // comment and the trailing comma are both legal in a Tailscale policy file
    // and neither survives a JSON.parse/JSON.stringify round-trip, so the
    // byte-exact body assertions below catch a re-serialized body as well as an
    // emptied one.
    const policy = `// tailnet policy
{
  "acls": [
    { "action": "accept", "src": ["*"], "dst": ["*:*"] },
  ],
}
`;
    writeFileSync(aclFile, policy);

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
        validateBody = init?.body as string;
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
    // The safety property of deploy-acl: the bytes the API validated are the
    // bytes it then stored, and both are the file's. Every mock in this test
    // answers 200 regardless of what arrives, so nothing else here notices a
    // validate call carrying "" or the tailnet's CURRENT ACL (that is
    // validatePolicy(getRes.rawBody) instead of the policy) -- the run still
    // prints "deployed successfully" and an unvalidated policy goes out.
    const policyBytes = readFileSync(aclFile, "utf-8");
    assert.equal(validateBody, policyBytes, "validate must receive the file's exact bytes");
    assert.equal(capturedBody, validateBody, "the deployed bytes must be the bytes that were validated");
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
    // Exercises the !getRes.etag half of deployAcl's ETag guard. Response is OK
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

  it("should exit 1 when validate returns 200 with an `error` field instead of `message`", async () => {
    // parseValidationError honors `error` as well as `message`. That field is
    // declared contract in cli.ts's own doc comment and mirrored by the MCP
    // update_acl handler, but nothing pinned it, so the arm could have been
    // deleted or inverted with the whole suite green. To be accurate about what
    // this catches: the arm is fail-CLOSED already -- it aborts the deploy -- so
    // the risk is not a live hole but a silent conversion of that arm into a
    // fall-through, which WOULD be fail-open. Mirrors the `message` test above
    // (postCount, not just exit code) because "the deploy POST never fired" is
    // the assertion that actually distinguishes the two outcomes.
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
        return mockFetchResponse(200, '{"error":"acl rule 0: src tag :bar is not defined"}');
      }
      // If we reach here, deploy was called -- that's the bug.
      return mockFetchResponse(200, {});
    };

    await assert.rejects(async () => deployAcl(aclFile), /process\.exit/);
    assert.equal(exitCode, 1);
    // The extracted `error` value must surface, not the raw JSON envelope.
    assert.ok(
      consoleErrors.some(
        (e) =>
          e.includes("ACL validation failed") &&
          e.includes("acl rule 0: src tag :bar is not defined") &&
          !e.includes('{"error"'),
      ),
      `expected the extracted error field, got: ${JSON.stringify(consoleErrors)}`,
    );
    // Only the validate POST should have run; deploy must NOT have been called.
    assert.equal(postCount, 1);
  });

  it("should print the failing user and assertion from the validate `data` array", async () => {
    // openapi.yaml's testsOrValidationFailed example for POST /acl/validate.
    // Before this, the CLI printed "ACL validation failed: test(s) failed" and
    // dropped the array that says which test broke -- the one thing the
    // operator needs to fix the policy.
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
        return mockFetchResponse(200, {
          message: "test(s) failed",
          data: [{ user: "user1@example.com", errors: ['address "2.2.2.2:22": want: Drop, got: Accept'] }],
        });
      }
      return mockFetchResponse(200, {});
    };

    await assert.rejects(async () => deployAcl(aclFile), /process\.exit/);
    assert.equal(exitCode, 1);
    const printed = consoleErrors.join("\n");
    assert.ok(printed.includes("ACL validation failed: test(s) failed"), `got: ${printed}`);
    assert.ok(printed.includes("For user user1@example.com:"), `expected the user line, got: ${printed}`);
    assert.ok(printed.includes("Errors found:"), `expected the errors heading, got: ${printed}`);
    assert.ok(
      printed.includes('- address "2.2.2.2:22": want: Drop, got: Accept'),
      `expected the assertion text, got: ${printed}`,
    );
    // Only the validate POST should have run; deploy must NOT have been called.
    assert.equal(postCount, 1);
  });

  it("should print the warning text and still exit 1 on 'warning(s) found'", async () => {
    // openapi.yaml's validateSCIMGroupsNotSynced example. The warnings policy
    // is unchanged -- a warning still fails the deploy, as it does in upstream's
    // gitops-pusher and the official Go client -- but the operator can now read
    // what the warning was instead of guessing.
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
        return mockFetchResponse(200, {
          message: "warning(s) found",
          data: [
            {
              user: "group:unknown@example.com",
              warnings: ["group is not syncing from SCIM and will be ignored by rules in the policy file"],
            },
          ],
        });
      }
      return mockFetchResponse(200, {});
    };

    await assert.rejects(async () => deployAcl(aclFile), /process\.exit/);
    assert.equal(exitCode, 1);
    const printed = consoleErrors.join("\n");
    assert.ok(printed.includes("ACL validation failed: warning(s) found"), `got: ${printed}`);
    assert.ok(printed.includes("For user group:unknown@example.com:"), `expected the user line, got: ${printed}`);
    assert.ok(printed.includes("Warnings found:"), `expected the warnings heading, got: ${printed}`);
    assert.ok(printed.includes("- group is not syncing from SCIM"), `expected the warning text, got: ${printed}`);
    assert.equal(postCount, 1);
  });

  it("should surface an entry that reports a failure under an unrecognised key", async () => {
    // The spec types the validate `data` items as a bare `object`, so an entry
    // can carry keys the structured renderer does not know. It must reach the
    // operator as JSON rather than being summarised away -- this is also the
    // shape that must never be mistaken for a warnings-only result when
    // --allow-warnings lands.
    const { deployAcl } = await import("./cli.js");

    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (!init?.method || init.method === "GET") {
        return mockFetchResponse(200, '{ "acls": [] }', { etag: '"etag-1"' });
      }
      if (url.includes("/acl/validate")) {
        return mockFetchResponse(200, {
          message: "warning(s) found",
          data: [{ user: "user1@example.com", warnings: ["scim"], failures: ["port 22 unreachable"] }],
        });
      }
      return mockFetchResponse(200, {});
    };

    await assert.rejects(async () => deployAcl(aclFile), /process\.exit/);
    assert.equal(exitCode, 1);
    const printed = consoleErrors.join("\n");
    assert.ok(printed.includes("port 22 unreachable"), `the unknown key must survive, got: ${printed}`);
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

  it("should treat a validate body with an empty message as success and deploy", async () => {
    // Pins the final fall-through of parseValidationError. `message` and `error`
    // are only honored when non-empty, so `{"message":""}` returns undefined and
    // the deploy proceeds. Stated plainly because this is the one fail-OPEN
    // shape in the parser: a body that LOOKS like a diagnostic envelope still
    // deploys. That is the deliberate reading of the contract -- an empty string
    // carries no diagnostic to show the operator, and `{}` has to stay a success
    // body -- but it is exactly the arm a future "any message key means failure"
    // tightening would flip, so it gets a test rather than an assumption.
    const { deployAcl } = await import("./cli.js");
    let deployCalled = false;

    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (!init?.method || init.method === "GET") {
        return mockFetchResponse(200, '{ "acls": [] }', { etag: '"etag-1"' });
      }
      if (url.includes("/acl/validate")) {
        return mockFetchResponse(200, '{"message":""}');
      }
      deployCalled = true;
      return mockFetchResponse(200, {});
    };

    await deployAcl(aclFile);

    assert.ok(deployCalled, "an empty message field must not block the deploy");
    assert.ok(consoleLogs.some((l) => l.includes("deployed successfully")));
  });

  it("should still deploy when validate returns `data` with no message", async () => {
    // Companion to the empty-message case, pinned now that the parser reads
    // `data`: the message is still what decides valid vs invalid, so a body
    // carrying only diagnostics deploys. That matches the official Go client
    // (policyfile.go returns nil when Message is empty) and is the shape no
    // primary source shows the API emitting. Tightening it to fail closed is a
    // behaviour change held back for the release that adds --allow-warnings, so
    // this test exists to be flipped deliberately rather than by accident.
    const { deployAcl } = await import("./cli.js");
    let deployCalled = false;

    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (!init?.method || init.method === "GET") {
        return mockFetchResponse(200, '{ "acls": [] }', { etag: '"etag-1"' });
      }
      if (url.includes("/acl/validate")) {
        return mockFetchResponse(200, '{"data":[{"user":"user1@example.com","warnings":["scim"]}]}');
      }
      deployCalled = true;
      return mockFetchResponse(200, {});
    };

    await deployAcl(aclFile);

    assert.ok(deployCalled, "a messageless body must not block the deploy in this release");
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

  it("should name the failing test when the deploy POST itself is rejected", async () => {
    // A policy can pass validate and still be rejected by POST /acl -- the
    // shape Tailscale's historical api.md documents as "failed test error".
    // deployAcl needs no edit for this: the detail rides in deployRes.error
    // because extractErrorMessage renders the `data` array.
    const { deployAcl } = await import("./cli.js");

    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (!init?.method || init.method === "GET") {
        return mockFetchResponse(200, '{ "acls": [] }', { etag: '"etag-1"' });
      }
      if (url.includes("/acl/validate")) {
        return mockFetchResponse(200, "");
      }
      return mockFetchResponse(400, {
        message: "test(s) failed",
        data: [{ user: "user1@example.com", errors: ['address "user2@example.com:400": want: Accept, got: Drop'] }],
      });
    };

    await assert.rejects(async () => deployAcl(aclFile), /process\.exit/);
    assert.equal(exitCode, 1);
    const printed = consoleErrors.join("\n");
    assert.ok(printed.includes("ACL deploy failed: test(s) failed"), `got: ${printed}`);
    assert.ok(printed.includes("For user user1@example.com:"), `expected the user line, got: ${printed}`);
    assert.ok(
      printed.includes('- address "user2@example.com:400": want: Accept, got: Drop'),
      `expected the assertion text, got: ${printed}`,
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

  it("strips a UTF-8 BOM before the policy reaches either request", async () => {
    // Every PowerShell redirect writes EF BB BF -- `Out-File`, `Set-Content
    // -Encoding utf8` and plain `>` on 5.1 -- so a policy file authored on
    // Windows usually has one. Sent verbatim it sits ahead of the first `{`,
    // and the API's rejection does not name it, so the file looks right in
    // every editor and fails anyway. Asserted on BOTH requests: validating
    // stripped bytes and then deploying unstripped ones would be worse than
    // sending the BOM twice.
    const { deployAcl } = await import("./cli.js");
    const bodies: string[] = [];
    writeFileSync(aclFile, `﻿{ "acls": [{ "action": "accept", "src": ["*"], "dst": ["*:*"] }] }`);

    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (!init?.method || init.method === "GET") {
        return mockFetchResponse(200, "{}", { etag: '"e"' });
      }
      bodies.push(init.body as string);
      return url.includes("/acl/validate") ? mockFetchResponse(200, "") : mockFetchResponse(200, {});
    };

    await deployAcl(aclFile);

    assert.equal(bodies.length, 2);
    for (const body of bodies) {
      assert.ok(!body.startsWith("﻿"), `the BOM reached the wire: ${JSON.stringify(body.slice(0, 8))}`);
      assert.ok(
        body.startsWith("{"),
        `expected the policy to start at its first brace, got ${JSON.stringify(body.slice(0, 8))}`,
      );
    }
    // The file is otherwise passed through byte for byte.
    assert.equal(bodies[0], readFileSync(aclFile, "utf-8").slice(1));
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
    // Remove the whole mkdtemp directory, not just the ACL file inside it.
    // beforeEach mints a fresh dir per test, so unlinking only the file left
    // an empty directory behind on every case -- ~19 per `npm test`, forever,
    // in the OS temp dir.
    //
    // Guarded: if mkdtempSync itself threw, tmpDir is undefined and a bare
    // rmSync would throw ERR_INVALID_ARG_TYPE from afterEach, burying the real
    // setup failure behind a teardown error. `force: true` covers the
    // already-gone case but not the never-assigned one.
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  it("should validate successfully and never touch the live ACL", async () => {
    const { validateAcl } = await import("./cli.js");
    const urls: string[] = [];
    let validateBody: string | undefined;

    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      urls.push(url);
      if (url.includes("/acl/validate")) {
        validateBody = init?.body as string;
        return mockFetchResponse(200, "{}");
      }
      // Any other endpoint reached (GET /acl, deploy POST) is a contract
      // violation: validate-acl must be safe to run without deploy rights.
      throw new Error(`unexpected request: ${init?.method ?? "GET"} ${url}`);
    };

    await validateAcl(aclFile);

    assert.equal(urls.length, 1);
    assert.ok(urls[0].includes("/acl/validate"));
    // validate-acl issues no second request to compare against, so the file on
    // disk is the only anchor. This mock answers 200 whatever arrives, so an
    // emptied or re-serialized body still prints "ACL policy is valid" for a
    // policy the API never saw.
    assert.equal(validateBody, readFileSync(aclFile, "utf-8"), "validate must send the file's exact bytes");
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

  it("should exit 1 and name the failing test from the `data` array", async () => {
    // The validate-acl half of the deploy-acl case above: this is the command
    // CI runs on a pull request, so the per-user detail is what a reviewer sees.
    const { validateAcl } = await import("./cli.js");

    globalThis.fetch = async () =>
      mockFetchResponse(200, {
        message: "test(s) failed",
        data: [{ user: "user1@example.com", errors: ['address "2.2.2.2:22": want: Drop, got: Accept'] }],
      });

    await assert.rejects(async () => validateAcl(aclFile), /process\.exit/);
    assert.equal(exitCode, 1);
    const printed = consoleErrors.join("\n");
    assert.ok(printed.includes("ACL validation failed: test(s) failed"), `got: ${printed}`);
    assert.ok(printed.includes("For user user1@example.com:"), `expected the user line, got: ${printed}`);
    assert.ok(
      printed.includes('- address "2.2.2.2:22": want: Drop, got: Accept'),
      `expected the assertion text, got: ${printed}`,
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
  // Every spawn in this block resolves the entry from import.meta.url and runs
  // process.execPath, matching the convention index.test.ts and
  // release-metadata.test.ts already document. These used to pass the literal
  // "node" and the cwd-relative "dist/index.js", which worked only because
  // `npm test` happens to start at the repo root and because PATH's `node`
  // happens to be the runtime running the suite -- a version-manager shim or an
  // externally-launched runner breaks either assumption, and this package
  // requires node >= 20.11.0.
  //
  // The compiled test lands in dist/ next to the bundle it spawns, so the entry
  // is a sibling and the repo root is one level up.
  const serverEntry = resolve(dirname(fileURLToPath(import.meta.url)), "index.js");
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const pkg = JSON.parse(readFileSync(resolve(repoRoot, "package.json"), "utf-8")) as { version: string };

  // Whitelisted env rather than `...process.env`, for the reason index.test.ts
  // gives: a TAILSCALE_* var exported by the developer's shell (or leaked by a
  // sibling test) must not be able to reach the child. Most assertions here are
  // env-insensitive, but the no-credentials case at the bottom is not -- with an
  // inherited env it would pass for the wrong reason on any machine that has a
  // real key exported.
  const spawnEnv: Record<string, string> = { PATH: process.env.PATH ?? "" };

  it("should print version with --version flag", () => {
    const result = execFileSync(process.execPath, [serverEntry, "--version"], {
      encoding: "utf-8",
      timeout: 10_000,
      env: spawnEnv,
    }).trim();
    // Equality against package.json, not a /^\d+\.\d+\.\d+$/ shape match: this
    // is the version MCP clients display and the one release.sh and server.json
    // key off, so a stale baked value is exactly the drift worth catching and a
    // shape match would pass straight through it.
    //
    // What this does NOT pin is that esbuild's `define: { __VERSION__ }` is
    // live: index.ts's resolveVersionFallback() reads package.json at runtime
    // and returns the same string, so a dead define still prints the right
    // version here and both version tests stay green. The define itself is
    // pinned against the bundle in release-metadata.test.ts.
    assert.equal(result, pkg.version);
  });

  it("should print version with 'version' subcommand", () => {
    const result = execFileSync(process.execPath, [serverEntry, "version"], {
      encoding: "utf-8",
      timeout: 10_000,
      env: spawnEnv,
    }).trim();
    // Same reasoning as --version above: value, not shape.
    assert.equal(result, pkg.version);
  });

  it("should print version with -V", () => {
    const result = execFileSync(process.execPath, [serverEntry, "-V"], {
      encoding: "utf-8",
      timeout: 10_000,
      env: spawnEnv,
    }).trim();
    assert.equal(result, pkg.version);
  });

  // `help` alongside the two flags: the bareword is the first thing typed at a
  // subcommand CLI, and it used to reach the unknown-arg fall-through and hang
  // on stdio. execFileSync is the assertion for "did not start the server" --
  // a server that came up would never exit and would fail on the 10s timeout
  // rather than returning this stdout at all.
  for (const helpFlag of ["--help", "-h", "help"]) {
    it(`should print usage and exit with ${helpFlag}`, () => {
      const result = execFileSync(process.execPath, [serverEntry, helpFlag], {
        encoding: "utf-8",
        timeout: 10_000,
        env: spawnEnv,
      });
      assert.match(result, /^Usage:/u);
      assert.match(result, /deploy-acl/u);
      assert.match(result, /validate-acl/u);
      assert.match(result, /start the MCP server on stdio/u);
      // Line-anchored, not a bare /version/: the usage prose contains the word
      // "version" in two descriptions, so a substring match stays green with
      // the command and flag lines themselves deleted. Each assertion below
      // pins the line that documents one accepted spelling, which is the thing
      // that actually drifts when a dispatch branch is added or renamed.
      assert.match(result, /^ {2}version {2,}Print the installed version$/mu);
      assert.match(result, /^ {2}help {2,}Print this message$/mu);
      assert.match(result, /^ {2}--version, -V {2,}Print the installed version$/mu);
      assert.match(result, /^ {2}--help, -h {2,}Print this message$/mu);
    });
  }

  // Every spelling the dispatch chain accepts must be documented in USAGE --
  // `-V` in particular is supported but was invisible, which is the gap this
  // closes. Reads the flags out of the rendered block rather than restating
  // them, so a renamed flag fails here instead of silently passing a list that
  // was updated in only one of the two places.
  it("should document every accepted spelling in the usage block", () => {
    const result = execFileSync(process.execPath, [serverEntry, "--help"], {
      encoding: "utf-8",
      timeout: 10_000,
      env: spawnEnv,
    });
    for (const spelling of ["deploy-acl", "validate-acl", "version", "help", "--version", "-V", "--help", "-h"]) {
      assert.ok(result.includes(spelling), `usage block omits "${spelling}": ${JSON.stringify(result)}`);
    }
  });

  // `tailscale-mcp deploy-acl --help` used to take the flag as the policy path
  // and exit 1 on "Failed to read --help: ENOENT ... open '<cwd>/--help'". It
  // is a help request: stdout, exit 0, and the subcommand named so the two arms
  // cannot collapse to one generic line.
  for (const subcommand of ["deploy-acl", "validate-acl"]) {
    for (const helpFlag of ["--help", "-h"]) {
      it(`should print usage and exit 0 for ${subcommand} ${helpFlag}`, () => {
        const result = execFileSync(process.execPath, [serverEntry, subcommand, helpFlag], {
          encoding: "utf-8",
          timeout: 10_000,
          env: spawnEnv,
        });
        assert.equal(result.trim(), `Usage: tailscale-mcp ${subcommand} <path-to-acl.json>`);
      });
    }
  }

  it("should exit 1 with usage message when deploy-acl has no file arg", () => {
    try {
      execFileSync(process.execPath, [serverEntry, "deploy-acl"], {
        encoding: "utf-8",
        timeout: 10_000,
        env: spawnEnv,
      });
      assert.fail("Should have exited with code 1");
    } catch (err: unknown) {
      const e = err as { status: number; stderr: string };
      assert.equal(e.status, 1);
      // Name the subcommand, matching the validate-acl twin below. Both arms
      // interpolate one shared usage template today, so the twin already catches
      // a hardcoded name -- this closes the asymmetry before that single `if`
      // splits into per-subcommand arms and leaves deploy-acl uncovered.
      assert.ok(e.stderr.includes("Usage:") && e.stderr.includes("deploy-acl"));
    }
  });

  it("should exit 1 with usage message when validate-acl has no file arg", () => {
    try {
      execFileSync(process.execPath, [serverEntry, "validate-acl"], {
        encoding: "utf-8",
        timeout: 10_000,
        env: spawnEnv,
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
      execFileSync(process.execPath, [serverEntry, "deploy-acl", "/nonexistent/file.json"], {
        encoding: "utf-8",
        timeout: 10_000,
        // The key is belt-and-braces: deployAcl reads the policy file before it
        // resolves credentials, so the read failure fires either way. Keeping it
        // makes the assertion unambiguous -- the exit is the missing FILE, not a
        // missing key.
        env: { ...spawnEnv, TAILSCALE_API_KEY: "tskey-api-test" },
      });
      assert.fail("Should have exited with code 1");
    } catch (err: unknown) {
      const e = err as { status: number; stderr: string };
      assert.equal(e.status, 1);
      assert.ok(e.stderr.includes("Failed to read"));
    }
  });

  it("should not start the MCP server when a subcommand handles the invocation", () => {
    // Pins the TRUE branch of index.ts's `cliSubcommandHandled` guard: a
    // subcommand ran, so the MCP server must NOT come up. That guard exists for
    // a documented regression -- the subcommand runner is a `.then()` chain
    // rather than a top-level await (esbuild cannot emit TLA for the CJS
    // bundle), so the module body keeps executing synchronously while the
    // promise is pending and used to start a server alongside the deploy.
    //
    // The other subcommand spawns in this block cannot reach the guard: both
    // usage cases exit on the missing argument, and the missing-file case exits
    // inside readPolicyFile. This one hands deploy-acl a file that DOES exist
    // and no credentials, so the run gets past the read and rejects when the
    // auth config comes up empty -- far enough that a removed guard would have
    // printed the "ready (" banner. Auth resolves before the first fetch, so
    // there is no network I/O.
    //
    // spawnSync rather than the execFileSync/try-catch shape above: this needs
    // stderr on BOTH outcomes, and a regressed guard changes how the child
    // exits, not just its code.
    const dir = mkdtempSync(join(tmpdir(), "tailscale-mcp-test-"));
    const file = join(dir, "acl.json");
    writeFileSync(file, '{ "acls": [] }');
    try {
      const res = spawnSync(process.execPath, [serverEntry, "deploy-acl", file], {
        encoding: "utf-8",
        timeout: 10_000,
        env: spawnEnv,
        // EOF on stdin immediately: if the guard ever regresses, the server that
        // should not exist still terminates instead of hanging out the timeout.
        input: "",
      });
      const stderr = res.stderr ?? "";
      assert.equal(res.status, 1, `expected exit 1, got status=${res.status} signal=${res.signal}`);
      assert.match(stderr, /Fatal: No Tailscale credentials configured/);
      assert.ok(
        !stderr.includes("ready ("),
        `a handled subcommand must not start the MCP server, got: ${JSON.stringify(stderr)}`,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("should warn on stderr for an unrecognized argument and still start the server", async () => {
    // Two-sided contract of the unknown-arg branch: (1) the warning names the
    // bad argument so a typo'd subcommand doesn't look like a hang, and (2)
    // the process does NOT exit -- MCP clients may pass extra flags, so the
    // server must still come up (the "ready (" banner is the startup signal).
    // Spawn async, watch stderr for both markers, then kill the child.
    // `resolvePromise`, not `resolve` -- this file now imports `resolve` from
    // node:path for the entry resolution above, and the executor parameter would
    // shadow it. Same rename, same reason, as index.test.ts's captureStartup.
    //
    // (3) is asserted after the await rather than in the settle condition: a
    // missing discovery hint must fail with a readable diff, not by never
    // satisfying the watcher and timing out at 10s with no explanation.
    let stderr = "";
    await new Promise<void>((resolvePromise, reject) => {
      const child = execFile(process.execPath, [serverEntry, "deployacl"], { timeout: 10_000, env: spawnEnv });
      let settled = false;
      const settle = (err?: Error) => {
        if (settled) return;
        settled = true;
        child.kill();
        if (err) reject(err);
        else resolvePromise();
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

    // (3) the warning is the only thing a typo'd invocation ever sees, so it
    // has to name the way out. Without a help spelling in this list the user is
    // told what they typed is wrong and nothing about what to type instead.
    assert.match(stderr, /known subcommands: [^\n]*\bhelp\b/u);
    assert.match(stderr, /--help/u);
  });
});
