import { PATTERNS, post } from "./_shared.mjs";

const MINIMAL_POLICY = '{"acls":[{"action":"accept","src":["*"],"dst":["*:*"]}]}';
const POLICY_WITH_TESTS =
  '{"acls":[{"action":"accept","src":["*"],"dst":["*:*"]}],"tests":[{"src":"user@example.com","accept":["100.64.0.1:22"]}]}';
const POLICY_WITH_FAILING_TEST =
  '{"acls":[{"action":"accept","src":["*"],"dst":["*:22"]}],"tests":[{"src":"user@example.com","deny":["100.64.0.1:22"]}]}';

/**
 * P14 -- does POST /acl/validate run the `tests` block, and what does a FAILING
 * test look like on the wire?
 *
 * A reviewer addition. It is a POST, but the only POST it is allowed to make is
 * /acl/validate: the request allowlist pins the path, because POST /acl on the
 * same prefix REPLACES the tailnet's entire policy. `methods` alone would not
 * be enough here, and that is the reason allowedRequests exists.
 *
 * Nothing is applied: validate takes a policy in the body and returns
 * diagnostics. It does not touch the stored policy.
 *
 * The answer matters because acl.ts:320-325 normalises a 200 with an empty or
 * `{}` body to "ACL policy is valid." -- so if a failing TEST also comes back
 * 200 with diagnostics in the body, the tool is currently at risk of reporting
 * a policy valid when its own tests say otherwise.
 */
export default {
  probeId: "P14-acl-validate-tests",
  settles: ["C-acl-validate-tests"],
  question:
    "Does /acl/validate execute a `tests` block, and does a failing test surface as a non-200 or as a 200 with diagnostics?",
  safetyClass: "safe-read-only",
  requiresTargetKind: null,
  methods: ["POST"],
  allowedRequests: [post(PATTERNS.aclValidate)],
  // The default, said out loud: full bodies only on a target this harness
  // provisioned. The diagnostics this probe is after are about the policy in
  // its own request body, not the tailnet's -- but on an unattested target the
  // GET-only drop skips its only step anyway, so there is nothing to record.
  countsOnly: "unattested",
  credentialNeeds:
    "Any credential with policy_file:read (validate does not write). Safe on the real tailnet behind --allow-real-readonly: the policy in the body is the harness's own, not the tailnet's.",
  blastRadius:
    "None. The only permitted path is /acl/validate, which evaluates a submitted policy and stores nothing. POST /acl -- the replace-the-whole-policy endpoint on the same prefix -- is refused by the request allowlist, not merely by convention.",
  cleanup: "None.",
  outcomes: [
    {
      when: "a failing test returns 200 with diagnostics in the body",
      ship: 'PR35 must parse them. As it stands, acl.ts:320-325 rewrites a 200 to "ACL policy is valid." whenever the body is empty or {} -- fine today, but it must not be extended to swallow a diagnostics body.',
    },
    { when: "a failing test returns 4xx", ship: "The existing error path already surfaces it; PR35 shrinks." },
    {
      when: "the tests block is ignored entirely",
      ship: "Drop the tests half of PR35 and say the endpoint validates syntax only.",
    },
    {
      when: "validate 403s for a policy_file:read credential",
      ship: "It needs write scope despite being non-mutating -- worth documenting on the tool.",
    },
  ],
  steps() {
    return [
      {
        n: 1,
        arm: "control",
        method: "POST",
        path: "/tailnet/{T}/acl/validate",
        body: MINIMAL_POLICY,
        headers: { "content-type": "application/hujson" },
        tool: { module: "tools/acl.js", name: "tailscale_validate_acl", input: { policy: MINIMAL_POLICY } },
        expect: "200 with an empty body or {}. If this fails, every later arm is inconclusive.",
        note: "The policy is the harness's own text, so nothing about the tailnet's real ACL is sent or recorded.",
      },
      {
        n: 2,
        arm: "spec",
        method: "POST",
        path: "/tailnet/{T}/acl/validate",
        body: POLICY_WITH_TESTS,
        headers: { "content-type": "application/hujson" },
        tool: { module: "tools/acl.js", name: "tailscale_validate_acl", input: { policy: POLICY_WITH_TESTS } },
        expect: "A PASSING tests block. Still 200 and still empty?",
      },
      {
        n: 3,
        arm: "spec",
        method: "POST",
        path: "/tailnet/{T}/acl/validate",
        body: POLICY_WITH_FAILING_TEST,
        headers: { "content-type": "application/hujson" },
        tool: { module: "tools/acl.js", name: "tailscale_validate_acl", input: { policy: POLICY_WITH_FAILING_TEST } },
        expect:
          "A FAILING tests block. This is the observation PR35 is gated on: status, and whether diagnostics arrive in a 200 body.",
      },
      {
        n: 4,
        arm: "spec",
        method: "POST",
        path: "/tailnet/{T}/acl/validate",
        body: '{"acls":[{"action":"accept"',
        headers: { "content-type": "application/hujson" },
        expect: "Malformed HuJSON: the syntax-error shape, for the error-path fixture.",
      },
    ];
  },
};
