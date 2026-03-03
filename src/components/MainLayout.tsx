import { For, Show, onMount } from "solid-js";
import { siGithub } from "simple-icons";
import { KANBAN_COLUMNS } from "../features/board/types";
import { useBoardCanvas } from "../features/board/hooks/useBoardCanvas";
import { useBoardInteractions } from "../features/board/hooks/useBoardInteractions";
import { highlightIssueCode, parseIssueBody, parseIssueInlineTokens } from "../features/issue-content/issue-body";
import { useGithubAuth } from "../features/auth/hooks/useGithubAuth";
import { GithubAuthPanel } from "../features/auth/components/GithubAuthPanel";
import { useRepositories } from "../features/repositories/hooks/useRepositories";
import { RepositorySidebar } from "../features/repositories/components/RepositorySidebar";

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

const formatIssueCountLabel = (assigneeCount: number) => {
  if (assigneeCount === 1) {
    return "1 assignee";
  }

  return `${assigneeCount} assignees`;
};

export function MainLayout() {
  const {
    githubUser,
    authError,
    isAuthChecking,
    isAuthStarting,
    isPollingAuth,
    isSigningOut,
    isCodeCopied,
    deviceFlow,
    refreshAuthState,
    connectGithub,
    copyUserCode,
    signOutGithub,
    openVerificationPage,
  } = useGithubAuth();
  const {
    repositories,
    repositoryListError,
    isRepositoryListLoading,
    selectedRepositoryId,
    setSelectedRepositoryId,
    selectedRepository,
  } = useRepositories(githubUser);
  const {
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
  } = useBoardInteractions(githubUser, selectedRepository);
  const {
    boardCameraStyle,
    isCanvasPanning,
    setCanvasViewportRef,
    setCanvasGridRef,
    resetCanvasView,
    beginCanvasPan,
    moveCanvasPan,
    endCanvasPan,
    zoomCanvas,
    handleCanvasDoubleClick,
  } = useBoardCanvas();

  onMount(() => {
    void refreshAuthState();
  });

  return (
    <div class={`layout${selectedBoardItem() ? " is-issue-panel-open" : ""}`}>
      <aside class="sidebar-left">
        <RepositorySidebar
          githubUser={githubUser}
          repositories={repositories}
          repositoryListError={repositoryListError}
          isRepositoryListLoading={isRepositoryListLoading}
          selectedRepositoryId={selectedRepositoryId}
          onSelectRepository={(repositoryId) => setSelectedRepositoryId(repositoryId)}
        />
        <GithubAuthPanel
          authError={authError}
          deviceFlow={deviceFlow}
          isPollingAuth={isPollingAuth}
          isCodeCopied={isCodeCopied}
          githubUser={githubUser}
          isAuthChecking={isAuthChecking}
          isAuthStarting={isAuthStarting}
          isSigningOut={isSigningOut}
          onOpenVerificationPage={openVerificationPage}
          onCopyUserCode={copyUserCode}
          onConnectGithub={connectGithub}
          onSignOutGithub={signOutGithub}
        />
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
          ref={setCanvasViewportRef}
          class={`content-canvas-viewport${isCanvasPanning() ? " is-panning" : ""}${isCardDragging() ? " is-card-dragging" : ""}`}
          onPointerDown={beginCanvasPan}
          onPointerMove={moveCanvasPan}
          onPointerUp={endCanvasPan}
          onPointerCancel={endCanvasPan}
          onWheel={zoomCanvas}
          onDblClick={handleCanvasDoubleClick}
        >
          <canvas
            ref={setCanvasGridRef}
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

                                        <p class="kanban-card-title">{item.title}</p>

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
