import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import hljs from "highlight.js/lib/core";
import bashLanguage from "highlight.js/lib/languages/bash";
import javascriptLanguage from "highlight.js/lib/languages/javascript";
import jsonLanguage from "highlight.js/lib/languages/json";
import markdownLanguage from "highlight.js/lib/languages/markdown";
import plaintextLanguage from "highlight.js/lib/languages/plaintext";
import rustLanguage from "highlight.js/lib/languages/rust";
import shellLanguage from "highlight.js/lib/languages/shell";
import typescriptLanguage from "highlight.js/lib/languages/typescript";
import xmlLanguage from "highlight.js/lib/languages/xml";
import yamlLanguage from "highlight.js/lib/languages/yaml";
import { siGithub } from "simple-icons";
import {
  githubAttemptIssueIntake,
  githubAuthLogout,
  githubAuthPoll,
  githubAuthStart,
  githubAuthStatus,
  githubListRepositories,
  githubListRepositoryItems,
  githubOpenItemUrl,
  githubRevertIssueIntake,
  githubOpenVerificationUrl,
  type GithubIssueIntakeOutcome,
  type GithubDeviceAuthStart,
  type GithubRepository,
  type GithubRepositoryItem,
  type GithubUser,
} from "../lib/commands";
import { beginIntakeAttempt, clearIntakeAttempts, createIntakeAttemptState, resolveIntakeAttempt } from "../intake/intake-state";
import { pushIntakeRejectionToast } from "../intake/toast-store";

type KanbanColumnKey = "todo" | "inProgress" | "inReview" | "done";
const CANVAS_DEFAULT_PAN_X = 0;
const CANVAS_DEFAULT_PAN_Y = 0;
const CANVAS_DEFAULT_ZOOM = 0.94;
const CANVAS_GRID_UNIT = 24;
const CANVAS_MIN_ZOOM = 0.35;
const CANVAS_MAX_ZOOM = 2.6;
const CANVAS_RESET_DURATION_MS = 320;
const BOARD_ORIGIN_X = 66;
const BOARD_ORIGIN_Y = 160;
const KANBAN_COLUMN_PAGE_SIZE = 6;
const CARD_POINTER_DRAG_THRESHOLD_PX = 6;
const DRAG_GHOST_CURSOR_OFFSET_X = 18;
const DRAG_GHOST_CURSOR_OFFSET_Y = 16;
const DRAG_GHOST_SNAPBACK_DURATION_MS = 240;

const KANBAN_COLUMNS: ReadonlyArray<{ key: KanbanColumnKey; title: string; description: string }> = [
  {
    key: "todo",
    title: "Todo",
    description: "Not started",
  },
  {
    key: "inProgress",
    title: "In Progress",
    description: "Active work",
  },
  {
    key: "inReview",
    title: "In Review",
    description: "Awaiting review",
  },
  {
    key: "done",
    title: "Done",
    description: "Closed and shipped",
  },
];

const isKanbanColumnKey = (value: string | null | undefined): value is KanbanColumnKey =>
  value === "todo" || value === "inProgress" || value === "inReview" || value === "done";

type DragGhostMode = "drag" | "snapback";

interface DragGhostState {
  itemId: number;
  issueNumber: number;
  title: string;
  isPullRequest: boolean;
  x: number;
  y: number;
  mode: DragGhostMode;
}

interface PointerDragContext {
  itemId: number;
  issueNumber: number;
  title: string;
  isPullRequest: boolean;
  originCenterX: number;
  originCenterY: number;
  dropX: number;
  dropY: number;
}

interface LoadRepositoryItemsOptions {
  background?: boolean;
}

const ISSUE_IN_PROGRESS_LABELS = new Set(["in progress", "in-progress", "doing", "wip", "working"]);
const AGENT_IN_PROGRESS_LABEL_PREFIX = "agent:";
const DEFAULT_AGENT_LABEL = "hostlocal";

let hasRegisteredHighlightLanguages = false;

const ensureHighlightLanguagesRegistered = () => {
  if (hasRegisteredHighlightLanguages) {
    return;
  }

  hljs.registerLanguage("plaintext", plaintextLanguage);
  hljs.registerLanguage("bash", bashLanguage);
  hljs.registerLanguage("shell", shellLanguage);
  hljs.registerLanguage("javascript", javascriptLanguage);
  hljs.registerLanguage("typescript", typescriptLanguage);
  hljs.registerLanguage("json", jsonLanguage);
  hljs.registerLanguage("yaml", yamlLanguage);
  hljs.registerLanguage("rust", rustLanguage);
  hljs.registerLanguage("markdown", markdownLanguage);
  hljs.registerLanguage("xml", xmlLanguage);

  hasRegisteredHighlightLanguages = true;
};

ensureHighlightLanguagesRegistered();

const parseTimestamp = (isoDate: string) => {
  const timestamp = Date.parse(isoDate);
  return Number.isNaN(timestamp) ? 0 : timestamp;
};

