import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { z } from "zod";
import { aclTools } from "./acl.js";
import { auditTools } from "./audit.js";
import { deviceTools } from "./devices.js";
import { dnsTools } from "./dns.js";
import { inviteTools } from "./invites.js";
import { keyTools } from "./keys.js";
import { localCliTools } from "./local-cli.js";
import { logStreamingTools } from "./log-streaming.js";
import { postureTools } from "./posture.js";
import { serviceTools } from "./services.js";
import { statusTools } from "./status.js";
import { tailnetTools } from "./tailnet.js";
import { tailnetsTools } from "./tailnets.js";
import { userTools } from "./users.js";
import { webhookTools } from "./webhooks.js";

const allTools = [
  ...statusTools,
  ...deviceTools,
  ...aclTools,
  ...dnsTools,
  ...keyTools,
  ...userTools,
  ...tailnetTools,
  ...tailnetsTools,
  ...webhookTools,
  ...postureTools,
  ...auditTools,
  ...inviteTools,
  ...serviceTools,
  ...logStreamingTools,
  ...localCliTools,
];

// Single source of truth for per-module tool counts. The total is derived from
// these, so adding a tool only requires bumping the one module's number here --
// the per-module assertions below and the total assertion both read from this.
const EXPECTED_MODULE_COUNTS: Array<[string, ReadonlyArray<unknown>, number]> = [
  ["statusTools", statusTools, 1],
  ["deviceTools", deviceTools, 17],
  ["aclTools", aclTools, 4],
  ["dnsTools", dnsTools, 11],
  ["keyTools", keyTools, 7],
  ["userTools", userTools, 7],
  ["tailnetTools", tailnetTools, 5],
  ["tailnetsTools", tailnetsTools, 3],
  ["webhookTools", webhookTools, 7],
  ["postureTools", postureTools, 5],
  ["auditTools", auditTools, 2],
  ["inviteTools", inviteTools, 11],
  ["serviceTools", serviceTools, 7],
  ["logStreamingTools", logStreamingTools, 7],
  ["localCliTools", localCliTools, 6],
];

const EXPECTED_TOTAL = EXPECTED_MODULE_COUNTS.reduce((sum, [, , count]) => sum + count, 0);

// readOnlyHint and destructiveHint are pinned by VALUE here, in two frozen name
// lists. Every other annotation assertion in this file checks a hint's TYPE
// (`typeof === "boolean"`), which passes for true and false alike, so these two
// sets are the only thing standing between a one-character annotation flip and
// a green suite. They sit side by side on purpose: the disjointness check below
// is then a statement about the LISTS, catching a contradiction between them
// before any registry value is read.

// The complete read-only surface, pinned by name. readOnlyHint is not a hint at
// all for this server: filterTools keeps a tool under TAILSCALE_READONLY if and
// only if that flag is exactly true, so this set IS the readonly boundary. The
// sweep below asserts its VALUE and not just its type, because a one-character
// flip on a write tool -- or a copy-pasted annotations block -- would otherwise
// expose that tool in readonly mode with the whole suite green.
//
// Names rather than a name-verb heuristic: the registry has write tools whose
// verb reads harmless (test_webhook, rotate_webhook_secret, restore_user) and
// read tools whose verb reads mutating (validate_acl, preview_acl), so only an
// explicit list is exhaustive in both directions. It also buys the property
// that matters -- any change to the readonly surface becomes a deliberate,
// reviewable diff. A new read-only tool costs one line here, the same friction
// budget EXPECTED_MODULE_COUNTS already spends.
const READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  // status
  "tailscale_status",
  // devices
  "tailscale_list_devices",
  "tailscale_get_device",
  "tailscale_get_device_routes",
  "tailscale_get_device_posture_attributes",
  // acl
  "tailscale_get_acl",
  "tailscale_validate_acl",
  "tailscale_preview_acl",
  // dns
  "tailscale_get_nameservers",
  "tailscale_get_search_paths",
  "tailscale_get_split_dns",
  "tailscale_get_dns_preferences",
  "tailscale_get_dns_configuration",
  // keys
  "tailscale_list_keys",
  "tailscale_get_key",
  "tailscale_get_oauth_app",
  // users
  "tailscale_list_users",
  "tailscale_get_user",
  // tailnet
  "tailscale_get_tailnet_settings",
  "tailscale_get_contacts",
  // org-tailnets
  "tailscale_list_org_tailnets",
  // webhooks
  "tailscale_list_webhooks",
  "tailscale_get_webhook",
  // posture
  "tailscale_list_posture_integrations",
  "tailscale_get_posture_integration",
  // audit
  "tailscale_get_audit_log",
  "tailscale_get_network_flow_logs",
  // invites
  "tailscale_list_device_invites",
  "tailscale_get_device_invite",
  "tailscale_list_user_invites",
  "tailscale_get_user_invite",
  // services
  "tailscale_list_services",
  "tailscale_get_service",
  "tailscale_list_service_hosts",
  "tailscale_get_service_device_approval",
  // log-streaming
  "tailscale_list_log_stream_configs",
  "tailscale_get_log_stream_config",
  "tailscale_get_log_stream_status",
  "tailscale_validate_aws_trust_policy",
  // local-cli
  "tailscale_local_status",
  "tailscale_ping",
  "tailscale_netcheck",
  "tailscale_local_version",
  "tailscale_local_whoami",
  "tailscale_local_service_list",
]);

