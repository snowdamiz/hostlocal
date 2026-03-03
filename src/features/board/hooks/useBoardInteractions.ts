import { createEffect, createMemo, createSignal, onCleanup, onMount, type Accessor } from "solid-js";
import {
  githubAttemptIssueIntake,
  githubListRepositoryItems,
  githubOpenItemUrl,
  githubRevertIssueIntake,
  runtimeEnqueueIssueRun,
  type GithubIssueIntakeOutcome,
  type GithubRepository,
  type GithubRepositoryItem,
  type GithubUser,
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

  let repositoryItemsRequestId = 0;
  let repositoryItemsLoadingCount = 0;
  let pointerDragState: PointerDragState | null = null;
  const intakeAttemptState = createIntakeAttemptState();

  const selectedBoardItem = createMemo(() => {
    const itemId = selectedBoardItemId();
    if (itemId === null) {
      return null;
    }

    return repositoryItems().find((item) => item.id === itemId) ?? null;
  });

  const clearRepositoryItemState = () => {
    repositoryItemsRequestId += 1;
    repositoryItemsLoadingCount = 0;
    pointerDragState = null;
    setRepositoryItems([]);
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

    for (const item of repositoryItems()) {
      const column = optimisticColumns[item.id] ?? inferDefaultColumn(item);
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
        : await githubRevertIssueIntake({
            repositoryFullName: repository.fullName,
            issueNumber: item.number,
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
      clearRepositoryItemState();
      return;
    }

    void loadRepositoryItems(repository.fullName);
  });

  onMount(() => {
    window.addEventListener("pointermove", handleWindowPointerMove, { passive: false });
    window.addEventListener("pointerup", handleWindowPointerUp, { passive: false });
    window.addEventListener("pointercancel", handleWindowPointerCancel);
  });

  onCleanup(() => {
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
    selectedBoardItemId,
    selectedBoardItem,
    setSelectedBoardItemId,
    handleCardPointerDown,
    loadMoreColumnCards,
    openGithubItemPage,
    closeIssuePanel,
  };
}
