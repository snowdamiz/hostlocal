export type KanbanColumnKey = "todo" | "inProgress" | "inReview" | "done";

export interface ColumnInferenceItem {
  state: "open" | "closed";
  isPullRequest: boolean;
  labels: string[];
  assignees: string[];
}

export const ISSUE_IN_PROGRESS_LABELS = new Set(["in progress", "in-progress", "doing", "wip", "working"]);
export const AGENT_IN_PROGRESS_LABEL_PREFIX = "agent:";

export const inferDefaultColumn = (item: ColumnInferenceItem): KanbanColumnKey => {
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