// The complete destructive surface, pinned by name. Unlike readOnlyHint this
// one gates nothing inside the server -- it is advisory, and what consumes it
// is the MCP client's approval prompt. That makes a wrong value invisible here
// and expensive there: destructiveHint:false on tailscale_delete_device is an
// unprompted deletion in any client that auto-approves the non-destructive
// calls.
//
// By name, for the same reason READ_ONLY_TOOLS is: the verb does not predict
// the value. delete_* is destructive, but so are deauthorize_device,
// expire_device, suspend_user, set_devices_authorized (which deauthorizes in
// bulk) and the replace-the-whole-collection setters, while create_* and the
// scalar and merge updates are not. Absence from this set means
// destructiveHint:false, and a newly added tool cannot slip in unnoticed
// regardless -- EXPECTED_MODULE_COUNTS already forces a count bump.
//
// The line the set draws: can this call wipe configuration the caller never
// named? update_acl POSTs a whole new policy file over the existing one, and
// set_device_routes / set_device_tags / set_nameservers / set_search_paths /
// set_split_dns / set_dns_configuration each treat the supplied collection as
// the complete new value, so an empty one clears the config rather than leaving
// it alone. That is why the scalar and merge writes stay out on the other side
// of the line: set_dns_preferences flips one boolean, update_split_dns PATCHes
// a merge, set_device_posture_attribute writes one named key, and
// batch_update_posture_attributes is merge-patch over named keys as well --
// it deletes only where the caller spells out an explicit null.
//
// tailscale_set_contacts (tailnet.ts) reads like a replace-all and is not one:
// it filters to the contact types the caller actually supplied and PATCHes each
// with a required z.email(), so an omitted type is left alone and there is no
// empty-collection path that clears anything. It belongs on the scalar-swap side
// of the line with set_device_ip and rename_device, which is why it is absent.
const DESTRUCTIVE_TOOLS: ReadonlySet<string> = new Set([
  // devices
  "tailscale_deauthorize_device",
  "tailscale_delete_device",
  "tailscale_expire_device",
  "tailscale_set_device_routes",
  "tailscale_delete_device_posture_attribute",
  "tailscale_set_device_tags",
  "tailscale_set_devices_authorized",
  // acl
  "tailscale_update_acl",
  // dns
  "tailscale_set_nameservers",
  "tailscale_set_search_paths",
  "tailscale_set_split_dns",
  "tailscale_set_dns_configuration",
  // keys
  "tailscale_delete_key",
  // users
  "tailscale_suspend_user",
  "tailscale_delete_user",
  // org-tailnets
  "tailscale_delete_tailnet",
  // webhooks
  "tailscale_delete_webhook",
  // posture
  "tailscale_delete_posture_integration",
  // invites
  "tailscale_delete_device_invite",
  "tailscale_delete_user_invite",
  // services
  "tailscale_delete_service",
  // log-streaming
  "tailscale_delete_log_stream_config",
]);

