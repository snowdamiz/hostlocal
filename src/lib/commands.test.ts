import { beforeEach, describe, expect, it, vi } from "vitest";

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}));

import type {
  RuntimeAbortIssueRunRequest,
  RuntimeControlIssueRunRequest,
  RuntimeRunControlOutcome,
  RuntimeSteerIssueRunRequest,
} from "./commands";
import {
  runtimeAbortIssueRun,
  runtimePauseIssueRun,
  runtimeResumeIssueRun,
  runtimeSteerIssueRun,
} from "./commands";

const createControlOutcome = (
  overrides: Partial<RuntimeRunControlOutcome> = {},
): RuntimeRunControlOutcome => ({
  acknowledged: true,
  runId: 101,
  isPaused: false,
  reasonCode: null,
  fixHint: null,
  ...overrides,
});

describe("runtime control command wrappers", () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it("invokes runtime_pause_issue_run with the typed request payload", async () => {
    const request: RuntimeControlIssueRunRequest = {
      repositoryFullName: "Owner/Repo",
      issueNumber: 42,
    };
    const expected = createControlOutcome({ isPaused: true });
    invokeMock.mockResolvedValue(expected);

    const outcome = await runtimePauseIssueRun(request);

    expect(invokeMock).toHaveBeenCalledWith("runtime_pause_issue_run", { request });
    expect(outcome).toEqual(expected);
  });

  it("invokes runtime_resume_issue_run with the typed request payload", async () => {
    const request: RuntimeControlIssueRunRequest = {
      repositoryFullName: "Owner/Repo",
      issueNumber: 42,
    };
    const expected = createControlOutcome({ isPaused: false });
    invokeMock.mockResolvedValue(expected);

    const outcome = await runtimeResumeIssueRun(request);

    expect(invokeMock).toHaveBeenCalledWith("runtime_resume_issue_run", { request });
    expect(outcome).toEqual(expected);
  });

  it("invokes runtime_abort_issue_run and forwards optional abort reason metadata", async () => {
    const request: RuntimeAbortIssueRunRequest = {
      repositoryFullName: "Owner/Repo",
      issueNumber: 42,
      reason: "Need to adjust acceptance criteria",
    };
    const expected = createControlOutcome({
      isPaused: false,
      reasonCode: "runtime_user_abort",
      fixHint: "Issue run was aborted by user request.",
    });
    invokeMock.mockResolvedValue(expected);

    const outcome = await runtimeAbortIssueRun(request);

    expect(invokeMock).toHaveBeenCalledWith("runtime_abort_issue_run", { request });
    expect(outcome).toEqual(expected);
  });

  it("invokes runtime_steer_issue_run and forwards steering instruction text", async () => {
    const request: RuntimeSteerIssueRunRequest = {
      repositoryFullName: "Owner/Repo",
      issueNumber: 42,
      instruction: "Focus on edge cases around queue promotion.",
    };
    const expected = createControlOutcome({ isPaused: false });
    invokeMock.mockResolvedValue(expected);

    const outcome = await runtimeSteerIssueRun(request);

    expect(invokeMock).toHaveBeenCalledWith("runtime_steer_issue_run", { request });
    expect(outcome).toEqual(expected);
  });
});
