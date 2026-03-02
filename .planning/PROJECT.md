# HostLocal

## What This Is

HostLocal is a Tauri desktop app for turning GitHub repository work into a visual execution flow. It already lets a user connect GitHub, browse repositories, and view repo work items (issues and PRs) in a kanban-style board. The next stage is an agent-driven flow where moving an issue into progress runs a local AI worker that implements and submits a PR while the user watches and steers from the app.

## Core Value

A user can move a GitHub issue to in-progress and reliably get a review-ready PR from a fast local agent run, with clear visibility and control throughout execution.

## Requirements

### Validated

- ✓ User can connect/disconnect a GitHub account via OAuth device flow — existing
- ✓ User auth state persists via OS keychain-backed token handling — existing
- ✓ User can list accessible repositories after authentication — existing
- ✓ User can select a repository and view issue/PR items in kanban-style columns — existing
- ✓ User can use a desktop-native app shell with local SQLite-backed app settings — existing

### Active

- [ ] User can move an issue from Todo to In Progress to trigger an ephemeral local worker run
- [ ] Worker runs on the user machine via a Rust/Tauri sidecar path (no remote infrastructure)
- [ ] Worker clones/pulls repo, creates branch, implements issue fix, and opens a PR automatically
- [ ] Worker validates changes with code-level tests and visual/browser-driven checks where applicable
- [ ] UI right sidebar streams real-time worker activity/logs so user can see what the agent is doing
- [ ] User can send steering instructions/messages to the running agent from the UI
- [ ] User receives clear in-app status when PR is ready for review
- [ ] Execution remains optimized for low startup latency and minimal local resource usage
- [ ] Scope enforces small coding tasks only (bugfixes/refactors/docs/tests), avoiding high-risk changes

### Out of Scope

- Team/multi-user collaboration workflows — v1 is solo-first
- Cloud/remote VM orchestration — execution is local-only by decision
- Broad autonomous infra/deploy/database migration changes — outside small-task safety boundary
- Full generic long-running assistant platform features — focus is issue-to-PR loop first

## Context

Current app foundation is a SolidJS + Tauri desktop architecture with Rust command handlers and local persistence. GitHub integration and repository/item loading are already in place, providing the right baseline for issue-driven automation. The new value layer is job orchestration and agent observability: a lightweight ephemeral execution environment tied to board movement, plus bidirectional communication between user and active run.

The project is explicitly brownfield: existing UI structure, OAuth/device-flow plumbing, and repo/item surfaces should be reused rather than replaced.

## Constraints

- **Execution Model**: Ephemeral per-task local workers only — maximize isolation and deterministic cleanup
- **Hosting**: User machine only via Rust/Tauri sidecar — avoid remote infra in v1
- **Audience**: Solo developer first — reduce permissions and collaboration complexity
- **Task Scope**: Small coding tasks only — reduce blast radius and improve success rate
- **Performance**: Fast spin-up and low resource footprint — worker environment must be lightweight
- **Workflow Integration**: Trigger from kanban state transitions — core loop starts in existing board UX

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Use ephemeral per-task workers | Strong isolation and predictable cleanup per issue run | — Pending |
| Run workers locally through Rust/Tauri sidecar path | v1 must avoid cloud infra and keep control on user machine | — Pending |
| Target solo users first | Simplifies permissions, UX, and reliability in first delivery | — Pending |
| Restrict autonomous scope to small coding tasks | Increases safety and likelihood of high-quality first results | — Pending |
| Keep user-in-the-loop via sidebar telemetry and steering chat | Trust and controllability are required for agent adoption | — Pending |

---
*Last updated: 2026-03-02 after initialization*
