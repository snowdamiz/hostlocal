# Phase 3: Local Worker Runtime Boundary - Context

**Gathered:** 2026-03-03
**Status:** Ready for planning

<domain>
## Phase Boundary

Every accepted run executes locally through the Rust/Tauri sidecar path in an isolated, ephemeral workspace and issue branch, with explicit command/path guardrails and automatic workspace cleanup after completion or cancellation.

</domain>

<decisions>
## Implementation Decisions

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

</decisions>

<specifics>
## Specific Ideas

- Keep `startAgentRunForIssue` in the board interaction flow as the initial runtime boundary integration seam.
- Preserve current drag semantics (`todo <-> inProgress`) while introducing queue-aware run execution behavior behind that boundary.

</specifics>

<code_context>
## Existing Code Insights

### Reusable Assets
- `src/features/board/hooks/useBoardInteractions.ts`:
  - Intake acceptance already routes into `startAgentRunForIssue` after policy checks.
  - Existing optimistic board updates and background item refresh behavior can remain the trigger shell.
- `src/intake/toast-store.ts` and `src/components/IntakeToastViewport.tsx`:
  - Existing rejection-toast pipeline can carry guardrail failure outcomes.
- `src/lib/commands.ts`:
  - Central typed invoke wrappers are ready for runtime command additions.
- `src-tauri/src/commands.rs`:
  - Existing development-folder and project-path flows provide local path context for runtime prep.

### Established Patterns
- Frontend-to-backend calls are command-based through `invoke` wrappers (`src/lib/commands.ts`) and `#[tauri::command]` handlers.
- Intake acceptance is backend-authoritative before run start behavior is attempted.
- Current board state integrity relies on explicit accepted/rejected outcomes and clear user-visible feedback.

### Integration Points
- Extend `startAgentRunForIssue` path in `src/features/board/hooks/useBoardInteractions.ts` to hand off accepted issues into local runtime execution.
- Add and register runtime boundary commands via `src/lib/commands.ts` and `src-tauri/src/lib.rs`.
- Reuse existing toast-based rejection surface for explicit guardrail block outcomes.

</code_context>

<deferred>
## Deferred Ideas

None - discussion stayed within phase scope.

</deferred>

---

*Phase: 03-local-worker-runtime-boundary*
*Context gathered: 2026-03-03*
