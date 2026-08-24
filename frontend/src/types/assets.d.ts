/**
 * Ambient declarations for non-TypeScript imports.
 *
 * `build.mjs` registers esbuild's `text` loader for `.css`, so importing a
 * stylesheet yields its contents as a string, which the importing module
 * injects into a <style> tag at runtime. That keeps the bundle a single
 * self-contained file -- Gradio serves it as one flat `file=` URL with no
 * sibling assets and no import map.
 */
declare module "*.css" {
    const contents: string;
    export default contents;
}
