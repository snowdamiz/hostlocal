# Project Research Summary

**Project:** HostLocal
**Domain:** Local-only autonomous issue-to-PR workflow in a desktop app
**Researched:** 2026-03-02
**Confidence:** HIGH

## Executive Summary

This project fits a local orchestration product pattern: a desktop control plane that triggers deterministic worker runs, streams progress, and publishes review-ready PRs. Research indicates the fastest reliable path is to keep execution local and ephemeral, using a bounded sidecar process model rather than introducing cloud infrastructure or heavy container VM requirements in v1.

The recommended implementation stack is Rust-first orchestration inside the existing Tauri v2 host, with strict permission scoping, per-run isolated git worktrees, and a durable SQLite-backed run state machine. GitHub integration should use versioned REST calls with queued writes/backoff, and browser validation should be optional/repo-aware (reuse existing test tooling when present).

Primary risks are safety drift (scope creep and shell permissions), reliability drift (non-deterministic run states), and publish instability (rate limits + local webhook assumptions). These are preventable if phase ordering prioritizes policy boundaries, deterministic state, and integration reliability before advanced optimizations.

## Key Findings

### Recommended Stack

The strongest fit is:
- Tauri v2 command boundary + channels for control/stream separation.
- Rust orchestration modules with Tokio runtime for async process and timeout control.
- Per-run `git worktree` isolation for speed + cleanup.
- GitHub REST via typed client (`octocrab`) with explicit API versioning and paced write queue.
- SQLite + keychain for durable run state and secure credentials.
- Optional Playwright-driven visual validation only when repositories already include browser test surfaces.

**Core technologies:**
- **Tauri + shell sidecar plugin:** secure local command execution and desktop-native integration.
- **Rust + Tokio:** deterministic orchestration, cancellation, and streaming.
- **Git worktree + GitHub REST:** efficient repo isolation and PR publication loop.

### Expected Features

The feature research identified a clear MVP boundary aligned to your goal flow.

**Must have (table stakes):**
- Issue eligibility gate (small-task-only policy)
- Ephemeral local workspace + deterministic run state machine
- Live sidebar activity stream
- User steering controls (pause/abort/instruction)
- GitHub writeback loop (branch/commit/PR/status)
- Validation pipeline with explicit outcomes

**Should have (competitive):**
- Checkpointed patch approval mode
- Smart branch/PR authoring
- Adaptive task budgeting

**Defer (v2+):**
- Warm-start caching and replay bundles
- Remote/cloud workers (explicitly out for current scope)

### Architecture Approach

The recommended architecture is a split control/data plane:
- Command plane: `invoke` APIs for start/pause/abort/steer.
- Data plane: channel-based structured event stream for timeline/logs.
- Core: policy gate -> job state machine -> workspace manager -> sidecar runner -> validation -> GitHub publish.
- Persistence: SQLite checkpoints for resume/recovery and artifact pointers.

**Major components:**
1. **Run Orchestrator** — owns state transitions and lifecycle invariants.
2. **Workspace/Execution Layer** — provisions isolated run environment and executes sidecar tasks.
3. **UI Observability/Control Layer** — displays progress and allows user steering in real time.

### Critical Pitfalls

1. **Unbounded task scope** — prevent with strict preflight eligibility policy.
2. **Over-permissive sidecar execution** — prevent with capability allowlists and path constraints.
3. **Workspace contamination** — prevent with per-run worktree lifecycle and mandatory cleanup.
4. **GitHub API throttling and localhost webhook assumptions** — prevent with queued writes + ETag polling.
5. **Missing deterministic recovery** — prevent with persisted transitions/checkpoints and startup reconciliation.

## Implications for Roadmap

Based on research, suggested phase structure:

### Phase 1: Policy + Execution Boundary
**Rationale:** Safety and scope boundaries must exist before autonomous edits.
**Delivers:** Eligibility gate, permission-scoped sidecar command surface, run-state schema foundations.
**Addresses:** TS-1, TS-3, TS-9
**Avoids:** Unbounded scope, over-permissive execution pitfalls.

### Phase 2: Deterministic Local Run Core
**Rationale:** The issue->run loop must be reliable before adding rich UX.
**Delivers:** Job state machine, worktree lifecycle manager, start/stop control primitives.
**Uses:** Rust/Tokio + SQLite + git worktree.
**Implements:** Core orchestrator + workspace components.

