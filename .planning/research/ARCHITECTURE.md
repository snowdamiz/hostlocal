# Architecture Research

**Domain:** Local-only issue-to-PR automation in an existing Tauri + Solid desktop app
**Researched:** 2026-03-02
**Confidence:** HIGH

## Standard Architecture

### System Overview

```text
┌────────────────────────────────────────────────────────────────────────────┐
│                             Desktop UI Layer                              │
├────────────────────────────────────────────────────────────────────────────┤
│  Kanban Board  │  Right Sidebar Timeline  │  Agent Steering Chat          │
│  (issue move)  │  (live events/logs)      │  (pause/abort/instructions)   │
└──────────────┬─────────────────────────────────────────────────────────────┘
               │ Tauri invoke + channels
┌──────────────▼─────────────────────────────────────────────────────────────┐
│                        Tauri Command Boundary (Rust)                      │
├────────────────────────────────────────────────────────────────────────────┤
│  Job API      │  Stream API        │  Control API                         │
│  start/queue  │  subscribe/events  │  steer/pause/abort                  │
└──────────────┬─────────────────────────────────────────────────────────────┘
               │
┌──────────────▼─────────────────────────────────────────────────────────────┐
│                         Local Orchestration Core                           │
├────────────────────────────────────────────────────────────────────────────┤
│  Policy Gate  │  Job State Machine  │  Workspace Manager  │  GitHub Client │
│  (scope/safe) │  (deterministic)    │  (worktree lifecycle)│ (issues/PRs)   │
└──────────────┬─────────────────────────────────────────────────────────────┘
               │ sidecar process + stdio/structured events
┌──────────────▼─────────────────────────────────────────────────────────────┐
│                         Ephemeral Worker Runtime                           │
├────────────────────────────────────────────────────────────────────────────┤
│  Repo checkout/worktree  │  Edit loop  │  Tests/visual checks  │  Commit   │
└──────────────┬─────────────────────────────────────────────────────────────┘
               │
┌──────────────▼─────────────────────────────────────────────────────────────┐
│                             Local Persistence                              │
├────────────────────────────────────────────────────────────────────────────┤
│  SQLite: jobs, transitions, checkpoints, artifacts pointers               │
│  Keychain: GitHub token                                                    │
└────────────────────────────────────────────────────────────────────────────┘
```

### Component Responsibilities

| Component | Responsibility | Typical Implementation |
|-----------|----------------|------------------------|
| `Issue Trigger Controller` | Converts board transition into job request | Existing frontend drag/drop emits command `start_issue_run(repo, issue)`.
| `Policy Gate` | Enforces small-task-only safety boundary | Rust preflight classifier on issue labels/body/size heuristics before worker start.
| `Job State Machine` | Owns deterministic run phases and transitions | Rust enum + transition guards persisted in SQLite.
| `Workspace Manager` | Creates/cleans isolated per-run repo workspace | `git worktree add/remove`, temporary directories, branch naming conventions.
| `Worker Sidecar Runner` | Spawns/monitors sidecar process with bounded permissions | `tauri-plugin-shell` command/sidecar allowlist + timeout/kill semantics.
| `Validation Engine` | Runs code and optional visual checks with budgets | Command runner with per-step timeout and structured result model.
| `GitHub Writeback Service` | Creates PR, comments status, syncs issue linkage | GitHub REST via `octocrab` using versioned headers and retry/backoff.
| `Event Stream Bridge` | Streams ordered progress + logs to sidebar | Tauri channels for high-frequency streaming; events for low-volume status.
| `Control Channel` | Applies user steering actions to active run | Pause/resume/abort + instruction injection with ack events.

## Recommended Project Structure

```text
src/
├── components/
│   ├── MainLayout.tsx                # Existing shell + board
│   ├── AgentRunSidebar.tsx           # New timeline/log stream panel
│   └── AgentSteeringPanel.tsx        # New user control + instruction UI
├── lib/
│   ├── commands.ts                   # Existing typed invoke wrappers
│   ├── run-events.ts                 # Channel subscription client helpers
│   └── run-state.ts                  # Frontend run-state mapping/selectors
└── features/
    └── issue-run/
        ├── controller.ts             # Trigger flow from board action
        └── types.ts                  # Contract types for UI and IPC

src-tauri/src/
├── commands.rs                       # Existing command registration (extend)
├── github_auth.rs                    # Existing auth/token flows
├── worker/
│   ├── mod.rs                        # Module wiring
│   ├── policy.rs                     # Issue eligibility/scope gates
│   ├── job_state.rs                  # Deterministic state machine
│   ├── orchestrator.rs               # Main run coordinator
│   ├── workspace.rs                  # Worktree clone/cleanup
│   ├── sidecar.rs                    # Sidecar spawn/monitor/kill
│   ├── validation.rs                 # Test + visual check runners
│   ├── github_writeback.rs           # PR/comment/update flows
│   └── stream.rs                     # Event payloads + channel bridge
├── db.rs                             # Existing SQLite helpers (extend schema)
└── migrations/
    ├── 001_jobs.sql                  # Jobs + transitions tables
    └── 002_artifacts.sql             # Validation/report metadata
```

### Structure Rationale

- **`worker/` module boundary:** keeps new orchestration complexity isolated from existing auth/settings commands.
- **`run-events.ts` + `run-state.ts`:** decouples high-volume stream ingestion from presentation components.
- **SQLite migrations for jobs/artifacts:** ensures crash recovery and deterministic replay without depending on volatile memory.

## Architectural Patterns

### Pattern 1: Deterministic State Machine

