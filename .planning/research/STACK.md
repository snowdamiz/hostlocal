# Stack Research

**Domain:** Local-only issue-to-PR automation in a Tauri desktop app
**Researched:** 2026-03-02
**Confidence:** HIGH

## Recommended Stack

### Core Technologies

| Technology | Version | Purpose | Why Recommended |
|------------|---------|---------|-----------------|
| Tauri | 2.10.x | Desktop host, IPC, packaging | Native desktop runtime already in place; first-class Rust integration for secure command boundaries and event/channels.
| `tauri-plugin-shell` | 2.3.x | Controlled sidecar process execution | Official sidecar path for spawning local worker processes with capability-scoped permissions.
| Rust | >= 1.77.2 | Sidecar/orchestrator implementation | Plugin-shell requires at least Rust 1.77.2 and Rust provides strong safety/concurrency for worker lifecycle and cleanup logic.
| Tokio | 1.49.x | Async orchestration runtime | Mature async runtime for concurrent process I/O, timeouts, cancellation, and stream handling.
| Git CLI | 2.53.x | Branch/worktree and commit orchestration | `git worktree` supports isolated per-task workspaces with fast setup/teardown.
| GitHub REST API | Versioned API (`X-GitHub-Api-Version: 2022-11-28`) | Issue/PR/comment operations | Stable versioned API surface for issue intake, PR creation, and status reporting.
| `octocrab` | 0.49.5 | Typed GitHub client in Rust | Speeds implementation over raw HTTP while still allowing low-level escape hatches.
| SQLite + `rusqlite` | SQLite (bundled) + `rusqlite` 0.38.x | Durable local run state and checkpoints | Local-first persistence, crash-safe checkpoints, and deterministic recovery with low overhead.
| OS keychain + `keyring` | 3.6.x | Secure token storage | Cross-platform secure secret storage for GitHub credentials.
| Playwright | 1.58.x | Visual/browser validation | Best-in-class browser automation for optional UI validation and trace evidence when repos include browser tests.

### Supporting Libraries

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `serde` / `serde_json` | 1.x | Command/event serialization | Always for frontend/backend contracts and persisted run metadata.
| `tracing` + `tracing-subscriber` | 0.1.x | Structured logs and event correlation | Always for timeline stream in sidebar and post-run diagnostics.
| `ignore` | 0.4.x | File discovery respecting `.gitignore` | For selecting candidate files/tests and avoiding noisy directories.
| `anyhow` / `thiserror` | 1.x / 2.x | Error taxonomy and propagation | Always to separate user-facing failure reasons from internal details.

### Development Tools

| Tool | Purpose | Notes |
|------|---------|-------|
| GitHub CLI (`gh`) | Local fallback for PR/auth diagnostics | Keep as optional fallback path; primary path should remain GitHub REST via Rust client.
| `cargo nextest` (optional) | Fast Rust test execution in agent-run repos | Use only when target repo supports it; detect and fallback automatically.
| Playwright Trace Viewer | Debug failed visual validation | Attach trace/video artifacts to run details for reviewability.

## Installation

```bash
# Frontend
pnpm add @tauri-apps/api @tauri-apps/plugin-shell

# Rust core
cargo add tauri@2
cargo add tauri-plugin-shell@2
cargo add tokio --features rt-multi-thread,macros,process,time,sync,io-util
cargo add octocrab
cargo add rusqlite --features bundled
cargo add keyring
cargo add serde --features derive
cargo add serde_json
cargo add tracing tracing-subscriber
cargo add ignore
cargo add anyhow thiserror

# Optional browser validation runtime
pnpm add -D playwright
```

## Alternatives Considered

| Recommended | Alternative | When to Use Alternative |
|-------------|-------------|-------------------------|
| Tauri sidecar process model | Always-on in-process worker thread | Use in-process only for trivial non-shell tasks; process model is safer for kill/restart isolation.
| `git worktree` per job | Full clone per job | Use full clone only when repository policies forbid worktrees.
| GitHub REST + `octocrab` | Raw `reqwest` calls only | Use raw HTTP only for endpoints not modeled yet by `octocrab`.
| Native process isolation + permission scopes | Container VM per task (Docker/Podman machine) | Use container VM only if strict Linux parity is mandatory and startup latency budget allows it.

