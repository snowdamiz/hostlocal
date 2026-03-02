# Technical Concerns

This document lists concrete, evidence-backed risks found in the current codebase, prioritized by severity.

## Critical

### C1) Renderer hardening gap creates a high-impact injection blast radius
- Categories: Security, Reliability, Fragile Area
- Evidence:
  - `src-tauri/tauri.conf.json` disables CSP with `"csp": null`.
  - `src/components/MainLayout.tsx` renders HTML into the DOM using `innerHTML={highlightIssueCode(...)}` for GitHub-sourced issue content.
  - `src-tauri/src/lib.rs` exposes backend commands (`github_list_repositories`, `github_list_repository_items`, `github_open_item_url`, etc.) to the renderer process.
- Risk:
  - This is a defense-in-depth gap: if untrusted HTML rendering is ever bypassed (dependency bug, parser edge case, future refactor), a renderer compromise can immediately invoke privileged commands and access authenticated GitHub data.
- Actionable recommendations:
  1. Set a restrictive CSP in `src-tauri/tauri.conf.json` (no `unsafe-inline`, no remote script origins).
  2. Remove `innerHTML` usage for issue rendering, or pass output through a strict sanitizer with an explicit allowlist.
  3. Reduce renderer command blast radius by isolating GitHub commands and validating caller state before returning sensitive data.

## High

### H1) OAuth scope is broader than current product behavior requires
- Categories: Security
- Evidence:
  - `src-tauri/src/github_auth.rs` requests scope `"read:user user:email repo"` in `github_auth_start`.
- Risk:
  - `repo` grants broad private repository access; token compromise has significantly higher impact than the app's apparent read-only use cases (repo listing + issue/PR viewing).
- Actionable recommendations:
  1. Reduce scopes to the minimum required for shipped features.
  2. Prefer a GitHub App or finer-grained token model if private-repo read access is needed.
  3. Document required scopes and add a permission review checklist for future API expansions.

### H2) GitHub API calls have no timeout controls and unbounded pagination
- Categories: Reliability, Performance
- Evidence:
  - `src-tauri/src/github_auth.rs` builds `reqwest::Client` without explicit timeout settings.
  - `fetch_repositories` and `fetch_repository_items` loop through all pages until empty and aggregate all results into memory.
- Risk:
  - Slow or stuck network requests can hang command responses.
  - Large GitHub accounts/repositories can cause long load times, rate-limit pressure, and memory spikes.
- Actionable recommendations:
  1. Configure connect/read/request timeouts on the HTTP client.
  2. Add bounded retry with backoff for transient failures.
  3. Enforce server-side paging limits and load incrementally in the UI (cursor or explicit "load more").

### H3) No automated quality gates (tests + CI)
- Categories: Operational Gap, Reliability
- Evidence:
  - `package.json` has no `test`, `lint`, or `typecheck` script entries.
  - No test/spec files are present under tracked project sources.
  - No `.github/workflows/*` CI configuration exists in the repository.
- Risk:
  - Regressions in auth, database, and interaction-heavy UI flows can ship undetected.
- Actionable recommendations:
  1. Add baseline scripts in `package.json` (`typecheck`, `lint`, `test`).
  2. Add Rust tests for backend command/auth behavior and frontend tests for critical flows.
  3. Add CI to run frontend build/tests and `cargo test` on every PR.

## Medium

### M1) Temporary GitHub API failures can force unnecessary logout
- Categories: Reliability
- Evidence:
  - In `src-tauri/src/github_auth.rs`, `github_auth_status` clears persisted token/state on any `fetch_viewer` error, not only authentication failures.
- Risk:
  - Network blips can erase valid sessions and force repeated re-authentication.
- Actionable recommendations:
  1. Clear persisted credentials only on explicit auth errors (for example HTTP 401).
  2. Treat transient network/API failures as retriable and preserve local session state.

### M2) Token persistence failures are swallowed, creating silent session fragility
- Categories: Reliability, Operational Gap
- Evidence:
  - `src-tauri/src/github_auth.rs` logs keyring write failures (`eprintln!`) but still returns authorized state.
- Risk:
  - Users appear connected but lose session after restart, with no visible explanation.
- Actionable recommendations:
  1. Return a non-fatal warning status to the frontend when keyring persistence fails.
  2. Surface an actionable UI message (retry, keychain access guidance).

### M3) Database access path is not optimized for growth
- Categories: Performance, Technical Debt
- Evidence:
  - `src-tauri/src/db.rs` opens a new SQLite connection and runs schema initialization in every `with_connection` call.
  - `src-tauri/src/commands.rs` routes all command operations through `with_connection`.
- Risk:
  - Per-command connection and schema overhead increases latency and contention as usage scales.
- Actionable recommendations:
  1. Initialize schema once at startup with explicit migration versioning.
  2. Reuse a managed connection/pool for command execution.

### M4) Window state persistence is fragile across high-frequency events and display changes
- Categories: Reliability, Performance, Fragile Area
- Evidence:
  - `src-tauri/src/lib.rs` persists window state on every move/resize/close event.
  - `src-tauri/src/window.rs` restores raw coordinates without validating current monitor bounds.
- Risk:
  - Excessive disk writes during drag/resize and potential off-screen window restoration after monitor layout changes.
- Actionable recommendations:
  1. Debounce/throttle persisted writes.
  2. Validate/clamp restored coordinates against active displays; fallback to centered placement.

## Low

### L1) Frontend implementation is highly coupled and expensive to maintain
- Categories: Technical Debt, Fragile Area
- Evidence:
  - `src/components/MainLayout.tsx` is a 1382-line component combining auth flows, API orchestration, canvas rendering, drag/drop state, and issue parsing.
- Risk:
  - High change coupling increases regression risk and slows feature iteration.
- Actionable recommendations:
  1. Split into focused modules/hooks (auth, repository loading, board state, issue rendering, canvas interactions).
  2. Add unit-level coverage around extracted pure logic.

### L2) Styling system is inconsistent with token-first constraints
- Categories: Technical Debt
- Evidence:
  - `src/App.css` contains multiple direct color literals outside base token declarations (for example hex literals in hover/status styles).
  - `package.json` has no Tailwind dependency/config despite current guidance favoring Tailwind v4.
- Risk:
  - Theme evolution and UI consistency become harder over time.
- Actionable recommendations:
  1. Replace direct literals with semantic design tokens.
  2. Plan incremental migration of layout/components to Tailwind v4 utilities while preserving current behavior.
