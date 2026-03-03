# Requirements: HostLocal

**Defined:** 2026-03-02
**Core Value:** A user can move a GitHub issue to in-progress and reliably get a review-ready PR from a fast local agent run, with clear visibility and control throughout execution.

## v1 Requirements

Requirements for the local-only issue-to-PR workflow. Each maps to roadmap phases.

### Styling Foundation

- [x] **STYLE-01**: User-facing v1 app surfaces use Tailwind v4 utilities and established design tokens instead of legacy global CSS-file styling.

### Issue Intake

- [x] **INTK-01**: User can move an issue from Todo to In Progress to start an agent run when policy checks pass.
- [x] **INTK-02**: User receives a clear rejection reason when an issue is outside the small-task policy boundary.

### Local Runtime

- [x] **RUN-01**: User run executes on the local machine through a Rust/Tauri sidecar path (no remote workers).
- [x] **RUN-02**: User run uses an isolated ephemeral workspace and branch for that issue.
- [x] **RUN-03**: Run workspace is cleaned up automatically after completion or cancellation.

### Orchestration

- [x] **ORCH-01**: User can see deterministic run stages (`queued`, `preparing`, `coding`, `validating`, `publishing`, `done|failed|cancelled`).
- [x] **ORCH-02**: Run state is persisted so the app can recover/reconcile correctly after restart or crash.

### Agent Control

- [ ] **CTRL-01**: User can pause an active run.
- [ ] **CTRL-02**: User can resume a paused run.
- [ ] **CTRL-03**: User can abort an active run and trigger safe cleanup.
- [ ] **CTRL-04**: User can send steering instructions to an in-progress run and receive acknowledgement.

### Validation

- [ ] **VAL-01**: User receives code-validation status (`pass|fail|timeout|not-found`) before a PR is marked ready.
- [ ] **VAL-02**: User receives browser/visual validation status when applicable tests are available in the target repo.

### GitHub Publish

- [ ] **GIT-01**: User gets an automated branch + commit + draft PR for a successful run.
- [ ] **GIT-02**: Draft PR links back to the source issue so closure and traceability are preserved.
- [ ] **GIT-03**: User receives in-app notification with PR link when a run is ready for review.
- [ ] **GIT-04**: GitHub API writes use queued retries/backoff so rate-limit pressure does not silently lose run outcomes.

### Observability

- [x] **OBS-01**: User can watch live run activity/events in the existing right sidebar.
- [x] **OBS-02**: User can review final run summary including key actions, validation outcomes, and completion status.

### Security

- [x] **SEC-01**: User tokens/secrets remain in OS secure storage and are never exposed in run logs or UI event streams.
- [x] **SEC-02**: Sidecar execution is restricted by explicit command/path permissions to the run workspace boundary.

## v2 Requirements

Deferred to future release. Tracked but not in current roadmap.

### Quality-of-Life Enhancements

- **QOL-01**: User can opt into checkpoint-based patch approval before final PR publishing.
- **QOL-02**: User gets enhanced PR authoring (structured summaries, richer templates, auto-tagging).
- **QOL-03**: User gets adaptive task budgeting that predicts likely failure and proposes manual handoff.
- **QOL-04**: User gets warm-start repo cache optimization for faster repeated runs in large repositories.
- **QOL-05**: User can export run replay bundles for debugging and support workflows.

## Out of Scope

Explicitly excluded in this release to prevent scope creep.

| Feature | Reason |
|---------|--------|
| Team collaboration and multi-user board workflows | v1 is intentionally solo-first to reduce complexity and stabilize core loop |
| Cloud or remote worker execution | Product decision is local-only execution in this milestone |
| Auto-merge to default branch | Safety model requires human review/merge for generated code |
| Multi-repo edits in a single run | Increases blast radius and recovery complexity for early versions |
| Broad autonomous infra/deploy/database migration changes | Outside small-task boundary and not suitable for initial reliability goals |

## Traceability

Which phases cover which requirements. Updated during roadmap creation.

| Requirement | Phase | Status |
|-------------|-------|--------|
| STYLE-01 | Phase 1 | Complete |
| INTK-01 | Phase 2 | Complete |
| INTK-02 | Phase 2 | Complete |
| RUN-01 | Phase 3 | Complete |
| RUN-02 | Phase 3 | Complete |
| RUN-03 | Phase 3 | Complete |
| ORCH-01 | Phase 4 | Complete |
| ORCH-02 | Phase 4 | Complete |
| CTRL-01 | Phase 6 | Pending |
| CTRL-02 | Phase 6 | Pending |
| CTRL-03 | Phase 6 | Pending |
| CTRL-04 | Phase 6 | Pending |
| VAL-01 | Phase 7 | Pending |
| VAL-02 | Phase 7 | Pending |
| GIT-01 | Phase 8 | Pending |
| GIT-02 | Phase 8 | Pending |
| GIT-03 | Phase 9 | Pending |
| GIT-04 | Phase 9 | Pending |
| OBS-01 | Phase 5 | Complete |
| OBS-02 | Phase 5 | Complete |
| SEC-01 | Phase 5 | Complete |
| SEC-02 | Phase 3 | Complete |

**Coverage:**
- v1 requirements: 22 total
- Mapped to phases: 22
- Unmapped: 0 ✓

---
*Requirements defined: 2026-03-02*
*Last updated: 2026-03-02 after roadmap revision*
