#!/usr/bin/env node
/**
 * live-probe.mjs -- the live shape probe harness.
 *
 * WHAT THIS IS FOR. Roughly a dozen findings about this server cannot be
 * settled from the OpenAPI spec, the Go client and the docs, because the
 * question is what a closed-source server DOES with a request, not what the
 * documents say it should. A 200 does not prove a write took effect; a 400 does
 * not prove which part was wrong. So each probe sends the shape the SHIPPED
 * tool emits and the shape the SPEC documents, against the same target in the
 * same run, with a GET before and after, and records both.
 *
 * WHO RUNS IT. The owner, in his own shell. Not an agent. Dry run is the
 * default: `run --all` prints every request that would be sent and exits
 * without touching the network, so the list can be read before --execute is
 * typed.
 *
 * WHY IT LIVES IN scripts/ AND NOT src/.
 *   - `npm test` runs `node --test "dist/**\/*.test.js"` and the integration
 *     suite opts in on RUN_INTEGRATION_TESTS=1 plus the ambient
 *     TAILSCALE_API_KEY (integration.test.ts:39-44). A probe written as a
 *     src/*.test.ts would run DNS-wiping writes against the owner's real key
 *     the next time anyone ran that suite.
 *   - release-metadata.test.ts:331-363 scans every non-test .ts under src/ for
 *     TAILSCALE_* names and fails unless each is in the launcher allow-list. A
 *     TS_PROBE_* prefix outside src/ stays clear of that guard.
 *   - package.json's `files` allow-list publishes bin/tailscale-mcp.mjs,
 *     dist/index.js, LICENSE and README.md, so neither this harness nor its
 *     fixtures can ship. scripts/ IS a lint target, so it still goes through
 *     the pre-commit checklist.
 *
 * TWO DELIBERATE DEPARTURES FROM HOUSE RULES, BOTH DECLARED HERE.
 *
 *  1. Raw fetch. The "@yawlabs scripts route through MCP, not raw fetch" rule
 *     is satisfied by every CURRENT arm, which runs the real compiled handler:
 *     inputSchema.parse then handler, exactly as src/index.ts:283-292 registers
 *     it, so the recorded request is byte-for-byte what ships. The SPEC arms
 *     call apiRequest from the same build. That is the rule's explicit
 *     raw-fetch escape hatch, and it is unavoidable: no tool can emit the spec
 *     shape until the fix lands -- emitting it is the whole point of the probe.
 *
 *  2. P9 and P15 mint tokens through a harness-local raw POST to
 *     /api/v2/oauth/token, NEVER getOAuthAccessToken. That function caches the
 *     token in a module-global (api.ts:41), so a token minted for one arm would
 *     ride onto the next; it discards the raw response body, which is the
 *     fixture those probes exist to capture; and it cannot emit the spec's
 *     form-body shape at all. The reconstruction is byte-for-byte what
 *     api.ts:135-146 builds. It is the one place a CURRENT arm is not the
 *     shipped code path, and each plan says so on the step.
 *
 * CREDENTIALS. This process reads TS_PROBE_* variables only. On startup it
 * DELETES every TAILSCALE_* name from its own environment, because
 * getAuthConfig (api.ts:58-73) prefers an ambient TAILSCALE_API_KEY over the
 * OAuth pair and getTailnet (api.ts:231-233) defaults the tailnet to "-". The
 * owner's shell exports the real key; without the strip, every request here
 * would carry it and address his production tailnet.
 *
 * NOTHING IN THIS FILE HAS EVER BEEN RUN AGAINST api.tailscale.com. No fixture
 * under fixtures/live/ was produced by an observation; the directory ships
 * empty on purpose.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  applyProbeCredentials,
  assertAttestationFresh,
  assertCredentialIsolation,
  assertEnvClean,
  assertExecuteAllowed,
  assertExplicitTarget,
  assertProvenance,
  assertSafetyClassWiring,
  assertServerAttestedEmptiness,
  assertStatePathSafe,
  assertTargetRouting,
  assertTypedConfirmation,
  createEgressGuard,
  defaultStateDir,
  fingerprint,
  normalizeForbidden,
  PROBE_NAME_PREFIX,
  ProbeRefusal,
  resolvePinnedDist,
  shortFingerprint,
  stripAmbientCredentials,
} from "./lib/probe-guard.mjs";
import { findPlan, NOT_IMPLEMENTED, notImplementedReason, PLANS } from "./lib/probe-plans/index.mjs";
import {
  createRecorder,
  describePlannedStep,
  fixtureFiles,
  parseBody,
  REDACTED_KEYS,
  REQUIRED_PROVENANCE_KEYS,
  scanFixtures,
} from "./lib/probe-recorder.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE_ROOT = resolve(REPO_ROOT, "fixtures", "live");
const API_BASE = "https://api.tailscale.com/api/v2";
const COMMANDS = ["list", "provision", "preflight", "run", "cleanup", "teardown", "scrub-check"];

const USAGE = `live-probe.mjs <command> [options]

Commands:
  list                      Print every probe plan, and the probes that are deliberately not implemented.
  provision                 Create disposable target A and write the state file. Needs --execute.
  preflight                 Prove the target is empty and reachable before any write. Needs --execute.
  run <probeId...> | --all  Run probes. WITHOUT --execute this only prints what would be sent.
  cleanup                   Replay the cleanup journal after a crash. Needs --execute.
  teardown                  Delete target A. Needs --execute and --destroy-tailnet=<id>.
  scrub-check               Grep the fixtures and journal for the literal probe credentials. Never sends anything.

Options:
  --execute                       Actually send requests. Everything is dry-run without it.
  --all                           Every implemented probe.
  --allow-real-readonly           Permit a safe-read-only probe against an unattested target (forces GET-only egress).
  --allow-real-reversible=<id>    Permit ONE named safe-reversible-write probe against an unattested target.
  --destroy-tailnet=<id>          Typed confirmation for teardown. Must equal TS_PROBE_TAILNET_ID byte for byte.
  --state-dir=<path>              Override the state directory (default: outside the repo, see defaultStateDir).

Environment (TS_PROBE_* only -- every TAILSCALE_* name is deleted at startup):
  TS_PROBE_TAILNET_ID             The explicit target tailnet id. "-" is refused.
  TS_PROBE_TARGET_KIND            api-only | human
  TS_PROBE_FORBIDDEN_TAILNETS     MANDATORY, comma-separated: the real tailnet's id AND its name/domain.
  TS_PROBE_API_KEY                User-owned API key for target B (the invite and auth-key arms).
  TS_PROBE_OAUTH_CLIENT_ID/_SECRET        The TARGET's own OAuth client (returned by provision for target A).
  TS_PROBE_PROVISION_CLIENT_ID/_SECRET    A real-tailnet OAuth client with ONLY the \`tailnets\` scope.
  TS_PROBE_CREATING_CLIENT_ID/_SECRET     P9 only: a short-lived \`all\`-scope client in the CREATING tailnet.
  TS_PROBE_DOWNSCOPE_CLIENT_ID/_SECRET    P15 only: the client its scope mints authenticate with.
  TS_PROBE_EXPECT_LOGIN           Target B's single human login name.
  TS_PROBE_SINK_A / TS_PROBE_SINK_B       Owner-controlled HTTPS sinks for the P7 webhook probe.
  TS_PROBE_DEVICE_ID              The throwaway node on target B, for P3.
  TS_PROBE_PINNED_DIST            dist/ of a v0.20.2 build made OUTSIDE this working tree. Required to --execute.
  TS_PROBE_PINNED_VERSION         Defaults to 0.20.2.
  TS_PROBE_ORG                    Organization for the tailnets API. Defaults to "-".
  TS_PROBE_OPENAPI                Path to the OpenAPI spec, hashed into every fixture's provenance.
  TS_PROBE_FIXTURE_ROOT           Directory scrub-check sweeps. Defaults to fixtures/live.
  TS_PROBE_STATE_DIR              Where the state file lives. Default is outside the repo.
`;

/* ------------------------------------------------------------------ args -- */

