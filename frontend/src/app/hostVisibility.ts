/**
 * Whether Forge is showing our tab. A hidden same-origin iframe keeps getting
 * rAF and timers, so the host script (`javascript/ultra-paint-iframe.js`)
 * posts tab changes and per-frame work idles on them. Always true when not
 * embedded (e.g. popped out); the browser throttles hidden tabs itself.
 */
let visible = true;
const listeners = new Set<(visible: boolean) => void>();

window.addEventListener("message", (event) => {
  if (event.source !== window.parent || event.origin !== window.location.origin) return;
  if (event.data?.type !== "ultra-paint:visible") return;
  const next = event.data.visible === true;
  if (next === visible) return;
  visible = next;
  for (const listener of listeners) listener(visible);
});

export function isHostVisible(): boolean {
  return visible;
}

export function onHostVisibilityChange(listener: (visible: boolean) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
