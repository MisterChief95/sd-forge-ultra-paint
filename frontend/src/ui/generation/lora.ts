import type { LoraCatalogItem } from "./generationApi";

export interface SelectedLora extends LoraCatalogItem {
  enabled: boolean;
  weight: number;
}

export function clampLoraWeight(value: number): number {
  const clamped = Math.max(-10, Math.min(10, value));
  return Object.is(clamped, -0) ? 0 : clamped;
}

export function buildLoraPrompt(prompt: string, loras: SelectedLora[]): string {
  const tags = loras
    .filter((lora) => lora.enabled)
    .map((lora) => `<lora:${lora.promptName}:${clampLoraWeight(lora.weight)}>`)
    .join(" ");
  return tags ? `${prompt}${prompt ? "\n" : ""}${tags}` : prompt;
}
