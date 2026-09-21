# Expression channel kinds — toggles, pick, color, ramp, curve for Point Expression + GLSL Expression

Spec — 2026-09-04. Status: **M1 built** (see Milestones).

## Why

Point Expression and GLSL Expression share one tunable mechanism: a
`ch("name", default, min, max)` reference in the source is a **channel** —
the Sync scan mints a slider row on the node, the row is a wireable scalar
socket, and the code reads it by name. `pick("name", "a", "b")` is the
only other kind (a dropdown, panel-only).

That covers "a number". It does not cover what a real effect wants to be
driven by: an on/off switch, a 2/3-way mode, a color, a gradient (the
per-pixel `t → color` lookup every stylize shader eventually writes by
hand as `mix(mix(a,b,..),c,..)`), or a falloff curve. Today those are
either magic numbers in the code or a pile of `ch()` sliders pretending to
be a color. This spec makes them first-class channel kinds, in both
nodes, through the same Sync / socket / recipe machinery — and teaches the
in-app agent (080826_claude-agent-panel.md) to author them, because the
agent is where most expression code will come from.

## Channel kinds

| kind | Point Expression (JS) | GLSL Expression (comment decl → usage) | panel row | socket | stored value |
|---|---|---|---|---|---|
| `scalar` | `ch("k", 0.5, 0, 1)` | `// ch("k", 0.5, 0, 1)` → `float k` | slider | `scalar` | number |
| `enum` | `pick("mode", "a", "b", "c")` | `// pick("mode", "a", "b", "c")` → `int mode` + `const int mode_a = 0 …` | segmented pill (≤ 3 options) / dropdown | — | option string |
| `toggle` | `toggle("invert", false)` | `// toggle("invert", false)` → `bool invert` | toggle pill | `scalar` (≠ 0 ⇒ on) | boolean |
| `color` | `color("tint", "#ff8800")` → `[r,g,b,a]` 0..1 | `// color("tint", "#ff8800")` → `vec4 tint` (straight alpha) | color swatch (alpha) | `vec4` | hex string |
| `ramp` | `ramp("ink", t, "#000000", "#ffffff")` → `[r,g,b,a]` | `// ramp("ink", "#000000", "#ffffff")` → `vec4 ink(float t)` | ramp editor | `color_ramp` | `ColorRampStop[]` |
| `curve` | `curve("falloff", x, 1, 0)` → number | `// curve("falloff", 1, 0)` → `float falloff(float x)` | curve editor | — | `CurvePoint[]` |

Rules, both nodes:

- **The name is a string literal**, never a bare identifier — the existing
  invariant that keeps channel names from colliding with built-ins.
