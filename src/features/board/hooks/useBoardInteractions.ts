import { createEffect, createMemo, createSignal, onCleanup, onMount, type Accessor } from "solid-js";
import { listen, type Event as TauriEvent } from "@tauri-apps/api/event";
import {
  githubAttemptIssueIntake,
  githubListRepositoryItems,
  githubOpenItemUrl,
  githubRevertIssueIntake,
  runtimeDequeueIssueRun,
  runtimeEnqueueIssueRun,
  runtimeGetIssueRunHistory,
  runtimeGetIssueRunSummary,
  runtimeGetIssueRunTelemetry,
  runtimeGetRepositoryRunSnapshot,
  type RuntimeDequeueIssueRunOutcome,
  type GithubIssueIntakeOutcome,
  type GithubRepository,
  type GithubRepositoryItem,
  type GithubUser,
  type RuntimeIssueRunHistoryItem,
  type RuntimeIssueRunSummary,
  type RuntimeIssueRunTelemetry,
  type RuntimeRepositoryRunSnapshot,
  type RuntimeRepositoryRunSnapshotItem,
  type RuntimeRunTelemetryEventPayload,
  type RuntimeRunStageChangedEventPayload,
  type RuntimeEnqueueIssueRunOutcome,
} from "../../../lib/commands";
import { beginIntakeAttempt, clearIntakeAttempts, createIntakeAttemptState, resolveIntakeAttempt } from "../../../intake/intake-state";
import { pushIntakeRejectionToast } from "../../../intake/toast-store";
import { AGENT_IN_PROGRESS_LABEL_PREFIX, inferDefaultColumn } from "../column-inference";
import type {
  BoardDragSource,
  DragGhostState,
  KanbanColumnKey,
  OptimisticColumnByItemId,
  PointerDragContext,
  VisibleCardCountByColumn,
} from "../types";
import { isKanbanColumnKey } from "../types";

const KANBAN_COLUMN_PAGE_SIZE = 6;
const CARD_POINTER_DRAG_THRESHOLD_PX = 6;
const DRAG_GHOST_CURSOR_OFFSET_X = 18;
const DRAG_GHOST_CURSOR_OFFSET_Y = 16;
const DRAG_GHOST_SNAPBACK_DURATION_MS = 240;
const DEFAULT_AGENT_LABEL = "hostlocal";
const RUNTIME_STAGE_CHANGED_EVENT_NAME = "runtime/run-stage-changed";
const RUNTIME_RUN_TELEMETRY_EVENT_NAME = "runtime/run-telemetry";
const RUNTIME_TELEMETRY_REPLAY_LIMIT = 24;

export type RuntimeSnapshotByIssueNumber = Record<number, RuntimeRepositoryRunSnapshotItem>;
export type RuntimeHistoryByIssueNumber = Record<number, RuntimeIssueRunHistoryItem[]>;
export type RuntimeTelemetryByIssueNumber = Record<number, RuntimeRunTelemetryEventPayload[]>;
export type RuntimeSummaryByIssueNumber = Record<number, RuntimeIssueRunSummary | null>;

interface LoadRepositoryItemsOptions {
  background?: boolean;
}

interface PointerDragState extends BoardDragSource {
  pointerId: number;
  startX: number;
  startY: number;
  lastX: number;
  lastY: number;
  originCenterX: number;
  originCenterY: number;
  dragging: boolean;
}

const createDefaultVisibleCardCountByColumn = (): VisibleCardCountByColumn => ({
  todo: KANBAN_COLUMN_PAGE_SIZE,
  inProgress: KANBAN_COLUMN_PAGE_SIZE,
  inReview: KANBAN_COLUMN_PAGE_SIZE,
  done: KANBAN_COLUMN_PAGE_SIZE,
});

const formatInvokeError = (error: unknown, fallback: string) => {
  if (error instanceof Error && error.message) {
    return error.message;
  }

  if (typeof error === "string" && error.trim().length > 0) {
    return error;
  }

  if (error && typeof error === "object" && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message.trim().length > 0) {
      return message;
    }
  }

  return fallback;
};

export interface StartAgentRunForIssueInput {
  repositoryFullName: string;
  item: GithubRepositoryItem;
  agentLabel: string;
  emitIntakeRejection: (outcome: GithubIssueIntakeOutcome) => void;
}

export interface StartAgentRunForIssueDependencies {
  runtimeEnqueueIssueRun: typeof runtimeEnqueueIssueRun;
  githubRevertIssueIntake: typeof githubRevertIssueIntake;
}

const startAgentRunForIssueDependencies: StartAgentRunForIssueDependencies = {
  runtimeEnqueueIssueRun,
  githubRevertIssueIntake,
};

const toRuntimeRejectionOutcome = (outcome: RuntimeEnqueueIssueRunOutcome): GithubIssueIntakeOutcome => ({
  accepted: false,
  reasonCode: outcome.reasonCode ?? "runtime_startup_failed",
  fixHint: outcome.fixHint ?? "Runtime startup failed before local worker execution could begin.",
});

export interface RevertIssueIntakeWithRuntimeDequeueInput {
  repositoryFullName: string;
  item: GithubRepositoryItem;
  agentLabel: string;
}

