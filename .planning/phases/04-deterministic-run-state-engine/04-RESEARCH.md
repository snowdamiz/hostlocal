# Phase 4: Deterministic Run State Engine - Research

**Researched:** 2026-03-03
**Domain:** Deterministic run lifecycle orchestration (state machine + durable persistence + startup reconciliation)
**Confidence:** HIGH

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

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

### Deferred Ideas (OUT OF SCOPE)
None - discussion stayed within phase scope.
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| ORCH-01 | User can see deterministic run stages (`queued`, `preparing`, `coding`, `validating`, `publishing`, `done\|failed\|cancelled`). | Implement a persisted canonical state machine and expose it to the board/details UI via snapshot command + live event updates. Keep non-terminal stages in `In Progress`, and render explicit queue position for queued runs. |
| ORCH-02 | Run state is persisted so the app can recover/reconcile correctly after restart or crash. | Make SQLite the source of truth for active/queued/terminal runs and transition history; run startup reconciliation that finalizes unrecoverable in-flight runs and resumes FIFO progression for recoverable queued work. |
</phase_requirements>

## Summary

Phase 3 already has the right execution boundary (Rust-owned queue + sidecar + finalization), but state is currently ephemeral in a `Mutex<HashMap<...>>` and terminal evidence is written as standalone JSON under temp. That cannot satisfy ORCH-01/ORCH-02 because there is no durable canonical run state for UI rendering or restart reconciliation.

The most reliable planning direction is a DB-backed finite state machine with append-only transition history. Treat SQLite as the source of truth for run lifecycle and per-repository FIFO ordering, then rebuild/synchronize runtime scheduler state from DB at startup. This gives deterministic behavior across crashes, eliminates orphaned/duplicated runs, and provides a stable surface for card metadata + issue details history.

Use a hybrid UI delivery model: command-based snapshot hydration (for startup and refresh) plus Tauri events for near-real-time stage updates. Event-only delivery is insufficient because app restarts miss in-flight event streams; snapshot-only delivery is stale and not responsive enough for stage progression.

**Primary recommendation:** Implement a persisted run state machine (`queued -> preparing -> coding -> validating -> publishing -> terminal`) with transactional transitions, startup reconciliation, and UI snapshot+event delivery as one coherent boundary.

## Standard Stack

### Core

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `rusqlite` | `0.32` (project) | Persist run state, queue order, and transition history | Already in project; transaction APIs and behavior controls support deterministic state transitions. |
| SQLite WAL mode | existing (`PRAGMA journal_mode = WAL`) | Crash-tolerant persistence with good local concurrency | Already enabled in `initialize_schema`; WAL is persistent and supports concurrent reads with single-writer semantics. |
| `tauri` | `2.x` (project uses `@tauri-apps/api` 2.10.1 / `tauri` 2) | Command boundary + event emission to frontend | Existing architecture is command-driven; event APIs provide run-stage streaming. |
| `tauri-plugin-shell` | `2.x` | Sidecar lifecycle events (`Stdout`, `Stderr`, `Error`, `Terminated`) to drive terminal transitions | Already used in runtime boundary; event model is explicit and typed. |
| `serde` / `serde_json` | `1.x` | Serialize persisted transition payloads and command/event responses | Already in project and current run evidence path. |

### Supporting

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `@tauri-apps/api/event` | `2.10.1` | Frontend `listen` / `unlisten` for stage updates | Use in `useBoardInteractions` to keep runtime metadata current between snapshots. |
| Existing reason-copy model (`src/intake/policy-reasons.ts`) | current | Structured `reasonCode` + `fixHint` terminal messaging | Use for recovery/process-loss failures and other runtime terminal reasons. |
| Existing board/details components | current | Render stage badges, queue position, and history metadata | Reuse `KanbanBoard` card metadata and `IssueDetailsPanel` inspection surface. |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| SQLite source-of-truth state | JSON files per run in temp/app-data | Harder atomic updates, brittle queryability for queue/history/reconciliation. |
| Snapshot + events | Snapshot-only polling | Simpler, but weaker UX and slower stage visibility; still needs snapshot for restart anyway. |
| Persisted queue order column | Recompute queue from timestamps each query | Timestamp ties/clock behavior can cause nondeterministic ordering. Explicit monotonic queue order is safer. |

**Installation:**
```bash
# No new package is required for the recommended Phase 4 approach.
# Reuse existing dependencies in Cargo.toml and package.json.
```

## Architecture Patterns

### Recommended Project Structure

