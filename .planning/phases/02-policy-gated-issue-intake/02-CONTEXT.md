# Phase 2: Policy-Gated Issue Intake - Context

**Gathered:** 2026-03-02
**Status:** Ready for planning

<domain>
## Phase Boundary

Start an agent run only when a user moves an issue from Todo to In Progress and it passes small-task policy checks. If policy fails, reject with a clear reason and do not start any background run side effects.

</domain>

<decisions>
## Implementation Decisions

### Policy Criteria
- Intake is label-gated.
- Label matching uses a prefix-family rule, not a single exact label.
- Even with a matching intake label prefix, intake is rejected unless the item is an open issue with non-empty body text.
- Conflict handling is fail-closed: if out-of-scope signals are present (for example large/epic style markers), intake is rejected.

### Trigger Semantics
- Intake fires only on completed drop into `In Progress` (never on drag-over).
- Only `Todo -> In Progress` moves can trigger intake.
- Duplicate starts are disallowed for the same issue while a prior intake outcome is unresolved.
- `In Progress` must be GitHub-backed, not local-only board state.
- Agent ownership is represented on GitHub via an `agent:*` label prefix.
- Default In Progress inclusion rule is: open issue + intake label + `agent:*` label.
- If required GitHub label persistence fails during move-to-In-Progress, intake is rejected and board state reverts (no run starts).

### Card Interaction Behavior
- Drag initiation should use a dedicated drag handle model (card click remains available for selection/details).
- Canvas interactions should prevent accidental text selection/highlighting during drag interactions.

### Rejection UX
- Rejections are surfaced through a global toast notification system.
- Toast content includes the violated rule plus an actionable fix hint.
- On rejection, the card reverts to Todo to preserve In Progress integrity.
- Repeated identical rejection attempts should collapse into a counter-based toast behavior instead of duplicating separate toasts.

### Claude's Discretion
- Exact intake label prefix naming.
- Exact deny-signal list for conflict rejection.
- Precise drag-handle affordance and drag threshold details.
- Toast timing/placement/animation and counter reset window.

</decisions>

<code_context>
## Existing Code Insights

### Reusable Assets
- `src/components/MainLayout.tsx`:
  - Existing drag/drop handlers (`handleCardDragStart`, `handleColumnDrop`) and column grouping.
  - Existing issue detail sidebar selection behavior that currently overlaps with drag intent.
  - Existing error display patterns that can complement toast usage.
- `src/lib/commands.ts`:
  - Typed command boundary for adding new intake and GitHub-write commands.
- `src-tauri/src/github_auth.rs`:
  - Current issue payload already includes `state`, `labels`, `assignees`, `is_pull_request`, `body`, and timestamps.

### Established Patterns
- Frontend state is signal-driven in `MainLayout` with local optimistic board overrides via `manualColumnByItemId`.
- Backend command model uses `invoke` wrappers + `#[tauri::command]` handlers returning `Result<_, String>`.
- Current GitHub integration is read-heavy (repo/item listing, auth); issue mutation commands are not yet present.

### Integration Points
- Intake trigger logic hooks into the existing drop path in `MainLayout` where moves are currently local-only.
- New GitHub mutation + policy-evaluation commands should be exposed via `src/lib/commands.ts` and registered in `src-tauri/src/lib.rs`.
- In Progress rendering logic should shift from local drag state to GitHub-backed label criteria to satisfy phase intent.

</code_context>

<specifics>
## Specific Ideas

- Known interaction regression: drag/drop behavior degraded after right sidebar selection behavior was introduced; selection and drag intent need clear separation.
- In Progress should reflect "actively worked by agents" from GitHub truth, not transient local UI moves.

</specifics>

<deferred>
## Deferred Ideas

None - discussion stayed within phase scope.

</deferred>

---

*Phase: 02-policy-gated-issue-intake*
*Context gathered: 2026-03-02*
