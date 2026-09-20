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
 *    counts, key sets and booleans only -- never records, and never a map KEY
 *    that is not a plain identifier, because split-DNS documents are keyed by
 *    domain name and a key set would otherwise carry the operator's internal
 *    domains straight into a committed fixture. That is the same counts-only
 *    discipline as the throwaway scratchpad probe this replaces, and it is what
 *    makes P1 and the P9 discriminator safe to point at a real tailnet at all.
 *    It applies to BOTH halves of a fixture. `response` is projected in
 *    recordResponse and `envelope` in buildFixture, because the envelope is the
 *    same document one field further down -- `ApiResponse.data`, or
 *    rawRequest's `parsed`/`raw` -- and projecting only the first half nulled
 *    `response.body` and then wrote the whole body four lines later.
 *
 * It also owns the offline fixture scanner (scanFixtures), so the committed
 * integrity gate in src/live-fixtures.test.ts and `live-probe.mjs scrub-check`
 * enforce ONE rule set rather than two that can drift apart.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
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

/**
 * The committed-fixture integrity rules, in ONE place.
 *
 * Both readers of this list check the same thing: src/live-fixtures.test.ts,
 * which is the only gate that runs in `npm test`, and `live-probe.mjs
 * scrub-check`, which additionally compares against the literal credentials in
 * the operator's shell -- something a committed test cannot do. They used to
 * carry separate regex sets with different thresholds, which meant a fixture
 * could pass one and fail the other.
 *
 * `evidence` is the matched text. scrub-check reports it by fingerprint and
 * never prints it; the test asserts on `why`.
 */
const SCAN_RULES = [
  { why: "contains a tskey- prefix", pattern: /tskey-/ },
  { why: "contains a raw control-plane id", pattern: /\b[0-9a-zA-Z]{5,}CNTRL\b/ },
  { why: "contains an invite code", pattern: /\/admin\/invite\/[A-Za-z0-9]/ },
  { why: "contains a raw tailNNNN.ts.net name", pattern: /\btail[0-9a-f]+\.ts\.net\b/ },
  { why: "contains an Authorization credential", pattern: /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{16,}/ },
];
const SCAN_EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const SCAN_EXAMPLE_DOMAIN_RE = /@example\.(com|org|net)$/;
const REDACTION_PLACEHOLDER_RE = /<redacted(:[a-z-]+)?>/g;

/** Every .json file under `root`, recursively. Missing directory -> no files. */
export function fixtureFiles(root, out = []) {
  if (!existsSync(root)) return out;
  for (const name of readdirSync(root)) {
    const path = join(root, name);
    if (statSync(path).isDirectory()) fixtureFiles(path, out);
    else if (name.endsWith(".json")) out.push(path);
  }
  return out;
}

/**
 * Scan a directory of fixtures. Returns findings rather than throwing, so a
 * caller can report WHICH rule fired.
 */
export function scanFixtures(root, requiredProvenanceKeys = REQUIRED_PROVENANCE_KEYS) {
  const findings = [];
  for (const file of fixtureFiles(root)) {
    const text = readFileSync(file, "utf8");
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      findings.push({ file, why: `not valid JSON: ${err instanceof Error ? err.message : String(err)}` });
      continue;
    }

    const provenance = parsed?.provenance;
    if (!provenance || typeof provenance !== "object") {
      findings.push({ file, why: "missing provenance" });
    } else {
      for (const key of requiredProvenanceKeys) {
        if (!(key in provenance)) findings.push({ file, why: `provenance is missing ${key}` });
      }
    }

    // The redaction placeholders come out first: `<redacted:tskey>` must not
    // read as a leaked key, and `Bearer <redacted:credential>` must not read as
    // a leaked token.
    const scrubbed = text.replace(REDACTION_PLACEHOLDER_RE, "");
    for (const rule of SCAN_RULES) {
      const match = rule.pattern.exec(scrubbed);
      if (match) findings.push({ file, why: rule.why, evidence: match[0] });
    }
    for (const email of scrubbed.match(SCAN_EMAIL_RE) ?? []) {
      if (!SCAN_EXAMPLE_DOMAIN_RE.test(email)) {
        // The address itself goes in `evidence`, never in `why`: scrub-check
        // prints `why` to a terminal and must not print the thing it found.
        findings.push({ file, why: "contains a non-example email", evidence: email });
      }
    }

    const requestHeaders = parsed?.request?.headers ?? {};
    for (const name of Object.keys(requestHeaders)) {
      if (name.toLowerCase() === "authorization") findings.push({ file, why: "kept an Authorization header" });
    }

    // Under countsOnly the body is gone, and the only tailnet-derived strings
    // left in the fixture are KEY NAMES -- in `keySets`, in the json paths that
    // index it, and in `summary`. A key name is usually a schema fact, which is
    // why they are kept at all, but a MAP-shaped field is keyed by data:
    // split-DNS is keyed by domain name. Those are supposed to have been
    // replaced with REDACTED_KEY on the way in (sanitizeKeyName). This is the
    // gate that says so out loud, because none of the rules above can see an
    // internal domain: it carries no tskey-, no email and no ts.net name.
    if (parsed?.provenance?.countsOnly === true) {
      // `response` AND `envelope`: both carry the projection, and the envelope
      // is the half that used to be written whole.
      for (const name of countsOnlyKeyNames({ response: parsed?.response, envelope: parsed?.envelope })) {
        if (name !== REDACTED_KEY && !SCHEMA_KEY_RE.test(name)) {
          findings.push({ file, why: "keeps a map key that is tailnet data, not a schema name", evidence: name });
        }
      }
    }
  }
  return findings;
}

