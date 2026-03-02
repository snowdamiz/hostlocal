# Phase 2: Policy-Gated Issue Intake - Research

**Researched:** 2026-03-02
**Domain:** GitHub-backed issue intake gating (SolidJS + Tauri + GitHub REST)
**Confidence:** HIGH

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

### Policy Criteria
- Intake is label-gated.
- Label matching uses a prefix-family rule, not a single exact label.
- Even with a matching intake label prefix, intake is rejected unless the item is an open issue with non-empty body text.
- Conflict handling is fail-closed: if out-of-scope signals are present (for example large/epic style markers), intake is rejected.

### Trigger Semantics
- Intake fires only on completed drop into `In Progress` (never on drag-over).
- Only `Todo -> In Progress` moves can trigger intake.
- Duplicate starts are disallowed for the same issue while a prior intake outcome is unresolved.
- `In Progress` must be GitHub-backed, not local-only board state.
- Agent ownership is represented on GitHub via an `agent:*` label prefix.
- Default In Progress inclusion rule is: open issue + intake label + `agent:*` label.
- If required GitHub label persistence fails during move-to-In-Progress, intake is rejected and board state reverts (no run starts).

### Card Interaction Behavior
- Drag initiation should use a dedicated drag handle model (card click remains available for selection/details).
- Canvas interactions should prevent accidental text selection/highlighting during drag interactions.

### Rejection UX
- Rejections are surfaced through a global toast notification system.
- Toast content includes the violated rule plus an actionable fix hint.
- On rejection, the card reverts to Todo to preserve In Progress integrity.
- Repeated identical rejection attempts should collapse into a counter-based toast behavior instead of duplicating separate toasts.

### Claude's Discretion
- Exact intake label prefix naming.
- Exact deny-signal list for conflict rejection.
- Precise drag-handle affordance and drag threshold details.
- Toast timing/placement/animation and counter reset window.

### Deferred Ideas (OUT OF SCOPE)
None - discussion stayed within phase scope.
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| INTK-01 | User can move an issue from Todo to In Progress to start an agent run when policy checks pass. | Intake should be implemented as a single policy+GitHub-persist gate command, invoked only on completed `Todo -> In Progress` drop, with success triggering run start and GitHub-truth column refresh. |
| INTK-02 | User receives a clear rejection reason when an issue is outside the small-task policy boundary. | Return structured rejection reason codes + fix hints from policy evaluation, and map them into deduplicated global toasts so user gets explicit remediation guidance. |
</phase_requirements>

## Summary

Phase 2 should be planned as a transactional intake boundary, not as a UI-only drag state change. The board drop is the trigger, but acceptance must be decided against GitHub truth (issue state/body/labels/type) and only become visible as `In Progress` if required GitHub labels are actually persisted. This matches the phase constraints and avoids false-positive starts.

The existing architecture already supports the needed pattern: Solid state orchestration in `MainLayout`, typed invoke wrappers in `src/lib/commands.ts`, and async Rust `#[tauri::command]` handlers returning `Result<_, String>`. The main gap is a dedicated intake command path that performs policy check + GitHub write + verification, then returns structured accepted/rejected results.

GitHub API behavior introduces two planning-critical details: issues endpoints include pull requests (must reject those using `pull_request` marker), and write endpoints can fail or be rate-limited (including secondary limits), so intake writes should be serialized and retried with rate-limit-aware behavior where applicable.

**Primary recommendation:** Implement `Todo -> In Progress` intake as a single backend-authoritative gate command that returns explicit policy outcomes and only starts a run after confirmed GitHub label persistence.

## Standard Stack

### Core

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| SolidJS | `^1.9.3` | Board interaction state and drop handling | Existing UI runtime; lowest-risk integration with current signals/memos in `MainLayout`. |
| Tauri command bridge (`@tauri-apps/api` + `#[tauri::command]`) | JS `^2.10.1`, Rust `2.x` | Enforce policy and GitHub writes at backend boundary | Existing project pattern; strongly typed invoke surface and native-side control. |
| GitHub REST API (Issues + Labels) | `2022-11-28` | Source of truth for issue eligibility and label persistence | Official, versioned API with explicit endpoint behavior and status/error semantics. |
| reqwest | `0.12` | Rust HTTP client for GitHub API calls | Already in codebase and used for all GitHub operations. |

