/**
 * Integration tests that hit the real Tailscale API.
 *
 * Gated behind RUN_INTEGRATION_TESTS=1 AND live credentials
 * (TAILSCALE_API_KEY or TAILSCALE_OAUTH_CLIENT_ID + TAILSCALE_OAUTH_CLIENT_SECRET).
 * Without the flag the entire suite is skipped -- so `npm test` in normal
 * development and PR CI remains fully offline. With the flag set but no
 * credentials the suite FAILS (see the credential-check describe below) instead
 * of skipping green.
 *
 * NOT read-only. Read this before choosing which tailnet to point it at:
 *
 *   - "Integration: real Tailscale API (read-only)" issues GETs only and is safe
 *     against any tailnet, production included.
 *   - "Integration: tailscale_create_key keyType=client round-trip" and its
 *     keyType=federated twin each MINT A REAL CREDENTIAL in the target tailnet
 *     (POST /tailnet/{tailnet}/keys) and delete it again in a `finally`. They sit
 *     behind the SAME RUN_INTEGRATION_TESTS=1 gate as the read-only suite, so the
 *     command below runs them too. If the process dies between create and delete,
 *     or the delete call fails, a live OAuth client / federated identity is left
 *     behind in that tailnet. Use a dedicated test tailnet, not production.
 *
 * Precondition: the target tailnet must have at least one device and at least one
 * key. Element-level shape drift is what this suite exists to catch, and an empty
 * tailnet would let every list assertion pass without inspecting a single field,
 * so the empty case fails loudly rather than passing silently.
 *
 * Run locally (bash):
 *   RUN_INTEGRATION_TESTS=1 TAILSCALE_API_KEY=tskey-api-... npm test
 *
 * There is no CI workflow for this suite (the repo runs no CI) -- run it
 * manually when you need API-shape-drift coverage.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

const CREDENTIAL_VARS = ["TAILSCALE_API_KEY", "TAILSCALE_OAUTH_CLIENT_ID", "TAILSCALE_OAUTH_CLIENT_SECRET"];

const hasCredentials =
  !!process.env.TAILSCALE_API_KEY ||
  (!!process.env.TAILSCALE_OAUTH_CLIENT_ID && !!process.env.TAILSCALE_OAUTH_CLIENT_SECRET);

const optedIn = process.env.RUN_INTEGRATION_TESTS === "1";
const runIntegration = optedIn && hasCredentials;

type ApiResult<T> = {
  ok: boolean;
  status?: number;
  data?: T;
  rawBody?: string;
  etag?: string;
  error?: string;
};

// Minimal element shapes for the list assertions below. The fields are typed
// `unknown` on purpose: the tests assert the RUNTIME type, and declaring `string`
// here would let a live shape change type-check clean.
type DeviceElement = { id?: unknown; addresses?: unknown };
type KeyElement = { id?: unknown };

/**
 * RUN_INTEGRATION_TESTS=1 with a missing or misspelled credential variable used
 * to skip all three describes below and still report success. node:test does
 * print a `# SKIP` line per skipped suite, but the run summary counts skipped
 * TESTS, and the `it`s inside a skipped describe never register -- so the summary
 * an operator actually reads says `fail 0` AND `skipped 0` after zero live
 * requests were made. An explicit opt-in that degrades to a silent no-op is worse
 * than no opt-in at all, so fail here and name the variables that are unset.
 */
describe("Integration: opt-in without credentials", { skip: !(optedIn && !hasCredentials) }, () => {
  it("RUN_INTEGRATION_TESTS=1 requires live credentials", () => {
    const unset = CREDENTIAL_VARS.filter((name) => !process.env[name]).join(", ");
    assert.fail(
      `RUN_INTEGRATION_TESTS=1 is set but no live credentials were found (unset: ${unset}). ` +
        "Set TAILSCALE_API_KEY, or both TAILSCALE_OAUTH_CLIENT_ID and TAILSCALE_OAUTH_CLIENT_SECRET, " +
        "or unset RUN_INTEGRATION_TESTS to skip the integration suite.",
    );
  });
});

