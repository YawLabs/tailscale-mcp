/**
 * The recording fetch wrapper for the live shape probe harness.
 *
 * It exists because apiRequest collapses an error body through
 * extractErrorMessage (api.ts:350-365, :816-822), so the raw 400 -- exactly
 * what the hand-built mocks in handlers.test.ts never had -- would be lost if
 * the harness only kept the handler's return value. Every fixture therefore
 * stores BOTH `wire` (what crossed the socket) and `envelope` (what an agent
 * sees today).
 *
 * Three things it does that are not obvious:
 *
 *  - It records EVERY attempt. api.ts retries GET/PUT/DELETE on 429 and on
 *    transport errors (api.ts:34, :701-768), up to four times, so a single
 *    logical request can hit the wire repeatedly. The fixture keeps them all
 *    and names the last one as the observation.
 *  - Redaction is deny-by-default and runs before anything reaches disk, so a
 *    crash between the response and the fixture write cannot leave a secret in
 *    a half-written file: there is no unredacted copy to write.
 *  - For reads against a tailnet that is NOT attested as disposable it keeps
 *    counts, key sets and booleans only -- never records. That is the same
 *    counts-only discipline as the throwaway scratchpad probe this replaces,
 *    and it is what makes P1 and the P9 discriminator safe to point at a real
 *    tailnet at all.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { API_HOST, REPO_ROOT } from "./probe-guard.mjs";

/**
 * Keys whose VALUE is replaced wherever they appear, at any depth. Deny-by-
 * default: this list is applied to every body the harness sees, request and
 * response alike, and the type is preserved so a fixture still documents the
 * shape.
 */
export const REDACTED_KEYS = [
  "key",
  "secret",
  "clientSecret",
  "client_secret",
  "access_token",
  "accessToken",
  "refresh_token",
  "token",
  "inviteUrl",
  "inviteCode",
  "invite",
  "s3SecretAccessKey",
  "s3AccessKeyId",
  "password",
  "authorization",
];

/** Every fixture carries these, re-read at write time rather than cached. */
export const REQUIRED_PROVENANCE_KEYS = [
  "capturedAt",
  "harness",
  "packageVersion",
  "gitHead",
  "targetKind",
  "credentialKind",
  "pinnedBuildVersion",
];

export const HARNESS_ID = "scripts/live-probe.mjs";

/** Request headers worth keeping. Authorization is never one of them. */
const KEPT_REQUEST_HEADERS = ["content-type", "accept", "if-match"];
const KEPT_RESPONSE_HEADERS = ["content-type", "etag", "content-length", "retry-after"];

const TSKEY_RE = /\b(tskey-[A-Za-z0-9-]+)/g;
const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const TS_NET_RE = /\btail[0-9a-f]+\.ts\.net\b/gi;
const BEARER_RE = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi;

/**
 * Scrub a STRING. Runs on every string the harness persists, including ones
 * nested inside a JSON body and including raw bodies that never parsed.
 *
 * `tailnetId` is replaced with the literal `{tailnet}` so a fixture can be
 * committed and replayed against any tailnet, and so the offline integrity test
 * can assert no raw tailnet id survived.
 */
export function scrubString(value, { tailnetId, forbidden = [] } = {}) {
  let out = String(value);
  out = out.replace(BEARER_RE, (_m, scheme) => `${scheme} <redacted:credential>`);
  out = out.replace(TSKEY_RE, "<redacted:tskey>");
  out = out.replace(EMAIL_RE, "user@example.com");
  out = out.replace(TS_NET_RE, "tailXXXX.ts.net");
  if (tailnetId) out = replaceAllLiteral(out, tailnetId, "{tailnet}");
  for (const entry of forbidden) {
    if (entry) out = replaceAllLiteral(out, entry, "{forbidden-tailnet}");
  }
  return out;
}

function replaceAllLiteral(haystack, needle, replacement) {
  if (!needle) return haystack;
  return haystack.split(needle).join(replacement);
}

/**
 * Redact a parsed JSON value. Keys on REDACTED_KEYS lose their value but keep
 * their type, every remaining string is scrubbed, and the json paths that were
 * touched come back so the fixture can say what it hid.
 */