export function parseArgs(argv) {
  const out = { command: null, probeIds: [], flags: {}, allowRealReversible: [], badOptions: [] };
  for (const raw of argv) {
    if (!raw.startsWith("-")) {
      if (out.command === null) out.command = raw;
      else out.probeIds.push(raw);
      continue;
    }
    // TWO dashes, always. A single-dash form used to be accepted, which made
    // `-execute` -- one missing keystroke in an otherwise harmless position --
    // the flag that authorises sending. An unknown option is collected and
    // `main` exits with usage rather than running the command without it.
    if (!raw.startsWith("--")) {
      out.badOptions.push(raw);
      continue;
    }
    const [name, value] = raw.slice(2).split("=");
    if (name === "allow-real-reversible") {
      if (value) out.allowRealReversible.push(value);
      continue;
    }
    out.flags[name] = value === undefined ? true : value;
  }
  return out;
}

/* ------------------------------------------------------------- probe env -- */

function readProbeEnv(env) {
  const pick = (name) => {
    const raw = env[name];
    return typeof raw === "string" && raw.trim() !== "" ? raw.trim() : undefined;
  };
  return {
    tailnetId: pick("TS_PROBE_TAILNET_ID"),
    targetKind: pick("TS_PROBE_TARGET_KIND"),
    forbidden: (pick("TS_PROBE_FORBIDDEN_TAILNETS") ?? "").split(",").map((s) => s.trim()),
    apiKey: pick("TS_PROBE_API_KEY"),
    oauthClientId: pick("TS_PROBE_OAUTH_CLIENT_ID"),
    oauthClientSecret: pick("TS_PROBE_OAUTH_CLIENT_SECRET"),
    provisionClientId: pick("TS_PROBE_PROVISION_CLIENT_ID"),
    provisionClientSecret: pick("TS_PROBE_PROVISION_CLIENT_SECRET"),
    creatingClientId: pick("TS_PROBE_CREATING_CLIENT_ID"),
    creatingClientSecret: pick("TS_PROBE_CREATING_CLIENT_SECRET"),
    downscopeClientId: pick("TS_PROBE_DOWNSCOPE_CLIENT_ID"),
    downscopeClientSecret: pick("TS_PROBE_DOWNSCOPE_CLIENT_SECRET"),
    expectLogin: pick("TS_PROBE_EXPECT_LOGIN"),
    sinkA: pick("TS_PROBE_SINK_A"),
    sinkB: pick("TS_PROBE_SINK_B"),
    deviceId: pick("TS_PROBE_DEVICE_ID"),
    organization: pick("TS_PROBE_ORG") ?? "-",
    openapi: pick("TS_PROBE_OPENAPI"),
    fixtureRoot: pick("TS_PROBE_FIXTURE_ROOT"),
  };
}

/** The credential a plan's arms authenticate with, chosen by target kind. */
function targetCredential(probeEnv) {
  if (probeEnv.targetKind === "human") {
    if (!probeEnv.apiKey) return null;
    return { kind: "api-key", secret: probeEnv.apiKey, label: "TS_PROBE_API_KEY" };
  }
  if (!probeEnv.oauthClientId || !probeEnv.oauthClientSecret) return null;
  return {
    kind: "oauth",
    clientId: probeEnv.oauthClientId,
    secret: probeEnv.oauthClientSecret,
    label: "TS_PROBE_OAUTH_CLIENT_*",
  };
}

/* ------------------------------------------------------------ state file -- */

function stateFilePath(env, flags) {
  const dir = flags["state-dir"] ? resolve(String(flags["state-dir"])) : defaultStateDir(env);
  return join(dir, "probe-state.json");
}

function readState(path) {
  if (!existsSync(path)) return { targets: {}, journal: [] };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return { targets: parsed.targets ?? {}, journal: parsed.journal ?? [] };
  } catch {
    return { targets: {}, journal: [] };
  }
}

function writeState(path, state) {
  mkdirSync(dirname(path), { recursive: true });
  // 0600 is honoured on POSIX and is a no-op on Windows, which is why the
  // default directory is under the user profile rather than in the repo.
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  return path;
}

/**
 * The cleanup journal, written to disk at every append.
 *
 * Two kinds of entry, because a create cannot be undone by an id that does not
 * exist yet:
 *
 *  - a BREADCRUMB, written before the create is sent. It cannot name the object
 *    -- nothing has been created -- but it says a create is in flight and which
 *    list to sweep, so a process killed mid-request leaves a trail rather than
 *    silence.
 *  - an UNDO, written the moment the id comes back, naming the exact request
 *    that removes it. `live-probe.mjs cleanup` replays these after a crash, and
 *    a 404 counts as done, so replaying an already-cleaned run is harmless.
 */
function journalBreadcrumb(statePath, state, entry) {
  state.journal.push({ ...entry, kind: "breadcrumb", at: new Date().toISOString() });
  writeState(statePath, state);
}

function journalUndo(statePath, state, entry) {
  state.journal.push({ ...entry, kind: "undo", at: new Date().toISOString(), done: false });
  writeState(statePath, state);
}

/* ------------------------------------------------------------- printing -- */

function planHeader(plan) {
  return [
    `${plan.probeId}   [${plan.safetyClass}]${plan.requiresTargetKind ? `  target: ${plan.requiresTargetKind}` : ""}`,
    `  settles:     ${plan.settles.join(", ")}`,
    `  question:    ${plan.question}`,
    `  credential:  ${plan.credentialNeeds}`,
    `  blast:       ${plan.blastRadius}`,
    `  cleanup:     ${plan.cleanup}`,
    `  methods:     ${plan.methods.join(", ")}${plan.allowBareTailnetGet ? "  (+ bare /tailnet/-/ GET)" : ""}`,
    `  recording:   ${plan.countsOnly === true ? "counts only" : plan.countsOnly === "unattested" ? "counts only unless the target is attested" : "full bodies, redacted"}`,
  ];
}

function outcomeLines(plan) {
  const lines = ["  outcomes:"];
  for (const row of plan.outcomes ?? []) lines.push(`    - ${row.when}`, `      -> ${row.ship}`);
  return lines;
}

function notImplementedLines() {
  const lines = ["", "NOT IMPLEMENTED (by design, not by omission):"];
  for (const entry of NOT_IMPLEMENTED) {
    lines.push(`  ${entry.probeId}`, `    why:     ${entry.why}`, `    instead: ${entry.instead}`);
  }
  return lines;
}

/* ------------------------------------------------------------- dry runs -- */

function dryRunPlan(plan, ctx, log) {
  for (const line of planHeader(plan)) log(line);
  for (const line of outcomeLines(plan)) log(line);
  log("  requests, in order:");
  const steps = plan.steps(ctx);
  for (const step of steps) {
    const tags = [];
    if (step.optional) tags.push("optional");
    if (step.requires?.attestedTarget) tags.push("attested target only");
    if (step.requires?.targetKind) tags.push(`target ${step.requires.targetKind} only`);
    if (step.requires?.flag) tags.push(`needs --${step.requires.flag}`);
    if (step.credentialTarget) tags.push(`credential ${step.credentialTarget}`);
    log(`    [${String(step.n).padStart(2, " ")}]${tags.length > 0 ? ` (${tags.join("; ")})` : ""}`);
    for (const line of describePlannedStep(step, { tailnetId: ctx.tailnetId ?? "{T}", indent: "      " })) log(line);
    if (step.expect) log(`        expect:  ${step.expect}`);
  }
  log("");
  return steps.length;
}

/* ---------------------------------------------------------- module load -- */

/**
 * Load a module from the PINNED build. Everything the harness imports from the
 * package -- api.js for apiRequest and the OAuth cache reset, tools/*.js for
 * the CURRENT arms -- comes from the same pinned directory, so one cache reset
 * covers one module instance.
 */
async function loadPinned(pinned, relPath) {
  return import(pathToFileURL(resolve(pinned.dir, relPath)).href);
}

function findTool(tools, name) {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`Tool not found in the pinned build: ${name}`);
  return tool;
}

/* ------------------------------------------------------------- run core -- */

