# Typed-Array Points Refactor — Checklist

Goal: make `PointsValue` cheap to iterate at high N, eliminate per-point object/array allocations in hot effect nodes, and unblock GPU paths (transform feedback / WebGPU compute) by storing point data in `Float32Array`s.

## Strategy: additive, not destructive

We do NOT remove `points: Point[]`. We add parallel typed-array fields alongside it. Hot-path consumers read the typed arrays; legacy consumers keep working unchanged. We migrate producers/consumers one at a time. When everything's migrated, we can flip the default and (optionally) remove the object array.

This lets us land the refactor incrementally without breaking the graph.

## New shape

```ts
export interface PointsValue {
  kind: "points";
  count: number;                // authoritative length
  positions: Float32Array;      // length = count * 2,  [x0,y0, x1,y1, ...]
  scales?: Float32Array;        // length = count * 2  (undefined = all [1,1])
  rotations?: Float32Array;     // length = count      (undefined = all 0)
  groupIndices?: Int32Array;    // length = count      (undefined = all 0)
  // Legacy view, lazily built. Prefer typed arrays in new code.
  points: Point[];
}
```

Invariants:
- `positions.length === count * 2` always.
- `scales` / `rotations` / `groupIndices` are either absent OR full-length. No partial coverage.
- `points` is either authored directly OR lazily synthesized from typed arrays. It's a view, not authoritative — never mutate it without also updating the typed arrays.

## Helpers (one new file: `src/engine/points.ts`)

- [ ] `makePoints(count): PointsValue` — allocates positions, no scale/rot, empty `points` array (lazy).
- [ ] `pointsFromArray(pts: Point[]): PointsValue` — current shape → typed arrays. Used by every existing producer until migrated.
- [ ] `ensurePointArray(p: PointsValue): Point[]` — builds `points` from typed arrays on demand (memoized via internal `_pointsBuiltFor` token).
- [ ] `clonePoints(p: PointsValue): PointsValue` — copies typed arrays.
- [ ] `EMPTY_POINTS` constant for the common `kind: "points", count: 0` case.

## Engine plumbing

- [ ] Update `PointsValue` in `src/engine/types.ts`. Keep `points: Point[]` non-optional for now (lazy fill).
- [ ] Add a getter or helper so `value.points` works for any consumer that hasn't been migrated yet. Cheapest: producers always set `points: []` and we expose `ensurePointArray()` for consumers that actually iterate. Or: make `points` a real array that producers leave empty and we lazily fill via `ensurePointArray`. Pick one and stick to it.
- [ ] Audit `src/engine/coerce.ts` / `evaluator.ts` for any code that reads `value.points` directly — wrap with `ensurePointArray`.

## Producers (write the new shape directly; emit `points: []` placeholder)

- [ ] `src/nodes/source/point.ts`
- [ ] `src/nodes/effect/scatter-points.ts`
- [ ] `src/nodes/effect/points-on-path.ts`
- [ ] `src/nodes/effect/lissajous.ts`
- [ ] `src/nodes/effect/object-tracker.ts`
- [ ] `src/nodes/effect/hand-tracker.ts`
- [ ] `src/nodes/effect/particle-simulator.ts` (readback path)
- [ ] `src/nodes/effect/group.ts` (concatenates Float32Arrays now)
- [ ] `src/nodes/effect/group-pick.ts`
- [ ] `src/nodes/effect/connect-points.ts` (passthrough only — easy)
- [ ] `src/nodes/effect/simulation-start.ts` / `simulation-end.ts`
- [ ] `src/nodes/source/fracture.ts` (vertices output)

For each producer: if it currently builds `Point[]` and wraps it, switch to `pointsFromArray(pts)` as a one-liner first. Tighten the hot ones later.

## Consumers (read typed arrays in the hot loop)

Priority order — top of list = most expected speedup:

- [ ] `src/nodes/effect/modulate-points.ts`  ← the reason we're here
- [ ] `src/nodes/effect/modulate-splines.ts`
- [ ] `src/nodes/effect/copy-to-points.ts`
- [ ] `src/nodes/effect/jitter.ts`
- [ ] `src/nodes/effect/transform.ts` (point branch)
- [ ] `src/nodes/effect/set-position.ts`
- [ ] `src/nodes/effect/array.ts` (point branch)
- [ ] `src/nodes/effect/proximity-merge.ts`

Per-consumer pattern:

```ts
const { count, positions } = src;
const scales = src.scales;       // may be undefined
const rotations = src.rotations; // may be undefined

const outPos = new Float32Array(count * 2);
const outScale = new Float32Array(count * 2);
const outRot = new Float32Array(count);

for (let i = 0; i < count; i++) {
  const px = positions[i * 2];
  const py = positions[i * 2 + 1];
  // ...write outPos[i*2], outScale[i*2], outRot[i]...
}

return {
  primary: { kind: "points", count, positions: outPos, scales: outScale, rotations: outRot, points: [] },
};
```

Mutation pattern (when the node is allocation-free): if the consumer is the sole owner (post-cache), it can write back into pre-allocated typed arrays cached in `ctx.state[nodeId]` — zero allocations per frame.

## UI / overlay consumers

- [ ] `src/components/effects/PointsOverlay.tsx` — accepts `Point[]`. Switch to reading typed arrays directly OR call `ensurePointArray()` once.
- [ ] `src/components/effects/NodeInspectorPopup.tsx` `PointsSummary` — same.
- [ ] `src/components/effects/EffectsApp.tsx` (line ~952 — points kind handling).

## Verification

- [ ] `npm run lint` clean.
- [ ] `tsc --noEmit` clean.
- [ ] Open a graph with: scatter → modulate-points → copy-to-points (image mode) → output. Confirm visual parity with `git stash` of pre-refactor.
- [ ] Same graph with: scatter → modulate-points → connect-points → output. Visual parity.
- [ ] Same graph with: scatter → group → group-pick → output. Visual parity.
- [ ] Hand-tracker / object-tracker still drive copy-to-points.
- [ ] Particle simulator readback (CPU bridge) still produces visible points.
- [ ] Save / load a project containing points-bearing graph — round-trip clean (PointsValue isn't serialized directly, but sanity-check anyway).
- [ ] FPS check on the original slow scene. Target: noticeably above current 37.

## Stretch (do NOT bundle into this refactor)

- WebGL2 transform feedback path for modulate-points.
- WebGPU compute path for modulate-points.
- Removing `points: Point[]` and migrating overlays + inspector to typed arrays.

These become straightforward once the typed-array shape is the source of truth everywhere.

## Out of scope

- Changing socket types, serialization format, or node identities.
- Touching splines (`SplineValue`) — separate refactor if/when needed.
- Renaming any nodes.