// The leading word of a tool name: "tailscale_delete_device" -> "delete".
const toolVerb = (name: string) => name.replace(/^tailscale_/, "").split("_")[0];

// Verbs whose title agreement is mechanically checkable. tailscale_status and
// the six local-cli tools are deliberately absent (their verbs are status,
// local, ping and netcheck): those are titled after the CLI command they wrap
// -- "Tailscale netcheck", "Local tailscale status" -- rather than after a
// verb, so they get the non-empty and uniqueness checks only. A tool added with
// a novel verb is silently exempt too, which is the accepted cost of not
// enforcing a naming convention the source does not otherwise enforce.
const TITLE_VERBS: ReadonlySet<string> = new Set([
  "accept",
  "approve",
  "authorize",
  "batch",
  "create",
  "deauthorize",
  "delete",
  "expire",
  "get",
  "list",
  "preview",
  "rename",
  "resend",
  "restore",
  "rotate",
  "set",
  "suspend",
  "test",
  "update",
  "validate",
]);

describe("Tool definitions", () => {
  it("should have no duplicate tool names", () => {
    const names = allTools.map((t) => t.name);
    const unique = new Set(names);
    assert.equal(
      names.length,
      unique.size,
      `Duplicate tool names found: ${names.filter((n, i) => names.indexOf(n) !== i)}`,
    );
  });

  it("should have no duplicate tool titles", () => {
    // Two tools sharing a title leaves the operator unable to tell which call an
    // approval prompt is describing -- the same copy-paste risk as a wrong
    // title, one step further along.
    const titles = allTools.map((t) => t.annotations.title);
    const unique = new Set(titles);
    assert.equal(
      titles.length,
      unique.size,
      `Duplicate tool titles found: ${titles.filter((t, i) => titles.indexOf(t) !== i)}`,
    );
  });

  it("should have the expected total tool count", () => {
    // Derived from EXPECTED_MODULE_COUNTS so a new tool only needs one number bumped.
    assert.equal(allTools.length, EXPECTED_TOTAL);
  });

  it("should cover exactly the tools the server registers", async () => {
    // allTools is a hand-maintained spread of the 15 tool modules, while the
    // server registers whatever buildToolGroups returns. Nothing else joined the
    // two, so a module composed into an existing group key (or a whole new key)
    // could reach production while collecting none of the invariants in this
    // file -- no duplicate-name, prefix, description, schema or annotation
    // check. This is the reconciliation.
    //
    // Imported dynamically because this is the only assertion here that needs
    // the server's registry; everything else works off the module exports.
    const { buildToolGroups } = await import("../server-wiring.js");
    // local-cli is opt-in (TAILSCALE_LOCAL_CLI), so ask for it explicitly --
    // otherwise the registry is six tools short of this file's list and the
    // failure would report gating as drift.
    const registered = Object.values(buildToolGroups({ TAILSCALE_LOCAL_CLI: "1" })).flat();
    assert.deepEqual(
      allTools.map((t) => t.name).sort(),
      registered.map((t) => t.name).sort(),
      "allTools (this file) and buildToolGroups (what the server registers) disagree -- add the new module to allTools",
    );
  });

  it("READ_ONLY_TOOLS and DESTRUCTIVE_TOOLS name only tools that still exist", () => {
    // The per-tool sweeps below iterate allTools, so they catch a tool whose
    // annotation disagrees with these sets -- but never a name that has LEFT
    // the registry. A deleted or renamed tool strands its entry here, where it
    // then asserts nothing for the rest of the file's life. This is the other
    // direction, and the reason neither set needs a companion count.
    // Explicitly Set<string>: allTools comes from `as const` arrays, so an
    // inferred set is keyed by the literal-name union and `.has()` then rejects
    // the plain `string`s held in READ_ONLY_TOOLS / DESTRUCTIVE_TOOLS. Widening
    // here is the point -- a stale pinned name is BY DEFINITION not in the
    // union, so a literal-typed set could never express this check.
    const names = new Set<string>(allTools.map((t) => t.name));
    const stale = [...READ_ONLY_TOOLS, ...DESTRUCTIVE_TOOLS].filter((n) => !names.has(n));
    assert.deepEqual(stale, [], `pinned names no longer in the registry: ${stale.join(", ")}`);
  });

  it("no tool is listed as both read-only and destructive", () => {
    // Asserted between the two SETS, not per tool. A per-tool form can only
    // fire on tools the registry ALREADY marks read-only, so a write tool
    // wrongly added to both lists would sail past it; here the contradiction is
    // caught in the lists themselves, before any annotation is read.
    const both = [...READ_ONLY_TOOLS].filter((n) => DESTRUCTIVE_TOOLS.has(n));
    assert.deepEqual(both, [], `listed as both read-only and destructive: ${both.join(", ")}`);
  });

  for (const tool of allTools) {
    describe(tool.name, () => {
      it("should have a non-empty name", () => {
        assert.ok(tool.name.length > 0);
      });

      it("should have a name prefixed with tailscale_", () => {
        assert.ok(tool.name.startsWith("tailscale_"), `Tool name ${tool.name} should start with tailscale_`);
      });

      it("should have a non-empty description", () => {
        assert.ok(tool.description.length > 0);
      });

      it("should have a Zod input schema", () => {
        assert.ok(tool.inputSchema);
        assert.ok(typeof tool.inputSchema.shape === "object");
      });

      it("should have an async handler function", () => {
        assert.equal(typeof tool.handler, "function");
      });

      it("should have annotations with required hints", () => {
        assert.ok(tool.annotations, `Tool ${tool.name} is missing annotations`);
        assert.equal(typeof tool.annotations.readOnlyHint, "boolean", `Tool ${tool.name} missing readOnlyHint`);
        assert.equal(typeof tool.annotations.destructiveHint, "boolean", `Tool ${tool.name} missing destructiveHint`);
        assert.equal(typeof tool.annotations.idempotentHint, "boolean", `Tool ${tool.name} missing idempotentHint`);
        assert.equal(typeof tool.annotations.openWorldHint, "boolean", `Tool ${tool.name} missing openWorldHint`);
      });

      // The four assertions above check only the TYPE of each hint, which passes
      // for true and false alike across all 100 tools. readOnlyHint's VALUE is
      // the entire TAILSCALE_READONLY boundary, so pin it against the frozen set
      // above: flipping a write tool to read-only then has to be a deliberate
      // edit to READ_ONLY_TOOLS rather than an invisible one-character change.
      it("should have the readOnlyHint value pinned by READ_ONLY_TOOLS", () => {
        assert.equal(
          tool.annotations.readOnlyHint,
          READ_ONLY_TOOLS.has(tool.name),
          `${tool.name}: readOnlyHint disagrees with READ_ONLY_TOOLS -- fix the annotation or update that set`,
        );
      });

      // destructiveHint gets the same treatment for the same reason, one layer
      // out: it steers the approval prompt an MCP client shows before the call
      // rather than anything this server branches on, so nothing but this
      // assertion notices when it is wrong.
      it("should have the destructiveHint value pinned by DESTRUCTIVE_TOOLS", () => {
        assert.equal(
          tool.annotations.destructiveHint,
          DESTRUCTIVE_TOOLS.has(tool.name),
          `${tool.name}: destructiveHint disagrees with DESTRUCTIVE_TOOLS -- fix the annotation or update that set`,
        );
      });

      // annotations.title is what an MCP client renders in its tool picker and,
      // more to the point, in the approval prompt shown before a destructive
      // call. These definition blocks are heavily copy-pasted (the five posture
      // tools are near-identical, as are suspend/restore), which is exactly the
      // shape that ships tailscale_delete_posture_integration labelled "Update
      // posture integration" -- approved on the strength of a label that says
      // the wrong thing. Nothing in the suite asserted title before these.
      it("should have a non-empty title", () => {
        assert.equal(typeof tool.annotations.title, "string", `Tool ${tool.name} is missing annotations.title`);
        assert.ok(tool.annotations.title.length > 0, `Tool ${tool.name} has an empty annotations.title`);
      });

      const verb = toolVerb(tool.name);
      if (TITLE_VERBS.has(verb)) {
        it(`should have a title leading with "${verb}"`, () => {
          assert.equal(
            tool.annotations.title.split(" ")[0].toLowerCase(),
            verb,
            `${tool.name}: annotations.title ${JSON.stringify(tool.annotations.title)} must lead with its name's verb`,
          );
        });
      }
    });
  }
});

