---
phase: 03-local-worker-runtime-boundary
plan: 02
subsystem: infra
tags: [rust, tauri, sidecar, workspace, guardrails]
requires:
  - phase: 03-local-worker-runtime-boundary
    provides: "Deterministic enqueue/dequeue queue contracts and repository identity helpers from Plan 03-01."
provides:
  - "Local sidecar-only runtime start path with guarded workspace preparation and branch creation."
  - "Runtime guardrail outcomes that expose violated rule + target type without leaking raw command/path values."
  - "Shared terminal finalizer that records minimal evidence, cleans workspace, and promotes queued runs FIFO."
affects: [phase-03-plan-03, board-runtime-integration, runtime-observability]
tech-stack:
  added: [tauri-plugin-shell, tempfile]
  patterns:
    [
      "TempDir-backed ephemeral workspace clone + deterministic branch creation before worker spawn",
      "Redacted runtime guardrail reason_code/fix_hint outcomes encoded as runtime_guardrail_<rule>_<target>",
      "Centralized finalization path for evidence persistence, cleanup, and queue handoff",
    ]
key-files:
  created: [src-tauri/binaries/hostlocal-worker-aarch64-apple-darwin]
  modified:
    [
      src-tauri/Cargo.toml,
      src-tauri/Cargo.lock,
      src-tauri/src/lib.rs,
      src-tauri/capabilities/default.json,
      src-tauri/tauri.conf.json,
      src-tauri/src/runtime_boundary.rs,
    ]
key-decisions:
  - "Use one stable sidecar alias (`hostlocal-worker`) across capability scopes, runtime spawn, and externalBin contract metadata."
  - "Persist only lightweight terminal evidence in system temp outside ephemeral workspace to preserve traceability while deleting run workspace contents."
patterns-established:
  - "Runtime startup is backend-authoritative: queue start triggers workspace prep + sidecar spawn in Rust, never via frontend command strings."
  - "Finalization is terminal-state centric: write evidence, attempt cleanup, clear/promote queue, then immediately attempt next queued run."
requirements-completed: [RUN-01, RUN-02, RUN-03, SEC-02]
duration: 7m
completed: 2026-03-03
---

# Phase 03 Plan 02: Local Worker Runtime Boundary Summary

**HostLocal now launches accepted runs through a guarded local sidecar flow with per-run temp workspaces, deterministic issue branches, and centralized terminal cleanup/evidence handling.**

## Performance

- **Duration:** 7m
- **Started:** 2026-03-03T04:49:39Z
- **Completed:** 2026-03-03T04:56:47Z
- **Tasks:** 3
- **Files modified:** 7

## Accomplishments
- Added sidecar runtime dependencies/config wiring (`tauri-plugin-shell`, `tempfile`, shell plugin init, capability execute/spawn scope, externalBin alias contract).
- Implemented guarded run worker startup in `runtime_boundary.rs`: per-run temp workspace, fresh clone, deterministic issue branch, workspace-boundary checks, and sidecar-only execution path.
- Centralized terminal finalization for run evidence persistence, deterministic workspace cleanup, and FIFO queued-run promotion.

## Task Commits

Each task was committed atomically:

1. **Task 1: Add sidecar runtime dependencies and explicit capability scope wiring**
   - `5621b1d` (chore)
2. **Task 2: Implement guarded workspace preparation and sidecar execution path**
   - `16c503c` (test)
   - `a6f1e9f` (feat)
3. **Task 3: Centralize terminal finalization for cleanup, queue handoff, and lightweight run evidence**
   - `cb0f4ae` (test)
   - `9eca51d` (feat)

_Note: TDD tasks include test (RED) and feature (GREEN) commits._

## Files Created/Modified
- `src-tauri/Cargo.toml` - Added runtime shell/temp dependencies.
- `src-tauri/Cargo.lock` - Locked added runtime dependencies.
- `src-tauri/src/lib.rs` - Registered `tauri_plugin_shell` during app bootstrap.
- `src-tauri/capabilities/default.json` - Added explicit shell execute/spawn permission scope for `hostlocal-worker`.
- `src-tauri/tauri.conf.json` - Added `externalBin` contract metadata for `hostlocal-worker`.
- `src-tauri/binaries/hostlocal-worker-aarch64-apple-darwin` - Added required local sidecar placeholder artifact path.
- `src-tauri/src/runtime_boundary.rs` - Added guarded runtime worker startup, terminal finalization, evidence persistence, and expanded runtime tests.

## Decisions Made
- Kept guardrail messaging redacted by encoding rule + target type (`runtime_guardrail_<rule>_<target>`) and avoiding raw command/path details.
- Used a shared finalization pathway to keep cleanup/evidence/queue handoff behavior deterministic across terminal outcomes.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] `externalBin` compile-time artifact path missing**
- **Found during:** Task 1
- **Issue:** `cargo check` failed after adding `externalBin` because required sidecar artifact path did not exist (`binaries/hostlocal-worker-aarch64-apple-darwin`).
- **Fix:** Added executable placeholder sidecar artifact at the required path to satisfy Tauri compile-time resource contract.
- **Files modified:** `src-tauri/binaries/hostlocal-worker-aarch64-apple-darwin`
- **Verification:** `cd src-tauri && cargo check`
- **Committed in:** `5621b1d` (Task 1 commit)

---

**Total deviations:** 1 auto-fixed (1 blocking)
**Impact on plan:** Required to unblock planned sidecar config wiring; no scope creep outside runtime boundary implementation.

## Issues Encountered
- Initial Task 1 verification failed due missing sidecar `externalBin` artifact path; resolved inline via Rule 3 blocker fix and verification rerun.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness
- Runtime boundary now enforces local sidecar startup, workspace isolation, explicit guardrail outcomes, and deterministic finalization.
- Plan 03-03 can integrate frontend runtime enqueue/dequeue behavior against concrete `started|queued|blocked|startup_failed` outcomes.

## Self-Check: PASSED
- Summary file exists: `.planning/phases/03-local-worker-runtime-boundary/03-02-SUMMARY.md`
- Commit hashes verified: `5621b1d`, `16c503c`, `a6f1e9f`, `cb0f4ae`, `9eca51d`