function resolvePath(path, tailnetId, state, { allowUnresolved = false } = {}) {
  let out = String(path).replace(/\{T\}/g, tailnetId);
  for (const [key, value] of Object.entries(state ?? {})) {
    if (value === undefined || value === null) continue;
    out = out.replace(new RegExp(`\\{${key}\\}`, "g"), String(value));
  }
  // An unresolved placeholder means the id this step depends on never arrived
  // -- the create 4xx'd, or a plan named a key nothing fills. Sending a literal
  // "{W}" would address an object that does not exist, so refuse instead. The
  // egress guard would also refuse it as an unregistered id; this says WHY.
  const leftover = /\{[A-Za-z][A-Za-z0-9_]*\}/.exec(out);
  if (leftover && !allowUnresolved) {
    throw new ProbeRefusal(
      "unresolved-placeholder",
      `Refusing ${out}: ${leftover[0]} was never filled in. The step it depends on did not return an id, so ` +
        "there is nothing to address.",
    );
  }
  return out;
}

/**
 * A harness-local request that carries an explicit bearer. Used only where
 * apiRequest cannot help: the token mints, and the discriminator GETs that must
 * run under one specific minted token rather than under whatever api.ts would
 * build from the environment.
 */
async function rawRequest(method, path, { bearer, body, form, headers = {} } = {}) {
  const init = { method, headers: { ...headers } };
  if (bearer) init.headers.Authorization = `Bearer ${bearer}`;
  if (form) {
    init.headers["Content-Type"] = "application/x-www-form-urlencoded";
    init.body = new URLSearchParams(form);
  } else if (body !== undefined && body !== null) {
    init.headers["Content-Type"] = init.headers["Content-Type"] ?? "application/json";
    init.body = typeof body === "string" ? body : JSON.stringify(body);
  }
  const res = await fetch(`${API_BASE}${path}`, init);
  const text = await res.text();
  return { status: res.status, ok: res.ok, ...parseBody(text, res.headers.get("content-type") ?? "") };
}

function collectIds(value, into) {
  if (value === null || value === undefined) return into;
  if (Array.isArray(value)) {
    for (const entry of value) collectIds(entry, into);
    return into;
  }
  if (typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      if ((key === "id" || key === "deviceId" || key === "nodeId") && typeof entry === "string") into.push(entry);
      else collectIds(entry, into);
    }
  }
  return into;
}

function skipReason(step, ctx) {
  if (step.requires?.attestedTarget && !ctx.targetIsAttested) {
    return "the target is not attested as disposable, and this step is a replace-all write";
  }
  // G6's GET-only drop. The egress guard refuses the request anyway, but a
  // refusal stops the whole run; a step the harness knows it must not send is
  // better skipped with the reason printed.
  if (ctx.readOnlyDrop && step.method !== "GET" && !String(step.path).startsWith("/oauth/token")) {
    return `${ctx.probeSafetyClass} on an unattested target is GET-only egress (--allow-real-readonly), and this step is a ${step.method}`;
  }
  if (step.requires?.targetKind && step.requires.targetKind !== ctx.targetKind) {
    return `it needs a ${step.requires.targetKind} target and this one is ${ctx.targetKind}`;
  }
  if (step.requires?.flag && ctx.flags[step.requires.flag] !== true) {
    return `--${step.requires.flag} was not passed`;
  }
  return null;
}

/**
 * The form fields that are CREDENTIALS. A plan spells these as a display
 * placeholder naming the variable it wants (`<TS_PROBE_CREATING_CLIENT_ID>`)
 * so the dry run says where the value comes from; the runner substitutes the
 * real value, and refuses when there is none rather than posting the
 * placeholder to the token endpoint as if it were a client id.
 */
export const FORM_CREDENTIAL_KEYS = new Set(["client_id", "client_secret"]);

/**
 * The `ctx.ids` keys the runner seeds from the environment before a plan's
 * first step, so a plan may write `{sinkA}` in a tool input and have it
 * resolved (or refused, if the variable is unset) rather than sending the
 * literal. The names are the TS_PROBE_* ones readProbeEnv already uses.
 *
 * Exported because the offline plan gate checks that every `{placeholder}` a
 * step writes is one something actually fills; hard-coding that list in the
 * test would let the two drift.
 */
export const SEEDED_ID_KEYS = ["deviceId", "sinkA", "sinkB"];

/**
 * Build the urlencoded body of a token mint.
 *
 * A plan spells a credential field as the display placeholder naming the
 * variable it wants, so the DRY RUN says out loud where the value will come
 * from. That only works if the real run substitutes it -- and, when there is
 * nothing to substitute, refuses. Posting `<TS_PROBE_DOWNSCOPE_CLIENT_ID>` to
 * the token endpoint as if it were a client id would record an authentication
 * failure as if it were an answer about scopes.
 *
 * Exported so the refusal can be tested without driving a live run.
 */
export function resolveMintForm(plan, step, ctx) {
  const form = {};
  for (const [key, value] of Object.entries(step.form ?? {})) {
    const supplied = ctx.formValues?.[key];
    if (supplied !== undefined) {
      form[key] = supplied;
      continue;
    }
    if (FORM_CREDENTIAL_KEYS.has(key)) {
      throw new ProbeRefusal(
        "missing-mint-credential",
        `${plan.probeId} step ${step.n} mints a token with ${key} from ${ctx.mintCredentialLabel}, which is ` +
          `unset. Refusing to POST ${String(value)} to the token endpoint as if it were a credential. Set ` +
          `${ctx.mintCredentialLabel}, or run a probe that does not mint.`,
      );
    }
    form[key] = resolvePath(String(value), ctx.tailnetId, ctx.ids);
  }
  return form;
}

/**
 * Did the shipped handler emit the request the plan said it would?
 *
 * The declared preview is a REVIEW artefact, not the truth, so a difference is
 * a NOTE rather than a refusal. Path and query are compared SEPARATELY: a
 * substring test over the whole thing reported every step that carries a query
 * string as a mismatch, because the handler builds its params in its own order.
 */
export function comparePlannedRequest(declaredPath, recordedPath) {
  const [declared, declaredQuery = ""] = String(declaredPath).split("?");
  const [recorded, recordedQuery = ""] = String(recordedPath).split("?");
  if (declared !== recorded) return `emitted ${recorded}, not the planned ${declared}`;

  const want = new URLSearchParams(declaredQuery);
  const got = new URLSearchParams(recordedQuery);
  const show = (params, key) => (params.has(key) ? params.getAll(key).sort().join(",") : "<absent>");
  const differing = [...new Set([...want.keys(), ...got.keys()])]
    .sort()
    .filter((key) => show(want, key) !== show(got, key));
  if (differing.length === 0) return null;
  return `emitted query ${differing.map((key) => `${key}=${show(got, key)} (planned ${show(want, key)})`).join("; ")}`;
}

/**
 * The cleanup sweep: replay every undo THIS probe journalled in THIS run.
 *
 * A plan's final cleanup step cannot name the objects it deletes -- several
 * creates register several ids, and the last one to land would be the only one
 * a single `{id}` could address. The journal already holds one fully resolved
 * undo per created object, written the moment the id came back, so the sweep
 * replays those: one request each, marked done as it goes, so a later
 * `cleanup --execute` has nothing left to do.
 */
async function runSweep(plan, step, ctx, log) {
  const pending = ctx.state.journal.filter(
    (entry) => entry.kind === "undo" && entry.probeId === plan.probeId && entry.done !== true && entry.undo?.id,
  );
  if (pending.length === 0) {
    log(`    [${step.n}] SWEEP -- nothing was created by this probe, so there is nothing to undo`);
    return { swept: 0 };
  }
  let index = 0;
  for (const entry of pending) {
    index += 1;
    const label = `${step.n}.${index}`;
    ctx.recorder.setContext({ probeId: plan.probeId, step: label, arm: step.arm, derive: null });
    ctx.guard.setContext({ probeId: plan.probeId, step: label, credentialTarget: ctx.credentialTarget });
    let envelope;
    try {
      envelope = await ctx.api.apiRequest(entry.undo.method, entry.undo.path, entry.undo.body ?? undefined);
    } catch (err) {
      if (err instanceof ProbeRefusal) throw err;
      envelope = { ok: false, status: 0, error: String(err instanceof Error ? err.message : err) };
    }
    // A 404 counts as done: the object is gone, which is the point.
    entry.done = envelope?.ok === true || envelope?.status === 404;
    writeState(ctx.statePath, ctx.state);
    const fixture = ctx.recorder.buildFixture({
      probeId: plan.probeId,
      step: label,
      arm: step.arm,
      envelope,
      note: step.note ?? step.expect ?? null,
    });
    const written = ctx.recorder.writeFixture(join(FIXTURE_ROOT, plan.probeId), fixture);
    log(
      `    [${label}] ${step.arm} ${entry.undo.method} ${entry.undo.path} -> ${fixture.response?.status ?? "no response"}` +
        `${entry.done ? "" : "  STILL PENDING"}`,
    );
    log(`         fixture: ${written}`);
  }
  return { swept: pending.length };
}

