import { Color, FillGradient, Graphics, RenderTexture, Sprite } from "pixi.js";
import type { Application } from "pixi.js";

import type { BrushSettings } from "../state/paintToolStore.svelte";

export function createCoverageStamp(
  app: Application,
  settings: Readonly<BrushSettings>,
  color: string,
): { texture: RenderTexture; sprite: Sprite } {
  const padding = 2;
  const size = Math.ceil(settings.radius * 2) + padding * 2;
  const center = size / 2;
  const graphics = new Graphics();
  let gradient: FillGradient | null = null;

  if (settings.hardness >= 0.999) {
    graphics.circle(center, center, settings.radius).fill({
      color: new Color(color).toNumber(),
      alpha: 1,
    });
  } else {
    const rgb = new Color(color).toUint8RgbArray();
    const solid = `rgba(${rgb[0] ?? 0},${rgb[1] ?? 0},${rgb[2] ?? 0},1)`;
    const transparent = `rgba(${rgb[0] ?? 0},${rgb[1] ?? 0},${rgb[2] ?? 0},0)`;
    const colorStops = [{ offset: 0, color: solid }];
    if (settings.hardness > 0) colorStops.push({ offset: settings.hardness, color: solid });
    colorStops.push({ offset: 1, color: transparent });

    gradient = new FillGradient({
      type: "radial",
      center: { x: 0.5, y: 0.5 },
      innerRadius: 0,
      outerCenter: { x: 0.5, y: 0.5 },
      outerRadius: 0.5,
      colorStops,
      textureSpace: "local",
    });
    graphics.circle(center, center, settings.radius).fill(gradient);
  }

  const texture = RenderTexture.create({
    width: size,
    height: size,
    resolution: 1,
    antialias: true,
  });
  try {
    app.renderer.render({
      container: graphics,
      target: texture,
      clear: true,
      clearColor: [0, 0, 0, 0],
    });
  } catch (error) {
    texture.destroy(true);
    throw error;
  } finally {
    graphics.destroy();
    gradient?.destroy();
  }

  const sprite = new Sprite({ texture });
  sprite.anchor.set(0.5);
  return { texture, sprite };
}
