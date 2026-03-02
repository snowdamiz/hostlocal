# Roadmap: HostLocal

## Overview

This roadmap delivers the local issue-to-PR loop in requirement-driven phases: Tailwind v4 styling foundation, policy-gated intake, isolated local execution, deterministic orchestration, live observability, user control, validation gating, automated PR publication, and reliable review notification. Each phase adds a complete user-visible capability and unblocks the next boundary without introducing remote infrastructure.

## Phases

**Phase Numbering:**
- Integer phases (1, 2, 3): Planned milestone work
- Decimal phases (2.1, 2.2): Urgent insertions (marked with INSERTED)

Decimal phases appear between their surrounding integers in numeric order.

- [ ] **Phase 1: Tailwind v4 Styling Foundation** - Convert global CSS-file styling to Tailwind v4 utilities and design tokens.
- [ ] **Phase 2: Policy-Gated Issue Intake** - Start runs from board movement only for in-scope issues.
- [ ] **Phase 3: Local Worker Runtime Boundary** - Run each task locally in isolated ephemeral workspace with command/path guardrails.
- [ ] **Phase 4: Deterministic Run State Engine** - Make run stages explicit and crash-recoverable.
- [ ] **Phase 5: Live Telemetry and Safe Summaries** - Stream activity in-app and expose post-run evidence without secret leakage.
- [ ] **Phase 6: In-Run User Control** - Let users pause, resume, abort, and steer active runs.
- [ ] **Phase 7: Validation Gate Before Publish** - Require explicit code and visual validation outcomes before PR readiness.
- [ ] **Phase 8: Automated Draft PR Publication** - Create traceable draft PRs directly from successful runs.
- [ ] **Phase 9: Publish Reliability and Review Notification** - Guarantee publish outcome delivery with retries/backoff and in-app ready signal.

## Phase Details

### Phase 1: Tailwind v4 Styling Foundation
**Goal**: Users interact with existing app workflows using Tailwind v4-based styling and established tokens instead of legacy global CSS-file styling.
**Depends on**: Nothing (first phase)
**Requirements**: STYLE-01
**Success Criteria** (what must be TRUE):
  1. User can open existing authenticated app views and see them rendered through Tailwind v4 styling without relying on legacy global CSS file rules.
  2. User sees consistent token-driven colors, spacing, and typography across migrated v1 surfaces.
  3. Core existing workflows remain visually usable after migration (repo selection, board view, sidebar telemetry surfaces).
**Plans**: TBD

### Phase 2: Policy-Gated Issue Intake
**Goal**: Users can start an agent run by moving an issue to In Progress only when it passes small-task policy checks.
**Depends on**: Phase 1
**Requirements**: INTK-01, INTK-02
**Success Criteria** (what must be TRUE):
  1. User can move an eligible issue from Todo to In Progress and a run starts automatically.
  2. User sees a clear rejection reason when an issue is out of policy and the run is not started.
  3. Rejected issues do not begin background execution side effects.
**Plans**: TBD

### Phase 3: Local Worker Runtime Boundary
**Goal**: Every accepted run executes locally in an isolated, ephemeral workspace with constrained sidecar execution.
**Depends on**: Phase 2
**Requirements**: RUN-01, RUN-02, RUN-03, SEC-02
**Success Criteria** (what must be TRUE):
  1. User run executes on the local machine through the Rust/Tauri sidecar path only.
  2. Each run gets a dedicated isolated workspace and branch for that issue.
  3. Workspace artifacts are cleaned automatically after completion or cancellation.
  4. Out-of-bound sidecar command/path attempts are blocked with an explicit failure outcome.
**Plans**: TBD

### Phase 4: Deterministic Run State Engine
**Goal**: Run lifecycle stages are deterministic and persisted so app restarts reconcile correctly.
**Depends on**: Phase 3
**Requirements**: ORCH-01, ORCH-02
**Success Criteria** (what must be TRUE):
  1. User can observe runs progressing through defined stages (`queued`, `preparing`, `coding`, `validating`, `publishing`, terminal state).
  2. After app restart or crash, user sees reconciled run state instead of orphaned or duplicated execution.
  3. Completed runs retain durable terminal status for later inspection.