describe("Integration: real Tailscale API (read-only)", { skip: !runIntegration }, () => {
  it("tailscale_status returns tailnet, deviceCount, and connected flag", async () => {
    const { statusTools } = await import("./tools/status.js");
    const tool = statusTools.find((t) => t.name === "tailscale_status");
    assert.ok(tool, "tailscale_status tool not found");
    const handler = tool.handler as () => Promise<
      ApiResult<{
        connected: boolean;
        deviceCount: number;
        tailnet: string;
        settings?: unknown;
        errors?: Record<string, string>;
      }>
    >;
    const result = await handler();
    assert.equal(result.ok, true, `API call failed: ${result.error ?? "(no error)"}`);
    assert.equal(typeof result.data?.tailnet, "string");
    assert.equal(typeof result.data?.connected, "boolean");
    assert.equal(typeof result.data?.deviceCount, "number");
    // The handler fires /devices and /settings in parallel and only fast-fails
    // when BOTH fail, so a settings-only 404 / scope error / shape change still
    // returns ok:true and records itself in data.errors. Every assertion above is
    // devices-side (deviceCount already catches a devices-only failure), so
    // without this line a settings-side failure -- exactly the drift this suite
    // exists to catch -- was invisible. The errors bag is the handler's own drift
    // signal, and it was being discarded.
    assert.equal(result.data?.errors, undefined, JSON.stringify(result.data?.errors));
    // Settings-side counterpart to the deviceCount check: a 200 with an empty body
    // leaves settings null without populating errors. assert.ok, not
    // `typeof === "object"` -- typeof null is "object", so the typeof form would
    // pass on the very failure path it is meant to catch.
    assert.ok(result.data?.settings, "expected data.settings to be populated");
  });

  it("tailscale_list_devices returns devices with element shape intact", async () => {
    const { deviceTools } = await import("./tools/devices.js");
    const tool = deviceTools.find((t) => t.name === "tailscale_list_devices");
    assert.ok(tool, "tailscale_list_devices tool not found");
    const handler = tool.handler as (input: { fields?: string }) => Promise<ApiResult<{ devices?: DeviceElement[] }>>;
    const result = await handler({});
    assert.equal(result.ok, true, `API call failed: ${result.error ?? "(no error)"}`);
    const devices = result.data?.devices;
    assert.ok(Array.isArray(devices), "expected data.devices to be an array");
    // Array.isArray alone catches container-level drift (field rename, non-array)
    // but passes on an empty tailnet without ever touching an element -- and
    // element shape is precisely the drift fetch mocks cannot catch. Fail rather
    // than skip on empty: a skip reads in the summary as coverage that never ran.
    assert.ok(devices.length > 0, "expected at least one device -- this suite requires a non-empty test tailnet");
    const device = devices[0];
    assert.equal(typeof device.id, "string", `expected device.id to be a string, got ${typeof device.id}`);
    const addresses = device.addresses;
    assert.ok(Array.isArray(addresses), "expected device.addresses to be an array");
    assert.equal(typeof addresses[0], "string", "expected device.addresses[0] to be a string");
  });

  it("tailscale_list_keys (all=true) returns keys with element shape intact", async () => {
    const { keyTools } = await import("./tools/keys.js");
    const tool = keyTools.find((t) => t.name === "tailscale_list_keys");
    assert.ok(tool, "tailscale_list_keys tool not found");
    const handler = tool.handler as (input: { all?: boolean }) => Promise<ApiResult<{ keys?: KeyElement[] }>>;
    // all:true, not {} -- the default query sends no `all` parameter and so lists
    // auth keys only, which means the OAuth-client and federated-identity shapes
    // the round-trip describes below create were never in the body this test
    // inspected. A 403 here on the OAuth credential path means the client's scopes
    // do not cover the broader query: a permissions failure, not shape drift.
    const result = await handler({ all: true });
    assert.equal(result.ok, true, `API call failed: ${result.error ?? "(no error)"}`);
    const keys = result.data?.keys;
    assert.ok(Array.isArray(keys), "expected data.keys to be an array");
    // Same reasoning as the devices test: the container check passes on an empty
    // tailnet, so require an element and actually look at it.
    assert.ok(keys.length > 0, "expected at least one key -- this suite requires a tailnet with at least one key");
    const key = keys[0];
    assert.equal(typeof key.id, "string", `expected key.id to be a string, got ${typeof key.id}`);
  });

  it("tailscale_get_acl returns non-empty HuJSON body with ETag marker", async () => {
    const { aclTools } = await import("./tools/acl.js");
    const tool = aclTools.find((t) => t.name === "tailscale_get_acl");
    assert.ok(tool, "tailscale_get_acl tool not found");
    const handler = tool.handler as () => Promise<ApiResult<unknown>>;
    const result = await handler();
    assert.equal(result.ok, true, `API call failed: ${result.error ?? "(no error)"}`);
    assert.equal(typeof result.rawBody, "string");
    // The handler appends a five-line `// ETag:` footer to rawBody whenever the
    // response is ok and carries an ETag, so a bare `rawBody.length > 0` check was
    // satisfied by the handler's own footer and stayed green on an empty policy
    // body. Split at the footer and assert the part the live API actually sent.
    // Non-empty is the only structural claim made here: HuJSON policies commonly
    // open with a `//` comment block, so a `startsWith("{")` check would
    // false-fail on real tailnets.
    const body = (result.rawBody ?? "").split("\n// ETag:")[0].trim();
    assert.ok(body.length > 0, "expected non-empty ACL body before the ETag footer");
    // Kept as a live-API signal the mocked unit coverage cannot give: the unit test
    // hand-sets the etag response header, so it can never see a real API that
    // stops sending one (no header -> no footer -> this regex fails).
    assert.match(result.rawBody ?? "", /ETag:\s*\S+/);
    // The parsed field tailscale_update_acl actually consumes as If-Match; the
    // footer above is only a human-readable copy of it.
    assert.equal(typeof result.etag, "string");
  });
});