describe("Tool modules export correct counts", () => {
  for (const [moduleName, tools, expected] of EXPECTED_MODULE_COUNTS) {
    it(`${moduleName} has ${expected} tool${expected === 1 ? "" : "s"}`, () => assert.equal(tools.length, expected));
  }

  it("per-module counts sum to the total tool count", () => {
    assert.equal(allTools.length, EXPECTED_TOTAL);
  });
});

describe("JSON Schema exposed to MCP clients", () => {
  // These fields use z.string().superRefine(...) rather than z.enum so the
  // allowed set can be extended at runtime via env. That swap silently DROPPED
  // the `enum` array from the generated JSON Schema, leaving `{"type":"string"}`
  // with the valid values only in prose -- losing constrained decoding and any
  // enum-rendering UI. `.meta({ enum })` puts it back; these pin that it stays.
  function schemaFor(tools: ReadonlyArray<{ name: string; inputSchema: unknown }>, name: string) {
    const tool = tools.find((t) => t.name === name);
    if (!tool) throw new Error(`Tool not found: ${name}`);
    const shape = (tool.inputSchema as { shape: z.ZodRawShape }).shape;
    return z.toJSONSchema(z.object(shape), { io: "input", unrepresentable: "any" }) as {
      properties: Record<string, { enum?: string[]; items?: { enum?: string[] } }>;
    };
  }

  // Both enums below are resolved at MODULE LOAD from process.env (posture.ts
  // reads TAILSCALE_EXTRA_POSTURE_PROVIDERS, webhooks.ts reads
  // TAILSCALE_EXTRA_WEBHOOK_EVENTS), so the copies imported at the top of this
  // file froze whatever the developer's shell happened to export. Re-loading the
  // module with the extras var deleted is what makes these exact-list
  // assertions describe the CODE rather than the ambient environment -- without
  // it, an operator of this very package who has the extras configured fails
  // both tests for a reason that has nothing to do with the change they made.
  // Restores in a finally so the var cannot leak into the next test.
  async function withoutEnv<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const previous = process.env[name];
    delete process.env[name];
    try {
      return await fn();
    } finally {
      if (previous === undefined) delete process.env[name];
      else process.env[name] = previous;
    }
  }

  it("advertises every posture provider as an enum, not just prose", async () => {
    const tools = await withoutEnv("TAILSCALE_EXTRA_POSTURE_PROVIDERS", async () => {
      // Cache-busting query so the module re-evaluates and re-reads env; a plain
      // import returns the instance already loaded at the top of this file. The
      // query differs from the one the load-time test below uses, since Node
      // caches per specifier and that copy was loaded WITH an extra set.
      const specifier = "./posture.js?staticenum=1";
      const fresh = (await import(specifier)) as {
        postureTools: ReadonlyArray<{ name: string; inputSchema: { shape: z.ZodRawShape } }>;
      };
      return fresh.postureTools;
    });
    const provider = schemaFor(tools, "tailscale_create_posture_integration").properties.provider;
    assert.deepEqual(provider.enum, [
      "falcon",
      "fleet",
      "huntress",
      "intune",
      "jamfpro",
      "kandji",
      "kolide",
      "sentinelone",
    ]);
  });

  it("advertises the webhook event catalog as an enum on the array items", async () => {
    const tools = await withoutEnv("TAILSCALE_EXTRA_WEBHOOK_EVENTS", async () => {
      const specifier = "./webhooks.js?staticenum=1";
      const fresh = (await import(specifier)) as {
        webhookTools: ReadonlyArray<{ name: string; inputSchema: { shape: z.ZodRawShape } }>;
      };
      return fresh.webhookTools;
    });
    const subs = schemaFor(tools, "tailscale_create_webhook").properties.subscriptions;
    assert.ok(subs.items?.enum, "subscriptions items must carry an enum");
    assert.equal(subs.items.enum.length, 18);
    assert.ok(subs.items.enum.includes("nodeCreated"));
    // Always-on/undisableable events must stay OUT of the subscribable set.
    for (const excluded of ["test", "webhookDeleted", "webhookUpdated"]) {
      assert.ok(!subs.items.enum.includes(excluded), `${excluded} is not subscribable`);
    }
  });
});

