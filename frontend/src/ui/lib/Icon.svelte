<script module lang="ts">
  /**
   * The app's single icon set: 16x16 viewBox, currentColor, 1.4 stroke with
   * round caps/joins. Every icon-bearing control renders through here so size,
   * weight, and color (pressed/disabled/danger) stay consistent. Icons are
   * decorative -- the owning control carries the accessible name.
   */
  type Part = string | { d: string; fill?: boolean; dash?: string; opacity?: number };

  const circle = (cx: number, cy: number, r: number): string =>
    `M${cx - r} ${cy}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0`;
  const dot = (cx: number, cy: number): Part => ({ d: circle(cx, cy, 0.85), fill: true });
  const EYE = "M1.5 8s2.5-4.5 6.5-4.5S14.5 8 14.5 8s-2.5 4.5-6.5 4.5S1.5 8 1.5 8z";

  const ICONS = {
    brush: [
      "M13.5 2.5 8.3 7.7",
      "M9.3 8.7 7.3 6.7",
      "M7.3 6.7c-1.8-.3-3.6 1-3.6 3 0 1.5-.7 2.5-2.2 3 3.3.9 6.8-.3 7.1-3.3z",
    ],
    eraser: [
      "M6.5 13.5h7",
      "M9.3 2.9a1 1 0 0 1 1.4 0l3.4 3.4a1 1 0 0 1 0 1.4L8.3 13.5H5.6L2.9 10.8a1 1 0 0 1 0-1.4z",
      "M5.6 6.6l4.8 4.8",
    ],
    fill: [
      "M2.5 8 7.5 3l5 5-5 5z",
      "M2.5 8h10",
      "M5.3 1.5 7.5 3",
      "M14 10.3s1 1.3 1 2a1 1 0 0 1-2 0c0-.7 1-2 1-2z",
    ],
    lasso: [
      "M8 2.5c3 0 5.5 1.7 5.5 3.8S11 10 8 10 2.5 8.4 2.5 6.3 5 2.5 8 2.5z",
      "M4.6 9.3c-.7.9-.5 2 .4 2.6.8.5 1.2 1.3.9 2.6",
    ],
    "lasso-polygon": [
      "M2.5 5.5 8.5 2.5l5 3-2 4.5H4z",
      "M4.6 10c-.7.9-.5 2 .4 2.6.8.5 1.2 1.3.9 2.6",
    ],
    eyedropper: [
      "M11.25 2.25a2 2 0 0 1 2.83 2.83l-1.3 1.3-2.83-2.83z",
      "M10.98 5.4 4.2 12.18a1.5 1.5 0 0 1-.66.38l-2.04.6.6-2.04c.07-.25.2-.47.38-.66L9.26 3.68",
      "M8.4 5.9 10.1 7.6",
    ],
    transform: [
      "M2.5 5V2.5H5M11 2.5h2.5V5M13.5 11v2.5H11M5 13.5H2.5V11",
      { d: "M4.5 4.5h7v7h-7z", dash: "1.5 1" },
    ],
    "mirror-h": [
      { d: "M8 1.5v13", dash: "1.5 1.5" },
      "m6.5 4-4 2.5v3l4 2.5zM9.5 4l4 2.5v3l-4 2.5z",
    ],
    "mirror-v": [{ d: "M1.5 8h13", dash: "1.5 1.5" }, "m4 6.5 2.5-4h3l2.5 4zM4 9.5l2.5 4h3l2.5-4z"],
    "boundary-box": [
      "M2.5 2.5h11v11h-11z",
      { d: "M5.5 2.5v11M10.5 2.5v11M2.5 5.5h11M2.5 10.5h11", opacity: 0.45 },
    ],
    size: [circle(5, 11, 2), circle(10.5, 5.5, 3.5)],
    hardness: [circle(8, 8, 5.5), { d: "M8 2.5a5.5 5.5 0 0 1 0 11z", fill: true }],
    pressure: [circle(8, 8, 6), circle(8, 8, 3.25), dot(8, 8)],
    "chevron-down": ["m4 6 4 4 4-4"],
    "chevron-left": ["m10 4-4 4 4 4"],
    "chevron-right": ["m6 4 4 4-4 4"],
    save: ["M2.5 2.5h8.75l2.25 2.25V13.5h-11z", "M5 2.5v4h5.5v-4M5 13.5V9h6v4.5"],
    download: ["M8 2.5v8", "m4.5 7 3.5 3.5L11.5 7", "M2.5 13.5h11"],
    "folder-open": ["M1.5 12.5v-9h4l1.5 1.5h5.5v2", "M1.5 12.5l2-5h11l-2 5z"],
    folder: ["M1.5 3.5h4.5l1.5 1.5h7v7.5h-13z"],
    image: ["M2.5 2.5h11v11h-11z", "m2.5 11 3.5-3.5 3 3 2-2 2.5 2.5", circle(10.5, 5.5, 1)],
    check: ["M3 8.5l3.2 3.2L13 4.5"],
    x: ["M4 4l8 8M12 4l-8 8"],
    plus: ["M8 3v10M3 8h10"],
    minus: ["M3 8h10"],
    pan: ["M8 1.5v13M1.5 8h13", "m6 3.5 2-2 2 2M6 12.5l2 2 2-2M3.5 6l-2 2 2 2M12.5 6l2 2-2 2"],
    trash: [
      "M3 4.5h10M6.5 4.5V3a1 1 0 0 1 1-1h1a1 1 0 0 1 1 1v1.5",
      "M4.5 4.5l.6 8.4a1 1 0 0 0 1 .9h3.8a1 1 0 0 0 1-.9l.6-8.4",
    ],
    eye: [EYE, circle(8, 8, 2)],
    "eye-off": [EYE, circle(8, 8, 2), "M2.5 13.5l11-11"],
    lock: ["M3.5 7h9v6.5h-9z", "M5.5 7V5a2.5 2.5 0 0 1 5 0v2"],
    unlock: ["M3.5 7h9v6.5h-9z", "M5.5 7V5a2.5 2.5 0 0 1 4.9-.7"],
    alpha: [
      { d: "M2 2h6v6H2zM8 8h6v6H8z", fill: true, opacity: 0.9 },
      { d: "M8 2h6v6H8zM2 8h6v6H2z", fill: true, opacity: 0.35 },
    ],
    sliders: [
      "M2.5 4.5h3M8.5 4.5h5",
      circle(7, 4.5, 1.5),
      "M2.5 11.5h6.5M12 11.5h1.5",
      circle(10.5, 11.5, 1.5),
    ],
    merge: ["M4 2.5v3l4 3 4-3v-3", "M8 8.5v5", "m5.5 11 2.5 2.5 2.5-2.5"],
    swap: ["M3 5.5h10", "m10.5 3 2.5 2.5L10.5 8", "M13 10.5H3", "m5.5 8-2.5 2.5L5.5 13"],
    dice: [
      "M2.25 3.75a1.5 1.5 0 0 1 1.5-1.5h8.5a1.5 1.5 0 0 1 1.5 1.5v8.5a1.5 1.5 0 0 1-1.5 1.5h-8.5a1.5 1.5 0 0 1-1.5-1.5z",
      dot(5.25, 5.25),
      dot(10.75, 5.25),
      dot(5.25, 10.75),
      dot(10.75, 10.75),
      dot(8, 8),
    ],
    repeat: [
      "M8 2.25a5.75 5.75 0 0 1 5.4 3.75",
      "M13.75 4.25v2.5h-2.5",
      "M8 13.75a5.75 5.75 0 0 1-5.4-3.75",
      "M2.25 11.75v-2.5h2.5",
    ],
    settings: [
      "M2.5 4.5h11M2.5 8h11M2.5 11.5h11",
      { d: circle(5.5, 4.5, 1.4), fill: true },
      { d: circle(10.5, 8, 1.4), fill: true },
      { d: circle(6.5, 11.5, 1.4), fill: true },
    ],
    undo: ["M5.5 3 2.5 6l3 3", "M2.5 6h7a4 4 0 0 1 0 8H7"],
    redo: ["m10.5 3 3 3-3 3", "M13.5 6h-7a4 4 0 0 0 0 8H9"],
    grip: ["M4 5h8M4 8h8M4 11h8"],
    "panel-left": ["M2.5 2.5h11v11h-11z", "M6.5 2.5v11"],
    "panel-right": ["M2.5 2.5h11v11h-11z", "M9.5 2.5v11"],
    fit: ["M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10"],
    "fit-content": ["M6 2.5V6H2.5M10 2.5V6h3.5M13.5 10H10v3.5M2.5 10H6v3.5"],
    grid: ["M2.5 2.5h11v11h-11z", "M2.5 6.2h11M2.5 9.8h11M6.2 2.5v11M9.8 2.5v11"],
    tiles: ["M2.5 2.5H7V7H2.5zM9 2.5h4.5V7H9zM2.5 9H7v4.5H2.5zM9 9h4.5v4.5H9z"],
  } satisfies Record<string, Part[]>;

  export type IconName = keyof typeof ICONS;
</script>

<script lang="ts">
  type Props = { name: IconName; size?: number; class?: string };

  let { name, size = 14, class: className = "" }: Props = $props();

  const parts = $derived(
    (ICONS[name] as Part[]).map((part) => (typeof part === "string" ? { d: part } : part)),
  );
</script>

<svg
  class="shrink-0 {className}"
  width={size}
  height={size}
  viewBox="0 0 16 16"
  fill="none"
  stroke="currentColor"
  stroke-width="1.4"
  stroke-linecap="round"
  stroke-linejoin="round"
  aria-hidden="true"
  focusable="false"
>
  {#each parts as part (part.d)}
    <path
      d={part.d}
      fill={part.fill ? "currentColor" : undefined}
      stroke={part.fill ? "none" : undefined}
      stroke-dasharray={part.dash}
      opacity={part.opacity}
    />
  {/each}
</svg>