export interface RevertIssueIntakeWithRuntimeDequeueDependencies {
  runtimeDequeueIssueRun: typeof runtimeDequeueIssueRun;
  githubRevertIssueIntake: typeof githubRevertIssueIntake;
}

const revertIssueIntakeWithRuntimeDequeueDependencies: RevertIssueIntakeWithRuntimeDequeueDependencies = {
  runtimeDequeueIssueRun,
  githubRevertIssueIntake,
};

const toRuntimeDequeueRejectionOutcome = (outcome: RuntimeDequeueIssueRunOutcome): GithubIssueIntakeOutcome => ({
  accepted: false,
  reasonCode: outcome.reasonCode ?? "runtime_queue_removal_failed",
  fixHint: outcome.fixHint ?? "Runtime queue removal failed before moving this issue back to Todo.",
});

export async function startAgentRunForIssue(
  input: StartAgentRunForIssueInput,
  dependencies: StartAgentRunForIssueDependencies = startAgentRunForIssueDependencies,
) {
  const runtimeOutcome = await dependencies.runtimeEnqueueIssueRun({
    repositoryFullName: input.repositoryFullName,
    issueNumber: input.item.number,
    issueTitle: input.item.title,
  });

  if (runtimeOutcome.status === "started" || runtimeOutcome.status === "queued") {
    return;
  }

  input.emitIntakeRejection(toRuntimeRejectionOutcome(runtimeOutcome));

  try {
    const revertOutcome = await dependencies.githubRevertIssueIntake({
      repositoryFullName: input.repositoryFullName,
      issueNumber: input.item.number,
      agentLabel: input.agentLabel,
    });
    if (!revertOutcome.accepted) {
      input.emitIntakeRejection(revertOutcome);
    }
  } catch (error) {
    input.emitIntakeRejection({
      accepted: false,
      reasonCode: "label_persist_failed",
      fixHint: formatInvokeError(
        error,
        "Intake reversion failed after runtime rejection. Retry when GitHub is reachable.",
      ),
    });
  }
}

export async function revertIssueIntakeWithRuntimeDequeue(
  input: RevertIssueIntakeWithRuntimeDequeueInput,
  dependencies: RevertIssueIntakeWithRuntimeDequeueDependencies = revertIssueIntakeWithRuntimeDequeueDependencies,
): Promise<GithubIssueIntakeOutcome> {
  try {
    const dequeueOutcome = await dependencies.runtimeDequeueIssueRun({
      repositoryFullName: input.repositoryFullName,
      issueNumber: input.item.number,
    });
    if (dequeueOutcome.status !== "removed") {
      return toRuntimeDequeueRejectionOutcome(dequeueOutcome);
    }
  } catch (error) {
    return {
      accepted: false,
      reasonCode: "runtime_queue_removal_failed",
      fixHint: formatInvokeError(
        error,
        "Runtime queue removal failed before moving this issue back to Todo.",
      ),
    };
  }

  return dependencies.githubRevertIssueIntake({
    repositoryFullName: input.repositoryFullName,
    issueNumber: input.item.number,
    agentLabel: input.agentLabel,
  });
}

const normalizeRepositoryIdentifier = (value: string) => value.trim().toLowerCase();

export function mapRuntimeSnapshotByIssueNumber(snapshot: RuntimeRepositoryRunSnapshot): RuntimeSnapshotByIssueNumber {
  const mapped: RuntimeSnapshotByIssueNumber = {};
  for (const run of snapshot.runs) {
    mapped[run.issueNumber] = run;
  }
  return mapped;
}

const sortRuntimeTelemetryNewestFirst = (
  events: RuntimeRunTelemetryEventPayload[],
): RuntimeRunTelemetryEventPayload[] =>
  [...events].sort((left, right) => {
    if (left.sequence !== right.sequence) {
      return right.sequence - left.sequence;
    }
    return right.eventId - left.eventId;
  });

export function mapRuntimeTelemetryByIssueNumber(
  telemetry: RuntimeIssueRunTelemetry,
): RuntimeTelemetryByIssueNumber {
  return {
    [telemetry.issueNumber]: sortRuntimeTelemetryNewestFirst(telemetry.events),
  };
}

export function mergeRuntimeTelemetryPayloadByIssueNumber(
  current: RuntimeTelemetryByIssueNumber,
  payload: RuntimeRunTelemetryEventPayload,
): RuntimeTelemetryByIssueNumber {
  const existing = current[payload.issueNumber] ?? [];
  const deduped = existing.filter((event) => event.eventId !== payload.eventId);
  const merged = sortRuntimeTelemetryNewestFirst([payload, ...deduped]).slice(0, RUNTIME_TELEMETRY_REPLAY_LIMIT);
  return {
    ...current,
    [payload.issueNumber]: merged,
  };
}

