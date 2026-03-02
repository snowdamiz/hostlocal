# Feature Research

**Domain:** Local issue-to-PR automation in a Tauri desktop app
**Researched:** 2026-03-02
**Confidence:** HIGH

## Feature Landscape

### Table Stakes (Users Expect These)

Features users assume exist. Missing these = product feels incomplete.

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| `TS-1 Issue Eligibility Gate` | Users need confidence that only small/safe tasks are automated. | MEDIUM | Parse issue metadata + body, enforce scope policy (`bugfix/refactor/docs/tests` only), reject with reason. Depends on `TS-10` for reliable issue fetch. |
| `TS-2 Ephemeral Local Workspace Per Run` | "Local-only" implies isolated, disposable execution for each task. | HIGH | Create task workspace from repo, branch, run, then cleanup. Favor linked worktrees for speed and cleanup (`git worktree add/remove`). Depends on `TS-9`. |
| `TS-3 Locked-Down Sidecar Execution` | Desktop users expect strong local safety boundaries. | MEDIUM | Run worker through Tauri sidecar with explicit shell permissions/capabilities (no unrestricted command surface). Depends on Tauri shell/capability config. |
| `TS-4 Deterministic Run State Machine` | Users need predictable transitions from issue -> code -> PR. | HIGH | Explicit phases: intake, prep, edit, validate, publish, done/failed/cancelled. Persist checkpoints in SQLite for crash recovery and resume. Depends on `TS-2`, `TS-3`. |
| `TS-5 Live Activity Stream in Sidebar` | Agent trust requires visibility while it runs. | MEDIUM | Stream ordered progress/log events from Rust to frontend (prefer Tauri channels for throughput). Depends on `TS-4`. |
| `TS-6 User Steering + Pause/Abort` | Solo developers expect to interrupt/steer autonomous runs. | MEDIUM | In-run instruction channel (append guidance), pause/resume, hard abort with process kill and safe cleanup. Depends on `TS-4`, `TS-5`. |
| `TS-7 GitHub Writeback Loop` | Core promise is "issue moved -> review-ready PR appears in GitHub." | HIGH | Create branch commits, open draft PR, add issue/PR comments, include `Fixes #<issue>` semantics for closure on merge. Depends on `TS-1`, `TS-4`, `TS-10`. |
| `TS-8 Validation Pipeline` | Review-ready PRs require proof (tests/linters and optional browser checks). | HIGH | Detect and run project test commands with timeout/budget; support Playwright traces when present; normalize pass/fail/none-collected outcomes. Depends on `TS-2`, `TS-4`. |
| `TS-9 Local Secret Handling` | Local app still needs secure token handling on-device. | MEDIUM | Store tokens in OS secure store (existing keychain approach remains valid), never log secrets, scrub env on worker launch. Foundation for all GitHub operations. |
| `TS-10 API Queue + Backoff + Conditional Polling` | GitHub API limits and mutative endpoint throttles are unavoidable. | MEDIUM | Serialize mutative requests, pause between mutations, use ETag/304 conditional reads for status polling in local-only mode. Enables stable `TS-1` and `TS-7`. |

### Differentiators (Competitive Advantage)

Features that set the product apart. Not required, but valuable.

| Feature | Value Proposition | Complexity | Notes |
|---------|-------------------|------------|-------|
| `DF-1 Checkpointed Patch Approval Mode` | Gives users confidence for higher-risk small tasks without losing automation speed. | MEDIUM | Optional checkpoints after planning and after first patch set; one-click accept/revise. Enhances `TS-6`, `TS-7`. |
| `DF-2 Smart Branch/PR Authoring` | Produces cleaner PRs with less manual cleanup. | LOW | Consistent branch naming (`issue/<id>-slug`), structured PR template with summary/test evidence/risks, auto-link issue keyword handling. Enhances `TS-7`. |
| `DF-3 Fast Warm Start Cache` | Makes repeated local runs feel instant on large repos. | HIGH | Reuse local mirror/worktree + optional partial clone (`--filter=blob:none`) for cold-start reductions. Enhances `TS-2`, `TS-8`. |
| `DF-4 Run Replay Artifact` | Improves debugging and trust when a run fails. | MEDIUM | Export a deterministic run bundle (timeline, commands, exit codes, diff summary) for replay/support. Depends on `TS-4`, `TS-5`, `TS-8`. |
| `DF-5 Adaptive Task Budgeting` | Keeps solo-first UX fast by refusing or downsizing tasks likely to fail. | MEDIUM | Heuristic score from issue size/file spread/test cost; auto-suggest "manual mode" when above threshold. Extends `TS-1`. |

### Anti-Features (Commonly Requested, Often Problematic)

Features that seem good but create problems.

