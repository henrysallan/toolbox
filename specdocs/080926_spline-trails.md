# Spline Trails — points → per-point motion-trail splines

Status: shipped (single milestone).

## What it is

A new node, **Spline Trails** (`spline-trails`), that watches a `points`
input over time and emits one open spline subpath per point tracing where
that point has been — the classic motion-trail. Feed it anything animated
(Points on Path with Animate, a particle sim's points, Modulate Points
wiggle, Scatter driven by a mask) and wire the output into Stroke /
Rasterize Spline.

It is the **temporal** sibling of Points to Spline: that node chains the
*current* point set into one spline in index order; this one chains each
point's *history* into its own subpath.

## Design decisions (the Q&A, resolved)

- **Scene time, never wall clock.** Samples are stamped with `ctx.time`
  and expire by scene-time age. This is what makes the node exportable:
  `simulation: true` + scene-time accumulation means the export drivers'
  sim pre-roll (lib/sim-preroll.ts) reproduces the preview exactly.
  Paused timeline = frozen trails (paused param edits move the trail
  *head* in place but never grow it).
- **Trail identity** must survive membership churn (Cursor Trail Points'
  ring overflow shifts indices; particles die). Key =
  `groupIndex : ordinal-within-that-group` when the input carries
  `groupIndices`, else the plain array index. This handles both
  groupIndex regimes: Cursor Trail Points' unique-id-per-point tags
  (ordinal always 0 → trails follow the id through ring shifts) and
  Collect's collection-id tags (ordinal = position within the
  collection, so other collections' trails survive one collection
  resizing). An identity that disappears keeps its trail, which decays
  naturally by expiry — a dead particle's trail fades out instead of
  vanishing.
- **Stationary points shed their trail.** When time advances but the
  point hasn't moved (< 1e-6), the head sample's timestamp refreshes
  instead of pushing a duplicate; old samples keep expiring, so the
  trail contracts to nothing rather than accumulating a coincident-point
  clump. (catmullRomSubpath is division-free and safe on coincident
  points regardless — this is about behavior, not NaNs.)
- **Loop/rewind clears** (`clear_on_loop`, default on) — same convention
  as Cursor Trail Points and Loop Weave's auto-reveal pen: scene time
  moving backwards resets the accumulation.
- **Taper via the width profile.** `tail_width` writes
  `SplineAnchor.width` (a multiplier on the consuming stroke's base
  thickness, spec 072726 M3) ramping from `tail_width` at the oldest
  sample to 1 at the head. Default 0 — a trail that tapers to nothing is
  *the* trail look; set 1 for uniform width. Only written when < 1 so
  the default-off case stays lean.
- **Output tagging**: emitted subpaths inherit the source point's
  `groupIndex` when the input was tagged (per-index downstream ops and
  color-by-index keep working); untagged input emits untagged subpaths,
  mirroring Points to Spline. Emission order sorts by (groupIndex,
  ordinal) so output order is stable regardless of input interleaving.
- **Caching**: `stable: false` (state advances with the eval clock).
  The evaluator's `t:` fingerprint stamp already busts downstream every
  time scene time changes, and input-driven changes ride the input
  fingerprints — no `fingerprintExtras` needed (unlike Cursor Trail
  Points, whose state moves on wall-clock/pointer signals invisible to
  scene time).
- **Caps, not knobs**: MAX_TRAILS = 2048 identities (new points beyond
  that are ignored), MAX_SAMPLES = 1024 per trail (oldest dropped).
  Documented in the node comment; no params for them.

## Params

| name | type | default | notes |
|---|---|---|---|
| `length` | scalar (s) | 0.75 | trail age window; min 0.05, max 30, softMax 3 |
| `curve` | enum linear/smooth | smooth | corner anchors vs catmull-rom auto handles (same as Points to Spline) |
| `tail_width` | scalar 0–1 | 0 | width multiplier at the oldest end, lerped to 1 at the head |
| `clear_on_loop` | boolean | true | reset when scene time jumps backwards |

Primary output `spline`; no aux outputs. Category spline/generator.
Coordinates pass through untouched (authored in → authored out), so no
aspect math anywhere in the node.

## Files

- `src/nodes/effect/spline-trails.ts` — the def.
- `src/nodes/index.ts` — registration (beside Points to Spline).
