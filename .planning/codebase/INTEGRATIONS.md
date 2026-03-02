# Integrations

## External APIs
- GitHub OAuth Device Flow endpoints are integrated in the Rust backend:
  - Device code: `https://github.com/login/device/code`
  - Access token: `https://github.com/login/oauth/access_token`
  - Source: constants in `src-tauri/src/github_auth.rs`.
- GitHub REST API is used for user and repository data:
  - `https://api.github.com/user`
  - `https://api.github.com/user/repos`
  - `https://api.github.com/repos/{owner}/{repo}/issues`
  - Source: constants and request code in `src-tauri/src/github_auth.rs`.
- HTTP client integration is via `reqwest` with Rustls TLS (`src-tauri/Cargo.toml`, `src-tauri/src/github_auth.rs`).

## Storage Integrations
- Local SQLite database integration via `rusqlite` (`src-tauri/Cargo.toml`, `src-tauri/src/db.rs`, `src-tauri/src/commands.rs`).
- Database file is created in the app data directory as `hostlocal.sqlite` (`src-tauri/src/db.rs`).
- SQLite schema currently includes `messages`, `app_settings`, and `projects` tables with WAL journal mode (`src-tauri/src/db.rs`).
- Window state is persisted to `window-state.json` in the app config directory (`src-tauri/src/window.rs`).

## Authentication and Secrets
- GitHub authentication uses OAuth Device Flow (no client secret path in code flow) implemented in `src-tauri/src/github_auth.rs`.
- Access tokens are persisted in the OS keychain via the `keyring` crate (`src-tauri/Cargo.toml`, `src-tauri/src/github_auth.rs`).
- Keyring identifiers:
  - Service: `com.sn0w.hostlocal`
  - Account: `github_access_token`
  - Source: constants in `src-tauri/src/github_auth.rs`.
- The README explicitly documents keychain storage behavior (`README.md`).

## OS and Platform Integrations
- Native folder picker uses `rfd::AsyncFileDialog` (`src-tauri/src/commands.rs`).
- External URLs (GitHub verification/item links) open via the system browser using `webbrowser::open` (`src-tauri/src/github_auth.rs`).
- Tauri window management integration:
  - Custom window controls and drag behavior (`src/components/WindowControls.tsx`, `src-tauri/capabilities/default.json`)
  - Window move/resize persistence hooks (`src-tauri/src/lib.rs`, `src-tauri/src/window.rs`)
- macOS private API is enabled in both runtime config and Rust feature flags (`src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`).

## Frontend ↔ Native Boundary
- Frontend integration with native commands occurs via `@tauri-apps/api/core` `invoke()` wrappers (`src/lib/commands.ts`).
- Backend command registration is centralized in `tauri::generate_handler!` (`src-tauri/src/lib.rs`).

## Telemetry and Monitoring
- No telemetry/analytics SDK integration was found (no `sentry`, `posthog`, `amplitude`, or OpenTelemetry references in `package.json`, `src/`, or `src-tauri/`).

## Integrations Not Present
- No third-party cloud database integration (only local SQLite is implemented).
- No third-party auth provider integration beyond GitHub OAuth.
- No error monitoring/APM provider integration detected.
