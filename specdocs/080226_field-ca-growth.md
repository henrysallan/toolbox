# Field/CA Growth (spec, 2026-08-02)

Status: **spec, not implemented.** Survey: [080226_growth-systems-survey.md](080226_growth-systems-survey.md).
Shared conventions in [080226_accretive-growth.md](080226_accretive-growth.md) §2.

Family D: *no discrete elements — a field evolves under a local rule.*
Image in, image out.

```
type:        "field-ca-growth"          ← slug; display name has a slash
name:        "Field/CA Growth"
file:        src/nodes/effect/field-ca-growth.ts
category:    "image"       subcategory: "modifier"
backend:     "webgl2"
headerControl: { paramName: "mode" }
stable:      false                      ← Reaction Diffusion's precedent
```

**Reaction Diffusion and Watercolor Ink stay standalone.** Both are shipped
Family D nodes with saved projects referencing their `type` strings;
absorbing them as modes here would be a migration tax (invariant #2) for no
user gain. This node ships the modes they *don't* cover. Consolidation is
not planned.

`watercolor-ink.ts` is the structural template to copy: persistent
`RGBA32F` textures allocated by the node, ping-pong through
`ctx.drawFullscreen`, one shader per rule stage, `ctx.allocImage()` for the
final render pass.

---

## 1. Modes

| mode | rule | look |
|---|---|---|
| `cyclic` | k-state cyclic CA: a cell advances to state (s+1) mod k if ≥`threshold` neighbours are already there | spiral waves, rock-paper-scissors demons |
| `lenia` | continuous CA — Gaussian kernel convolution + smooth growth mapping (Chan 2019) | emergent self-organising "creatures" |
| `smoothlife` | continuous Game of Life over inner/outer disc averages (Rafler 2011) | gliding blobs, smooth mitosis |
| `excitable` | FitzHugh–Nagumo / BZ two-variable excitable medium | target patterns, rotating spirals |
| `sandpile` | abelian sandpile: cells with ≥4 grains topple to neighbours | deterministic fractal, unlike anything else here |
| `snowflake` | Reiter 2005 hex-grid crystal growth (α diffusion, β background vapour, γ addition) | real snowflake variety from three numbers |
| `langton` | Langton's ant / turmites — agents on the grid flipping cells | emergent highways from a 2-rule automaton |
| `wolfram` | 1D elementary CA, one generation per row, scrolling down the canvas | **the timeline becomes the spatial axis** |

`snowflake` lives here rather than in Accretive Growth (where it might
seem to belong) because its rule is a diffusion field over the whole grid
with no frontier-attachment step and no parent structure — it has nothing
to emit as branches. Accretive's `boundary` emission and this node's
`boundary` aux (§4) deliberately overlap, so the two nodes meet at the
silhouette.

---

## 2. Sockets & universal params

| socket | type | required | meaning |
|---|---|---|---|
| `seed` | image | no | initial state. Unwired ⇒ seeded noise (`seed_density`, `seed` params) |
| `region` | mask | no | evolution confined here; outside stays frozen |
| `feed` | image | no | per-pixel modulation of the mode's primary rate param — **this is how you art-direct a CA**, painting where it runs hot |

Primary output: **image**.

| param | range | default | notes |
|---|---|---|---|
| `mode` | enum | — | `cyclic`; headerControl |
| `steps_per_frame` | int 1–64 | 8 | sim speed without changing rule constants |
| `resolution` | 128–2048 | 512 | sim grid; decoupled from canvas |
| `seed_density` | 0–1 | 0.5 | noise seeding when `seed` unwired |
| `seed` | int | 0 | |
| `feed_amount` | 0–1 | 0 | how hard `feed` modulates |
| `colorize` | enum | `state` | `state \| ramp \| raw` — how the field renders |

Per-mode params (kernel radii for Lenia/SmoothLife, `k`/`threshold` for
cyclic, α/β/γ for snowflake, rule number for Wolfram/Langton, ε/a/b for
excitable) hang off `visibleIf`.

---

## 3. Timeline — stateful only

Same as Differential Growth: **not sliceable, no `progress`.** A CA's state
at frame N does not contain frame N−1.

- Persistent ping-pong `RGBA32F` textures owned by the node
  (`watercolor-ink.ts` line ~524 is the allocation pattern), reallocated on
  `resolution` change.
- Reset on: first eval; scene-time wrap (`lastTime > 0.05 && time < 0.05`);
  `resolution` / `mode` / seeding-param change.
- Advance gate on `ctx.time !== lastTime` so paused param tweaks re-render
  the current state rather than stepping.
- `stable: false`, `fingerprintExtras` returns `ctx.time`, `dispose`
  releases the textures (invariant #3 — release what you alloc).

`langton` and `wolfram` are the two odd ones: both keep small CPU-side
state (ant positions / the current row index) alongside the texture, which
is fine — the texture is still the authoritative field.

---

## 4. Aux output — `boundary` (spline)

`marchingSquares(grid, w, h, { iso })` from `engine/marching-squares.ts`
over a readback of the state texture, giving the field's level set as
closed subpaths. **Consumption-gated** (`consumedOutputs.has("aux:boundary")`)
because it costs a full readback per frame — and the gating is safe here
precisely because the node is `stable: false` and never serves a cached
NodeOutput (the trap Advect Points documented does not apply).

This is what turns any of these fields into strokeable, fillable geometry —
Lenia creatures as outlines, sandpile terraces as contour rings.

---

## 5. Milestones

1. **M1 — Spine + cyclic.** Node + registration; persistent RGBA32F
   ping-pong, resolution handling, reset rules, advance gate, dispose;
   seeding (noise + `seed` image); `colorize` render pass; `cyclic` mode.
   Verify: spiral waves form; `steps_per_frame` changes speed not
   character; texture count is stable over a long playback.
2. **M2 — Continuous CA.** `lenia` + `smoothlife` (shared separable
   kernel-convolution stage). Verify: known Lenia parameter sets produce
   stable gliders — this is the correctness check that the kernel and
   growth mapping are right.
3. **M3 — Excitable + sandpile.** Two-variable FitzHugh–Nagumo;
   integer-grain sandpile with a toppling pass. Verify: spirals rotate
   rather than dying; sandpile reaches the known fractal steady state.
4. **M4 — Grid oddballs.** `snowflake` (hex neighbourhood on a
   rectangular texture via offset rows), `langton`, `wolfram`. Verify:
   α/β/γ sweeps produce visibly different crystals.
5. **M5 — Region, feed, boundary.** `region` freezing, `feed`
   modulation, the `boundary` aux. Verify: a painted `feed` mask makes
   the CA run hot only where painted; boundary traces the level set.
6. **M6 — Bookkeeping.** `description`, docs page, an explicit note that
   RD and Watercolor Ink are separate nodes and why, devlist, devguide.

---

## 6. Deliberately not doing

- **No absorbing Reaction Diffusion or Watercolor Ink** — §preamble.
- **No neural CA.** Requires trained weights; the parameter space isn't
  explorable with sliders, which is the whole point of the other modes.
- **No CPU fallback.** These are the one family that is unambiguously
  GPU-shaped.
