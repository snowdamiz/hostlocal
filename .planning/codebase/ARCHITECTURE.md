# Architecture

## System Type
- Desktop application built with a Tauri shell and a SolidJS renderer.
- Frontend runtime: Vite + Solid (`package.json`, `vite.config.ts`, `src/index.tsx`).
- Backend runtime: Rust + Tauri command host (`src-tauri/src/main.rs`, `src-tauri/src/lib.rs`).

## Runtime Entry Points
- Browser window bootstraps from `index.html`, which mounts `src/index.tsx`.
- Renderer root is `src/App.tsx`; this file gates the app between setup and main workspace.
- Native entry is `src-tauri/src/main.rs`, delegating to `hostlocal_lib::run()` in `src-tauri/src/lib.rs`.
- Tauri app/window behavior is configured in `src-tauri/tauri.conf.json`.
- Rust build setup is handled in `src-tauri/build.rs`.

## Architectural Layers
1. Presentation Layer (Solid components)
- Shell and state gate: `src/App.tsx`.
- Onboarding/setup flow: `src/components/SetupWizard.tsx`.
- Window chrome controls: `src/components/WindowControls.tsx`.
- Main product UI (GitHub repo list, board, issue details, canvas interactions): `src/components/MainLayout.tsx`.
- Styling tokens and layout live centrally in `src/App.css`.

2. Frontend Boundary Layer (IPC wrappers)
- `src/lib/commands.ts` exposes typed wrappers around Tauri `invoke(...)` calls.
- This layer is the only direct renderer-to-backend command surface in the frontend code.

3. Backend Command Layer (Tauri commands)
- SQLite and local filesystem commands: `src-tauri/src/commands.rs`.
- GitHub OAuth + API commands: `src-tauri/src/github_auth.rs`.
- Command registration and wiring: `src-tauri/src/lib.rs` (`tauri::generate_handler!`).

4. Infrastructure Layer (persistence + OS integration)
- SQLite path creation + schema bootstrap + connection helper: `src-tauri/src/db.rs`.
- Window state persist/restore to app config dir: `src-tauri/src/window.rs`.
- OS keychain token storage and browser opening in `src-tauri/src/github_auth.rs`.
- Tauri capability scope (window-related permissions): `src-tauri/capabilities/default.json`.

## Data Flow
### 1) App startup and setup gating
1. `index.html` loads `src/index.tsx`.
2. `src/index.tsx` sets platform metadata (`data-platform`) and renders `src/App.tsx`.
3. `src/App.tsx` calls `getDevelopmentFolder()` from `src/lib/commands.ts`.
4. Backend command `sqlite_get_development_folder` in `src-tauri/src/commands.rs` reads `app_settings` via `src-tauri/src/db.rs`.
5. UI route decision:
- Folder exists -> render `MainLayout`.
- Folder missing/error -> render `SetupWizard`.

### 2) Setup wizard flow
1. `src/components/SetupWizard.tsx` requests folder selection via `pickDevelopmentFolder()`.
2. Rust command `pick_development_folder` opens a native folder picker (`rfd`) in `src-tauri/src/commands.rs`.
3. User confirms; frontend calls `setDevelopmentFolder(...)`.
4. `sqlite_set_development_folder` validates/canonicalizes path and upserts `app_settings`.
5. App switches to ready state in `src/App.tsx`.

### 3) GitHub auth and board flow
1. `src/components/MainLayout.tsx` runs `refreshAuthState()` on mount.
2. `githubAuthStatus()` invokes `github_auth_status` in `src-tauri/src/github_auth.rs`.
3. Backend hydrates session from in-memory `GithubAuthState` or OS keychain token; validates token via GitHub `/user`.
4. On authenticated state, frontend loads repositories via `githubListRepositories()` -> `github_list_repositories`.
5. Repository selection triggers item load via `githubListRepositoryItems(...)` -> `github_list_repository_items`.
6. Board columns are derived in frontend (`inferDefaultColumn`, `groupedItemsByColumn`) and can be manually overridden in local UI state.

### 4) Device flow polling
1. `connectGithub()` in `src/components/MainLayout.tsx` calls `githubAuthStart()` -> `github_auth_start`.
2. Backend requests a GitHub device code, stores pending state in `GithubAuthState`.
3. Frontend schedules polling (`setTimeout`) calling `githubAuthPoll()` -> `github_auth_poll`.
4. Authorized status persists token to OS keychain and refreshes frontend auth/repository state.

### 5) Window state flow
1. During setup in `src-tauri/src/lib.rs`, window state file path is resolved via `src-tauri/src/window.rs`.
2. Existing state is restored on startup.
3. On move/resize/close-request events, state is persisted back to disk.

## State Management
### Frontend
- Local component state is managed with Solid primitives (`createSignal`, `createMemo`, `createEffect`, `onMount`, `onCleanup`) in `src/App.tsx` and `src/components/MainLayout.tsx`.
- State is colocated by feature, not in a global store.
- Async race handling is explicit for board fetches using `repositoryItemsRequestId` in `src/components/MainLayout.tsx`.
- Poll timers and animation frames are explicitly cleared during cleanup.

### Backend
- App-scoped shared state is injected with `app.manage(...)` in `src-tauri/src/lib.rs`:
- `DbPath` for SQLite location.
- `GithubAuthState` (`Mutex` guarded session) for auth/session/pending device flow.
- Durable state:
- SQLite file (`hostlocal.sqlite`) under app data dir (`src-tauri/src/db.rs`).
- Keychain token persistence (`src-tauri/src/github_auth.rs`).
- Window geometry JSON under app config dir (`src-tauri/src/window.rs`).

## IPC Boundaries
- All renderer-to-native calls cross through Tauri `invoke`, centralized in `src/lib/commands.ts`.
- Command names are explicit and grouped by domain:
- SQLite/settings/project commands (`sqlite_*`, `pick_development_folder`) implemented in `src-tauri/src/commands.rs`.
- GitHub/auth/browser commands (`github_*`) implemented in `src-tauri/src/github_auth.rs`.
- Registration boundary lives in `src-tauri/src/lib.rs`; only registered handlers are callable.
- Serialization contract uses Rust `serde` with camelCase mapping for JS interop in `src-tauri/src/github_auth.rs` and `src-tauri/src/commands.rs`.

## Notable Patterns
- Single-file feature orchestration: most product behavior is concentrated in `src/components/MainLayout.tsx`.
- Typed command façade pattern in `src/lib/commands.ts` keeps UI code decoupled from raw command strings.
- Defensive URL validation before browser open in `src-tauri/src/github_auth.rs` (`github_open_verification_url`, `github_open_item_url`).
- Token hygiene pattern: access tokens are kept in OS keychain, not SQLite (`README.md`, `src-tauri/src/github_auth.rs`).
- Lazy schema init pattern: every DB connection ensures schema existence via `initialize_schema` in `src-tauri/src/db.rs`.
- Platform-adaptive chrome pattern: `src/index.tsx` sets platform data attribute consumed by style rules in `src/App.css`.
