import { Filter, GlProgram, GpuProgram } from "pixi.js";

const vertex = `
in vec2 aPosition;
out vec2 vTextureCoord;

uniform vec4 uInputSize;
uniform vec4 uOutputFrame;
uniform vec4 uOutputTexture;

vec4 filterVertexPosition()
{
    vec2 position = aPosition * uOutputFrame.zw + uOutputFrame.xy;
    position.x = position.x * (2.0 / uOutputTexture.x) - 1.0;
    position.y = position.y * (2.0 * uOutputTexture.z / uOutputTexture.y) - uOutputTexture.z;
    return vec4(position, 0.0, 1.0);
}

vec2 filterTextureCoord()
{
    return aPosition * (uOutputFrame.zw * uInputSize.zw);
}

void main()
{
    gl_Position = filterVertexPosition();
    vTextureCoord = filterTextureCoord();
}
`;

const fragment = `
in vec2 vTextureCoord;
out vec4 finalColor;

uniform sampler2D uTexture;
uniform vec4 uColor;
uniform float uSpacing;
uniform float uStripeWidth;

void main()
{
    vec4 source = texture(uTexture, vTextureCoord);
    float diagonal = mod(mod(gl_FragCoord.x - gl_FragCoord.y, uSpacing) + uSpacing, uSpacing);
    float stripe = 1.0 - step(uStripeWidth, diagonal);
    float alpha = source.a * mix(0.22, 0.78, stripe);
    finalColor = vec4(uColor.rgb * alpha, alpha);
}
`;

const wgsl = `
struct GlobalFilterUniforms {
    uInputSize: vec4<f32>,
    uInputPixel: vec4<f32>,
    uInputClamp: vec4<f32>,
    uOutputFrame: vec4<f32>,
    uGlobalFrame: vec4<f32>,
    uOutputTexture: vec4<f32>,
};

struct MaskHatchUniforms {
    uColor: vec4<f32>,
    uSpacing: f32,
    uStripeWidth: f32,
};

@group(0) @binding(0) var<uniform> gfu: GlobalFilterUniforms;
@group(0) @binding(1) var uTexture: texture_2d<f32>;
@group(0) @binding(2) var uSampler: sampler;
@group(1) @binding(0) var<uniform> maskHatchUniforms: MaskHatchUniforms;

struct VSOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) uv: vec2<f32>,
};

fn filterVertexPosition(aPosition: vec2<f32>) -> vec4<f32>
{
    var position = aPosition * gfu.uOutputFrame.zw + gfu.uOutputFrame.xy;
    position.x = position.x * (2.0 / gfu.uOutputTexture.x) - 1.0;
    position.y = position.y * (2.0 * gfu.uOutputTexture.z / gfu.uOutputTexture.y) - gfu.uOutputTexture.z;
    return vec4<f32>(position, 0.0, 1.0);
}

fn filterTextureCoord(aPosition: vec2<f32>) -> vec2<f32>
{
    return aPosition * (gfu.uOutputFrame.zw * gfu.uInputSize.zw);
}

@vertex
fn mainVertex(@location(0) aPosition: vec2<f32>) -> VSOutput
{
    return VSOutput(filterVertexPosition(aPosition), filterTextureCoord(aPosition));
}

@fragment
fn mainFragment(
    @location(0) uv: vec2<f32>,
    @builtin(position) position: vec4<f32>,
) -> @location(0) vec4<f32>
{
    let source = textureSample(uTexture, uSampler, uv);
    let spacing = maskHatchUniforms.uSpacing;
    let diagonal = ((position.x - position.y) % spacing + spacing) % spacing;
    let stripe = 1.0 - step(maskHatchUniforms.uStripeWidth, diagonal);
    let alpha = source.a * mix(0.22, 0.78, stripe);
    return vec4<f32>(maskHatchUniforms.uColor.rgb * alpha, alpha);
}
`;

/** Display-only quick-mask tint; it never writes into the source texture. */
export class MaskHatchFilter extends Filter {
  public constructor(color: string) {
    super({
      glProgram: GlProgram.from({
        name: "ultra-paint-mask-hatch",
        vertex,
        fragment,
      }),
      gpuProgram: GpuProgram.from({
        name: "ultra-paint-mask-hatch",
        vertex: { source: wgsl, entryPoint: "mainVertex" },
        fragment: { source: wgsl, entryPoint: "mainFragment" },
      }),
      resources: {
        maskHatchUniforms: {
          uColor: {
            value: colorToRgba(color),
            type: "vec4<f32>",
          },
          uSpacing: { value: 12, type: "f32" },
          uStripeWidth: { value: 5, type: "f32" },
        },
      },
      resolution: "inherit",
      antialias: "off",
      padding: 0,
    });
  }

  public setColor(color: string): void {
    this.resources.maskHatchUniforms.uniforms.uColor = colorToRgba(color);
  }
}

function colorToRgba(color: string): Float32Array {
  const value = Number.parseInt(color.slice(1), 16);
  return new Float32Array([
    ((value >> 16) & 0xff) / 255,
    ((value >> 8) & 0xff) / 255,
    (value & 0xff) / 255,
    1,
  ]);
}
