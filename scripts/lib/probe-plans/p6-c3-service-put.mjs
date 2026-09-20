import { del, get, PATTERNS, put } from "./_shared.mjs";

const NAME = "svc:yaw-probe-c3";
const COMMENT = "yaw probe c3";

/**
 * P6 -- does PUT services/{name} take object-shaped ports, is udp refused, and
 * does a sparse PUT clear the fields it omits?
 *
 * The name goes through encPath (api.ts:236-238), so the colon leaves as
 * `svc%3Ayaw-probe-c3`. Whether the server accepts the encoded colon is itself
 * recorded -- a 404 on the PRECHECK could mean "no such service" or "that is
 * not a name I parse", and the two are different findings.
 *
 * The reviewer added an identical-body echo round trip and an explicit
 * `comment:""` / `tags:[]` arm: a sparse PUT that clears omitted fields and a
 * PUT that accepts an explicit empty are different server behaviours, and
 * PR23's merge design depends on which one is real.
 */
export default {
  probeId: "P6-C3-service-put",
  settles: ["C3"],
  question:
    "Does PUT services/{name} reject object-shaped ports and the phantom autoApproveHosts field, is udp refused, and does a sparse PUT clear omitted fields?",
  safetyClass: "safe-reversible-write",
  requiresTargetKind: null,
  methods: ["GET", "PUT", "DELETE"],
  allowedRequests: [get(PATTERNS.services), put(PATTERNS.services), del(PATTERNS.services)],
  credentialNeeds:
    "OAuth `services` scope (openapi.yaml:3606) or an API key; the create-tailnet `all` client is sufficient IF Services is enabled on API-only tailnets, which is unknown.",
  blastRadius:
    "Bounded to one probe-named service the harness creates: it allocates a virtual IP and publishes a MagicDNS name to the tailnet until deleted. It never touches an existing service -- the PRECHECK aborts on anything but a 404. The TAGS sub-step edits the ACL and is attested-target only.",
  cleanup: `DELETE /tailnet/{T}/services/${NAME}; GET must then be 404; then list and delete anything whose comment is "${COMMENT}".`,
  outcomes: [
    {
      when: "CURRENT-1 400",
      ship: "Any ports update through the tool has always failed. Change to string ports (services.ts:51-59); the changelog may quote the 400.",
    },
    {
      when: "CURRENT-1 200 with ports unchanged or cleared",
      ship: "Silent failure -- stronger wording, higher priority than a loud 400.",
    },
    {
      when: "CURRENT-2 200 with autoApproveHosts ignored",
      ship: "Remove the field (services.ts:61-64, error text :79) and point the description at autoApprovers.services. A 400 means the same removal plus a was-rejected line.",
    },
    {
      when: "SPEC-SPARSE clears comment or name",
      ship: "PUT is replace. The handler must GET-merge-PUT or expose and require the full body -- that is PR23.",
    },
    { when: "SPEC-UDP 400", ship: "Drop udp from the enum at services.ts:54." },
    {
      when: "SPEC CREATE 200",
      ship: 'The claim at services.ts:8 ("there is no API endpoint to create a service") is wrong, and tailscale_create_service becomes a real tool (OD5).',
    },
    {
      when: "LIST returns `vipServices`",
      ship: "The `{services: []}` mock at handlers.test.ts:2791 is a wrong-shape mock and gets replaced by the fixture.",
    },
    { when: "PRECHECK or CREATE 403/404 on both arms", ship: "Services is not enabled on this target: inconclusive." },
  ],
  steps() {
    return [
      {
        n: 1,
        arm: "precheck",
        method: "GET",
        path: `/tailnet/{T}/services/${NAME}`,
        body: null,
        tool: { module: "tools/services.js", name: "tailscale_get_service", input: { serviceName: NAME } },
        expect: "404. ABORT the whole probe on anything else -- it must never touch an existing service.",
        note: "Also records whether the server accepts the percent-encoded colon at all.",
      },
      {
        n: 2,
        arm: "spec",
        method: "PUT",
        path: `/tailnet/{T}/services/${NAME}`,
        body: { name: NAME, comment: COMMENT, ports: ["tcp:443"] },
        undo: { method: "DELETE", path: `/tailnet/{T}/services/${NAME}` },
        expect:
          "200 (openapi.yaml:3597-3616; ports are STRINGS, :6331-6341; Terraform requires only name+ports, tf_service.go:61-104).",
        note: "Raw apiRequest. No tool can create a service today.",
      },
      {
        n: 3,
        arm: "observe",
        method: "GET",
        path: `/tailnet/{T}/services/${NAME}`,
        body: null,
        expect:
          "The real VIPServiceInfo fixture, including addrs and any undocumented `annotations` (go_services.go:22).",
      },
      {
        n: 4,
        arm: "current",
        method: "PUT",
        path: `/tailnet/{T}/services/${NAME}`,
        body: { ports: [{ protocol: "tcp", port: 8443 }] },
        tool: {
          module: "tools/services.js",
          name: "tailscale_update_service",
          input: { serviceName: NAME, ports: [{ protocol: "tcp", port: 8443 }] },
        },
        expect: "400 if ports are strings upstream (services.ts:72-81 sends objects).",
      },
      { n: 5, arm: "observe", method: "GET", path: `/tailnet/{T}/services/${NAME}`, body: null },
      {
        n: 6,
        arm: "current",
        method: "PUT",
        path: `/tailnet/{T}/services/${NAME}`,
        body: { autoApproveHosts: true },
        tool: {
          module: "tools/services.js",
          name: "tailscale_update_service",
          input: { serviceName: NAME, autoApproveHosts: true },
        },
        expect: "Rejected? Ignored? And did comment/ports get cleared by a body carrying only a phantom field?",
      },
      { n: 7, arm: "observe", method: "GET", path: `/tailnet/{T}/services/${NAME}`, body: null },
      {
        n: 8,
        arm: "spec",
        method: "PUT",
        path: `/tailnet/{T}/services/${NAME}`,
        body: { name: NAME, comment: COMMENT, ports: ["tcp:443"] },
        expect: "200, and GET must then be byte-identical to step 3.",
        note: "Reviewer addition: the identical-body echo round trip. If writing back what was read changes anything, PR23 cannot be a merge.",
      },
      { n: 9, arm: "observe", method: "GET", path: `/tailnet/{T}/services/${NAME}`, body: null },
      {
        n: 10,
        arm: "spec",
        method: "PUT",
        path: `/tailnet/{T}/services/${NAME}`,
        body: { name: NAME, ports: ["udp:53"] },
        expect: "400 -- the spec allows tcp only.",
      },
      {
        n: 11,
        arm: "spec",
        method: "PUT",
        path: `/tailnet/{T}/services/${NAME}`,
        body: { ports: ["tcp:80"] },
        expect: "Did name and comment survive a sparse PUT? That is the replace-vs-merge question.",
      },
      { n: 12, arm: "observe", method: "GET", path: `/tailnet/{T}/services/${NAME}`, body: null },
      {
        n: 13,
        arm: "spec",
        method: "PUT",
        path: `/tailnet/{T}/services/${NAME}`,
        body: { name: NAME, comment: "", ports: ["tcp:80"], tags: [] },
        expect: "Is an explicit empty accepted, and does it differ from omitting the field?",
        note: "Reviewer addition. An omitted field and an explicit empty are different requests; PR23 needs to know which one clears.",
      },
      { n: 14, arm: "observe", method: "GET", path: `/tailnet/{T}/services/${NAME}`, body: null },
      {
        n: 15,
        arm: "observe",
        method: "GET",
        path: "/tailnet/{T}/services",
        body: null,
        tool: { module: "tools/services.js", name: "tailscale_list_services", input: {} },
        expect: "The list key: `vipServices` per the spec (openapi.yaml:3552), not `services`.",
      },
      {
        n: 16,
        arm: "observe",
        method: "GET",
        path: "/tailnet/{T}/vip-services",
        body: null,
        optional: true,
        expect: "The alias the Go client uses (go_services.go:33). Read-only, so a 404 here costs nothing.",
      },
      {
        n: 17,
        arm: "spec",
        method: "PUT",
        path: `/tailnet/{T}/services/${NAME}`,
        body: { ports: ["tcp:80"], tags: ["tag:yaw-probe"] },
        requires: { attestedTarget: true },
        expect: "Are tags cleared by a later sparse PUT?",
        note: "Needs a tagOwners entry in the ACL, so this edits the policy file. Attested target only.",
      },
      {
        n: 18,
        arm: "cleanup",
        method: "DELETE",
        path: `/tailnet/{T}/services/${NAME}`,
        body: null,
        tool: { module: "tools/services.js", name: "tailscale_delete_service", input: { serviceName: NAME } },
        expect: `GET must be 404, then list and sweep anything whose comment is "${COMMENT}" in case a name-less PUT renamed it.`,
      },
    ];
  },
};
