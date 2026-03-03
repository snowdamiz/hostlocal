export type KanbanColumnKey = "todo" | "inProgress" | "inReview" | "done";

export interface ColumnInferenceItem {
  state: "open" | "closed";
  isPullRequest: boolean;
  labels: string[];
  assignees: string[];
}

export type RuntimeColumnTerminalStatus = "success" | "failed" | "cancelled" | "guardrail_blocked";

export interface RuntimeColumnInferenceMetadata {
  stage: string;
  terminalStatus: RuntimeColumnTerminalStatus | null;
}

export const ISSUE_IN_PROGRESS_LABELS = new Set(["in progress", "in-progress", "doing", "wip", "working"]);
export const AGENT_IN_PROGRESS_LABEL_PREFIX = "agent:";
const ACTIVE_RUNTIME_STAGES = new Set(["queued", "preparing", "coding", "validating", "publishing"]);

export const inferDefaultColumn = (
  item: ColumnInferenceItem,
  runtimeMetadata?: RuntimeColumnInferenceMetadata | null,
): KanbanColumnKey => {
  if (runtimeMetadata?.terminalStatus === "success") {
    return "inReview";
  }

  if (
    runtimeMetadata?.terminalStatus === "failed" ||
    runtimeMetadata?.terminalStatus === "cancelled" ||
    runtimeMetadata?.terminalStatus === "guardrail_blocked"
  ) {
    return "todo";
  }

  if (runtimeMetadata && ACTIVE_RUNTIME_STAGES.has(runtimeMetadata.stage)) {
    return "inProgress";
  }

  if (item.state === "closed") {
    return "done";
  }

  if (item.isPullRequest) {
    return "inReview";
  }

  const hasInProgressLabel = item.labels.some((label) => {
    const normalized = label.trim().toLowerCase();
    return ISSUE_IN_PROGRESS_LABELS.has(normalized) || normalized.startsWith(AGENT_IN_PROGRESS_LABEL_PREFIX);
  });
  if (hasInProgressLabel || item.assignees.length > 0) {
    return "inProgress";
  }

  return "todo";
};
