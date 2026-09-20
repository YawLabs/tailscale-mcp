/**
 * The probe registry.
 *
 * Everything here is DATA. Importing this module sends nothing, reads no
 * credential and touches no file; `live-probe.mjs run` without --execute prints
 * it and stops.
 */

import p1 from "./p1-c6-log-end.mjs";
import p2 from "./p2-c1-user-invite.mjs";
import p3 from "./p3-c1-device-invite.mjs";
import p4a from "./p4a-dns-config-read.mjs";
import p4b from "./p4b-dns-config-noop-roundtrip.mjs";
import p4c from "./p4c-dns-config-current-shape.mjs";
import p5 from "./p5-c25-split-dns-null.mjs";
import p6 from "./p6-c3-service-put.mjs";
import p7 from "./p7-c4-webhook-patch.mjs";
import p8 from "./p8-c5-key-put.mjs";
import p9 from "./p9-c7-oauth-tailnet-param.mjs";
import p10 from "./p10-c9-oauth-app-casing.mjs";
import p12 from "./p12-devices-fields-projection.mjs";
import p13 from "./p13-acl-details.mjs";
import p14 from "./p14-acl-validate-tests.mjs";
import p15 from "./p15-oauth-downscope.mjs";
import p17 from "./p17-audit-multivalue-filters.mjs";

export const PLANS = [p1, p2, p3, p4a, p4b, p4c, p5, p6, p7, p8, p9, p10, p12, p13, p14, p15, p17];

/**
 * Probes that were designed and are NOT here, with the reason. Printed by
 * `run --all` and by `list`, because "the harness does not implement it" and
 * "the harness forgot it" look identical from the outside otherwise.
 */
export const NOT_IMPLEMENTED = [
  {
    probeId: "P11-C21-s3-external-id",
    settles: ["C21"],
    why: "UNSAFE, and deliberately not built. PUT /logging/configuration/stream REPLACES any existing configuration-log stream, and the old destination's token cannot be read back, so the previous configuration is unrecoverable -- a silent break in compliance log delivery. Where no stream exists it starts exporting the tailnet's audit log to the probe bucket. POST /aws-external-id also mints an identifier with no delete endpoint. On top of that it needs a Premium/Enterprise plan on the target plus an AWS account whose IAM trust policy the owner edits mid-run.",
    instead:
      "Ship the optional s3ExternalId pass-through worded 'per the Go client and Terraform provider; not verified against a live tailnet', following the CHANGELOG.md:185 precedent. If the owner ever wants the observation, the cheap variant is two PUTs with a deliberately nonexistent role ARN, comparing only the two error bodies -- and that still needs a disposable tailnet with no stream configured, so it would be a separate, separately reviewed plan.",
  },
  {
    probeId: "P16-wif-token-exchange",
    settles: ["C-wif"],
    why: "Out of scope for this harness by construction: workload identity federation needs a real OIDC token issued by a CI provider, which this process cannot mint. Faking one proves nothing.",
    instead:
      "Run it from a scratch GitHub Actions repository against a federated identity created for the purpose, and bring the recorded request/response back as a fixture by hand.",
  },
  {
    probeId: "L1-local-ping",
    settles: [],
    why: "Not an API probe. The local-CLI tools shell out to the tailscale binary on the host; there is no request for this harness to guard or record.",
    instead: "Shell commands the owner runs directly, recorded in the PR that changes those tools.",
  },
];

export function findPlan(probeId) {
  const wanted = String(probeId).toLowerCase();
  return (
    PLANS.find((plan) => plan.probeId.toLowerCase() === wanted) ??
    PLANS.find((plan) => plan.probeId.toLowerCase().startsWith(`${wanted}-`)) ??
    null
  );
}

export function notImplementedReason(probeId) {
  const wanted = String(probeId).toLowerCase();
  return (
    NOT_IMPLEMENTED.find(
      (entry) => entry.probeId.toLowerCase() === wanted || entry.probeId.toLowerCase().startsWith(`${wanted}-`),
    ) ?? null
  );
}
