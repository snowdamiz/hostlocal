# Phase 6: In-Run User Control - Research

**Researched:** 2026-03-03
**Domain:** Runtime control-plane actions for active local runs (pause, resume, abort, steering)
**Confidence:** MEDIUM-HIGH

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

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

### Deferred Ideas (OUT OF SCOPE)
- Global board-level control bars or multi-issue batch controls.
- Queued-run pause semantics distinct from queue removal.
- Preset steering templates or macro instruction libraries.
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| CTRL-01 | User can pause an active run. | Add backend `runtime_pause_issue_run` command + persisted paused flag + stage event payload extension (`isPaused`) so UI can stop progression and show explicit paused indicator. |
| CTRL-02 | User can resume a paused run. | Add backend `runtime_resume_issue_run` command that clears paused flag and resumes completion path from paused point (including draining any pending terminal outcome). |
| CTRL-03 | User can abort an active run and trigger safe cleanup. | Add backend `runtime_abort_issue_run` command that kills active process, finalizes run as `cancelled`, emits reason/fix telemetry, and reuses existing `finalize_run` cleanup/promotion path. |
| CTRL-04 | User can send steering instructions to an in-progress run and receive acknowledgement. | Add backend `runtime_steer_issue_run` command that writes instruction to child stdin (best-effort) and always returns explicit acknowledgement/error, with mirrored telemetry + toast feedback. |
</phase_requirements>

## Summary

Phase 5 already provides the required primitives for control acknowledgements: typed command wrappers, live runtime telemetry, stage-change events, and panel surfaces for current runtime context. What is missing is a runtime control plane that keeps handles to active child processes and can mutate active-run control state safely.

The main architectural gap is in `spawn_sidecar_for_run`: it currently drops the `CommandChild` handle immediately (`let (mut receiver, _child)`), so there is no way to kill or write to the process after spawn. Without retaining this handle, Phase 6 cannot implement abort or steering reliably, and pause/resume cannot be represented as a true in-run control.

The safest planning approach is: keep canonical lifecycle stages unchanged (`queued -> preparing -> coding -> validating -> publishing`), add a persisted paused flag instead of introducing a new stage enum, and implement control commands around an in-memory runtime control registry keyed by run. This avoids disruptive SQLite CHECK-constraint rewrites while still meeting UI/state behavior requirements for CTRL-01..04.

**Primary recommendation:** Implement a backend runtime control registry + four explicit control commands, persist `is_paused` metadata in `runtime_runs`, extend stage payloads with pause state, and wire IssueDetailsPanel actions through `useBoardInteractions` with telemetry + toast acknowledgement.

## Standard Stack

### Core

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `tauri` / `@tauri-apps/api` | `2.x` / `2.10.1` | Command/event bridge between UI and Rust runtime | Already the project’s runtime boundary and event transport model. |
| `tauri-plugin-shell` | `2.x` | Active child-process control (`CommandChild.write`, `CommandChild.kill`, `pid`) | Existing sidecar execution path; no new process-control library required. |
| `rusqlite` | `0.32` | Persisted run state/read models (`runtime_runs`, transitions, events) | Existing canonical runtime state storage. |
| `serde` / `serde_json` | `1.x` | Typed command payloads and event DTOs | Existing backend/frontend contract pattern. |
| SolidJS (`createSignal`, `createMemo`, `createEffect`) | `1.9.3` | State-aware action enablement and optimistic/pending UI state | Already used in `useBoardInteractions` for runtime hydration + subscriptions. |

### Supporting

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| Existing telemetry pipeline in `runtime_boundary.rs` | current | Acknowledgement evidence and audit trail for control actions | Record pause/resume/abort/steer acknowledgements and failures. |
| Existing toast-store pattern (`src/intake/toast-store.ts`) | current | Dedupe + TTL toast behavior | Reuse pattern for control acknowledgements with a control-specific store/viewport. |
| Tailwind v4 + CSS tokens (`var(--...)`) | `4.2.1` | Action-row and toast visuals | Required by repo rules (`STYLE-01`, token-only colors). |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Persisted `is_paused` flag + unchanged stage enum | Add `"paused"` to stage enum/check constraints | Stage-enum expansion touches DB constraints, stage ordering guards, column inference, and many tests. Higher migration risk. |
| Control registry with `CommandChild` retained | Fire-and-forget child with no handle | Cannot support abort/steer; pause/resume semantics become mostly cosmetic. |
| Steering via `stdin` + explicit ack | Backend-only no-op steering ack | Easier short-term, but loses forward compatibility with real worker steering. |
| Abort through `finalize_run` path | Ad hoc SQL status writes | Risks bypassing safe cleanup, queue promotion, telemetry consistency. |