async function executeStep(plan, step, ctx, log) {
  const skip = skipReason(step, ctx);
  if (skip) {
    log(`    [${step.n}] SKIPPED -- ${skip}`);
    return { skipped: skip };
  }

  // Before resolvePath: a sweep step's declared path is documentation, and its
  // `{id}` is deliberately not one ctx.ids can fill.
  if (step.sweep === "journal") return runSweep(plan, step, ctx, log);

  const path = resolvePath(step.path, ctx.tailnetId, ctx.ids);

  // A step may take its body from an earlier step's response -- P4b writes the
  // DNS document back unchanged, and P4c/P5 restore the baseline they captured.
  // The source is the UNREDACTED value held in memory for this run only; the
  // redacted copy on disk would round-trip a "{tailnet}" placeholder into a
  // live write.
  let body = step.body;
  if (step.bodyFromStep !== undefined) {
    body = ctx.responses[step.bodyFromStep];
    if (body === undefined || body === null) {
      throw new ProbeRefusal(
        "missing-source-step",
        `${plan.probeId} step ${step.n} writes back the response of step ${step.bodyFromStep}, but that step ` +
          "returned nothing. Refusing to send an empty document to a replace-all endpoint.",
      );
    }
  }

  ctx.recorder.setContext({ probeId: plan.probeId, step: step.n, arm: step.arm, derive: step.derive ?? null });
  ctx.guard.setContext({
    probeId: plan.probeId,
    step: step.n,
    credentialTarget: step.credentialTarget ?? ctx.credentialTarget,
  });

  let envelope = null;
  try {
    if (step.form) {
      const form = resolveMintForm(plan, step, ctx);
      envelope = await rawRequest("POST", path, { form });
      if (typeof envelope.parsed?.access_token === "string") ctx.mintedBearer = envelope.parsed.access_token;
    } else if (step.credentialTarget === "creating" || step.credentialTarget === "minted") {
      // The arms that must run under the token an earlier step minted rather
      // than under whatever api.ts would build from the environment. Without
      // this branch the step would go out with the ordinary target credential
      // and the fixture would record that credential's answer to a question
      // about the minted one.
      if (!ctx.mintedBearer) {
        throw new ProbeRefusal(
          "no-minted-token",
          `${plan.probeId} step ${step.n} runs under the token an earlier step minted, but no mint has succeeded ` +
            "in this run. Sending it under the target credential would answer a different question, so it is " +
            "refused instead.",
        );
      }
      envelope = await rawRequest(step.method, path, {
        bearer: ctx.mintedBearer,
        body,
        headers: step.headers,
      });
    } else if (step.tool) {
      const mod = await loadPinned(ctx.pinned, step.tool.module);
      const tools = Object.values(mod).find((value) => Array.isArray(value) && value.some((t) => t?.name));
      const tool = findTool(tools, step.tool.name);
      const input = JSON.parse(resolvePath(JSON.stringify(step.tool.input ?? {}), ctx.tailnetId, ctx.ids));
      envelope = await tool.handler(tool.inputSchema.parse(input));
    } else {
      const options = {};
      if (step.headers?.accept) options.accept = step.headers.accept;
      if (step.headers?.["content-type"]) options.contentType = step.headers["content-type"];
      // A string body is raw text (the ACL probes send HuJSON), which apiRequest
      // only passes through unmodified via rawBody. Sending it as `body` would
      // JSON.stringify the text and quote the whole policy.
      if (typeof body === "string") options.rawBody = body;
      envelope = await ctx.api.apiRequest(
        step.method,
        path,
        typeof body === "string" ? undefined : (body ?? undefined),
        Object.keys(options).length > 0 ? options : undefined,
      );
    }
  } catch (err) {
    if (err instanceof ProbeRefusal) throw err;
    envelope = { ok: false, status: 0, error: String(err instanceof Error ? err.message : err) };
  }

  // Register every id this response handed back, so a later non-tailnet-scoped
  // path is allowed to name it -- and nothing else.
  const ids = collectIds(envelope?.data ?? envelope?.parsed ?? null, []);
  for (const id of ids) ctx.guard.registerId(id);
  if (step.registers === "id" && ids.length > 0) {
    // `idKey` is the placeholder later steps write: P7's {W}, P8's {K}/{A}/{F}.
    ctx.ids[step.idKey ?? "id"] = ids[0];
  }
  // Kept in memory only, never written, so `bodyFromStep` can write back the
  // real document rather than its redacted shadow.
  ctx.responses[step.n] = envelope?.data ?? envelope?.parsed ?? null;

  // The undo goes to disk as soon as the id exists, before the next request.
  if (step.undo) {
    for (const id of ids.length > 0 ? ids : [null]) {
      journalUndo(ctx.statePath, ctx.state, {
        probeId: plan.probeId,
        step: step.n,
        undo: {
          id,
          method: step.undo.method,
          path: resolvePath(step.undo.path, ctx.tailnetId, { ...ctx.ids, id }, { allowUnresolved: id === null }),
          body: step.undo.body ?? null,
        },
        // No id came back, so this cannot be replayed automatically. Say so in
        // the journal rather than leaving a line that looks actionable.
        needsManualSweep: id === null,
      });
    }
  }

  const fixture = ctx.recorder.buildFixture({
    probeId: plan.probeId,
    step: step.n,
    arm: step.arm,
    tool: step.tool ? { name: step.tool.name, input: step.tool.input } : null,
    envelope,
    note: step.note ?? step.expect ?? null,
  });
  const written = ctx.recorder.writeFixture(join(FIXTURE_ROOT, plan.probeId), fixture);
  log(`    [${step.n}] ${step.arm} ${step.method} ${path} -> ${fixture.response?.status ?? "no response"}`);
  log(`         fixture: ${written}`);

  // When the shipped handler emits something else, say so loudly rather than
  // quietly recording the real request under a plan line that promised a
  // different one. The recorder scrubs the tailnet id out of the path it
  // stored, so the declared path is put through the same substitution first.
  if (step.tool && fixture.request) {
    const declared = ctx.tailnetId ? path.split(ctx.tailnetId).join("{tailnet}") : path;
    const difference = comparePlannedRequest(declared, fixture.request.path);
    if (difference) log(`         NOTE: the handler ${difference}.`);
  }
  return { fixture };
}

/**
 * Everything that must hold before a plan sends its first request, in one
 * place a test can call directly.
 *
 * It exists because these checks used to be spread across runLive, where the
 * only way to exercise them was to drive a live --execute run. Two of them were
 * quietly missing as a result: G2's age and naming rules were validated where
 * the provisioning record is WRITTEN but never again where it is USED, and
 * G6's documented GET-only drop for a safe-read-only probe on an unattested
 * target was never applied to the egress guard at all.
 *
 * Returns the guard's effective method list, which is `plan.methods` except
 * under that drop.
 */
export function assertRunPreconditions(plan, ctx) {
  assertTargetRouting(plan, ctx.targetKind);
  const needs = assertSafetyClassWiring(plan, {
    targetIsAttested: ctx.targetIsAttested,
    allowRealReversible: ctx.allowRealReversible ?? [],
    allowRealReadonly: ctx.allowRealReadonly === true,
  });

  // G2, on the path that USES the record rather than the one that writes it.
  // `targetIsAttested` is a two-field truthiness test: it cannot tell a record
  // provisioned an hour ago from one provisioned last month, nor a
  // `yaw-probe-` tailnet from a production one someone hand-edited in.
  if (needs.provenance) {
    assertProvenance(ctx.targetRecord, ctx.tailnetId, ctx.nowMs ?? Date.now());
    assertAttestationFresh(ctx.targetRecord, ctx.tailnetId, ctx.nowMs ?? Date.now());
  }

  // G6: "safe-read-only on an unattested target requires --allow-real-readonly
  // and forces GET-only egress." The flag half was implemented; the egress half
  // was not -- the guard's method set came straight from plan.methods, so
  // --allow-real-readonly let P14 POST and P9 POST against a real tailnet.
  const readOnlyDrop = plan.safetyClass === "safe-read-only" && ctx.targetIsAttested !== true;
  const methods = readOnlyDrop ? plan.methods.filter((method) => method === "GET") : [...plan.methods];
  return { needs, readOnlyDrop, methods };
}

