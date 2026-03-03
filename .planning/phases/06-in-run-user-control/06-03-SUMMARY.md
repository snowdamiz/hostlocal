---
phase: 06-in-run-user-control
plan: 03
subsystem: ui
tags: [solidjs, tauri-commands, runtime-control, policy-reasons]
requires:
  - phase: 06-in-run-user-control
    provides: Backend runtime control commands/outcomes plus runtime control toast infrastructure from plans 06-01 and 06-02.
provides:
  - Typed frontend wrappers/contracts for pause/resume/abort/steer runtime controls.
  - Board-hook runtime control orchestration with state-aware eligibility and pending serialization.
  - Control-specific policy reason copy mapping for panel and toast reasonCode/fixHint surfaces.
affects: [06-04, issue-details-panel, runtime-control-ui]
tech-stack:
  added: []
  patterns:
    - TDD task slicing with dedicated RED/GREEN commits per control-plane step.
    - Selected-issue runtime control orchestration via shared action executor with scoped hydration and toast acknowledgement.
key-files:
  created:
    - src/lib/commands.test.ts
  modified:
    - src/lib/commands.ts
    - src/features/board/hooks/useBoardInteractions.ts
    - src/features/board/hooks/useBoardInteractions.test.ts
    - src/intake/policy-reasons.ts
    - src/intake/policy-reasons.test.ts
key-decisions:
  - Frontend command contracts now mirror backend RuntimeRunControlOutcome and paused metadata fields directly.
  - Runtime control orchestration is centralized in hook helpers so UI actions can reuse identical gating, refresh, and toast semantics.
  - Runtime control reason codes are resolved through the intake policy reason map to keep panel/toast messaging consistent.
patterns-established:
  - Control callbacks are selected-issue scoped and no-op when repository/item/runtime context is missing.
  - Rejected control outcomes preserve backend reasonCode/fixHint for downstream UI reason surfaces.
requirements-completed: [CTRL-01, CTRL-02, CTRL-03, CTRL-04]
duration: 6m 38s
completed: 2026-03-03
---

# Phase 6 Plan 3: Frontend Runtime Control Contracts and Hook Orchestration Summary

**Typed frontend runtime control contracts now drive selected-issue pause/resume/abort/steer orchestration with deterministic eligibility, pending guards, refresh hydration, and reason-aware acknowledgement feedback.**

## Performance

- **Duration:** 6m 38s
- **Started:** 2026-03-03T18:13:46Z
- **Completed:** 2026-03-03T18:20:24Z
- **Tasks:** 3
- **Files modified:** 6

## Accomplishments

- Added typed runtime control request/outcome interfaces and invoke wrappers for `runtime_pause_issue_run`, `runtime_resume_issue_run`, `runtime_abort_issue_run`, and `runtime_steer_issue_run`.
- Extended runtime snapshot/history/stage payload contracts with `isPaused` and `pausedAt` metadata for board/panel gating and paused-state rendering.
- Implemented hook-level runtime control helpers for selected issue scope with eligibility derivation, pending serialization, scoped re-hydration, and runtime-control toast acknowledgements.
- Expanded policy reason mapping and tests for runtime control reason codes so abort/cancel and control rejection metadata resolve into actionable UI copy.

## Task Commits

Each task was committed atomically:

1. **Task 1: Extend command contracts for control commands and paused-state payload fields**
   - `6065b83` (`test`) RED: failing runtime control wrapper tests
   - `a72fc62` (`feat`) GREEN: command contracts, wrappers, and paused payload typing
2. **Task 2: Add selected-issue control orchestration and pending state to board hook**
   - `ca8970e` (`test`) RED: failing control helper coverage
   - `9165d4b` (`feat`) GREEN: hook orchestration, eligibility, pending, hydration, and toasts
3. **Task 3: Expand reason-code copy mapping for control outcomes and sync tests**
   - `230795c` (`test`) RED: failing control reason-copy and rejection-path tests
   - `2c920e5` (`feat`) GREEN: control reason-code copy mapping and runtime-user-abort guidance

## Files Created/Modified

- `src/lib/commands.ts` - Runtime control contracts/wrappers and paused-state payload typing.
- `src/lib/commands.test.ts` - Wrapper RED/GREEN coverage for pause/resume/abort/steer invoke wiring.
- `src/features/board/hooks/useBoardInteractions.ts` - Selected-issue control eligibility/pending orchestration and shared control executor.
- `src/features/board/hooks/useBoardInteractions.test.ts` - Control helper tests for eligibility, pending guard, refresh, and toast semantics.
- `src/intake/policy-reasons.ts` - Control reason-code copy entries including runtime abort metadata.
- `src/intake/policy-reasons.test.ts` - Mapping completeness and runtime_user_abort resolution assertions.

## Decisions Made

- Mirrored backend control reason codes in frontend mapping instead of introducing frontend-specific aliases.
- Used one shared `executeRuntimeControlAction` helper for all control actions to avoid divergent refresh/toast behavior between pause/resume/abort/steer.
- Kept control pending serialization at hook level so repeated submissions are blocked before command invocation.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Restored parseable STATE.md control fields for gsd-tools automation**
- **Found during:** Post-task state updates (`state advance-plan`, `state update-progress`, `state record-session`)
- **Issue:** Existing STATE formatting used non-bold field labels, so gsd-tools could not parse `Current Plan`, `Total Plans in Phase`, `Progress`, or session continuity fields.
- **Fix:** Converted Current Position and Session Continuity labels to the parseable `**Field:**` format, then re-ran progress/session updates.
- **Files modified:** `.planning/STATE.md`
- **Verification:** `state update-progress` and `state record-session` returned success after the format correction.
- **Committed in:** pending docs metadata commit

---

**Total deviations:** 1 auto-fixed (1 blocking)
**Impact on plan:** Deviation was documentation/state synchronization only and did not alter runtime control feature scope.

## Issues Encountered

None.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- `06-04` can consume the hook’s `onPauseRun`/`onResumeRun`/`onAbortRun`/`onSteerRun` callbacks and `selectedRuntimeControlAvailability` state directly in `IssueDetailsPanel`.
- Runtime control reason copy coverage is in place for panel metadata and control toast rejection messaging.

---
*Phase: 06-in-run-user-control*
*Completed: 2026-03-03*

## Self-Check: PASSED

- FOUND: .planning/phases/06-in-run-user-control/06-03-SUMMARY.md
- FOUND: 6065b83
- FOUND: a72fc62
- FOUND: ca8970e
- FOUND: 9165d4b
- FOUND: 230795c
- FOUND: 2c920e5
