export type KanbanColumnKey = "todo" | "inProgress" | "inReview" | "done";

export interface KanbanColumnDefinition {
  key: KanbanColumnKey;
  title: string;
  description: string;
}

export const KANBAN_COLUMNS: ReadonlyArray<KanbanColumnDefinition> = [
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

export const isKanbanColumnKey = (value: string | null | undefined): value is KanbanColumnKey =>
  value === "todo" || value === "inProgress" || value === "inReview" || value === "done";

export interface BoardCanvasView {
  panX: number;
  panY: number;
  zoom: number;
}

export type DragGhostMode = "drag" | "snapback";

export interface DragGhostState {
  itemId: number;
  issueNumber: number;
  title: string;
  isPullRequest: boolean;
  x: number;
  y: number;
  mode: DragGhostMode;
}

export interface PointerDragContext {
  itemId: number;
  issueNumber: number;
  title: string;
  isPullRequest: boolean;
  originCenterX: number;
  originCenterY: number;
  dropX: number;
  dropY: number;
}

export interface BoardDragSource {
  itemId: number;
  issueNumber: number;
  title: string;
  isPullRequest: boolean;
}

export type VisibleCardCountByColumn = Record<KanbanColumnKey, number>;
export type OptimisticColumnByItemId = Record<number, KanbanColumnKey>;

export type LoadMoreColumnCards = (columnKey: KanbanColumnKey) => void;
export type SelectBoardItem = (itemId: number | null) => void;
export type OpenGithubItemPage = (url: string) => Promise<void>;
