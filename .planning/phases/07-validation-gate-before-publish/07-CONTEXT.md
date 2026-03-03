# Phase 7: Validation Gate Before Publish - Context

**Gathered:** 2026-03-03
**Status:** Ready for planning

<domain>
## Phase Boundary

Require explicit validation outcomes before publish readiness is shown. This phase defines the readiness gate behavior for code and browser/visual validation outcomes and attaches those outcomes to run results. Automated draft PR publication remains Phase 8.

</domain>

<decisions>
## Implementation Decisions

### Validation gate rules
- Publish readiness is allowed only when `code` validation outcome is `pass`.
- Any non-`pass` code outcome (`fail`, `timeout`, `not-found`, `not-run`) blocks readiness.
- When browser validation is applicable for the run, readiness is allowed only when `browser` outcome is `pass`.
- When browser validation is applicable and outcome is non-`pass`, readiness is blocked.
- When readiness is blocked by validation, the issue details surface should show a clear blocked banner plus the existing validation status chips.

### Browser applicability behavior
- Browser/visual validation applicability should be auto-detected from repository signals (not manually toggled per run).
- Applicability is evaluated per run, not permanently locked per repository.
- If browser validation is not applicable for a run, browser status remains visible as `not-run`.
- If browser validation is applicable but no browser result is captured, browser status is `not-found` and readiness remains blocked.

### Claude's Discretion
- Exact copy text for the blocked-readiness banner.
- Exact visual styling details for banner/chip emphasis using existing design tokens.
- Precise repository-signal heuristics used to detect browser-validation applicability.

</decisions>

<specifics>
## Specific Ideas

- Keep the existing explicit status vocabulary (`pass|fail|timeout|not-found|not-run`) and use it directly in readiness decisions.
- Keep browser status visible even when not applicable so users can distinguish `not-run` from missing/failed cases.

</specifics>

<code_context>
## Existing Code Insights

### Reusable Assets
- `src-tauri/src/runtime_boundary.rs`: existing summary projection (`runtime_get_issue_run_summary_inner`) and validation parsing (`parse_validation_status`, `derive_validation_outcomes`) already produce status outcomes that can feed the gate.
- `src/lib/commands.ts`: typed summary contracts already include `validationOutcomes.code` and `validationOutcomes.browser`.
- `src/features/board/hooks/useBoardInteractions.ts`: runtime summary normalization/fallback logic already centralizes UI-safe validation statuses.
- `src/features/board/components/IssueDetailsPanel.tsx`: existing run summary section already renders validation chips and is the natural location for blocked-readiness messaging.

### Established Patterns
- Validation status computation is derived from runtime telemetry evidence and normalized in frontend before display.
- UI data hydration follows existing snapshot/history/telemetry/summary fetch patterns in `useBoardInteractions`.
- Runtime lifecycle states remain fixed (`queued -> preparing -> coding -> validating -> publishing`), with terminal outcomes rendered through existing summary surfaces.

### Integration Points
- Backend readiness gating inputs: runtime summary generation in `src-tauri/src/runtime_boundary.rs`.
- Frontend readiness interpretation: summary normalization + selected issue hydration in `src/features/board/hooks/useBoardInteractions.ts`.
- User-facing gate visibility: run summary section in `src/features/board/components/IssueDetailsPanel.tsx`.
- Downstream publish flow (Phase 8) should consume Phase 7 readiness outcomes rather than infer ad hoc validation logic.

</code_context>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope.

</deferred>

---

*Phase: 07-validation-gate-before-publish*
*Context gathered: 2026-03-03*
