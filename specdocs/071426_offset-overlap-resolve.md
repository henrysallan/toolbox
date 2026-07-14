# Offset overlap resolve — Sharp / Smooth (devlist: repeat/offset corner overlap)

Snapshot 2026-07-14. When a path with sharp corners is offset (Repeat Path
rings, Offset Path, Stroke Repeats), the offset copies overlap themselves on
the concave side of each corner — and, at larger distances, wherever two
distant parts of the path collide. This spec adds an **Overlap** mode to all
three surfaces: **Keep** (today's raw behavior, default), **Sharp** (cut the
loop, resolve to a single intersection point), **Smooth** (sharp cut, then a
fillet at the cut so the transition is a curve).

## Problem (why offsets overlap today)

All three surfaces bottom out in `offsetSubpath`
([spline-math.ts:246](../src/engine/spline-math.ts)):

- Each cubic segment is offset **independently** via bezier-js `.offset(d)`
  (which subdivides around high curvature and returns a cubic chain).
- The chains are stitched back into one subpath by carrying handles across
  the joins — no intersection handling at all.

At a sharp corner the two neighboring segment-offsets don't meet. On the
convex side there's a gap (the stitch bridges it — visually acceptable). On
the **concave side they cross**, leaving a local self-intersection loop: the
little "bowtie" wedge the devlist entry describes. Large offsets add
**global** self-intersections where a narrow concave feature collapses.

Call sites that inherit the artifact:

- **Offset Path** ([offset-path.ts](../src/nodes/effect/offset-path.ts)) —
  `offsetSubpath` directly, in normalized space.
- **Repeat Path** ([repeat-path.ts](../src/nodes/effect/repeat-path.ts)) →
  `buildRepeatStrokes` ([spline-repeat.ts](../src/engine/spline-repeat.ts)),
  which offsets in canvas-pixel space per ring.
- **Stroke's Repeats section** ([stroke.ts](../src/nodes/effect/stroke.ts))
  → the same `buildRepeatStrokes`.

## Decision (design Q&A, 2026-07-14)

1. **Control shape: single 3-way enum.** One segmented row per node —
   `Overlap: Keep / Sharp / Smooth` — default **keep** so every existing
   save renders byte-identically. No schema bump, no migration (new params
   with defaults).
2. **Smooth = sharp cut + fillet.** Run the sharp resolve, then round *only
   the cut junction anchors* with the existing fillet math
   (`roundSubpath` in spline-math). Radius scales with the offset distance
   via a `Smoothing` knob (`visibleIf` overlap = smooth). Local, cheap,
   resolution-independent; the rest of the path is byte-identical to sharp.
   (Rejected: whole-path resample + Schneider refit — wobbles faithful
   geometry; field/flow iso-line à la Spline Merge Flow — polygonal,
   canvas-resolution-bound, closed-fill-only.)
3. **Loop-cull only — a ring stays one subpath.** Cubic-exact
   self-intersection culling; **no** polygon-clipping island split when a
   closed inner offset collapses past a neck. A ring whose chain is
   *entirely* covered by loop intervals has fully inverted and is dropped
   (offset past collapse vanishes — see algorithm step 5).
4. **Scope: all three surfaces.** Offset Path, Repeat Path, and Stroke's
   Repeats group — they share the engine, so the third is nearly free.

## Engine: `src/engine/spline-offset-resolve.ts` (new)

Engine-side module (invariant #1 — exported apps carry it). Space-agnostic:
it operates in whatever space the caller's subpath lives in; callers run it
in **canvas-pixel space** so intersection tolerances and fillet radii are
isotropic on non-square canvases (Repeat/Stroke already offset in px;
Offset Path scales to px for the resolve step — see integration).

```ts
export type OverlapStyle = "keep" | "sharp" | "smooth";

export function resolveSubpathOverlaps(
  sub: SplineSubpath,
  opts: { style: OverlapStyle; filletRadius?: number } // radius in sub's space
): SplineSubpath | null; // null = fully-inverted ring, drop it
```

`style: "keep"` returns `sub` untouched (callers can pass through
unconditionally). Non-geometry fields (`groupIndex` etc.) are re-carried by
the caller exactly as `offsetSubpathsPx` does today.

### Algorithm (cubic-exact loop cull)

1. `subpathToBeziers(sub)` → segment chain. Chain coordinate = `(segIndex,
   t)`, ordered lexicographically.
2. **Find self-intersections.**
   - Per-segment: bezier-js's no-arg `curve.intersects()` (self-intersection
     form; a lone cubic crosses itself at most once). Verify the API shape at
     implementation — fall back to split-in-half + pairwise if it drifts.
   - Pairwise `a.intersects(b)` for i < j, pruned by a bbox-overlap pre-test.
     Results are `"t1/t2"` strings → parse to chain coords.
   - **Exclude shared endpoints**: adjacent pairs (and the closing pair on a
     closed chain) always "intersect" at the join — drop hits with
     `t1 > 1−ε` on the earlier curve and `t2 < ε` on the later one.
   - Dedupe near-identical hits (Δchain-position < ε AND point distance
     < εpx) — tangential grazes and float noise produce clusters.
