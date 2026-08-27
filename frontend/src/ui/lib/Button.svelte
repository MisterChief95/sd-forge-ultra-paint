<script lang="ts">
  import type { Snippet } from "svelte";
  import type { HTMLButtonAttributes } from "svelte/elements";

  type Variant = "default" | "primary" | "danger" | "ghost";
  type Size = "sm" | "md" | "icon";
  type Radius = "all" | "left" | "right" | "none";

  type Props = Omit<HTMLButtonAttributes, "aria-pressed" | "children" | "class"> & {
    variant?: Variant;
    size?: Size;
    radius?: Radius;
    pressed?: boolean;
    class?: string;
    children?: Snippet;
  };

  let {
    variant = "default",
    size = "md",
    radius = "all",
    pressed,
    class: className = "",
    type = "button",
    children,
    ...rest
  }: Props = $props();

  const base =
    "inline-flex shrink-0 cursor-pointer items-center justify-center border font-medium outline-none transition-[background-color,border-color,color,opacity] duration-150 focus-visible:ring-2 focus-visible:ring-(--upaint-accent) focus-visible:ring-offset-1 focus-visible:ring-offset-(--upaint-bg) disabled:cursor-not-allowed disabled:opacity-50";
  const variants: Record<Variant, string> = {
    default:
      "border-(--upaint-border) bg-(--upaint-surface-raised) text-(--upaint-text) hover:border-(--upaint-accent)",
    primary:
      "border-(--upaint-accent) bg-(--upaint-accent) text-(--upaint-text) hover:bg-(--upaint-accent-muted)",
    danger:
      "border-(--upaint-border) bg-(--upaint-surface-raised) text-(--upaint-danger) hover:border-(--upaint-danger)",
    ghost:
      "border-transparent bg-transparent text-(--upaint-text) hover:bg-(--upaint-surface-raised)",
  };
  const sizes: Record<Size, string> = {
    sm: "px-2 py-1 text-[11px] leading-tight",
    md: "px-2.5 py-1.5 text-xs leading-tight",
    icon: "h-7 w-7 p-0 text-xs",
  };
  const active = "border-(--upaint-accent) bg-(--upaint-accent) text-(--upaint-text)";
  const radii: Record<Radius, string> = {
    all: "var(--upaint-radius-sm)",
    left: "var(--upaint-radius-sm) 0 0 var(--upaint-radius-sm)",
    right: "0 var(--upaint-radius-sm) var(--upaint-radius-sm) 0",
    none: "0",
  };

  const buttonClass = $derived(
    `${base} ${pressed ? active : variants[variant]} ${sizes[size]} ${className}`,
  );
</script>

<button
  {...rest}
  {type}
  class={buttonClass}
  style:border-radius={radii[radius]}
  aria-pressed={pressed}
>
  {@render children?.()}
</button>