## What NOT to Use

| Avoid | Why | Use Instead |
|-------|-----|-------------|
| Webhook-first local orchestration | GitHub does not support `localhost`/`127.0.0.1` webhook URLs; brittle for desktop-local app | Use conditional polling + backoff queue in local app.
| Unscoped `shell:allow-execute` without allowlist | Expands command-injection blast radius | Configure capability allowlists per sidecar command and args.
| Mandatory Docker Desktop/Podman VM for every run | Adds VM startup cost and extra memory floor for local desktop workflow | Start with native sidecar + worktree isolation; add container mode later behind feature flag.
| Auto-merge after agent run | Breaks trust/safety for generated changes | Always open PR and require user review/merge.

## Stack Patterns by Variant

**If repository already has browser tests:**
- Run existing Playwright/Cypress pipeline and collect artifacts.
- Because reusing repo-native tests reduces false positives and avoids brittle bespoke scripts.

**If repository has only code tests:**
- Run deterministic unit/integration checks + lint/typecheck.
- Because quick, reliable feedback beats forcing synthetic browser tests everywhere.

**If startup latency is high in large repos:**
- Introduce warm bare mirror + per-run linked worktree (`git worktree add/remove`).
- Because it preserves isolation while removing repeated network clone costs.

## Version Compatibility

| Package A | Compatible With | Notes |
|-----------|-----------------|-------|
| `tauri@2.10.x` | `@tauri-apps/api@2.x` | Keep Rust and JS packages on the same major line.
| `tauri-plugin-shell@2.3.x` (Rust) | `@tauri-apps/plugin-shell@2.3.x` (JS) | Prefer matching major/minor for API parity.
| `tokio@1.49.x` | Rust toolchain >= 1.77.2 | Tokio MSRV is lower, but plugin-shell minimum is the effective floor.
| `octocrab@0.49.5` | GitHub REST versioned headers | Set API version explicitly and keep media-type defaults stable.

## Sources

- [Tauri crate (latest)](https://docs.rs/crate/tauri/latest/builds) — current v2 release line
- [Tauri shell plugin docs](https://v2.tauri.app/es/plugin/shell/) — plugin setup, permissions, Rust minimum
- [Tauri sidecar docs](https://v2.tauri.app/fr/develop/sidecar/) — sidecar execution model
- [Tauri calling frontend docs](https://v2.tauri.app/es/develop/calling-frontend/) — events vs channels guidance
- [GitHub REST pull requests](https://docs.github.com/en/rest/reference/pulls) — PR lifecycle endpoints
- [GitHub REST best practices](https://docs.github.com/rest/guides/best-practices-for-integrators) — queueing/backoff guidance
- [GitHub REST rate limits](https://docs.github.com/enterprise-cloud%40latest/rest/overview/rate-limits-for-the-rest-api) — primary/secondary limits
- [GitHub webhook troubleshooting](https://docs.github.com/en/webhooks/testing-and-troubleshooting-webhooks/troubleshooting-webhooks) — localhost webhook limitation
- [`git worktree` docs](https://git-scm.com/docs/git-worktree.html) — linked worktree lifecycle
- [`octocrab` crate docs](https://docs.rs/octocrab/latest/octocrab/) — typed GitHub client
- [`tokio` crate docs](https://docs.rs/crate/tokio/latest) — runtime baseline
- [`rusqlite` crate docs](https://docs.rs/crate/rusqlite/latest) — SQLite integration
- [`keyring` crate docs](https://docs.rs/crate/keyring/latest) — secure credential storage
- [Playwright release notes](https://playwright.dev/docs/release-notes) — current major/minor line
- [Docker Desktop on Mac requirements](https://docs.docker.com/desktop/setup/install/mac-install/) — desktop VM memory baseline context
- [Podman machine docs](https://docs.podman.io/en/v4.9.0/markdown/podman-machine.1.html) — VM requirement on macOS/Windows

---
*Stack research for: local issue-to-PR automation in a Tauri desktop app*
*Researched: 2026-03-02*