```text
src-tauri/src/
├── runtime_boundary.rs      # scheduler + stage transitions + sidecar lifecycle hooks
├── db.rs                    # schema extension for run state + history tables
├── commands.rs              # optional read commands for runtime snapshots/history
└── lib.rs                   # startup reconciliation wiring + command registration

src/lib/
└── commands.ts              # typed runtime read command wrappers + enriched outcomes

src/features/board/
├── hooks/useBoardInteractions.ts   # runtime snapshot hydration + event subscriptions
├── components/KanbanBoard.tsx      # stage + queue badges on cards
└── components/IssueDetailsPanel.tsx # terminal status + transition timeline

src/intake/
└── policy-reasons.ts        # add recovery reason code copy
```

### Pattern 1: Persisted Canonical State Machine + Transition Log
**What:** Use one canonical row per run plus append-only transition rows for audit/history.
**When to use:** On enqueue, every stage transition, and terminal finalization.
**Example:**
```sql
-- Suggested schema extension
CREATE TABLE IF NOT EXISTS runtime_runs (
  run_id INTEGER PRIMARY KEY AUTOINCREMENT,
  repository_key TEXT NOT NULL,
  repository_full_name TEXT NOT NULL,
  issue_number INTEGER NOT NULL,
  issue_title TEXT NOT NULL,
  issue_branch_name TEXT NOT NULL,
  queue_order INTEGER NOT NULL,
  stage TEXT NOT NULL, -- queued|preparing|coding|validating|publishing
  terminal_status TEXT, -- success|failed|cancelled|guardrail_blocked
  reason_code TEXT,
  fix_hint TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  terminal_at TEXT
);

CREATE TABLE IF NOT EXISTS runtime_run_transitions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL,
  sequence INTEGER NOT NULL,
  stage TEXT NOT NULL,
  terminal_status TEXT,
  reason_code TEXT,
  fix_hint TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(run_id) REFERENCES runtime_runs(run_id) ON DELETE CASCADE,
  UNIQUE(run_id, sequence)
);
```

### Pattern 2: Transactional Transition Guard (Never Skip/Backtrack)
**What:** Transition function validates allowed next state and writes both current row + history atomically.
**When to use:** Every state update, including recovery finalization.
**Example:**
```rust
// Source shape: src-tauri/src/runtime_boundary.rs + rusqlite transaction APIs
fn transition_run(
    conn: &mut rusqlite::Connection,
    run_id: i64,
    expected_stage: &str,
    next_stage: &str,
    terminal_status: Option<&str>,
    reason_code: Option<&str>,
    fix_hint: Option<&str>,
) -> rusqlite::Result<()> {
    let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;

    // 1) Read current stage/status, assert expected_stage and non-terminal.
    // 2) Update runtime_runs stage/status/updated_at/terminal_at.
    // 3) Insert runtime_run_transitions with next sequence.
    // 4) Commit.

    tx.commit()
}
```

### Pattern 3: Startup Reconciliation Before User Interaction
**What:** Reconcile non-terminal persisted runs immediately in app setup.
**When to use:** `tauri::Builder::setup` path after DB init.
**Example:**
```rust
// Source seam: src-tauri/src/lib.rs setup + RuntimeBoundarySharedState
fn reconcile_on_startup(app: &tauri::AppHandle) -> Result<(), String> {
    // 1) Load non-terminal runs ordered by repository_key, queue_order.
    // 2) For in-flight stages (preparing/coding/validating/publishing) that are not reattachable,
    //    transition to terminal failed with reason_code=runtime_recovery_process_lost.
    // 3) Preserve queued runs.
    // 4) Promote next queued run per repository and start worker deterministically.
    Ok(())
}
```

### Pattern 4: Snapshot + Event Delivery to Frontend
**What:** UI receives deterministic state from read command, then applies incremental updates from events.
**When to use:** Board load, repository switch, and active session updates.
**Example:**
```ts
// Source: @tauri-apps/api/event docs + src/features/board/hooks/useBoardInteractions.ts
import { listen } from "@tauri-apps/api/event";

const unlisten = await listen<RuntimeRunStagePayload>("runtime/run-stage-changed", (event) => {
  // merge payload into local runtime state map keyed by issue number
});

// call unlisten() during cleanup
```

### Pattern 5: Deterministic Queue Position Rendering
**What:** Queue badge is derived from persisted ordering among non-terminal queued runs in same repo.
**When to use:** Card metadata and issue details surfaces.
**Example:**
```sql
SELECT run_id, issue_number,
       ROW_NUMBER() OVER (PARTITION BY repository_key ORDER BY queue_order) - 1 AS queue_position
FROM runtime_runs
WHERE repository_key = ?
  AND stage = 'queued'
  AND terminal_status IS NULL;
```

