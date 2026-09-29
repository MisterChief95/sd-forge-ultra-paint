import type { ExtractOptions, Renderer } from "pixi.js";

/**
 * `renderer.extract.canvas()` for render textures returns PREMULTIPLIED RGBA
 * (Pixi's readback never un-premultiplies), but a canvas holds straight alpha.
 * Encoding that canvas to PNG bakes premultiplied colour into the file, and the
 * premultiply-on-upload decode then darkens every soft edge a second time
 * (dark fringes after an autosave restore / project open). Every extraction
 * that ends up encoded or composited on a 2D canvas goes through here instead.
 */
export function extractStraightCanvas(
  renderer: Renderer,
  options: ExtractOptions,
): HTMLCanvasElement {
  const { pixels, width, height } = renderer.extract.pixels(options);
  const straight = new Uint8ClampedArray(pixels);
  for (let i = 0; i < straight.length; i += 4) {
    const alpha = straight[i + 3]!;
    if (alpha === 0 || alpha === 255) continue;
    const scale = 255 / alpha;
    straight[i] = straight[i]! * scale + 0.5;
    straight[i + 1] = straight[i + 1]! * scale + 0.5;
    straight[i + 2] = straight[i + 2]! * scale + 0.5;
  }
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  canvas.getContext("2d")!.putImageData(new ImageData(straight, width, height), 0, 0);
  return canvas;
}