/* ------------------------------------------------------------- commands -- */

async function commandRun(args, ctx, log) {
  const wanted = args.flags.all ? PLANS.map((p) => p.probeId) : args.probeIds;
  if (wanted.length === 0) {
    log("Name at least one probe id, or pass --all. `list` prints them.");
    return 2;
  }

  const plans = [];
  for (const id of wanted) {
    const plan = findPlan(id);
    if (plan) {
      plans.push(plan);
      continue;
    }
    const missing = notImplementedReason(id);
    if (missing) {
      log(`${id} is NOT IMPLEMENTED.`);
      log(`  why:     ${missing.why}`);
      log(`  instead: ${missing.instead}`);
      return 2;
    }
    log(`Unknown probe ${JSON.stringify(id)}. \`list\` prints every id.`);
    return 2;
  }

  if (args.flags.execute !== true) {
    log("DRY RUN. Nothing below is sent; this process makes no network call at all.");
    log("Re-run with --execute once the request list is what you want sent.");
    log("");
    let total = 0;
    for (const plan of plans) total += dryRunPlan(plan, ctx, log);
    if (args.flags.all) for (const line of notImplementedLines()) log(line);
    log("");
    log(`${plans.length} probe(s), ${total} planned request(s). DRY RUN -- nothing was sent.`);
    return 0;
  }

  assertExecuteAllowed({ execute: true, command: "run" });
  return runLive(plans, args, ctx, log);
}

async function runLive(plans, args, ctx, log) {
  const credential = targetCredential(ctx.probeEnv);
  if (!credential) {
    throw new ProbeRefusal(
      "no-credential",
      ctx.probeEnv.targetKind === "human"
        ? "TS_PROBE_API_KEY is unset. A human target needs the user-owned key -- invites require an inviting user."
        : "TS_PROBE_OAUTH_CLIENT_ID / TS_PROBE_OAUTH_CLIENT_SECRET are unset. An API-only target is reached with its OWN client.",
    );
  }
  // Every probe secret this environment carries, not just the one this run
  // authenticates with: a mint credential is a credential, and "is this the
  // ambient production key pasted into a probe slot?" is the same question
  // whichever slot it was pasted into.
  assertCredentialIsolation(
    {
      [credential.label]: credential.secret,
      TS_PROBE_API_KEY: ctx.probeEnv.apiKey,
      TS_PROBE_OAUTH_CLIENT_SECRET: ctx.probeEnv.oauthClientSecret,
      TS_PROBE_CREATING_CLIENT_SECRET: ctx.probeEnv.creatingClientSecret,
      TS_PROBE_DOWNSCOPE_CLIENT_SECRET: ctx.probeEnv.downscopeClientSecret,
    },
    ctx.ambient,
  );

  const pinned = resolvePinnedDist(ctx.env, { requirePin: true, repoRoot: REPO_ROOT });
  const api = await loadPinned(pinned, "api.js");
  log(`Pinned build: ${pinned.dir} (v${pinned.version})`);

  for (const plan of plans) {
    const { readOnlyDrop, methods } = assertRunPreconditions(plan, {
      targetKind: ctx.targetKind,
      targetIsAttested: ctx.targetIsAttested,
      targetRecord: ctx.targetRecord,
      tailnetId: ctx.tailnetId,
      allowRealReversible: args.allowRealReversible,
      allowRealReadonly: args.flags["allow-real-readonly"] === true,
    });
    if (readOnlyDrop) {
      log(
        `  NOTE: ${plan.probeId} is safe-read-only on an unattested target, so egress drops to GET only ` +
          `(declared ${plan.methods.join("/")}). Any non-GET step is skipped, not sent.`,
      );
      if (methods.length === 0) {
        log(
          `        ${plan.probeId} declares no GET at all, so every one of its steps is skipped here. It needs a ` +
            "target this harness provisioned.",
        );
      }
    }

    // One credential set per plan, with the module-global OAuth cache cleared
    // between them (critic amendment 3). Without this a token minted for target
    // A can be replayed on target B's arm and the "-" guard never sees it.
    api.__resetOAuthTokenCacheForTests();
    const authorization = applyProbeCredentials(credential, ctx.tailnetId, ctx.env);
    assertEnvClean(ctx.env);

    const guard = createEgressGuard({
      target: ctx.tailnetId,
      // `mode` is the label in the guard's refusal text; `methods` is the rule.
      // Under the GET-only drop the list can be EMPTY (P14's only method is
      // POST), and an empty list permits nothing, which is the intent.
      mode: readOnlyDrop || (methods.length === 1 && methods[0] === "GET") ? "readonly" : "full",
      methods,
      allowedRequests: plan.allowedRequests ?? null,
      allowBareTailnetGet: plan.allowBareTailnetGet === true,
      allowOrganizations: false,
    });
    if (authorization) guard.bindCredential(ctx.tailnetId, authorization);

    const countsOnly = plan.countsOnly === true || (plan.countsOnly === "unattested" && !ctx.targetIsAttested);
    const recorder = createRecorder({
      guard,
      tailnetId: ctx.tailnetId,
      forbidden: normalizeForbidden(ctx.probeEnv.forbidden),
      targetKind: ctx.targetKind,
      credentialKind: credential.kind,
      pinnedBuildVersion: pinned.version,
      openapiPath: ctx.probeEnv.openapi ?? null,
      countsOnly,
      repoRoot: REPO_ROOT,
    });

    // Which OAuth client this plan's mints authenticate with. P9 uses the
    // short-lived `all`-scope client in the CREATING tailnet; P15 uses its own,
    // because asking an `all`-scope production client for dns:write is a much
    // larger question than the one P15 is about.
    const mint =
      plan.mintCredential === "downscope"
        ? {
            label: "TS_PROBE_DOWNSCOPE_CLIENT_ID / _SECRET",
            clientId: ctx.probeEnv.downscopeClientId,
            clientSecret: ctx.probeEnv.downscopeClientSecret,
          }
        : {
            label: "TS_PROBE_CREATING_CLIENT_ID / _SECRET",
            clientId: ctx.probeEnv.creatingClientId,
            clientSecret: ctx.probeEnv.creatingClientSecret,
          };

    const planCtx = {
      ...ctx,
      api,
      pinned,
      guard,
      recorder,
      credentialTarget: ctx.tailnetId,
      mintedBearer: null,
      mintCredentialLabel: mint.label,
      readOnlyDrop,
      probeSafetyClass: plan.safetyClass,
      ids: Object.fromEntries(SEEDED_ID_KEYS.map((key) => [key, ctx.probeEnv[key]])),
      responses: {},
      formValues: {
        client_id: mint.clientId,
        client_secret: mint.clientSecret,
        grant_type: "client_credentials",
      },
      flags: args.flags,
    };

    log("");
    for (const line of planHeader(plan)) log(line);
    log(`  recording:   countsOnly=${countsOnly}`);

    recorder.install();
    const onInterrupt = () => {
      recorder.uninstall();
      writeState(ctx.statePath, ctx.state);
      log("");
      log("Interrupted. The cleanup journal is on disk -- run `live-probe.mjs cleanup --execute` next.");
      process.exit(130);
    };
    process.once("SIGINT", onInterrupt);
    const steps = plan.steps(planCtx);
    try {
      for (const step of steps) {
        if (step.undo) {
          journalBreadcrumb(ctx.statePath, ctx.state, {
            probeId: plan.probeId,
            step: step.n,
            aboutToSend: `${step.method} ${step.path}`,
            sweep: plan.cleanup,
          });
        }
        await executeStep(plan, step, planCtx, log);
        // apiRequest turns a thrown fetch into an envelope and RETRIES it on
        // GET/PUT/DELETE, so a guard refusal raised inside the fetch wrapper
        // would otherwise be swallowed into a failed-request result and tried
        // three more times. The request never left the process either way; this
        // turns it back into the hard stop it is supposed to be.
        if (guard.blockedRequests.length > 0) {
          const first = guard.blockedRequests[0];
          throw new ProbeRefusal(
            "egress-blocked",
            `${plan.probeId} step ${step.n} tried to send ${first.method} ${first.url} and the egress guard ` +
              `refused it (${first.why}). Nothing was sent. Stopping the run rather than continuing past a ` +
              "request the plan did not account for.",
          );
        }
      }
    } finally {
      process.removeListener("SIGINT", onInterrupt);
      recorder.uninstall();
      writeState(ctx.statePath, ctx.state);
      const blockedHere = guard.blockedRequests;
      if (blockedHere.length > 0) {
        log(`  ${blockedHere.length} request(s) were BLOCKED by the egress guard:`);
        for (const entry of blockedHere) log(`    ${entry.method} ${entry.url} -- ${entry.why}`);
      }
    }
  }
  log("");
  log("Run the `cleanup` and `scrub-check` commands before committing any fixture.");
  return 0;
}

