# Displace — polymorphic (image / spline / points), Jitter merged in (spec)

Snapshot 2026-06-25. Owner wants to "use noise to push around points / spline
points." That capability existed as **Jitter** (per-anchor displacement by
X/Y noise images) but was hard to find (filed under `utility`, named for random
scatter), so users kept reaching for **Set Position** — which is absolute
whole-cluster placement, the wrong tool. There was also a separate **Displace**
node doing the same operation for image pixels. Two overlapping nodes = the
confusion.

## Decision (settled with owner)

Merge Jitter into **Displace** as one polymorphic node:

- **Source socket (`in:image`) retypes from what's wired** — image / spline /
  points — via `resolveInputs`' `connectedTypes` (the [math.ts](../src/nodes/effect/math.ts)
  idiom). No `mode` toggle. `resolvePrimaryOutput` makes the output type follow.
- **`compute` branches on the source kind:** image → the original per-pixel GPU
  shader (unchanged); spline / points → CPU per-anchor sampling of the
  displacement field (the old Jitter mechanism), generalized to read the picked
  channels.
- **Displacement field stays one image with `channelX` / `channelY`** (R→X,
  G→Y). This is the existing Displace model and the designed pipeline: Perlin
  Noise in **flow** / **curl** mode outputs an RG vector (`vec4(v*0.5+0.5,0,a)`)
  precisely so Displace's R/G channels read a signed 2D push. Decorrelated X/Y
  comes from one flow-noise input — no need for two sockets. Offsets are in
  normalized `[0,1]` units, shared by pixels (UV) and geometry positions, so the
  one set of amount sliders works for every source type. `wrap` applies to the
  image path only (ignored for geometry).

Usage: Perlin Noise (flow/curl) → Displace `displace`; spline/points → Displace
`in`; the default `channelX=r` / `channelY=g` already match the flow output.

## Code

- [effect/displace.ts](../src/nodes/effect/displace.ts) — rewritten: `resolveInputs`
  / `resolvePrimaryOutput` off `connectedTypes`; CPU branch (readback field once
  per eval, `sampleChannel` per anchor/point, offset `(v−midlevel)·amount`);
  image branch unchanged; `dispose` drops the scratch canvas. Source handle name
  kept as `image` (no edge/save breakage); params unchanged.
- [components/effects/NodeEditor.tsx](../src/components/effects/NodeEditor.tsx) —
  `isValidConnection` + `canCoerce` allow `spline` / `points` → Displace's
  `in:image` (it reads `image` by default before anything is wired, so the wire
  would otherwise be rejected before `resolveInputs` could retype it). Mirrors
  the existing `copy-to-points` `in:instance` precedent.

## Back-compat (invariant #2)

- `displace` type/handles/params unchanged → existing Displace saves load and
  render identically (output resolves to `image` when nothing/an image is wired).
- **Jitter kept registered but `hidden: true`** ([effect/jitter.ts](../src/nodes/effect/jitter.ts)):
  old projects with `jitter` nodes still compute and render; it's just gone from
  the add menus / docs. New work uses Displace. No migration of `jitter` →
  `displace` (param/handle shapes differ); the hidden alias is sufficient.
- Array node's user-facing description updated ("feed Jitter" → "feed Displace").
  Historical changelog entry left as-is.

## Notes / not done

- CPU sampling stays nearest-neighbor (matches old Jitter). Bilinear would be a
  strict quality upgrade for low-res noise — deferred.
- Geometry path still gets the universal `mask` input socket appended (harmless;
  the mask blend is image-only). Same as Jitter before.
