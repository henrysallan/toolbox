# Along Path node — spec (2026-07-05)

Devlist #407. A general-purpose node that lays an **object** (spline / points /
image) **along a path** (spline) — replacing the current two-node dance
(Sample Along Path / Points on Path → Copy to Points) and adding a genuinely
new capability: **true geometry bending** (warp) to the path's curvature.

## Motivation & what already exists

- `sample-along-path` gives one `{pos, tangent, angle}` at arc-length `t`; you
  still have to Copy-to-Points to actually place an object there.
- `points-on-path` emits N arc-length-even points with `rotation` baked from
  the tangent; feeding Copy-to-Points already gives **rigid rotate-to-tangent**
  placement. So "align rotation" is mostly a bundling win.
- **Text-on-path does NOT warp geometry** — it rigidly stamps each glyph
  (`translate`+`rotate`+perpendicular offset, `text-raster.ts:461-563`). No node
  today bends vector geometry or a raster to follow a curve. That is the new
  value-add here.

## Design decisions (from design Q&A)

- **Placement: one node, `count` param.** `count = 1` lays a single object;
  `count = N` repeats copies distributed along the path.
- **Inputs: vector AND images.** Polymorphic instance socket like Copy-to-Points
  (`spline | points | image`), output type follows input.
- **Warp = TRUE geometry bend**, not just rotation (vertices remapped
  x→arc-length, y→normal). Separate from the rigid **align-rotation** toggle.

## Node definition

```
type:         "along-path"
name:         "Along Path"
category:     "spline"   subcategory: "modifier"   backend: "webgl2"
primaryOutput: follows the instance type (resolvePrimaryOutput):
                 spline→spline, points→points, image→image
```

### Inputs (polymorphic, mirrors Copy-to-Points)

- `path`   — `spline`, required. The curve to lay along.
- `object` — retyped by `mode` via `resolveInputs`/`connectedTypes`:
  `spline | points | image` (upgrades to `image_group` if that's what's wired).
- `t_field` / `scale_field` (later) — optional modulation images. Out of scope v1.

### Params