async function commandProvision(args, ctx, log) {
  if (args.flags.execute !== true) {
    log("DRY RUN. `provision` would send:");
    log(`    POST api.tailscale.com/api/v2/organizations/${ctx.probeEnv.organization}/tailnets`);
    log(`    body:    {"displayName":"${PROBE_NAME_PREFIX}<yyyymmdd>-<4 hex>"}`);
    log("    auth:    TS_PROBE_PROVISION_CLIENT_* -- an OAuth client with ONLY the `tailnets` scope.");
    log("             An API key will not work here (tailnets.ts:11-14).");
    log("    then:    write the returned tailnet id, displayName and its OWN OAuth client to the state file,");
    log(`             at ${ctx.statePath} (outside the repo; 0600 where the OS honours it).`);
    log("");
    log("DRY RUN -- nothing was sent.");
    return 0;
  }
  assertExecuteAllowed({ execute: true, command: "provision" });

  if (!ctx.probeEnv.provisionClientId || !ctx.probeEnv.provisionClientSecret) {
    throw new ProbeRefusal(
      "no-credential",
      "TS_PROBE_PROVISION_CLIENT_ID / TS_PROBE_PROVISION_CLIENT_SECRET are unset. Creating an API-only tailnet " +
        "needs an OAuth client with the `tailnets` scope; an API key cannot do it.",
    );
  }
  assertCredentialIsolation({ TS_PROBE_PROVISION_CLIENT_SECRET: ctx.probeEnv.provisionClientSecret }, ctx.ambient);

  const pinned = resolvePinnedDist(ctx.env, { requirePin: true, repoRoot: REPO_ROOT });
  const api = await loadPinned(pinned, "api.js");
  api.__resetOAuthTokenCacheForTests();

  // The creating tailnet is addressed through the org endpoint, so there is no
  // tailnet id to set -- but TAILSCALE_TAILNET must never be left at "-" for
  // anything that follows, so the provisioning credential is applied against a
  // placeholder that the egress guard will never let reach a tailnet path.
  for (const name of ["TAILSCALE_API_KEY", "TAILSCALE_TAILNET", "TAILSCALE_OAUTH_TAILNET"]) delete ctx.env[name];
  ctx.env.TAILSCALE_OAUTH_CLIENT_ID = ctx.probeEnv.provisionClientId;
  ctx.env.TAILSCALE_OAUTH_CLIENT_SECRET = ctx.probeEnv.provisionClientSecret;
  ctx.env.TAILSCALE_TAILNET = `${PROBE_NAME_PREFIX}unset`;
  assertEnvClean(ctx.env);

  const displayName = `${PROBE_NAME_PREFIX}${new Date().toISOString().slice(0, 10).replace(/-/g, "")}-${Math.random()
    .toString(16)
    .slice(2, 6)}`;
  const guard = createEgressGuard({
    target: `${PROBE_NAME_PREFIX}unset`,
    methods: ["POST"],
    allowOrganizations: true,
  });
  const recorder = createRecorder({
    guard,
    tailnetId: `${PROBE_NAME_PREFIX}unset`,
    targetKind: "api-only",
    credentialKind: "oauth",
    pinnedBuildVersion: pinned.version,
    countsOnly: true,
    repoRoot: REPO_ROOT,
  });
  recorder.setContext({ probeId: "provision", step: 1, arm: "seed" });
  recorder.install();

  let created;
  try {
    const mod = await loadPinned(pinned, "tools/tailnets.js");
    const tool = findTool(mod.tailnetsTools, "tailscale_create_org_tailnet");
    created = await tool.handler(tool.inputSchema.parse({ displayName, organization: ctx.probeEnv.organization }));
  } finally {
    recorder.uninstall();
  }

  const data = created?.data ?? {};
  const tailnetId = data.tailnet?.id ?? data.id;
  if (!created?.ok || !tailnetId) {
    log(`provision failed: HTTP ${created?.status ?? "?"} ${created?.error ?? "no tailnet id in the response"}`);
    return 1;
  }

  ctx.state.targets[tailnetId] = {
    tailnetId,
    displayName,
    createdAt: new Date().toISOString(),
    createdByHarness: true,
    targetKind: "api-only",
    oauthClientId: data.oauthClient?.id ?? data.oauthClient?.clientId ?? null,
    oauthClientSecret: data.oauthClient?.secret ?? data.oauthClient?.clientSecret ?? null,
  };
  writeState(ctx.statePath, ctx.state);

  log(`Created ${tailnetId} (${displayName}).`);
  log(`State written to ${ctx.statePath}.`);
  log("Export these for the probe run -- the secret is returned ONCE and is now only in that file:");
  log("  TS_PROBE_TAILNET_ID=<the id above>");
  log("  TS_PROBE_TARGET_KIND=api-only");
  log("  TS_PROBE_OAUTH_CLIENT_ID / TS_PROBE_OAUTH_CLIENT_SECRET=<the client in the state file>");
  log("Do NOT set TAILSCALE_OAUTH_TAILNET. The harness refuses to run with it set: reaching a target through");
  log("`?tailnet=` on the token exchange is the unverified mechanism finding C7 is about.");
  return 0;
}

async function commandPreflight(args, ctx, log) {
  if (args.flags.execute !== true) {
    log("DRY RUN. `preflight` would send, against the declared target only:");
    for (const path of ["/tailnet/{T}/users", "/tailnet/{T}/devices", "/tailnet/{T}/dns/configuration"]) {
      log(`    GET  api.tailscale.com/api/v2${path.replace("{T}", ctx.tailnetId ?? "{T}")}`);
    }
    log("    then: refuse unless every user matches TS_PROBE_EXPECT_LOGIN (or there are none on an API-only");
    log(`          target), every device hostname starts with ${JSON.stringify(PROBE_NAME_PREFIX)}, and the DNS`);
    log("          configuration holds nothing this harness did not seed.");
    log("");
    log("DRY RUN -- nothing was sent.");
    return 0;
  }
  assertExecuteAllowed({ execute: true, command: "preflight" });

  const credential = targetCredential(ctx.probeEnv);
  if (!credential) throw new ProbeRefusal("no-credential", "No target credential in TS_PROBE_*.");
  assertCredentialIsolation({ [credential.label]: credential.secret }, ctx.ambient);

  const pinned = resolvePinnedDist(ctx.env, { requirePin: true, repoRoot: REPO_ROOT });
  const api = await loadPinned(pinned, "api.js");
  api.__resetOAuthTokenCacheForTests();
  const authorization = applyProbeCredentials(credential, ctx.tailnetId, ctx.env);
  assertEnvClean(ctx.env);

  const guard = createEgressGuard({ target: ctx.tailnetId, mode: "readonly", methods: ["GET"] });
  if (authorization) guard.bindCredential(ctx.tailnetId, authorization);
  const recorder = createRecorder({
    guard,
    tailnetId: ctx.tailnetId,
    targetKind: ctx.targetKind,
    credentialKind: credential.kind,
    pinnedBuildVersion: pinned.version,
    countsOnly: true,
    repoRoot: REPO_ROOT,
  });
  recorder.setContext({ probeId: "preflight", step: 1, arm: "observe" });
  recorder.install();

  let users;
  let devices;
  let dns;
  try {
    users = await api.apiRequest("GET", `/tailnet/${ctx.tailnetId}/users`);
    devices = await api.apiRequest("GET", `/tailnet/${ctx.tailnetId}/devices`);
    dns = await api.apiRequest("GET", `/tailnet/${ctx.tailnetId}/dns/configuration`);
  } finally {
    recorder.uninstall();
  }

  const attestation = assertServerAttestedEmptiness({
    users: users?.data,
    devices: devices?.data,
    dnsConfiguration: dns?.ok ? dns.data : undefined,
    expectLogin: ctx.probeEnv.expectLogin,
    targetKind: ctx.targetKind,
  });

  const record = ctx.state.targets[ctx.tailnetId];
  if (record) {
    assertProvenance(record, ctx.tailnetId);
    record.attestedAt = new Date().toISOString();
    record.attestation = attestation;
    writeState(ctx.statePath, ctx.state);
    log(`${ctx.tailnetId} is attested: provisioned by this harness and server-attested empty.`);
  } else {
    log(`${ctx.tailnetId} passed the emptiness checks but has NO provisioning record.`);
    log("Unsafe probes still refuse it. Reversible ones need --allow-real-reversible=<probeId> each.");
  }
  log(`  users: ${attestation.userCount}   devices: ${attestation.deviceCount}   dns: ${dns?.status}`);
  return 0;
}

