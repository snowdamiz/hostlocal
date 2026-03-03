---
phase: 04-deterministic-run-state-engine
plan: 03
subsystem: ui
tags: [tauri, solidjs, runtime-state, kanban]
requires:
  - phase: 04-deterministic-run-state-engine
    provides: Deterministic runtime snapshots, history reads, and stage-change event payloads
provides:
  - Runtime snapshot/history hydration and event sync in board interaction state
  - Runtime-aware deterministic column inference rules for board grouping
  - Card/details runtime stage, queue, terminal metadata, and newest-first history rendering
affects: [board, intake-policy-copy, runtime-visibility]
tech-stack:
  added: []
  patterns: [snapshot-plus-event runtime state merge, runtime-first column inference overlay]
key-files:
  created: []
  modified:
    - src/lib/commands.ts
    - src/features/board/hooks/useBoardInteractions.ts
    - src/features/board/hooks/useBoardInteractions.test.ts
    - src/features/board/column-inference.ts
    - src/features/board/column-inference.test.ts
    - src/features/board/components/KanbanBoard.tsx
    - src/features/board/components/IssueDetailsPanel.tsx
    - src/components/MainLayout.tsx
    - src/intake/policy-reasons.ts
    - src/intake/policy-reasons.test.ts
key-decisions:
  - "Use repository-scoped snapshot hydration plus runtime/run-stage-changed event deltas as the canonical UI runtime metadata source."
  - "Apply runtime terminal/non-terminal precedence before GitHub fallback inference so column placement matches deterministic orchestration rules."
patterns-established:
  - "Hook Runtime Projection: Board hook owns runtime snapshot/history maps and exposes selected issue runtime accessors for surface rendering."
  - "Recovery Reason Surface Contract: Terminal reasonCode/fixHint copy resolves through intake policy mapping for consistent user messaging."
requirements-completed: [ORCH-01, ORCH-02]
duration: 10 min
completed: 2026-03-03
---

# Phase 04 Plan 03: Deterministic Runtime UI Surfaces Summary

**Board cards and issue details now expose deterministic runtime lifecycle state (stage/queue/terminal/history) from persisted snapshot + event metadata.**

## Performance

- **Duration:** 10 min
- **Started:** 2026-03-03T06:45:26Z
- **Completed:** 2026-03-03T06:55:43Z
- **Tasks:** 3
- **Files modified:** 10

## Accomplishments
- Added typed frontend contracts for runtime snapshot/history reads and runtime stage-change payloads.
- Extended board interaction state with startup snapshot hydration, runtime event subscription/cleanup, and issue-level history hydration.
- Shipped runtime-aware column mapping plus UI rendering for canonical stage, queue position, terminal metadata, and newest-first runtime history.

## Task Commits

Each task was committed atomically:

1. **Task 1: Add typed runtime snapshot/history contracts and hook hydration + event sync**
   - `9624c10` (`test`): failing RED tests for snapshot mapping, event delta merge, and unlisten cleanup
   - `c0e6134` (`feat`): runtime command contracts + hook hydration/event lifecycle implementation
2. **Task 2: Apply runtime-aware deterministic column mapping rules with tests**
   - `be22916` (`test`): failing RED tests for runtime stage/terminal inference precedence
   - `ca52f1f` (`feat`): runtime-first column inference and hook grouping overlay wiring
3. **Task 3: Render stage badges, queue position, terminal metadata, and newest-first history in board/details surfaces**
   - `e9b85ba` (`test`): failing RED tests for recovery process-loss reason-code coverage
   - `49b9874` (`feat`): card/details runtime UI rendering and recovery reason copy support

## Files Created/Modified
- `src/lib/commands.ts` - Added typed runtime snapshot/history/event payload contracts and invoke wrappers.
- `src/features/board/hooks/useBoardInteractions.ts` - Added runtime metadata hydration, event sync, repository scoping, and selected issue history loading.
- `src/features/board/hooks/useBoardInteractions.test.ts` - Added runtime snapshot/event lifecycle tests for deterministic metadata sync behavior.
- `src/features/board/column-inference.ts` - Added runtime stage/terminal precedence rules for deterministic board column mapping.
- `src/features/board/column-inference.test.ts` - Added table-driven runtime precedence tests.
- `src/features/board/components/KanbanBoard.tsx` - Added card-level runtime stage, queue position, and terminal status badges.
- `src/features/board/components/IssueDetailsPanel.tsx` - Added current runtime section and newest-first runtime history rendering with reasonCode/fixHint details.
- `src/components/MainLayout.tsx` - Wired runtime metadata accessors from board hook into board/details surfaces.
- `src/intake/policy-reasons.ts` - Added `runtime_recovery_process_lost` reason copy.
- `src/intake/policy-reasons.test.ts` - Added recovery reason mapping tests.

## Decisions Made
- Runtime metadata rendering is driven from hook-level snapshot + event state, not direct per-component command calls, to keep board/detail surfaces consistent.
- Runtime terminal statuses (`success|failed|cancelled|guardrail_blocked`) override GitHub fallback inference for deterministic column placement.
- Recovery process-loss outcomes resolve through the existing policy reason system to preserve structured `reasonCode` + `fixHint` semantics.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Cleared transient git index lock during Task 1 RED commit**
- **Found during:** Task 1 commit (`test(04-03): add failing tests for runtime metadata sync`)
- **Issue:** `git commit` failed with `Unable to create '.git/index.lock': File exists`.
- **Fix:** Verified no active commit process owned the lock and retried the commit once the stale lock cleared.
- **Files modified:** None
- **Verification:** Commit retry succeeded and produced hash `9624c10`.
- **Committed in:** `9624c10` (task commit)

---

**Total deviations:** 1 auto-fixed (1 blocking issue)
**Impact on plan:** No scope change; resolved a transient tooling blocker and continued planned implementation.

## Issues Encountered
None.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
Phase 04 is complete (plans 01-03 all summarized). Runtime lifecycle state is now visible and deterministic in board/detail UI surfaces, ready for phase transition work.

## Self-Check: PASSED
- Verified SUMMARY and all key modified files exist on disk.
- Verified task commits `9624c10`, `c0e6134`, `be22916`, `ca52f1f`, `e9b85ba`, and `49b9874` exist in git history.

---
*Phase: 04-deterministic-run-state-engine*
*Completed: 2026-03-03*
