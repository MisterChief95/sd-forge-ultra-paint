<script lang="ts">
  let fps = $state(0);

  let frames = 0;
  let windowStart = performance.now();
  let animationFrame: number;

  function tick(now: number): void {
    frames += 1;
    const elapsed = now - windowStart;
    if (elapsed >= 500) {
      fps = Math.round((frames * 1000) / elapsed);
      frames = 0;
      windowStart = now;
    }
    animationFrame = requestAnimationFrame(tick);
  }

  $effect(() => {
    animationFrame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(animationFrame);
  });
</script>

<div
  class="absolute bottom-2 right-2 z-10 rounded border px-2 py-1 text-xs tabular-nums shadow-lg"
  style="border-color: var(--upaint-border); background: color-mix(in srgb, var(--upaint-surface) 80%, transparent); color: var(--upaint-text);"
>
  {fps} FPS
</div>
