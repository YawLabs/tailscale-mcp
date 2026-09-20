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
 * Two gates, because the suite is not all read-only. Read this before choosing
 * which tailnet to point it at:
 *
 *   - RUN_INTEGRATION_TESTS=1 runs the read-only describes. They issue GETs only
 *     (plus /acl/preview, which evaluates and applies nothing) and are safe
 *     against any tailnet, production included.
 *   - RUN_MUTATING_INTEGRATION_TESTS=1, ON TOP of that flag, additionally runs
 *     "Integration: tailscale_create_key keyType=client round-trip" and its
 *     keyType=federated twin. Each MINTS A REAL CREDENTIAL in the target tailnet
 *     (POST /tailnet/{tailnet}/keys) and deletes it again in a `finally`. If the
 *     process dies between create and delete, or the delete call fails, a live
 *     OAuth client / federated identity is left behind in that tailnet. Use a
 *     dedicated test tailnet, not production. They used to sit behind the
 *     read-only flag, which meant asking for shape-drift coverage also minted
 *     credentials -- the second flag is what makes "safe against production"
 *     something an operator can actually choose.
 *
 * Preconditions: the target tailnet must have at least one device, at least one
 * key, and at least one configuration audit entry in the last 29 days. Element-
 * level shape drift is what this suite exists to catch, and an empty tailnet
 * would let every list assertion pass without inspecting a single field, so the
 * empty case fails loudly rather than passing silently.
 *
 * Run locally (bash):
 *   RUN_INTEGRATION_TESTS=1 TAILSCALE_API_KEY=tskey-api-... npm test
 *   RUN_INTEGRATION_TESTS=1 RUN_MUTATING_INTEGRATION_TESTS=1 TAILSCALE_API_KEY=... npm test
 *
 * To run a single describe, build first and pass the pattern to node directly,
 * BEFORE --test (npm test would put it after the file glob, where node ignores
 * it):
 *   npm run build && RUN_INTEGRATION_TESTS=1 node --test-name-pattern="read-only" \
 *     --test dist/integration.test.js
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
const mutatingOptedIn = process.env.RUN_MUTATING_INTEGRATION_TESTS === "1";
const runMutatingIntegration = runIntegration && mutatingOptedIn;

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
// A configuration audit entry carries no `event` field: the value the `event`
// filter takes is composed from target.type, action and (when present)
// target.property. Same `unknown` reasoning as above.
type AuditLogElement = { action?: unknown; target?: { type?: unknown; property?: unknown } };

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

/**
 * Same failure mode as above, one flag along: RUN_MUTATING_INTEGRATION_TESTS=1
 * on its own runs nothing at all, and the summary reads `fail 0` / `skipped 0`
 * exactly as it does after a full green run. Someone who set only the mutating
 * flag asked for the round-trips specifically, so say which variable is missing
 * rather than silently doing nothing.
 */
