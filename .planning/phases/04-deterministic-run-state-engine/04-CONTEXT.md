# Phase 4: Deterministic Run State Engine - Context

**Gathered:** 2026-03-03
**Status:** Ready for planning

<domain>
## Phase Boundary

Run lifecycle stages must be deterministic, persisted, and crash-recoverable so users can observe canonical stage progression (`queued`, `preparing`, `coding`, `validating`, `publishing`) and inspect durable terminal outcomes after restarts.

</domain>

<decisions>
## Implementation Decisions

### Stage Visibility and In-Run Presentation
- Show run stage in both places: Kanban card metadata and the existing issue details panel.
- Present canonical stage names directly (`queued`, `preparing`, `coding`, `validating`, `publishing`).
- Keep all non-terminal run stages in the `In Progress` column; do not auto-move columns by internal stage.
- For queued runs, show explicit queue position badge (not just a generic queued indicator).

### Restart and Crash Reconciliation
- Reconcile persisted run state immediately at app startup.
- Persist and recover both active run and full per-repository FIFO queue.
- On restart, auto-reconcile and continue deterministic progression when recoverable.
- If an in-flight run cannot be reattached after restart, finalize it as `failed` with an explicit recovery reason.

### Terminal Outcome Semantics
- Keep explicit terminal statuses: `success`, `failed`, `cancelled`, `guardrail_blocked`.
- Recovery process-loss cases map to `failed` with dedicated reason metadata (not a separate terminal status).
- Column mapping on terminal transition: `success -> In Review`; `failed/cancelled/guardrail_blocked -> Todo`.
- User-facing terminal feedback must keep structured `reasonCode` + `fixHint` style messaging.
- Durable terminal status should be inspectable from both card metadata and issue details panel.

### Durable History Scope
- Persist stage-transition timeline with timestamps plus terminal status/reason metadata.
- Retain last 20 runs per issue for inspection.
- Persist metadata only in Phase 4 (no raw stdout/stderr log payloads).
- Show history newest-first in UI inspection surfaces.

### Claude's Discretion
- Exact visual treatment of stage/queue/terminal badges and details-panel layout.
- Exact copy phrasing for recovery-failure messaging as long as `reasonCode` + `fixHint` semantics stay intact.
- Exact pruning mechanics used to enforce last-20 history retention.

</decisions>

<specifics>
## Specific Ideas

No external product references were requested.
Priority is deterministic, restart-safe run behavior with minimal sensitive-data exposure in persisted evidence.

</specifics>

<code_context>
## Existing Code Insights

### Reusable Assets
- `src-tauri/src/runtime_boundary.rs`:
  - Existing per-repository queue model (`active_run` + FIFO `queued_runs`).
  - Existing terminal finalization flow and minimal terminal evidence write path.
- `src/features/board/hooks/useBoardInteractions.ts`:
  - Existing runtime enqueue/dequeue integration seam and rejection handling pipeline.
- `src/features/board/components/KanbanBoard.tsx` and `src/features/board/components/IssueDetailsPanel.tsx`:
  - Existing card metadata and details-panel surfaces where stage/terminal inspection can be added.
- `src/intake/policy-reasons.ts` + toast pipeline:
  - Existing structured `reasonCode`/`fixHint` copy model for user-facing runtime outcomes.
- `src-tauri/src/db.rs` + `src-tauri/src/commands.rs`:
  - Existing SQLite initialization and command patterns suitable for durable run-state/history records.

### Established Patterns
- Frontend/backend contracts are command-driven through typed `invoke` wrappers and `#[tauri::command]` handlers.
- Runtime outcomes already use explicit status + reason payloads.
- One-active-per-repo with FIFO queue behavior is already established from Phase 3.
- Existing runtime evidence is external to ephemeral workspace cleanup, matching durable-terminal direction.

### Integration Points
- Extend runtime boundary commands/state to persist canonical stage transitions and reconciliation state.
- Add startup reconciliation wiring from app initialization path so restore behavior is immediate on launch.
- Extend command contracts consumed by board/details surfaces for stage + terminal metadata rendering.
- Extend policy-reason mapping for restart-recovery failure reason codes shown to users.

</code_context>

<deferred>
## Deferred Ideas

None - discussion stayed within phase scope.

</deferred>

---

*Phase: 04-deterministic-run-state-engine*
*Context gathered: 2026-03-03*
