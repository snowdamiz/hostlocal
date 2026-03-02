# CONVENTIONS

## Scope
This document describes conventions currently present in the codebase, with explicit evidence from source/config files.

## Code Style
- Frontend uses TypeScript + Solid with function components and reactive primitives (`createSignal`, `createMemo`, `createEffect`, `onMount`, `onCleanup`) in `src/components/MainLayout.tsx` and `src/App.tsx`.
- Shared frontend command contract is centralized in typed wrappers in `src/lib/commands.ts` (`invoke<T>(...)` wrappers + interface definitions).
- Backend uses Rust modules split by responsibility (`commands`, `db`, `github_auth`, `window`) in `src-tauri/src/lib.rs`.
- Style is defensive and explicit:
  - Guard clauses for invalid input (for example in `src-tauri/src/commands.rs`).
  - Helper functions for normalization/parsing (`normalize_project_folder_name`, `parseIssueBody`, `formatInvokeError`) in `src-tauri/src/commands.rs` and `src/components/MainLayout.tsx`.

## Naming
- TypeScript/Solid:
  - Components/types/interfaces: `PascalCase` (for example `MainLayout`, `SetupWizard`, `GithubRepositoryItem`) in `src/components/MainLayout.tsx`, `src/components/SetupWizard.tsx`, and `src/lib/commands.ts`.
  - Local variables/functions: `camelCase` (for example `loadRepositories`, `formatInvokeError`) in `src/components/MainLayout.tsx`.
  - Signals follow `[value, setValue]` pattern with boolean prefixes like `is*`/`has*` in `src/components/MainLayout.tsx`.
  - Module constants are `UPPER_SNAKE_CASE` in `src/components/MainLayout.tsx`.
- Rust:
  - Functions/modules: `snake_case`, structs/types: `PascalCase`, constants: `UPPER_SNAKE_CASE` in `src-tauri/src/commands.rs`, `src-tauri/src/db.rs`, and `src-tauri/src/github_auth.rs`.
  - Serde bridges backend snake_case to frontend camelCase payloads using `#[serde(rename_all = "camelCase")]` and field renames in `src-tauri/src/commands.rs` and `src-tauri/src/github_auth.rs`.
- CSS:
  - Class names are kebab-case and domain-prefixed (`setup-*`, `sidebar-*`, `kanban-*`, `window-control-*`) across `src/App.css` and `src/components/MainLayout.tsx`.

## Patterns
- State-driven UI routing for setup vs ready flow in `src/App.tsx`.
- Async UI actions wrap native/backend calls and update local state in `src/components/SetupWizard.tsx` and `src/components/MainLayout.tsx`.
- Frontend-to-backend boundary is command-based (`invoke` wrappers in `src/lib/commands.ts`, `#[tauri::command]` handlers in `src-tauri/src/commands.rs` and `src-tauri/src/github_auth.rs`).
- Persistent desktop state patterns:
  - SQLite bootstrap-on-open in `src-tauri/src/db.rs`.
  - Window geometry persistence/restore in `src-tauri/src/window.rs` and wired in `src-tauri/src/lib.rs`.
  - GitHub token persistence in OS keyring in `src-tauri/src/github_auth.rs`.

## Error Handling
- Frontend:
  - Uses `try/catch/finally` around async actions and sets user-facing error state rather than throwing in `src/components/SetupWizard.tsx` and `src/components/MainLayout.tsx`.
  - Normalizes unknown errors via `formatInvokeError` in `src/components/MainLayout.tsx`.
  - Window control failures are logged with `console.error` in `src/components/WindowControls.tsx`.
- Backend:
  - Tauri commands commonly return `Result<..., String>` with validation-first checks in `src-tauri/src/commands.rs` and `src-tauri/src/github_auth.rs`.
  - Lower-level errors are converted with `map_err(|e| e.to_string())` for frontend-safe transport in `src-tauri/src/db.rs`, `src-tauri/src/window.rs`, and `src-tauri/src/github_auth.rs`.
  - Non-fatal persistence failures are logged and flow continues (token keyring read/write paths) in `src-tauri/src/github_auth.rs`.

## Frontend Styling Conventions
- Current implementation is global CSS (single stylesheet `src/App.css`) imported by `src/App.tsx`; Tailwind utilities are not used.
- A token-like CSS variable layer exists on `html` (`--app-bg`, `--surface`, `--text-*`, etc.) in `src/App.css` and is referenced throughout component classes.
- Platform-specific styling is controlled with `html[data-platform]`, set in `src/index.tsx`.
- Modifiers are expressed as additive state classes (`is-selected`, `is-drop-target`, `is-issue-panel-open`) in `src/components/MainLayout.tsx` and `src/App.css`.
- Rule alignment notes:
  - Repo rule says no hardcoded colors and Tailwind v4 when possible (`AGENTS.md`).
  - Current stylesheet still contains direct hex values in multiple places (for example `src/App.css`), so this rule is only partially followed today.

## Notable Lint/Build Practices
- JavaScript/TypeScript scripts are limited to `dev/build/serve/tauri`; no dedicated `lint`, `test`, or `typecheck` npm script in `package.json`.
- Type checking/lint-like strictness is enforced via TypeScript compiler flags (`strict`, `noUnusedLocals`, `noUnusedParameters`, `noFallthroughCasesInSwitch`) in `tsconfig.json`.
- Vite is tuned for Tauri workflow (fixed dev port, strict port, rust-friendly clear screen behavior, and `src-tauri` watch ignore) in `vite.config.ts`.
- Tauri build lifecycle invokes frontend commands via config (`beforeDevCommand`, `beforeBuildCommand`) in `src-tauri/tauri.conf.json`.
- Rust toolchain dependencies are declared in `src-tauri/Cargo.toml`; no repo-level `clippy`, `rustfmt`, or JS lint config file is currently present.

## Evidence Paths
- `AGENTS.md`
- `package.json`
- `tsconfig.json`
- `vite.config.ts`
- `src/App.tsx`
- `src/index.tsx`
- `src/App.css`
- `src/components/MainLayout.tsx`
- `src/components/SetupWizard.tsx`
- `src/components/WindowControls.tsx`
- `src/lib/commands.ts`
- `src-tauri/Cargo.toml`
- `src-tauri/src/lib.rs`
- `src-tauri/src/db.rs`
- `src-tauri/src/commands.rs`
- `src-tauri/src/window.rs`
- `src-tauri/src/github_auth.rs`
- `src-tauri/tauri.conf.json`