- **Seeds are literals after the name.** `ch` stays positional
  (default, min, max). `pick` takes every string literal. `toggle` takes
  the first `true|false|0|1`. `color` takes the first `"#hex"` (6 or 8
  digits). `ramp` takes every `"#hex"` literal → evenly spaced stops (none
  ⇒ black→white). `curve` takes every numeric literal → evenly spaced
  points when there are ≥ 2 (a single number is ignored, so
  `curve("f", 0.5)` with a literal x doesn't seed; none ⇒ identity 0→1).
  Non-literal args (the runtime `t` / `x` in Point Expression, or
  `60*10`) are skipped, which is what lets one scanner read both the JS
  call form and the GLSL comment form.
- **Sync is add-only and id-stable**, exactly as before: new names mint a
  row with the seeded value; existing rows keep id, wires, and the user's
  edited value — re-seeding by editing the literal never overwrites a
  tuned control. The panel `×` prunes.
- **Reads return the control's value, else the inline seed**, so an
  expression is valid before Sync. Wired sockets win over the row
  (scalar → number, scalar → toggle via `≠ 0`, vec4 → color, color_ramp →
  ramp).
- **GLSL reserves the `u_` prefix** for the template (`u_ramp_<name>` /
  `u_curve_<name>` samplers back the generated lookup functions); a
  channel named `u_…` is skipped, like a name that isn't a GLSL
  identifier. Enum option constants are emitted only for options that
  sanitize to unique identifiers (`"spline anchors"` → `mode_spline_anchors`).

### Engine home: `src/engine/expr-channels.ts`

The scanner, Sync, kind derivation, socket typing, synthesized `ParamDef`
per row (what the panel renders), value normalization (row + wired socket
→ runtime value), the 256×1 LUT builders for ramps/curves, and the
channel-set vetting used by `set_param` all live engine-side (invariant
#1 — the recipe builder and the panel already imported these from the
node file; the node files now re-export). `ExprInput` gains
`kind?: "scalar" | "enum" | "toggle" | "color" | "ramp" | "curve"`;
absent ⇒ `options ? "enum" : "scalar"`, so every saved project reads
unchanged.

### Point Expression

The per-frame env gains `toggle`, `color`, `ramp`, `curve` (they join
`ENV_KEYS`, so the compile prologue destructures them like `ch`/`pick`).
`ramp`/`curve` read a per-frame sampler map (stops sorted once per eval,
tangents cached on the array) and allocate one small array per call —
the same cost class as `fieldAt()`.

### GLSL Expression

Template per kind as in the table. Ramps and curves are uploaded as
256×1 RGBA16F LUTs (LINEAR, CLAMP_TO_EDGE — the pool's default), cached
in node state by value (JSON key), released on change and in `dispose`.
Image inputs stay on texture units 0–3; LUTs take 4… up to 12 channels
(a minimum-spec device has 16 fragment units). A wired `color_ramp`
socket replaces the row's stops the same way a wired scalar replaces a
slider. The `fingerprintExtras` clock rule is unchanged.

## Recipes, MCP, and the agent

- **Address by name everywhere.** `resolveChannelHandle` (`"<id>:in:ink"`)
  and `edit_group expose_param` resolve any *socketed* kind (scalar,
  toggle, color, ramp) — the boundary socket takes the channel's socket
  type, so a ramp channel on a group is a `color_ramp` interface input
  and a color one is `vec4`. `pick`/`curve` stay panel-only and report
  `PARAM_NOT_EXPOSABLE`.
- **`set_param` accepts a channel name as `param`** (both the MCP/agent
  tool and the `edit_group` op). The value is vetted by the row's
  synthesized ParamDef: number / boolean / option / hex / `[{position,
  color, alpha?}]` / `[{x, y}]` (ids minted server-side). This is the
  missing half of the loop — Sync is add-only, so before this the agent's
  only way to *tune* a channel after minting it was to rewrite the code,
  which never changed the value. The channel list itself stays
  non-settable.
- **`get_graph` lists channels** on channelSync nodes: `channels:
  [{name, kind, value, options?}]` (ramp values are stops, curve values are
  points), so a session can read what exists and tune it by name.
- **Descriptions are the teaching surface** (decision 6 of the agent spec:
  the tool set is closed). The two node descriptions (what `get_catalog`
  shows), `RECIPE_CONTRACT`, `set_param` / `edit_group` descriptions in
  `toolbox-tool-defs.mjs` and their `mcp-server.mjs` mirrors, the agent
  host's system prompt, both nodes' default sources, and the Point
  Expression authoring instructions
  (archive/070926_point-expression-prompt.md) all state the kinds, the
  literal-seed rule, and "tune with set_param <channel name>".

## Decisions (made for the owner in an unattended session — revisit freely)

1. **`pick` with ≤ 3 options renders as the segmented pill**, more as a
   dropdown. That IS the "2-way / 3-way toggle" ask without a new syntax;
   `toggle` is the boolean case. No per-row override yet.
2. **No `vec2` kind.** Two `ch()`s cover it; a vec2 row would need a
   third seed grammar. Cheap to add later under the same scanner.
3. **`curve` has no socket** — there is no `float_curve` socket type, and
   inventing one for this is a bigger decision (Map Attribute etc. would
   want it too). Panel-only, like `pick`.
   *Update 2026-09-19:* the socket type now exists
   (091926_float-curve-socket.md — it made every `float_curve` PARAM
   exposable). The `curve()` channel row is still panel-only:
   `channelSocketType` was left returning null so this spec's gate holds;
   giving channel rows a curve socket is the natural follow-up.
4. **Ramp interpolation is linear** on both sides (the wire drops `interp`
   anyway — see `ColorRampValue` in types.ts). `constant`/`ease` would be
   a per-row option later.
5. **Channel values are not keyframable** (unchanged from `ch`). The
   virtual-key pattern (`ramp_c:<param>:<stop>`) would extend to rows;
   deferred until someone needs it — wiring an LFO into the socket is the
   supported way to animate a channel today.
6. **Colors carry alpha** (8-digit hex accepted, `ParamDef.alpha: true` on
   the synthesized row) — the GLSL uniform is a straight-alpha vec4 and
   the JS read is `[r,g,b,a]`, so there's no parse path to break.

## Milestones

- **M1 (built 2026-09-04):** engine module + `ExprInput.kind`; Point
  Expression env reads; GLSL template/uniforms/LUTs; panel rows; recipe
  name resolution + expose + `set_param` by channel name + `get_graph`
  channels; tool/prompt/doc text; `scripts/check-expression-channels.mts`
  in `npm run check`.
- **M2 (open):** per-row keyframing via virtual keys; `vec2` kind;
  per-ramp `interp`; live-viewer controls for channels exposed on a
  group boundary of non-scalar type (verify `color_ramp`/`vec4` boundary
  sockets surface as controls in exported apps).
