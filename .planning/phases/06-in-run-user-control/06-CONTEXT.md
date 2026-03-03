# Phase 6: In-Run User Control - Context

**Gathered:** 2026-03-03
**Status:** Ready for planning

<domain>
## Phase Boundary

Phase 6 adds in-run user intervention for active runs: pause, resume, abort, and steering instructions. This phase does not add new execution capabilities outside control actions.

</domain>

<decisions>
## Implementation Decisions

### Control Entry Points
- Primary control surface is the right IssueDetailsPanel.
- Controls are state-aware: render when runtime metadata exists, enable only valid actions for current run state.
- Use an inline action row near "Current Runtime Stage" for pause/resume/abort, with steering input below.
- Controls target the currently selected issue only (no direct multi-target card actions).

### Pause and Resume Behavior
- Paused runs stay in In Progress and show an explicit paused indicator in board/panel stage UI.
- Pause/resume is allowed for active runs only; queued runs keep existing queue semantics.
- Resume is manual only.
- Pause and resume must acknowledge via telemetry event + stage badge update + toast.

### Abort Behavior
- Abort requires an explicit confirmation modal.
- Abort is enabled for active and paused runs; queued runs continue using queue removal semantics.
- Post-abort state is terminal `cancelled`, with board returning issue to Todo while history/panel retain cancelled metadata.
- Abort acknowledgement must include telemetry event + visible reason/fix hint + toast.

### Steering Interaction
- Steering uses a freeform text composer in IssueDetailsPanel.
- Sending is explicit (button/Enter) one instruction at a time, with pending-disable behavior while request is in flight.
- Steering acknowledgement is shown via telemetry entry and toast.
- Steering is allowed only for active runs.

### Claude's Discretion
- Exact action copy, iconography, and control ordering within the inline action row.
- Exact toast wording and duration.
- Minor UI spacing and micro-interaction details.

</decisions>

<code_context>
## Existing Code Insights

### Reusable Assets
- `src/features/board/components/IssueDetailsPanel.tsx`: existing runtime stage, telemetry, summary, and history sections provide the natural control surface.
- `src/features/board/hooks/useBoardInteractions.ts`: central place for runtime command calls, hydration, event subscriptions, and selected-issue state.
- `src/lib/commands.ts`: typed command facade for adding control command contracts.
- `src-tauri/src/runtime_boundary.rs`: canonical run lifecycle, queue state, stage transitions, telemetry emission, and safe finalization/cleanup behavior.

### Established Patterns
- Frontend uses typed Tauri command wrappers in `src/lib/commands.ts` and keeps side effects in feature hooks.
- Runtime UI state is driven by `runtime/run-stage-changed` and `runtime/run-telemetry` events.
- Board column placement is derived from runtime metadata in `src/features/board/column-inference.ts` (terminal cancelled/failure map to Todo; active stages map to In Progress).
- Terminal outcomes and cleanup are finalized through `finalize_run` in backend runtime boundary.

### Integration Points
- Add new runtime control commands in `src-tauri/src/runtime_boundary.rs` and register them in `src-tauri/src/lib.rs`.
- Expose typed frontend wrappers in `src/lib/commands.ts`.
- Execute controls and acknowledgement handling in `src/features/board/hooks/useBoardInteractions.ts`.
- Render control UI and action states in `src/features/board/components/IssueDetailsPanel.tsx`.
- Extend runtime metadata/state mapping where needed in `src/features/board/column-inference.ts` and related tests.

</code_context>

<specifics>
## Specific Ideas

- Keep control actions close to runtime context (stage + telemetry) to reduce accidental actions.
- Prioritize explicit acknowledgement in both telemetry and lightweight toasts for every control action.
- Preserve deterministic queue semantics for queued runs; avoid overloading pause/resume with dequeue-like behavior.

</specifics>

<deferred>
## Deferred Ideas

- Global board-level control bars or multi-issue batch controls.
- Queued-run pause semantics distinct from queue removal.
- Preset steering templates or macro instruction libraries.

</deferred>

---

*Phase: 06-in-run-user-control*
*Context gathered: 2026-03-03*