| Feature | Why Requested | Why Problematic | Alternative |
|---------|---------------|-----------------|-------------|
| `AF-1 Multi-repo / cross-repo edits in one run` | Feels powerful for broad fixes. | Explodes failure surface, permissions, and rollback complexity for v1 solo flow. | Keep single-repo run boundary; create follow-up tasks per repo. |
| `AF-2 Auto-merge to default branch` | "Fully hands-off" appeal. | High blast radius; bypasses review trust model for generated code. | Always open draft PR first; user promotes/merges manually. |
| `AF-3 Remote/cloud worker execution` | Offloads local compute. | Breaks local-only requirement and introduces infra/security/latency overhead. | Local sidecar only in v1; optimize startup via `DF-3`. |
| `AF-4 Webhook-first orchestration backend` | Real-time sync seems ideal. | `localhost` webhook targets are unsupported by GitHub; implies external forwarding/server ops. | Poll with ETag + bounded intervals in desktop app (`TS-10`). |
| `AF-5 Unbounded autonomous scope` | "Fix anything" marketing appeal. | Poor reliability on broad tasks; hard to verify safely for solo users. | Hard scope gate (`TS-1`) + adaptive budgeting (`DF-5`). |

## Feature Dependencies

```text
TS-9 Local Secret Handling
    -> enables -> TS-2 Ephemeral Local Workspace
                      -> enables -> TS-4 Deterministic Run State Machine
                                         -> requires -> TS-5 Live Activity Stream
                                         -> requires -> TS-6 User Steering + Pause/Abort
                                         -> requires -> TS-8 Validation Pipeline
                                         -> requires -> TS-7 GitHub Writeback Loop

TS-10 API Queue + Backoff + Conditional Polling
    -> supports -> TS-1 Issue Eligibility Gate
    -> supports -> TS-7 GitHub Writeback Loop

TS-3 Locked-Down Sidecar Execution
    -> guards -> TS-4 Deterministic Run State Machine

DF-3 Fast Warm Start Cache -> enhances -> TS-2 Ephemeral Local Workspace
DF-1 Checkpointed Patch Approval -> enhances -> TS-6 User Steering + TS-7 GitHub Writeback
AF-2 Auto-merge -> conflicts -> TS-6 User Steering + manual review model
AF-3 Remote/cloud workers -> conflicts -> TS-2 local-only execution model
```

### Dependency Notes

- **`TS-4` requires `TS-2` + `TS-3`:** reliable orchestration depends on isolated workspace and constrained execution surface.
- **`TS-5` requires `TS-4`:** progress events must map to deterministic run phases, not free-form logs only.
- **`TS-6` requires `TS-4` + `TS-5`:** steering actions need known run state and visible context.
- **`TS-7` requires `TS-1` + `TS-10`:** only eligible tasks should publish PRs, and API calls must respect rate/secondary limits.
- **`TS-8` requires `TS-2`:** validation must execute against the exact task workspace/branch.
- **`DF-3` enhances `TS-2`:** faster prep preserves local-only model while reducing latency.
- **`AF-4` conflicts with local-only v1:** webhook-first design implies public ingress/service plumbing outside current scope.
- **`AF-5` conflicts with small-task guarantee:** broad autonomy undermines deterministic safety boundaries.

## MVP Definition

### Launch With (v1)

Minimum viable product - what is needed to validate the concept.

- [ ] `TS-1 Issue Eligibility Gate` - enforces small-task-only promise.
- [ ] `TS-2 Ephemeral Local Workspace Per Run` - provides isolation and cleanup.
- [ ] `TS-3 Locked-Down Sidecar Execution` - secures command execution path.
- [ ] `TS-4 Deterministic Run State Machine` - makes automation reliable and recoverable.
- [ ] `TS-5 Live Activity Stream in Sidebar` - establishes user trust/observability.
- [ ] `TS-6 User Steering + Pause/Abort` - keeps user in control.
- [ ] `TS-7 GitHub Writeback Loop` - delivers core issue->PR value.
- [ ] `TS-8 Validation Pipeline` - ensures review-ready output.
- [ ] `TS-9 Local Secret Handling` - protects credentials.
- [ ] `TS-10 API Queue + Backoff + Conditional Polling` - prevents rate-limit instability.

### Add After Validation (v1.x)

Features to add once core is working.

- [ ] `DF-1 Checkpointed Patch Approval Mode` - add when users request tighter control on risky edits.
- [ ] `DF-2 Smart Branch/PR Authoring` - add when PR polish becomes a repeat complaint.
- [ ] `DF-5 Adaptive Task Budgeting` - add when failed-run rate is high enough to justify predictive gating.

### Future Consideration (v2+)

Features to defer until product-market fit is established.

- [ ] `DF-3 Fast Warm Start Cache` - defer until startup latency is a proven adoption blocker.
- [ ] `DF-4 Run Replay Artifact` - defer until multi-session debugging/support overhead appears.
- [ ] Optional auth model migration (GitHub App) - consider once app distribution and permission UX requirements harden.