/**
 * Every key NAME a countsOnly record carries, from all three places one can
 * hide: `keySets`, the json paths that index it, and `summary`.
 *
 * It walks the whole subtree rather than one named field, because the same
 * projection appears under `response` and under EVERY field of a projected
 * `envelope` (`envelope.data.keySets`, `envelope.parsed.summary`, ...), and a
 * scanner that only knew about `response` could not see the half that leaked.
 */
function countsOnlyKeyNames(node, out = new Set(), depth = 0) {
  if (!node || typeof node !== "object" || depth > 24) return out;
  if (Array.isArray(node)) {
    for (const entry of node) countsOnlyKeyNames(entry, out, depth + 1);
    return out;
  }
  const keySets = node.keySets;
  if (keySets && typeof keySets === "object" && !Array.isArray(keySets)) {
    for (const [path, names] of Object.entries(keySets)) {
      // `$.splitDNS.<redacted:key>[]` -> splitDNS, <redacted:key>
      for (const segment of String(path)
        .replace(/^\$\.?/, "")
        .split(".")) {
        const name = segment.replace(/\[\]$/, "");
        if (name !== "") out.add(name);
      }
      if (Array.isArray(names)) for (const name of names) out.add(String(name));
    }
  }
  summaryKeyNames(node.summary, out);
  for (const [key, value] of Object.entries(node)) {
    if (key === "keySets" || key === "summary") continue;
    countsOnlyKeyNames(value, out, depth + 1);
  }
  return out;
}

function summaryKeyNames(summary, out) {
  if (!summary || typeof summary !== "object") return out;
  for (const name of Array.isArray(summary.keys) ? summary.keys : []) out.add(String(name));
  for (const name of Array.isArray(summary.firstElementKeys) ? summary.firstElementKeys : []) out.add(String(name));
  for (const [name, child] of Object.entries(summary.children ?? {})) {
    out.add(String(name));
    summaryKeyNames(child, out);
  }
  return out;
}

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

/** What a key set records in place of a key that is data rather than schema. */
export const REDACTED_KEY = "<redacted:key>";

/**
 * A key name that is a SCHEMA fact: a plain identifier, the kind of thing a
 * struct field is called. `splitDNS`, `magicDNS`, `eventGroupID`, `s3Bucket`.
 *
 * WHAT THIS DELIBERATELY DOES NOT CATCH, so the next reader does not take it
 * for complete: a SINGLE-LABEL internal domain (`corp`, `intranet`) is a plain
 * identifier and passes. It has to -- `splitDNS` and `magicDNS` are single
 * labels too, and nothing in a key name distinguishes the two. A dotted domain
 * is caught, which is the shape Tailscale's split-DNS and search-path
 * documents actually use (openapi.yaml SplitDns, :5618-5634); a bare label is
 * not, and the offline scanner reuses this same constant, so it cannot flag one
 * either. The rule below is therefore a floor, not a proof: the thing that
 * makes countsOnly safe is that no VALUE and no BODY reaches disk at all.
 */
const SCHEMA_KEY_RE = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;

