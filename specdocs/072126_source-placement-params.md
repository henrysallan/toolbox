# Placement params on raster sources (shipped 07/21/26)

Image Source, Video Source (both paths), and Webcam get three params —
**Offset X / Offset Y / Zoom** — that pan/zoom the source within the
canvas *at sampling time*, against the full-resolution source texture.

## Why

The sources keep the whole bitmap on the GPU, but the primary output
rasterizes it into a canvas-sized target through the fit shader — with
the default `fit: cover`, the aspect-overflow was cropped at that step
and unreachable downstream (Transform samples the already-cropped
canvas raster; `contain` + Transform-upscale resamples canvas-res
pixels and goes soft). Placement params move the crop *window* instead:
zoom out / offset to reveal the cover-cropped pixels at full fidelity.

## The one rule

Placement runs on the resolved UV (after any `uv_in` warp, which is
also output-space) **before** the aspect-fit mapping:

```glsl
uv = 0.5 + (uv - vec2(u_offset.x, -u_offset.y) - 0.5) / u_zoom;
vec2 s = 0.5 + (uv - 0.5) * u_invScale;
```

Conventions match the Transform node: offsets are canvas fractions,
**+Y moves the image down** (screen convention, hence the y-flip),
zoom > 1 zooms in about the canvas center, offset is zoom-independent
(offsetX 0.25 always moves the image a quarter-canvas right). Ranges
match Transform too: offsets −1…1, zoom 0.01…10 (softMax 4), all
keyframable like any scalar param.

## Edge behavior (unchanged per fit mode)

- `cover`: sampling past the bitmap edge clamps (CLAMP_TO_EDGE smear) —
  same as `uv_in` warps always did. To place a too-big image *inside*
  the canvas with clean surround, use `contain`, which letterboxes
  opaque black outside the image, placement included.
- The letterbox check runs on the final `s`, so it stays correct under
  any offset/zoom.

## Scope

- Primary output only. The `element` aux (Auto Layout) still carries
  the untouched bitmap at natural size — layout slots do their own fit.
- EXR stills ride the same Image Source draw, so placement applies.
- Defaults (0, 0, 1) are a no-op: existing projects render identically;
  missing params deserialize to defaults, no schema bump.

Files: `src/nodes/source/image-source.ts` (FIT_FS + params + uniforms),
`src/nodes/source/video.ts` (shared FS, sequence + video draw sites),
`src/nodes/source/webcam.ts` (FS + params + uniforms).
