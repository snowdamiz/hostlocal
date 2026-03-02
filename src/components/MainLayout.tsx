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
  githubAuthLogout,
  githubAuthPoll,
  githubAuthStart,
  githubAuthStatus,
  githubListRepositories,
  githubListRepositoryItems,
  githubOpenItemUrl,
  githubOpenVerificationUrl,
  type GithubDeviceAuthStart,
  type GithubRepository,
  type GithubRepositoryItem,
  type GithubUser,
} from "../lib/commands";

type KanbanColumnKey = "todo" | "inProgress" | "inReview" | "done";
const CANVAS_DEFAULT_PAN_X = 0;
const CANVAS_DEFAULT_PAN_Y = 0;
const CANVAS_DEFAULT_ZOOM = 0.60;
const CANVAS_GRID_UNIT = 24;
const CANVAS_MIN_ZOOM = 0.35;
const CANVAS_MAX_ZOOM = 2.6;
const CANVAS_RESET_DURATION_MS = 320;
const BOARD_ORIGIN_X = 66;
const BOARD_ORIGIN_Y = 180;
const KANBAN_COLUMN_PAGE_SIZE = 6;

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

const ISSUE_IN_PROGRESS_LABELS = new Set(["in progress", "in-progress", "doing", "wip", "working"]);

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

  const hasInProgressLabel = item.labels.some((label) => ISSUE_IN_PROGRESS_LABELS.has(label.trim().toLowerCase()));
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
  const [manualColumnByItemId, setManualColumnByItemId] = createSignal<Record<number, KanbanColumnKey>>({});
  const [visibleCardCountByColumn, setVisibleCardCountByColumn] = createSignal<Record<KanbanColumnKey, number>>(
    createDefaultVisibleCardCountByColumn(),
  );
  const [draggingItemId, setDraggingItemId] = createSignal<number | null>(null);
  const [dragOverColumn, setDragOverColumn] = createSignal<KanbanColumnKey | null>(null);
  const [canvasView, setCanvasView] = createSignal({
    panX: CANVAS_DEFAULT_PAN_X,
    panY: CANVAS_DEFAULT_PAN_Y,
    zoom: CANVAS_DEFAULT_ZOOM,
  });
  const [isCanvasPanning, setIsCanvasPanning] = createSignal(false);
  const [selectedBoardItemId, setSelectedBoardItemId] = createSignal<number | null>(null);

  let pollTimeoutId: number | null = null;
  let repositoryItemsRequestId = 0;
  let canvasResizeObserver: ResizeObserver | null = null;
  let activeCanvasPointerId: number | null = null;
  let resetAnimationFrameId: number | null = null;
  let lastPointerX = 0;
  let lastPointerY = 0;
  let canvasViewportRef: HTMLDivElement | undefined;
  let canvasGridRef: HTMLCanvasElement | undefined;

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

    return !target.closest("a,button,input,textarea,select,label,[draggable='true'],[data-board-card='true']");
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
    setRepositoryItems([]);
    setRepositoryItemsError(null);
    setIsRepositoryItemsLoading(false);
    setManualColumnByItemId({});
    setVisibleCardCountByColumn(createDefaultVisibleCardCountByColumn());
    setDraggingItemId(null);
    setDragOverColumn(null);
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

    const manuallyAssignedColumns = manualColumnByItemId();
    for (const item of repositoryItems()) {
      const column = manuallyAssignedColumns[item.id] ?? inferDefaultColumn(item);
      grouped[column].push(item);
    }

    return grouped;
  });

  const loadRepositoryItems = async (repositoryFullName: string) => {
    const requestId = ++repositoryItemsRequestId;
    setIsRepositoryItemsLoading(true);
    setRepositoryItemsError(null);
    setManualColumnByItemId({});
    setVisibleCardCountByColumn(createDefaultVisibleCardCountByColumn());

    try {
      const items = await githubListRepositoryItems(repositoryFullName);
      if (requestId !== repositoryItemsRequestId) {
        return;
      }

      setRepositoryItems(
        [...items].sort((left, right) => parseTimestamp(right.updatedAt) - parseTimestamp(left.updatedAt)),
      );
    } catch (error) {
      if (requestId !== repositoryItemsRequestId) {
        return;
      }

      setRepositoryItems([]);
      setRepositoryItemsError(formatInvokeError(error, "Unable to load board items from GitHub."));
    } finally {
      if (requestId === repositoryItemsRequestId) {
        setIsRepositoryItemsLoading(false);
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

  const resolveDraggedItemId = (event: DragEvent) => {
    const activeDraggingItemId = draggingItemId();
    if (activeDraggingItemId !== null) {
      return activeDraggingItemId;
    }

    const serializedItemId = event.dataTransfer?.getData("text/plain");
    if (!serializedItemId) {
      return null;
    }

    const parsedItemId = Number.parseInt(serializedItemId, 10);
    if (!Number.isFinite(parsedItemId)) {
      return null;
    }

    return parsedItemId;
  };

  const handleCardDragStart = (event: DragEvent, itemId: number) => {
    setSelectedBoardItemId(itemId);
    setDraggingItemId(itemId);
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", String(itemId));
    }
  };

  const handleCardDragEnd = () => {
    setDraggingItemId(null);
    setDragOverColumn(null);
  };

  const closeIssuePanel = () => {
    setSelectedBoardItemId(null);
  };

  const handleColumnDragOver = (event: DragEvent, columnKey: KanbanColumnKey) => {
    if (resolveDraggedItemId(event) === null) {
      return;
    }

    event.preventDefault();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = "move";
    }

    if (dragOverColumn() !== columnKey) {
      setDragOverColumn(columnKey);
    }
  };

  const handleColumnDragLeave = (event: DragEvent, columnKey: KanbanColumnKey) => {
    const currentTarget = event.currentTarget;
    if (!(currentTarget instanceof HTMLElement)) {
      return;
    }

    const relatedTarget = event.relatedTarget;
    if (relatedTarget instanceof Node && currentTarget.contains(relatedTarget)) {
      return;
    }

    if (dragOverColumn() === columnKey) {
      setDragOverColumn(null);
    }
  };

  const handleColumnDrop = (event: DragEvent, columnKey: KanbanColumnKey) => {
    event.preventDefault();

    const itemId = resolveDraggedItemId(event);
    if (itemId === null) {
      return;
    }

    setManualColumnByItemId((currentColumns) => {
      if (currentColumns[itemId] === columnKey) {
        return currentColumns;
      }

      return {
        ...currentColumns,
        [itemId]: columnKey,
      };
    });

    setDraggingItemId(null);
    setDragOverColumn(null);
  };

  const loadMoreColumnCards = (columnKey: KanbanColumnKey) => {
    setVisibleCardCountByColumn((current) => ({
      ...current,
      [columnKey]: current[columnKey] + KANBAN_COLUMN_PAGE_SIZE,
    }));
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
  });

  onCleanup(() => {
    clearPollTimer();
    stopCanvasResetAnimation();
    if (canvasResizeObserver) {
      canvasResizeObserver.disconnect();
      canvasResizeObserver = null;
    }
  });

  return (
    <div
      class="relative flex h-full w-full overflow-hidden bg-surface-canvas text-text-strong"
      classList={{
        "is-issue-panel-open": selectedBoardItem() !== null,
      }}
    >
      <aside class="flex h-full w-[var(--sidebar-left-width)] shrink-0 flex-col border-r border-border-strong bg-surface-panel/95">
        <div class="min-h-0 flex-1 overflow-hidden p-4">
          <div class="flex h-full flex-col gap-3 overflow-y-auto pr-1">
            <Show when={repositoryListError()}>
              {(error) => (
                <p class="rounded-[calc(var(--radius-app-shell)-0.25rem)] border border-status-danger-border bg-status-danger-surface px-3 py-2 text-[11px] text-status-danger-ink" role="alert">
                  {error()}
                </p>
              )}
            </Show>
            <Show
              when={githubUser()}
              fallback={<p class="px-1 text-[11px] text-text-muted">Connect GitHub to see your repositories.</p>}
            >
              <Show
                when={!isRepositoryListLoading()}
                fallback={<p class="px-1 text-[11px] text-text-muted">Loading repositories...</p>}
              >
                <Show
                  when={repositories().length > 0}
                  fallback={<p class="px-1 text-[11px] text-text-muted">No repositories found.</p>}
                >
                  <For each={repositories()}>
                    {(repository) => (
                      <button
                        type="button"
                        class="group flex w-full items-center gap-3 rounded-[calc(var(--radius-app-shell)-0.25rem)] border border-transparent px-3 py-2 text-left transition-colors hover:border-border-strong/70 hover:bg-surface-elevated/45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-text-body/45"
                        classList={{
                          "border-border-strong bg-surface-elevated/65": selectedRepositoryId() === repository.id,
                        }}
                        title={repository.fullName}
                        onClick={() => setSelectedRepositoryId(repository.id)}
                      >
                        <svg
                          class="h-4 w-4 shrink-0 text-text-muted transition-colors group-hover:text-text-body"
                          viewBox="0 0 24 24"
                          fill="none"
                          aria-hidden="true"
                        >
                          <path
                            d="M5 4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h4v-5h6v5h4a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2H5Z"
                            stroke="currentColor"
                            stroke-width="1.8"
                            stroke-linejoin="round"
                          />
                          <path
                            d="M9 20v-5h6v5"
                            stroke="currentColor"
                            stroke-width="1.8"
                            stroke-linecap="round"
                            stroke-linejoin="round"
                          />
                        </svg>
                        <p class="min-w-0 flex-1">
                          <span class="block truncate text-[12px] font-medium text-text-strong">{repository.name}</span>
                        </p>
                        <span
                          class="inline-flex shrink-0 rounded-full border px-2 py-0.5 text-[9px] font-semibold uppercase tracking-[0.08em]"
                          classList={{
                            "border-status-danger-border text-status-danger-ink": repository.isPrivate,
                            "border-border-strong text-text-muted": !repository.isPrivate,
                          }}
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

        <div class="border-t border-border-strong px-4 py-3">
          <Show when={authError()}>
            {(error) => (
              <p class="mb-3 rounded-[calc(var(--radius-app-shell)-0.25rem)] border border-status-danger-border bg-status-danger-surface px-3 py-2 text-[11px] text-status-danger-ink" role="alert">
                {error()}
              </p>
            )}
          </Show>

          <Show when={deviceFlow()}>
            {(flow) => (
              <div class="mb-3 rounded-[calc(var(--radius-app-shell)-0.25rem)] border border-border-strong bg-surface-canvas/45 p-3">
                <p class="text-[10px] font-semibold uppercase tracking-[0.08em] text-text-muted">Confirm on GitHub</p>
                <button
                  type="button"
                  class="mt-2 w-full rounded-[calc(var(--radius-app-shell)-0.35rem)] border border-border-strong bg-surface-panel/80 px-3 py-1.5 text-[11px] text-text-body transition-colors hover:bg-surface-elevated/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-text-body/45"
                  onClick={() => void openVerificationPage()}
                >
                  Open verification page
                </button>
                <button
                  type="button"
                  class="mt-2 flex w-full items-center justify-between rounded-[calc(var(--radius-app-shell)-0.35rem)] border border-border-strong bg-surface-canvas/80 px-3 py-1.5 text-[11px] font-medium tracking-[0.08em] text-text-strong transition-colors hover:bg-surface-elevated/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-text-body/45"
                  onClick={() => void copyUserCode()}
                >
                  <span>{flow().userCode}</span>
                  <span class="text-text-muted">{isCodeCopied() ? "Copied" : "Copy"}</span>
                </button>
                <p class="mt-2 text-[10px] text-text-muted">
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
                class="w-full rounded-[calc(var(--radius-app-shell)-0.25rem)] border border-border-strong bg-surface-elevated/75 px-3 py-2 text-[11px] font-medium text-text-strong transition-colors hover:bg-surface-elevated focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-text-body/45 disabled:cursor-not-allowed disabled:opacity-55"
                onClick={() => void connectGithub()}
                disabled={isAuthChecking() || isAuthStarting()}
              >
                {isAuthStarting() ? "Connecting..." : "Connect GitHub"}
              </button>
            }
          >
            {(user) => (
              <div class="flex items-center gap-2.5">
                <img
                  class="h-8 w-8 rounded-full border border-border-strong object-cover"
                  src={user().avatarUrl}
                  alt={`${user().login} profile`}
                  loading="lazy"
                />
                <a
                  class="min-w-0 flex-1 truncate text-[11px] font-medium text-text-body transition-colors hover:text-text-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-text-body/45"
                  href={user().htmlUrl}
                  target="_blank"
                  rel="noreferrer"
                  title={user().login}
                >
                  {user().login}
                </a>
                <button
                  type="button"
                  class="grid h-8 w-8 place-items-center rounded-[calc(var(--radius-app-shell)-0.35rem)] border border-border-strong bg-surface-canvas/60 text-text-muted transition-colors hover:bg-surface-elevated/70 hover:text-text-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-text-body/45 disabled:cursor-not-allowed disabled:opacity-55"
                  onClick={() => void signOutGithub()}
                  aria-label="Sign out of GitHub"
                  title="Sign out"
                  disabled={isSigningOut()}
                >
                  <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                    <path
                      d="M14 7V4a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2v-3"
                      stroke="currentColor"
                      stroke-width="1.8"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                    />
                    <path d="M10 12h10" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
                    <path
                      d="m17 8 4 4-4 4"
                      stroke="currentColor"
                      stroke-width="1.8"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                    />
                  </svg>
                </button>
              </div>
            )}
          </Show>
        </div>
      </aside>

      <section class="relative flex min-w-0 flex-1 flex-col overflow-hidden bg-surface-canvas">
        <header class="flex h-[calc(var(--drag-region-height)+0.375rem)] items-end justify-between border-b border-border-strong px-4 pb-2">
          <h2 class="truncate text-[13px] font-semibold text-text-strong">
            {selectedRepository()?.fullName ?? "GitHub repositories"}
          </h2>
          <button
            type="button"
            class="grid h-8 w-8 place-items-center rounded-[calc(var(--radius-app-shell)-0.35rem)] border border-border-strong bg-surface-panel/80 text-text-muted transition-colors hover:bg-surface-elevated/75 hover:text-text-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-text-body/45"
            aria-label="Reset canvas view"
            title="Reset canvas view"
            onClick={resetCanvasView}
          >
            <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M12 4v4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
              <path d="M12 16v4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
              <path d="M4 12h4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
              <path d="M16 12h4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
              <circle cx="12" cy="12" r="3.5" stroke="currentColor" stroke-width="1.8" />
            </svg>
          </button>
        </header>

        <div
          ref={(element) => {
            canvasViewportRef = element;
          }}
          class="relative min-h-0 flex-1 overflow-hidden [touch-action:none]"
          classList={{
            "cursor-grabbing": isCanvasPanning(),
            "cursor-grab": !isCanvasPanning(),
          }}
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
            class="pointer-events-none absolute inset-0 h-full w-full"
            aria-label="Interactive canvas background"
            role="img"
          />
          <div class="absolute inset-0 overflow-hidden">
            <div class="relative h-full w-full [transform-origin:0_0] will-change-transform" style={boardCameraStyle()}>
              <Show
                when={selectedRepository()}
                fallback={
                  <p class="mx-[var(--content-overlay-inset)] mt-[var(--content-overlay-top-inset)] rounded-[calc(var(--radius-app-shell)-0.2rem)] border border-border-strong bg-surface-panel/85 px-4 py-3 text-[12px] text-text-muted shadow-sm">
                    Select a repository to open its board.
                  </p>
                }
              >
                <Show
                  when={!isRepositoryItemsLoading()}
                  fallback={
                    <p class="mx-[var(--content-overlay-inset)] mt-[var(--content-overlay-top-inset)] rounded-[calc(var(--radius-app-shell)-0.2rem)] border border-border-strong bg-surface-panel/85 px-4 py-3 text-[12px] text-text-muted shadow-sm">
                      Loading board items...
                    </p>
                  }
                >
                  <Show
                    when={!repositoryItemsError()}
                    fallback={
                      <p class="mx-[var(--content-overlay-inset)] mt-[var(--content-overlay-top-inset)] rounded-[calc(var(--radius-app-shell)-0.2rem)] border border-status-danger-border bg-status-danger-surface px-4 py-3 text-[12px] text-status-danger-ink shadow-sm" role="alert">
                        {repositoryItemsError() ?? "Unable to load board items."}
                      </p>
                    }
                  >
                    <div
                      class="flex min-h-full min-w-max items-start gap-4 pr-[var(--content-overlay-inset)] pb-[var(--content-overlay-inset)] pl-[var(--content-overlay-inset)] pt-[var(--content-overlay-top-inset)]"
                      role="list"
                      aria-label="Repository work board"
                    >
                      <For each={KANBAN_COLUMNS}>
                        {(column) => {
                          const columnItems = () => groupedItemsByColumn()[column.key];
                          const visibleColumnItems = () =>
                            columnItems().slice(0, visibleCardCountByColumn()[column.key]);
                          const hasMoreColumnItems = () =>
                            columnItems().length > visibleCardCountByColumn()[column.key];

                          return (
                            <section
                              class="flex w-[18.5rem] shrink-0 flex-col gap-3 rounded-[var(--radius-app-shell)] border border-border-strong bg-surface-panel/88 p-3 backdrop-blur-[1px] transition-colors"
                              classList={{
                                "border-text-body/60 bg-surface-elevated/82 ring-2 ring-text-body/40":
                                  dragOverColumn() === column.key,
                              }}
                              role="listitem"
                              aria-label={`${column.title} column`}
                              onDragOver={(event) => handleColumnDragOver(event, column.key)}
                              onDragLeave={(event) => handleColumnDragLeave(event, column.key)}
                              onDrop={(event) => handleColumnDrop(event, column.key)}
                            >
                              <header class="flex items-start justify-between gap-3 border-b border-border-strong/75 pb-2">
                                <div>
                                  <p class="text-[12px] font-semibold text-text-strong">{column.title}</p>
                                  <p class="mt-0.5 text-[10px] uppercase tracking-[0.08em] text-text-muted">
                                    {column.description}
                                  </p>
                                </div>
                                <span class="inline-flex h-6 min-w-6 items-center justify-center rounded-full border border-border-strong bg-surface-canvas/65 px-2 text-[10px] font-semibold text-text-body">
                                  {columnItems().length}
                                </span>
                              </header>
                              <div class="flex flex-1 flex-col gap-2">
                                <Show
                                  when={columnItems().length > 0}
                                  fallback={<p class="py-4 text-center text-[11px] text-text-muted">No items</p>}
                                >
                                  <For each={visibleColumnItems()}>
                                    {(item) => (
                                      <article
                                        class="group flex cursor-pointer flex-col gap-2 rounded-[calc(var(--radius-app-shell)-0.2rem)] border border-border-strong bg-surface-canvas/75 p-3 transition-[border-color,background-color,transform,opacity] hover:border-text-body/45 hover:bg-surface-elevated/65"
                                        classList={{
                                          "opacity-50": draggingItemId() === item.id,
                                          "border-text-body/65 bg-surface-elevated/82 ring-1 ring-text-body/45":
                                            selectedBoardItemId() === item.id,
                                        }}
                                        data-board-card="true"
                                        draggable
                                        onPointerDown={(event) => {
                                          if (event.button === 0) {
                                            setSelectedBoardItemId(item.id);
                                          }
                                        }}
                                        onClick={() => setSelectedBoardItemId(item.id)}
                                        onDragStart={(event) => handleCardDragStart(event, item.id)}
                                        onDragEnd={handleCardDragEnd}
                                      >
                                        <div class="flex items-center justify-between gap-2">
                                          <span
                                            class="inline-flex rounded-full border px-2 py-0.5 text-[9px] font-semibold uppercase tracking-[0.08em]"
                                            classList={{
                                              "border-text-body/55 text-text-body": item.isPullRequest,
                                              "border-border-strong text-text-muted": !item.isPullRequest,
                                            }}
                                          >
                                            {item.isPullRequest ? "Pull request" : "Issue"}
                                          </span>
                                          <span class="text-[10px] font-medium text-text-muted">#{item.number}</span>
                                        </div>

                                        <p class="line-clamp-3 text-[12px] font-medium leading-relaxed text-text-strong">
                                          {item.title}
                                        </p>

                                        <p class="flex flex-wrap items-center gap-x-2 gap-y-1 text-[10px] text-text-muted">
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
                                    class="mt-1 rounded-[calc(var(--radius-app-shell)-0.3rem)] border border-border-strong bg-surface-canvas/65 px-3 py-1.5 text-[11px] font-medium text-text-body transition-colors hover:bg-surface-elevated/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-text-body/45"
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
        </div>

      </section>

      <Show when={selectedBoardItem()}>
        <button
          type="button"
          class="absolute inset-0 z-20 bg-surface-canvas/55 lg:hidden"
          aria-label="Close issue details overlay"
          onClick={closeIssuePanel}
        />
      </Show>

      <aside
        class="absolute inset-y-0 right-0 z-30 flex max-w-full flex-col bg-surface-panel/98 transition-[transform,width,opacity,border-color] ease-out lg:relative lg:inset-y-auto lg:right-auto lg:z-0 lg:translate-x-0"
        classList={{
          "w-[min(100%,var(--sidebar-right-width))] translate-x-0 border-l border-border-strong opacity-100 shadow-2xl lg:w-[var(--sidebar-right-width)] lg:shadow-none":
            selectedBoardItem() !== null,
          "w-[min(100%,var(--sidebar-right-width))] translate-x-full border-l border-transparent opacity-0 pointer-events-none lg:w-0 lg:translate-x-0 lg:opacity-100 lg:shadow-none":
            selectedBoardItem() === null,
        }}
        style={{
          "transition-duration": "var(--sidebar-panel-transition)",
        }}
        aria-label="Selected issue details"
        aria-hidden={!selectedBoardItem()}
      >
        <Show when={selectedBoardItem()} keyed>
          {(item) => {
            return (
              <>
                <header class="flex items-start justify-between gap-3 border-b border-border-strong px-4 py-3">
                  <div class="min-w-0">
                    <p class="text-[10px] font-semibold uppercase tracking-[0.08em] text-text-muted">
                      {item.isPullRequest ? "Pull request" : "Issue"} #{item.number}
                    </p>
                    <h3 class="mt-1 line-clamp-3 text-[13px] font-semibold leading-snug text-text-strong">{item.title}</h3>
                  </div>
                  <button
                    type="button"
                    class="grid h-8 w-8 shrink-0 place-items-center rounded-[calc(var(--radius-app-shell)-0.35rem)] border border-border-strong bg-surface-canvas/55 text-text-muted transition-colors hover:bg-surface-elevated/70 hover:text-text-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-text-body/45"
                    aria-label="Close issue details"
                    title="Close details"
                    onClick={closeIssuePanel}
                  >
                    <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                      <path d="M6 6 18 18" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
                      <path d="M18 6 6 18" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
                    </svg>
                  </button>
                </header>

                <div class="min-h-0 flex flex-1 flex-col overflow-y-auto px-4 py-3">
                  <section class="flex-1">
                    <p class="text-[10px] font-semibold uppercase tracking-[0.08em] text-text-muted">Issue text</p>
                    <Show
                      when={item.body && item.body.trim().length > 0}
                      fallback={
                        <p class="mt-2 rounded-[calc(var(--radius-app-shell)-0.25rem)] border border-border-strong bg-surface-canvas/50 px-3 py-2 text-[11px] text-text-muted">
                          No issue text provided.
                        </p>
                      }
                    >
                      <div class="mt-2 space-y-3 text-[12px] leading-relaxed text-text-body">
                        <For each={parseIssueBody(item.body ?? "")}>
                          {(block) => {
                            if (block.kind === "code") {
                              return (
                                <pre class="overflow-x-auto rounded-[calc(var(--radius-app-shell)-0.2rem)] border border-border-strong bg-surface-canvas/72 p-3">
                                  <Show when={block.language}>
                                    <span class="mb-2 inline-flex rounded-[0.375rem] border border-border-strong bg-surface-panel/75 px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.08em] text-text-muted">
                                      {block.language}
                                    </span>
                                  </Show>
                                  <code
                                    class="hljs block whitespace-pre text-[11px] leading-relaxed text-text-strong"
                                    innerHTML={highlightIssueCode(block.code, block.language)}
                                  />
                                </pre>
                              );
                            }

                            return (
                              <p class="text-[12px] leading-relaxed text-text-body">
                                <For each={parseIssueInlineTokens(block.text)}>
                                  {(token) => {
                                    if (token.kind === "inlineCode") {
                                      return (
                                        <code class="rounded-[0.25rem] border border-border-strong bg-surface-canvas/65 px-1 py-0.5 text-[11px] text-text-strong">
                                          {token.value}
                                        </code>
                                      );
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

                  <div class="mt-4 border-t border-border-strong pt-3">
                    <a
                      class="inline-flex items-center gap-2 rounded-[calc(var(--radius-app-shell)-0.3rem)] border border-border-strong bg-surface-canvas/60 px-3 py-1.5 text-[11px] font-medium text-text-body transition-colors hover:bg-surface-elevated/70 hover:text-text-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-text-body/45"
                      href={item.htmlUrl}
                      target="_blank"
                      rel="noreferrer"
                      onClick={(event) => {
                        event.preventDefault();
                        void openGithubItemPage(item.htmlUrl);
                      }}
                    >
                      <svg class="h-4 w-4 fill-current" viewBox="0 0 24 24" aria-hidden="true">
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
