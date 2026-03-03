# Phase 3: Local Worker Runtime Boundary - Research

**Researched:** 2026-03-03
**Domain:** Local run execution boundary (Tauri v2 sidecar + isolated ephemeral workspace + guardrails)
**Confidence:** HIGH

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

### Workspace Lifecycle
- Each accepted run starts from a fresh clone in a brand-new workspace.
- Ephemeral workspaces are created in the system temp directory.
- Per-run branches use deterministic issue-based naming (`hostlocal/issue-<number>-<slug>` style).
- On completion or cancellation, workspace directories are deleted; lightweight run evidence remains outside the workspace.

### Concurrency Behavior
- Allow one active run per repository at a time.
- If another issue in the same repository is accepted while one run is active, queue it automatically.
- Queue order is FIFO by intake acceptance time.
- If a queued issue is moved back to Todo before starting, remove it from the queue.

### Guardrail Failure Outcomes
- Guardrail blocks are surfaced immediately through the global rejection-toast pattern.
- Guardrail-blocked runs move the issue back to Todo so In Progress stays trustworthy.
- Failure messages include violated rule + blocked target type, without exposing raw sensitive command/path values.
- Guardrail failures never auto-retry; retry is manual via the board intake flow.

### Claude's Discretion
- Exact temp-workspace folder naming and per-run metadata file layout.
- Exact guardrail toast copy and presentation details.
- Exact blocked-target taxonomy used in user-facing messages.
- Exact non-guardrail startup failure copy/details, as long as failure remains explicit and bounded to this phase.

### Deferred Ideas (OUT OF SCOPE)

None - discussion stayed within phase scope.
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| RUN-01 | User run executes on the local machine through a Rust/Tauri sidecar path (no remote workers). | Use `tauri-plugin-shell` sidecar execution only, with no frontend-provided command strings and no remote execution endpoints. |
| RUN-02 | User run uses an isolated ephemeral workspace and branch for that issue. | Per run: create `tempfile::TempDir` under system temp, fresh clone target repository, create deterministic issue branch with `git switch -c`, and run sidecar with workspace as `current_dir`. |
| RUN-03 | Run workspace is cleaned up automatically after completion or cancellation. | Centralize run finalization so all terminal paths (success, failure, cancel, guardrail reject) drop/close the temp workspace and remove directory automatically. |
| SEC-02 | Sidecar execution is restricted by explicit command/path permissions to the run workspace boundary. | Enforce Tauri shell command scope (`shell:allow-execute`/`shell:allow-spawn`) plus Rust guardrails (`canonicalize` + `strip_prefix`) before spawning sidecar or accepting path targets. |
</phase_requirements>

## Summary

This phase should be planned as a strict backend runtime boundary, not as frontend orchestration. Current code still has a placeholder seam (`startAgentRunForIssue`) and no runtime queue/workspace/sidecar implementation. That is good for incremental integration: keep frontend behavior thin, and move all run authority into Rust commands and state.

The strongest implementation path is Tauri v2 shell sidecar execution with explicit permission scopes, per-repo queue state in Rust, and ephemeral workspace lifecycle managed by `TempDir`. This directly satisfies RUN-01/02/03 while giving a concrete SEC-02 enforcement model (permission scope + canonicalized path boundary checks + explicit blocked outcomes).

Current project patterns already fit this: command wrappers in `src/lib/commands.ts`, `#[tauri::command]` backend handlers, global intake rejection toasts, and board flow that already reverts to Todo on explicit rejection outcomes. Phase 3 should reuse those patterns and add runtime-specific reason codes/copy.

**Primary recommendation:** Implement a Rust-owned `runtime_enqueue_issue_run` boundary that (1) enqueues by repository, (2) allocates an ephemeral workspace + branch, (3) executes only approved sidecar command scopes, and (4) guarantees cleanup in every terminal path.

## Standard Stack

### Core

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `tauri` + `tauri-plugin-shell` | `2.x` | Execute local sidecar processes under Tauri capability permissions | Official Tauri v2 path for controlled process execution and sidecar support. |
| `tempfile::TempDir` | `3.x` | Create run-scoped ephemeral workspaces with automatic cleanup | Avoids hand-rolled temp-dir lifecycle and leaks. |
| Rust std path APIs (`std::fs::canonicalize`, `Path::strip_prefix`) | stable std | Enforce workspace path boundary guardrails | Canonical absolute path checks with symlink resolution are required for SEC-02. |
| Git CLI (`git clone`, `git switch -c`) | system git | Create fresh workspace clone and deterministic issue branch | Reliable, standard git workflow; aligns with locked “fresh clone” decision. |

