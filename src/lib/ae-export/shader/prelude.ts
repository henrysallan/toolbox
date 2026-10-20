// The validator's copy of the host-owned halves of a Toolbox Shader source
// (ABI.md): prelude (TbxUniforms + TbxImage) before `bundle.source.msl`, and
// an epilogue kernel after it. check-shader-abi.mts keeps TbxUniforms, the
// TbxImage member signatures and the TbxProgram constructor in sync with
// ABI.md. The host's real TbxImage may be built differently ("Toolbox code
// never depends on how TbxImage is built"); this one is a texture plus a
// bilinear clamp-to-edge sampler, enough to compile and to probe.
//
// Texture memory row 0 is uv.y = 0 here (the GL convention), so a probe and
// a WebGL render of the same texel data agree with no flip. The host flips
// AE's top-down rows itself.

export const TBX_MSL_PRELUDE = `#include <metal_stdlib>
using namespace metal;

struct TbxUniforms {
  float2 res;          // u_res: output size in pixels at the current downsample
  float  time;         // u_time: comp seconds + Time Offset
  float  frame;        // u_frame: time × bundle.fps
  float  aspect;       // u_aspect: res.x / res.y
  float  sliders[32];  // pool slot n → sliders[n-1]
  float4 colors[8];    // straight RGBA, 0–1 (unclamped at 32 bpc)
  float2 points[8];    // reserved; v1 bundles use none
  int    checkboxes[8];// 0 or 1
};

// Validator stand-in for the host's TbxImage (same three members).
struct TbxImage {
  texture2d<float> tex;
  float4 sample(float2 uv) const {
    constexpr sampler s(filter::linear, address::clamp_to_edge, coord::normalized);
    return tex.sample(s, uv);
  }
  float4 fetch(int2 p) const { return tex.read(uint2(p)); }
  int2   size() const { return int2(int(tex.get_width()), int(tex.get_height())); }
};
`;

const IMAGES = "a, b, c, d, l0, l1, l2, l3, l4, l5, l6, l7".split(", ");
const textureParams = IMAGES.map((n, i) => `texture2d<float> ${n} [[texture(${i})]]`).join(",\n    ");
const programArgs = `U, ${IMAGES.map((n) => `TbxImage{${n}}`).join(", ")}`;

// tbx_render mirrors ABI.md's host epilogue (Y-up v_uv from the grid,
// premultiplied write); tbx_probe evaluates shade() at listed uvs for the
// parity gate (scripts/ae-export/msl-compile.m's `probe` mode binds it).
export const TBX_MSL_EPILOGUE = `
kernel void tbx_render(
    constant TbxUniforms& U [[buffer(0)]],
    ${textureParams},
    texture2d<float, access::write> out [[texture(12)]],
    uint2 gid [[thread_position_in_grid]]) {
  if (gid.x >= out.get_width() || gid.y >= out.get_height()) return;
  float2 v_uv = float2((float(gid.x) + 0.5f) / U.res.x, 1.0f - (float(gid.y) + 0.5f) / U.res.y);
  TbxProgram p(${programArgs});
  float4 straight = p.shade(v_uv);
  out.write(float4(straight.rgb * straight.a, straight.a), gid);
}

kernel void tbx_probe(
    constant TbxUniforms& U [[buffer(0)]],
    device const float2* uvs [[buffer(1)]],
    device float4* result [[buffer(2)]],
    constant uint& count [[buffer(3)]],
    ${textureParams},
    uint gid [[thread_position_in_grid]]) {
  if (gid >= count) return;
  TbxProgram p(${programArgs});
  result[gid] = p.shade(uvs[gid]);
}
`;

// prelude + bundle source + epilogue, and where the bundle part starts.
export function fullMslSource(bundleMsl: string): { source: string; firstBundleLine: number } {
  const firstBundleLine = TBX_MSL_PRELUDE.split("\n").length;
  return { source: TBX_MSL_PRELUDE + bundleMsl + TBX_MSL_EPILOGUE, firstBundleLine };
}
