# Stack

## Languages and Runtime
- TypeScript is used for the frontend application and Tauri command bindings (`src/index.tsx`, `src/App.tsx`, `src/lib/commands.ts`).
- Rust (edition 2021) is used for the native desktop backend (`src-tauri/Cargo.toml`, `src-tauri/src/lib.rs`, `src-tauri/src/commands.rs`).
- CSS is used for styling (`src/App.css`).
- Runtime model is Tauri desktop: web frontend + Rust backend command bridge (`src-tauri/src/lib.rs`, `src/lib/commands.ts`).

## Frontend Frameworks and Libraries
- SolidJS (`solid-js` `^1.9.3`) powers the UI (`package.json`, `src/index.tsx`).
- Vite (`vite` `^6.0.3`) is the dev server and bundler (`package.json`, `vite.config.ts`).
- `vite-plugin-solid` (`^2.11.0`) integrates Solid with Vite (`package.json`, `vite.config.ts`).
- Tauri JavaScript API (`@tauri-apps/api` `^2.10.1`) is used for invoking Rust commands and window APIs (`package.json`, `src/lib/commands.ts`, `src/components/WindowControls.tsx`).
- UI helper libraries include `highlight.js` and `simple-icons` (`package.json`, `src/components/MainLayout.tsx`).

## Native/Desktop Backend
- Tauri v2 Rust crate (`tauri = { version = "2" }`) provides the desktop runtime and command system (`src-tauri/Cargo.toml`, `src-tauri/src/lib.rs`).
- Tauri build integration uses `tauri-build` (`src-tauri/Cargo.toml`, `src-tauri/build.rs`).
- Rust backend exposes command handlers with `#[tauri::command]` for SQLite, filesystem, and GitHub auth flows (`src-tauri/src/commands.rs`, `src-tauri/src/github_auth.rs`).

## Build and Tooling
- Package manager is pnpm (lockfile present at `pnpm-lock.yaml`; Tauri config uses `pnpm dev` and `pnpm build`).
- NPM scripts are defined in `package.json`:
  - `dev` / `start`: `vite`
  - `build`: `vite build`
  - `serve`: `vite preview`
  - `tauri`: `tauri`
- Tauri build pipeline links frontend output to desktop bundle via `frontendDist: "../dist"` (`src-tauri/tauri.conf.json`).
- TypeScript compiler configuration is in `tsconfig.json` and `tsconfig.node.json` (strict mode, bundler module resolution, noEmit).

## Primary Dependencies
- JavaScript runtime dependencies (`package.json`):
  - `solid-js`
  - `@tauri-apps/api`
  - `highlight.js`
  - `simple-icons`
- JavaScript dev dependencies (`package.json`):
  - `vite`
  - `vite-plugin-solid`
  - `typescript`
  - `@tauri-apps/cli`
- Rust dependencies (`src-tauri/Cargo.toml`):
  - `tauri` (desktop shell/runtime)
  - `rusqlite` with `bundled` feature (embedded SQLite)
  - `serde`, `serde_json` (serialization)
  - `reqwest` with `rustls-tls` and `json` (HTTP client)
  - `keyring` (OS credential storage)
  - `rfd` (native file/folder dialogs)
  - `webbrowser` (open URLs in system browser)

## Key Configuration Files
- `package.json`: frontend scripts and JS dependency graph.
- `pnpm-lock.yaml`: pinned Node dependency versions.
- `vite.config.ts`: dev server port (`1420`), HMR host logic, and Solid plugin setup.
- `tsconfig.json`: frontend TypeScript compiler/linting strictness.
- `tsconfig.node.json`: TypeScript settings for Node-side config files.
- `src-tauri/Cargo.toml`: Rust crate metadata and dependency graph.
- `src-tauri/Cargo.lock`: pinned Rust crate versions.
- `src-tauri/tauri.conf.json`: Tauri app identity, window config, build hooks, and bundle targets.
- `src-tauri/capabilities/default.json`: allowed Tauri window capabilities/permissions.

## Not Present in Current Stack
- No Tailwind CSS packages/config (`tailwind`, `postcss`, `tailwind.config.*`) were found in `package.json` or repository config files.
- No explicit frontend test framework setup (`vitest`, `jest`, `playwright`) was found in `package.json`.
