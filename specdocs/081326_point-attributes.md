# Named point attributes (extends #89; enables spreadsheet columns)

Blender/Houdini-style named per-point channels — `weight`, `age`, `color` —
riding on `PointsValue`, authored by Point Expression / a Set Attribute
node, consumed by instancing, filtering, labels, and the Spreadsheet panel
(081326_spreadsheet-panel.md, whose table projection was built to grow
extra columns with zero panel changes).

Grounded in a full sweep of the point pipeline (08/13/26): 40 files
construct a `PointsValue`; 13 hand-roll raw object literals; ~10 round-trip
through the legacy `Point[]` view. Five transforms (Modulate, Lerp, Sample
Texture at Points, Advect, Point Expression) already silently drop
`z`/`normals` today — the same lossiness attributes would hit — so the
foundation milestone is a correctness refactor that pays for itself even if
the rest never ships.

## Data model (M1 — the field itself)

```ts
// On PointsValue, additive + optional, like z/normals:
attributes?: Record<string, PointAttribute>;
export interface PointAttribute {
  arity: 1 | 2 | 3 | 4;   // float / vec2 / vec3 / vec4
  // Display hint only — arity 3/4 channels tagged "color" render as
  // swatches in the spreadsheet and feed Instance Color directly.
  color?: boolean;
  data: Float32Array;     // length = count * arity
}
```

Decisions:

- **Built-ins stay fixed fields.** positions/scales/rotations/groupIndices/
  z/normals are NOT migrated into the map — hot consumers read them
  monomorphically, and `groupIndex` is an identity tag with its own
  non-interpolating semantics (lerp.ts documents this). Attributes are the
  extension surface only. Reserved names: the POINT_LABEL_FIELDS set
  (`position x y index rotation scale group`) plus `z nx ny nz` — a channel
  may not shadow a built-in column.
- **Runtime-only, like the whole value.** Nothing serializes a PointsValue
  (verified: zero sites), so no save-format change. Caching is untouched —
  fingerprints key on the producer chain, never value contents.
- **No socket/coercion changes.** `points`/`points3d` both carry the map;
  the 2D/3D discriminator stays `z` presence.
- **Missing channel reads as 0.** Combiners zero-fill; consumers default 0.
- **EMPTY_POINTS stays frozen** — attributes attach at construction only,
  never lazily onto a received value.

## Propagation law (the part that must be uniform)

Every points-touching node is one of six classes; each has ONE rule:

- **Per-point transform** (count+order kept): share `attributes` by
  reference — the InstancesValue convention ("copy the value, replace the
  arrays you change, share the rest").
- **Subset/reorder**: gather every channel through the same index map
  (filter-points.ts is the canonical template — today the only node that
  carries all five optional arrays).
- **Combiner**: Collect = union of channels, zero-fill missing, all inputs'
  channels survive. Lerp = per-channel lerp when both sides have the
  channel, else carry A's. Proximity Merge = blend within a cluster, then
  representative-wins on dedupe. Copy-to-Points point mode = carry the
  TARGET's channels, drop the source's (v1).
- **Producer**: may emit channels (none required).
- **Simulator**: rebuild per frame, re-reading channels from the CURRENT
  seed input by original index — the advect-points idiom ("only positions
  persist").
- **Consumer**: opt-in reads.

## Milestones

- **M0 — helpers + lossy-site fix (this commit; no user-visible change).**
  Two engine helpers in points.ts:
  - `copyPointsWith(src, replacements)` — spread-and-replace copy: new
    value object, replace only the named arrays, share the rest, reset the
    lazy `points` view. The per-point-transform primitive.
  - `gatherPoints(src, indexMap)` — subset/reorder: gathers positions and
    every present optional array through one index map. The subset
    primitive.
  Migrate the five z/normals-lossy sites onto them (modulate-points, lerp
  points path, sample-texture-at-points, advect-points, point-expression).
  Attributes don't exist yet — but once they do, propagation lands in
  exactly these two helpers.
- **M1 — the field + plumbing. SHIPPED 08/14/26.** `attributes` on the
  type; copyPointsWith/gatherPoints/clonePoints carry it, plus two new
  primitives: `gatherAttributes` (channel-map gather for consumers with
  their own expansion maps) and `concatPoints` (combiner concat with
  channel-presence union — Collect and Proximity Merge ride it). Combiner
  rules landed: Lerp lerps matching channels (A-only carries, B-only
  drops), Collect unions + zero-fills, Proximity Merge blends toward the
  cluster mean at the geometry's t then representative-picks on dedupe,
  Copy-to-Points point mode gathers the TARGET's channels through its
  product map. The `Point[]`-roundtrip nodes are off `ensurePointArray`:
  jitter/displace/set-position (positions-only SoA), transform (SoA;
  incidentally fixes its old groupIndex drop), mirror/array (tiled
  gather + per-copy overwrite), group-pick (match-map gather).
  Spreadsheet grows attribute columns (scalar, per-component vecs,
  color-tagged swatches); points summaries read "· N attrs".
  Known gaps (fine for now): Iterate's points accumulation and the
  particle simulator's emit still round-trip `Point[]` (sim state has no
  seed identity to gather from); Copy-to-Points spline/image modes don't
  consume channels yet (that's M3).
- **M2 — authoring. SHIPPED 08/14/26.** The node shipped as **Set Named
  Attribute** (`set-named-attribute`, point/modifier): name + type
  (float/vec2/vec3/vec4/color) + source (constant / index ramp with Lo–Hi
  / stable per-index random / image sampled at point position — float
  reads luminance, color reads RGBA). Reserved or empty names pass
  through unchanged; `RESERVED_POINT_ATTR_NAMES` in points.ts is the
  shared guard. Point Expression gained `attr("name", component?)` +
  `setattr("name", v)` as env keys closing over a per-eval cursor (the
  monomorphic PointCtx and packed 7-tuple stayed untouched); reads see
  the SOURCE value only (order-independent), writes are float channels
  compacted through keptMap and overlaid over carried channels.
  User docs: /docs/editor/point-attributes ("Point data & the
  Spreadsheet" — panel, built-ins, authoring, flow rules, limits); the
  node self-documents on the auto-generated Point Nodes page.
  The channel name renders as a single-line text field ON the node body
  (EffectNode's STRING_INPUT_PARAMS grew a `singleLine` variant) — the
  name is the node's meaning, so it reads in the graph.
  DECIDED against a Blender-style "get attribute as a socket" for now:
  Blender sockets carry lazily-evaluated per-element FIELDS; ours carry
  concrete values, so the only honest wire type for per-point data is
  `list`. The getter roles are covered by Point Expression's `attr()`
  (programmable read) and M3's consumption features (map-to-scale/
  rotation, instance tint, filter-by-attribute). A "Get Named Attribute →
  list" node stays cheap to add if a list-chain use case appears.
- **M3 — attribute operations (owner Q&A 08/14). SHIPPED 08/14/26.** The
  Houdini-shaped toolkit, each a plain node — no fields needed:
  - **Attribute Math** (`attribute-math`): channel in, op (add/sub/mul/
    div/min/max/power + remap lo-hi→lo-hi), operand = constant OR a
    second channel, write to the same or a new name.
  - **Attribute Blur** (`attribute-blur`): N iterations of lerp toward
    the neighborhood mean. Domain: spatial (radius in authored units,
    Proximity Merge's distance convention, via the sim-kernel spatial
    hash run over normalized space W=H=1) or index (1D kernel along
    point order — for path-ordered points).
  - **Attribute Transfer** (`attribute-transfer`): source points →
    target points by proximity; nearest or distance-weighted average
    within a radius. Same spatial core as Blur.
  - **Spline attributes**: `attrs?: Record<string, number | number[]>`
    ON the SplineAnchor and SplineSubpath objects (the width/cornerRadius
    /driver precedent — object-attached so `{...a}` spread-copying ops
    carry them and anchor inserts can't desync a parallel array; this is
    deliberately NOT the points SoA shape, because spline topology
    mutates). Set Named Attribute goes polymorphic (points | spline) with
    a Domain param (anchor | subpath); the spreadsheet's spline table
    grows the columns.
  - **The name dropdown + invalid tint** (Blender-v1's lesson): attribute
    name params declare `suggestAttrsFrom: "<input socket>"` (+
    `suggestAttrsRequire` on consumers, where the name must exist); ONE
    registry (components/effects/attr-name-source.ts, fed by EffectsApp
    with an edges + eval-cache closure) resolves a node's wired input to
    its upstream channel names, serving BOTH surfaces — the panel row's
    datalist picker and the on-node single-line fields (all four
    attribute nodes render their name on the body). A verified-wrong
    name — reserved, or absent upstream on a require param — tints both
    fields with the error red; unwired/unevaluated inputs never flag
    (nothing can be verified).
  All 2D-points-first: `points3d` can't ride a `points` socket, so the
  spatial ops are 2D by construction until a 3D need appears.
- **M4 — rendering consumption. 2D HALF SHIPPED 08/14/26.**
  - Map Attribute node (`map-attribute`): channel component 0 → clamped
    In/Out remap → scale multiply / rotation add / position x/y offset.
  - Filter Points `attribute` mode: keep where channel ≥ Threshold
    (space-blind, works on 3D). Same change also fixed a real M1 gap:
    Filter Points' hand-rolled compaction predated gatherPoints and was
    silently DROPPING attributes — it now rides the helper.
  - Copy to Points (image mode) `tint_attr`: an arity≥3 channel on the
    target points packs into the data texture's free floats
    (`(scaleY, r, g, b)`), the instanced FS multiplies rgb (alpha stays
    straight). The pack-skip cache key includes the channel name — the
    points-identity check alone can't see a param-only change.
  - Copy to Points `opacity_attr` (image mode) + `pick_mode: "attribute"`
    (all modes), added same day: the data texture grew a THIRD row per
    instance — `(opacity, _, _, _)`, OFF packed as 1.0 so no enable
    uniform, clamped [0,1] (negative coverage breaks source-over) — and
    the variant pick reads the target point's channel through the same
    [0,1]→variant mapping as image luminance (`pick_attr` names it;
    CPU-side, so it works in image/spline/point/text modes alike).
  - `{attr:name}` token in point-labels (component 0, missing reads 0).
  - **The reference wire (owner Q&A 08/14):** Set Named Attribute and
    Attribute Math emit a `name` STRING aux output — the channel's name.
    Every attribute-name param is a string param, so it exposes as a
    string socket; wiring the name aux into it gives the Blender "pull a
    wire from the attribute" gesture with existing machinery: the DATA
    rides the points wire, the wire carries the REFERENCE, and renaming
    at the source ripples through every wired consumer. This is the
    honest resolution of the fields question — no new socket type.
  - REMAINING (3D): Instance Color "attribute" source needs channels to
    reach InstancesValue (either an attributes map on it, or 3D Copy to
    Points reading a color channel into `colors`) — and Set Named
    Attribute needs a points3d target first, since 2D-only sockets mean
    nothing can author onto 3D points today.

## Verification

M0: `npm run typecheck` / `npm run check` / `npm run lint:ratchet`; manual —
Modulate/Lerp/Advect/Point Expression graphs behave identically (pure
refactor), and a 3D value through Sample Texture at Points keeps its z.
Later milestones add spreadsheet-visible checks (author a channel, watch
the column).
