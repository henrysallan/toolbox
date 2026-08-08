# Spline Interpolate node (spec, 2026-07-06)

Devlist origin: "a node that interpolates between splines — feed in 1+ splines
(auto-grow, always a spare empty socket), output a single spline containing the
inputs plus a slider-controlled number of interpolated in-between splines."

## What it is

A `spline` → `spline` utility. Wire N splines into auto-growing input sockets;
the node outputs **one** `SplineValue` whose subpaths are the input shapes plus
`count` interpolated in-between shapes, spread across the whole A→…→Z sequence.
Every output subpath is `groupIndex`-tagged in chain order (like the Combine
node) so Select by Index / Count Indices / Copy-to-Points can address the family.

Name: **Spline Interpolate** (type `spline-interpolate`). Sibling to the
existing **Spline Morph** (`spline-morph`), which is a *two-input, animated,
rasterizing* A→B tween; this node is a *multi-input, static, spline-out* family
generator. Both sit on the same engine.

## Engine reuse (the hard part already exists)

[engine/spline-morph.ts](../../src/engine/spline-morph.ts):

- `buildMorphCorrespondence(A, B, resolution)` — resamples both shapes to a
  matched anchor count, aligns orientation + cyclic start-vertex (closed) or
  travel direction (open), pairs subpaths biggest-to-biggest, collapses surplus
  subpaths to/from a centroid point. Returns a `MorphCorrespondence` that is
  **independent of the interpolation amount**.
- `applyMorph(corr, t)` — cheap per-anchor lerp; produces the in-between at `t`.

So an in-between at any `t` is one `applyMorph` call once the correspondence for
that segment is built.

## Distribution: "total across the chain"

`count` is the **total** number of in-betweens for the whole node (not per gap).
There are `segCount = N − 1` gaps between the N input shapes.

Allocation (even, no in-between ever lands on an input shape):

```
base  = floor(count / segCount)
extra = count % segCount            // first `extra` gaps get one more
gap k gets  inSeg = base + (k < extra ? 1 : 0)  in-betweens
in-between m of gap k is at localT = m / (inSeg + 1),  m = 1..inSeg
```

`localT ∈ (0,1)` strictly, so every in-between is strictly between its two knots
— no wasteful near-duplicate of an input shape (which a naive global
`g = j/(count+1)` placement produces whenever a sample lands on a knot).

Output order is chain order — for each gap: the gap's left input shape, then its
in-betweens; the final input shape closes the list. `groupIndex` = position in
that list.

Examples:
- N=2, count=3 → `A · i · i · i · B` (one gap, 3 in-betweens at 1/4, 2/4, 3/4).
- N=3, count=3 → `A · i · i · B · i · C` (gap0 gets 2, gap1 gets 1).
- count=0 → inputs only, tagged. N=1 → the single input, tagged group 0. N=0 → empty.

Degenerate `count < segCount` (fewer in-betweens than gaps) fills the first gaps
first — some gaps get none. Documented, acceptable.

## Node anatomy

- `type: "spline-interpolate"`, `name: "Spline Interpolate"`,
  `category: "spline"`, `subcategory: "modifier"`, `backend: "webgl2"`.
- `noMaskInput: true` — a pure spline utility; the universal image matte is
  meaningless here and would show a dead pink socket.
- **Inputs — auto-grow slots**, identical convention to Proximity Join/Merge: a
  `slots: string[]` param (default `["in"]`) whose value is derived from edges by
  the normalization `useEffect` in EffectsApp (kept equal to connected sockets +
  one trailing empty spare). `resolveInputs(params)` maps slots → `spline`
  sockets labelled "Spline 1…n". A fresh node shows one empty "Spline" socket.
- **Params**: `count` ("In-betweens", scalar 0–200, softMax 24, step 1,
  default 5); `resolution` (scalar 3–256, softMax 128, step 1, default 64 —
  anchors each shape is resampled to before interpolating, same as Spline Morph).
- **Output**: `primaryOutput: "spline"`, no aux. (A stroke/fill raster aux like
  Spline Morph is a trivial future add; v1 is spline-only per the request.)

### Caching

Per-segment correspondences are cached in `ctx.state["spline-interpolate:<id>"]`
keyed by input **object identity** + resolution (upstream hands new
`SplineValue` objects exactly when geometry changed — same trick as Spline
Morph). Rebuild only when a shape or `resolution` changes; sweeping `count` is
just re-sampling (cheap). Not `stable:false` — the evaluator's fingerprint cache
(params + input fingerprints) drives recompute. `dispose` clears the state key.

## Wiring changes

1. New file `src/nodes/effect/spline-interpolate.ts`.
2. Register in `src/nodes/index.ts` (import + `registerNode`), beside Spline Morph.
3. Extend the auto-grow `slots` normalization effect in EffectsApp to also match
   `defType === "spline-interpolate"` (currently hardcoded to `proximity-merge`).
   Its `t`/`mask` name exclusions are harmless here (this node has neither).

## Edge cases / notes

- One socket = one shape (all its subpaths morphed together — correspondence
  handles multi-subpath shapes). Feeding a Combine'd group into a single socket
  treats the whole group as one shape. A future "split a group's subpaths into
  separate interpolation stops" mode is possible but out of scope for v1.
- Inputs are emitted with their **true anchors** (faithful); only in-betweens
  are resampled to `resolution`. A tiny visual step between a faithful input and
  its adjacent resampled in-between is possible at low resolution — negligible at
  the default 64.
- Non-square canvas: interpolation is in normalized [0,1]² space (anisotropic),
  same as every other CPU spline op; no aspect handling needed at this layer.

## Milestones

1. Node file + registration + EffectsApp slots effect (this spec). Manual verify:
   two Spline Draw shapes → Spline Interpolate → Rasterize/stroke; scrub `count`;
   add a third shape via the spare socket; confirm even in-between distribution
   and that Select by Index picks individual family members.
2. (Optional, later) stroke/fill raster aux mirroring Spline Morph; groupIndex
   "split single group" input mode; easing/spacing control for non-linear `t`.