async function commandCleanup(args, ctx, log) {
  const pending = ctx.state.journal.filter((entry) => entry.kind === "undo" && entry.done !== true && entry.undo.id);
  if (args.flags.execute !== true) {
    log(`DRY RUN. The journal holds ${pending.length} entr(y|ies) still to undo:`);
    for (const entry of pending) log(`    ${entry.undo.method} ${entry.undo.path}   (from ${entry.probeId})`);
    log("");
    log("DRY RUN -- nothing was sent.");
    return 0;
  }
  assertExecuteAllowed({ execute: true, command: "cleanup" });

  const credential = targetCredential(ctx.probeEnv);
  if (!credential) throw new ProbeRefusal("no-credential", "No target credential in TS_PROBE_*.");
  const pinned = resolvePinnedDist(ctx.env, { requirePin: true, repoRoot: REPO_ROOT });
  const api = await loadPinned(pinned, "api.js");
  api.__resetOAuthTokenCacheForTests();
  const authorization = applyProbeCredentials(credential, ctx.tailnetId, ctx.env);
  assertEnvClean(ctx.env);

  const guard = createEgressGuard({ target: ctx.tailnetId, methods: ["GET", "DELETE", "PUT", "POST"] });
  if (authorization) guard.bindCredential(ctx.tailnetId, authorization);
  for (const entry of pending) guard.registerId(entry.undo.id);
  const recorder = createRecorder({
    guard,
    tailnetId: ctx.tailnetId,
    targetKind: ctx.targetKind,
    credentialKind: credential.kind,
    pinnedBuildVersion: pinned.version,
    countsOnly: true,
    repoRoot: REPO_ROOT,
  });
  recorder.install();
  try {
    for (const entry of pending) {
      recorder.setContext({ probeId: entry.probeId, step: entry.step, arm: "cleanup" });
      const res = await api.apiRequest(
        entry.undo.method,
        resolvePath(entry.undo.path, ctx.tailnetId, {}),
        entry.undo.body ?? undefined,
      );
      entry.done = res.ok || res.status === 404;
      log(`  ${entry.undo.method} ${entry.undo.path} -> ${res.status}${entry.done ? "" : "  STILL PENDING"}`);
    }
  } finally {
    recorder.uninstall();
    writeState(ctx.statePath, ctx.state);
  }
  const stillPending = ctx.state.journal.filter(
    (entry) => entry.kind === "undo" && entry.done !== true && entry.undo.id,
  );
  const manual = ctx.state.journal.filter((entry) => entry.needsManualSweep === true);
  if (manual.length > 0) {
    log(`${manual.length} create(s) returned no id, so they cannot be replayed. Sweep these by hand:`);
    for (const entry of manual) log(`    ${entry.probeId} step ${entry.step}: ${entry.undo.method} ${entry.undo.path}`);
  }
  return stillPending.length > 0 || manual.length > 0 ? 1 : 0;
}

async function commandTeardown(args, ctx, log) {
  const confirm = args.flags["destroy-tailnet"];
  if (args.flags.execute !== true) {
    log("DRY RUN. `teardown` would send:");
    log(`    DELETE api.tailscale.com/api/v2/tailnet/${ctx.tailnetId ?? "{T}"}`);
    log(
      `    GET    api.tailscale.com/api/v2/organizations/${ctx.probeEnv.organization}/tailnets  (confirm it is gone)`,
    );
    log("    interlocks: a provisioning record younger than 7 days whose displayName starts with");
    log(`                ${JSON.stringify(PROBE_NAME_PREFIX)}, plus --destroy-tailnet=<id> matching byte for byte.`);
    log("");
    log("DRY RUN -- nothing was sent.");
    return 0;
  }
  assertExecuteAllowed({ execute: true, command: "teardown" });
  assertProvenance(ctx.state.targets[ctx.tailnetId], ctx.tailnetId);
  assertTypedConfirmation(typeof confirm === "string" ? confirm : undefined, ctx.tailnetId);

  const credential = targetCredential(ctx.probeEnv);
  if (!credential) throw new ProbeRefusal("no-credential", "No target credential in TS_PROBE_*.");
  const pinned = resolvePinnedDist(ctx.env, { requirePin: true, repoRoot: REPO_ROOT });
  const api = await loadPinned(pinned, "api.js");
  api.__resetOAuthTokenCacheForTests();
  const authorization = applyProbeCredentials(credential, ctx.tailnetId, ctx.env);
  assertEnvClean(ctx.env);

  const guard = createEgressGuard({ target: ctx.tailnetId, methods: ["GET", "DELETE"], allowOrganizations: true });
  if (authorization) guard.bindCredential(ctx.tailnetId, authorization);
  const recorder = createRecorder({
    guard,
    tailnetId: ctx.tailnetId,
    targetKind: ctx.targetKind,
    credentialKind: credential.kind,
    pinnedBuildVersion: pinned.version,
    countsOnly: true,
    repoRoot: REPO_ROOT,
  });
  recorder.setContext({ probeId: "teardown", step: 1, arm: "cleanup" });
  recorder.install();
  let deleted;
  let listed;
  try {
    const mod = await loadPinned(pinned, "tools/tailnets.js");
    const del = findTool(mod.tailnetsTools, "tailscale_delete_tailnet");
    deleted = await del.handler(del.inputSchema.parse({ tailnet: ctx.tailnetId, confirmTailnet: ctx.tailnetId }));
    const list = findTool(mod.tailnetsTools, "tailscale_list_org_tailnets");
    listed = await list.handler(list.inputSchema.parse({ organization: ctx.probeEnv.organization }));
  } finally {
    recorder.uninstall();
  }

  log(`DELETE -> ${deleted?.status}`);
  log(`org list -> ${listed?.status}`);
  if (deleted?.ok) {
    ctx.state.targets[ctx.tailnetId].deletedAt = new Date().toISOString();
    writeState(ctx.statePath, ctx.state);
  }
  log("Now revoke the `tailnets` client, and the P9 `all`-scope client if one was issued.");
  return deleted?.ok ? 0 : 1;
}

/* --------------------------------------------------------- scrub-check -- */

/**
 * Grep the fixtures and the journal for the literal probe credentials.
 *
 * `TS_PROBE_FIXTURE_ROOT` points it at a different directory. That exists so
 * the offline test can prove this command actually FINDS a leak without
 * planting one in the committed tree, and so a fixture set can be swept before
 * it is moved into fixtures/live.
 */
