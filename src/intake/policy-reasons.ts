export type IntakePolicyReasonCode =
  | "missing_intake_label"
  | "empty_body"
  | "issue_closed"
  | "is_pull_request"
  | "deny_signal_present"
  | "label_persist_failed"
  | "label_persist_rate_limited"
  | "duplicate_intake_pending";

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
  missing_intake_label: {
    violatedRule: "Issue is missing an intake label in the accepted policy prefix family.",
    fixHint: "Add an intake label such as intake:small, then retry.",
  },
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
