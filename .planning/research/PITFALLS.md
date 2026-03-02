# Pitfalls Research

**Domain:** Local-only autonomous issue-to-PR workers in a Tauri desktop app
**Researched:** 2026-03-02
**Confidence:** HIGH

## Critical Pitfalls

### Pitfall 1: Unbounded Task Scope

**What goes wrong:**
Agent attempts broad feature work, multi-module refactors, or hidden infra changes; runs fail or produce unsafe PRs.

**Why it happens:**
"Solve the issue" is interpreted too literally without strict eligibility boundaries.

**How to avoid:**
Implement a hard scope gate before run start (allowed task types, max file count, forbidden paths, and confidence threshold).

**Warning signs:**
Large diff previews, migration files in patch, repeated retries, run time growing far beyond budget.

**Phase to address:**
Phase 1 (policy + eligibility gate foundation).

---

### Pitfall 2: Over-Permissive Sidecar Execution

**What goes wrong:**
Local worker can execute arbitrary commands/filesystem actions beyond intended repo scope.

**Why it happens:**
Developers enable broad shell permissions for convenience during prototyping and forget to tighten them.

**How to avoid:**
Use capability-scoped shell permissions/allowlists and enforce repo-root working directory constraints.

**Warning signs:**
Generic `allow execute` permissions, commands run outside workspace root, missing command audit logs.

**Phase to address:**
Phase 1 (security boundary and command policy).

---

### Pitfall 3: Workspace Contamination Between Runs

**What goes wrong:**
Changes leak across tasks, dirty worktrees accumulate, wrong branch gets pushed.

**Why it happens:**
Reusing a single repo checkout for all runs with ad-hoc reset logic.

**How to avoid:**
Use per-run linked worktrees with deterministic naming and mandatory cleanup on terminal states.

**Warning signs:**
Unexpected modified files before run start, branch mismatch errors, cleanup failures after cancel.

**Phase to address:**
Phase 2 (workspace manager + lifecycle invariants).

---

### Pitfall 4: API Throttling and Secondary Rate Limits

**What goes wrong:**
PR/comments/status updates fail intermittently, causing user-visible "stuck" runs.

**Why it happens:**
Bursting mutative GitHub calls without queued pacing and backoff behavior.

**How to avoid:**
Implement per-run/per-user request queue, retry with jitter, honor `Retry-After`, and avoid polling bursts.

**Warning signs:**
Frequent `403`/abuse-limit responses, repeated retries on write endpoints, duplicated PR comments.

**Phase to address:**
Phase 3 (GitHub writeback reliability).

---

### Pitfall 5: Assuming Webhooks Work Locally

**What goes wrong:**
Design depends on GitHub webhooks to `localhost`; events never arrive in local desktop app.

**Why it happens:**
Webhook mental model copied from server apps without checking desktop-local constraints.

**How to avoid:**
Use polling with ETag/conditional requests and bounded intervals for local-only v1.

**Warning signs:**
No callback traffic despite successful webhook registration attempts; reliance on tunnel hacks for core flow.

**Phase to address:**
Phase 3 (integration strategy and sync reliability).

---

### Pitfall 6: Non-Deterministic Run State / No Recovery

**What goes wrong:**
App restart/crash leaves orphaned processes or unknown run status; user cannot trust current state.

**Why it happens:**
Run progress held only in memory and not checkpointed.

**How to avoid:**
Persist every transition/checkpoint in SQLite and reconcile on startup (resume, mark failed, or cleanup).

**Warning signs:**
"In progress" UI cards with no active worker, missing terminal statuses, manual DB edits to recover.

**Phase to address:**
Phase 1-2 (state machine + persistence before full automation).

---

### Pitfall 7: Weak Validation Contracts

**What goes wrong:**
PR marked "ready" even when tests were skipped, flaky, or partial; trust collapses.

**Why it happens:**
Validation treated as best-effort command execution without normalized result semantics.

**How to avoid:**
Define explicit validation contract (`pass|fail|not-found|timeout`) and expose evidence artifacts in sidebar.

**Warning signs:**
Runs succeed with "no tests run" silently, inconsistent status labels, missing logs/artifacts.

**Phase to address:**
Phase 4 (validation and evidence model).

---

### Pitfall 8: Missing User Control During Long Runs

**What goes wrong:**
Users feel locked out while agent runs; they kill app/process externally and lose state.

**Why it happens:**
System ships with logs only, without pause/abort/steer controls and acknowledgements.

**How to avoid:**
Implement control channel (pause/resume/abort/instruction) with explicit ack and state transitions.

**Warning signs:**
Force-quit usage, repeated duplicate runs for same issue, support requests about "stuck" agent behavior.

**Phase to address:**
Phase 2-3 (control plane + UI integration).

## Technical Debt Patterns

| Shortcut | Immediate Benefit | Long-term Cost | When Acceptable |
|----------|-------------------|----------------|-----------------|
| Reuse one checkout for all runs | Faster prototype | Cross-run contamination, branch confusion, hard rollback | Never for production flow |
| Store run state only in memory | Less schema work | No crash recovery, orphaned runs | Only in throwaway spike branch |
| Skip structured event schema | Faster logging | UI parsing drift and brittle contracts | Never once sidebar is user-facing |
| Hardcode validation command list | Simple initial implementation | Fails across heterogeneous repos | Acceptable only if explicitly limited to one internal repo |

## Integration Gotchas

