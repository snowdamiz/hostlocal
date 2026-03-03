# Phase 5: Live Telemetry and Safe Summaries - Context

**Gathered:** 2026-03-03
**Status:** Ready for planning

<domain>
## Phase Boundary

Deliver live in-app run activity and a final post-run summary inside existing app surfaces, while preventing tokens/secrets from appearing in telemetry or summary output.

</domain>

<decisions>
## Implementation Decisions

### Live event detail
- Live stream follows the currently selected issue in the right sidebar.
- Event detail should be milestone-level (more than stage chips, less than raw command transcript).
- Events should render in a newest-first feed.
- When a run reaches terminal status, keep final live events visible and hand off directly to the final summary.

### Final summary shape
- Final summary should live in the existing issue details panel (right sidebar), not a separate view.
- Summary must include completion outcome, key actions, and validation outcomes.
- Key actions should be concise milestone bullets, not a full raw transcript.
- Validation outcomes should always be explicit, including unavailable/missing states (for example `not-run`/`not-found`).

### Secret-safe visibility
- Sensitive substrings should be masked in-place with a clear marker (for example `[REDACTED]`) instead of dropping entire entries.
- Redaction scope should be strict by default: tokens, API keys, auth headers, cookie/session values, and credential-like environment values.
- UI may support a manual reveal toggle for advanced local debugging workflows.

### Claude's Discretion
- Unsafe-content uncertainty policy (when detection confidence is low) was left to implementation discretion.
- Prefer conservative handling during planning because Phase 5 includes SEC-01 guarantees.

</decisions>

<specifics>
## Specific Ideas

- Keep live telemetry and summary inside the current right-sidebar workflow to avoid adding navigation complexity.
- Preserve readability by showing masked context (`[REDACTED]`) rather than blanking all affected lines.

</specifics>

<code_context>
## Existing Code Insights

### Reusable Assets
- `src/features/board/components/IssueDetailsPanel.tsx`: Existing right-sidebar runtime sections (`Current Runtime Stage`, `Runtime history`) are the primary UI insertion point.
- `src/features/board/hooks/useBoardInteractions.ts`: Already hydrates runtime snapshot/history and subscribes to `runtime/run-stage-changed` events.
- `src/lib/commands.ts`: Typed runtime contracts already exist for snapshot/history payloads and can be extended for telemetry/summary fields.
- `src-tauri/src/runtime_boundary.rs`: Owns run lifecycle transitions, emits runtime stage events, and writes minimal terminal evidence.

### Established Patterns
- Runtime updates are event-driven from Rust to renderer (`runtime/run-stage-changed`) with repository filtering in frontend listeners.
- Runtime persistence is SQLite-first (`runtime_runs`, `runtime_run_transitions`) with deterministic transition sequencing.
- UI runtime details are rendered as token-driven badges/cards in Tailwind class strings using CSS variables.

### Integration Points
- Backend command/event surface: `src-tauri/src/runtime_boundary.rs`, `src-tauri/src/commands.rs`, and handler registration in `src-tauri/src/lib.rs`.
- Frontend wiring: `useBoardInteractions` for data subscription/hydration and `IssueDetailsPanel` for sidebar presentation.
- Security boundary: GitHub credentials remain in OS keychain via `src-tauri/src/github_auth.rs`; telemetry surfaces must never require plaintext token handling.

</code_context>

<deferred>
## Deferred Ideas

None - discussion stayed within phase scope.

</deferred>

---

*Phase: 05-live-telemetry-and-safe-summaries*
*Context gathered: 2026-03-03*