**Plans**: TBD

### Phase 5: Live Telemetry and Safe Summaries
**Goal**: Users can observe active work and completed outcomes in-app while secrets remain protected in all surfaced telemetry.
**Depends on**: Phase 4
**Requirements**: OBS-01, OBS-02, SEC-01
**Success Criteria** (what must be TRUE):
  1. User can watch live run activity/events in the existing right sidebar during execution.
  2. User can view a final run summary containing key actions, validation outcomes, and completion status.
  3. Logs and event streams shown in the UI never expose tokens or secrets.
  4. Run execution continues to use secure stored credentials without requiring plaintext credential handling.
**Plans**: TBD

### Phase 6: In-Run User Control
**Goal**: Users can intervene in active runs with pause, resume, abort, and steering actions.
**Depends on**: Phase 5
**Requirements**: CTRL-01, CTRL-02, CTRL-03, CTRL-04
**Success Criteria** (what must be TRUE):
  1. User can pause an active run and stage progression stops until resumed.
  2. User can resume a paused run and execution continues from the paused point.
  3. User can abort an active run and receives cancelled status with safe cleanup behavior.
  4. User can send steering instructions to an in-progress run and receives acknowledgement.
**Plans**: TBD

### Phase 7: Validation Gate Before Publish
**Goal**: PR readiness is backed by explicit validation outcomes for code and browser/visual checks when applicable.
**Depends on**: Phase 6
**Requirements**: VAL-01, VAL-02
**Success Criteria** (what must be TRUE):
  1. User receives code-validation status (`pass|fail|timeout|not-found`) before PR readiness is shown.
  2. User receives browser/visual validation status when applicable tests exist in the target repository.
  3. Validation outcomes are attached to run results so user can distinguish pass/fail/unsupported states.
**Plans**: TBD

### Phase 8: Automated Draft PR Publication
**Goal**: Successful runs publish a draft PR flow with source issue traceability.
**Depends on**: Phase 7
**Requirements**: GIT-01, GIT-02
**Success Criteria** (what must be TRUE):
  1. A successful run automatically creates a branch, commit(s), and draft PR without manual git steps.
  2. The draft PR links back to the source issue for closure and audit traceability.
  3. Publish success includes direct PR URL access in run context.
**Plans**: TBD

### Phase 9: Publish Reliability and Review Notification
**Goal**: Users are reliably informed when PRs are review-ready, and publish writes survive transient GitHub API pressure.
**Depends on**: Phase 8
**Requirements**: GIT-03, GIT-04
**Success Criteria** (what must be TRUE):
  1. User receives in-app notification with PR link when a run is ready for review.
  2. GitHub write operations use queued retries/backoff under rate-limit or transient API failures.
  3. Publish outcomes are never silently dropped; user sees either ready signal or actionable failure state.
**Plans**: TBD

## Progress

**Execution Order:**
Phases execute in numeric order: 1 -> 2 -> 3 -> 4 -> 5 -> 6 -> 7 -> 8 -> 9 (with decimal insertions between integers when needed)

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. Tailwind v4 Styling Foundation | 0/TBD | Not started | - |
| 2. Policy-Gated Issue Intake | 0/TBD | Not started | - |
| 3. Local Worker Runtime Boundary | 0/TBD | Not started | - |
| 4. Deterministic Run State Engine | 0/TBD | Not started | - |
| 5. Live Telemetry and Safe Summaries | 0/TBD | Not started | - |
| 6. In-Run User Control | 0/TBD | Not started | - |
| 7. Validation Gate Before Publish | 0/TBD | Not started | - |
| 8. Automated Draft PR Publication | 0/TBD | Not started | - |
| 9. Publish Reliability and Review Notification | 0/TBD | Not started | - |