### Supporting

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| HTML Drag and Drop API | Web standard | Reliable drag lifecycle (`dragstart` -> `dragover` -> `drop`) | Keep existing drag model; refine to handle-only drag initiation. |
| CSS `user-select` | Web standard | Prevent accidental text selection during drag | Apply to drag handle/card regions while preserving normal reading/copy elsewhere. |
| GitHub rate-limit headers (`retry-after`, `x-ratelimit-*`) | API protocol | Backoff/queue behavior for mutative calls | Use whenever GitHub returns `403/429` on intake writes. |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| `POST /issues/{issue_number}/labels` for additive writes | `PATCH /issues/{issue_number}` with full `labels` replacement | `PATCH` can replace full label set and is riskier for accidental label loss; additive endpoint is safer for this phase's ownership-label add flow. |
| GitHub-truth in-progress derivation | Local optimistic-only `manualColumnByItemId` | Faster UI-only transitions but violates locked decision (`In Progress` must be GitHub-backed). |
| Native HTML DnD with dedicated handle | Third-party DnD library | Libraries can improve ergonomics but add dependency and migration scope; native DnD is already integrated and sufficient for phase goals. |

**Installation:**
```bash
# No new package is required for the recommended baseline.
# Reuse existing Solid + Tauri + reqwest stack.
```

## Architecture Patterns

### Recommended Project Structure

```text
src/
├── components/
│   └── MainLayout.tsx              # drop trigger wiring + UI reactions
├── lib/
│   └── commands.ts                 # typed intake command wrappers
└── intake/
    ├── intake-state.ts             # pending/outcome dedupe keyed by issue id
    ├── policy-reasons.ts           # reason-code -> user hint mapping
    └── toast-store.ts              # global toast + collapse counter behavior

src-tauri/src/
├── github_auth.rs                  # reuse auth token/session access
├── github_intake.rs                # policy gate + label persistence commands
└── lib.rs                          # command registration
```

### Pattern 1: Backend-Authoritative Intake Transaction
**What:** One command evaluates policy against latest GitHub issue data, persists required labels, verifies persistence, and returns `accepted` or structured `rejected` outcome.
**When to use:** Every `Todo -> In Progress` drop attempt.
**Example:**
```rust
// Source: https://v2.tauri.app/develop/calling-rust/
// Source: https://docs.github.com/en/rest/issues/issues?apiVersion=2022-11-28
// Source: https://docs.github.com/en/rest/issues/labels?apiVersion=2022-11-28
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct IntakeOutcome {
    accepted: bool,
    reason_code: Option<String>,
    fix_hint: Option<String>,
}

#[tauri::command]
async fn github_attempt_issue_intake(
    state: tauri::State<'_, GithubAuthState>,
    repository_full_name: String,
    issue_number: i64,
    required_agent_label: String,
    intake_label_prefix: String,
) -> Result<IntakeOutcome, String> {
    // 1) Fetch authoritative issue from GitHub
    // 2) Reject non-issue/closed/empty-body/out-of-policy
    // 3) Add required labels via GitHub API
    // 4) Re-fetch and verify labels are truly present
    // 5) Return accepted/rejected without starting run on rejection
    todo!()
}
```

### Pattern 2: Trigger Guard at Drop Boundary
**What:** Trigger intake only on completed drop into `In Progress` from `Todo`, never on drag-over.
**When to use:** UI drop handler in board column component.
**Example:**
```ts
// Source: https://developer.mozilla.org/en-US/docs/Web/API/HTML_Drag_and_Drop_API
if (fromColumn !== "todo" || toColumn !== "inProgress") return;
if (pendingByIssueId[issue.id]) return; // unresolved outcome guard

pendingByIssueId[issue.id] = true;
const outcome = await githubAttemptIssueIntake({ ... });
pendingByIssueId[issue.id] = false;

if (!outcome.accepted) {
  showPolicyToast(outcome.reasonCode, outcome.fixHint);
  revertCardToTodo(issue.id);
  return;
}

await startAgentRun(issue.id); // only after accept
await refreshRepositoryItems(); // GitHub-truth board state
```

### Pattern 3: Dedicated Drag Handle, Clickable Card
**What:** Keep card body for selection/details, make only handle draggable.
**When to use:** Card rendering in `MainLayout`.
**Example:**
```tsx
// Source: https://developer.mozilla.org/en-US/docs/Web/API/HTML_Drag_and_Drop_API
<article class="kanban-card" onClick={() => setSelectedBoardItemId(item.id)}>
  <button
    class="kanban-card-drag-handle"
    draggable="true"
    onDragStart={(event) => handleCardDragStart(event, item.id)}
    onDragEnd={handleCardDragEnd}
    aria-label="Drag issue"
  >
    :::
  </button>
  {/* rest of card remains click-selectable */}
</article>
```

