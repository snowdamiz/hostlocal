import { describe, expect, it, vi } from "vitest";
import type {
  GithubIssueIntakeOutcome,
  GithubRepositoryItem,
  RuntimeIssueRunSummary,
  RuntimeIssueRunTelemetry,
  RuntimeRepositoryRunSnapshotItem,
  RuntimeRepositoryRunSnapshot,
  RuntimeRunControlOutcome,
  RuntimeRunTelemetryEventPayload,
  RuntimeRunStageChangedEventPayload,
  RuntimeDequeueIssueRunOutcome,
  RuntimeEnqueueIssueRunOutcome,
} from "../../../lib/commands";
import {
  executeRuntimeControlAction,
  mapRuntimeSnapshotByIssueNumber,
  mapRuntimeTelemetryByIssueNumber,
  mergeRuntimeTelemetryPayloadByIssueNumber,
  mergeRuntimeStageChangedPayload,
  normalizeRuntimeIssueRunSummary,
  revertIssueIntakeWithRuntimeDequeue,
  resolveRuntimeControlEligibility,
  startAgentRunForIssue,
  subscribeRuntimeTelemetryEvents,
  subscribeRuntimeStageChangedEvents,
} from "./useBoardInteractions";

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

const createRuntimeSnapshot = (): RuntimeRepositoryRunSnapshot => ({
  repositoryFullName: "Owner/Repo",
  repositoryKey: "owner/repo",
  runs: [
    {
      runId: 100,
      issueNumber: 41,
      issueTitle: "Queued issue",
      issueBranchName: "hostlocal/issue-41",
      stage: "queued",
      queuePosition: 1,
      terminalStatus: null,
      reasonCode: null,
      fixHint: null,
      isPaused: false,
      pausedAt: null,
      updatedAt: "2026-03-03T05:00:00.000Z",
      terminalAt: null,
    },
    {
      runId: 101,
      issueNumber: 42,
      issueTitle: "Coding issue",
      issueBranchName: "hostlocal/issue-42",
      stage: "coding",
      queuePosition: null,
      terminalStatus: null,
      reasonCode: null,
      fixHint: null,
      isPaused: false,
      pausedAt: null,
      updatedAt: "2026-03-03T05:01:00.000Z",
      terminalAt: null,
    },
  ],
});

const createRuntimeStagePayload = (
  overrides: Partial<RuntimeRunStageChangedEventPayload> = {},
): RuntimeRunStageChangedEventPayload => ({
  runId: 100,
  repositoryFullName: "Owner/Repo",
  repositoryKey: "owner/repo",
  issueNumber: 41,
  issueTitle: "Queued issue",
  issueBranchName: "hostlocal/issue-41",
  stage: "queued",
  queuePosition: 2,
  terminalStatus: null,
  reasonCode: null,
  fixHint: null,
  isPaused: false,
  pausedAt: null,
  ...overrides,
});

const createRuntimeControlTarget = (
  overrides: Partial<RuntimeRepositoryRunSnapshotItem> = {},
): RuntimeRepositoryRunSnapshotItem => ({
  runId: 101,
  issueNumber: 42,
  issueTitle: "Runtime control issue",
  issueBranchName: "hostlocal/issue-42",
  stage: "coding",
  queuePosition: null,
  terminalStatus: null,
  reasonCode: null,
  fixHint: null,
  isPaused: false,
  pausedAt: null,
  updatedAt: "2026-03-03T05:10:00.000Z",
  terminalAt: null,
  ...overrides,
});

const createRuntimeControlOutcome = (
  overrides: Partial<RuntimeRunControlOutcome> = {},
): RuntimeRunControlOutcome => ({
  acknowledged: true,
  runId: 101,
  isPaused: false,
  reasonCode: null,
  fixHint: null,
  ...overrides,
});

const createRuntimeTelemetryPayload = (
  overrides: Partial<RuntimeRunTelemetryEventPayload> = {},
): RuntimeRunTelemetryEventPayload => ({
  eventId: 200,
  runId: 101,
  repositoryFullName: "Owner/Repo",
  repositoryKey: "owner/repo",
  issueNumber: 42,
  issueTitle: "Telemetry issue",
  issueBranchName: "hostlocal/issue-42",
  sequence: 2,
  kind: "milestone",
  stage: "coding",
  message: "Generated patch for sidebar feed.",
  redactionReasons: [],
  includeInSummary: true,
  createdAt: "2026-03-03T05:02:00.000Z",
  ...overrides,
});

