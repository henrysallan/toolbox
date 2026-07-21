# Mirror node — axis / radial symmetry for splines & points

**Status: shipped (M1).**

A single **Mirror** node (`mirror`, utility) that duplicates CPU geometry
under a symmetry: reflect across the X or Y axis (or both), or repeat
radially around a center with a count slider. Works on `spline` and
`points` — the input socket retypes itself (and the output) from whatever
is wired in, exactly like Transform / Displace (connectedTypes retyping,
no mode param). No image mode: raster mirroring is already covered by
SDF Position Mirror / Polar for SDF content and can be added later as a
shader mode if wanted.

## Design

- **Input** `source` (resting type `spline`; retypes to `points`).
  Output mirrors the input kind. `noMaskInput` — the node never emits
  images, so the universal matte socket is noise (same reasoning as
  Rope Simulator / Spline Interpolate).
- **`mode`** (segmented): `x` | `y` | `both` | `radial`.
  - `x` — reflect across the **vertical** line at `centerX` (the "X
    mode" mirrors left↔right, matching how users read "mirror X").
  - `y` — reflect across the horizontal line at `centerY`.
  - `both` — source + X-reflection + Y-reflection + 180° rotation
    (the four-quadrant set; the 4th copy is the point reflection, not a
    double-negated no-op).
  - `radial` — `count` copies rotated evenly around
    (`centerX`,`centerY`); copy 0 is the source itself.
- **`centerX` / `centerY`** (0..1, default 0.5): the mirror line /
  rotation center. `centerY` hides in `x` mode, `centerX` in `y` mode.
- **`count`** (radial only, 1..64, soft 24, default 6).
- **`kaleidoscope`** (radial only, default off): interleaves a mirrored
  copy per wedge — the source reflected across the horizontal line
  through the center, then rotated with its wedge. Total copies = 2 ×
  count = the dihedral group D_count (mirror lines fall on the wedge
  boundaries), i.e. an actual kaleidoscope.
- **`includeSource`** (axis modes only, default on): off = emit only the
  reflected copies. This is the one thing Transform can't fake (its
  scale is clamped positive, so a pure reflection is otherwise
  unreachable).
- **`tagGroups`** (default off): stamp `groupIndex` = copy index on
  every emitted subpath / point (otherwise incoming groupIndex is
  preserved). Turns the copies into addressable groups for
  ramp-by-group fills, Group Pick, Copy-to-Points variation, etc. —
  same convention as Repeat Path's per-ring tags.

## Math notes

- **Aspect correction** (decided explicitly per the devguide rule):
  axis reflections and the 180° copy are axis-aligned → aspect-free.
  Radial rotations run in pixel-isotropic space — deltas from the
  center are mapped `(dx, dy/aspect)`, rotated, mapped back — so
  copies rotate as rigid shapes on non-square canvases instead of
  shearing (`aspect = ctx.width / ctx.height`). Canvas resizes rebuild
  the engine backend and drop the eval cache, so the aspect isn't in
  the fingerprint.
- **Handles** are deltas: they flip/rotate but never translate
  (mirrors `transformAnchor` in spline-transform.ts). Anchor order is
  left as-is — the mirrored curve is traversed in mirrored direction,
  which is invisible to even-odd fills and correct for strokes.
- **Point frames under reflection**: a single flip is orientation-
  reversing, which no rotation+positive-scale can represent, so a
  mirrored point gets `rotation → −rotation` and the flipped axis's
  scale component **negated** (M·R(θ) = R(−θ)·diag(−1,1) for an X
  flip). Downstream Copy-to-Points then stamps genuinely mirrored
  instances. Two flips compose to a pure rotation: `rotation → θ+π`,
  scale untouched. Radial adds the wedge angle to `rotation`.

## Touch points

- `src/nodes/effect/mirror.ts` — the def (pure CPU, no GL, no state).
- `src/nodes/index.ts` — registration.
- `EffectsApp.tsx` `CONNECTED_TYPE_RETYPE_NODES` — add `"mirror"` (mode-less
  connectedTypes retyping, per the devguide rule for Transform/Displace/
  Reroute).
- `engine/graph-validation.ts` `editorCanCoerce` — allow `points` onto the
  spline-resting `in:source`.

Verification: typecheck + lint ratchet + `npm run check`; manual in
browser (no test runner in this repo).
