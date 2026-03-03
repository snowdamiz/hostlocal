import { describe, expect, it } from "vitest";
import type { KanbanColumnKey } from "./column-inference";
import { inferDefaultColumn } from "./column-inference";

interface TestItem {
  state: "open" | "closed";
  isPullRequest: boolean;
  labels: string[];
  assignees: string[];
}

const createItem = (overrides: Partial<TestItem> = {}): TestItem => ({
  state: "open",
  isPullRequest: false,
  labels: [],
  assignees: [],
  ...overrides,
});

describe("inferDefaultColumn", () => {
  it("uses closed-state precedence over all other signals", () => {
    const item = createItem({
      state: "closed",
      isPullRequest: true,
      labels: ["in progress"],
      assignees: ["sn0w"],
    });

    expect(inferDefaultColumn(item)).toBe("done");
  });

  it("uses pull-request precedence over in-progress labels and assignees", () => {
    const item = createItem({
      isPullRequest: true,
      labels: ["IN PROGRESS"],
      assignees: ["sn0w"],
    });

    expect(inferDefaultColumn(item)).toBe("inReview");
  });

  it("maps assignee presence to inProgress when no stronger signal exists", () => {
    expect(
      inferDefaultColumn(
        createItem({
          assignees: ["sn0w"],
        }),
      ),
    ).toBe("inProgress");
  });

  it("handles in-progress labels case-insensitively, including agent prefix labels", () => {
    const scenarios: Array<{ labels: string[]; expected: KanbanColumnKey }> = [
      { labels: ["In Progress"], expected: "inProgress" },
      { labels: ["  WIP  "], expected: "inProgress" },
      { labels: ["Agent:HostLocal"], expected: "inProgress" },
    ];

    for (const scenario of scenarios) {
      expect(
        inferDefaultColumn(
          createItem({
            labels: scenario.labels,
          }),
        ),
      ).toBe(scenario.expected);
    }
  });

  it("falls back to todo for remaining open issues", () => {
    expect(inferDefaultColumn(createItem())).toBe("todo");
  });

  it("maps runtime non-terminal stages to inProgress regardless of label or state fallback signals", () => {
    const runtimeStages = ["queued", "preparing", "coding", "validating", "publishing"] as const;
    for (const stage of runtimeStages) {
      expect(
        inferDefaultColumn(
          createItem({
            state: "closed",
            isPullRequest: true,
          }),
          {
            stage,
            terminalStatus: null,
          },
        ),
      ).toBe("inProgress");
    }
  });

  it("maps runtime terminal statuses to deterministic review/todo columns", () => {
    const scenarios: Array<{
      terminalStatus: "success" | "failed" | "cancelled" | "guardrail_blocked";
      expected: KanbanColumnKey;
    }> = [
      { terminalStatus: "success", expected: "inReview" },
      { terminalStatus: "failed", expected: "todo" },
      { terminalStatus: "cancelled", expected: "todo" },
      { terminalStatus: "guardrail_blocked", expected: "todo" },
    ];

    for (const scenario of scenarios) {
      expect(
        inferDefaultColumn(createItem({ state: "closed" }), {
          stage: "publishing",
          terminalStatus: scenario.terminalStatus,
        }),
      ).toBe(scenario.expected);
    }
  });

  it("keeps paused non-terminal runs in inProgress even when stage is unknown", () => {
    expect(
      inferDefaultColumn(createItem({ state: "closed" }), {
        stage: "paused-runtime",
        terminalStatus: null,
        isPaused: true,
      }),
    ).toBe("inProgress");
  });

  it("keeps terminal precedence over paused metadata", () => {
    expect(
      inferDefaultColumn(createItem({ state: "closed" }), {
        stage: "paused-runtime",
        terminalStatus: "failed",
        isPaused: true,
      }),
    ).toBe("todo");
  });
});