### Phase 3: GitHub Writeback + Control Plane
**Rationale:** User value is incomplete until successful PR publication and steering.
**Delivers:** Branch/commit/push/PR flow, comments/status updates, pause/abort/steer channel.
**Uses:** GitHub REST queue/backoff and versioned API headers.
**Implements:** GitHub integration + control channel.

### Phase 4: Observability + Validation Evidence
**Rationale:** Trust depends on transparent progress and clear validation outcomes.
**Delivers:** Sidebar timeline stream, structured logs, validation contract, artifact links.
**Uses:** Tauri channels/events and test/visual check runners.
**Implements:** Event bridge + validation subsystem.

### Phase 5: Recovery, Hardening, and UX Polish
**Rationale:** Production quality requires resilience and failure ergonomics.
**Delivers:** Crash reconciliation, retry workflows, actionable failure UX, performance tuning.
**Uses:** Persisted checkpoints + cleanup guarantees.
**Implements:** Recovery/hardening layer across all prior components.

### Phase Ordering Rationale

- Safety boundaries first reduce blast radius before autonomous code changes.
- Deterministic orchestration must precede high-volume streaming and polished UX.
- GitHub writeback reliability is foundational to the core promise (issue -> PR).
- Validation and observability become meaningful once runs are stable and publish-capable.
- Recovery and optimization are most effective after base control/data flows exist.

### Research Flags

Phases likely needing deeper research during planning:
- **Phase 1:** Sidecar permission model hardening across macOS/Windows/Linux differences.
- **Phase 3:** GitHub secondary rate-limit behavior under bursty local usage patterns.
- **Phase 4:** Standardized visual validation strategy for repos without existing browser tests.

Phases with standard patterns (skip research-phase):
- **Phase 2:** Worktree lifecycle and deterministic state machine are well-established patterns.
- **Phase 5:** Crash recovery/checkpoint reconciliation patterns are straightforward once schema exists.

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| Stack | HIGH | Backed by official Tauri, GitHub, Git, and crate documentation.
| Features | HIGH | Strong alignment with user goal flow and current local-only constraints.
| Architecture | HIGH | Direct fit for existing Tauri/Solid brownfield baseline.
| Pitfalls | HIGH | Validated against official docs + common failure patterns in local orchestration.

**Overall confidence:** HIGH

### Gaps to Address

- **Cross-platform sidecar edge cases:** Verify permission/argv behavior on each target OS during Phase 1.
- **Visual check baseline selection:** Define fallback policy when repositories lack browser tests.
- **Agent steering protocol:** Finalize instruction format and interruption semantics before UI lock-in.

## Sources

### Primary (HIGH confidence)
- [Tauri shell plugin docs](https://v2.tauri.app/es/plugin/shell/) — sidecar, permissions, setup
- [Tauri sidecar docs](https://v2.tauri.app/fr/develop/sidecar/) — binary execution model
- [Tauri frontend communication docs](https://v2.tauri.app/es/develop/calling-frontend/) — events/channels
- [GitHub REST pull requests](https://docs.github.com/en/rest/reference/pulls) — PR lifecycle operations
- [GitHub REST best practices](https://docs.github.com/rest/guides/best-practices-for-integrators) — queue/backoff guidance
- [GitHub REST rate limits](https://docs.github.com/enterprise-cloud%40latest/rest/overview/rate-limits-for-the-rest-api) — primary/secondary limits
- [GitHub webhook troubleshooting](https://docs.github.com/en/webhooks/testing-and-troubleshooting-webhooks/troubleshooting-webhooks) — localhost limitations
- [Git worktree docs](https://git-scm.com/docs/git-worktree.html) — per-run workspace strategy

### Secondary (MEDIUM confidence)
- [Tauri crate release index](https://docs.rs/crate/tauri/latest/builds) — current v2 release line
- [Tokio crate docs](https://docs.rs/crate/tokio/latest) — runtime baseline
- [Octocrab crate docs](https://docs.rs/octocrab/latest/octocrab/) — typed GitHub client approach
- [Playwright release notes](https://playwright.dev/docs/release-notes) — visual testing baseline

### Tertiary (LOW confidence)
- [Docker Desktop install requirements](https://docs.docker.com/desktop/setup/install/mac-install/) — resource overhead context
- [Podman machine docs](https://docs.podman.io/en/v4.9.0/markdown/podman-machine.1.html) — VM-based local container model trade-offs

---
*Research completed: 2026-03-02*
*Ready for roadmap: yes*
