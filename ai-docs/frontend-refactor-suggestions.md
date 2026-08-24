# Frontend refactor suggestions

This document captures the highest-value reuse opportunities in the Svelte frontend, based on the current UI structure and repeated patterns.

## 1) Reusable input controls

These patterns appear repeatedly and are ideal for small, testable UI primitives.

### Slider + numeric value pair

Files:
- `frontend/src/ui/PaintToolbar.svelte`
- `frontend/src/ui/GenerationPanel.svelte`

Repeated patterns:
- label + range input + numeric companion input
- synchronized value state
- min/max/step configuration
- display formatting (percent, pixels, decimal values)

Suggested component:
- `RangeField.svelte`
- Props: `label`, `value`, `min`, `max`, `step`, `format`, `displaySuffix`, `onChange`
- Optional variant for `range + number` side-by-side, or a compact single-track input

Benefits:
- reduces duplicated markup
- keeps numeric validation centralized
- consistent styling and accessibility across the app

### Tool button / segmented toggle

Files:
- `frontend/src/ui/PaintToolbar.svelte`

Repeated patterns:
- Brush / Eraser / Fill / Boundary Box buttons
- active/inactive styling
- `aria-pressed` state
- click handlers with shared class logic

Suggested component:
- `ToolButton.svelte`
- or `SegmentedToggle.svelte`

Props:
- `label`, `active`, `onClick`, `icon`, `title`, `disabled`

Benefits:
- one place for styling and keyboard semantics
- easier to add new tools without repeating button markup

## 2) Form field abstractions

Files:
- `frontend/src/ui/GenerationPanel.svelte`

Repeated patterns:
- labeled textarea
- labeled select
- simple stacked form controls

Suggested component:
- `FieldLabel.svelte`
- `TextAreaField.svelte`
- `SelectField.svelte`

These can wrap common styling instead of repeating border, radius, focus, and text classes.

## 3) Layer-row presentation

File:
- `frontend/src/ui/LayerPanel.svelte`

This is the biggest UI candidate for decomposition.

Potential subcomponents:
- `LayerRow.svelte`
- `LayerThumbnail.svelte`
- `LayerNameEditor.svelte`
- `LayerOpacityControl.svelte`
- `LayerBlendModeSelect.svelte`
- `LayerDragHandle.svelte`

The row currently handles:
- selection
- rename state
- thumbnail rendering
- opacity change
- blend mode selection
- drag/drop ordering
- interactive target checks

Breaking this into smaller components would improve readability and allow targeted testing.

## 4) Shared style tokens / utility classes

Files:
- all Svelte UI files

There are many repeated class strings:
- border colors
- surface backgrounds
- radius values
- accent colors
- transition styles

Suggested action:
- centralize repeated styling in a small utility layer or CSS token file
- avoid repeated inline class concatenation where possible

This is not mandatory, but it would help keep the UI more consistent as more controls are added.

## Recommended refactor order

1. `RangeField.svelte`
2. `ToolButton.svelte`
3. `LayerRow.svelte` split-out
4. semantic form-field wrappers for generation settings
5. shared styling utility cleanup

This sequence gives the highest readability and maintainability gain with the least risk.