const formatUpdatedAt = (isoDate: string) => {
  const timestamp = parseTimestamp(isoDate);
  if (timestamp === 0) {
    return "Updated recently";
  }

  const date = new Date(timestamp);
  return `Updated ${date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  })}`;
};

const inferDefaultColumn = (item: GithubRepositoryItem): KanbanColumnKey => {
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

const formatIssueCountLabel = (assigneeCount: number) => {
  if (assigneeCount === 1) {
    return "1 assignee";
  }

  return `${assigneeCount} assignees`;
};

type IssueBodyBlock =
  | {
      kind: "paragraph";
      text: string;
    }
  | {
      kind: "code";
      language: string | null;
      code: string;
    };

type IssueBodyInlineToken =
  | {
      kind: "text";
      value: string;
    }
  | {
      kind: "inlineCode";
      value: string;
    };

const escapeHtml = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

const parseIssueBody = (input: string): IssueBodyBlock[] => {
  const normalizedInput = input.replaceAll(/\r\n?/g, "\n");
  const blocks: IssueBodyBlock[] = [];
  const paragraphLines: string[] = [];
  let codeLines: string[] = [];
  let isInCodeBlock = false;
  let activeCodeLanguage: string | null = null;

  const flushParagraph = () => {
    const paragraphText = paragraphLines.join("\n").trim();
    paragraphLines.length = 0;
    if (paragraphText.length > 0) {
      blocks.push({
        kind: "paragraph",
        text: paragraphText,
      });
    }
  };

  const flushCodeBlock = () => {
    blocks.push({
      kind: "code",
      language: activeCodeLanguage,
      code: codeLines.join("\n"),
    });
    codeLines = [];
    activeCodeLanguage = null;
  };

  for (const line of normalizedInput.split("\n")) {
    const fenceMatch = line.match(/^```([\w#+.-]*)\s*$/);
    if (fenceMatch) {
      if (isInCodeBlock) {
        flushCodeBlock();
        isInCodeBlock = false;
      } else {
        flushParagraph();
        isInCodeBlock = true;
        activeCodeLanguage = fenceMatch[1] ? fenceMatch[1] : null;
      }
      continue;
    }

    if (isInCodeBlock) {
      codeLines.push(line);
      continue;
    }

    if (line.trim().length === 0) {
      flushParagraph();
      continue;
    }

    paragraphLines.push(line);
  }

  if (isInCodeBlock) {
    flushCodeBlock();
  } else {
    flushParagraph();
  }

  return blocks;
};

const parseIssueInlineTokens = (text: string): IssueBodyInlineToken[] => {
  const tokens: IssueBodyInlineToken[] = [];
  let cursor = 0;

  while (cursor < text.length) {
    const inlineCodeStart = text.indexOf("`", cursor);
    if (inlineCodeStart < 0) {
      tokens.push({
        kind: "text",
        value: text.slice(cursor),
      });
      break;
    }

    const inlineCodeEnd = text.indexOf("`", inlineCodeStart + 1);
    if (inlineCodeEnd < 0) {
      tokens.push({
        kind: "text",
        value: text.slice(cursor),
      });
      break;
    }

    if (inlineCodeStart > cursor) {
      tokens.push({
        kind: "text",
        value: text.slice(cursor, inlineCodeStart),
      });
    }

    const inlineCodeValue = text.slice(inlineCodeStart + 1, inlineCodeEnd);
    if (inlineCodeValue.length === 0) {
      tokens.push({
        kind: "text",
        value: "``",
      });
    } else {
      tokens.push({
        kind: "inlineCode",
        value: inlineCodeValue,
      });
    }

    cursor = inlineCodeEnd + 1;
  }

  return tokens.length > 0
    ? tokens
    : [
        {
          kind: "text",
          value: text,
        },
      ];
};

const highlightIssueCode = (code: string, language: string | null) => {
  const normalizedLanguage = language?.trim().toLowerCase() ?? "";
  if (normalizedLanguage.length > 0 && hljs.getLanguage(normalizedLanguage)) {
    try {
      return hljs.highlight(code, {
        language: normalizedLanguage,
        ignoreIllegals: true,
      }).value;
    } catch {
      // Ignore and continue with fallback highlighting.
    }
  }

  try {
    return hljs.highlightAuto(code).value;
  } catch {
    return escapeHtml(code);
  }
};

const createDefaultVisibleCardCountByColumn = (): Record<KanbanColumnKey, number> => ({
  todo: KANBAN_COLUMN_PAGE_SIZE,
  inProgress: KANBAN_COLUMN_PAGE_SIZE,
  inReview: KANBAN_COLUMN_PAGE_SIZE,
  done: KANBAN_COLUMN_PAGE_SIZE,
});

export function MainLayout() {
  const [githubUser, setGithubUser] = createSignal<GithubUser | null>(null);
  const [authError, setAuthError] = createSignal<string | null>(null);
  const [isAuthChecking, setIsAuthChecking] = createSignal(true);
  const [isAuthStarting, setIsAuthStarting] = createSignal(false);
  const [isPollingAuth, setIsPollingAuth] = createSignal(false);
  const [isSigningOut, setIsSigningOut] = createSignal(false);
  const [isCodeCopied, setIsCodeCopied] = createSignal(false);
  const [deviceFlow, setDeviceFlow] = createSignal<GithubDeviceAuthStart | null>(null);
  const [repositories, setRepositories] = createSignal<GithubRepository[]>([]);
  const [repositoryListError, setRepositoryListError] = createSignal<string | null>(null);
  const [isRepositoryListLoading, setIsRepositoryListLoading] = createSignal(false);
  const [selectedRepositoryId, setSelectedRepositoryId] = createSignal<number | null>(null);
  const [repositoryItems, setRepositoryItems] = createSignal<GithubRepositoryItem[]>([]);
  const [repositoryItemsError, setRepositoryItemsError] = createSignal<string | null>(null);
  const [isRepositoryItemsLoading, setIsRepositoryItemsLoading] = createSignal(false);
  const [optimisticColumnByItemId, setOptimisticColumnByItemId] = createSignal<Record<number, KanbanColumnKey>>({});
  const [visibleCardCountByColumn, setVisibleCardCountByColumn] = createSignal<Record<KanbanColumnKey, number>>(
    createDefaultVisibleCardCountByColumn(),
  );
  const [draggingItemId, setDraggingItemId] = createSignal<number | null>(null);
  const [dragOverColumn, setDragOverColumn] = createSignal<KanbanColumnKey | null>(null);
  const [dragGhost, setDragGhost] = createSignal<DragGhostState | null>(null);
  const [isCardDragging, setIsCardDragging] = createSignal(false);
  const [canvasView, setCanvasView] = createSignal({
    panX: CANVAS_DEFAULT_PAN_X,
    panY: CANVAS_DEFAULT_PAN_Y,
    zoom: CANVAS_DEFAULT_ZOOM,
  });
  const [isCanvasPanning, setIsCanvasPanning] = createSignal(false);
  const [selectedBoardItemId, setSelectedBoardItemId] = createSignal<number | null>(null);

  let pollTimeoutId: number | null = null;
  let repositoryItemsRequestId = 0;
  let repositoryItemsLoadingCount = 0;
  let canvasResizeObserver: ResizeObserver | null = null;
  let activeCanvasPointerId: number | null = null;
  let resetAnimationFrameId: number | null = null;
  let lastPointerX = 0;
  let lastPointerY = 0;
  let pointerDragState:
    | {
        itemId: number;
        issueNumber: number;
        title: string;
        isPullRequest: boolean;
        pointerId: number;
        startX: number;
        startY: number;
        lastX: number;
        lastY: number;
        originCenterX: number;
        originCenterY: number;
        dragging: boolean;
      }
    | null = null;
  let canvasViewportRef: HTMLDivElement | undefined;
  let canvasGridRef: HTMLCanvasElement | undefined;
  const intakeAttemptState = createIntakeAttemptState();

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

  const clearPollTimer = () => {
    if (pollTimeoutId !== null) {
      window.clearTimeout(pollTimeoutId);
      pollTimeoutId = null;
    }
  };

  const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

  const stopCanvasResetAnimation = () => {
    if (resetAnimationFrameId !== null) {
      window.cancelAnimationFrame(resetAnimationFrameId);
      resetAnimationFrameId = null;
    }
  };

  const boardCameraStyle = createMemo(() => {
    const view = canvasView();
    return {
      transform: `translate3d(${BOARD_ORIGIN_X + view.panX}px, ${BOARD_ORIGIN_Y + view.panY}px, 0) scale(${view.zoom})`,
    };
  });

  const selectedBoardItem = createMemo(() => {
    const itemId = selectedBoardItemId();
    if (itemId === null) {
      return null;
    }

    return repositoryItems().find((item) => item.id === itemId) ?? null;
  });

  const shouldPanCanvasFromTarget = (target: EventTarget | null, pointerButton: number) => {
    if (pointerButton === 1) {
      return true;
    }

    if (!(target instanceof Element)) {
      return true;
    }

    return !target.closest("a,button,input,textarea,select,label,[draggable='true'],.kanban-card");
  };

  const getCanvasTokenColor = (tokenName: string, fallbackTokenName: string) => {
    if (!canvasViewportRef) {
      return "";
    }

    const styles = window.getComputedStyle(canvasViewportRef);
    const value = styles.getPropertyValue(tokenName).trim();
    if (value.length > 0) {
      return value;
    }

    return styles.getPropertyValue(fallbackTokenName).trim();
  };

  const drawGridLines = (
    context: CanvasRenderingContext2D,
    width: number,
    height: number,
    spacing: number,
    originX: number,
    originY: number,
  ) => {
    if (spacing <= 0) {
      return;
    }

    const normalizedX = ((originX % spacing) + spacing) % spacing;
    const normalizedY = ((originY % spacing) + spacing) % spacing;

    context.beginPath();

    for (let x = normalizedX; x <= width; x += spacing) {
      const alignedX = Math.round(x) + 0.5;
      context.moveTo(alignedX, 0);
      context.lineTo(alignedX, height);
    }

    for (let y = normalizedY; y <= height; y += spacing) {
      const alignedY = Math.round(y) + 0.5;
      context.moveTo(0, alignedY);
      context.lineTo(width, alignedY);
    }

    context.stroke();
  };

  const drawCanvas = () => {
    if (!canvasGridRef || !canvasViewportRef) {
      return;
    }

    const context = canvasGridRef.getContext("2d");
    if (!context) {
      return;
    }

    const dpr = window.devicePixelRatio || 1;
    const width = canvasGridRef.width / dpr;
    const height = canvasGridRef.height / dpr;

    context.save();
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, canvasGridRef.width, canvasGridRef.height);
    context.restore();
    context.setTransform(dpr, 0, 0, dpr, 0, 0);

    const view = canvasView();
    const spacing = CANVAS_GRID_UNIT * view.zoom;
    if (spacing < 8) {
      return;
    }

    context.strokeStyle = getCanvasTokenColor("--content-canvas-grid-line", "--app-grid-line");
    context.lineWidth = 1;
    drawGridLines(context, width, height, spacing, BOARD_ORIGIN_X + view.panX, BOARD_ORIGIN_Y + view.panY);
  };

  const resizeCanvas = () => {
    if (!canvasGridRef || !canvasViewportRef) {
      return;
    }

    const rect = canvasViewportRef.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvasGridRef.width = Math.max(1, Math.floor(rect.width * dpr));
    canvasGridRef.height = Math.max(1, Math.floor(rect.height * dpr));
    drawCanvas();
  };

  const resetCanvasView = () => {
    stopCanvasResetAnimation();

    const startView = canvasView();
    const startedAt = performance.now();

    const animateFrame = (timestamp: number) => {
      const progress = Math.min(1, (timestamp - startedAt) / CANVAS_RESET_DURATION_MS);
      const easedProgress = 1 - (1 - progress) ** 3;

      setCanvasView({
        panX: startView.panX + (CANVAS_DEFAULT_PAN_X - startView.panX) * easedProgress,
        panY: startView.panY + (CANVAS_DEFAULT_PAN_Y - startView.panY) * easedProgress,
        zoom: startView.zoom + (CANVAS_DEFAULT_ZOOM - startView.zoom) * easedProgress,
      });

      if (progress < 1) {
        resetAnimationFrameId = window.requestAnimationFrame(animateFrame);
        return;
      }

      resetAnimationFrameId = null;
      setCanvasView({
        panX: CANVAS_DEFAULT_PAN_X,
        panY: CANVAS_DEFAULT_PAN_Y,
        zoom: CANVAS_DEFAULT_ZOOM,
      });
    };

    resetAnimationFrameId = window.requestAnimationFrame(animateFrame);
  };

  const beginCanvasPan = (event: PointerEvent) => {
    if (event.button !== 0 && event.button !== 1) {
      return;
    }

    if (!canvasViewportRef) {
      return;
    }

    if (!shouldPanCanvasFromTarget(event.target, event.button)) {
      return;
    }

    stopCanvasResetAnimation();
    activeCanvasPointerId = event.pointerId;
    lastPointerX = event.clientX;
    lastPointerY = event.clientY;
    setIsCanvasPanning(true);
    canvasViewportRef.setPointerCapture(event.pointerId);
    event.preventDefault();
  };

  const moveCanvasPan = (event: PointerEvent) => {
    if (activeCanvasPointerId !== event.pointerId) {
      return;
    }

    const deltaX = event.clientX - lastPointerX;
    const deltaY = event.clientY - lastPointerY;
    lastPointerX = event.clientX;
    lastPointerY = event.clientY;

    if (deltaX === 0 && deltaY === 0) {
      return;
    }

    setCanvasView((current) => ({
      ...current,
      panX: current.panX + deltaX,
      panY: current.panY + deltaY,
    }));
    event.preventDefault();
  };

  const endCanvasPan = (event: PointerEvent) => {
    if (activeCanvasPointerId !== event.pointerId) {
      return;
    }

    if (canvasViewportRef && canvasViewportRef.hasPointerCapture(event.pointerId)) {
      canvasViewportRef.releasePointerCapture(event.pointerId);
    }

    activeCanvasPointerId = null;
    setIsCanvasPanning(false);
  };

  const zoomCanvas = (event: WheelEvent) => {
    if (!canvasViewportRef) {
      return;
    }

    stopCanvasResetAnimation();

    const rect = canvasViewportRef.getBoundingClientRect();
    const pointX = event.clientX - rect.left;
    const pointY = event.clientY - rect.top;
    const current = canvasView();
    const zoomFactor = Math.exp(-event.deltaY * 0.0015);
    const nextZoom = clamp(current.zoom * zoomFactor, CANVAS_MIN_ZOOM, CANVAS_MAX_ZOOM);

    if (Math.abs(nextZoom - current.zoom) < 0.0001) {
      event.preventDefault();
      return;
    }

    const worldX = (pointX - BOARD_ORIGIN_X - current.panX) / current.zoom;
    const worldY = (pointY - BOARD_ORIGIN_Y - current.panY) / current.zoom;

    setCanvasView({
      panX: pointX - BOARD_ORIGIN_X - worldX * nextZoom,
      panY: pointY - BOARD_ORIGIN_Y - worldY * nextZoom,
      zoom: nextZoom,
    });

    event.preventDefault();
  };

  const handleCanvasDoubleClick = (event: MouseEvent) => {
    if (!shouldPanCanvasFromTarget(event.target, 0)) {
      return;
    }

    resetCanvasView();
  };

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

  const clearRepositoryState = () => {
    setRepositories([]);
    setSelectedRepositoryId(null);
    setRepositoryListError(null);
    setIsRepositoryListLoading(false);
    clearRepositoryItemState();
  };

  const selectedRepository = () => {
    const repositoryId = selectedRepositoryId();
    if (repositoryId === null) {
      return null;
    }

    return repositories().find((repository) => repository.id === repositoryId) ?? null;
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

      setRepositoryItems(
        [...items].sort((left, right) => right.number - left.number),
      );
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

  const loadRepositories = async () => {
    setIsRepositoryListLoading(true);
    setRepositoryListError(null);

    try {
      const allRepositories = await githubListRepositories();
      setRepositories(allRepositories);
      setSelectedRepositoryId((currentRepositoryId) => {
        if (currentRepositoryId !== null && allRepositories.some((repository) => repository.id === currentRepositoryId)) {
          return currentRepositoryId;
        }

        return allRepositories.length > 0 ? allRepositories[0].id : null;
      });
    } catch (error) {
      clearRepositoryState();
      setRepositoryListError(formatInvokeError(error, "Unable to load repositories."));
    } finally {
      setIsRepositoryListLoading(false);
    }
  };

  const refreshAuthState = async () => {
    setIsAuthChecking(true);

    try {
      const status = await githubAuthStatus();
      setGithubUser(status.user);
      setAuthError(null);

      if (status.user) {
        await loadRepositories();
      } else {
        clearRepositoryState();
      }
    } catch {
      setGithubUser(null);
      clearRepositoryState();
      setAuthError("Unable to load GitHub connection status.");
    } finally {
      setIsAuthChecking(false);
    }
  };

  const scheduleAuthPoll = (delayMs: number) => {
    clearPollTimer();
    pollTimeoutId = window.setTimeout(() => {
      void pollForGithubAuthorization(delayMs);
    }, delayMs);
  };

  const pollForGithubAuthorization = async (delayMs: number) => {
    if (!deviceFlow()) {
      return;
    }

    setIsPollingAuth(true);

    try {
      const pollResponse = await githubAuthPoll();
      if (pollResponse.status === "authorized") {
        clearPollTimer();
        setAuthError(null);
        setDeviceFlow(null);
        setIsCodeCopied(false);
        await refreshAuthState();
        return;
      }

      if (pollResponse.status === "pending") {
        scheduleAuthPoll(delayMs);
        return;
      }

      if (pollResponse.status === "slow_down") {
        scheduleAuthPoll(delayMs + 5000);
        return;
      }

      clearPollTimer();
      setDeviceFlow(null);
      setIsCodeCopied(false);
      if (pollResponse.status === "denied") {
        setAuthError("GitHub authorization was denied.");
      } else if (pollResponse.status === "expired") {
        setAuthError("GitHub authorization expired. Start again.");
      } else {
        setAuthError("GitHub authorization failed.");
      }
    } catch (error) {
      clearPollTimer();
      setDeviceFlow(null);
      setIsCodeCopied(false);
      setAuthError(formatInvokeError(error, "Unable to complete GitHub authorization."));
    } finally {
      setIsPollingAuth(false);
    }
  };

  const connectGithub = async () => {
    setAuthError(null);
    setIsAuthStarting(true);
    setIsCodeCopied(false);

    try {
      const flow = await githubAuthStart();
      setDeviceFlow(flow);
      scheduleAuthPoll(Math.max(1, flow.intervalSeconds) * 1000);
      try {
        await githubOpenVerificationUrl(flow.verificationUri);
      } catch {
        setAuthError("Could not open browser automatically. Use 'Open verification page'.");
      }
    } catch (error) {
      setAuthError(formatInvokeError(error, "Unable to start GitHub authorization."));
    } finally {
      setIsAuthStarting(false);
    }
  };

  const copyUserCode = async () => {
    const flow = deviceFlow();
    if (!flow) {
      return;
    }

    try {
      await navigator.clipboard.writeText(flow.userCode);
      setIsCodeCopied(true);
      window.setTimeout(() => setIsCodeCopied(false), 1500);
    } catch {
      setAuthError("Could not copy the GitHub code.");
    }
  };

  const signOutGithub = async () => {
    setIsSigningOut(true);
    setAuthError(null);

    try {
      await githubAuthLogout();
      clearPollTimer();
      setDeviceFlow(null);
      setGithubUser(null);
      setIsCodeCopied(false);
      clearRepositoryState();
    } catch {
      setAuthError("Unable to sign out from GitHub.");
    } finally {
      setIsSigningOut(false);
    }
  };

  const openVerificationPage = async () => {
    const flow = deviceFlow();
    if (!flow) {
      return;
    }

    try {
      await githubOpenVerificationUrl(flow.verificationUri);
    } catch {
      setAuthError("Unable to open the verification page.");
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

  const startAgentRunForIssue = async (item: GithubRepositoryItem) => {
    // Phase 2 boundary for Phase 3 integration: accepted intake starts the run boundary.
    console.info(`[intake] start run boundary for issue #${item.number}`);
  };

  const emitIntakeRejection = (outcome: GithubIssueIntakeOutcome) => {
    pushIntakeRejectionToast(outcome.reasonCode, outcome.fixHint);
  };

  const createDragGhostState = (
    context: {
      itemId: number;
      issueNumber: number;
      title: string;
      isPullRequest: boolean;
    },
    clientX: number,
    clientY: number,
    mode: DragGhostMode = "drag",
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
            await startAgentRunForIssue(item);
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

  createEffect(() => {
    canvasView();
    drawCanvas();
  });

  onMount(() => {
    void refreshAuthState();
    resizeCanvas();
    canvasResizeObserver = new ResizeObserver(() => {
      resizeCanvas();
    });
    if (canvasViewportRef) {
      canvasResizeObserver.observe(canvasViewportRef);
    }
    window.addEventListener("pointermove", handleWindowPointerMove, { passive: false });
    window.addEventListener("pointerup", handleWindowPointerUp, { passive: false });
    window.addEventListener("pointercancel", handleWindowPointerCancel);
  });

  onCleanup(() => {
    clearPollTimer();
    stopCanvasResetAnimation();
    pointerDragState = null;
    clearIntakeAttempts(intakeAttemptState);
    document.documentElement.classList.remove("is-card-dragging");
    window.removeEventListener("pointermove", handleWindowPointerMove);
    window.removeEventListener("pointerup", handleWindowPointerUp);
    window.removeEventListener("pointercancel", handleWindowPointerCancel);
    if (canvasResizeObserver) {
      canvasResizeObserver.disconnect();
      canvasResizeObserver = null;
    }
  });

  return (
    <div class={`layout${selectedBoardItem() ? " is-issue-panel-open" : ""}`}>
      <aside class="sidebar-left">
        <div class="sidebar-repositories-panel">
          <div class="sidebar-repositories">
            <Show when={repositoryListError()}>
              {(error) => (
                <p class="sidebar-repositories-error" role="alert">
                  {error()}
                </p>
              )}
            </Show>
            <Show when={githubUser()} fallback={<p class="sidebar-repositories-empty">Connect GitHub to see your repositories.</p>}>
              <Show
                when={!isRepositoryListLoading()}
                fallback={<p class="sidebar-repositories-empty">Loading repositories...</p>}
              >
                <Show
                  when={repositories().length > 0}
                  fallback={<p class="sidebar-repositories-empty">No repositories found.</p>}
                >
                  <For each={repositories()}>
                    {(repository) => (
                      <button
                        type="button"
                        class={`sidebar-repository-item${selectedRepositoryId() === repository.id ? " is-selected" : ""}`}
                        title={repository.fullName}
                        onClick={() => setSelectedRepositoryId(repository.id)}
                      >
                        <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
                          <path d="M5 4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h4v-5h6v5h4a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2H5Z" />
                          <path d="M9 20v-5h6v5" />
                        </svg>
                        <p class="sidebar-repository-label">
                          <span class="sidebar-repository-name">{repository.name}</span>
                        </p>
                        <span
                          class={`sidebar-repository-visibility${repository.isPrivate ? " is-private" : ""}`}
                        >
                          {repository.isPrivate ? "Private" : "Public"}
                        </span>
                      </button>
                    )}
                  </For>
                </Show>
              </Show>
            </Show>
          </div>
        </div>

        <div class="sidebar-footer">
          <Show when={authError()}>
            {(error) => (
              <p class="sidebar-auth-error" role="alert">
                {error()}
              </p>
            )}
          </Show>

          <Show when={deviceFlow()}>
            {(flow) => (
              <div class="sidebar-device-flow">
                <p class="sidebar-device-title">Confirm on GitHub</p>
                <button
                  type="button"
                  class="sidebar-device-link"
                  onClick={() => void openVerificationPage()}
                >
                  Open verification page
                </button>
                <button type="button" class="sidebar-device-code" onClick={() => void copyUserCode()}>
                  <span>{flow().userCode}</span>
                  <span>{isCodeCopied() ? "Copied" : "Copy"}</span>
                </button>
                <p class="sidebar-device-hint">
                  {isPollingAuth() ? "Checking authorization..." : "Waiting for approval..."}
                </p>
              </div>
            )}
          </Show>

          <Show
            when={githubUser()}
            fallback={
              <button
                type="button"
                class="sidebar-connect-link"
                onClick={() => void connectGithub()}
                disabled={isAuthChecking() || isAuthStarting()}
              >
                {isAuthStarting() ? "Connecting..." : "Connect GitHub"}
              </button>
            }
          >
            {(user) => (
              <div class="sidebar-github-user">
                <img
                  class="sidebar-github-avatar"
                  src={user().avatarUrl}
                  alt={`${user().login} profile`}
                  loading="lazy"
                />
                <a
                  class="sidebar-github-login"
                  href={user().htmlUrl}
                  target="_blank"
                  rel="noreferrer"
                  title={user().login}
                >
                  {user().login}
                </a>
                <button
                  type="button"
                  class="sidebar-signout-btn"
                  onClick={() => void signOutGithub()}
                  aria-label="Sign out of GitHub"
                  title="Sign out"
                  disabled={isSigningOut()}
                >
                  <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
                    <path d="M14 7V4a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2v-3" />
                    <path d="M10 12h10" />
                    <path d="m17 8 4 4-4 4" />
                  </svg>
                </button>
              </div>
            )}
          </Show>
        </div>
      </aside>

      <section class="content">
        <header class="content-heading">
          <h2>{selectedRepository()?.fullName ?? "GitHub repositories"}</h2>
          <button
            type="button"
            class="content-board-refresh-btn"
            aria-label="Reset canvas view"
            title="Reset canvas view"
            onClick={resetCanvasView}
          >
            <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M12 4v4" />
              <path d="M12 16v4" />
              <path d="M4 12h4" />
              <path d="M16 12h4" />
              <circle cx="12" cy="12" r="3.5" />
            </svg>
          </button>
        </header>

        <div
          ref={(element) => {
            canvasViewportRef = element;
          }}
          class={`content-canvas-viewport${isCanvasPanning() ? " is-panning" : ""}${isCardDragging() ? " is-card-dragging" : ""}`}
          onPointerDown={beginCanvasPan}
          onPointerMove={moveCanvasPan}
          onPointerUp={endCanvasPan}
          onPointerCancel={endCanvasPan}
          onWheel={zoomCanvas}
          onDblClick={handleCanvasDoubleClick}
        >
          <canvas
            ref={(element) => {
              canvasGridRef = element;
            }}
            class="content-canvas-grid"
            aria-label="Interactive canvas background"
            role="img"
          />
          <div class="content-canvas-layer">
            <div class="content-canvas-world" style={boardCameraStyle()}>
              <Show when={selectedRepository()} fallback={<p class="kanban-state">Select a repository to open its board.</p>}>
                <Show when={!isRepositoryItemsLoading()} fallback={<p class="kanban-state">Loading board items...</p>}>
                  <Show
                    when={!repositoryItemsError()}
                    fallback={
                      <p class="kanban-state kanban-state-error" role="alert">
                        {repositoryItemsError() ?? "Unable to load board items."}
                      </p>
                    }
                  >
                    <div class="kanban-board" role="list" aria-label="Repository work board">
                      <For each={KANBAN_COLUMNS}>
                        {(column) => {
                          const columnItems = () => groupedItemsByColumn()[column.key];
                          const visibleColumnItems = () =>
                            columnItems().slice(0, visibleCardCountByColumn()[column.key]);
                          const hasMoreColumnItems = () =>
                            columnItems().length > visibleCardCountByColumn()[column.key];

                          return (
                            <section
                              class={`kanban-column${dragOverColumn() === column.key ? " is-drop-target" : ""}`}
                              data-column-key={column.key}
                              role="listitem"
                              aria-label={`${column.title} column`}
                            >
                              <header class="kanban-column-header">
                                <div>
                                  <p class="kanban-column-title">{column.title}</p>
                                  <p class="kanban-column-description">{column.description}</p>
                                </div>
                                <span class="kanban-column-count">{columnItems().length}</span>
                              </header>
                              <div class="kanban-column-cards">
                                <Show when={columnItems().length > 0} fallback={<p class="kanban-column-empty">No items</p>}>
                                  <For each={visibleColumnItems()}>
                                    {(item) => (
                                      <article
                                        class={`kanban-card${draggingItemId() === item.id ? " is-dragging" : ""}${selectedBoardItemId() === item.id ? " is-selected" : ""}`}
                                        onPointerDown={(event) => handleCardPointerDown(event, item)}
                                        onClick={() => setSelectedBoardItemId(item.id)}
                                      >
                                        <div class="kanban-card-top">
                                          <div class="kanban-card-top-meta">
                                            <span class={`kanban-card-kind${item.isPullRequest ? " is-pr" : " is-issue"}`}>
                                              {item.isPullRequest ? "Pull request" : "Issue"}
                                            </span>
                                            <span class="kanban-card-number">#{item.number}</span>
                                          </div>
                                          <span class="kanban-card-drag-handle" aria-hidden="true">
                                            <span class="kanban-card-drag-handle-dot" />
                                            <span class="kanban-card-drag-handle-dot" />
                                            <span class="kanban-card-drag-handle-dot" />
                                          </span>
                                        </div>

                                        <p class="kanban-card-title">
                                          {item.title}
                                        </p>

                                        <p class="kanban-card-meta">
                                          <span>{formatUpdatedAt(item.updatedAt)}</span>
                                          <Show when={item.assignees.length > 0}>
                                            <span>{formatIssueCountLabel(item.assignees.length)}</span>
                                          </Show>
                                          <Show when={item.draft}>
                                            <span>Draft</span>
                                          </Show>
                                        </p>
                                      </article>
                                    )}
                                  </For>
                                </Show>
                                <Show when={hasMoreColumnItems()}>
                                  <button
                                    type="button"
                                    class="kanban-column-load-more"
                                    onClick={() => loadMoreColumnCards(column.key)}
                                  >
                                    Load more
                                  </button>
                                </Show>
                              </div>
                            </section>
                          );
                        }}
                      </For>
                    </div>
                  </Show>
                </Show>
              </Show>
            </div>
          </div>
          <Show when={dragGhost()}>
            {(ghost) => (
              <article
                class={`kanban-drag-ghost${ghost().mode === "snapback" ? " is-snapback" : ""}`}
                style={{
                  left: `${ghost().x}px`,
                  top: `${ghost().y}px`,
                }}
                aria-hidden="true"
              >
                <div class="kanban-drag-ghost-top">
                  <div class="kanban-drag-ghost-top-meta">
                    <span class={`kanban-card-kind${ghost().isPullRequest ? " is-pr" : " is-issue"}`}>
                      {ghost().isPullRequest ? "Pull request" : "Issue"}
                    </span>
                    <span class="kanban-card-number">#{ghost().issueNumber}</span>
                  </div>
                  <span class="kanban-card-drag-handle" aria-hidden="true">
                    <span class="kanban-card-drag-handle-dot" />
                    <span class="kanban-card-drag-handle-dot" />
                    <span class="kanban-card-drag-handle-dot" />
                  </span>
                </div>
                <p class="kanban-drag-ghost-title">{ghost().title}</p>
              </article>
            )}
          </Show>
        </div>

      </section>

      <aside class="sidebar-right" aria-label="Selected issue details" aria-hidden={!selectedBoardItem()}>
        <Show when={selectedBoardItem()} keyed>
          {(item) => {
            return (
              <>
                <header class="sidebar-issue-header">
                  <div class="sidebar-issue-header-copy">
                    <p class="sidebar-issue-kicker">
                      {item.isPullRequest ? "Pull request" : "Issue"} #{item.number}
                    </p>
                    <h3 class="sidebar-issue-title">{item.title}</h3>
                  </div>
                  <button
                    type="button"
                    class="sidebar-issue-close"
                    aria-label="Close issue details"
                    title="Close details"
                    onClick={closeIssuePanel}
                  >
                    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
                      <path d="M6 6 18 18" />
                      <path d="M18 6 6 18" />
                    </svg>
                  </button>
                </header>

                <div class="sidebar-issue-content">
                  <section class="sidebar-issue-section">
                    <p class="sidebar-issue-section-title">Issue Text</p>
                    <Show
                      when={item.body && item.body.trim().length > 0}
                      fallback={<p class="sidebar-issue-inline-empty">No issue text provided.</p>}
                    >
                      <div class="sidebar-issue-body-content">
                        <For each={parseIssueBody(item.body ?? "")}>
                          {(block) => {
                            if (block.kind === "code") {
                              return (
                                <pre class="sidebar-issue-code-block">
                                  <Show when={block.language}>
                                    <span class="sidebar-issue-code-language">{block.language}</span>
                                  </Show>
                                  <code
                                    class="hljs sidebar-issue-code"
                                    innerHTML={highlightIssueCode(block.code, block.language)}
                                  />
                                </pre>
                              );
                            }

                            return (
                              <p class="sidebar-issue-body-paragraph">
                                <For each={parseIssueInlineTokens(block.text)}>
                                  {(token) => {
                                    if (token.kind === "inlineCode") {
                                      return <code class="sidebar-issue-inline-code">{token.value}</code>;
                                    }

                                    return token.value;
                                  }}
                                </For>
                              </p>
                            );
                          }}
                        </For>
                      </div>
                    </Show>
                  </section>

                  <div class="sidebar-issue-actions">
                    <a
                      class="sidebar-issue-link"
                      href={item.htmlUrl}
                      target="_blank"
                      rel="noreferrer"
                      onClick={(event) => {
                        event.preventDefault();
                        void openGithubItemPage(item.htmlUrl);
                      }}
                    >
                      <svg class="sidebar-issue-github-icon" viewBox="0 0 24 24" aria-hidden="true">
                        <path d={siGithub.path} />
                      </svg>
                      <span>Open on GitHub</span>
                    </a>
                  </div>
                </div>
              </>
            );
          }}
        </Show>
      </aside>
    </div>
  );
}
