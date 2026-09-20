# Live shape fixtures

**This directory is empty on purpose. Nothing in this repo has been observed
against a live tailnet yet.**

`scripts/live-probe.mjs` writes fixtures here, one directory per probe:

```
fixtures/live/<probeId>/<nn>-<arm>-<probe-slug>.json
```

Each file is one recorded HTTP exchange -- what actually crossed the wire, not
what a mock was told to pretend. They exist because a hand-built mock can only
ever confirm what its author already believed: several of this repo's mocked
pins encode a request shape the API may well reject, and a `{services: []}`
list mock encodes a key the spec does not use at all.

## What a fixture contains

| Field | What it is |
|---|---|
| `probeId`, `step`, `arm` | Which probe, which ordered step, and whether the request was the `current` shape, the `spec` shape, a `control`, an `observe` bracket, a `seed` or a `cleanup`. |
| `provenance` | `capturedAt`, `harness`, `packageVersion`, `gitHead`, `targetKind`, `credentialKind`, `pinnedBuildVersion`, `openapiSha256`, `countsOnly`. Every one is re-read at write time. |
| `tool` | The tool name and input, when the request came from a shipped handler rather than from the harness. |
| `request` | Method, host, path (tailnet id replaced by `{tailnet}`), a small header allow-list, and the body. |
| `response` | Status, a small header allow-list, the body, and `keySets`. |
| `keySets` | A value-free map of json path to sorted key names, at every level. This is what the P4a/P4b round trip is decided on. |
| `envelope` | The `ApiResponse` the handler returned -- what an agent sees today, which is NOT the same as the wire. |
| `attempts` | Every attempt, because api.ts retries GET/PUT/DELETE up to four times. |
| `redactions` | The json paths whose values were replaced. |

## The redaction contract

Redaction is deny-by-default and happens before anything reaches disk, so a
crash between the response and the write cannot leave a secret in a half-written
file -- there is no unredacted copy to write.

* The `Authorization` header is dropped, never stored.
* The values of `key`, `secret`, `client_secret`, `access_token`, `token`,
  `inviteUrl`, `s3SecretAccessKey` and their siblings are replaced, with the
  TYPE preserved so the shape still documents itself.
* `tskey-...` is scrubbed anywhere in any string.
* Email addresses become `user@example.com`; `tailXXXX.ts.net` is normalised;
  the target tailnet id becomes `{tailnet}`.
* A read against a tailnet that is not attested as disposable is recorded
  **counts-only**: statuses, key sets, lengths and derived booleans. No audit
  entry, device record or search path from a real tailnet is ever written here.

`src/live-fixtures.test.ts` enforces the parts of that contract that can be
checked offline, and it runs in the ordinary `npm test`. `live-probe.mjs
scrub-check` additionally compares the fixtures against the literal probe
credentials in the operator's own shell, which a committed test cannot do.

## Reading a fixture

A fixture is evidence about ONE observation on ONE date against ONE tailnet.
The `targetKind` field matters: an API-only tailnet may behave differently from
an ordinary one, and several of the endpoints probed here are upstream alpha.
A pair of failures is not a finding -- it is the paired control saying the run
was inconclusive.
