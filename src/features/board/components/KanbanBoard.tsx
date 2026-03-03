import { For, Show, type Accessor, type JSX } from "solid-js";
import type { GithubRepositoryItem } from "../../../lib/commands";
import { KANBAN_COLUMNS, type DragGhostState, type KanbanColumnKey, type VisibleCardCountByColumn } from "../types";

interface KanbanBoardProps {
  repositoryName: string | null;
  boardCameraStyle: Accessor<JSX.CSSProperties>;
  isCanvasPanning: Accessor<boolean>;
  isCardDragging: Accessor<boolean>;
  setCanvasViewportRef: (element: HTMLDivElement) => void;
  setCanvasGridRef: (element: HTMLCanvasElement) => void;
  onResetCanvasView: () => void;
  onCanvasPointerDown: (event: PointerEvent) => void;
  onCanvasPointerMove: (event: PointerEvent) => void;
  onCanvasPointerUp: (event: PointerEvent) => void;
  onCanvasPointerCancel: (event: PointerEvent) => void;
  onCanvasWheel: (event: WheelEvent) => void;
  onCanvasDoubleClick: (event: MouseEvent) => void;
  repositoryItemsError: Accessor<string | null>;
  isRepositoryItemsLoading: Accessor<boolean>;
  groupedItemsByColumn: Accessor<Record<KanbanColumnKey, GithubRepositoryItem[]>>;
  visibleCardCountByColumn: Accessor<VisibleCardCountByColumn>;
  dragOverColumn: Accessor<KanbanColumnKey | null>;
  draggingItemId: Accessor<number | null>;
  selectedBoardItemId: Accessor<number | null>;
  dragGhost: Accessor<DragGhostState | null>;
  onCardPointerDown: (event: PointerEvent, item: GithubRepositoryItem) => void;
  onSelectBoardItem: (itemId: number) => void;
  onLoadMoreColumnCards: (columnKey: KanbanColumnKey) => void;
}

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

export function KanbanBoard(props: KanbanBoardProps) {
  return (
    <section class="content">
      <header class="content-heading">
        <h2>{props.repositoryName ?? "GitHub repositories"}</h2>
        <button
          type="button"
          class="content-board-refresh-btn"
          aria-label="Reset canvas view"
          title="Reset canvas view"
          onClick={props.onResetCanvasView}
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
        ref={props.setCanvasViewportRef}
        class={`content-canvas-viewport${props.isCanvasPanning() ? " is-panning" : ""}${props.isCardDragging() ? " is-card-dragging" : ""}`}
        onPointerDown={props.onCanvasPointerDown}
        onPointerMove={props.onCanvasPointerMove}
        onPointerUp={props.onCanvasPointerUp}
        onPointerCancel={props.onCanvasPointerCancel}
        onWheel={props.onCanvasWheel}
        onDblClick={props.onCanvasDoubleClick}
      >
        <canvas
          ref={props.setCanvasGridRef}
          class="content-canvas-grid"
          aria-label="Interactive canvas background"
          role="img"
        />
        <div class="content-canvas-layer">
          <div class="content-canvas-world" style={props.boardCameraStyle()}>
            <Show when={props.repositoryName} fallback={<p class="kanban-state">Select a repository to open its board.</p>}>
              <Show when={!props.isRepositoryItemsLoading()} fallback={<p class="kanban-state">Loading board items...</p>}>
                <Show
                  when={!props.repositoryItemsError()}
                  fallback={
                    <p class="kanban-state kanban-state-error" role="alert">
                      {props.repositoryItemsError() ?? "Unable to load board items."}
                    </p>
                  }
                >
                  <div class="kanban-board" role="list" aria-label="Repository work board">
                    <For each={KANBAN_COLUMNS}>
                      {(column) => {
                        const columnItems = () => props.groupedItemsByColumn()[column.key];
                        const visibleColumnItems = () => columnItems().slice(0, props.visibleCardCountByColumn()[column.key]);
                        const hasMoreColumnItems = () => columnItems().length > props.visibleCardCountByColumn()[column.key];

                        return (
                          <section
                            class={`kanban-column${props.dragOverColumn() === column.key ? " is-drop-target" : ""}`}
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
                                      class={`kanban-card${props.draggingItemId() === item.id ? " is-dragging" : ""}${props.selectedBoardItemId() === item.id ? " is-selected" : ""}`}
                                      onPointerDown={(event) => props.onCardPointerDown(event, item)}
                                      onClick={() => props.onSelectBoardItem(item.id)}
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
                                  onClick={() => props.onLoadMoreColumnCards(column.key)}
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
        <Show when={props.dragGhost()}>
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
  );
}