### Supporting

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| Tauri managed state (`tauri::State`) | `2.x` | Hold per-repo active run + FIFO queue state | Always for queue ownership and run lifecycle serialization. |
| Existing toast infrastructure (`src/intake/toast-store.ts`) | current | Surface guardrail failures and startup failures consistently | For explicit user-visible blocked/failure outcomes. |
| Existing invoke wrapper layer (`src/lib/commands.ts`) | current | Typed frontend boundary for runtime commands | For starting runs and removing queued runs during revert. |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Tauri shell sidecar plugin with scopes | `std::process::Command` directly | Less built-in permission scaffolding; weaker alignment with Tauri command scope model for SEC-02. |
| `TempDir` lifecycle | Manual `std::env::temp_dir` + `remove_dir_all` everywhere | Higher leak/race risk and scattered cleanup logic. |
| Fresh clone per run (locked) | `git worktree` reuse | Faster warm start but violates locked workspace decision for this phase. |

**Installation:**
```bash
# Add Tauri shell sidecar plugin using official Tauri flow
pnpm tauri add shell

# Add ephemeral workspace helper
cd src-tauri && cargo add tempfile
```

## Architecture Patterns

### Recommended Project Structure

```text
src/
├── features/board/hooks/
│   └── useBoardInteractions.ts       # keep start seam; call runtime enqueue/revert commands
├── intake/
│   └── policy-reasons.ts             # add runtime/guardrail failure reason codes + copy
└── lib/
    └── commands.ts                   # runtime command wrappers

src-tauri/
├── capabilities/
│   └── default.json                  # add shell execute/spawn permissions with strict allow scope
├── src/
│   ├── runtime_boundary.rs           # queue state, workspace lifecycle, sidecar spawn, guardrails
│   ├── commands.rs                   # expose runtime enqueue/dequeue commands
│   └── lib.rs                        # register new runtime commands and plugin init
└── tauri.conf.json                   # sidecar externalBin entries (if packaging sidecar binary)
```

### Pattern 1: Backend-Owned Per-Repo Queue Boundary
**What:** Rust command accepts intake-approved issue run requests and enforces one active run per repository plus FIFO queue for additional accepted issues.
**When to use:** Every successful `todo -> inProgress` acceptance path.
**Example:**
```rust
use std::collections::{HashMap, VecDeque};

#[derive(Default)]
struct RuntimeState {
    repos: HashMap<String, RepoRuntime>,
}

#[derive(Default)]
struct RepoRuntime {
    active_run_id: Option<String>,
    queued: VecDeque<QueuedRun>,
}

#[tauri::command]
async fn runtime_enqueue_issue_run(
    state: tauri::State<'_, std::sync::Mutex<RuntimeState>>,
    request: RuntimeEnqueueRequest,
) -> Result<RuntimeEnqueueOutcome, String> {
    // 1) Lock state briefly, enqueue or start immediately by repo key
    // 2) Never hold lock across async/await process execution
    // 3) Return explicit outcome: started | queued | blocked
    todo!()
}
```

### Pattern 2: Sidecar-Only Execution with Explicit Shell Permission Scope
**What:** Execute only known sidecar commands through `tauri-plugin-shell`, with allowlisted command identity and argument validators.
**When to use:** Every run process spawn.
**Example:**
```json
{
  "identifier": "default",
  "windows": ["main"],
  "permissions": [
    "core:default",
    {
      "identifier": "shell:allow-execute",
      "allow": [
        {
          "name": "run-local-worker",
          "cmd": "binaries/hostlocal-worker",
          "sidecar": true,
          "args": [
            "--run",
            { "validator": "^[a-zA-Z0-9._/-]+$" }
          ]
        }
      ]
    }
  ]
}
```

```rust
use tauri_plugin_shell::{process::CommandEvent, ShellExt};

fn spawn_worker(app: &tauri::AppHandle, workspace: &std::path::Path) -> Result<(), String> {
    let command = app
        .shell()
        .sidecar("hostlocal-worker")
        .map_err(|e| e.to_string())?
        .current_dir(workspace)
        .args(["--run"]);

    let (mut rx, child) = command.spawn().map_err(|e| e.to_string())?;

    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Terminated(payload) => {
                    // map exit status into run terminal outcome
                    let _ = payload.code;
                }
                CommandEvent::Error(message) => {
                    // explicit failure outcome
                    let _ = message;
                }
                _ => {}
            }
        }
        let _ = child;
    });

    Ok(())
}
```

