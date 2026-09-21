# Float-curve socket + custom Scene Time easing

*2026-09-19. Shipped with Scene Time's Step Duration rework.*

## Ask

Drive Scene Time's easing from the graph: draw it in a Float Curve node or
write it as a formula in an Expression node, instead of picking from the
named list. "Expose the Easing as an input socket."

## What existed

- `engine/float-curve.ts` — `CurvePoint[]` (x, y ∈ [0,1]), monotone cubic
  sampler, `sanitizeFloatCurve`.
- `ParamType "float_curve"` with `FloatCurveEditor` / `FloatCurveControl`
  in the panel and on the Float Curve node body; eleven params across nine
  nodes use it (Float Curve, Map Attribute, Stroke ×3, Taper Spline, Grain,
  Repeat Path, Bevel, Shade, Diffusion Curves).
- **No `float_curve` SocketType.** 090426_expression-channel-kinds.md
  decision 3 deferred it ("Map Attribute etc. would want it too").

## Decision

Add the socket type, in the exact mould of `color_ramp`: a plain CPU
descriptor `FloatCurveValue { kind: "float_curve"; points: CurvePoint[] }`,
mapped by `paramSocketType` so every `float_curve` param becomes
exposable, and unwrapped by `socketToParamRaw` to the bare array the param
type already stores — so no consumer changes.

Scene Time gets no new socket on its body. Its two easing enums gain a
`custom` option that routes the ramp through a new `easing_curve`
float_curve param; exposing that param IS the socket. This keeps the app's
one expose idiom (dashed square handle, dimmed "driven" control) and gives
a panel-editable custom easing for free.

Alternatives rejected: reusing `scalar_field` (a per-pixel GLSL AST, no
CPU evaluator, canvas-space); a closure-valued socket (Element's lifetime
contract, and Expression is `stable: true`); a `BezierEasing` socket (four
numbers, overshoot-capable, but not what the Float Curve node authors).

## Ripple (devguide invariant 7, walked)

| site | change |
|---|---|
| `engine/types.ts` | `"float_curve"` in `SocketType`; `FloatCurveValue` in `SocketValue` |
| `engine/graph-helpers.ts` `paramSocketType` | `float_curve → float_curve` |
| `engine/evaluator.ts` `socketToParamRaw` | returns `sv.points` |
| `engine/coerce.ts` / `coercible` | identity only — no coercions |
| `components/effects/socketColor.ts` | rose-gold pair; `npm run gen:theme-css` |
| `engine/clips.ts` `emptyClipOutput` | identity ramp off-clip |
| `engine/groups.ts` `socketValueFromGroupDefault` | wraps a stored array |
| `nodes/effect/switch.ts` `TYPES` | added (and `color_ramp`, which was missing) |
| `engine/time-offset.ts` carried types | added (plain descriptor) |
| `components/effects/NodeInspectorPopup.tsx` | "curve · N pts" summary |
| `components/effects/EffectNode.tsx` | Float Curve's on-node editor read-only while its `curve` param is wired |

Not touched: `SETTABLE_PARAM_TYPES` (MCP `set_param` still cannot write a
curve), `SocketPeekPopover` (no curve plot yet), `expr-channels.ts`
`channelSocketType` (Point / GLSL Expression `curve()` rows stay
panel-only; `check-expression-channels` asserts it).

## Producers

- **Float Curve node** — new `curve` aux output (`float_curve`): the
  authored curve itself, sanitized. Primary stays the sampled scalar.
- **Expression node** — new `out_type: curve`. The source is evaluated 65
  times with the new global `u` swept 0→1 (`CURVE_SAMPLES = 64`), y clamped
  to [0,1], fixed point ids `cu-<i>`. Input variables bind as usual, so
  `pow(u, k)` with `k` wired is a live easing family. A compile/runtime
  error or empty source emits the identity ramp (the neutral easing), not
  a flat zero. `u` is 0 in the value modes. Naming an input `u` is a
  compile error, same as naming one `t` today.

## Consumer: Scene Time

- `easing` / `pingpong_easing` options = `EASING_OPTIONS + "custom"`
  (`CUSTOM_EASING`). The Text animators share `EASING_OPTIONS` unchanged.
- `easing_curve` (float_curve, default identity ramp) is visible when the
  live mode's enum is `custom`, and always while exposed (panel rule).
- `easeRamp`: named → `applyEasing`; custom → clamp t, sample the curve,
  blend with `ease_intensity` exactly like the named path.
- Sanitized curves are memoized by raw-array identity so the sampler's
  tangent cache holds across frames.

## Limits

- The float-curve model is clamped to the unit square and monotone between
  points: a custom curve cannot overshoot. back / elastic / bounce remain
  enum-only.
- The on-node Float Curve editor shows the STORED curve dimmed while wired,
  not the wired one — same as the on-node ramp.

## Gates

`scripts/check-float-curve-socket.mts` (plumbing, both producers, the
validator, and a real evaluator run Float Curve → Scene Time and Expression
→ Scene Time) and `scripts/check-scene-time.mts` (custom easing math).
Live-app verification was not run in the authoring session.