export function redactValue(value, opts = {}, path = "$", redactions = []) {
  if (value === null || value === undefined) return { value, redactions };
  if (typeof value === "string") {
    return { value: scrubString(value, opts), redactions };
  }
  if (typeof value === "number" || typeof value === "boolean") return { value, redactions };
  if (Array.isArray(value)) {
    const out = value.map((entry, i) => redactValue(entry, opts, `${path}[${i}]`, redactions).value);
    return { value: out, redactions };
  }
  if (typeof value === "object") {
    const out = {};
    for (const [key, entry] of Object.entries(value)) {
      const here = `${path}.${key}`;
      if (REDACTED_KEYS.some((name) => name.toLowerCase() === key.toLowerCase())) {
        redactions.push(here);
        out[key] = redactedPlaceholder(entry);
        continue;
      }
      out[key] = redactValue(entry, opts, here, redactions).value;
    }
    return { value: out, redactions };
  }
  return { value: String(value), redactions };
}

function redactedPlaceholder(original) {
  if (Array.isArray(original)) return original.map(() => "<redacted>");
  if (typeof original === "number") return 0;
  if (typeof original === "boolean") return original;
  if (original === null) return null;
  if (typeof original === "object") return { "<redacted>": true };
  return "<redacted>";
}

/**
 * Counts-only projection for reads against a tailnet that is not attested as
 * disposable. Audit and flow logs carry actor emails, IPs and node names; a
 * device list carries every hostname. None of that goes to disk.
 */
export function summarize(value, depth = 0) {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    return {
      kind: "array",
      length: value.length,
      firstElementKeys: value.length > 0 && isPlainObject(value[0]) ? Object.keys(value[0]).sort() : null,
    };
  }
  if (isPlainObject(value)) {
    if (depth >= 1) return { kind: "object", keys: Object.keys(value).sort() };
    const out = { kind: "object", keys: Object.keys(value).sort(), children: {} };
    for (const [key, entry] of Object.entries(value)) {
      out.children[key] = summarize(entry, depth + 1);
    }
    return out;
  }
  return { kind: typeof value };
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A value-free map of every key set in a document: json path -> sorted keys.
 * Array elements collapse to one `[]` entry whose key set is the UNION over the
 * elements, so a resolver list that is uniform reads as one row and a ragged one
 * is visible immediately.
 *
 * This is what critic amendment 4 asks for on P4a/P4b: compare FULL key sets at
 * every level -- top-level, preferences, each resolver object -- not just the
 * keys that went missing. It is safe to record even under countsOnly, because a
 * key name is a schema fact, not tailnet data.
 */
export function keySetMap(value, path = "$", out = {}) {
  if (Array.isArray(value)) {
    const here = `${path}[]`;
    for (const entry of value) keySetMap(entry, here, out);
    return out;
  }
  if (isPlainObject(value)) {
    const keys = Object.keys(value).sort();
    out[path] = [...new Set([...(out[path] ?? []), ...keys])].sort();
    for (const [key, entry] of Object.entries(value)) keySetMap(entry, `${path}.${key}`, out);
    return out;
  }
  return out;
}

/** Read the repo's current version and git HEAD at WRITE time, never cached. */
export function readProvenanceBasics(repoRoot = REPO_ROOT) {
  let packageVersion = null;
  try {
    packageVersion = JSON.parse(readFileSync(resolve(repoRoot, "package.json"), "utf8")).version ?? null;
  } catch {
    packageVersion = null;
  }
  const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8", timeout: 10_000 });
  const gitHead = head.status === 0 ? String(head.stdout).trim() : null;
  return { packageVersion, gitHead };
}

export function sha256File(path) {
  if (!path || !existsSync(path)) return null;
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function normalizeHeaders(headers) {
  const out = {};
  if (!headers) return out;
  if (typeof Headers !== "undefined" && headers instanceof Headers) {
    for (const [key, value] of headers.entries()) out[key.toLowerCase()] = value;
    return out;
  }
  if (Array.isArray(headers)) {
    for (const [key, value] of headers) out[String(key).toLowerCase()] = String(value);
    return out;
  }
  for (const [key, value] of Object.entries(headers)) out[String(key).toLowerCase()] = String(value);
  return out;
}

function pickHeaders(headers, keep) {
  const out = {};
  for (const name of keep) {
    if (headers[name] !== undefined) out[name] = headers[name];
  }
  return out;
}

function bodyToString(body) {
  if (body === undefined || body === null) return undefined;
  if (typeof body === "string") return body;
  if (typeof URLSearchParams !== "undefined" && body instanceof URLSearchParams) return body.toString();
  return String(body);
}

/**
 * Parse a request or response body into something a fixture can hold: parsed
 * JSON when it is JSON, a form map when it is urlencoded, otherwise the raw
 * text. Never throws -- an unparseable body is itself an observation.
 */
export function parseBody(text, contentType = "") {
  if (text === undefined || text === null || text === "") return { parsed: null, raw: text ?? null };
  const type = String(contentType).toLowerCase();
  if (type.includes("x-www-form-urlencoded")) {
    const parsed = {};
    for (const [key, value] of new URLSearchParams(text).entries()) parsed[key] = value;
    return { parsed, raw: text };
  }
  const trimmed = String(text).trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return { parsed: JSON.parse(trimmed), raw: text };
    } catch {
      return { parsed: null, raw: text };
    }
  }
  return { parsed: null, raw: text };
}

