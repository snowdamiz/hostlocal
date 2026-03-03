export type IntakePolicyReasonCode =
  | "empty_body"
  | "issue_closed"
  | "is_pull_request"
  | "deny_signal_present"
  | "label_persist_failed"
  | "label_persist_rate_limited"
  | "duplicate_intake_pending"
  | "runtime_guardrail_workspace_boundary_path"
  | "runtime_guardrail_command_scope_command"
  | "runtime_startup_failed"
  | "runtime_workspace_prepare_failed"
  | "runtime_recovery_process_lost"
  | "queued_run_not_found"
  | "runtime_queue_removal_failed";

export interface IntakePolicyReasonCopy {
  violatedRule: string;
  fixHint: string;
}

export interface ResolvedIntakePolicyReason {
  reasonCode: IntakePolicyReasonCode | "unknown_policy_rejection";
  violatedRule: string;
  fixHint: string;
  signature: string;
}

const UNKNOWN_INTAKE_POLICY_REASON: IntakePolicyReasonCopy = {
  violatedRule: "Intake policy check failed before this issue could move to In Progress.",
  fixHint: "Review the issue scope and labels, then retry the move.",
};

export const INTAKE_POLICY_REASON_MAP: Readonly<Record<IntakePolicyReasonCode, IntakePolicyReasonCopy>> = {
  empty_body: {
    violatedRule: "Issue body must include implementation details before intake can start.",
    fixHint: "Add concrete task details to the issue body, then retry.",
  },
  issue_closed: {
    violatedRule: "Only open issues can move into In Progress intake.",
    fixHint: "Reopen the issue before retrying intake.",
  },
  is_pull_request: {
    violatedRule: "Only issue cards are eligible for intake; pull requests are not intake sources.",
    fixHint: "Move an issue card instead of a pull request card.",
  },
  deny_signal_present: {
    violatedRule: "Issue includes out-of-scope deny signals for small-task intake.",
    fixHint: "Split the issue into smaller scoped work and remove deny-signal markers.",
  },
  label_persist_failed: {
    violatedRule: "Required GitHub labels did not persist, so intake cannot be accepted safely.",
    fixHint: "Retry after GitHub label writes are available.",
  },
  label_persist_rate_limited: {
    violatedRule: "GitHub rate limiting prevented required intake labels from persisting.",
    fixHint: "Wait briefly for the GitHub limit window to reset, then retry.",
  },
  duplicate_intake_pending: {
    violatedRule: "An intake attempt for this issue is already pending and unresolved.",
    fixHint: "Wait for the current intake attempt to resolve before trying again.",
  },
  runtime_guardrail_workspace_boundary_path: {
    violatedRule: "Runtime blocked a path target outside the local workspace boundary.",
    fixHint: "Retry after ensuring runtime file operations stay inside the run workspace.",
  },
  runtime_guardrail_command_scope_command: {
    violatedRule: "Runtime blocked an unapproved command target before worker start.",
    fixHint: "Retry with the approved local worker command scope.",
  },
  runtime_startup_failed: {
    violatedRule: "Runtime failed before local worker execution could start.",
    fixHint: "Retry after runtime startup dependencies are available.",
  },
  runtime_workspace_prepare_failed: {
    violatedRule: "Runtime workspace preparation failed before local worker execution.",
    fixHint: "Retry after repository clone and branch setup are available locally.",
  },
  runtime_recovery_process_lost: {
    violatedRule: "Runtime recovery could not reconnect an in-flight process after restart.",
    fixHint: "Move the issue back to In Progress to requeue a fresh local run.",
  },
  queued_run_not_found: {
    violatedRule: "Issue run was not queued, so runtime queue removal could not proceed.",
    fixHint: "Retry after confirming the issue run is queued for this repository.",
  },
  runtime_queue_removal_failed: {
    violatedRule: "Runtime queue removal failed before the issue could return to Todo.",
    fixHint: "Retry after runtime queue operations are available.",
  },
};

export function isIntakePolicyReasonCode(value: string): value is IntakePolicyReasonCode {
  return value in INTAKE_POLICY_REASON_MAP;
}

export function resolveIntakePolicyReason(reasonCode: string | null | undefined, upstreamFixHint?: string | null): ResolvedIntakePolicyReason {
  if (reasonCode && isIntakePolicyReasonCode(reasonCode)) {
    const reason = INTAKE_POLICY_REASON_MAP[reasonCode];
    const fixHint = upstreamFixHint && upstreamFixHint.trim().length > 0 ? upstreamFixHint : reason.fixHint;
    return {
      reasonCode,
      violatedRule: reason.violatedRule,
      fixHint,
      signature: `${reasonCode}:${fixHint}`,
    };
  }

  const fallbackFixHint =
    upstreamFixHint && upstreamFixHint.trim().length > 0
      ? upstreamFixHint
      : UNKNOWN_INTAKE_POLICY_REASON.fixHint;
  return {
    reasonCode: "unknown_policy_rejection",
    violatedRule: UNKNOWN_INTAKE_POLICY_REASON.violatedRule,
    fixHint: fallbackFixHint,
    signature: `unknown_policy_rejection:${fallbackFixHint}`,
  };
}