## Feature Prioritization Matrix

| Feature | User Value | Implementation Cost | Priority |
|---------|------------|---------------------|----------|
| `TS-7 GitHub Writeback Loop` | HIGH | HIGH | P1 |
| `TS-4 Deterministic Run State Machine` | HIGH | HIGH | P1 |
| `TS-1 Issue Eligibility Gate` | HIGH | MEDIUM | P1 |
| `TS-5 Live Activity Stream in Sidebar` | HIGH | MEDIUM | P1 |
| `TS-8 Validation Pipeline` | HIGH | HIGH | P1 |
| `TS-10 API Queue + Backoff + Conditional Polling` | HIGH | MEDIUM | P1 |
| `DF-1 Checkpointed Patch Approval Mode` | MEDIUM | MEDIUM | P2 |
| `DF-2 Smart Branch/PR Authoring` | MEDIUM | LOW | P2 |
| `DF-5 Adaptive Task Budgeting` | MEDIUM | MEDIUM | P2 |
| `DF-3 Fast Warm Start Cache` | MEDIUM | HIGH | P3 |
| `DF-4 Run Replay Artifact` | MEDIUM | MEDIUM | P3 |

**Priority key:**
- P1: Must have for launch
- P2: Should have, add when possible
- P3: Nice to have, future consideration

## Competitor Feature Analysis

| Feature | Competitor A | Competitor B | Our Approach |
|---------|--------------|--------------|--------------|
| Issue -> PR automation | GitHub Copilot coding agent supports issue assignment and opens one PR per task in an ephemeral GH Actions environment. | Manual `gh pr create` + scripts requires user orchestration. | Local deterministic run from board transition with explicit scope gate and steering controls. |
| Execution locality | Cloud-run task execution model. | Fully local but manual. | Fully local sidecar automation (no remote worker in v1). |
| Progress visibility | Agent session logs and PR updates on GitHub. | Terminal output only unless user scripts custom dashboards. | Native in-app sidebar timeline with structured phases + streaming output. |
| Safety model | Branch/PR constraints and review flow, but generalized cloud agent surface. | Human-driven safety; no autonomous scope by default. | Small-task-only policy, local secret handling, locked-down sidecar permissions, and manual merge requirement. |

## Sources

- Local project context: `/Users/sn0w/Documents/dev/hostlocal/.planning/PROJECT.md`
- [Tauri: Embedding External Binaries (sidecar)](https://v2.tauri.app/develop/sidecar/)
- [Tauri: Shell plugin](https://v2.tauri.app/plugin/shell/)
- [Tauri: Permissions and capabilities](https://v2.tauri.app/security/permissions/)
- [Tauri: Calling the Frontend from Rust (events/channels)](https://v2.tauri.app/develop/calling-frontend/)
- [GitHub REST: Pull requests](https://docs.github.com/en/rest/pulls/pulls)
- [GitHub REST: Issue comments](https://docs.github.com/en/rest/issues/comments)
- [GitHub Docs: Linking a PR to an issue](https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/linking-a-pull-request-to-an-issue)
- [GitHub REST best practices](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api)
- [GitHub REST rate limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api)
- [GitHub webhook troubleshooting (`localhost` not supported)](https://docs.github.com/en/webhooks/testing-and-troubleshooting-webhooks/troubleshooting-webhooks)
- [GitHub OAuth app authorization (device flow)](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps)
- [GitHub OAuth app security best practices](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/best-practices-for-creating-an-oauth-app)
- [GitHub Copilot coding agent concepts](https://docs.github.com/en/copilot/concepts/agents/coding-agent/about-coding-agent)
- [GitHub CLI manual: `gh pr create`](https://cli.github.com/manual/gh_pr_create)
- [Git docs: `git worktree`](https://git-scm.com/docs/git-worktree)
- [Git docs: `git clone`](https://git-scm.com/docs/git-clone)
- [Git docs: `git switch`](https://git-scm.com/docs/git-switch)
- [Rust keyring crate docs](https://docs.rs/keyring/latest/keyring/)
- [Rust std: `temp_dir`](https://doc.rust-lang.org/std/env/fn.temp_dir.html)
- [Rust std: `remove_dir_all`](https://doc.rust-lang.org/std/fs/fn.remove_dir_all.html)
- [Tokio process command docs](https://docs.rs/tokio/latest/tokio/process/struct.Command.html)
- [Playwright CLI docs](https://playwright.dev/docs/test-cli)
- [pytest exit codes](https://docs.pytest.org/en/stable/reference/exit-codes.html)

---
*Feature research for: local issue-to-PR automation in a Tauri desktop app*
*Researched: 2026-03-02*