**What:** Model every run as explicit transitions (`queued -> preparing -> coding -> validating -> publishing -> done|failed|cancelled`).
**When to use:** Always for autonomous workflows that users may interrupt.
**Trade-offs:** More upfront modeling work, but dramatically simpler recovery and UI consistency.

**Example:**
```rust
// Pseudocode
match (state, action) {
  (Queued, Start) => Preparing,
  (Preparing, WorkspaceReady) => Coding,
  (Coding, PatchReady) => Validating,
  (Validating, ChecksPassed) => Publishing,
  (Publishing, PrCreated) => Done,
  (_, Abort) => Cancelled,
  _ => InvalidTransition,
}
```

### Pattern 2: Command + Channel Split

**What:** Use invoke commands for control operations and channels for streaming output.
**When to use:** High-frequency log/timeline updates plus low-frequency control actions.
**Trade-offs:** Slightly more protocol surface, much better throughput and ordering for logs.

**Example:**
```typescript
await invoke("worker_start_run", { repoId, issueNumber });
const unsubscribe = await subscribeRunChannel(runId, (event) => {
  applyRunEvent(event);
});
```

### Pattern 3: Workspace-Per-Run Isolation

**What:** Use linked worktrees and disposable temp paths per run.
**When to use:** Any repo-modifying autonomous behavior.
**Trade-offs:** Requires strict cleanup and naming discipline, but prevents branch/workspace contamination.

## Data Flow

### Request Flow

```text
[User drags issue to In Progress]
    ↓
[Frontend issue-run controller]
    ↓ invoke worker_start_run
[Rust policy gate] -> [Job table insert]
    ↓ accepted
[Workspace manager creates worktree + branch]
    ↓
[Sidecar runner starts agent process]
    ↓
[Event stream bridge emits timeline/log events]
    ↓
[Validation engine runs tests + optional browser checks]
    ↓
[GitHub writeback creates/updates PR]
    ↓
[Run final state + UI notification]
```

### State Management

```text
[SQLite jobs/transitions/artifacts]
      ↑                     ↓
[Orchestrator writes]   [Frontend reads snapshot]
      ↓                     ↑
[Stream events/channels] -> [Sidebar real-time view]
```

### Key Data Flows

1. **Issue Trigger Flow:** board transition -> policy gate -> queued job id.
2. **Execution Flow:** queued job -> sidecar process -> structured event stream.
3. **Validation Flow:** changed workspace -> checks -> normalized pass/fail evidence.
4. **Publish Flow:** validated changes -> commit/push -> PR creation -> UI status.
5. **Control Flow:** user steering input -> orchestrator action -> ack + state transition.

## Scaling Considerations

| Scale | Architecture Adjustments |
|-------|--------------------------|
| 1 user, 1 active run | Single in-process orchestrator + one worker process.
| 1 user, multiple queued runs | Add local queue scheduler and concurrency cap (default 1 active).
| Heavy repos / long runs | Add warm mirror cache + disk quota guardrails + artifact pruning.

### Scaling Priorities

1. **First bottleneck:** clone/workspace startup time; optimize with warm mirror/worktree strategy.
2. **Second bottleneck:** UI stream volume; downsample/aggregate noisy logs while preserving milestones.

## Anti-Patterns

### Anti-Pattern 1: Frontend-Driven Shell Commands

**What people do:** Execute arbitrary shell directly from UI layer.
**Why it's wrong:** Expands attack surface and makes policy enforcement inconsistent.
**Do this instead:** Route all execution through Rust policy + sidecar allowlist.

### Anti-Pattern 2: Free-Form Agent Loop Without Checkpoints

**What people do:** Let agent run without deterministic state or persisted checkpoints.
**Why it's wrong:** Crash/interrupt recovery becomes unreliable, UI gets out of sync.
**Do this instead:** Enforce transition table + checkpoint writes after each stage.

## Integration Points

### External Services

| Service | Integration Pattern | Notes |
|---------|---------------------|-------|
| GitHub REST API | Typed client (`octocrab`) + backoff queue | Set API version header and handle secondary rate limits.
| Git provider remote (`git`) | CLI subprocess calls | Keep commands explicit and auditable per run artifact.
| Browser validation tooling | Spawn existing repo test commands | Prefer repo-native scripts first; fallback optional Playwright tasks.

### Internal Boundaries

| Boundary | Communication | Notes |
|----------|---------------|-------|
| Frontend <-> Rust commands | Tauri `invoke` | Control plane only (start/pause/abort/steer).
| Rust orchestrator <-> Frontend stream | Tauri channels/events | Data plane for timeline/log updates.
| Orchestrator <-> Sidecar process | stdio + structured JSON lines | Enforce message schema and heartbeat timeout.
| Orchestrator <-> SQLite | transactional writes | Persist transitions before emitting terminal status.

## Sources

- [Tauri sidecar docs](https://v2.tauri.app/fr/develop/sidecar/)
- [Tauri shell plugin docs](https://v2.tauri.app/es/plugin/shell/)
- [Tauri calling frontend (events/channels)](https://v2.tauri.app/es/develop/calling-frontend/)
- [Git `worktree` docs](https://git-scm.com/docs/git-worktree.html)
- [GitHub REST pulls reference](https://docs.github.com/en/rest/reference/pulls)
- [GitHub REST best practices](https://docs.github.com/rest/guides/best-practices-for-integrators)
- [GitHub REST rate limits](https://docs.github.com/enterprise-cloud%40latest/rest/overview/rate-limits-for-the-rest-api)

---
*Architecture research for: local issue-to-PR automation in a Tauri desktop app*
*Researched: 2026-03-02*
