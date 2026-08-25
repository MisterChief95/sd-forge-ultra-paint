## GenerationPanel: Svelte 5 compliance + split plan

`frontend/src/ui/GenerationPanel.svelte` was updated to align with Svelte 5 and prepared for a safe component split.

### Implemented now
- Replaced `use:disableSpellcheck` with `{@attach fromAction(disableSpellcheck)}`.
- Added keyed `each` blocks for sampler and scheduler options.
- Verified with Svelte autofixer (Svelte 5): no remaining issues/suggestions.

### Planned split (next)
- Keep `GenerationPanel.svelte` as the orchestrator/state owner.
- Extract focused pieces into `frontend/src/ui/generation/`:
  - `generationController.svelte.ts` (async workflow + progress/cancel lifecycle)
  - `generationApi.ts` (API calls)
  - `PromptFields.svelte`
  - `SamplingControls.svelte`
  - `InpaintControls.svelte`
  - `ResolutionSettings.svelte`
  - `GenerationActionsAndStatus.svelte`