/**
 * Sanitize an object KEY before it is recorded in a key set or a summary.
 *
 * The distinction this makes is the whole point of `countsOnly`. A key name is
 * usually a schema fact -- which is why key sets are worth recording at all --
 * but a MAP-shaped field is keyed by tailnet DATA: `splitDNS` is keyed by
 * domain name, and a posture or attribute map is keyed by whatever the operator
 * called it. Recording those verbatim would put a real tailnet's internal
 * domains in a committed fixture with nothing in the offline scanner able to
 * see them (no `tskey-`, no email, no `tailNNNN.ts.net`).
 *
 * So under countsOnly a key survives only if scrubbing changed nothing AND it
 * looks like an identifier. Everything else becomes REDACTED_KEY, and the
 * summary keeps a count of how many were dropped.
 */
export function sanitizeKeyName(key, { scrub = {}, countsOnly = false } = {}) {
  const raw = String(key);
  const scrubbed = scrubString(raw, scrub);
  if (scrubbed !== raw) return REDACTED_KEY;
  if (countsOnly && !SCHEMA_KEY_RE.test(scrubbed)) return REDACTED_KEY;
  return scrubbed;
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
 * device list carries every hostname. None of that goes to disk -- and neither
 * do the KEYS of a map-shaped field, which is why `options` is threaded all the
 * way down to sanitizeKeyName.
 */
export function summarize(value, options = {}, depth = 0) {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    return {
      kind: "array",
      length: value.length,
      firstElementKeys: value.length > 0 && isPlainObject(value[0]) ? sortedKeySet(value[0], options) : null,
    };
  }
  if (isPlainObject(value)) {
    const keys = sortedKeySet(value, options);
    const redactedKeyCount = Object.keys(value).filter((key) => sanitizeKeyName(key, options) === REDACTED_KEY).length;
    // The count is the shape fact that survives when the names cannot: "this
    // map held 3 entries" says what a reviewer needs without naming them.
    const counted = redactedKeyCount > 0 ? { redactedKeyCount } : {};
    if (depth >= 1) return { kind: "object", keys, ...counted };
    const out = { kind: "object", keys, ...counted, children: {} };
    for (const [key, entry] of Object.entries(value)) {
      const name = sanitizeKeyName(key, options);
      // Several redacted keys collapse onto one child; the first one wins and
      // redactedKeyCount above says how many there were.
      if (out.children[name] === undefined) out.children[name] = summarize(entry, options, depth + 1);
    }
    return out;
  }
  return { kind: typeof value };
}