/**
 * Create the recorder.
 *
 * `countsOnly` is the real-tailnet read mode: response bodies are reduced to
 * counts and key sets before redaction, so no record from someone's live
 * tailnet ever reaches the fixture.
 */
export function createRecorder({
  guard,
  tailnetId,
  forbidden = [],
  targetKind,
  credentialKind,
  pinnedBuildVersion,
  openapiPath = null,
  countsOnly = false,
  paceMs = 1000,
  repoRoot = REPO_ROOT,
  now = () => new Date(),
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
}) {
  const scrubOpts = { tailnetId, forbidden };
  const attempts = [];
  let installed = null;
  let lastRequestAt = 0;
  // `derive` is how a countsOnly step keeps the ONE fact it needs out of a body
  // it must not persist -- P9's markerPresent boolean, read off the real
  // tailnet's search paths. It runs on the parsed body before redaction and
  // only its return value survives.
  let context = { probeId: "<none>", step: "<none>", arm: "<none>", derive: null };

  async function pace() {
    const wait = paceMs - (Date.now() - lastRequestAt);
    if (wait > 0) await sleep(wait);
    lastRequestAt = Date.now();
  }

  function recordRequest(url, method, headers, bodyText) {
    const parsedUrl = new URL(url);
    const { parsed, raw } = parseBody(bodyText, headers["content-type"]);
    const path = scrubString(`${parsedUrl.pathname}${parsedUrl.search}`, scrubOpts);
    return {
      method,
      host: parsedUrl.host,
      path,
      headers: pickHeaders(headers, KEPT_REQUEST_HEADERS),
      body: parsed === null ? null : redactValue(parsed, scrubOpts).value,
      rawBody: parsed === null && raw ? scrubString(raw, scrubOpts) : null,
    };
  }

  async function recordResponse(res) {
    const headers = {};
    for (const [key, value] of res.headers.entries()) headers[key.toLowerCase()] = value;
    let text = "";
    try {
      text = await res.clone().text();
    } catch (err) {
      text = "";
      return {
        status: res.status,
        headers: pickHeaders(headers, KEPT_RESPONSE_HEADERS),
        body: null,
        rawBody: null,
        bodyReadError: String(err instanceof Error ? err.message : err),
      };
    }
    const { parsed, raw } = parseBody(text, headers["content-type"]);
    // Key sets are recorded in BOTH modes: a key name is a schema fact, not
    // tailnet data, and the P4a/P4b round trip is decided by comparing them.
    const keySets = parsed === null ? null : keySetMap(parsed);
    let derived = null;
    if (typeof context.derive === "function") {
      try {
        derived = redactValue(context.derive(parsed, raw), scrubOpts).value;
      } catch (err) {
        derived = { deriveError: String(err instanceof Error ? err.message : err) };
      }
    }
    if (countsOnly) {
      return {
        status: res.status,
        headers: pickHeaders(headers, KEPT_RESPONSE_HEADERS),
        body: null,
        rawBody: null,
        countsOnly: true,
        keySets,
        derived,
        summary: parsed === null ? { kind: "text", length: String(raw ?? "").length } : summarize(parsed),
      };
    }
    return {
      status: res.status,
      headers: pickHeaders(headers, KEPT_RESPONSE_HEADERS),
      body: parsed === null ? null : redactValue(parsed, scrubOpts).value,
      rawBody: parsed === null && raw ? scrubString(raw, scrubOpts) : null,
      keySets,
      derived,
    };
  }

  return {
    get attempts() {
      return attempts.slice();
    },
    get countsOnly() {
      return countsOnly;
    },
    setContext(next) {
      context = { ...context, ...next };
      guard?.setContext?.({ probeId: context.probeId, step: context.step });
    },

    /**
     * Install the wrapper on globalThis.fetch. api.ts reads the global at call
     * time (api.ts:138, :562-567), which is the same property the unit tests
     * stub (handlers.test.ts:69-74), so this captures the token exchange too.
     */
    install(target = globalThis) {
      if (installed) throw new Error("The probe recorder is already installed.");
      const original = target.fetch;
      installed = { target, original };
      target.fetch = async (input, init) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : String(input?.url ?? "");
        const method = String(init?.method ?? input?.method ?? "GET").toUpperCase();
        const headers = normalizeHeaders(init?.headers ?? input?.headers);
        const bodyText = bodyToString(init?.body ?? undefined);

        // Refuses BEFORE the socket: a blocked request never leaves the process.
        guard.check(url, method, headers.authorization);

        await pace();
        const startedAt = now().toISOString();
        let res;
        let transportError = null;
        try {
          res = await original.call(target, input, init);
        } catch (err) {
          transportError = String(err instanceof Error ? `${err.name}: ${err.message}` : err);
        }
        const attempt = {
          index: attempts.length,
          probeId: context.probeId,
          step: context.step,
          arm: context.arm,
          startedAt,
          request: recordRequest(url, method, headers, bodyText),
          response: res ? await recordResponse(res) : null,
          transportError,
        };
        attempts.push(attempt);
        if (transportError) throw new Error(transportError);
        return res;
      };
      return this;
    },

    uninstall() {
      if (!installed) return this;
      installed.target.fetch = installed.original;
      installed = null;
      return this;
    },

    /** Attempts recorded for the current step, oldest first. */
    attemptsFor(probeId, step) {
      return attempts.filter((a) => a.probeId === probeId && a.step === step);
    },

    /**
     * Build the fixture for one step. `envelope` is the ApiResponse the handler
     * returned (what an agent sees); the wire truth comes from the attempts.
     */
    buildFixture({ probeId, step, arm, tool = null, envelope = null, stateBefore = null, stateAfter = null, note }) {
      const mine = this.attemptsFor(probeId, step);
      const final = mine.length > 0 ? mine[mine.length - 1] : null;
      const { packageVersion, gitHead } = readProvenanceBasics(repoRoot);
      const redactions = [];
      const envelopeOut = envelope === null ? null : redactValue(envelope, scrubOpts, "$.envelope", redactions).value;
      return {
        probeId,
        step,
        arm,
        note: note ?? null,
        provenance: {
          capturedAt: now().toISOString(),
          harness: HARNESS_ID,
          packageVersion,
          gitHead,
          targetKind,
          credentialKind,
          pinnedBuildVersion: pinnedBuildVersion ?? null,
          openapiSha256: sha256File(openapiPath),
          countsOnly,
        },
        tool,
        request: final?.request ?? null,
        response: final?.response ?? null,
        transportError: final?.transportError ?? null,
        envelope: envelopeOut,
        stateBefore: stateBefore === null ? null : redactValue(stateBefore, scrubOpts, "$.stateBefore").value,
        stateAfter: stateAfter === null ? null : redactValue(stateAfter, scrubOpts, "$.stateAfter").value,
        attempts: mine,
        redactions: [...new Set(redactions)].sort(),
      };
    },

    writeFixture(dir, fixture) {
      mkdirSync(dir, { recursive: true });
      const name = `${String(fixture.step).padStart(2, "0")}-${fixture.arm}-${slug(fixture.probeId)}.json`;
      const path = resolve(dir, name);
      writeFileSync(path, `${JSON.stringify(fixture, null, 2)}\n`, "utf8");
      return path;
    },
  };
}