export function mergeRuntimeStageChangedPayload(
  current: RuntimeSnapshotByIssueNumber,
  payload: RuntimeRunStageChangedEventPayload,
): RuntimeSnapshotByIssueNumber {
  const previous = current[payload.issueNumber];
  return {
    ...current,
    [payload.issueNumber]: {
      runId: payload.runId,
      issueNumber: payload.issueNumber,
      issueTitle: payload.issueTitle,
      issueBranchName: payload.issueBranchName,
      stage: payload.stage,
      queuePosition: payload.queuePosition ?? null,
      terminalStatus: payload.terminalStatus ?? null,
      reasonCode: payload.reasonCode ?? null,
      fixHint: payload.fixHint ?? null,
      updatedAt: previous?.updatedAt ?? "",
      terminalAt: payload.terminalStatus ? previous?.terminalAt ?? null : null,
    },
  };
}

export interface RuntimeStageChangedEventSubscriptionDependencies {
  listen: typeof listen;
}

const runtimeStageChangedEventSubscriptionDependencies: RuntimeStageChangedEventSubscriptionDependencies = {
  listen,
};

export async function subscribeRuntimeStageChangedEvents(
  repositoryFullName: string,
  onPayload: (payload: RuntimeRunStageChangedEventPayload) => void,
  dependencies: RuntimeStageChangedEventSubscriptionDependencies = runtimeStageChangedEventSubscriptionDependencies,
): Promise<() => void> {
  const expectedRepository = normalizeRepositoryIdentifier(repositoryFullName);
  const unlisten = await dependencies.listen<RuntimeRunStageChangedEventPayload>(
    RUNTIME_STAGE_CHANGED_EVENT_NAME,
    (event: TauriEvent<RuntimeRunStageChangedEventPayload>) => {
      const payload = event.payload;
      if (normalizeRepositoryIdentifier(payload.repositoryFullName) !== expectedRepository) {
        return;
      }
      onPayload(payload);
    },
  );
  return () => {
    unlisten();
  };
}

export interface RuntimeTelemetryEventSubscriptionDependencies {
  listen: typeof listen;
}

const runtimeTelemetryEventSubscriptionDependencies: RuntimeTelemetryEventSubscriptionDependencies = {
  listen,
};

export async function subscribeRuntimeTelemetryEvents(
  repositoryFullName: string,
  onPayload: (payload: RuntimeRunTelemetryEventPayload) => void,
  dependencies: RuntimeTelemetryEventSubscriptionDependencies = runtimeTelemetryEventSubscriptionDependencies,
): Promise<() => void> {
  const expectedRepository = normalizeRepositoryIdentifier(repositoryFullName);
  const unlisten = await dependencies.listen<RuntimeRunTelemetryEventPayload>(
    RUNTIME_RUN_TELEMETRY_EVENT_NAME,
    (event: TauriEvent<RuntimeRunTelemetryEventPayload>) => {
      const payload = event.payload;
      if (normalizeRepositoryIdentifier(payload.repositoryFullName) !== expectedRepository) {
        return;
      }
      onPayload(payload);
    },
  );
  return () => {
    unlisten();
  };
}

