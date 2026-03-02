# Phase 1: Tailwind v4 Styling Foundation - Context

**Gathered:** 2026-03-02
**Status:** Ready for planning

<domain>
## Phase Boundary

Migrate existing authenticated app views from legacy global CSS-file styling to Tailwind v4 utilities backed by design tokens, while keeping current workflows visually usable (repo selection, board view, and sidebar telemetry surfaces).

</domain>

<decisions>
## Implementation Decisions

### Token Naming Strategy
- Rename the existing token set systematically during migration instead of preserving current token names as-is.
- Keep tokens semantic (surface/text/border/status intent), then map Tailwind v4 utility usage to that semantic set.

### Hardcoded Color Policy
- Replace hardcoded color values with design tokens across migrated surfaces.
- Include platform window-control accents and destructive/error states in tokenization scope.

### Typography and Spacing Density
- Preserve the current compact density and visual rhythm.
- Translate existing spacing and type sizing into token-driven Tailwind usage rather than broadening layout spacing in this phase.

### Theme Scope for Phase 1
- Keep migration minimal for now; focus on parity with the current dark visual system.
- Do not add additional theme variants in this phase.

### Claude's Discretion
- Final token names and grouping structure.
- Exact Tailwind v4 utility composition per component/surface.
- Whether to use a temporary compatibility alias layer during cutover.

</decisions>

<code_context>
## Existing Code Insights

### Reusable Assets
- `src/App.css`: current token layer and complete style behavior baseline to translate.
- Class-based surface markup already exists in:
  - `src/App.tsx`
  - `src/components/SetupWizard.tsx`
  - `src/components/MainLayout.tsx`
  - `src/components/WindowControls.tsx`
- `src/index.tsx` already sets `html[data-platform]` for macOS vs non-macOS styling variants.

### Established Patterns
- Styling is centralized in one global stylesheet imported by `src/App.tsx`.
- UI state styles rely on modifier classes (`is-selected`, `is-drop-target`, `is-issue-panel-open`).
- Tailwind is not currently installed/configured in the repo.

### Integration Points
- App shell + setup/loading flows (`src/App.tsx`, `src/components/SetupWizard.tsx`).
- Main product surfaces (left repo sidebar, board canvas/columns/cards, right issue details sidebar) in `src/components/MainLayout.tsx`.
- Platform-specific window controls in `src/components/WindowControls.tsx`.

</code_context>

<specifics>
## Specific Ideas

No specific external design references were requested; prioritize migration fidelity to existing behavior and layout.

</specifics>

<deferred>
## Deferred Ideas

None - discussion stayed within phase scope.

</deferred>

---

*Phase: 01-tailwind-v4-styling-foundation*
*Context gathered: 2026-03-02*