### Anti-Patterns to Avoid
- **In-memory-only queue as source of truth:** loses state on restart and causes orphan/duplicate behavior.
- **Event-only UI updates:** misses data after app reload/crash and cannot satisfy reconciliation visibility.
- **Non-atomic stage updates:** updating run row and history in separate non-transactional calls can corrupt chronology.
- **Using timestamp alone for FIFO:** clock granularity ties can produce nondeterministic ordering.
- **Pruning without terminal filter:** can accidentally delete active/queued records.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Run persistence | Ad hoc JSON files for active/queue/history | SQLite tables with transactions | Atomicity, queryability, restart-safe reconciliation. |
| Transition integrity | Manual if/else spread across call sites | Single transition function with allowed-state map | Prevents skipped/backwards/duplicate stages. |
| Busy-lock retries | Custom sleep/retry loops | `busy_timeout` + transaction behavior (`Immediate` where needed) | Cleaner failure semantics and fewer race bugs. |
| UI sync | Directly mutating card state from drag handlers only | Snapshot command + event stream merge | Keeps UI consistent after restart/background updates. |

**Key insight:** Determinism requires one authoritative timeline. That means the planner should treat persisted transition history as the truth and all UI/runtime logic as projections of that truth.

## Common Pitfalls

### Pitfall 1: Duplicate active runs after restart
**What goes wrong:** App starts a queued run while stale in-flight state also appears active.
**Why it happens:** Startup path promotes queue before reconciling non-terminal persisted rows.
**How to avoid:** Reconcile first, then schedule promotion in one ordered startup routine.
**Warning signs:** Two runs shown active in same repository or repeated sidecar starts.

### Pitfall 2: Out-of-order stage transitions
**What goes wrong:** `coding -> publishing` without `validating`, or duplicate transitions.
**Why it happens:** Transitions emitted from multiple async branches without expected-state guard.
**How to avoid:** Transition API requires `expected_stage` and rejects invalid transitions.
**Warning signs:** Transition history sequence gaps or duplicate stage rows.

### Pitfall 3: Queue position badge drift
**What goes wrong:** Badge shows incorrect position after dequeue/finalize/restart.
**Why it happens:** Position is stored as static mutable field instead of derived from current queue ordering.
**How to avoid:** Store stable `queue_order`; compute display position at read time.
**Warning signs:** Two queued runs both showing position 1.

### Pitfall 4: Reconciliation failure messaging breaks UX contract
**What goes wrong:** Restart-loss failures show generic errors without `reasonCode` + `fixHint`.
**Why it happens:** New terminal reason codes not added to policy-reason mapping.
**How to avoid:** Add dedicated recovery reason code and copy in `policy-reasons.ts` + tests.
**Warning signs:** Unknown-policy toasts for recovery failures.

### Pitfall 5: WAL lock surprises during startup
**What goes wrong:** Intermittent `SQLITE_BUSY` in early startup/reconcile.
**Why it happens:** WAL recovery/checkpoint lock contention and parallel connection activity.
**How to avoid:** Keep startup DB writes serialized; rely on busy timeout and concise transactions.
**Warning signs:** Flaky startup errors that disappear on immediate retry.

## Code Examples

Verified patterns from official sources and current code:

### Emit stage updates from Rust
```rust
// Source: https://v2.tauri.app/develop/calling-frontend/
// Source seam: src-tauri/src/runtime_boundary.rs
use tauri::Emitter;

app.emit("runtime/run-stage-changed", &payload)?;
```

### Listen/unlisten in frontend runtime hook
```ts
// Source: https://tauri.app/reference/javascript/api/namespaceevent/
import { listen } from "@tauri-apps/api/event";

const unlisten = await listen<RuntimeRunStagePayload>("runtime/run-stage-changed", (event) => {
  // apply event.payload
});

unlisten();
```

### Sidecar lifecycle events that drive terminal transition
```rust
// Source: https://docs.rs/tauri-plugin-shell/latest/tauri_plugin_shell/process/enum.CommandEvent.html
// Source seam: src-tauri/src/runtime_boundary.rs
match event {
    CommandEvent::Terminated(payload) => { /* success/failed */ }
    CommandEvent::Error(_) => { /* failed */ }
    _ => {}
}
```