export function useBoardInteractions(
  githubUser: Accessor<GithubUser | null>,
  selectedRepository: Accessor<GithubRepository | null>,
) {
  const [repositoryItems, setRepositoryItems] = createSignal<GithubRepositoryItem[]>([]);
  const [repositoryItemsError, setRepositoryItemsError] = createSignal<string | null>(null);
  const [isRepositoryItemsLoading, setIsRepositoryItemsLoading] = createSignal(false);
  const [optimisticColumnByItemId, setOptimisticColumnByItemId] = createSignal<OptimisticColumnByItemId>({});
  const [visibleCardCountByColumn, setVisibleCardCountByColumn] = createSignal<VisibleCardCountByColumn>(
    createDefaultVisibleCardCountByColumn(),
  );
  const [draggingItemId, setDraggingItemId] = createSignal<number | null>(null);
  const [dragOverColumn, setDragOverColumn] = createSignal<KanbanColumnKey | null>(null);
  const [dragGhost, setDragGhost] = createSignal<DragGhostState | null>(null);
  const [isCardDragging, setIsCardDragging] = createSignal(false);
  const [selectedBoardItemId, setSelectedBoardItemId] = createSignal<number | null>(null);
  const [runtimeSnapshotByIssueNumber, setRuntimeSnapshotByIssueNumber] = createSignal<RuntimeSnapshotByIssueNumber>({});
  const [runtimeHistoryByIssueNumber, setRuntimeHistoryByIssueNumber] = createSignal<RuntimeHistoryByIssueNumber>({});
  const [runtimeTelemetryByIssueNumber, setRuntimeTelemetryByIssueNumber] = createSignal<RuntimeTelemetryByIssueNumber>({});
  const [runtimeSummaryByIssueNumber, setRuntimeSummaryByIssueNumber] = createSignal<RuntimeSummaryByIssueNumber>({});

  let repositoryItemsRequestId = 0;
  let runtimeSnapshotRequestId = 0;
  let runtimeHistoryRequestId = 0;
  let runtimeTelemetryRequestId = 0;
  let runtimeSummaryRequestId = 0;
  let runtimeStageListenerRequestId = 0;
  let runtimeTelemetryListenerRequestId = 0;
  let repositoryItemsLoadingCount = 0;
  let pointerDragState: PointerDragState | null = null;
  let runtimeStageUnlisten: (() => void) | null = null;
  let runtimeTelemetryUnlisten: (() => void) | null = null;
  let activeRepositoryKey: string | null = null;
  let activeHistoryKey: string | null = null;
  let activeTelemetryKey: string | null = null;
  let activeSummaryKey: string | null = null;
  const intakeAttemptState = createIntakeAttemptState();

  const selectedBoardItem = createMemo(() => {
    const itemId = selectedBoardItemId();
    if (itemId === null) {
      return null;
    }

    return repositoryItems().find((item) => item.id === itemId) ?? null;
  });

  const selectedBoardRuntime = createMemo(() => {
    const item = selectedBoardItem();
    if (!item) {
      return null;
    }
    return runtimeSnapshotByIssueNumber()[item.number] ?? null;
  });

  const selectedBoardRuntimeHistory = createMemo(() => {
    const item = selectedBoardItem();
    if (!item) {
      return [];
    }
    return runtimeHistoryByIssueNumber()[item.number] ?? [];
  });

  const selectedBoardRuntimeTelemetry = createMemo(() => {
    const item = selectedBoardItem();
    if (!item) {
      return [];
    }
    return runtimeTelemetryByIssueNumber()[item.number] ?? [];
  });

  const selectedBoardRuntimeSummary = createMemo(() => {
    const item = selectedBoardItem();
    if (!item) {
      return null;
    }
    return runtimeSummaryByIssueNumber()[item.number] ?? null;
  });

  const clearRepositoryItemState = () => {
    activeHistoryKey = null;
    activeTelemetryKey = null;
    activeSummaryKey = null;
    repositoryItemsRequestId += 1;
    runtimeSnapshotRequestId += 1;
    runtimeHistoryRequestId += 1;
    runtimeTelemetryRequestId += 1;
    runtimeSummaryRequestId += 1;
    runtimeStageListenerRequestId += 1;
    runtimeTelemetryListenerRequestId += 1;
    if (runtimeStageUnlisten) {
      runtimeStageUnlisten();
      runtimeStageUnlisten = null;
    }
    if (runtimeTelemetryUnlisten) {
      runtimeTelemetryUnlisten();
      runtimeTelemetryUnlisten = null;
    }
    repositoryItemsLoadingCount = 0;
    pointerDragState = null;
    setRepositoryItems([]);
    setRuntimeSnapshotByIssueNumber({});
    setRuntimeHistoryByIssueNumber({});
    setRuntimeTelemetryByIssueNumber({});
    setRuntimeSummaryByIssueNumber({});
    setRepositoryItemsError(null);
    setIsRepositoryItemsLoading(false);
    setOptimisticColumnByItemId({});
    clearIntakeAttempts(intakeAttemptState);
    setVisibleCardCountByColumn(createDefaultVisibleCardCountByColumn());
    setDraggingItemId(null);
    setDragOverColumn(null);
    setDragGhost(null);
    setIsCardDragging(false);
    document.documentElement.classList.remove("is-card-dragging");
    setSelectedBoardItemId(null);
  };

  const groupedItemsByColumn = createMemo(() => {
    const grouped: Record<KanbanColumnKey, GithubRepositoryItem[]> = {
      todo: [],
      inProgress: [],
      inReview: [],
      done: [],
    };
    const optimisticColumns = optimisticColumnByItemId();
    const runtimeByIssueNumber = runtimeSnapshotByIssueNumber();

    for (const item of repositoryItems()) {
      const runtimeMetadata = runtimeByIssueNumber[item.number] ?? null;
      const column =
        optimisticColumns[item.id] ??
        inferDefaultColumn(
          item,
          runtimeMetadata
            ? {
                stage: runtimeMetadata.stage,
                terminalStatus: runtimeMetadata.terminalStatus,
              }
            : null,
        );
      grouped[column].push(item);
    }

    return grouped;
  });

  const normalizeAgentLabel = (value: string): string | null => {
    const normalized = value.trim().toLowerCase();
    if (normalized.length === 0) {
      return null;
    }

    if (normalized.startsWith(AGENT_IN_PROGRESS_LABEL_PREFIX)) {
      return normalized.length > AGENT_IN_PROGRESS_LABEL_PREFIX.length ? normalized : null;
    }

    return `${AGENT_IN_PROGRESS_LABEL_PREFIX}${normalized}`;
  };

  const applyOptimisticInProgressState = (itemId: number, agentLabel: string) => {
    const normalizedAgentLabel = normalizeAgentLabel(agentLabel);
    setRepositoryItems((currentItems) =>
      currentItems.map((currentItem) => {
        if (currentItem.id !== itemId) {
          return currentItem;
        }

        const nextLabels = [...currentItem.labels];
        if (
          normalizedAgentLabel &&
          !nextLabels.some((label) => label.trim().toLowerCase() === normalizedAgentLabel)
        ) {
          nextLabels.push(normalizedAgentLabel);
        }

        return {
          ...currentItem,
          labels: nextLabels,
          updatedAt: new Date().toISOString(),
        };
      }),
    );
  };

  const applyOptimisticTodoState = (itemId: number, agentLabel: string) => {
    const normalizedAgentLabel = normalizeAgentLabel(agentLabel);
    setRepositoryItems((currentItems) =>
      currentItems.map((currentItem) => {
        if (currentItem.id !== itemId) {
          return currentItem;
        }

        if (!normalizedAgentLabel) {
          return currentItem;
        }

        const nextLabels = currentItem.labels.filter((label) => label.trim().toLowerCase() !== normalizedAgentLabel);
        return {
          ...currentItem,
          labels: nextLabels,
          updatedAt: new Date().toISOString(),
        };
      }),
    );
  };

  const loadRepositoryItems = async (repositoryFullName: string, options: LoadRepositoryItemsOptions = {}) => {
    const requestId = ++repositoryItemsRequestId;
    const isBackgroundRefresh = options.background === true;
    if (!isBackgroundRefresh) {
      repositoryItemsLoadingCount += 1;
      setIsRepositoryItemsLoading(true);
      setRepositoryItemsError(null);
      clearIntakeAttempts(intakeAttemptState);
      setVisibleCardCountByColumn(createDefaultVisibleCardCountByColumn());
    }

    try {
      const items = await githubListRepositoryItems(repositoryFullName);
      if (requestId !== repositoryItemsRequestId) {
        return;
      }

      setRepositoryItems([...items].sort((left, right) => right.number - left.number));
    } catch (error) {
      if (requestId !== repositoryItemsRequestId) {
        return;
      }

      if (isBackgroundRefresh) {
        console.warn("[board] background refresh failed", error);
        return;
      }

      setRepositoryItems([]);
      setRepositoryItemsError(formatInvokeError(error, "Unable to load board items from GitHub."));
    } finally {
      if (!isBackgroundRefresh) {
        repositoryItemsLoadingCount = Math.max(0, repositoryItemsLoadingCount - 1);
        setIsRepositoryItemsLoading(repositoryItemsLoadingCount > 0);
      }
    }
  };

  const hydrateRuntimeSnapshot = async (repositoryFullName: string) => {
    const requestId = ++runtimeSnapshotRequestId;
    try {
      const snapshot = await runtimeGetRepositoryRunSnapshot(repositoryFullName);
      if (requestId !== runtimeSnapshotRequestId) {
        return;
      }
      setRuntimeSnapshotByIssueNumber(mapRuntimeSnapshotByIssueNumber(snapshot));
    } catch (error) {
      if (requestId !== runtimeSnapshotRequestId) {
        return;
      }
      console.warn("[board] runtime snapshot hydration failed", error);
      setRuntimeSnapshotByIssueNumber({});
    }
  };

  const hydrateRuntimeHistoryForIssue = async (repositoryFullName: string, issueNumber: number) => {
    const requestId = ++runtimeHistoryRequestId;
    try {
      const history = await runtimeGetIssueRunHistory({
        repositoryFullName,
        issueNumber,
      });
      if (requestId !== runtimeHistoryRequestId) {
        return;
      }
      setRuntimeHistoryByIssueNumber((current) => ({
        ...current,
        [issueNumber]: history.runs,
      }));
    } catch (error) {
      if (requestId !== runtimeHistoryRequestId) {
        return;
      }
      console.warn("[board] runtime issue history hydration failed", error);
      setRuntimeHistoryByIssueNumber((current) => ({
        ...current,
        [issueNumber]: [],
      }));
    }
  };

  const hydrateRuntimeTelemetryForIssue = async (
    repositoryFullName: string,
    issueNumber: number,
    runId?: number,
  ) => {
    const requestId = ++runtimeTelemetryRequestId;
    try {
      const telemetry = await runtimeGetIssueRunTelemetry({
        repositoryFullName,
        issueNumber,
        runId: runId ?? null,
        limit: RUNTIME_TELEMETRY_REPLAY_LIMIT,
      });
      if (requestId !== runtimeTelemetryRequestId) {
        return;
      }
      setRuntimeTelemetryByIssueNumber((current) => ({
        ...current,
        ...mapRuntimeTelemetryByIssueNumber(telemetry),
      }));
    } catch (error) {
      if (requestId !== runtimeTelemetryRequestId) {
        return;
      }
      console.warn("[board] runtime issue telemetry hydration failed", error);
      setRuntimeTelemetryByIssueNumber((current) => ({
        ...current,
        [issueNumber]: [],
      }));
    }
  };

  const hydrateRuntimeSummaryForIssue = async (
    repositoryFullName: string,
    issueNumber: number,
    runId?: number,
  ) => {
    const requestId = ++runtimeSummaryRequestId;
    try {
      const summary = await runtimeGetIssueRunSummary({
        repositoryFullName,
        issueNumber,
        runId: runId ?? null,
      });
      if (requestId !== runtimeSummaryRequestId) {
        return;
      }
      setRuntimeSummaryByIssueNumber((current) => ({
        ...current,
        [issueNumber]: summary,
      }));
    } catch (error) {
      if (requestId !== runtimeSummaryRequestId) {
        return;
      }
      console.warn("[board] runtime issue summary hydration failed", error);
      setRuntimeSummaryByIssueNumber((current) => ({
        ...current,
        [issueNumber]: null,
      }));
    }
  };

  const setupRuntimeStageListener = async (repositoryFullName: string) => {
    const requestId = ++runtimeStageListenerRequestId;
    if (runtimeStageUnlisten) {
      runtimeStageUnlisten();
      runtimeStageUnlisten = null;
    }

    try {
      const unlisten = await subscribeRuntimeStageChangedEvents(repositoryFullName, (payload) => {
        setRuntimeSnapshotByIssueNumber((current) => mergeRuntimeStageChangedPayload(current, payload));
        const activeRepository = selectedRepository();
        const activeItem = selectedBoardItem();
        if (activeRepository && activeItem && activeItem.number === payload.issueNumber) {
          void hydrateRuntimeHistoryForIssue(activeRepository.fullName, activeItem.number);
          if (payload.terminalStatus) {
            void hydrateRuntimeSummaryForIssue(activeRepository.fullName, activeItem.number, payload.runId);
          }
        }
      });

      if (requestId !== runtimeStageListenerRequestId) {
        unlisten();
        return;
      }
      runtimeStageUnlisten = unlisten;
    } catch (error) {
      if (requestId !== runtimeStageListenerRequestId) {
        return;
      }
      console.warn("[board] runtime stage listener setup failed", error);
    }
  };

  const setupRuntimeTelemetryListener = async (repositoryFullName: string) => {
    const requestId = ++runtimeTelemetryListenerRequestId;
    if (runtimeTelemetryUnlisten) {
      runtimeTelemetryUnlisten();
      runtimeTelemetryUnlisten = null;
    }

    try {
      const unlisten = await subscribeRuntimeTelemetryEvents(repositoryFullName, (payload) => {
        setRuntimeTelemetryByIssueNumber((current) => mergeRuntimeTelemetryPayloadByIssueNumber(current, payload));
        const activeRepository = selectedRepository();
        const activeItem = selectedBoardItem();
        if (activeRepository && activeItem && activeItem.number === payload.issueNumber) {
          void hydrateRuntimeSummaryForIssue(activeRepository.fullName, activeItem.number, payload.runId);
        }
      });

      if (requestId !== runtimeTelemetryListenerRequestId) {
        unlisten();
        return;
      }
      runtimeTelemetryUnlisten = unlisten;
    } catch (error) {
      if (requestId !== runtimeTelemetryListenerRequestId) {
        return;
      }
      console.warn("[board] runtime telemetry listener setup failed", error);
    }
  };

  const openGithubItemPage = async (url: string) => {
    try {
      await githubOpenItemUrl(url);
    } catch {
      // Browser fallback when native opener fails in the runtime.
      window.open(url, "_blank", "noopener,noreferrer");
    }
  };

  const setCardDragInteraction = (active: boolean) => {
    setIsCardDragging(active);
    document.documentElement.classList.toggle("is-card-dragging", active);
  };

  const handleCardDragEnd = () => {
    setDraggingItemId(null);
    setDragOverColumn(null);
    setDragGhost(null);
    setCardDragInteraction(false);
  };

  const closeIssuePanel = () => {
    setSelectedBoardItemId(null);
  };

  const resolveCurrentItemColumn = (itemId: number): KanbanColumnKey | null => {
    const item = repositoryItems().find((candidate) => candidate.id === itemId);
    if (!item) {
      return null;
    }

    return optimisticColumnByItemId()[item.id] ?? inferDefaultColumn(item);
  };

  const setOptimisticColumn = (itemId: number, column: KanbanColumnKey) => {
    setOptimisticColumnByItemId((current) => ({
      ...current,
      [itemId]: column,
    }));
  };

  const clearOptimisticColumn = (itemId: number) => {
    setOptimisticColumnByItemId((current) => {
      if (!(itemId in current)) {
        return current;
      }

      const next = { ...current };
      delete next[itemId];
      return next;
    });
  };

  const emitIntakeRejection = (outcome: GithubIssueIntakeOutcome) => {
    pushIntakeRejectionToast(outcome.reasonCode, outcome.fixHint);
  };

  const createDragGhostState = (
    context: BoardDragSource,
    clientX: number,
    clientY: number,
    mode: DragGhostState["mode"] = "drag",
  ): DragGhostState => ({
    itemId: context.itemId,
    issueNumber: context.issueNumber,
    title: context.title,
    isPullRequest: context.isPullRequest,
    x: clientX + DRAG_GHOST_CURSOR_OFFSET_X,
    y: clientY + DRAG_GHOST_CURSOR_OFFSET_Y,
    mode,
  });

  const animateDragGhostSnapBack = (context: PointerDragContext) =>
    new Promise<void>((resolve) => {
      const startX = context.dropX + DRAG_GHOST_CURSOR_OFFSET_X;
      const startY = context.dropY + DRAG_GHOST_CURSOR_OFFSET_Y;
      const endX = context.originCenterX;
      const endY = context.originCenterY;
      const startedAt = performance.now();

      const tick = (frameAt: number) => {
        const progress = Math.min(1, (frameAt - startedAt) / DRAG_GHOST_SNAPBACK_DURATION_MS);
        const eased = 1 - (1 - progress) ** 3;
        const x = startX + (endX - startX) * eased;
        const y = startY + (endY - startY) * eased;

        setDragGhost({
          itemId: context.itemId,
          issueNumber: context.issueNumber,
          title: context.title,
          isPullRequest: context.isPullRequest,
          x,
          y,
          mode: "snapback",
        });

        if (progress < 1) {
          window.requestAnimationFrame(tick);
          return;
        }

        resolve();
      };

      window.requestAnimationFrame(tick);
    });

  const performColumnDrop = async (
    itemId: number,
    columnKey: KanbanColumnKey,
    dragContext?: PointerDragContext,
  ) => {
    const sourceColumn = resolveCurrentItemColumn(itemId);
    const isTodoToInProgress = sourceColumn === "todo" && columnKey === "inProgress";
    const isInProgressToTodo = sourceColumn === "inProgress" && columnKey === "todo";
    if (!isTodoToInProgress && !isInProgressToTodo) {
      if (dragContext) {
        await animateDragGhostSnapBack(dragContext);
      }
      handleCardDragEnd();
      return;
    }

    const repository = selectedRepository();
    const item = repositoryItems().find((candidate) => candidate.id === itemId);
    if (!repository || !item) {
      handleCardDragEnd();
      return;
    }

    if (!beginIntakeAttempt(intakeAttemptState, itemId)) {
      if (dragContext) {
        await animateDragGhostSnapBack(dragContext);
      }
      pushIntakeRejectionToast(
        "duplicate_intake_pending",
        "An intake attempt is already pending for this issue. Wait for it to finish before retrying.",
      );
      handleCardDragEnd();
      return;
    }

    setOptimisticColumn(itemId, columnKey);
    // Do not keep the dropped ghost visible while waiting on intake network round-trips.
    handleCardDragEnd();

    try {
      const outcome = isTodoToInProgress
        ? await githubAttemptIssueIntake({
            repositoryFullName: repository.fullName,
            issueNumber: item.number,
            agentLabel: DEFAULT_AGENT_LABEL,
          })
        : await revertIssueIntakeWithRuntimeDequeue({
            repositoryFullName: repository.fullName,
            item,
            agentLabel: DEFAULT_AGENT_LABEL,
          });

      if (!outcome.accepted) {
        if (dragContext) {
          await animateDragGhostSnapBack(dragContext);
        }
        emitIntakeRejection(outcome);
        handleCardDragEnd();
        return;
      }

      if (isTodoToInProgress) {
        applyOptimisticInProgressState(item.id, DEFAULT_AGENT_LABEL);
      } else {
        applyOptimisticTodoState(item.id, DEFAULT_AGENT_LABEL);
      }
      void (async () => {
        try {
          if (isTodoToInProgress) {
            await startAgentRunForIssue({
              repositoryFullName: repository.fullName,
              item,
              agentLabel: DEFAULT_AGENT_LABEL,
              emitIntakeRejection,
            });
          }
        } finally {
          await loadRepositoryItems(repository.fullName, {
            background: true,
          });
        }
      })();
      return;
    } catch (error) {
      if (dragContext) {
        await animateDragGhostSnapBack(dragContext);
      }
      pushIntakeRejectionToast(
        "label_persist_failed",
        formatInvokeError(error, "Intake update failed before completion. Retry when GitHub is reachable."),
      );
      handleCardDragEnd();
    } finally {
      resolveIntakeAttempt(intakeAttemptState, itemId);
      clearOptimisticColumn(itemId);
    }
  };

  const loadMoreColumnCards = (columnKey: KanbanColumnKey) => {
    setVisibleCardCountByColumn((current) => ({
      ...current,
      [columnKey]: current[columnKey] + KANBAN_COLUMN_PAGE_SIZE,
    }));
  };

  const resolveColumnKeyFromPoint = (clientX: number, clientY: number): KanbanColumnKey | null => {
    const targetElement = document.elementFromPoint(clientX, clientY);
    if (!targetElement) {
      return null;
    }

    const columnElement = targetElement.closest<HTMLElement>("[data-column-key]");
    const key = columnElement?.dataset.columnKey;
    return isKanbanColumnKey(key) ? key : null;
  };

  const handleCardPointerDown = (event: PointerEvent, item: GithubRepositoryItem) => {
    if (event.button !== 0) {
      return;
    }

    const currentTarget = event.currentTarget;
    let originCenterX = event.clientX;
    let originCenterY = event.clientY;
    if (currentTarget instanceof HTMLElement) {
      const rect = currentTarget.getBoundingClientRect();
      originCenterX = rect.left + rect.width / 2;
      originCenterY = rect.top + rect.height / 2;
    }

    setSelectedBoardItemId(item.id);
    pointerDragState = {
      itemId: item.id,
      issueNumber: item.number,
      title: item.title,
      isPullRequest: item.isPullRequest,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      lastX: event.clientX,
      lastY: event.clientY,
      originCenterX,
      originCenterY,
      dragging: false,
    };
  };

  const handleWindowPointerMove = (event: PointerEvent) => {
    const state = pointerDragState;
    if (!state || state.pointerId !== event.pointerId) {
      return;
    }

    state.lastX = event.clientX;
    state.lastY = event.clientY;

    const distance = Math.hypot(state.lastX - state.startX, state.lastY - state.startY);
    if (!state.dragging && distance < CARD_POINTER_DRAG_THRESHOLD_PX) {
      return;
    }

    if (!state.dragging) {
      state.dragging = true;
      setDraggingItemId(state.itemId);
      setCardDragInteraction(true);
    }

    setDragGhost(createDragGhostState(state, state.lastX, state.lastY, "drag"));

    const columnKey = resolveColumnKeyFromPoint(state.lastX, state.lastY);
    if (dragOverColumn() !== columnKey) {
      setDragOverColumn(columnKey);
    }

    event.preventDefault();
  };

  const handleWindowPointerUp = (event: PointerEvent) => {
    const state = pointerDragState;
    if (!state || state.pointerId !== event.pointerId) {
      return;
    }

    pointerDragState = null;
    if (!state.dragging) {
      return;
    }

    const dropX = event.clientX;
    const dropY = event.clientY;
    const dragContext: PointerDragContext = {
      itemId: state.itemId,
      issueNumber: state.issueNumber,
      title: state.title,
      isPullRequest: state.isPullRequest,
      originCenterX: state.originCenterX,
      originCenterY: state.originCenterY,
      dropX,
      dropY,
    };

    const columnKey = resolveColumnKeyFromPoint(dropX, dropY);
    if (columnKey === null) {
      void (async () => {
        await animateDragGhostSnapBack(dragContext);
        handleCardDragEnd();
      })();
      return;
    }

    void performColumnDrop(state.itemId, columnKey, dragContext);
    event.preventDefault();
  };

  const handleWindowPointerCancel = (event: PointerEvent) => {
    const state = pointerDragState;
    if (!state || state.pointerId !== event.pointerId) {
      return;
    }

    pointerDragState = null;
    if (state.dragging) {
      handleCardDragEnd();
    }
  };

  createEffect(() => {
    const repository = selectedRepository();
    const user = githubUser();

    if (!user || !repository) {
      activeRepositoryKey = null;
      clearRepositoryItemState();
      return;
    }

    const repositoryKey = normalizeRepositoryIdentifier(repository.fullName);
    if (activeRepositoryKey === repositoryKey) {
      return;
    }
    activeRepositoryKey = repositoryKey;
    clearRepositoryItemState();
    void loadRepositoryItems(repository.fullName);
    void hydrateRuntimeSnapshot(repository.fullName);
    void setupRuntimeStageListener(repository.fullName);
    void setupRuntimeTelemetryListener(repository.fullName);
  });

  createEffect(() => {
    const repository = selectedRepository();
    const item = selectedBoardItem();
    if (!repository || !item) {
      activeHistoryKey = null;
      activeTelemetryKey = null;
      activeSummaryKey = null;
      return;
    }

    const issueScopeKey = `${normalizeRepositoryIdentifier(repository.fullName)}#${item.number}`;
    const historyKey = `${issueScopeKey}:history`;
    if (activeHistoryKey === historyKey) {
      // Keep checking telemetry/summary keys in the same effect.
    } else {
      activeHistoryKey = historyKey;
      void hydrateRuntimeHistoryForIssue(repository.fullName, item.number);
    }

    const telemetryKey = `${issueScopeKey}:telemetry`;
    if (activeTelemetryKey !== telemetryKey) {
      activeTelemetryKey = telemetryKey;
      void hydrateRuntimeTelemetryForIssue(repository.fullName, item.number);
    }

    const summaryKey = `${issueScopeKey}:summary`;
    if (activeSummaryKey !== summaryKey) {
      activeSummaryKey = summaryKey;
      void hydrateRuntimeSummaryForIssue(repository.fullName, item.number);
    }
  });

  onMount(() => {
    window.addEventListener("pointermove", handleWindowPointerMove, { passive: false });
    window.addEventListener("pointerup", handleWindowPointerUp, { passive: false });
    window.addEventListener("pointercancel", handleWindowPointerCancel);
  });

  onCleanup(() => {
    if (runtimeStageUnlisten) {
      runtimeStageUnlisten();
      runtimeStageUnlisten = null;
    }
    if (runtimeTelemetryUnlisten) {
      runtimeTelemetryUnlisten();
      runtimeTelemetryUnlisten = null;
    }
    pointerDragState = null;
    clearIntakeAttempts(intakeAttemptState);
    document.documentElement.classList.remove("is-card-dragging");
    window.removeEventListener("pointermove", handleWindowPointerMove);
    window.removeEventListener("pointerup", handleWindowPointerUp);
    window.removeEventListener("pointercancel", handleWindowPointerCancel);
  });

  return {
    repositoryItemsError,
    isRepositoryItemsLoading,
    groupedItemsByColumn,
    visibleCardCountByColumn,
    draggingItemId,
    dragOverColumn,
    dragGhost,
    isCardDragging,
    runtimeSnapshotByIssueNumber,
    runtimeHistoryByIssueNumber,
    runtimeTelemetryByIssueNumber,
    runtimeSummaryByIssueNumber,
    selectedBoardItemId,
    selectedBoardItem,
    selectedBoardRuntime,
    selectedBoardRuntimeHistory,
    selectedBoardRuntimeTelemetry,
    selectedBoardRuntimeSummary,
    setSelectedBoardItemId,
    handleCardPointerDown,
    loadMoreColumnCards,
    openGithubItemPage,
    closeIssuePanel,
  };
}