| Integration | Common Mistake | Correct Approach |
|-------------|----------------|------------------|
| GitHub REST | No version header and naive retries | Set API version, queue writes, use jittered backoff, inspect rate-limit headers |
| GitHub webhooks | Build local flow around webhook callbacks | For desktop-local v1 use polling + ETag; webhooks are optional future cloud path |
| Tauri shell/sidecar | Enable broad shell permissions globally | Use explicit capability allowlists and command-specific permissions |
| Git worktree | Create worktrees without deterministic cleanup | Record worktree path per run and always cleanup on terminal state |

## Performance Traps

| Trap | Symptoms | Prevention | When It Breaks |
|------|----------|------------|----------------|
| Full network clone per run | Long startup before first token generated | Maintain local mirror + linked worktree strategy | Medium/large repos or poor network |
| Mandatory container VM runtime | High CPU/RAM floor, cold-start lag | Start with native sidecar process isolation | On laptops and battery-constrained machines |
| Verbose raw logs to UI at full rate | Sidebar jank and dropped frames | Emit structured milestones + sampled detail logs | Multi-minute runs with high stdout volume |
| Unlimited parallel runs | Resource contention and failure cascades | Concurrency cap + queued scheduling | More than 1 active run on modest hardware |

## Security Mistakes

| Mistake | Risk | Prevention |
|---------|------|------------|
| Logging OAuth/access tokens | Credential leakage in UI/artifacts | Redact secrets at source and in sink; never print auth headers/env |
| Passing issue text directly to shell | Command injection and arbitrary execution | Treat issue text as data only; command templates must be static/allowlisted |
| Allowing writes outside repo workspace | Local file damage/exfiltration risk | Chroot-like path checks, canonicalize + enforce workspace root boundaries |
| Auto-merge generated PRs | Unsafe code reaches default branch | Keep explicit user review/merge gate in v1 |

## UX Pitfalls

| Pitfall | User Impact | Better Approach |
|---------|-------------|-----------------|
| Status labels are too coarse | Users cannot tell if run is healthy or stuck | Show deterministic stage and elapsed time per stage |
| No actionable failure reason | Users retry blindly and lose trust | Provide concise failure cause + suggested next action |
| Steering commands have no acknowledgement | Users unsure if instruction was applied | Return command ack event and show resulting state change |
| Hidden validation evidence | Users do not trust "ready" status | Link test summary and artifact pointers directly in sidebar |

## "Looks Done But Isn't" Checklist

- [ ] **Issue trigger:** moving card creates a persisted job record (not only in-memory).
- [ ] **Isolation:** each run uses a unique worktree and branch, cleaned after completion/cancel.
- [ ] **Safety boundary:** disallowed task types are blocked before sidecar start.
- [ ] **Validation:** run cannot become "ready" without explicit validation result state.
- [ ] **GitHub publish:** PR creation failures transition to recoverable failed state with retry path.
- [ ] **User controls:** pause/abort/steer actions return ack and appear in timeline.
- [ ] **Recovery:** app restart reconciles active/orphaned runs deterministically.

## Recovery Strategies

| Pitfall | Recovery Cost | Recovery Steps |
|---------|---------------|----------------|
| Workspace contamination | MEDIUM | Abort run, snapshot diff, remove worktree, recreate fresh workspace, replay from checkpoint |
| API throttling | LOW | Backoff queue reset, replay pending write operations idempotently |
| Orphaned run after crash | MEDIUM | Startup reconciliation: inspect process liveness, mark stale states, cleanup artifacts |
| Over-permissive command config | HIGH | Rotate tokens if exposed, tighten capabilities, audit recent command history |
| False "ready" due validation gap | MEDIUM | Re-run validation with strict contract and update PR status/comment |

## Pitfall-to-Phase Mapping

| Pitfall | Prevention Phase | Verification |
|---------|------------------|--------------|
| Unbounded task scope | Phase 1 | Rejected out-of-scope issues are blocked with explicit reason |
| Over-permissive sidecar execution | Phase 1 | Security tests confirm denied commands/paths |
| Workspace contamination | Phase 2 | Repeated runs show isolated clean worktrees |
| Missing user control | Phase 2 | Pause/abort/steer round-trip tested in UI timeline |
| API throttling / webhook assumptions | Phase 3 | Simulated rate-limit and polling scenarios pass |
| Weak validation contracts | Phase 4 | "Ready" status requires test/visual evidence contract |
| No crash recovery | Phase 5 | Forced app restart resumes/reconciles runs safely |

## Sources

- [GitHub REST best practices](https://docs.github.com/rest/guides/best-practices-for-integrators)
- [GitHub REST rate limits](https://docs.github.com/enterprise-cloud%40latest/rest/overview/rate-limits-for-the-rest-api)
- [GitHub webhook troubleshooting](https://docs.github.com/en/webhooks/testing-and-troubleshooting-webhooks/troubleshooting-webhooks)
- [Tauri shell plugin docs](https://v2.tauri.app/es/plugin/shell/)
- [Tauri sidecar docs](https://v2.tauri.app/fr/develop/sidecar/)
- [Tauri permissions/capabilities docs](https://v2.tauri.app/reference/acl/capability/)
- [Tauri calling frontend docs](https://v2.tauri.app/es/develop/calling-frontend/)
- [Git `worktree` docs](https://git-scm.com/docs/git-worktree.html)
- [Docker Desktop install requirements](https://docs.docker.com/desktop/setup/install/mac-install/)
- [Podman machine docs](https://docs.podman.io/en/v4.9.0/markdown/podman-machine.1.html)

---
*Pitfalls research for: local issue-to-PR automation in a Tauri desktop app*
*Researched: 2026-03-02*
