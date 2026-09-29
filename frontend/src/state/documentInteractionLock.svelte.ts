import { filterStore } from "./filterStore.svelte";
import { previewStore } from "./previewStore.svelte";

// GPU-resident layer pixels do not survive a lost graphics context, so the
// document stays frozen for the rest of the page's life once it happens.
let graphicsContextLost = $state(false);

export function isGraphicsContextLost(): boolean {
  return graphicsContextLost;
}

export function markGraphicsContextLost(): void {
  graphicsContextLost = true;
}

// Set once another tab takes over the document (see app/popOut.ts); this copy
// stays frozen, and stops saving, until it reloads.
let handedOff = $state(false);

export function isHandedOff(): boolean {
  return handedOff;
}

export function markHandedOff(): void {
  handedOff = true;
}

/** Document pixels and structure stay frozen until an active preview is resolved. */
export function isDocumentMutationLocked(): boolean {
  return graphicsContextLost || handedOff || previewStore.selected !== null || filterStore.active;
}