### Pattern 4: Structured Rejection Taxonomy
**What:** Use stable reason codes (e.g., `missing_intake_label`, `empty_body`, `is_pull_request`, `deny_signal_present`, `label_persist_failed`) with UI hint mapping.
**When to use:** Every rejection path from policy gate.
**Example:**
```ts
const reasonHintMap: Record<string, string> = {
  missing_intake_label: "Add an intake label (for example intake:small).",
  empty_body: "Add implementation details in the issue body.",
  is_pull_request: "Move issues only; PR cards are not intake-eligible.",
  deny_signal_present: "Remove epic/large-scope markers or split the work.",
  label_persist_failed: "Retry after GitHub label write succeeds.",
};
```

### Anti-Patterns to Avoid
- **Run-start before GitHub write confirmation:** Can create execution side effects for rejected or stale items.
- **Duplicated policy logic across frontend/backend:** Drifts quickly and creates conflicting accept/reject behavior.
- **Local-only in-progress truth:** Violates locked decision and causes board/run desync.
- **String-only rejection errors:** Prevents deterministic toast collapse and actionable user guidance.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Issue vs PR detection | Title/URL heuristics | `pull_request` marker from GitHub Issues API payload | Official and deterministic; avoids false classification. |
| Label persistence semantics | Local label mutation assumptions | GitHub labels/issue write endpoints + post-write verification fetch | Prevents false accepts when writes fail, are dropped, or race. |
| Rate-limit handling | Immediate blind retries | Header-driven backoff (`retry-after`, `x-ratelimit-reset`) + serialized queue | Avoids secondary-limit loops and integration bans. |
| Drag data transport | Ad-hoc globals only | `dataTransfer.setData` at `dragstart`, read at `drop` | Aligns with browser drag lifecycle and event constraints. |

**Key insight:** Intake reliability comes from treating GitHub as authoritative state and making run-start contingent on verified, policy-compliant mutation success.

## Common Pitfalls

### Pitfall 1: Accepting PR cards as issues
**What goes wrong:** PRs move into `In Progress` and attempt intake.
**Why it happens:** GitHub Issues endpoints return both issues and PRs.
**How to avoid:** Require `isPullRequest === false` (or absent `pull_request`) in policy check.
**Warning signs:** Rejections later fail with PR-specific API behavior or incorrect run context.

### Pitfall 2: Drop succeeds visually but labels did not persist
**What goes wrong:** UI shows in-progress intent, but required labels were not applied in GitHub.
**Why it happens:** Write failure, permissions mismatch, or stale mutation assumptions.
**How to avoid:** Re-fetch issue after write and verify required labels before accepting intake.
**Warning signs:** Card appears in progress locally, disappears after refresh, no durable GitHub label state.

### Pitfall 3: Duplicate starts from repeated drops while pending
**What goes wrong:** Multiple run starts fire for same issue.
**Why it happens:** Missing per-issue pending/outcome guard.
**How to avoid:** Track unresolved intake state per issue ID; reject/ignore duplicate attempts until resolved.
**Warning signs:** Rapid repeated drag attempts create multiple command invocations.

### Pitfall 4: Drop handler never fires in target column
**What goes wrong:** User drags but release does nothing.
**Why it happens:** `dragover` target does not call `preventDefault`, so element is not a valid drop target.
**How to avoid:** Keep explicit `event.preventDefault()` in `onDragOver` for drop columns.
**Warning signs:** Browser “failed drop” animation and no `drop` event.

### Pitfall 5: Secondary rate limit lockouts during rapid retries
**What goes wrong:** Repeated `403/429` and intake instability.
**Why it happens:** Concurrent or too-frequent mutative requests.
**How to avoid:** Serialize mutative intake writes and honor `retry-after` / `x-ratelimit-reset`.
**Warning signs:** Bursts of `403`/`429`, intermittent label-write failures under load.

## Code Examples

Verified patterns from official sources:

### Add labels and verify before accept
```rust
// Source: https://docs.github.com/en/rest/issues/labels?apiVersion=2022-11-28
// Source: https://docs.github.com/en/rest/issues/issues?apiVersion=2022-11-28
async fn persist_required_labels_and_verify(...) -> Result<bool, String> {
    // POST /repos/{owner}/{repo}/issues/{issue_number}/labels
    // then GET /repos/{owner}/{repo}/issues/{issue_number}
    // return true only if required labels now exist in returned issue payload
    todo!()
}
```