### Pattern 3: Workspace Boundary Guardrail (Canonical Path Enforcement)
**What:** Resolve workspace root and candidate paths canonically, then require `candidate` to remain under workspace via `strip_prefix`.
**When to use:** Before any sidecar spawn path, current_dir path, file operation, or sidecar-provided path target.
**Example:**
```rust
fn ensure_within_workspace(
    workspace_root: &std::path::Path,
    candidate: &std::path::Path,
) -> Result<(), GuardrailBlock> {
    let root = std::fs::canonicalize(workspace_root)
        .map_err(|_| GuardrailBlock::new("workspace_unresolvable", "workspace"))?;
    let target = std::fs::canonicalize(candidate)
        .map_err(|_| GuardrailBlock::new("target_unresolvable", "path"))?;

    if target.strip_prefix(&root).is_err() {
        return Err(GuardrailBlock::new("workspace_boundary_violation", "path"));
    }

    Ok(())
}
```

### Pattern 4: Deterministic Workspace Lifecycle + Cleanup-on-All-Terminals
**What:** Create run workspace with `TempDir`, execute run inside it, and finalize with guaranteed cleanup on success/failure/cancel.
**When to use:** Entire run execution lifecycle for Phase 3.
**Example:**
```rust
use tempfile::TempDir;

async fn execute_run_with_workspace(...) -> Result<RunTerminal, String> {
    let workspace = TempDir::new_in(std::env::temp_dir())
        .map_err(|e| format!("workspace_create_failed: {e}"))?;

    // prepare clone + branch in workspace.path()
    // run sidecar command in workspace.path()

    let result = run_flow(workspace.path()).await;

    // Explicit close gives deterministic cleanup error visibility.
    workspace
        .close()
        .map_err(|e| format!("workspace_cleanup_failed: {e}"))?;

    result
}
```

### Pattern 5: Frontend Integration Through Existing Board Seam Only
**What:** Keep runtime kickoff in `startAgentRunForIssue` and use existing rejection-toast path for blocked outcomes.
**When to use:** Immediately after successful intake acceptance.
**Example:**
```ts
const startAgentRunForIssue = async (item: GithubRepositoryItem) => {
  const outcome = await runtimeEnqueueIssueRun({
    repositoryFullName: selectedRepository()!.fullName,
    issueNumber: item.number,
    issueTitle: item.title,
  });

  if (!outcome.accepted) {
    pushIntakeRejectionToast(outcome.reasonCode, outcome.fixHint);
    await githubRevertIssueIntake({ ... });
  }
};
```

### Anti-Patterns to Avoid
- **Frontend-selected executable/path:** Never accept arbitrary command/path from JS for sidecar execution.
- **Holding queue mutex across process await:** Causes deadlocks/stalls under concurrent accepts.
- **Best-effort cleanup only:** Cleanup must be part of terminal-state finalization, not optional background task.
- **Leaking raw blocked target values in UI errors:** Violates locked failure-message requirement.
- **Assuming shell plugin default permissions allow execution:** Shell default permission only allows open; execute/spawn must be explicitly granted.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Sidecar permission model | Custom ad-hoc allowlist file parser | Tauri capability + plugin permission scopes (`shell:allow-execute` / `shell:allow-spawn`) | Native security model with command scope semantics. |
| Ephemeral workspace management | Manual random temp path creation/deletion everywhere | `tempfile::TempDir` | RAII cleanup and clearer lifecycle boundaries. |
| Workspace path-boundary security | String prefix checks on raw paths | `canonicalize` + `strip_prefix` checks on resolved paths | Handles normalization/symlink resolution safely. |
| Branch creation in fresh clone | Custom git internals implementation | Git CLI (`git clone`, `git switch -c`) | Standard behavior, lower complexity, easier debugging. |

**Key insight:** SEC-02 is only reliably met when command scope restrictions and path-boundary guardrails are both enforced; either one alone leaves bypass gaps.

## Common Pitfalls

### Pitfall 1: Permission configured but command still blocked
**What goes wrong:** Sidecar spawn fails with denied-command errors.
**Why it happens:** Shell plugin permissions were not added to capability or command scope name mismatch.
**How to avoid:** Add explicit `shell:allow-execute`/`shell:allow-spawn` scope entries and keep sidecar command name aligned with Rust spawn call.
**Warning signs:** Immediate spawn errors before process start.

