/**
 * The one parse rule for this server's on/off env opt-ins: TAILSCALE_READONLY,
 * TAILSCALE_LOCAL_CLI, TAILSCALE_REQUIRE_APPROVAL and TAILSCALE_DEBUG.
 *
 * "1" or "true", any case, with surrounding whitespace ignored. The trim is the
 * load-bearing half: cmd.exe's `set TAILSCALE_READONLY=1 && ...` stores "1 ",
 * which an exact compare read as OFF -- a security opt-in failing open without a
 * word. bin/tailscale-mcp.mjs carries a copy (envFlagOn) for its sandbox opt-in,
 * since that file is plain .mjs and cannot import this one.
 */
export function envFlagOn(value: string | undefined): boolean {
  return /^(1|true)$/i.test((value ?? "").trim());
}

/**
 * A warning for a SECURITY opt-in set to a value that did not enable it, or null
 * when there is nothing to say (unset, empty, or on). "yes" and "on" read as a
 * request, and serving with the guard off in silence would hide that it did not
 * take.
 */
export function securityOptInWarning(name: string, value: string | undefined): string | null {
  if (envFlagOn(value) || (value ?? "").trim() === "") return null;
  return `${name}=${JSON.stringify(value)} is not 1 or true, so it is NOT enabled.`;
}
