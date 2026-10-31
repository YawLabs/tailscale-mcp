import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { envFlagOn, securityOptInWarning } from "./env-flag.js";

describe("envFlagOn", () => {
  it("accepts 1 or true in any case, with surrounding whitespace ignored", () => {
    // "1 " is what cmd.exe's `set FOO=1 && ...` stores; an exact compare read it as off.
    for (const value of ["1", "true", "TRUE", "True", "1 ", " 1", "true\t", "\n1\n"]) {
      assert.equal(envFlagOn(value), true, JSON.stringify(value));
    }
  });

  it("rejects everything else, failing closed", () => {
    for (const value of [undefined, "", " ", "0", "false", "yes", "on", "enabled", "11", "1 1", "truee", "node "]) {
      assert.equal(envFlagOn(value), false, JSON.stringify(value));
    }
  });
});

describe("securityOptInWarning", () => {
  it("says nothing when the opt-in is unset, empty, or on", () => {
    for (const value of [undefined, "", "  ", "1", "1 ", "TRUE"]) {
      assert.equal(securityOptInWarning("TAILSCALE_READONLY", value), null, JSON.stringify(value));
    }
  });

  it("names the variable and the raw value when the opt-in did not take", () => {
    // "yes" reads as a request; the guard is off, and that must not be silent.
    assert.equal(
      securityOptInWarning("TAILSCALE_READONLY", "yes"),
      'TAILSCALE_READONLY="yes" is not 1 or true, so it is NOT enabled.',
    );
    assert.match(securityOptInWarning("TAILSCALE_READONLY", "0") ?? "", /TAILSCALE_READONLY="0"/);
  });
});