### Pitfall 2: Queue lock contention stalls intake
**What goes wrong:** New accepted issues hang while run is active.
**Why it happens:** Long operations (clone/process wait) run while holding shared queue lock.
**How to avoid:** Lock only for queue mutations; spawn async worker and release lock immediately.
**Warning signs:** Intake commands become progressively slower under repeated accepts.

### Pitfall 3: Path guardrail false positives/false negatives
**What goes wrong:** Legitimate workspace paths are blocked, or out-of-bound paths slip through.
**Why it happens:** Checks on non-canonical path strings, missing symlink resolution, or checking before path exists.
**How to avoid:** Canonicalize existing roots/targets, and for not-yet-existing targets validate canonical parent + joined child intent.
**Warning signs:** Inconsistent behavior across relative paths/symlinks.

### Pitfall 4: Cleanup fails silently on cancellation
**What goes wrong:** Temp workspaces accumulate on disk.
**Why it happens:** Cancellation path kills process but skips finalizer.
**How to avoid:** Single terminal finalization function invoked by success/failure/cancel/guardrail paths.
**Warning signs:** Growing `hostlocal-*` directories in system temp.

### Pitfall 5: Branch creation fails on invalid names
**What goes wrong:** `git switch -c` fails for issue titles with unsupported characters.
**Why it happens:** Branch slug not normalized.
**How to avoid:** Deterministic slug sanitizer (lowercase ASCII, hyphen separators, bounded length) before branch command.
**Warning signs:** Failures correlated with punctuation-heavy issue titles.

### Pitfall 6: Guardrail failures don't restore board trust
**What goes wrong:** Issue remains visually in progress after blocked run.
**Why it happens:** Runtime rejection path not wired to intake revert + toast flow.
**How to avoid:** On blocked outcome, always emit rejection toast and execute revert-to-Todo flow.
**Warning signs:** In Progress column contains runs that never started.

## Code Examples

Verified patterns from official sources and current codebase:

### Tauri shell sidecar setup
```rust
// Source: https://v2.tauri.app/plugin/shell/
tauri::Builder::default()
    .plugin(tauri_plugin_shell::init())
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
```

### Sidecar spawn with events and child control
```rust
// Source: https://docs.rs/tauri-plugin-shell/latest/tauri_plugin_shell/struct.Shell.html
// Source: https://docs.rs/tauri-plugin-shell/latest/tauri_plugin_shell/process/struct.Command.html
// Source: https://docs.rs/tauri-plugin-shell/latest/tauri_plugin_shell/process/enum.CommandEvent.html
// Source: https://docs.rs/tauri-plugin-shell/latest/tauri_plugin_shell/process/struct.CommandChild.html
use tauri_plugin_shell::{process::CommandEvent, ShellExt};

let (mut rx, child) = app.shell().sidecar("hostlocal-worker")?.spawn()?;
while let Some(event) = rx.recv().await {
  if let CommandEvent::Terminated(payload) = event {
    println!("exit code: {:?}", payload.code);
  }
}
child.kill()?;
```

### Workspace temp allocation and deterministic cleanup
```rust
// Source: https://docs.rs/tempfile/latest/tempfile/struct.TempDir.html
let temp_workspace = tempfile::TempDir::new_in(std::env::temp_dir())?;
// ... execute run ...
temp_workspace.close()?;
```

### Canonical boundary check
```rust
// Source: https://doc.rust-lang.org/std/fs/fn.canonicalize.html
// Source: https://doc.rust-lang.org/std/path/struct.Path.html#method.strip_prefix
let workspace = std::fs::canonicalize(workspace_root)?;
let target = std::fs::canonicalize(target_path)?;
target.strip_prefix(&workspace).map_err(|_| "outside workspace")?;
```

