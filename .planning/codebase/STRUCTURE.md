# Structure

## Repository Layout (Top Level)
- Frontend source: `src/`
- Native backend source: `src-tauri/src/`
- Native app config/assets: `src-tauri/tauri.conf.json`, `src-tauri/capabilities/`, `src-tauri/icons/`
- Build/tool config: `package.json`, `vite.config.ts`, `tsconfig.json`, `tsconfig.node.json`, `src-tauri/Cargo.toml`, `src-tauri/build.rs`
- Static HTML shell: `index.html`
- Output/build artifacts: `dist/`, `src-tauri/target/`
- Planning docs: `.planning/codebase/`

## Frontend Directory Map (`src/`)
- App bootstrap:
- `src/index.tsx` mounts the Solid app and sets platform metadata.
- `src/App.tsx` controls high-level route/state between setup and main workspace.
- Components:
- `src/components/MainLayout.tsx` contains authenticated workspace UI and most feature orchestration.
- `src/components/SetupWizard.tsx` contains initial folder selection flow.
- `src/components/WindowControls.tsx` contains custom window action buttons.
- IPC client:
- `src/lib/commands.ts` contains typed wrappers for all Tauri commands used by the renderer.
- Styling:
- `src/App.css` is the central stylesheet and token source (CSS custom properties).
- Type setup:
- `src/vite-env.d.ts`.

## Backend Directory Map (`src-tauri/`)
- Runtime entry:
- `src-tauri/src/main.rs` -> calls `hostlocal_lib::run()`.
- App composition + command registration:
- `src-tauri/src/lib.rs`.
- Feature command modules:
- `src-tauri/src/commands.rs` (SQLite settings, project creation, folder picker).
- `src-tauri/src/github_auth.rs` (GitHub OAuth device flow, repo/item loading, browser openers, keychain token handling).
- Infrastructure helpers:
- `src-tauri/src/db.rs` (db path resolution, schema initialization, connection helper).
- `src-tauri/src/window.rs` (restore/persist native window geometry).
- Capability and permissions:
- `src-tauri/capabilities/default.json`.
- Native metadata/config:
- `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json`.

## Feature Location Guide
### Setup and onboarding
- UI: `src/App.tsx`, `src/components/SetupWizard.tsx`.
- Frontend command wrappers: `src/lib/commands.ts` (`getDevelopmentFolder`, `pickDevelopmentFolder`, `setDevelopmentFolder`).
- Backend handlers: `src-tauri/src/commands.rs` (`sqlite_get_development_folder`, `pick_development_folder`, `sqlite_set_development_folder`).
- Persistence: `src-tauri/src/db.rs` (`app_settings` table).

### GitHub connection and repository board
- UI orchestration: `src/components/MainLayout.tsx`.
- Frontend command wrappers: `src/lib/commands.ts` (`githubAuth*`, `githubList*`, `githubOpen*`).
- Backend handlers and GitHub HTTP integration: `src-tauri/src/github_auth.rs`.
- Token persistence: OS keychain via `keyring` in `src-tauri/src/github_auth.rs`.

### Project creation and local project list
- Frontend wrapper exists in `src/lib/commands.ts` (`listProjects`, `createProject`).
- Backend implementation in `src-tauri/src/commands.rs` (`sqlite_list_projects`, `sqlite_create_project`).
- Directory creation and naming normalization are implemented in `src-tauri/src/commands.rs`.

### Window controls and geometry persistence
- UI controls: `src/components/WindowControls.tsx`.
- Allowed window operations: `src-tauri/capabilities/default.json`.
- State restore/persist logic: `src-tauri/src/window.rs`, wired in `src-tauri/src/lib.rs`.

### Visual system and responsive behavior
- Global tokens, layout, component classes, and responsive rules: `src/App.css`.
- Platform-specific style branch (`macos` vs `non-macos`) derives from `src/index.tsx`.

## Naming Conventions
- Frontend component filenames use PascalCase: `MainLayout.tsx`, `SetupWizard.tsx`, `WindowControls.tsx`.
- Utility/module filenames use lowercase/snake-like naming by concern: `src/lib/commands.ts`.
- Rust module files are snake_case: `commands.rs`, `github_auth.rs`, `window.rs`, `db.rs`.
- Tauri command names are prefixed by domain:
- `sqlite_*` for database/settings.
- `github_*` for auth and GitHub APIs.
- `pick_development_folder` for native dialog integration.
- CSS classes are descriptive and area-prefixed (`sidebar-*`, `content-*`, `kanban-*`) in `src/App.css`.

## Code Organization Patterns
- Feature logic is mostly colocated by runtime side:
- Frontend behavior and interaction logic in `src/components/*`.
- Backend side effects/integration logic in `src-tauri/src/*`.
- Frontend-to-backend communication is intentionally funneled through one boundary file: `src/lib/commands.ts`.
- Styling is centralized in a single stylesheet rather than per-component CSS modules: `src/App.css`.