**Installation:**
```bash
# Baseline Phase 6 plan can be implemented with current dependencies.
# No required npm/cargo additions for core control plane.
```

## Architecture Patterns

### Recommended Project Structure

```text
src-tauri/src/
|- runtime_boundary.rs    # control registry, pause/resume/abort/steer commands, payload extensions
|- db.rs                  # runtime_runs paused-state migration helper
|- lib.rs                 # register new Tauri commands

src/lib/
|- commands.ts            # typed runtime control request/outcome contracts

src/features/board/hooks/
|- useBoardInteractions.ts  # invoke control commands, pending state, ack refresh logic

src/features/board/components/
|- IssueDetailsPanel.tsx    # inline action row + steering composer + confirmation modal trigger

src/runtime-control/
|- toast-store.ts           # control acknowledgement toasts (pattern reuse)
|- RuntimeToastViewport.tsx # optional dedicated viewport
```

### Pattern 1: Runtime Control Registry (Required)
**What:** Keep per-run control state in backend memory while run is active.
**When to use:** Any command that needs to mutate an in-flight run (pause/resume/abort/steer).

**Recommended registry shape:**
- key: `run_id` (or `{repository_key, issue_number}` resolved to latest active `run_id`)
- value:
  - `child: CommandChild`
  - `is_paused: bool`
  - `abort_requested: bool`
  - `pending_terminal: Option<{ status, reason_code, fix_hint }>`

**Why:** Enables deterministic arbitration between async process events and user control commands.

### Pattern 2: Persist Pause Metadata Without Stage Rewrite
**What:** Add paused metadata to `runtime_runs`, not to stage enum.
**When to use:** Showing paused indicator in board/panel, restoring state on hydration/restart.

**Suggested DB additions:**
- `runtime_runs.is_paused INTEGER NOT NULL DEFAULT 0 CHECK(is_paused IN (0, 1))`
- `runtime_runs.paused_at TEXT NULL`

**Why this is safer than a new stage value:**
- Existing stage CHECK constraints are strict.
- Existing transition guard logic assumes linear stage progression.
- `inferDefaultColumn` already maps non-terminal stages to `inProgress`; no extra column logic needed.

### Pattern 3: Explicit Control Commands + Eligibility Guards
**What:** Introduce four backend commands with structured outcomes.
**When to use:** Frontend action row invokes these directly.

**Commands:**
- `runtime_pause_issue_run({ repositoryFullName, issueNumber })`
- `runtime_resume_issue_run({ repositoryFullName, issueNumber })`
- `runtime_abort_issue_run({ repositoryFullName, issueNumber, reason? })`
- `runtime_steer_issue_run({ repositoryFullName, issueNumber, instruction })`

**Eligibility rules from locked decisions:**
- Pause/Resume: active runs only (not queued, not terminal)
- Abort: active + paused only (queued still uses dequeue semantics)
- Steering: active only; reject while paused/queued/terminal

### Pattern 4: Abort Through Existing Finalization Path
**What:** Convert user abort into controlled cancellation using existing `finalize_run`.
**When to use:** Abort command on active or paused run.

**Flow:**
1. Resolve active run and control entry.
2. Mark `abort_requested = true`.
3. `child.kill()` (best-effort; handle already-exited case).
4. Finalize with `RuntimeTerminalStatus::Cancelled`, reason/fix metadata.
5. Emit stage/telemetry acknowledgement and cleanup through existing `finalize_run`.

**Race guard requirement:** Ensure termination handler and abort handler cannot both finalize the same run twice.

### Pattern 5: Steering as Best-Effort Control Transport + Deterministic Ack
**What:** Send steering instructions to child stdin and always return a typed ack/error.
**When to use:** User submits one instruction at a time from panel composer.

**Flow:**
1. Validate active eligible run.
2. `child.write(format!("{instruction}\n").as_bytes())`
3. Record telemetry event (`kind: "control"`, stage context, message: steering acknowledged/failed).
4. Emit toast result to user.

**Note:** Current sidecar is placeholder; steering impact on actual execution remains worker-dependent, but acknowledgement behavior can still be deterministic in this phase.

### Pattern 6: UI Control Surface in IssueDetailsPanel
**What:** Add action row adjacent to runtime-stage section with state-aware buttons and steering composer.
**When to use:** `selectedBoardRuntime()` exists for selected issue.

**UI contract:**
- Buttons enabled only for valid state.
- Abort opens confirmation modal.
- Steering input disabled while send is pending.
- Pause/resume/abort/steer each produce telemetry + toast ack.
- Board card/panel stage badges render paused indicator from `isPaused`.

