# Toolbox Shader MSL ABI, v1

This is the contract between the toolbox side, which translates the fused GLSL in
`src/lib/ae-export/shader/`, and the C++/Metal host in `../AE_Plugins/toolbox-shader`.
The bundle format is `AeShaderBundle` in `src/lib/ae-export/types.ts`. A `.tbxfx` file is
that object as JSON.

The host compiles **one MSL source per bundle at runtime** (`newLibraryWithSource`). That
source is three parts concatenated:

```
[host prelude]   host-owned: #include, TbxUniforms, TbxImage
[bundle.source.msl]  toolbox-owned: struct TbxProgram (plus optional tbx_* helpers)
[host epilogue]  host-owned: the kernel that builds a TbxProgram and calls shade()
```

Change any part of this contract and you must bump the ABI version and `hostMin`.

## Host prelude (the host provides it)

```metal
#include <metal_stdlib>
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

// Host-implemented. Toolbox code calls only these three members.
struct TbxImage {
  float4 sample(float2 uv) const; // uv 0–1, Y-UP (0,0 = bottom-left), bilinear,
                                  // clamp-to-edge, returns STRAIGHT (unpremultiplied) RGBA
  float4 fetch(int2 p) const;     // texel at integer coords, Y-up, straight RGBA
  int2   size() const;            // texture size in pixels
};
```

If MSL refuses textures as struct members in this context, the host lane
proposes a replacement for `TbxImage` that keeps the same three members. Toolbox
code never depends on how `TbxImage` is built.

## Bundle source (the toolbox side emits it)

```metal
// optional program-scope helpers, all prefixed tbx_ (e.g. tbx_mod for GLSL mod)
// baked enum constants as `constant int <name> = <value>;` plus the
// `<name>_<option>` constants the GLSL node declares

struct TbxProgram {
  float2 u_res; float u_time; float u_frame; float u_aspect;
  TbxImage u_a, u_b, u_c, u_d;
  TbxImage u_ramp_<name>, u_curve_<name>;   // one member per bundle.luts entry, in order
  float <scalar>; bool <toggle>; float4 <color>;  // one member per channel

  TbxProgram(constant TbxUniforms& U,
             TbxImage a, TbxImage b, TbxImage c, TbxImage d,
             TbxImage l0, TbxImage l1, TbxImage l2, TbxImage l3,
             TbxImage l4, TbxImage l5, TbxImage l6, TbxImage l7)
    : u_res(U.res), u_time(U.time), u_frame(U.frame), u_aspect(U.aspect),
      u_a(a), u_b(b), u_c(c), u_d(d) /*, u_ramp_x(l0), ... */
  { /* <scalar> = U.sliders[slot-1]; <toggle> = U.checkboxes[slot-1] != 0; <color> = U.colors[slot-1]; */ }

  // translated helper functions become member functions, so they can still
  // read the uniforms the way the GLSL helpers did

  float4 shade(float2 v_uv);  // the translated main(); returns fragColor, STRAIGHT RGBA
};
```

- **LUT slots.** Up to 8 LUT textures. `bundle.luts[i]` binds to `l<i>`. Each is a
  `width × 1` RGBA float texture. Unused `l` arguments are a 1×1 transparent texture.
- **Images.** Unused image inputs (`bundle.inputs` omits them) are a 1×1 transparent
  texture.
- **Names.** Channel member names are the GLSL uniform names, unchanged. A GLSL
  identifier that is an MSL/C++ keyword (`half`, `kernel`, `device`, `constant`, `thread`,
  `namespace`, `template`, `class`, ...) is renamed `<name>_` consistently.

## Host epilogue (the host provides it)

The host epilogue is a compute (or fragment) entry point that:
- computes `v_uv = (float2(gid) + 0.5) / res` with Y flipped to Y-up;
- constructs `TbxProgram p(U, a, b, c, d, l0..l7)`;
- calls `p.shade(v_uv)`, converts to AE's channel order and writes it **straight**.
  AE hands effects straight-alpha pixels and expects straight ones back (the
  host lane measured this in AE 26.5, 2026-10-20), so nothing is premultiplied
  on either side. This corrects v1's first draft and changes no toolbox-side code.

The entry point's name and bindings belong to the host. Toolbox never emits a kernel.

## GLSL → MSL semantics the translator must preserve

| GLSL | MSL |
|---|---|
| `vecN` / `ivecN` / `uvecN` / `bvecN` / `matN` | `floatN` / `intN` / `uintN` / `boolN` / `floatNxN` (both column-major) |
| `texture(u_x, uv)` | `u_x.sample(uv)` |
| `texelFetch(u_x, p, 0)` | `u_x.fetch(p)` |
| `textureSize(u_x, 0)` | `u_x.size()` |
| `mod(x, y)` (floor semantics) | `tbx_mod(x, y)` = `x - y * floor(x / y)` (not `fmod`) |
| `atan(y, x)` | `atan2(y, x)` |
| `inversesqrt` | `rsqrt` |
| `dFdx` / `dFdy` / `fwidth` | `dfdx` / `dfdy` / `fwidth` (compute: not available. Refuse with a clear error) |
| `out` / `inout` params | `thread T&` |
| `const` globals | `constant` |
| array constructors `float[3](a,b,c)` | brace init `{a, b, c}` |
| precision qualifiers | dropped |
| `in vec2 v_uv` / `out vec4 fragColor` | the `shade(float2 v_uv)` parameter / a local returned at the end and at every `return` |
| vector relational `lessThan` etc. | component-wise `<` (bool vectors) |

Recursion and dynamic indexing of uniform arrays aren't allowed in GLSL ES 3.00 fused
shaders, so the translator need not support them. `#define` with a constant value may
be inlined. Any other preprocessor use is refused with the offending line.
