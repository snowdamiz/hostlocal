---
phase: 05-live-telemetry-and-safe-summaries
plan: 02
subsystem: api
tags: [tauri, rust, rusqlite, telemetry, summary, redaction]
requires:
  - phase: 05-01
    provides: "Sanitized runtime_run_events persistence and runtime/run-telemetry emission."
provides:
  - "Issue-scoped telemetry hydration command with newest-first replay and optional runId/limit."
  - "Issue-scoped terminal summary projection with completion, key actions, and validation fallbacks."
  - "Read-time redaction guard that prevents legacy unsanitized event rows from leaking to payloads."
affects: [observability, runtime-boundary, issue-details-sidebar]
tech-stack:
  added: []
  patterns:
    - "Runtime read models projected from runtime_runs + runtime_run_events."
    - "Validation outcomes always explicit via not-run/not-found fallback policy."
    - "Defense-in-depth redaction applied during read payload shaping."
key-files:
  created: []
  modified:
    - src-tauri/src/runtime_boundary.rs
    - src-tauri/src/commands.rs
    - src-tauri/src/lib.rs
key-decisions:
  - "Telemetry hydration resolves the latest issue run by default, with optional explicit runId override."
  - "Summary validation outcomes derive from validation telemetry and fall back explicitly when signals are absent."
  - "Telemetry and summary reads re-sanitize messages to protect against legacy unsanitized rows."
patterns-established:
  - "Issue-centric runtime read contract: repositoryFullName + issueNumber, optional runId."
  - "Summary key actions project only include_in_summary telemetry rows."
requirements-completed: [OBS-01, OBS-02, SEC-01]
duration: 9min
completed: 2026-03-03
---

# Phase 05 Plan 02: Telemetry Read Contracts Summary

**Issue-scoped telemetry replay and terminal summary command surfaces now project sanitized runtime evidence with explicit validation fallback states.**

## Performance

- **Duration:** 9 min
- **Started:** 2026-03-03T08:24:56Z
- **Completed:** 2026-03-03T08:33:29Z
- **Tasks:** 3
- **Files modified:** 3

## Accomplishments

- Added `runtime_get_issue_run_telemetry` request/response contracts and command wiring for selected-issue hydration.
- Added `runtime_get_issue_run_summary` projection with completion status, concise key actions, and explicit validation outcomes.
- Added regression coverage for newest-first telemetry limits and secret-safe summary/telemetry payload guarantees (including legacy-row defense).

## Task Commits

1. **Task 1: Add telemetry read contracts for selected-issue hydration** - `fb33f4b` (test), `2779aa6` (feat)
2. **Task 2: Project terminal run summaries from canonical runtime state plus telemetry milestones** - `ddef0c1` (test), `3de0364` (feat)
3. **Task 3: Add regression tests for ordering, fallback validation states, and secret-safe payload guarantees** - `26d7518` (test), `1580bb4` (fix)

## Files Created/Modified

- `src-tauri/src/runtime_boundary.rs` - Added telemetry/summary contracts, projection helpers, fallback derivation, and read-time sanitization.
- `src-tauri/src/commands.rs` - Exposed new Tauri command handlers for telemetry and summary retrieval.
- `src-tauri/src/lib.rs` - Registered telemetry and summary handlers in invoke dispatch.

## Decisions Made

- Latest issue run is resolved by default for telemetry/summary reads; callers can pin an explicit `runId` when needed.
- Validation outcomes are always emitted explicitly and never null/missing (`not-run` or `not-found` when signals are absent).
- Read payload shaping re-applies redaction to guard against legacy unsanitized event rows in the database.

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- Backend telemetry and summary contracts are ready for sidebar hydration/render integration.
- Runtime read payloads now maintain secret-safe guarantees even if legacy rows bypassed earlier write-time redaction.

## Self-Check: PASSED

- Verified summary file exists: `.planning/phases/05-live-telemetry-and-safe-summaries/05-02-SUMMARY.md`
- Verified task commits exist: `fb33f4b`, `2779aa6`, `ddef0c1`, `3de0364`, `26d7518`, `1580bb4`

---
*Phase: 05-live-telemetry-and-safe-summaries*
*Completed: 2026-03-03*
