# TESTING

## Current Testing Setup (Observed)
- No JavaScript/TypeScript test runner is configured in `package.json` (no `test` script and no test-related dev dependency entries).
- No Rust test modules or test attributes are present in `src-tauri/src/*.rs` (no `#[test]`, `#[cfg(test)]`, or `mod tests`).
- No frontend test files (`*.test.*` or `*.spec.*`) are present under `src/`.
- No end-to-end test tool config (Playwright/Cypress) is present at repository root.
- No coverage tooling config is present.

## Current Coverage Status
- Effective automated coverage is **absent** for both frontend and backend in the current repository state.
- High-risk untested areas include:
  - UI flow/state transitions and async error states in `src/App.tsx`, `src/components/SetupWizard.tsx`, and `src/components/MainLayout.tsx`.
  - Frontend command wrapper contract in `src/lib/commands.ts`.
  - Input normalization and filesystem/database behavior in `src-tauri/src/commands.rs` and `src-tauri/src/db.rs`.
  - OAuth/device-flow and session invalidation branches in `src-tauri/src/github_auth.rs`.
  - Window state persistence edge cases in `src-tauri/src/window.rs`.

## Frameworks/Tools Recommended for This Stack
- Frontend unit/component tests:
  - `vitest` + `@solidjs/testing-library` + `jsdom` (matches Vite + Solid stack from `package.json` and `vite.config.ts`).
- Frontend API boundary tests:
  - `vitest` mocking `@tauri-apps/api/core` for `src/lib/commands.ts` wrappers.
- Rust backend tests:
  - Native `cargo test` with module-level unit tests in `src-tauri/src/*.rs`.
  - Add temporary-directory based tests for filesystem paths and folder creation logic in `src-tauri/src/commands.rs` and `src-tauri/src/window.rs`.
- Optional desktop E2E:
  - Add Playwright/Tauri-driver style smoke checks only after unit coverage exists, focused on app boot, setup flow, and GitHub auth UI fallback paths.

## Recommended Test Organization
- Frontend:
  - Keep component tests adjacent to components: `src/components/*.test.tsx`.
  - Keep utility/parser tests adjacent to logic: `src/lib/*.test.ts` and extracted pure helpers from `src/components/MainLayout.tsx` where needed.
  - Use fixture factories for GitHub payload shapes based on interfaces in `src/lib/commands.ts`.
- Backend Rust:
  - Add `#[cfg(test)] mod tests` inside each module for pure logic.
  - For filesystem/database behavior, use isolated temp paths per test and avoid shared state.
  - Keep command validation tests close to command functions in `src-tauri/src/commands.rs`.
  - Keep auth parsing/mapping tests close to auth helpers in `src-tauri/src/github_auth.rs`.
- Test layering priority:
  1. Pure logic/helpers (fast, deterministic).
  2. Command/service unit tests with mocks/stubs.
  3. Minimal E2E smoke paths.

## Practical Initial Coverage Plan
1. Frontend: test setup wizard behavior (`browseForFolder`, error rendering, confirm disabled state) from `src/components/SetupWizard.tsx`.
2. Frontend: test board parsing/helpers (`parseIssueBody`, `parseIssueInlineTokens`, `inferDefaultColumn`) from `src/components/MainLayout.tsx` after extraction to a testable module.
3. Backend: test `normalize_project_folder_name` and unique folder allocation behavior from `src-tauri/src/commands.rs`.
4. Backend: test `map_http_error` and auth state transitions in `src-tauri/src/github_auth.rs`.
5. Backend: test restore/persist guards for minimized/zero-size windows in `src-tauri/src/window.rs`.

## Evidence Paths
- `package.json`
- `vite.config.ts`
- `src/App.tsx`
- `src/components/SetupWizard.tsx`
- `src/components/MainLayout.tsx`
- `src/lib/commands.ts`
- `src-tauri/src/db.rs`
- `src-tauri/src/commands.rs`
- `src-tauri/src/window.rs`
- `src-tauri/src/github_auth.rs`
- `src-tauri/tauri.conf.json`
