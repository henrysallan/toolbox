import type { NodeDefinition, ScalarValue, Vec2Value } from "@/engine/types";
import { measureSpline, sampleSplineAt } from "@/engine/spline-math";

// Sample a spline at arc-length parameter t ∈ [0,1]. The primary output is
// the position (vec2); aux outputs are the unit tangent (vec2) and its
// direction as an `angle` / `normalAngle` scalar (RADIANS). Measured
// by ARC LENGTH across the concatenation of all subpaths — so a multi-
// subpath SVG animates evenly along its total painted distance rather than
// snapping segment boundaries.
//
// The angle outputs exist so a single object can *orient along the path*:
// wire `angle` (or `normalAngle`) straight into Copy-to-Points' "Rotate +
// (uniform)" input (also radians) or a Point.rotation-consuming node. Since
// they come from the SAME sample as the position, position and rotation
// stay in sync as `t` animates. (Transform's `rotate` param is in degrees —
// convert with Math ▸ To Degrees if you drive that instead.)
//
// `t` is a regular param (0..1) that the user can expose as a scalar socket
// if they want to drive it from Scene Time or another node — standard
// exposed-param pattern; the evaluator overrides the stored value with the
// incoming socket value when an edge is attached.

// Fold a raw t into [0,1] per the wrap mode. `clamp` is the classic
// hold-at-endpoint behavior; `loop` is fract() (so t=1 → 0 for a seamless
// repeat); `ping-pong` bounces 0→1→0. Handles negative t too (e.g. a
// socket driving below 0), so the loop stays continuous in both directions.
function wrapParam(raw: number, mode: string): number {
  if (mode === "loop") {
    return raw - Math.floor(raw);
  }
  if (mode === "ping-pong") {
    const m = raw - 2 * Math.floor(raw / 2); // raw mod 2, always in [0,2)
    return m <= 1 ? m : 2 - m;
  }
  return Math.max(0, Math.min(1, raw)); // clamp (default)
}

export const sampleAlongPathNode: NodeDefinition = {
  type: "sample-along-path",
  name: "Sample Along Path",
  category: "spline",
  subcategory: "modifier",
  description:
    "Output the position, tangent, and orientation angle at a given arc-length t ∈ [0,1] along a spline. Expose `t` as a socket to animate along the path; set Past ends to loop/ping-pong so `t` past 1 repeats. Wire `angle` (radians, tangent direction) or `normalAngle` (perpendicular) into a rotation input to orient an object along the path.",
  backend: "webgl2",
  inputs: [{ name: "path", type: "spline", required: true }],
  params: [
    {
      name: "t",
      label: "t",
      type: "scalar",
      min: 0,
      // Slider runs 0→2 so you can scrub past the end and watch `wrap`
      // fold it back; one full lap is 0→1. Driving `t` from Scene Time /
      // an LFO past 1 loops too (the node no longer clamps to 1 unless
      // wrap = clamp).
      max: 2,
      step: 0.001,
      default: 0,
    },
    {
      // What happens once `t` leaves [0,1]. `clamp` = hold at the nearest
      // endpoint (the original behavior — kept as default for back-compat
      // and for hold-at-end / overshoot-easing use). `loop` = fract, wraps
      // 1→0 for a seamless repeat (best on closed paths). `ping-pong` =
      // bounce back toward 0.
      name: "wrap",
      label: "Past ends",
      type: "enum",
      options: ["clamp", "loop", "ping-pong"],
      control: "segmented",
      default: "clamp",
    },
  ],
  primaryOutput: "vec2",
  auxOutputs: [
    { name: "tangent", type: "vec2" },
    { name: "angle", type: "scalar" },
    { name: "normalAngle", type: "scalar" },
  ],

  compute({ inputs, params }) {
    const src = inputs.path;
    if (!src || src.kind !== "spline") {
      const zero: Vec2Value = { kind: "vec2", value: [0, 0] };
      const zeroAngle: ScalarValue = { kind: "scalar", value: 0 };
      return {
        primary: zero,
        aux: { tangent: zero, angle: zeroAngle, normalAngle: zeroAngle },
      };
    }
    const lengths = measureSpline(src);
    const t = wrapParam((params.t as number) ?? 0, (params.wrap as string) ?? "clamp");
    const sample = sampleSplineAt(src, lengths, t);
    // Tangent is a unit vec2 in normalized Y-DOWN space, so atan2(ty, tx)
    // is the on-canvas angle that orients a shape's +X axis along the
    // direction of travel. Normal is +90°. Both in radians.
    const angle = Math.atan2(sample.tangent[1], sample.tangent[0]);
    return {
      primary: { kind: "vec2", value: sample.pos } satisfies Vec2Value,
      aux: {
        tangent: { kind: "vec2", value: sample.tangent } satisfies Vec2Value,
        angle: { kind: "scalar", value: angle } satisfies ScalarValue,
        normalAngle: {
          kind: "scalar",
          value: angle + Math.PI / 2,
        } satisfies ScalarValue,
      },
    };
  },
};
