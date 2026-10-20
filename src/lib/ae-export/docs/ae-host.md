---
title: The Toolbox Shader plug-in and shader bundles
---

How a fused GLSL Expression runs inside After Effects. The AE user
installs one plug-in, **Toolbox Shader** (match name `TBX Shader`, in the
Effect ▸ AE Plugins menu); every shader region ships as a bundle it loads.
Source: `../AE_Plugins/toolbox-shader` (C++ / Metal, Mac only for now).

## The bundle (`shaders/<id>.tbxfx`)

- JSON of `AeShaderBundle` (`src/lib/ae-export/types.ts`): the fused GLSL
  (kept for traceability), its Metal translation (`source.msl`), the
  params with their pool slots, LUTs, the image inputs used, fps,
  loopFrames, the canvas it was proven on, and `hostMin`.
- `id` is a stable 24-bit hash of the bundle; it is the value of the
  effect's Bundle ID param.
- The plug-in loads `shaders/<id>.tbxfx` next to the saved `.aep` (or from
  `~/Library/Application Support/Toolbox Shader/bundles/`). After the
  project is saved once with the file present, the bundle lives inside the
  `.aep` and the file is no longer needed.
- A bundle whose `hostMin` is newer than the installed plug-in renders
  transparent with "Update Toolbox Shader (needs x.y.z)".

## Params

| Disk ID | Param |
|---|---|
| 1 | Bundle ID |
| 2 | Time Speed (multiplier, default 1; 0 makes Time Offset the whole clock) |
| 3 | Time Offset |
| 4 | Loop Frames |
| 10–13 | Layer A–D (image inputs `u_a`..`u_d`) |
| 20–51 | Sliders 1–32 (scalar channels) |
| 60–67 | Colors 1–8 (color channels, straight RGBA) |
| 70–77 | Points 1–8 (reserved) |
| 80–87 | Checkboxes 1–8 (toggle channels) |

- Scripts address params by match name, `TBX Shader-<4-digit disk ID>`,
  never by display name: the plug-in hides unused slots and renames used
  ones after the bundle's channels.
- Set **Bundle ID first** (changing it resets the other controls), then
  only the bundle's own controls (hidden ones refuse `setValue`).
- The project must be saved before Bundle ID is set, or the plug-in has no
  folder to find `shaders/` in (aerender can use `TBX_SHADER_BUNDLES`).

## Channel → param

- scalar → slider; toggle → checkbox; color → color.
- enum (`pick()`) → baked: the current option becomes a constant. Port only
  the selected branch.
- ramp / curve → a LUT texture (at most 8) sampled from the channel's
  current value. An **animated** ramp can't be a LUT: that region bakes.
- More than 32 scalars, 8 colors or 8 LUTs is refused.

## Translation (fused GLSL → Metal)

Done by `glslToMsl` (`src/lib/ae-export/shader/`) and checked by
`validate_ae_shader` before anything reaches AE. It refuses, with the GLSL
line:

- `dFdx` / `dFdy` / `fwidth`;
- preprocessor use other than `#version 300 es` and constant `#define`s;
- `texture()` with a bias, `texelFetch` / `textureSize` with a LOD other
  than literal 0, textureProj / Offset / Grad, pack / unpack;
- a swizzle or vector component passed as an `out` argument;
- `discard` inside helpers (in `main()` it returns transparent);
- uniform arrays, non-2D samplers, local structs, `gl_*` other than
  `gl_FragCoord`;
- `==` on matrices, structs or arrays.

Rewrite around a refusal in the GLSL node itself, re-run `get_shader_errors`
and `compare_renders`, then validate again.

## Conventions inside the plug-in

- `v_uv` is Y-up over the layer; `u_res` is the output size at the current
  downsample; `u_aspect = W / H`; `u_frame = u_time × fps`.
- Inputs arrive straight (unpremultiplied); the shader returns straight
  RGBA; nothing is premultiplied on either side.
- Out-of-range `texelFetch` clamps to the edge (WebGL2 returns 0).
- LUTs are float in the plug-in and RGBA16F in toolbox: up to ~5e-4 apart.
- Bundles compile with Metal's **fast math**, as toolbox's WebGL does
  (ANGLE on Metal), so hash noise like `fract(sin(x)·43758.5…)` matches;
  the plug-in keeps a NaN / infinity guard fast math can't remove.
- 8, 16 and 32 bpc all work; 32 bpc keeps over-range values.
- A shader that fails to compile renders transparent and the effect's
  status line shows "Compile error: msl <line>:<col>: …".

## Tools on the plug-in's side

- `tbxshader-check file.tbxfx [--json]` compiles a bundle exactly as the
  plug-in will (exit 0 = compiles).
- `tbxshader-render file.tbxfx --size WxH --time t [--a in.png] [--set slider3=0.5] -o out.png`
  renders a bundle offline — the reference for parity checks.