3. **Cull loops (open chain).** Each intersection is an interval
   `[s1, s2]` in chain coordinates. Walk from the chain start: at the first
   interval start not yet consumed, emit geometry up to `s1`, **jump to
   `s2`** (the loop between is dropped), splice the intersection point in as
   a corner anchor, continue. Intervals nested inside a dropped run die with
   it; partially-overlapping intervals are handled by **iterating the whole
   pass** (re-scan, re-cull) until no intersections remain, capped at 4
   rounds (corner bowties converge in 1; the cap is a runaway guard —
   if it's hit, return the last iterate).
4. **Closed chains: rotate to a safe seam.** Find any chain position not
   covered by a loop interval, split the segment there, rotate the chain to
   start at it, run the open-chain cull, re-close. (Corner loops never cover
   the whole ring, but they can straddle the original start anchor — the
   rotation makes the linear walk sound.)
5. **Fully-covered closed chain** (no uncovered position exists) = the ring
   has completely inverted (inner offset past total collapse) → return
   `null`; callers drop the ring, matching how degenerate offsets are
   dropped today.
6. **Rebuild.** Keep segments outside dropped runs verbatim. At each cut,
   `curveA.split(tA).left` and `curveB.split(tB).right` provide the exact
   trimmed cubics; the junction anchor's `inHandle`/`outHandle` come from
   their CP2/CP1 (same anchor-rebuild pattern as `offsetSubpath`). The
   junction is a **corner anchor** — that IS sharp mode.
7. **Smooth.** Fillet only the junction anchors from step 6 with
   `filletRadius`, clamped per-corner to half the adjacent segment lengths
   (same clamp as `roundSubpath`). Implementation: extract the per-corner
   fillet from `roundSubpath` into a helper (or give `roundCorners` an
   `onlyIndices?: Set<number>` option) — do NOT round pre-existing corners.

Numeric hygiene: ε on t is ~1e-4; point-distance ε is ~0.25px (callers are
in px space). Perf is O(n²) pairwise with bbox pruning over the post-offset
cubic count (typically well under a couple hundred segments) — fine per ring
per eval, and static graphs pay once via node fingerprint caching. If a
pathological path bites, the escape hatch is a sweep-line over bboxes, not a
new algorithm.

## Integration

**`buildRepeatStrokes`** ([spline-repeat.ts](../src/engine/spline-repeat.ts)):
`RepeatStrokeOpts` gains `overlap?: { style: OverlapStyle; smoothing:
number }`. Inside `offsetSubpathsPx` (already px space), after
`offsetSubpath`: `resolveSubpathOverlaps(off, { style, filletRadius:
smoothing × |distancePx| })`; `null` drops the ring's subpath. The identity
ring (distance 0) is never resolved — it keeps value identity (the existing
`emit(t, 0)` short-circuit is untouched).

**Offset Path** ([offset-path.ts](../src/nodes/effect/offset-path.ts)):
- New params: `overlap` (enum `keep|sharp|smooth`, default `keep`,
  `control: "segmented"`) and `smoothing` (scalar 0–1, default 0.5,
  `visibleIf: p => p.overlap === "smooth"`).
- Compute: when style ≠ keep, scale each offset subpath to px (`ctx.width/
  height` — compute already receives `ctx`), resolve with `filletRadius =
  smoothing × |distance| × ctx.width`, scale back. (The offset itself stays
  in normalized space — its existing anisotropy on non-square canvases is
  out of scope; only the *resolve* is px-isotropic.)

**Repeat Path** ([repeat-path.ts](../src/nodes/effect/repeat-path.ts)): same
two params, passed through as `opts.overlap`. Ring `groupIndex` tagging is
unchanged (resolve happens per subpath inside the ring build).

**Stroke** ([stroke.ts](../src/nodes/effect/stroke.ts)): `repeat_overlap` +
`repeat_smoothing` params in the Repeats collapsible group (same
`visibleIf: repeatsVisible` gating as its siblings; smoothing additionally
gated on `repeat_overlap === "smooth"`), passed to `buildRepeatStrokes`.
**Both must join `geomSig`** ([stroke.ts:294](../src/nodes/effect/stroke.ts))
— they change ring geometry, and the node's internal signature cache would
otherwise serve stale Path2Ds.

**Back-compat:** defaults reproduce today's output exactly; no schema bump.
Docs: the three node `description` strings mention the new mode (docs pages
render from defs); devguide § spline nodes gets a line; the devlist entry
gets its DONE annotation + spec pointer when shipped.

## Verification (manual, no test runner)

- Open zigzag → Offset Path, large distance: concave corners resolve to a
  single intersection (sharp) / a fillet (smooth); convex side unchanged.
- Closed star → Repeat Path, direction inner, count 8: rings stop
  bowtie-ing; push width until inner rings fully collapse → they vanish
  rather than glitch.
- Same star → Stroke with Repeats ≥ 8: rings clean; toggle overlap while
  scrubbing to confirm the geomSig cache busts.
- Compound path (text outline with holes): each subpath resolves
  independently; `groupIndex` survives (spot-check via Group Pick).
- Keep mode + old saves: pixel-identical to pre-feature output.
- Gates: `npm run typecheck`, `npm run check`, `npm run lint:ratchet`.

## Milestones

1. **Engine sharp resolve + Offset Path.** `spline-offset-resolve.ts`
   (find/cull/rebuild, open + closed + drop-on-full-inversion) wired into
   Offset Path behind the `overlap` enum. Browser-verify on zigzag + star.
2. **Repeat Path + Stroke Repeats.** `RepeatStrokeOpts.overlap` plumb-
   through, node params, stroke `geomSig` extension.
3. **Smooth mode.** Junction-only fillet helper (extracted from
   `roundSubpath`), `smoothing` knobs on all three, docs + devguide +
   devlist annotation.