describe("Integration: mutating opt-in without the base opt-in", { skip: !(mutatingOptedIn && !optedIn) }, () => {
  it("RUN_MUTATING_INTEGRATION_TESTS=1 also requires RUN_INTEGRATION_TESTS=1", () => {
    assert.fail(
      "RUN_MUTATING_INTEGRATION_TESTS=1 is set but RUN_INTEGRATION_TESTS is not 1, so no integration test ran. " +
        "Set both to run the key round-trips, or unset RUN_MUTATING_INTEGRATION_TESTS.",
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

  it("tailscale_get_audit_log accepts a start-only request", async () => {
    // The call shape the OpenAPI spec says cannot work without an `end`, and the
    // one an agent writes by hand ("what changed in the last day?"). The tool
    // now fills `end` in, so this is also the case that would go red if that
    // stopped happening -- no mock can tell us whether the server accepts it.
    const { auditTools } = await import("./tools/audit.js");
    const tool = auditTools.find((t) => t.name === "tailscale_get_audit_log");
    assert.ok(tool, "tailscale_get_audit_log tool not found");
    const handler = tool.handler as (input: {
      start: string;
      end?: string;
      event?: string[];
    }) => Promise<ApiResult<{ logs?: AuditLogElement[] }>>;
    const result = await handler({ start: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString() });
    assert.equal(result.ok, true, `API call failed: ${result.error ?? "(no error)"}`);
    assert.ok(Array.isArray(result.data?.logs), "expected data.logs to be an array");
  });

  it("tailscale_get_audit_log filters server-side on an event taken from an unfiltered pull", async () => {
    // The filter value comes from the tailnet's own history rather than a
    // hard-coded event type, so the case does not depend on what this tailnet
    // happens to have done. That also makes it a real assertion: an empty
    // filtered result fails, because the entry the filter was built from is
    // known to be inside the same window.
    const { auditTools } = await import("./tools/audit.js");
    const tool = auditTools.find((t) => t.name === "tailscale_get_audit_log");
    assert.ok(tool, "tailscale_get_audit_log tool not found");
    const handler = tool.handler as (input: {
      start: string;
      end?: string;
      event?: string[];
    }) => Promise<ApiResult<{ logs?: AuditLogElement[] }>>;

    // 29 days, not 30: the window is measured against a clock that keeps moving
    // while the request is in flight, and the API rejects anything over 30.
    const start = new Date(Date.now() - 29 * 24 * 60 * 60 * 1000).toISOString();
    const unfiltered = await handler({ start });
    assert.equal(unfiltered.ok, true, `unfiltered pull failed: ${unfiltered.error ?? "(no error)"}`);
    const logs = unfiltered.data?.logs ?? [];
    assert.ok(
      logs.length > 0,
      "expected at least one audit entry in the last 29 days -- this suite requires a tailnet with configuration history",
    );

    const compose = (entry: AuditLogElement) =>
      [entry.target?.type, entry.action, entry.target?.property].filter(Boolean).join(".");
    const filter = compose(logs[0]);
    assert.match(filter, /^[A-Z0-9_]+\.[A-Z0-9_]+/, `could not compose an event value from ${JSON.stringify(logs[0])}`);

    const filtered = await handler({ start, event: [filter] });
    assert.equal(filtered.ok, true, `event=${filter} failed: ${filtered.error ?? "(no error)"}`);
    const matched = filtered.data?.logs ?? [];
    assert.ok(
      matched.length > 0,
      `event=${filter} returned nothing, though an unfiltered pull over the same window contains it -- the filter is not being applied the way this tool sends it`,
    );
    // startsWith, not equality: nothing upstream says whether event=NODE.CREATE
    // also returns the NODE.CREATE.<property> entries, so equality could fail
    // for a reason that is not drift. An entry that does not even share the
    // prefix is an over-match, and that is worth failing on.
    for (const entry of matched) {
      const composed = compose(entry);
      assert.ok(
        composed.startsWith(filter),
        `event=${filter} returned an entry composing to ${composed}: the filter matched more than it was asked for`,
      );
    }
  });

  it("tailscale_get_network_flow_logs returns 200, or the documented 403/404 when the feature is off", async () => {
    // Network flow logs are plan-gated and off by default, so a 403 or a 404 is
    // a real answer from the API rather than a failure to tolerate. Anything
    // else -- a 400 on the start-only shape above all -- is not.
    const { auditTools } = await import("./tools/audit.js");
    const tool = auditTools.find((t) => t.name === "tailscale_get_network_flow_logs");
    assert.ok(tool, "tailscale_get_network_flow_logs tool not found");
    const handler = tool.handler as (input: { start: string; end?: string }) => Promise<ApiResult<{ logs?: unknown }>>;
    const result = await handler({ start: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString() });
    assert.ok(
      [200, 403, 404].includes(result.status ?? 0),
      `unexpected status ${result.status}: ${result.error ?? "(no error)"}`,
    );
    if (result.ok) {
      assert.ok(Array.isArray(result.data?.logs), "expected data.logs to be an array on a 200");
    }
  });
});

describe("Integration: tailscale_create_key keyType=client round-trip", { skip: !runMutatingIntegration }, () => {
  // MUTATES the target tailnet: mints a real OAuth client and deletes it again.
  // See the file header -- this needs RUN_MUTATING_INTEGRATION_TESTS=1 on top of
  // the read-only flag, so "safe against production" does not apply to it.
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

describe("Integration: tailscale_create_key keyType=federated round-trip", { skip: !runMutatingIntegration }, () => {
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

/**
 * The /acl/preview response shape, which tailscale_diff_acl_access depends on
 * entirely and which no unit test can verify -- every fixture in handlers.test.ts is
 * a hand-written reconstruction, and the API is the only authority on whether it is
 * right.
 *
 * These assert two facts MEASURED against a live tailnet rather than inferred from
 * the Go client's structs. Both were open questions that shipped as documented
 * limitations until a probe settled them, and one of the two limitations turned out
 * not to exist:
 *
 *   1. the response DOES carry a top-level `postures` map holding the SUBMITTED
 *      policy's definitions -- which is what makes posture-redefinition detection
 *      possible at all
 *   2. a multi-port grant returns SEPARATE port entries, never a comma-joined one,
 *      so narrowing a port list is a clean loss
 *
 * A crafted policy is submitted rather than the tailnet's own, so the answers do not
 * depend on how the target tailnet happens to be configured. `preview` evaluates and
 * applies nothing, so this remains read-only despite being a POST.
 */
describe("Integration: ACL preview response shape", { skip: !runIntegration }, () => {
  it("returns posture definitions and separate port entries", async () => {
    const { aclTools } = await import("./tools/acl.js");
    const { userTools } = await import("./tools/users.js");

    const listUsers = userTools.find((t) => t.name === "tailscale_list_users");
    assert.ok(listUsers, "tailscale_list_users tool not found");
    const usersResult = (await (
      listUsers.handler as (
        i: Record<string, unknown>,
      ) => Promise<ApiResult<{ users?: Array<Record<string, unknown>> }>>
    )({})) as ApiResult<{ users?: Array<Record<string, unknown>> }>;
    assert.equal(usersResult.ok, true, `could not list users: ${usersResult.error ?? "(no error)"}`);
    const users = usersResult.data?.users ?? [];
    assert.ok(users.length > 0, "target tailnet has no users; this suite cannot check the preview shape");

    // The principal the preview endpoint expects. NOT necessarily an email: a
    // GitHub-auth tailnet returns "alice@github" and carries no `email` key at all,
    // which is why tailscale_diff_acl_access resolves principals from loginName.
    const principal = users[0]?.loginName;
    assert.equal(typeof principal, "string", "expected users[].loginName to be a string on the live API");

    const policy = JSON.stringify({
      tagOwners: { "tag:shapeprobe": ["autogroup:admin"] },
      postures: { "posture:shapeprobe": ["node:tsVersion >= '1.80'"] },
      grants: [
        // srcPosture is rejected against src:["*"], so the grant names the principal.
        {
          src: [principal],
          dst: ["tag:shapeprobe"],
          ip: ["22", "80", "443"],
          srcPosture: ["posture:shapeprobe"],
        },
      ],
    });

    const preview = aclTools.find((t) => t.name === "tailscale_preview_acl");
    assert.ok(preview, "tailscale_preview_acl tool not found");
    const result = (await (
      preview.handler as (i: { policy: string; type: string; previewFor: string }) => Promise<ApiResult<unknown>>
    )({ policy, type: "user", previewFor: principal as string })) as ApiResult<unknown>;
    assert.equal(result.ok, true, `preview failed: ${result.error ?? "(no error)"}`);

    const parsed = JSON.parse(result.rawBody ?? "") as {
      matches?: Array<{ ports?: unknown; postures?: unknown }>;
      postures?: Record<string, string[]>;
    };

    // (1) The definitions map, and that it echoes what was SUBMITTED. If this ever
    // goes red, tailscale_diff_acl_access silently stops detecting posture
    // redefinitions -- it falls back to comparing names, which is the exact
    // false-clean the definition resolution was added to remove.
    assert.ok(parsed.postures, "no top-level `postures` map -- posture-definition diffing is not possible");
    assert.deepEqual(
      parsed.postures?.["posture:shapeprobe"],
      ["node:tsVersion >= '1.80'"],
      "the postures map must echo the SUBMITTED policy's definitions",
    );

    const matches = parsed.matches ?? [];
    assert.ok(matches.length > 0, "expected the crafted grant to match its own principal");
    const ports = matches.flatMap((m) => (Array.isArray(m.ports) ? (m.ports as string[]) : []));

    // (2) Separate entries, never comma-joined. A comma-joined form would make a
    // narrowed port list surface as a paired loss and gain of the whole entry --
    // the limitation this package documented until the API disproved it.
    assert.ok(
      !ports.some((p) => typeof p === "string" && p.includes(",")),
      `a port entry is comma-joined, so the narrowed-range limitation is real after all: ${JSON.stringify(ports)}`,
    );
    assert.equal(ports.length, 3, `expected one entry per port from ip:[22,80,443], got ${JSON.stringify(ports)}`);
  });
});

/**
 * Response sizes for the tools that declare `anthropic/maxResultSizeChars`.
 *
 * That annotation raises the client's truncation limit so a large-but-legitimate
 * result stays inline instead of becoming a file reference. Every entry currently
 * declares the documented 500000 ceiling, because sizing them needs measurements
 * from a POPULATED tailnet and inventing numbers is fake precision.
 *
 * This is the measurement, and it is a real assertion rather than a report: if a
 * live response EXCEEDS its declared cap, the cap is not doing its job and the tool
 * will be truncated anyway. It also prints each size, so running this against a
 * large tailnet produces exactly the data needed to tune the caps down from the
 * ceiling -- the open question that has been blocked on nothing but a populated
 * tailnet.
 */
describe("Integration: declared result-size caps vs real responses", { skip: !runIntegration }, () => {
  it("keeps every capped tool's live response inside its declared cap", async (t) => {
    const { MAX_RESULT_SIZE_CHARS, LARGE_RESULT_TOOLS } = await import("./server-wiring.js");
    const { deviceTools } = await import("./tools/devices.js");
    const { userTools } = await import("./tools/users.js");
    const { aclTools } = await import("./tools/acl.js");

    const probes: Array<[string, () => Promise<ApiResult<unknown>>]> = [
      [
        "tailscale_list_devices",
        () =>
          (
            deviceTools.find((x) => x.name === "tailscale_list_devices")!.handler as (
              i: Record<string, unknown>,
            ) => Promise<ApiResult<unknown>>
          )({ fields: "all" }),
      ],
      [
        "tailscale_list_users",
        () =>
          (
            userTools.find((x) => x.name === "tailscale_list_users")!.handler as (
              i: Record<string, unknown>,
            ) => Promise<ApiResult<unknown>>
          )({}),
      ],
      [
        "tailscale_get_acl",
        () => (aclTools.find((x) => x.name === "tailscale_get_acl")!.handler as () => Promise<ApiResult<unknown>>)(),
      ],
    ];

    for (const [name, run] of probes) {
      assert.ok(LARGE_RESULT_TOOLS.includes(name), `${name} should be in LARGE_RESULT_TOOLS`);
      const res = await run();
      assert.equal(res.ok, true, `${name} failed: ${res.error ?? "(no error)"}`);
      const size = (res.rawBody ?? JSON.stringify(res.data ?? {})).length;
      t.diagnostic(`${name}: ${size} chars (declared cap ${MAX_RESULT_SIZE_CHARS})`);
      assert.ok(
        size <= MAX_RESULT_SIZE_CHARS,
        `${name} returned ${size} chars, above its declared cap of ${MAX_RESULT_SIZE_CHARS} -- the cap cannot keep it inline`,
      );
    }

    t.diagnostic(
      "Sizes above are for THIS tailnet. Tuning the caps below the ceiling needs a populated tailnet; an empty one cannot answer it.",
    );
  });
});