### Drag/drop minimum correctness contract
```ts
// Source: https://developer.mozilla.org/en-US/docs/Web/API/HTML_Drag_and_Drop_API
function onDragStart(ev: DragEvent, itemId: number) {
  ev.dataTransfer?.setData("text/plain", String(itemId));
}

function onDragOver(ev: DragEvent) {
  ev.preventDefault(); // required for drop target
}

function onDrop(ev: DragEvent) {
  ev.preventDefault();
  const itemId = Number(ev.dataTransfer?.getData("text/plain"));
  if (!Number.isFinite(itemId)) return;
  // trigger intake gate
}
```

### Collapsing repeated rejection toasts
```ts
interface IntakeToastState {
  key: string;
  count: number;
  lastAtMs: number;
}

function collapseToast(state: IntakeToastState | null, key: string, now: number): IntakeToastState {
  if (!state || state.key !== key || now - state.lastAtMs > 8000) {
    return { key, count: 1, lastAtMs: now };
  }
  return { key, count: state.count + 1, lastAtMs: now };
}
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Local board override drives `In Progress` (`manualColumnByItemId`) | GitHub-authoritative inclusion rule (`open issue + intake label + agent:*`) | Phase 2 scope | Eliminates UI/backend drift and enforces policy boundary at source of truth. |
| Generic string failures from command errors | Structured policy reason codes with fix hints | Phase 2 scope | Enables clear INTK-02 UX and deterministic toast dedupe. |
| Uncoordinated write attempts | Serialized mutative requests with rate-limit-aware retry behavior | Current GitHub REST best practices | Reduces 403/429 churn and prevents repeated write-side failures. |

**Deprecated/outdated:**
- Local-only drag outcome as run trigger truth: replaced by backend-authoritative intake acceptance.

## Open Questions

1. **Canonical intake label prefix**
   - What we know: Prefix-family rule is locked; exact prefix string is discretionary.
   - What's unclear: Final accepted prefix namespace (`intake:`, `task:`, etc.).
   - Recommendation: Lock a single canonical prefix in plan Wave 0 and use shared constant across frontend/backend.

2. **Deny-signal list**
   - What we know: Conflict rejection must be fail-closed on out-of-scope markers.
   - What's unclear: Final deny markers (labels/title/body keywords).
   - Recommendation: Start with label-based deny list (most deterministic), then optionally extend to title/body keyword checks with explicit false-positive policy.

3. **Run start contract before later runtime phases**
   - What we know: Accepted intake must start a run automatically (INTK-01), but full runtime orchestration lands in later phases.
   - What's unclear: Whether Phase 2 uses a minimal enqueue/stub contract or introduces early runtime scaffolding.
   - Recommendation: Define a minimal `start_agent_run(issue)` boundary now (can be stubbed) so Phase 2 and Phase 3 integrate without reworking intake API.

4. **Agent ownership label value strategy**
   - What we know: Prefix is `agent:*`.
   - What's unclear: Canonical default value (`agent:hostlocal`, `agent:codex`, etc.) and whether user-selectable.
   - Recommendation: Pick one deterministic default in Phase 2 and defer configurability.

## Sources

### Primary (HIGH confidence)
- Project context and constraints:
  - `.planning/phases/02-policy-gated-issue-intake/02-CONTEXT.md`
  - `.planning/REQUIREMENTS.md`
  - `.planning/STATE.md`
- Existing implementation surfaces:
  - `src/components/MainLayout.tsx`
  - `src/lib/commands.ts`
  - `src-tauri/src/github_auth.rs`
  - `src-tauri/src/lib.rs`
  - `src-tauri/Cargo.toml`
- GitHub Docs (official):
  - https://docs.github.com/en/rest/issues/issues?apiVersion=2022-11-28
  - https://docs.github.com/en/rest/issues/labels?apiVersion=2022-11-28
  - https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api?apiVersion=2022-11-28
  - https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api?apiVersion=2022-11-28
- Tauri Docs (official):
  - https://v2.tauri.app/develop/calling-rust/
- MDN (official web platform docs):
  - https://developer.mozilla.org/en-US/docs/Web/API/HTML_Drag_and_Drop_API
  - https://developer.mozilla.org/en-US/docs/Web/CSS/user-select

### Secondary (MEDIUM confidence)
- Solid event handling/delegation reference:
  - https://docs.solidjs.com/concepts/components/event-handlers

### Tertiary (LOW confidence)
- None.

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH - verified from current repository manifests/code and official runtime/API docs.
- Architecture: HIGH - directly grounded in existing code paths and locked phase constraints.
- Pitfalls: HIGH - backed by official GitHub/MDN docs and observed current implementation patterns.

**Research date:** 2026-03-02
**Valid until:** 2026-04-01
