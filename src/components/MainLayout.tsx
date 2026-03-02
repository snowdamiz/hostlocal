import { For, Show, createSignal, onCleanup, onMount } from "solid-js";
import {
  githubAuthLogout,
  githubAuthPoll,
  githubAuthStart,
  githubAuthStatus,
  githubListRepositories,
  githubOpenVerificationUrl,
  type GithubDeviceAuthStart,
  type GithubRepository,
  type GithubUser,
} from "../lib/commands";

const CANVAS_DEFAULT_PAN_X = 0;
const CANVAS_DEFAULT_PAN_Y = 0;
const CANVAS_DEFAULT_ZOOM = 1;
const CANVAS_GRID_UNIT = 24;
const CANVAS_MIN_ZOOM = 0.35;
const CANVAS_MAX_ZOOM = 2.6;
const CANVAS_RESET_DURATION_MS = 320;

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
  const [isChatOpen, setIsChatOpen] = createSignal(false);
  const [isCanvasPanning, setIsCanvasPanning] = createSignal(false);

  let pollTimeoutId: number | null = null;
  let canvasResizeObserver: ResizeObserver | null = null;
  let activeCanvasPointerId: number | null = null;
  let resetAnimationFrameId: number | null = null;
  let lastPointerX = 0;
  let lastPointerY = 0;
  let canvasViewportRef: HTMLDivElement | undefined;
  let canvasGridRef: HTMLCanvasElement | undefined;

  const canvasTransform = {
    panX: CANVAS_DEFAULT_PAN_X,
    panY: CANVAS_DEFAULT_PAN_Y,
    zoom: CANVAS_DEFAULT_ZOOM,
  };

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

    const width = canvasGridRef.width / (window.devicePixelRatio || 1);
    const height = canvasGridRef.height / (window.devicePixelRatio || 1);

    context.save();
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, canvasGridRef.width, canvasGridRef.height);
    context.restore();
    context.setTransform(window.devicePixelRatio || 1, 0, 0, window.devicePixelRatio || 1, 0, 0);

    const gridColor = getCanvasTokenColor("--content-canvas-grid-line", "--app-grid-line");
    const originX = width / 2 + canvasTransform.panX;
    const originY = height / 2 + canvasTransform.panY;
    const gridSpacing = CANVAS_GRID_UNIT * canvasTransform.zoom;

    if (gridSpacing >= 8) {
      context.strokeStyle = gridColor;
      context.lineWidth = 1;
      drawGridLines(context, width, height, gridSpacing, originX, originY);
    }
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

    const startPanX = canvasTransform.panX;
    const startPanY = canvasTransform.panY;
    const startZoom = canvasTransform.zoom;
    const startedAt = performance.now();

    const animateFrame = (timestamp: number) => {
      const progress = Math.min(1, (timestamp - startedAt) / CANVAS_RESET_DURATION_MS);
      const easedProgress = 1 - (1 - progress) ** 3;

      canvasTransform.panX = startPanX + (CANVAS_DEFAULT_PAN_X - startPanX) * easedProgress;
      canvasTransform.panY = startPanY + (CANVAS_DEFAULT_PAN_Y - startPanY) * easedProgress;
      canvasTransform.zoom = startZoom + (CANVAS_DEFAULT_ZOOM - startZoom) * easedProgress;
      drawCanvas();

      if (progress < 1) {
        resetAnimationFrameId = window.requestAnimationFrame(animateFrame);
        return;
      }

      resetAnimationFrameId = null;
      canvasTransform.panX = CANVAS_DEFAULT_PAN_X;
      canvasTransform.panY = CANVAS_DEFAULT_PAN_Y;
      canvasTransform.zoom = CANVAS_DEFAULT_ZOOM;
      drawCanvas();
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

    canvasTransform.panX += deltaX;
    canvasTransform.panY += deltaY;
    drawCanvas();
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
    const zoomFactor = Math.exp(-event.deltaY * 0.0015);
    const nextZoom = clamp(canvasTransform.zoom * zoomFactor, CANVAS_MIN_ZOOM, CANVAS_MAX_ZOOM);

    if (Math.abs(nextZoom - canvasTransform.zoom) < 0.0001) {
      event.preventDefault();
      return;
    }

    const centerX = rect.width / 2;
    const centerY = rect.height / 2;
    const worldX = (pointX - centerX - canvasTransform.panX) / canvasTransform.zoom;
    const worldY = (pointY - centerY - canvasTransform.panY) / canvasTransform.zoom;

    canvasTransform.zoom = nextZoom;
    canvasTransform.panX = pointX - centerX - worldX * nextZoom;
    canvasTransform.panY = pointY - centerY - worldY * nextZoom;
    drawCanvas();
    event.preventDefault();
  };

  const clearRepositoryState = () => {
    setRepositories([]);
    setSelectedRepositoryId(null);
    setRepositoryListError(null);
    setIsRepositoryListLoading(false);
  };

  const selectedRepository = () => {
    const repositoryId = selectedRepositoryId();
    if (repositoryId === null) {
      return null;
    }

    return repositories().find((repository) => repository.id === repositoryId) ?? null;
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
    <div class="layout">
      <aside class="sidebar-left">
        <div class="sidebar-repositories-panel">
          <p class="sidebar-section-title">Repositories</p>
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
                      <a
                        class={`sidebar-repository-item${selectedRepositoryId() === repository.id ? " is-selected" : ""}`}
                        href={repository.htmlUrl}
                        target="_blank"
                        rel="noreferrer"
                        title={repository.fullName}
                        onClick={() => setSelectedRepositoryId(repository.id)}
                      >
                        <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
                          <path d="M5 4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h4v-5h6v5h4a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2H5Z" />
                          <path d="M9 20v-5h6v5" />
                        </svg>
                        <p class="sidebar-repository-label">
                          <span class="sidebar-repository-name">{repository.name}</span>
                          <span class="sidebar-repository-full-name">{repository.fullName}</span>
                        </p>
                        <span
                          class={`sidebar-repository-visibility${repository.isPrivate ? " is-private" : ""}`}
                        >
                          {repository.isPrivate ? "Private" : "Public"}
                        </span>
                      </a>
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
            class="content-canvas-reset-btn"
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
          class={`content-canvas-viewport${isCanvasPanning() ? " is-panning" : ""}`}
          onPointerDown={beginCanvasPan}
          onPointerMove={moveCanvasPan}
          onPointerUp={endCanvasPan}
          onPointerCancel={endCanvasPan}
          onWheel={zoomCanvas}
        >
          <canvas
            ref={(element) => {
              canvasGridRef = element;
            }}
            class="content-canvas-grid"
            aria-label="Interactive canvas background"
            role="img"
          />
        </div>
        <Show when={isChatOpen()}>
          <>
            <button
              type="button"
              class="content-chat-backdrop"
              aria-label="Close chat"
              onClick={() => setIsChatOpen(false)}
            />
            <section id="chat-panel" class="content-chat-panel" aria-label="Chat panel">
              <form class="content-chat-composer" onSubmit={(event) => event.preventDefault()}>
                <label class="content-chat-composer-label" for="chat-message-input">
                  Message
                </label>
                <input
                  id="chat-message-input"
                  class="content-chat-composer-input"
                  type="text"
                  placeholder="Type a message..."
                  autocomplete="off"
                />
                <button type="submit" class="content-chat-composer-send" aria-label="Send message" title="Send">
                  <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
                    <path d="M3 11.5 20.5 4.5 13.5 22l-2.25-7.75L3 11.5Z" />
                    <path d="m11.25 14.25 9.25-9.75" />
                  </svg>
                </button>
              </form>
            </section>
          </>
        </Show>
        <Show when={!isChatOpen()}>
          <button
            type="button"
            class="app-chat-fab"
            aria-label="Open chat"
            title="Open chat"
            aria-expanded={isChatOpen()}
            aria-controls="chat-panel"
            onClick={() => setIsChatOpen(true)}
          >
            <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M8 10h8" />
              <path d="M8 14h5" />
              <path d="M21 11.5a8.5 8.5 0 0 1-8.5 8.5c-1.3 0-2.52-.3-3.62-.8L3 21l1.9-5.2a8.45 8.45 0 0 1-.9-3.8A8.5 8.5 0 1 1 21 11.5Z" />
            </svg>
          </button>
        </Show>
      </section>
    </div>
  );
}