### Anti-Patterns to Avoid
- **Dropping child handles after spawn:** prevents abort/steer and weakens control guarantees.
- **Modeling pause as terminal state:** breaks resume semantics.
- **Queue-semantics drift:** do not allow pause/resume on queued runs.
- **Bypassing `finalize_run` for abort:** risks missed cleanup and queue promotion bugs.
- **State-only frontend control ack:** backend telemetry must be canonical acknowledgement.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Process control | Custom OS process wrappers from scratch | `tauri-plugin-shell` `CommandChild.write/kill/pid` | Already in stack, typed, and aligned with current sidecar architecture. |
| Run finalization | New cancellation SQL paths | Existing `finalize_run` + `persist_finalize_runtime_run` | Preserves safe cleanup, terminal evidence, and promotion behavior. |
| UI runtime sync | Ad hoc per-component state islands | Existing `useBoardInteractions` hydrate + event listener pattern | Maintains deterministic repository/issue scoping and avoids event drift. |
| Notifications | Repeated inline status text only | Toast store pattern with dedupe + TTL | Matches existing UX conventions and avoids action spam. |

**Key insight:** Phase 6 is a control-plane extension of Phase 4/5, not a new runtime engine. Reuse canonical runtime state + telemetry plumbing; only add control state and action contracts.

## Common Pitfalls

### Pitfall 1: Child Handle Lifetime Loss
**What goes wrong:** Abort/steering fail because no process handle is retained.
**Why it happens:** Current spawn path drops `CommandChild`.
**How to avoid:** Register `CommandChild` in control registry before entering event loop.
**Warning signs:** Control commands return “active run not controllable” despite active coding run.

### Pitfall 2: Pause Encoded as New Stage Too Early
**What goes wrong:** Migration/test blast radius explodes (DB checks, stage guards, UI maps).
**Why it happens:** Pause modeled as lifecycle stage instead of orthogonal state.
**How to avoid:** Keep stage canonical; add paused metadata field + payload indicator.
**Warning signs:** Failing tests around canonical stage-only transitions or invalid DB stage values.

### Pitfall 3: Abort/Terminate Double Finalization
**What goes wrong:** Duplicate terminal telemetry or queue promotion anomalies.
**Why it happens:** Abort path and async `CommandEvent::Terminated` both finalize.
**How to avoid:** Idempotent finalization guard in control registry keyed by run.
**Warning signs:** Multiple finalization milestones for same run ID.

### Pitfall 4: Invalid Action Enablement
**What goes wrong:** Pause shown for queued run, steering allowed while paused, resume shown when not paused.
**Why it happens:** UI derives enablement from incomplete runtime metadata.
**How to avoid:** Centralize action eligibility from `stage`, `terminalStatus`, and `isPaused`.
**Warning signs:** User can trigger control command and immediately gets server-side rejection for obvious invalid states.

### Pitfall 5: SQLite Migration Blind Spots
**What goes wrong:** Existing DBs miss new columns and control payloads crash on read.
**Why it happens:** Schema uses `CREATE TABLE IF NOT EXISTS` without explicit alter-step checks.
**How to avoid:** Add startup migration helper (`PRAGMA table_info`) and idempotent `ALTER TABLE ADD COLUMN`.
**Warning signs:** Production users see “no such column: is_paused”.

## Code Examples

Verified and recommended patterns:

### Existing typed command wrapper pattern
```ts
// src/lib/commands.ts
export function runtimeEnqueueIssueRun(request: RuntimeEnqueueIssueRunRequest): Promise<RuntimeEnqueueIssueRunOutcome> {
  return invoke<RuntimeEnqueueIssueRunOutcome>("runtime_enqueue_issue_run", { request });
}
```

### Existing event subscription + repo filter pattern
```ts
// src/features/board/hooks/useBoardInteractions.ts
const unlisten = await listen<RuntimeRunStageChangedEventPayload>("runtime/run-stage-changed", (event) => {
  const payload = event.payload;
  if (normalizeRepositoryIdentifier(payload.repositoryFullName) !== expectedRepository) return;
  onPayload(payload);
});
```

### Recommended control outcome contract
```ts
export interface RuntimeRunControlRequest {
  repositoryFullName: string;
  issueNumber: number;
}

export interface RuntimeRunControlOutcome {
  acknowledged: boolean;
  runId: number | null;
  reasonCode: string | null;
  fixHint: string | null;
  isPaused: boolean | null;
}
```

### Recommended steering command sketch (Rust)
```rust
#[tauri::command]
pub async fn runtime_steer_issue_run(
    app: AppHandle,
    state: State<'_, RuntimeBoundarySharedState>,
    request: RuntimeSteerIssueRunRequest,
) -> Result<RuntimeRunControlOutcome, String> {
    // 1) resolve active run for repository + issue
    // 2) validate state: active, not paused, not terminal
    // 3) write instruction bytes to child stdin
    // 4) record control telemetry event
    // 5) return explicit ack/error outcome
}
```