function slug(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * Render one planned step for the dry-run review. This is what the owner reads
 * BEFORE anything is sent, so it prints the method, the resolved path, the
 * headers it will carry (with Authorization shown as the placeholder it always
 * is in a fixture), the body, and which target the arm addresses.
 */
export function describePlannedStep(step, { tailnetId = "{T}", indent = "    " } = {}) {
  const lines = [];
  const path = String(step.path ?? "").replace(/\{T\}/g, tailnetId);
  lines.push(`${indent}${String(step.arm).toUpperCase().padEnd(7)} ${step.method} ${API_HOST}/api/v2${path}`);
  const headers = { ...(step.headers ?? {}), authorization: "<redacted:credential>" };
  lines.push(`${indent}  headers: ${JSON.stringify(headers)}`);
  if (step.bodyFromStep !== undefined) {
    lines.push(`${indent}  body:    <the response of step ${step.bodyFromStep}, written back verbatim>`);
  } else if (step.body !== undefined) {
    lines.push(`${indent}  body:    ${step.body === null ? "<none>" : JSON.stringify(step.body)}`);
  }
  if (step.form !== undefined) {
    lines.push(`${indent}  form:    ${JSON.stringify(redactValue(step.form).value)}`);
  }
  if (step.tool) {
    lines.push(`${indent}  tool:    ${step.tool.name}  input=${JSON.stringify(step.tool.input)}`);
  }
  if (step.undo) {
    lines.push(`${indent}  undo:    ${step.undo.method} ${String(step.undo.path).replace(/\{T\}/g, tailnetId)}`);
  }
  if (step.note) lines.push(`${indent}  note:    ${step.note}`);
  return lines;
}