const createRuntimeTelemetryReplay = (): RuntimeIssueRunTelemetry => ({
  repositoryFullName: "Owner/Repo",
  repositoryKey: "owner/repo",
  issueNumber: 42,
  runId: 101,
  events: [
    createRuntimeTelemetryPayload({
      eventId: 1001,
      sequence: 1,
      message: "Queued issue run.",
    }),
    createRuntimeTelemetryPayload({
      eventId: 1003,
      sequence: 3,
      message: "Published run evidence.",
      stage: "publishing",
    }),
    createRuntimeTelemetryPayload({
      eventId: 1002,
      sequence: 2,
      message: "Prepared workspace.",
      stage: "preparing",
    }),
  ],
});

const createRuntimeSummary = (
  overrides: Partial<RuntimeIssueRunSummary> = {},
): RuntimeIssueRunSummary => ({
  repositoryFullName: "Owner/Repo",
  repositoryKey: "owner/repo",
  issueNumber: 42,
  runId: 101,
  completion: {
    status: "success",
    terminalAt: "2026-03-03T05:05:00.000Z",
  },
  keyActions: [
    {
      kind: "milestone",
      stage: "coding",
      message: "Implemented sidebar telemetry sections.",
      createdAt: "2026-03-03T05:03:00.000Z",
    },
  ],
  validationOutcomes: {
    code: "pass",
    browser: "pass",
  },
  ...overrides,
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

describe("runtime metadata helpers", () => {
  it("maps snapshot runs by issue number for deterministic lookup", () => {
    const byIssueNumber = mapRuntimeSnapshotByIssueNumber(createRuntimeSnapshot());

    expect(Object.keys(byIssueNumber)).toEqual(["41", "42"]);
    expect(byIssueNumber[41]?.queuePosition).toBe(1);
    expect(byIssueNumber[42]?.stage).toBe("coding");
  });

  it("merges stage-changed payloads onto existing runtime metadata", () => {
    const current = mapRuntimeSnapshotByIssueNumber(createRuntimeSnapshot());
    const merged = mergeRuntimeStageChangedPayload(
      current,
      createRuntimeStagePayload({
        runId: 100,
        issueNumber: 41,
        stage: "publishing",
        queuePosition: null,
      }),
    );

    expect(merged[41]).toMatchObject({
      runId: 100,
      issueNumber: 41,
      stage: "publishing",
      queuePosition: null,
      terminalStatus: null,
    });
    expect(merged[42]).toEqual(current[42]);
  });

  it("subscribes to runtime stage events and unlistens on cleanup", async () => {
    const unlisten = vi.fn();
    let handler: ((event: { payload: RuntimeRunStageChangedEventPayload }) => void) | null = null;
    const listen = vi.fn().mockImplementation(async (_eventName, callback) => {
      handler = callback;
      return unlisten;
    });
    const onPayload = vi.fn();

    const stop = await subscribeRuntimeStageChangedEvents("Owner/Repo", onPayload, { listen });
    handler?.({
      payload: createRuntimeStagePayload({
        issueNumber: 41,
        stage: "coding",
      }),
    });
    handler?.({
      payload: createRuntimeStagePayload({
        repositoryFullName: "Else/Repo",
        repositoryKey: "else/repo",
        issueNumber: 99,
      }),
    });
    stop();

    expect(listen).toHaveBeenCalledWith("runtime/run-stage-changed", expect.any(Function));
    expect(onPayload).toHaveBeenCalledTimes(1);
    expect(onPayload).toHaveBeenCalledWith(
      expect.objectContaining({
        repositoryFullName: "Owner/Repo",
        issueNumber: 41,
        stage: "coding",
      }),
    );
    expect(unlisten).toHaveBeenCalledTimes(1);
  });
});

describe("runtime telemetry helpers", () => {
  it("maps issue telemetry replay as newest-first by sequence", () => {
    const mapped = mapRuntimeTelemetryByIssueNumber(createRuntimeTelemetryReplay());

    expect(Object.keys(mapped)).toEqual(["42"]);
    expect(mapped[42]?.map((event) => event.sequence)).toEqual([3, 2, 1]);
    expect(mapped[42]?.[0]?.message).toBe("Published run evidence.");
  });

  it("merges telemetry payloads by issue with dedupe and newest-first ordering", () => {
    const replay = createRuntimeTelemetryReplay();
    const current = mapRuntimeTelemetryByIssueNumber(replay);

    const merged = mergeRuntimeTelemetryPayloadByIssueNumber(
      current,
      createRuntimeTelemetryPayload({
        eventId: 1002,
        sequence: 4,
        message: "Prepared workspace v2.",
      }),
    );

    expect(merged[42]?.map((event) => event.sequence)).toEqual([4, 3, 1]);
    expect(merged[42]?.find((event) => event.eventId === 1002)?.message).toBe("Prepared workspace v2.");
  });

  it("keeps terminal telemetry entries visible when newer merge updates arrive", () => {
    const withTerminal = mergeRuntimeTelemetryPayloadByIssueNumber(
      {},
      createRuntimeTelemetryPayload({
        eventId: 1100,
        sequence: 5,
        stage: "publishing",
        message: "Run completed with success.",
      }),
    );

    const merged = mergeRuntimeTelemetryPayloadByIssueNumber(
      withTerminal,
      createRuntimeTelemetryPayload({
        eventId: 1101,
        sequence: 4,
        stage: "validating",
        message: "Validation checks finished.",
      }),
    );

    expect(merged[42]?.map((event) => event.sequence)).toEqual([5, 4]);
    expect(merged[42]?.[0]?.message).toBe("Run completed with success.");
  });

  it("keeps repeated same-event merges deterministic for the selected issue", () => {
    const replay = createRuntimeTelemetryReplay();
    const initial = mapRuntimeTelemetryByIssueNumber(replay);

    const mergedA = mergeRuntimeTelemetryPayloadByIssueNumber(
      initial,
      createRuntimeTelemetryPayload({
        issueNumber: 42,
        eventId: 1003,
        sequence: 3,
        message: "Published run evidence.",
      }),
    );
    const mergedB = mergeRuntimeTelemetryPayloadByIssueNumber(
      mergedA,
      createRuntimeTelemetryPayload({
        issueNumber: 42,
        eventId: 1003,
        sequence: 3,
        message: "Published run evidence.",
      }),
    );

    expect(mergedA[42]).toEqual(mergedB[42]);
    expect(mergedB[42]?.map((event) => event.eventId)).toEqual([1003, 1002, 1001]);
  });

  it("subscribes to runtime telemetry events and filters non-selected repositories", async () => {
    const unlisten = vi.fn();
    let handler: ((event: { payload: RuntimeRunTelemetryEventPayload }) => void) | null = null;
    const listen = vi.fn().mockImplementation(async (_eventName, callback) => {
      handler = callback;
      return unlisten;
    });
    const onPayload = vi.fn();

    const stop = await subscribeRuntimeTelemetryEvents("Owner/Repo", onPayload, { listen });
    handler?.({
      payload: createRuntimeTelemetryPayload({
        issueNumber: 42,
        message: "Coding milestone reached.",
      }),
    });
    handler?.({
      payload: createRuntimeTelemetryPayload({
        repositoryFullName: "Else/Repo",
        repositoryKey: "else/repo",
        issueNumber: 99,
      }),
    });
    stop();

    expect(listen).toHaveBeenCalledWith("runtime/run-telemetry", expect.any(Function));
    expect(onPayload).toHaveBeenCalledTimes(1);
    expect(onPayload).toHaveBeenCalledWith(
      expect.objectContaining({
        repositoryFullName: "Owner/Repo",
        issueNumber: 42,
      }),
    );
    expect(unlisten).toHaveBeenCalledTimes(1);
  });
});

describe("runtime summary normalization", () => {
  it("uses not-run fallback when validation outcomes are absent and no validation actions exist", () => {
    const normalized = normalizeRuntimeIssueRunSummary({
      ...createRuntimeSummary(),
      validationOutcomes: undefined as unknown as RuntimeIssueRunSummary["validationOutcomes"],
    });

    expect(normalized.validationOutcomes).toEqual({
      code: "not-run",
      browser: "not-run",
    });
  });

  it("uses not-found fallback when validation actions exist but statuses are missing", () => {
    const normalized = normalizeRuntimeIssueRunSummary({
      ...createRuntimeSummary({
        keyActions: [
          {
            kind: "validation",
            stage: "validating",
            message: "Validation completed without explicit status metadata.",
            createdAt: "2026-03-03T05:04:00.000Z",
          },
        ],
      }),
      validationOutcomes: {
        code: "unknown" as RuntimeIssueRunSummary["validationOutcomes"]["code"],
        browser: "" as RuntimeIssueRunSummary["validationOutcomes"]["browser"],
      },
    });

    expect(normalized.validationOutcomes).toEqual({
      code: "not-found",
      browser: "not-found",
    });
  });
});

describe("runtime control helpers", () => {
  it("resolves state-aware control eligibility from selected runtime metadata", () => {
    expect(resolveRuntimeControlEligibility(createRuntimeControlTarget())).toEqual({
      canPauseRun: true,
      canResumeRun: false,
      canAbortRun: true,
      canSteerRun: true,
    });

    expect(
      resolveRuntimeControlEligibility(
        createRuntimeControlTarget({
          isPaused: true,
          pausedAt: "2026-03-03T05:11:00.000Z",
        }),
      ),
    ).toEqual({
      canPauseRun: false,
      canResumeRun: true,
      canAbortRun: true,
      canSteerRun: false,
    });

    expect(
      resolveRuntimeControlEligibility(
        createRuntimeControlTarget({
          stage: "queued",
          queuePosition: 2,
        }),
      ),
    ).toEqual({
      canPauseRun: false,
      canResumeRun: false,
      canAbortRun: false,
      canSteerRun: false,
    });

    expect(
      resolveRuntimeControlEligibility(
        createRuntimeControlTarget({
          terminalStatus: "cancelled",
        }),
      ),
    ).toEqual({
      canPauseRun: false,
      canResumeRun: false,
      canAbortRun: false,
      canSteerRun: false,
    });
  });

  it("returns null and skips command invocation when another control action is pending", async () => {
    const runtimePauseIssueRun = vi.fn();
    const runtimeResumeIssueRun = vi.fn();
    const runtimeAbortIssueRun = vi.fn();
    const runtimeSteerIssueRun = vi.fn();
    const pushRuntimeControlToast = vi.fn();
    const hydrateRuntimeSnapshot = vi.fn();
    const hydrateRuntimeHistoryForIssue = vi.fn();
    const hydrateRuntimeTelemetryForIssue = vi.fn();
    const hydrateRuntimeSummaryForIssue = vi.fn();

    const outcome = await executeRuntimeControlAction(
      {
        action: "steer",
        repositoryFullName: "Owner/Repo",
        issueNumber: 42,
        runtime: createRuntimeControlTarget(),
        pendingAction: "steer",
        instruction: "Please keep the patch focused on sidebar rendering.",
      },
      {
        runtimePauseIssueRun,
        runtimeResumeIssueRun,
        runtimeAbortIssueRun,
        runtimeSteerIssueRun,
        pushRuntimeControlToast,
        hydrateRuntimeSnapshot,
        hydrateRuntimeHistoryForIssue,
        hydrateRuntimeTelemetryForIssue,
        hydrateRuntimeSummaryForIssue,
      },
    );

    expect(outcome).toBeNull();
    expect(runtimeSteerIssueRun).not.toHaveBeenCalled();
    expect(pushRuntimeControlToast).not.toHaveBeenCalled();
  });

  it("hydrates runtime state and emits accepted toast copy for acknowledged actions", async () => {
    const runtimePauseIssueRun = vi
      .fn()
      .mockResolvedValue(createRuntimeControlOutcome({ acknowledged: true, runId: 101, isPaused: true }));
    const runtimeResumeIssueRun = vi.fn();
    const runtimeAbortIssueRun = vi.fn();
    const runtimeSteerIssueRun = vi.fn();
    const pushRuntimeControlToast = vi.fn();
    const hydrateRuntimeSnapshot = vi.fn().mockResolvedValue(undefined);
    const hydrateRuntimeHistoryForIssue = vi.fn().mockResolvedValue(undefined);
    const hydrateRuntimeTelemetryForIssue = vi.fn().mockResolvedValue(undefined);
    const hydrateRuntimeSummaryForIssue = vi.fn().mockResolvedValue(undefined);

    const outcome = await executeRuntimeControlAction(
      {
        action: "pause",
        repositoryFullName: "Owner/Repo",
        issueNumber: 42,
        runtime: createRuntimeControlTarget(),
        pendingAction: null,
      },
      {
        runtimePauseIssueRun,
        runtimeResumeIssueRun,
        runtimeAbortIssueRun,
        runtimeSteerIssueRun,
        pushRuntimeControlToast,
        hydrateRuntimeSnapshot,
        hydrateRuntimeHistoryForIssue,
        hydrateRuntimeTelemetryForIssue,
        hydrateRuntimeSummaryForIssue,
      },
    );

    expect(outcome).toEqual(createRuntimeControlOutcome({ acknowledged: true, runId: 101, isPaused: true }));
    expect(runtimePauseIssueRun).toHaveBeenCalledWith({
      repositoryFullName: "Owner/Repo",
      issueNumber: 42,
    });
    expect(hydrateRuntimeSnapshot).toHaveBeenCalledWith("Owner/Repo");
    expect(hydrateRuntimeHistoryForIssue).toHaveBeenCalledWith("Owner/Repo", 42);
    expect(hydrateRuntimeTelemetryForIssue).toHaveBeenCalledWith("Owner/Repo", 42, 101);
    expect(hydrateRuntimeSummaryForIssue).toHaveBeenCalledWith("Owner/Repo", 42, 101);
    expect(pushRuntimeControlToast).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "pause",
        status: "accepted",
        severity: "success",
      }),
    );
  });
});
