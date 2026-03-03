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
    <section class="relative min-h-0 min-w-0 overflow-hidden">
      <header class="pointer-events-none absolute left-[var(--content-overlay-inset)] top-[var(--content-overlay-top-inset)] right-[var(--content-overlay-inset)] z-[110] flex items-center justify-between gap-3">
        <h2 class="pointer-events-none m-0 min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-[14px] font-semibold tracking-[-0.01em] text-[var(--text-primary)]">
          {props.repositoryName ?? "GitHub repositories"}
        </h2>
        <button
          type="button"
          class="pointer-events-auto mr-[-3px] mt-[3px] grid h-8 w-8 shrink-0 place-items-center rounded-[9px] border border-[var(--surface-border)] bg-[var(--surface)] text-[var(--text-primary)] transition-[background-color,border-color,transform] duration-150 hover:bg-[var(--surface-light)] active:scale-95 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--surface-light)] disabled:cursor-not-allowed disabled:opacity-55"
          aria-label="Reset canvas view"
          title="Reset canvas view"
          onClick={props.onResetCanvasView}
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            aria-hidden="true"
            class="h-4 w-4 stroke-current [stroke-linecap:round] [stroke-linejoin:round] [stroke-width:1.7]"
          >
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
        class="absolute inset-0 overflow-hidden bg-[var(--app-bg)] touch-none"
        classList={{
          "cursor-grab": !props.isCanvasPanning(),
          "cursor-grabbing": props.isCanvasPanning(),
          "select-none": props.isCanvasPanning() || props.isCardDragging(),
        }}
        onPointerDown={props.onCanvasPointerDown}
        onPointerMove={props.onCanvasPointerMove}
        onPointerUp={props.onCanvasPointerUp}
        onPointerCancel={props.onCanvasPointerCancel}
        onWheel={props.onCanvasWheel}
        onDblClick={props.onCanvasDoubleClick}
      >
        <canvas
          ref={props.setCanvasGridRef}
          class="pointer-events-none absolute inset-0 block h-full w-full"
          aria-label="Interactive canvas background"
          role="img"
        />
        <div class="absolute inset-0 overflow-hidden">
          <div class="absolute left-0 top-0 h-[calc(100%-68px)] min-h-[520px] origin-top-left will-change-transform" style={props.boardCameraStyle()}>
            <Show
              when={props.repositoryName}
              fallback={
                <p class="m-0 grid min-h-[220px] w-[420px] place-items-center rounded-[12px] border border-dashed border-[var(--surface-border)] bg-[var(--surface)] text-[12.5px] text-[var(--text-secondary)]">
                  Select a repository to open its board.
                </p>
              }
            >
              <Show
                when={!props.isRepositoryItemsLoading()}
                fallback={
                  <p class="m-0 grid min-h-[220px] w-[420px] place-items-center rounded-[12px] border border-dashed border-[var(--surface-border)] bg-[var(--surface)] text-[12.5px] text-[var(--text-secondary)]">
                    Loading board items...
                  </p>
                }
              >
                <Show
                  when={!props.repositoryItemsError()}
                  fallback={
                    <p
                      class="m-0 grid min-h-[220px] w-[420px] place-items-center rounded-[12px] border border-[var(--error-border)] bg-[var(--error-bg)] text-[12.5px] text-[var(--error-text)]"
                      role="alert"
                    >
                      {props.repositoryItemsError() ?? "Unable to load board items."}
                    </p>
                  }
                >
                  <div class="flex min-h-[520px] w-max items-start gap-[10px]" role="list" aria-label="Repository work board">
                    <For each={KANBAN_COLUMNS}>
                      {(column) => {
                        const columnItems = () => props.groupedItemsByColumn()[column.key];
                        const visibleColumnItems = () => columnItems().slice(0, props.visibleCardCountByColumn()[column.key]);
                        const hasMoreColumnItems = () => columnItems().length > props.visibleCardCountByColumn()[column.key];

                        return (
                          <section
                            class="flex min-h-[520px] w-[320px] shrink-0 flex-col rounded-[12px] border border-[var(--surface-border)] bg-[var(--surface)] transition-[border-color,box-shadow,background-color] duration-150"
                            classList={{
                              "border-[var(--surface-light)]": props.dragOverColumn() === column.key,
                              "bg-[var(--surface-dark)]": props.dragOverColumn() === column.key,
                              "shadow-[inset_0_0_0_1px_var(--surface-light)]": props.dragOverColumn() === column.key,
                            }}
                            data-column-key={column.key}
                            role="listitem"
                            aria-label={`${column.title} column`}
                          >
                            <header class="flex items-start justify-between gap-2 border-b border-[var(--surface-border)] p-[10px]">
                              <div>
                                <p class="m-0 text-[12.5px] font-bold text-[var(--text-primary)]">{column.title}</p>
                                <p class="m-0 mt-[2px] text-[11px] text-[var(--text-muted)]">{column.description}</p>
                              </div>
                              <span class="inline-flex min-w-6 items-center justify-center rounded-full border border-[var(--surface-border)] px-[6px] py-1 text-[11px] font-semibold leading-none text-[var(--text-secondary)]">
                                {columnItems().length}
                              </span>
                            </header>
                            <div class="flex flex-1 flex-col gap-2 p-[10px]">
                              <Show
                                when={columnItems().length > 0}
                                fallback={
                                  <p class="m-0 grid min-h-[72px] place-items-center rounded-[10px] border border-dashed border-[var(--surface-border)] text-[12px] text-[var(--text-muted)]">
                                    No items
                                  </p>
                                }
                              >
                                <For each={visibleColumnItems()}>
                                  {(item) => (
                                    <article
                                      class="kanban-card m-0 flex cursor-grab flex-col gap-2 rounded-[10px] border border-[var(--surface-border)] bg-[var(--surface-dark)] p-[10px] text-[var(--text-primary)] transition-[transform,box-shadow,border-color,background-color,opacity] duration-170 hover:border-[var(--surface-light)] hover:shadow-[0_6px_16px_var(--app-grid-line)] active:cursor-grabbing"
                                      classList={{
                                        "border-[var(--surface-light)]":
                                          props.draggingItemId() === item.id || props.selectedBoardItemId() === item.id,
                                        "opacity-[0.05]": props.draggingItemId() === item.id,
                                        "translate-x-[10px]": props.draggingItemId() === item.id,
                                        "translate-y-[-16px]": props.draggingItemId() === item.id,
                                        "scale-[0.94]": props.draggingItemId() === item.id,
                                      }}
                                      onPointerDown={(event) => props.onCardPointerDown(event, item)}
                                      onClick={() => props.onSelectBoardItem(item.id)}
                                    >
                                      <div class="flex items-center justify-between gap-2">
                                        <div class="flex items-center gap-2">
                                          <span
                                            class="inline-flex rounded-full border border-[var(--surface-border)] px-[7px] py-[2px] text-[10.5px] font-semibold text-[var(--text-secondary)]"
                                            classList={{
                                              "border-[var(--surface-light)]": item.isPullRequest,
                                              "text-[var(--text-primary)]": item.isPullRequest,
                                            }}
                                          >
                                            {item.isPullRequest ? "Pull request" : "Issue"}
                                          </span>
                                          <span class="text-[11px] font-semibold text-[var(--text-muted)]">#{item.number}</span>
                                        </div>
                                        <span
                                          class="inline-flex h-[22px] w-[30px] cursor-grab items-center justify-center gap-[3px] rounded-full border border-[var(--intake-drag-handle-border)] bg-[var(--intake-drag-handle-bg)] transition-[border-color,background-color] duration-120 hover:border-[var(--intake-drag-handle-border-hover)] hover:bg-[var(--intake-drag-handle-bg-hover)] active:cursor-grabbing focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--surface-light)]"
                                          aria-hidden="true"
                                        >
                                          <span class="h-[3px] w-[3px] rounded-full bg-[var(--intake-drag-handle-dot)]" />
                                          <span class="h-[3px] w-[3px] rounded-full bg-[var(--intake-drag-handle-dot)]" />
                                          <span class="h-[3px] w-[3px] rounded-full bg-[var(--intake-drag-handle-dot)]" />
                                        </span>
                                      </div>

                                      <p class="m-0 text-[12.5px] font-semibold leading-[1.4] text-[var(--text-primary)] hover:text-[var(--text-secondary)]">
                                        {item.title}
                                      </p>

                                      <p class="m-0 flex flex-wrap gap-[6px] text-[11px] leading-[1.35] text-[var(--text-muted)]">
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
                                  class="w-full appearance-none rounded-[10px] border border-dashed border-[var(--surface-border)] bg-[var(--surface-dark)] px-[10px] py-2 text-[11.5px] font-semibold text-[var(--text-secondary)] transition-[border-color,color,background-color] duration-120 hover:border-[var(--surface-light)] hover:bg-[var(--app-bg)] hover:text-[var(--text-primary)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--surface-light)]"
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
              class="pointer-events-none fixed z-[260] w-[min(320px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 rounded-[11px] border border-[var(--kanban-drag-ghost-border)] bg-[var(--kanban-drag-ghost-bg)] p-[10px] opacity-[0.96] shadow-[0_14px_24px_var(--kanban-drag-ghost-shadow)] [animation:drag-ghost-lift_160ms_ease]"
              classList={{
                "opacity-90": ghost().mode === "snapback",
              }}
              style={{
                left: `${ghost().x}px`,
                top: `${ghost().y}px`,
              }}
              aria-hidden="true"
            >
              <div class="flex items-center justify-between gap-2">
                <div class="flex items-center gap-2">
                  <span
                    class="inline-flex rounded-full border border-[var(--surface-border)] px-[7px] py-[2px] text-[10.5px] font-semibold text-[var(--text-secondary)]"
                    classList={{
                      "border-[var(--surface-light)]": ghost().isPullRequest,
                      "text-[var(--text-primary)]": ghost().isPullRequest,
                    }}
                  >
                    {ghost().isPullRequest ? "Pull request" : "Issue"}
                  </span>
                  <span class="text-[11px] font-semibold text-[var(--text-muted)]">#{ghost().issueNumber}</span>
                </div>
                <span
                  class="inline-flex h-[22px] w-[30px] items-center justify-center gap-[3px] rounded-full border border-[var(--intake-drag-handle-border)] bg-[var(--intake-drag-handle-bg)]"
                  aria-hidden="true"
                >
                  <span class="h-[3px] w-[3px] rounded-full bg-[var(--intake-drag-handle-dot)]" />
                  <span class="h-[3px] w-[3px] rounded-full bg-[var(--intake-drag-handle-dot)]" />
                  <span class="h-[3px] w-[3px] rounded-full bg-[var(--intake-drag-handle-dot)]" />
                </span>
              </div>
              <p class="m-0 mt-2 text-[12.5px] font-semibold leading-[1.35] text-[var(--text-primary)]">{ghost().title}</p>
            </article>
          )}
        </Show>
      </div>
    </section>
  );
}