function sortedKeySet(value, options) {
  return [...new Set(Object.keys(value).map((key) => sanitizeKeyName(key, options)))].sort();
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
 * keys that went missing.
 *
 * A key name is USUALLY a schema fact rather than tailnet data, which is why
 * this is recorded in both modes -- but not always: a map-shaped field is keyed
 * by data. Every key, in the map's values and in its json paths alike, goes
 * through sanitizeKeyName first, so under countsOnly a split-DNS document reads
 * as `"$.splitDNS": ["<redacted:key>"]` rather than as somebody's internal
 * domain names.
 */
export function keySetMap(value, options = {}, path = "$", out = {}) {
  if (Array.isArray(value)) {
    const here = `${path}[]`;
    for (const entry of value) keySetMap(entry, options, here, out);
    return out;
  }
  if (isPlainObject(value)) {
    const keys = Object.keys(value).map((key) => sanitizeKeyName(key, options));
    out[path] = [...new Set([...(out[path] ?? []), ...keys])].sort();
    for (const [key, entry] of Object.entries(value)) {
      keySetMap(entry, options, `${path}.${sanitizeKeyName(key, options)}`, out);
    }
    return out;
  }
  return out;
}

/**
 * The counts-only projection of an ENVELOPE -- the second half of the same
 * discipline recordResponse applies to the wire response.
 *
 * It exists because the envelope is the response body one field further down.
 * `ApiResponse` is `{ok, status, data, error, rawBody, etag}` (api.ts:367-374)
 * and rawRequest's is `{status, ok, parsed, raw}`; both carry the whole parsed
 * document. buildFixture used to write that through redactValue alone, and
 * redactValue is a key-NAME rule plus scrubString: neither can see an internal
 * domain, which a split-DNS map carries as a KEY and as a VALUE. So a
 * countsOnly fixture nulled `response.body` and wrote the same document four
 * lines later.
 *
 * What survives, and why:
 *
 *  - booleans and numbers (`ok`, `status`): the answer itself.
 *  - `error`, `statusText`, `etag`, `bodyReadError`: kept, scrubbed, because
 *    "does this 400, and what does it say?" is the question several of these
 *    probes exist to ask. With one bound: extractErrorMessage falls back to the
 *    WHOLE body when it is not `{message}`/`{error}` shaped (api.ts:346-365),
 *    so a JSON-shaped error string is projected like a body rather than kept as
 *    text, and a long one is truncated.
 *  - every other object or array (`data`, `parsed`): the same `summary` +
 *    `keySets` pair the response carries, every key through sanitizeKeyName.
 *  - every other string (`raw`, `rawBody`): its LENGTH and nothing else. That
 *    is where the ACL policy file lands (P13) and where a token mint's response
 *    text lands (P9, P15) -- `parsed.access_token` is redacted by key name and
 *    the raw text beside it never was.
 */
export function projectEnvelope(envelope, { keyOptions = {}, scrub = {} } = {}) {
  if (envelope === null || envelope === undefined) return null;
  if (!isPlainObject(envelope)) return countsOnlyField(envelope, keyOptions);
  const out = { countsOnly: true };
  for (const [key, value] of Object.entries(envelope)) {
    out[key] =
      typeof value === "string" && ENVELOPE_KEPT_STRING_KEYS.has(key.toLowerCase())
        ? countsOnlyMessage(value, keyOptions, scrub)
        : countsOnlyField(value, keyOptions);
  }
  return out;
}

/** The envelope strings that are a diagnostic rather than a document. */
const ENVELOPE_KEPT_STRING_KEYS = new Set(["error", "statustext", "bodyreaderror", "etag"]);
const COUNTS_ONLY_MESSAGE_MAX = 400;

function countsOnlyField(value, keyOptions) {
  if (value === null || value === undefined) return null;
  if (typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return { kind: "text", length: value.length };
  if (Array.isArray(value) || isPlainObject(value)) {
    return { summary: summarize(value, keyOptions), keySets: keySetMap(value, keyOptions) };
  }
  return { kind: typeof value };
}

function countsOnlyMessage(value, keyOptions, scrub) {
  const text = scrubString(value, scrub);
  const trimmed = text.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed);
      return { kind: "json-error", summary: summarize(parsed, keyOptions), keySets: keySetMap(parsed, keyOptions) };
    } catch {
      return { kind: "text", length: text.length };
    }
  }
  return text.length > COUNTS_ONLY_MESSAGE_MAX ? `${text.slice(0, COUNTS_ONLY_MESSAGE_MAX)}<truncated>` : text;
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
    // Key sets are recorded in BOTH modes, because the P4a/P4b round trip is
    // decided by comparing them -- but every key goes through sanitizeKeyName
    // first, and under countsOnly a key that is not a plain identifier is a
    // map key holding tailnet data and never reaches disk.
    const keyOptions = { scrub: scrubOpts, countsOnly };
    const keySets = parsed === null ? null : keySetMap(parsed, keyOptions);
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
        summary: parsed === null ? { kind: "text", length: String(raw ?? "").length } : summarize(parsed, keyOptions),
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
      // ONE rule for every whole document a fixture carries, in both modes.
      // Under countsOnly that is projectEnvelope, not redactValue: redactValue
      // is a key-name rule plus scrubString, so it would write `data` -- the
      // entire body -- one field below the `body: null` countsOnly just wrote.
      const projectDocument = (value, path, into) => {
        if (value === null || value === undefined) return null;
        if (countsOnly)
          return projectEnvelope(value, { keyOptions: { scrub: scrubOpts, countsOnly }, scrub: scrubOpts });
        return redactValue(value, scrubOpts, path, into).value;
      };
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
        // Evaluated before `redactions` below, which is what collects the paths
        // it hid. Object literal properties run in order.
        envelope: projectDocument(envelope, "$.envelope", redactions),
        // Nothing passes these two today. They get the same treatment anyway,
        // so a caller that starts bracketing a step with "the document before
        // and after" cannot reopen the hole the envelope just closed.
        stateBefore: projectDocument(stateBefore, "$.stateBefore"),
        stateAfter: projectDocument(stateAfter, "$.stateAfter"),
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
