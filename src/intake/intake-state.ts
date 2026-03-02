export interface IntakeAttemptState {
  pendingIssueIds: Set<number>;
}

export function createIntakeAttemptState(): IntakeAttemptState {
  return {
    pendingIssueIds: new Set<number>(),
  };
}

export function beginIntakeAttempt(state: IntakeAttemptState, issueId: number): boolean {
  if (!Number.isFinite(issueId)) {
    return false;
  }

  if (state.pendingIssueIds.has(issueId)) {
    return false;
  }

  state.pendingIssueIds.add(issueId);
  return true;
}

export function resolveIntakeAttempt(state: IntakeAttemptState, issueId: number): void {
  state.pendingIssueIds.delete(issueId);
}

export function clearIntakeAttempts(state: IntakeAttemptState): void {
  state.pendingIssueIds.clear();
}
