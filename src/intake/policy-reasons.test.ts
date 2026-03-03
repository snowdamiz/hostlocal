import { describe, expect, it } from "vitest";
import {
  INTAKE_POLICY_REASON_MAP,
  resolveIntakePolicyReason,
} from "./policy-reasons";

describe("INTAKE_POLICY_REASON_MAP", () => {
  it("contains policy and runtime boundary rejection reason codes", () => {
    expect(Object.keys(INTAKE_POLICY_REASON_MAP)).toEqual([
      "empty_body",
      "issue_closed",
      "is_pull_request",
      "deny_signal_present",
      "label_persist_failed",
      "label_persist_rate_limited",
      "duplicate_intake_pending",
      "runtime_guardrail_workspace_boundary_path",
      "runtime_guardrail_command_scope_command",
      "runtime_startup_failed",
      "runtime_workspace_prepare_failed",
      "queued_run_not_found",
      "runtime_queue_removal_failed",
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

  it("resolves runtime guardrail reason codes with violated-rule and fix-hint copy", () => {
    const resolved = resolveIntakePolicyReason("runtime_guardrail_command_scope_command");
    expect(resolved.reasonCode).toBe("runtime_guardrail_command_scope_command");
    expect(resolved.violatedRule).toMatch(/blocked|command/i);
    expect(resolved.fixHint).toMatch(/approved|retry|scope/i);
  });

  it("resolves queued-run removal failures with explicit runtime queue guidance", () => {
    const resolved = resolveIntakePolicyReason("queued_run_not_found");
    expect(resolved.reasonCode).toBe("queued_run_not_found");
    expect(resolved.violatedRule).toMatch(/queued|queue/i);
    expect(resolved.fixHint).toMatch(/queued|repository|retry/i);
  });

  it("falls back to safe generic messaging for unknown reason codes", () => {
    const resolved = resolveIntakePolicyReason("something_new");
    expect(resolved.reasonCode).toBe("unknown_policy_rejection");
    expect(resolved.violatedRule).toMatch(/policy/i);
    expect(resolved.fixHint).toMatch(/review|update|retry/i);
  });
});
