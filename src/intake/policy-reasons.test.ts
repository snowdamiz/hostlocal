import { describe, expect, it } from "vitest";
import {
  INTAKE_POLICY_REASON_MAP,
  resolveIntakePolicyReason,
} from "./policy-reasons";

describe("INTAKE_POLICY_REASON_MAP", () => {
  it("contains all required phase-two policy rejection reason codes", () => {
    expect(Object.keys(INTAKE_POLICY_REASON_MAP)).toEqual([
      "empty_body",
      "issue_closed",
      "is_pull_request",
      "deny_signal_present",
      "label_persist_failed",
      "label_persist_rate_limited",
      "duplicate_intake_pending",
    ]);
  });
});

describe("resolveIntakePolicyReason", () => {
  it("resolves known reason codes with violated rule copy and actionable fix hint", () => {
    const resolved = resolveIntakePolicyReason("empty_body");
    expect(resolved.reasonCode).toBe("empty_body");
    expect(resolved.violatedRule).toContain("body");
    expect(resolved.fixHint).toContain("details");
    expect(resolved.signature).toBeTruthy();
  });

  it("allows upstream fix hints to override the default hint copy", () => {
    const resolved = resolveIntakePolicyReason("label_persist_failed", "Retry after labels are synchronized.");
    expect(resolved.reasonCode).toBe("label_persist_failed");
    expect(resolved.fixHint).toBe("Retry after labels are synchronized.");
  });

  it("falls back to safe generic messaging for unknown reason codes", () => {
    const resolved = resolveIntakePolicyReason("something_new");
    expect(resolved.reasonCode).toBe("unknown_policy_rejection");
    expect(resolved.violatedRule).toMatch(/policy/i);
    expect(resolved.fixHint).toMatch(/review|update|retry/i);
  });
});