function commandScrubCheck(ctx, log) {
  const fixtureRoot = ctx.probeEnv.fixtureRoot ? resolve(ctx.probeEnv.fixtureRoot) : FIXTURE_ROOT;
  const secrets = [
    ["TS_PROBE_API_KEY", ctx.probeEnv.apiKey],
    ["TS_PROBE_OAUTH_CLIENT_SECRET", ctx.probeEnv.oauthClientSecret],
    ["TS_PROBE_PROVISION_CLIENT_SECRET", ctx.probeEnv.provisionClientSecret],
    ["TS_PROBE_CREATING_CLIENT_SECRET", ctx.probeEnv.creatingClientSecret],
    ...Object.values(ctx.state.targets ?? {}).flatMap((t) =>
      t.oauthClientSecret ? [[`state:${t.tailnetId}`, t.oauthClientSecret]] : [],
    ),
  ].filter(([, value]) => typeof value === "string" && value.length > 0);

  const files = fixtureFiles(fixtureRoot);
  log(
    `scrub-check: ${files.length} fixture file(s) under ${fixtureRoot}, ${secrets.length} live secret(s) to look for.`,
  );
  log(
    `Secrets are compared by value and reported by fingerprint only: ${secrets.map(([n]) => n).join(", ") || "none"}`,
  );

  let findings = 0;
  // The credential comparison is what only this command can do: it has the
  // operator's own shell to compare against.
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    for (const [name, value] of secrets) {
      if (text.includes(value)) {
        findings++;
        log(`  LEAK  ${file}  contains ${name} (${shortFingerprint(value)})`);
      }
    }
  }
  // Everything else is the SAME scanner src/live-fixtures.test.ts runs, rather
  // than a second, narrower copy of the rules that can drift away from it.
  // `why` never carries the matched text; the evidence is fingerprinted.
  for (const finding of scanFixtures(fixtureRoot, REQUIRED_PROVENANCE_KEYS)) {
    findings++;
    const evidence = finding.evidence ? ` (${shortFingerprint(finding.evidence)})` : "";
    log(`  LEAK  ${finding.file}  ${finding.why}${evidence}`);
  }
  if (ctx.state.journal.length > 0) {
    const journalText = JSON.stringify(ctx.state.journal);
    for (const [name, value] of secrets) {
      if (journalText.includes(value)) {
        findings++;
        log(`  LEAK  the cleanup journal contains ${name} (${shortFingerprint(value)})`);
      }
    }
  }
  log(findings === 0 ? "scrub-check: clean." : `scrub-check: ${findings} finding(s). Do NOT commit.`);
  return findings === 0 ? 0 : 1;
}

/** A one-line, refusal-free read of the pinned-build interlock, for the dry run. */
function pinnedStatus(env) {
  try {
    const pinned = resolvePinnedDist(env, { requirePin: true, repoRoot: REPO_ROOT });
    return `${pinned.dir} (v${pinned.version})`;
  } catch (err) {
    return `NOT READY -- ${err instanceof Error ? err.message.split(".")[0] : String(err)}`;
  }
}

/* ----------------------------------------------------------------- main -- */

export async function main(argv, { env = process.env, log = console.log } = {}) {
  // FIRST, before anything imports a compiled module: the owner's shell exports
  // the real TAILSCALE_API_KEY, and api.ts would prefer it over anything set
  // here. After this line the harness no longer holds it.
  const { removed, ambient } = stripAmbientCredentials(env);

  const args = parseArgs(argv);
  if (args.badOptions.length > 0) {
    // Before anything else: a mistyped option must not be silently dropped
    // while the rest of the command line runs. `-execute` used to parse as
    // `--execute`; now neither form of typo does anything but exit.
    log(`Unrecognised option(s): ${args.badOptions.join(", ")}. Every option takes TWO leading dashes.`);
    log(USAGE);
    return 2;
  }
  if (args.command === null || args.flags.help === true || !COMMANDS.includes(args.command)) {
    log(USAGE);
    return args.command === null || args.flags.help === true ? 0 : 2;
  }

  log(
    `live-probe: stripped ${removed.length} TAILSCALE_* variable(s) from this process: ${removed.join(", ") || "none"}`,
  );
  if (ambient.apiKeyFingerprint) {
    log(`  the ambient API key is remembered only as a fingerprint (${ambient.apiKeyFingerprint.slice(0, 12)}...),`);
    log("  so a probe credential that IS that key can be refused without the value ever being used.");
  }

  const probeEnv = readProbeEnv(env);
  const statePath = stateFilePath(env, args.flags);
  // Once, here, rather than in the two commands that happened to call it: five
  // commands write this file and every one of them writes `state.targets`,
  // which carries a disposable tailnet's OAuth client secret.
  assertStatePathSafe(statePath, { repoRoot: REPO_ROOT });
  const state = readState(statePath);

  if (args.command === "list") {
    for (const plan of PLANS) {
      for (const line of planHeader(plan)) log(line);
      log("");
    }
    for (const line of notImplementedLines()) log(line);
    return 0;
  }

  if (args.command === "scrub-check") {
    return commandScrubCheck({ probeEnv, state }, log);
  }

  // G1 for every command that can actually send: an explicit target and a
  // non-empty forbidden list, before a single byte can leave. A dry run is
  // exempt because it sends nothing -- it REPORTS the interlock state instead,
  // so the owner can read the request list before wiring any credential up.
  const forbidden = normalizeForbidden([...probeEnv.forbidden, ambient.tailnet, ambient.oauthTailnet]);
  const willExecute = args.flags.execute === true;
  let tailnetId = probeEnv.tailnetId;
  if (willExecute && args.command !== "provision") {
    tailnetId = assertExplicitTarget(probeEnv.tailnetId, forbidden);
  } else if (!willExecute) {
    log("");
    log("Interlocks, as this environment currently stands:");
    log(`  target (TS_PROBE_TAILNET_ID):       ${probeEnv.tailnetId ?? "UNSET -- --execute would refuse"}`);
    log(
      `  forbidden list (mandatory):         ${forbidden.length > 0 ? `${forbidden.length} entr(y|ies)` : "EMPTY -- --execute would refuse"}`,
    );
    log(`  target kind:                        ${probeEnv.targetKind ?? "unset (assumed api-only)"}`);
    log(`  pinned v0.20.2 build:               ${pinnedStatus(env)}`);
    log(`  state file:                         ${statePath}`);
  }
  // G0, the half that only matters for a caller inside this process. `main`
  // strips the env object it is HANDED, but api.ts reads process.env directly
  // (getAuthConfig at api.ts:58-63, getTailnet at :231-233). Handed a synthetic
  // env -- which is how the offline tests drive this -- the ambient
  // TAILSCALE_API_KEY would still be sitting in process.env when the pinned
  // build assembles its Authorization header, and the ambient fingerprints
  // assertCredentialIsolation compares against would have been computed from
  // the synthetic object, so that check would pass on a credential it never
  // saw. Nothing above this line sends anything, and nothing below it runs.
  if (willExecute && env !== process.env) {
    throw new ProbeRefusal(
      "synthetic-env",
      "--execute was asked for through main(argv, { env }) with an injected environment. The strip that makes " +
        "this harness safe applies to the object it is given, and api.ts reads process.env -- so an ambient " +
        "TAILSCALE_API_KEY would authenticate every request while the probe credential went somewhere api.ts " +
        "never looks. Run the CLI (`node scripts/live-probe.mjs ...`) to send anything; the injected-env entry " +
        "point is for dry runs and tests.",
    );
  }

  const targetKind = probeEnv.targetKind ?? "api-only";
  const record = tailnetId ? state.targets[tailnetId] : undefined;
  const targetIsAttested = Boolean(record?.createdByHarness && record?.attestedAt);

  const ctx = {
    env,
    ambient,
    probeEnv,
    statePath,
    state,
    tailnetId,
    targetKind,
    targetIsAttested,
    targetRecord: record,
    now: new Date(),
    flags: args.flags,
  };

  switch (args.command) {
    case "provision":
      return commandProvision(args, ctx, log);
    case "preflight":
      return commandPreflight(args, ctx, log);
    case "run":
      return commandRun(args, ctx, log);
    case "cleanup":
      return commandCleanup(args, ctx, log);
    case "teardown":
      return commandTeardown(args, ctx, log);
    default:
      log(USAGE);
      return 2;
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (invokedDirectly) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err) => {
      if (err instanceof ProbeRefusal) {
        console.error(`REFUSED [${err.code}] ${err.message}`);
        process.exitCode = 3;
        return;
      }
      console.error(err instanceof Error ? err.stack : String(err));
      process.exitCode = 1;
    });
}

// Re-exported so the offline tests can assert the redaction contract without
// reaching into the recorder's internals.
export { fingerprint, REDACTED_KEYS };