### Fresh clone + issue branch creation
```bash
# Source: https://git-scm.com/docs/git-clone
# Source: https://git-scm.com/docs/git-switch
git clone "https://github.com/${OWNER}/${REPO}.git" "$WORKSPACE"
cd "$WORKSPACE"
git switch -c "hostlocal/issue-${ISSUE_NUMBER}-${SLUG}"
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Frontend seam logs only (`startAgentRunForIssue` placeholder) | Rust-owned runtime enqueue boundary with explicit outcomes | Phase 3 implementation | Enables actual local-run execution and queue semantics. |
| No process permission boundary | Capability-scoped sidecar execution through shell plugin | Tauri v2 security model | Required for SEC-02 and explicit blocked behavior. |
| Ad-hoc temp folder handling risk | `TempDir` lifecycle + centralized finalizer | Current Rust ecosystem standard | Reduces workspace leak probability across terminal paths. |
| Implicit path trust | Canonicalized path boundary checks | Current secure filesystem practice | Prevents out-of-bound command/path attempts. |

**Deprecated/outdated for this phase:**
- Starting runs from frontend-side assumptions without backend runtime acceptance.
- Any execution path that bypasses Tauri sidecar command scope.

## Open Questions

1. **Private repository clone authentication strategy for runtime workspace prep**
   - What we know: Runs must start from fresh clone and execute locally.
   - What's unclear: Exact credential handoff for private repos during clone without exposing secrets in logs.
   - Recommendation: Decide in Wave 0; require redacted logging and process env hygiene from day one.

2. **Sidecar binary packaging target for dev vs packaged builds**
   - What we know: Sidecar naming and `externalBin` handling are explicit in Tauri docs.
   - What's unclear: Whether this phase uses a minimal local dev sidecar first or full packaged sidecar artifact path.
   - Recommendation: Lock a single sidecar binary contract and naming convention now to avoid rework in Phase 4.

3. **Minimal run evidence shape outside workspace**
   - What we know: Evidence must survive cleanup; detailed observability is Phase 5.
   - What's unclear: Which exact metadata fields are persisted in Phase 3 (run id, branch, terminal status, blocked reason).
   - Recommendation: Define a minimal evidence record schema in Phase 3 plan so later phases can extend without migration churn.

4. **Queue identity key normalization**
   - What we know: One active run per repository and FIFO by acceptance time are locked.
   - What's unclear: Canonical repository key format (`owner/repo` case normalization) used for queue map keys.
   - Recommendation: Normalize to lowercase `owner/repo` for queue indexing and test this explicitly.

## Sources

### Primary (HIGH confidence)
- Local project context and code:
  - `.planning/phases/03-local-worker-runtime-boundary/03-CONTEXT.md`
  - `.planning/REQUIREMENTS.md`
  - `.planning/STATE.md`
  - `.planning/ROADMAP.md`
  - `.planning/config.json`
  - `src/features/board/hooks/useBoardInteractions.ts`
  - `src/lib/commands.ts`
  - `src/intake/policy-reasons.ts`
  - `src/intake/toast-store.ts`
  - `src-tauri/src/lib.rs`
  - `src-tauri/src/commands.rs`
  - `src-tauri/src/github_auth.rs`
  - `src-tauri/capabilities/default.json`
  - `src-tauri/tauri.conf.json`
- Official Tauri docs:
  - https://v2.tauri.app/plugin/shell/
  - https://v2.tauri.app/learn/security/using-plugin-permissions/
  - https://v2.tauri.app/learn/security/runtime-authority/
  - https://v2.tauri.app/es/security/command-scopes/
- Official tauri-plugin-shell Rust docs:
  - https://docs.rs/tauri-plugin-shell/latest/tauri_plugin_shell/struct.Shell.html
  - https://docs.rs/tauri-plugin-shell/latest/tauri_plugin_shell/process/struct.Command.html
  - https://docs.rs/tauri-plugin-shell/latest/tauri_plugin_shell/process/enum.CommandEvent.html
  - https://docs.rs/tauri-plugin-shell/latest/tauri_plugin_shell/process/struct.CommandChild.html
- Official Rust docs:
  - https://docs.rs/tempfile/latest/tempfile/struct.TempDir.html
  - https://doc.rust-lang.org/std/env/fn.temp_dir.html
  - https://doc.rust-lang.org/std/fs/fn.canonicalize.html
  - https://doc.rust-lang.org/std/path/struct.Path.html#method.strip_prefix
  - https://doc.rust-lang.org/std/path/struct.Path.html#method.starts_with
- Official Git docs:
  - https://git-scm.com/docs/git-clone
  - https://git-scm.com/docs/git-switch

### Secondary (MEDIUM confidence)
- None.

### Tertiary (LOW confidence)
- None.

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH - official Tauri/Rust/Git docs + current repo manifests and capability config.
- Architecture: HIGH - directly mapped to locked phase decisions and existing integration seam.
- Pitfalls: MEDIUM-HIGH - mostly source-backed, with some project-specific operational assumptions flagged as open questions.

**Research date:** 2026-03-03
**Valid until:** 2026-04-02
