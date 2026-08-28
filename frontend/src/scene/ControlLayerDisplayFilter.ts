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

void main()
{
    vec4 source = texture(uTexture, vTextureCoord);
    float luminance = dot(source.rgb, vec3(0.2126, 0.7152, 0.0722));
    float alpha = source.a * mix(0.15, 1.0, luminance);
    finalColor = vec4(source.rgb * alpha, alpha);
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

@group(0) @binding(0) var<uniform> gfu: GlobalFilterUniforms;
@group(0) @binding(1) var uTexture: texture_2d<f32>;
@group(0) @binding(2) var uSampler: sampler;

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
fn mainFragment(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32>
{
    let source = textureSample(uTexture, uSampler, uv);
    let luminance = dot(source.rgb, vec3<f32>(0.2126, 0.7152, 0.0722));
    let alpha = source.a * mix(0.15, 1.0, luminance);
    return vec4<f32>(source.rgb * alpha, alpha);
}
`;

/** Display-only luminance-to-alpha treatment; it never writes into the source texture. */
export class ControlLayerDisplayFilter extends Filter {
  public constructor() {
    super({
      glProgram: GlProgram.from({
        name: "ultra-paint-control-layer-display",
        vertex,
        fragment,
      }),
      gpuProgram: GpuProgram.from({
        name: "ultra-paint-control-layer-display",
        vertex: { source: wgsl, entryPoint: "mainVertex" },
        fragment: { source: wgsl, entryPoint: "mainFragment" },
      }),
      resolution: "inherit",
      antialias: "off",
      padding: 0,
    });
  }
}
