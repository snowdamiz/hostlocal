import { describe, expect, it, vi } from "vitest";
import type {
  GithubIssueIntakeOutcome,
  GithubRepositoryItem,
  RuntimeDequeueIssueRunOutcome,
  RuntimeEnqueueIssueRunOutcome,
} from "../../../lib/commands";
import { revertIssueIntakeWithRuntimeDequeue, startAgentRunForIssue } from "./useBoardInteractions";

const createIssue = (overrides: Partial<GithubRepositoryItem> = {}): GithubRepositoryItem => ({
  id: 1,
  number: 42,
  title: "Guardrail-sensitive issue",
  htmlUrl: "https://github.com/owner/repo/issues/42",
  state: "open",
  isPullRequest: false,
  draft: false,
  labels: [],
  assignees: [],
  authorLogin: "sn0w",
  body: "Repro details",
  updatedAt: "2026-03-03T00:00:00.000Z",
  ...overrides,
});

const createQueueOutcome = (
  status: RuntimeEnqueueIssueRunOutcome["status"],
  reasonCode: string | null,
  fixHint: string | null,
): RuntimeEnqueueIssueRunOutcome => ({
  status,
  queuePosition: null,
  reasonCode,
  fixHint,
});

const createDequeueOutcome = (
  status: RuntimeDequeueIssueRunOutcome["status"],
  reasonCode: string | null,
  fixHint: string | null,
): RuntimeDequeueIssueRunOutcome => ({
  status,
  queuePosition: null,
  reasonCode,
  fixHint,
});

describe("startAgentRunForIssue", () => {
  it("emits rejection and reverts intake when runtime enqueue is blocked", async () => {
    const runtimeEnqueueIssueRun = vi.fn().mockResolvedValue(
      createQueueOutcome(
        "blocked",
        "runtime_guardrail_workspace_boundary_path",
        "Blocked path target because it violated workspace_boundary rule.",
      ),
    );
    const githubRevertIssueIntake = vi.fn().mockResolvedValue({
      accepted: true,
      reasonCode: null,
      fixHint: null,
    } satisfies GithubIssueIntakeOutcome);
    const emitIntakeRejection = vi.fn();

    await startAgentRunForIssue(
      {
        repositoryFullName: "Owner/Repo",
        item: createIssue(),
        agentLabel: "hostlocal",
        emitIntakeRejection,
      },
      {
        runtimeEnqueueIssueRun,
        githubRevertIssueIntake,
      },
    );

    expect(runtimeEnqueueIssueRun).toHaveBeenCalledWith({
      repositoryFullName: "Owner/Repo",
      issueNumber: 42,
      issueTitle: "Guardrail-sensitive issue",
    });
    expect(githubRevertIssueIntake).toHaveBeenCalledWith({
      repositoryFullName: "Owner/Repo",
      issueNumber: 42,
      agentLabel: "hostlocal",
    });
    expect(emitIntakeRejection).toHaveBeenCalledWith({
      accepted: false,
      reasonCode: "runtime_guardrail_workspace_boundary_path",
      fixHint: "Blocked path target because it violated workspace_boundary rule.",
    });
  });

  it("emits rejection and reverts intake when runtime startup fails", async () => {
    const runtimeEnqueueIssueRun = vi.fn().mockResolvedValue(
      createQueueOutcome(
        "startup_failed",
        "runtime_startup_failed",
        "Runtime startup failed before local worker execution could begin.",
      ),
    );
    const githubRevertIssueIntake = vi.fn().mockResolvedValue({
      accepted: true,
      reasonCode: null,
      fixHint: null,
    } satisfies GithubIssueIntakeOutcome);
    const emitIntakeRejection = vi.fn();

    await startAgentRunForIssue(
      {
        repositoryFullName: "Owner/Repo",
        item: createIssue({
          number: 55,
          title: "Startup failure issue",
        }),
        agentLabel: "hostlocal",
        emitIntakeRejection,
      },
      {
        runtimeEnqueueIssueRun,
        githubRevertIssueIntake,
      },
    );

    expect(runtimeEnqueueIssueRun).toHaveBeenCalledWith({
      repositoryFullName: "Owner/Repo",
      issueNumber: 55,
      issueTitle: "Startup failure issue",
    });
    expect(githubRevertIssueIntake).toHaveBeenCalledWith({
      repositoryFullName: "Owner/Repo",
      issueNumber: 55,
      agentLabel: "hostlocal",
    });
    expect(emitIntakeRejection).toHaveBeenCalledWith({
      accepted: false,
      reasonCode: "runtime_startup_failed",
      fixHint: "Runtime startup failed before local worker execution could begin.",
    });
  });
});

describe("revertIssueIntakeWithRuntimeDequeue", () => {
  it("returns explicit rejection and skips intake revert when queued run cannot be removed", async () => {
    const runtimeDequeueIssueRun = vi.fn().mockResolvedValue(
      createDequeueOutcome(
        "not_found",
        "queued_run_not_found",
        "Issue run was not queued for this repository.",
      ),
    );
    const githubRevertIssueIntake = vi.fn();

    const outcome = await revertIssueIntakeWithRuntimeDequeue(
      {
        repositoryFullName: "Owner/Repo",
        item: createIssue(),
        agentLabel: "hostlocal",
      },
      {
        runtimeDequeueIssueRun,
        githubRevertIssueIntake,
      },
    );

    expect(outcome).toEqual({
      accepted: false,
      reasonCode: "queued_run_not_found",
      fixHint: "Issue run was not queued for this repository.",
    });
    expect(githubRevertIssueIntake).not.toHaveBeenCalled();
  });

  it("calls intake revert after successful queued-run removal", async () => {
    const runtimeDequeueIssueRun = vi.fn().mockResolvedValue(
      createDequeueOutcome("removed", null, null),
    );
    const githubRevertIssueIntake = vi.fn().mockResolvedValue({
      accepted: true,
      reasonCode: null,
      fixHint: null,
    } satisfies GithubIssueIntakeOutcome);

    const outcome = await revertIssueIntakeWithRuntimeDequeue(
      {
        repositoryFullName: "Owner/Repo",
        item: createIssue({
          number: 99,
        }),
        agentLabel: "hostlocal",
      },
      {
        runtimeDequeueIssueRun,
        githubRevertIssueIntake,
      },
    );

    expect(runtimeDequeueIssueRun).toHaveBeenCalledWith({
      repositoryFullName: "Owner/Repo",
      issueNumber: 99,
    });
    expect(githubRevertIssueIntake).toHaveBeenCalledWith({
      repositoryFullName: "Owner/Repo",
      issueNumber: 99,
      agentLabel: "hostlocal",
    });
    expect(outcome).toEqual({
      accepted: true,
      reasonCode: null,
      fixHint: null,
    });
  });
});
