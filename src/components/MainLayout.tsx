import { onMount } from "solid-js";
import { useGithubAuth } from "../features/auth/hooks/useGithubAuth";
import { GithubAuthPanel } from "../features/auth/components/GithubAuthPanel";
import { KanbanBoard } from "../features/board/components/KanbanBoard";
import { IssueDetailsPanel } from "../features/board/components/IssueDetailsPanel";
import { useBoardCanvas } from "../features/board/hooks/useBoardCanvas";
import { useBoardInteractions } from "../features/board/hooks/useBoardInteractions";
import { useRepositories } from "../features/repositories/hooks/useRepositories";
import { RepositorySidebar } from "../features/repositories/components/RepositorySidebar";

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

      <KanbanBoard
        repositoryName={selectedRepository()?.fullName ?? null}
        boardCameraStyle={boardCameraStyle}
        isCanvasPanning={isCanvasPanning}
        isCardDragging={isCardDragging}
        setCanvasViewportRef={setCanvasViewportRef}
        setCanvasGridRef={setCanvasGridRef}
        onResetCanvasView={resetCanvasView}
        onCanvasPointerDown={beginCanvasPan}
        onCanvasPointerMove={moveCanvasPan}
        onCanvasPointerUp={endCanvasPan}
        onCanvasPointerCancel={endCanvasPan}
        onCanvasWheel={zoomCanvas}
        onCanvasDoubleClick={handleCanvasDoubleClick}
        repositoryItemsError={repositoryItemsError}
        isRepositoryItemsLoading={isRepositoryItemsLoading}
        groupedItemsByColumn={groupedItemsByColumn}
        visibleCardCountByColumn={visibleCardCountByColumn}
        dragOverColumn={dragOverColumn}
        draggingItemId={draggingItemId}
        selectedBoardItemId={selectedBoardItemId}
        dragGhost={dragGhost}
        onCardPointerDown={handleCardPointerDown}
        onSelectBoardItem={setSelectedBoardItemId}
        onLoadMoreColumnCards={loadMoreColumnCards}
      />

      <IssueDetailsPanel
        selectedBoardItem={selectedBoardItem}
        onClose={closeIssuePanel}
        onOpenGithubItemPage={openGithubItemPage}
      />
    </div>
  );
}