| param            | type    | default | notes |
|------------------|---------|---------|-------|
| `mode`           | enum    | image   | `image \| spline \| point` — mirrors Copy-to-Points; drives socket + output type. Set by onConnect promotion. |
| `count`          | scalar  | 1       | 1..256. 1 = single object; N = repeated copies. |
| `fit`            | enum    | span    | `span` = copies tile the whole path (each copy's X-extent → its 1/N arc); `natural` = each copy keeps its natural px width, distributed evenly by `count`. |
| `warp`           | boolean | true    | TRUE bend: remap the object's geometry so local-X → arc-length, local-Y → path normal. Off = rigid stamp. |
| `align_rotation` | boolean | true    | When `warp` is off: rotate each copy to the tangent at its placement point. (When `warp` is on, orientation is implied by the bend, so this is ignored.) |
| `offset`         | scalar  | 0       | Slide the whole layout along the path, 0..1 of total length (wraps on closed paths). |
| `wrap`           | enum    | clamp   | `clamp \| loop \| ping-pong` for `offset` past ends (reuse `sample-along-path`'s `wrapParam`). |
| `spacing`        | scalar  | 0       | `natural` mode only: extra gap between copies (fraction of copy width). |
| `normal_offset`  | scalar  | 0       | Shift the layout perpendicular to the path (px as fraction of canvas height), `side`-style. |
| `thickness`      | scalar  | 1       | Scales the object's cross-path (Y) extent; keeps natural thickness at 1 even when X is stretched to span a long path. |
| `flip`           | boolean | false   | Read the path from the far end / flip the normal side (matches Text's `path_flip`). |

`t`/`offset` and `count` are the usual exposable scalars.

## The warp math (shared vector + raster model)

All in **pixel space** for aspect correctness — the same reason Text bends in px
(`text-raster.ts:396-403`): the object's px extents must map to px arc length on
a non-square canvas. Convert normalized→px with `ctx.width/ctx.height` on the way
in, px→normalized on the way out.

1. **Object bounds** in normalized space → `[minX,maxX]×[minY,maxY]`, center
   `cY = (minY+maxY)/2`. (New shared helper `objectBounds` for spline/points;
   images use their alpha bbox or full canvas.)
2. **Path table**: reuse Text's `buildPathSampler(path, W, H, N)` →
   `{ totalPx, at(s) → {x,y,angle} }` (an even px-arc-length polyline of the
   bezier; `text-raster.ts:409-451`). Promote it from `text-raster.ts` into a
   shared engine helper (e.g. `spline-arc.ts`) so this node and Text share it.
3. **Copy windows**: for copy `k` of `count`, compute its arc-length window
   `[s0_k, s1_k]` in px:
   - `span`: `L = totalPx`; window length `= L/count`; `s0_k = k*L/count + offset*L`.
   - `natural`: window length `= objectWidthPx`; centers spaced by
     `objectWidthPx*(1+spacing)`, whole run centered/aligned then slid by `offset*L`.
   Windows honor `wrap` (loop/ping-pong) and `flip` (read `s` from `totalPx - s`).
4. **Per-vertex bend** (warp on): for object vertex `(x,y)`:
   - `u = (x-minX)/(maxX-minX)`; `s = s0_k + u*(s1_k - s0_k)`.
   - `{px,py,angle} = sampler.at(s)`; normal `n = (-sin angle, cos angle)`.
   - `offY = (y - cY) * H * thickness`  (natural px thickness, not stretched with X).
   - warped px `= (px,py) + n*offY`;  back to normalized `/(W,H)`.
5. **Rigid place** (warp off): place the object's anchor (content-center) at
   `sampler.at(center_k)`, rotate by `angle` if `align_rotation`, at natural size.
   This is exactly Copy-to-Points' per-point transform with rotation = tangent.

## Per-type implementation

### Spline (exact, cheap — Milestone 1)

Bending straight bezier segments won't follow the curve, so **densely resample
first**: for each subpath, `resampleSubpath(sub, K)` (`spline-math.ts:165`) to K
points (K scales with `count`, path length, and a quality constant), remap each
sample by the bend, then re-fit auto-smooth handles (same 1/3-spacing rule
`resampleSubpath` already uses). Closed subpaths stay closed. Multi-subpath
objects bend each subpath through the SAME window (so a whole glyph/logo bends
together). Output: `spline`.

### Points (exact, cheap — Milestone 1)

Remap each point's `pos` by the bend (warp on) or by rigid placement (warp off).
`align_rotation` (warp off) sets each point's `rotation = angle (+offset)`; warp
on leaves rotation as the bend implies (points are, well, points — position is
the whole story, but we still set rotation to the local tangent so a downstream
Copy-to-Points orients instances). Output: `points`. For `count>1`, the point
set is duplicated per copy into each window.

### Image (per-pixel inverse warp — Milestone 2)

No mesh drawing (GL is fullscreen-only, `gl.ts:384`), so bend a raster with an
**inverse map in a fullscreen shader**:

- Upload the path polyline as an `N×1` RGBA32F **data texture**: `xy = pos px`,
  `z = cumulative arc-length px`, `w` spare. (Built CPU-side from the sampler.)
- Fragment shader, per output pixel `P` (px):
  1. Loop the `N-1` segments, find the closest point on the polyline to `P` →
     min distance `d`, its arc-length `s`, and the signed side of the normal.
  2. Determine which copy window `s` falls in → `u` (local param) and whether a
     copy exists there (`natural` mode has gaps → else transparent).
  3. `v = cV + (signed d)/(H*thickness)`; sample the object texture at `(u,v)`;
     transparent if `u∉[0,1]` or `v∉[0,1]`.
- Cost: ~N iterations/pixel (N≈128–256). Heavy but it caches unless
  path/object/params change (normal fingerprinting). Warp off = the cheap rigid
  Copy-to-Points GPU instancing path (reuse its data-texture instancing).
- `image_group`: each item cycles per copy (like Copy-to-Points' `pick`), v2.

## Milestones

- **M1 — Vector core.** `along-path` node, polymorphic spline/points, `count`,
  `fit`, `warp` (true bend), `align_rotation`, `offset`/`wrap`, `normal_offset`,
  `thickness`, `flip`. New `engine/spline-arc.ts` (promote `buildPathSampler` +
  `objectBounds` + the bend remap). Register + onConnect mode promotion (mirror
  Copy-to-Points). Docs entry. **Testable end-to-end with shapes.**
- **M2 — Images.** Image mode: rigid place/align via Copy-to-Points' GPU
  instancing, plus the inverse-map warp shader + path data-texture. Alpha-bbox
  content-center. `image_group` cycling.
- **M3 — Polish.** Optional aux outputs (the generated `points`/`positions` for
  chaining), a `flow axis` param (X vs Y along path), field modulation
  (`scale_field`), and an on-canvas gizmo if warranted.

## Invariants / integration notes

- **Engine self-containment** (#1): the sampler + bend live in `src/engine`
  (`spline-arc.ts`), not the node file. Promoting `buildPathSampler` out of
  `text-raster.ts` keeps Text working (import from the new module).
- **Coordinate/alpha** (#4): bend in px, flip Y at the raster boundary, straight
  alpha. Normalized geometry is anisotropic — the px-space bend is the aspect fix.
- **Coercions/validation** (#7): the polymorphic `object` socket needs the same
  `isValidConnection` + `canCoerce` entries Copy-to-Points' `instance` has
  (NodeEditor ×2 places) so spline/points/image all wire in and mode-promote.
- **Back-compat** (#2): new `type` string, no migration.
- Caching: warp reads only params + inputs (no time) ⇒ `stable` default; it
  caches like Copy-to-Points. Fingerprint covers count/fit/warp/offset so a
  static chain is a constant.