## State of the Art

| Current (after Phase 5) | Target (Phase 6) | Impact |
|-------------------------|------------------|--------|
| Runtime is observable but not controllable mid-run | User can pause/resume/abort/steer active runs | Delivers CTRL-01..04 without altering overall run pipeline model. |
| Active child handle is not retained | Child handle registered per active run for control commands | Enables real abort/steer operations and reliable command outcomes. |
| Stage payload exposes stage/terminal only | Stage payload also carries paused metadata | Enables explicit paused indicator in board and panel UI. |
| Queue removal handles only queued cancellation | Abort handles active/paused cancellation with safe cleanup | Preserves queued semantics while adding in-run intervention. |

## Open Questions

1. **Worker control protocol compatibility**
   - What we know: the bundled sidecar is currently a placeholder script and does not expose a documented stdin control protocol.
   - What is unclear: exact pause/resume/steering semantics expected by future real worker implementation.
   - Recommendation: implement deterministic control acks now, and treat stdin command strings as versioned protocol (`control:pause`, `control:resume`, `control:steer:<payload>`) for worker follow-up.

2. **Cross-platform pause semantics**
   - What we know: `CommandChild.kill` is available and reliable for abort; pausing is not a first-class shell-plugin API.
   - What is unclear: whether OS-signal pause (Unix) is required in Phase 6, or control-level paused gating is acceptable.
   - Recommendation: plan baseline with persisted paused state + completion gating, then optionally add platform-specific process suspension if needed.

3. **Toast architecture scope**
   - What we know: existing toast system is intake-rejection-specific copy and schema.
   - What is unclear: whether to extend intake toasts into generic toasts now or add dedicated runtime-control toasts.
   - Recommendation: add dedicated control toast store/viewport in this phase to avoid coupling control success copy to intake rejection semantics.

## Sources

### Primary (HIGH confidence)
- `.planning/phases/06-in-run-user-control/06-CONTEXT.md`
- `.planning/REQUIREMENTS.md`
- `.planning/STATE.md`
- `.planning/ROADMAP.md`
- `.planning/config.json`
- `CLAUDE.md`
- `.claude/skills/gitnexus/gitnexus-exploring/SKILL.md`
- `src/components/MainLayout.tsx`
- `src/features/board/components/IssueDetailsPanel.tsx`
- `src/features/board/components/KanbanBoard.tsx`
- `src/features/board/hooks/useBoardInteractions.ts`
- `src/features/board/hooks/useBoardInteractions.test.ts`
- `src/features/board/column-inference.ts`
- `src/features/board/column-inference.test.ts`
- `src/lib/commands.ts`
- `src/intake/toast-store.ts`
- `src/intake/policy-reasons.ts`
- `src-tauri/src/runtime_boundary.rs`
- `src-tauri/src/db.rs`
- `src-tauri/src/lib.rs`
- `src-tauri/capabilities/default.json`
- `src-tauri/tauri.conf.json`
- `src-tauri/binaries/hostlocal-worker-aarch64-apple-darwin`
- `package.json`
- `src-tauri/Cargo.toml`
- `gitnexus://repo/hostlocal/context`
- `gitnexus://repo/hostlocal/processes`
- `gitnexus://repo/hostlocal/process/Runtime_enqueue_issue_run → CloneToasts`

### Secondary (MEDIUM confidence)
- Rust `std::process::Child` docs: https://doc.rust-lang.org/std/process/struct.Child.html
- `tauri_plugin_shell::process::CommandChild` docs: https://docs.rs/tauri-plugin-shell/latest/tauri_plugin_shell/process/struct.CommandChild.html
- `tauri_plugin_shell::process::Command` docs: https://docs.rs/tauri-plugin-shell/latest/tauri_plugin_shell/process/struct.Command.html
- SQLite ALTER TABLE docs: https://www.sqlite.org/lang_altertable.html
- Tauri v2 frontend listen docs: https://v2.tauri.app/develop/_sections/frontend-listen/
- Tauri v2 calling Rust docs: https://v2.tauri.app/es/develop/calling-rust/

### Tertiary (LOW confidence)
- None.

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH - all proposed mechanisms align with existing project dependencies and code patterns.
- Architecture: MEDIUM - control registry and paused-state persistence are strong fits, but worker-side control protocol remains partially unknown.
- Pitfalls: MEDIUM-HIGH - directly grounded in current runtime lifecycle, schema constraints, and event/handle behavior.

**Research date:** 2026-03-03
**Valid until:** 2026-04-02