describe("Integration: tailscale_create_key keyType=client round-trip", { skip: !runIntegration }, () => {
  // MUTATES the target tailnet: mints a real OAuth client and deletes it again.
  // See the file header -- this runs under the same RUN_INTEGRATION_TESTS=1 gate
  // as the read-only suite above, so "safe against production" does not apply.
  it("creates an OAuth client key and immediately deletes it", async () => {
    const { keyTools } = await import("./tools/keys.js");

    const createTool = keyTools.find((t) => t.name === "tailscale_create_key");
    assert.ok(createTool, "tailscale_create_key tool not found");
    const createHandler = createTool.handler as (input: {
      keyType?: "auth" | "client" | "federated";
      description?: string;
      scopes?: string[];
      tags?: string[];
    }) => Promise<ApiResult<{ id?: string }>>;

    const deleteTool = keyTools.find((t) => t.name === "tailscale_delete_key");
    assert.ok(deleteTool, "tailscale_delete_key tool not found");
    const deleteHandler = deleteTool.handler as (input: { keyId: string }) => Promise<ApiResult<unknown>>;

    const createResult = await createHandler({
      keyType: "client",
      scopes: ["devices:read"],
      description: "ci-smoke-client",
    });
    const keyId = createResult.data?.id;

    try {
      assert.equal(
        createResult.ok,
        true,
        `tailscale_create_key (client) failed: ${createResult.error ?? "(no error)"}`,
      );
      assert.ok(keyId, "expected response data to contain an id");
    } finally {
      if (keyId) {
        const deleteResult = await deleteHandler({ keyId });
        assert.equal(
          deleteResult.ok,
          true,
          `tailscale_delete_key (client) failed: ${deleteResult.error ?? "(no error)"}`,
        );
      }
    }
  });
});

describe("Integration: tailscale_create_key keyType=federated round-trip", { skip: !runIntegration }, () => {
  // MUTATES the target tailnet: mints a real federated identity and deletes it
  // again. Same gate as above -- see the file header.
  it("creates a federated identity key and immediately deletes it", async () => {
    const { keyTools } = await import("./tools/keys.js");

    const createTool = keyTools.find((t) => t.name === "tailscale_create_key");
    assert.ok(createTool, "tailscale_create_key tool not found");
    const createHandler = createTool.handler as (input: {
      keyType?: "auth" | "client" | "federated";
      description?: string;
      scopes?: string[];
      issuer?: string;
      subject?: string;
      audience?: string;
    }) => Promise<ApiResult<{ id?: string }>>;

    const deleteTool = keyTools.find((t) => t.name === "tailscale_delete_key");
    assert.ok(deleteTool, "tailscale_delete_key tool not found");
    const deleteHandler = deleteTool.handler as (input: { keyId: string }) => Promise<ApiResult<unknown>>;

    const createResult = await createHandler({
      keyType: "federated",
      scopes: ["devices:read"],
      issuer: "https://token.actions.githubusercontent.com",
      subject: "repo:YawLabs/tailscale-mcp:ref:refs/heads/test-smoke-do-not-merge",
      audience: "sts.tailscale.com",
      description: "ci-smoke-fed",
    });
    const keyId = createResult.data?.id;

    try {
      assert.equal(
        createResult.ok,
        true,
        `tailscale_create_key (federated) failed: ${createResult.error ?? "(no error)"}`,
      );
      assert.ok(keyId, "expected response data to contain an id");
    } finally {
      if (keyId) {
        const deleteResult = await deleteHandler({ keyId });
        assert.equal(
          deleteResult.ok,
          true,
          `tailscale_delete_key (federated) failed: ${deleteResult.error ?? "(no error)"}`,
        );
      }
    }
  });
});