describe("advertised enum vs runtime check", () => {
  // The JSON Schema enum is resolved at MODULE LOAD, while superRefine re-reads
  // env per call. A server started WITHOUT TAILSCALE_EXTRA_POSTURE_PROVIDERS
  // therefore advertises 8 providers but accepts 9 once the var appears -- a
  // strict client validating against the schema would refuse to send a request
  // the server would have honoured. Pinning the intended behaviour: the enum
  // must reflect the env as it stood at load, extras included.
  it("includes TAILSCALE_EXTRA_POSTURE_PROVIDERS in the advertised enum when set at load", async () => {
    const previous = process.env.TAILSCALE_EXTRA_POSTURE_PROVIDERS;
    process.env.TAILSCALE_EXTRA_POSTURE_PROVIDERS = "brandnewedr";
    try {
      // Cache-busting query so the module re-evaluates and re-reads env; a plain
      // import would return the instance already loaded by the suite above.
      // Built as a variable so TypeScript does not try to resolve the
      // query-suffixed specifier at compile time; the query is what busts
      // Node's ESM module cache at runtime.
      const specifier = "./posture.js?enumcase=1";
      const fresh = (await import(specifier)) as {
        postureTools: ReadonlyArray<{ name: string; inputSchema: { shape: z.ZodRawShape } }>;
      };
      const tool = fresh.postureTools.find((t) => t.name === "tailscale_create_posture_integration");
      assert.ok(tool, "tool not found in freshly-loaded module");
      const js = z.toJSONSchema(z.object(tool.inputSchema.shape), {
        io: "input",
        unrepresentable: "any",
      }) as unknown as { properties: { provider: { enum?: string[] } } };
      assert.ok(
        js.properties.provider.enum?.includes("brandnewedr"),
        `advertised enum must include the configured extra, got: ${JSON.stringify(js.properties.provider.enum)}`,
      );
      // The static set must still be there alongside the extra.
      assert.ok(js.properties.provider.enum?.includes("falcon"));
    } finally {
      if (previous === undefined) delete process.env.TAILSCALE_EXTRA_POSTURE_PROVIDERS;
      else process.env.TAILSCALE_EXTRA_POSTURE_PROVIDERS = previous;
    }
  });

  // webhooks.ts carries the identical construct and says so in its own comment
  // ("Resolved at module load, so a server started with
  // TAILSCALE_EXTRA_WEBHOOK_EVENTS advertises those too"), but only the parse
  // side of that var was tested -- nothing checked the sentence about the
  // ADVERTISED schema. Mirrors the posture case above so the two cannot drift.
  it("includes TAILSCALE_EXTRA_WEBHOOK_EVENTS in the advertised enum when set at load", async () => {
    const previous = process.env.TAILSCALE_EXTRA_WEBHOOK_EVENTS;
    process.env.TAILSCALE_EXTRA_WEBHOOK_EVENTS = "brandNewEvent";
    try {
      const specifier = "./webhooks.js?enumcase=1";
      const fresh = (await import(specifier)) as {
        webhookTools: ReadonlyArray<{ name: string; inputSchema: { shape: z.ZodRawShape } }>;
      };
      const tool = fresh.webhookTools.find((t) => t.name === "tailscale_create_webhook");
      assert.ok(tool, "tool not found in freshly-loaded module");
      const js = z.toJSONSchema(z.object(tool.inputSchema.shape), {
        io: "input",
        unrepresentable: "any",
      }) as unknown as { properties: { subscriptions: { items?: { enum?: string[] } } } };
      const advertised = js.properties.subscriptions.items?.enum;
      assert.ok(
        advertised?.includes("brandNewEvent"),
        `advertised enum must include the configured extra, got: ${JSON.stringify(advertised)}`,
      );
      // The 18-event static catalog must still be advertised alongside the extra
      // -- an extras var that REPLACED the catalog would strand every client.
      assert.ok(advertised?.includes("nodeCreated"));
      assert.equal(advertised?.length, 19);
    } finally {
      if (previous === undefined) delete process.env.TAILSCALE_EXTRA_WEBHOOK_EVENTS;
      else process.env.TAILSCALE_EXTRA_WEBHOOK_EVENTS = previous;
    }
  });
});