### Prune run history to last 20 per issue (newest-first retention)
```sql
DELETE FROM runtime_runs
WHERE run_id IN (
  SELECT run_id
  FROM runtime_runs
  WHERE repository_key = ?
    AND issue_number = ?
    AND terminal_status IS NOT NULL
  ORDER BY terminal_at DESC, run_id DESC
  LIMIT -1 OFFSET 20
);
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Ephemeral queue state in memory (`RuntimeBoundaryState`) | SQLite-backed canonical run state + transition log | Phase 4 target | Enables deterministic restart reconciliation and durable inspection. |
| Terminal evidence as per-run JSON in temp dir | Durable terminal metadata + timeline in DB | Phase 4 target | Satisfies last-20 history and details-panel inspection requirements. |
| Board status inferred from GitHub labels/assignees only | Board status composed from GitHub + runtime state overlay | Phase 4 target | Exposes canonical runtime stages and queue positions directly to user. |
| Start failures surfaced, but no restart-loss semantics | Explicit recovery failure reason code + fix hint | Phase 4 target | Prevents orphaned runs and preserves structured user feedback. |

**Deprecated/outdated for this phase:**
- Treating runtime queue mutex state as durable run truth.
- Assuming event streams alone can reconstruct state after app restart.

## Open Questions

1. **Run identity format (`INTEGER` row id vs external UUID/ULID)**
   - What we know: deterministic ordering and stable lookup are required.
   - What's unclear: whether cross-phase integrations need globally unique non-numeric IDs.
   - Recommendation: use `INTEGER PRIMARY KEY` now; add external ID only when cross-system correlation is needed.

2. **Visibility timing at startup (block UI until reconcile vs show stale then patch)**
   - What we know: reconciliation must happen immediately and avoid orphan/duplicate impression.
   - What's unclear: acceptable startup UX tradeoff for brief loading gate.
   - Recommendation: gate runtime metadata rendering until initial reconcile+snapshot complete for selected repository.

3. **Recoverable active-run definition in current architecture**
   - What we know: current sidecar process is child of app process, so true reattach is unlikely after crash.
   - What's unclear: whether any restart path should attempt automatic rerun-from-start for interrupted active runs.
   - Recommendation: for Phase 4, classify non-reattached in-flight runs as failed with recovery reason and continue FIFO queue.

## Sources

### Primary (HIGH confidence)
- Local code and planning artifacts:
  - `.planning/phases/04-deterministic-run-state-engine/04-CONTEXT.md`
  - `.planning/REQUIREMENTS.md`
  - `.planning/STATE.md`
  - `.planning/ROADMAP.md`
  - `.planning/config.json`
  - `src-tauri/src/runtime_boundary.rs`
  - `src-tauri/src/db.rs`
  - `src-tauri/src/lib.rs`
  - `src-tauri/src/commands.rs`
  - `src-tauri/capabilities/default.json`
  - `src-tauri/tauri.conf.json`
  - `src/lib/commands.ts`
  - `src/features/board/hooks/useBoardInteractions.ts`
  - `src/features/board/components/KanbanBoard.tsx`
  - `src/features/board/components/IssueDetailsPanel.tsx`
  - `src/intake/policy-reasons.ts`
- Official docs:
  - Tauri frontend eventing from Rust: https://v2.tauri.app/develop/calling-frontend/
  - Tauri JS event API (`listen`, `unlisten`, event naming): https://tauri.app/reference/javascript/api/namespaceevent/
  - Tauri sidecar embedding and permissions: https://v2.tauri.app/fr/develop/sidecar/
  - Tauri core permissions (`core:default`, `core:event:default`): https://v2.tauri.app/reference/acl/core-permissions/
  - `tauri-plugin-shell` `Command`: https://docs.rs/tauri-plugin-shell/latest/tauri_plugin_shell/process/struct.Command.html
  - `tauri-plugin-shell` `CommandEvent`: https://docs.rs/tauri-plugin-shell/latest/tauri_plugin_shell/process/enum.CommandEvent.html
  - `tauri-plugin-shell` `Shell`: https://docs.rs/tauri-plugin-shell/latest/tauri_plugin_shell/struct.Shell.html
  - `rusqlite::Connection` (`transaction`, `transaction_with_behavior`, `busy_timeout`): https://docs.rs/rusqlite/latest/rusqlite/struct.Connection.html
  - `rusqlite::Transaction` semantics: https://docs.rs/rusqlite/latest/rusqlite/struct.Transaction.html
  - SQLite WAL behavior and crash recovery notes: https://sqlite.org/wal.html
  - SQLite transaction semantics (`DEFERRED`, `IMMEDIATE`, single writer): https://www.sqlite.org/lang_transaction.html

### Secondary (MEDIUM confidence)
- None.

### Tertiary (LOW confidence)
- None.

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH - all recommended components already exist in this repo and are documented in primary sources.
- Architecture: HIGH - directly mapped to locked phase decisions and current code seams.
- Pitfalls: MEDIUM-HIGH - grounded in SQLite/Tauri docs plus observed project architecture constraints.

**Research date:** 2026-03-03
**Valid until:** 2026-04-02
