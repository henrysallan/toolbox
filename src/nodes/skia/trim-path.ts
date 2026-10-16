import type { NodeDefinition } from "@/engine/types";
import { bindDerived, bindParam, type Bind, type BindRef, type PathEffectIR, type SkiaNode } from "@/engine/skia/scene-ir";
import { SPLINE_TRIM_PARAMS } from "../source/spline-raster-aux";
import { TRIM_MEASURES } from "@/engine/spline-trim";
import { copyShape, geomSubpaths, modifyDrawing, num, subpathsToD, toolboxContour, type ShapeNode } from "./paint-shared";

// Trim Path (Skia) — the Skia-layer mirror of Trim Path over a drawing:
// every shape in it gets React Native Skia's <Path start end>, the IR's
// `trim` effect (which Skia applies to the geometry before stroke, fill
// type and every other path effect).
//
// The window math is trimSubpaths' (engine/spline-trim.ts): start / end
// clamp to 0..1, `offset` wraps mod 1 and slides the window, and a window
// that runs past the end continues from the start. React Native's trim
// takes ONE interval, so each shape is drawn twice — once for [lo, min(hi,
// 1)], once for the wrapped remainder [0, hi − 1] (empty, and free, when
// nothing wraps). Always both, so an animated offset never changes the
// scene's structure. Where the window wraps on a closed loop Trim Path
// stitches one continuous piece; here the two pieces meet at the path's
// start, each with its own caps (invisible with butt caps; with
// translucent round caps the overlap shows).
//
//   combined     one length domain over all of a shape's contours (Skia's
//                trim measures the whole path, like Trim Path's default)
//   per subpath  each contour its own 0..1 domain: the shape is split into
//                one shape per contour (an export needs the contour count
//                to hold still).
//
// Arc length: Skia measures its contours (SkContourMeasure: curves
// subdivided until their control points sit within 0.5 px of the chord's
// thirds, length mapped linearly inside each piece) and cuts at that arc
// length, as Trim Path does with measure=arc length (cubic-arc-length.ts,
// exact). They agree to Skia's tolerance: ≤ 0.3 px on the degenerate-cubic
// edges splineToSvgPathD writes for handle-less segments at 512 px, 0.0005
// px once those are lines (check-skia-paint). `measure` mirrors Trim Path's
// param. RN's trim has
// no way to say Trim Path's original `segment` measure (a cut that drifts
// along each segment's curve parameter, spline-trim.ts), so segment is
// refused with a reason and the shapes are trimmed by arc length. Unlike
// Trim Path, an absent `measure` here is arc length: this node has always
// trimmed that way.

const EMPTY = 1e-9;

export function skiaTrimMeasureProblem(nodeId: string, params: Record<string, unknown>): string | null {
  if (params.measure !== "segment") return null;
  return `Trim Path (Skia) "${nodeId}": measure "segment" has no React Native Skia equivalent — <Path start end> cuts by arc length, and segment's cut drifts along each segment's curve parameter. Trimmed by arc length; set measure to arc length (re-time the trim if it was matched to a segment-measure Trim Path), or trim with Trim Path before Skia Shape.`;
}

// [lo, hi] of trimSubpaths, as two drawable intervals (a, b).
export function trimWindows(start: number, end: number, offset: number): { a: [number, number]; b: [number, number]; plain: boolean } {
  const s = Math.min(1, Math.max(0, Number.isFinite(start) ? start : 0));
  const e = Math.min(1, Math.max(0, Number.isFinite(end) ? end : 1));
  if (s <= 0 && e >= 1) return { a: [0, 1], b: [0, 0], plain: s === start && e === end };
  if (e - s <= EMPTY) return { a: [0, 0], b: [0, 0], plain: false };
  const oRaw = Number.isFinite(offset) ? offset : 0;
  let o = oRaw - Math.floor(oRaw);
  if (o <= EMPTY || o >= 1 - EMPTY) o = 0;
  if (o === 0) return { a: [s, e], b: [0, 0], plain: s === start && e === end };
  let lo = s + o;
  if (lo >= 1) lo -= 1;
  const hi = lo + (e - s);
  if (hi <= 1) return { a: [lo, hi], b: [0, 0], plain: false };
  return { a: [lo, 1], b: [0, hi - 1 > EMPTY ? hi - 1 : 0], plain: false };
}

export const skiaTrimPathNode: NodeDefinition = {
  type: "skia-trim-path",
  name: "Trim Path (Skia)",
  category: "spline",
  subcategory: "modifier",
  description:
    "Reveals only part of every shape in a Skia drawing by arc length (React Native Skia <Path start end>), with Trim Path's start / end / offset. Offset wraps; Combined measures each shape's contours as one length, Per subpath gives every contour its own 0–1. Measure is arc length only: Trim Path's older segment measure has no React Native form and is refused.",
  searchAliases: ["skia", "trim", "trim paths", "draw on", "reveal", "react native"],
  facts: {
    gotchas: [
      "trim_start/trim_end/trim_offset are arc-length fractions (0-1) from each shape's start; circles and ovals are redrawn as toolbox's circle (top, clockwise), like Circle.",
      "Cuts at the exact arc length, like Trim Path with measure=arc length (to Skia's ~0.5 px contour tolerance); measure=segment is refused (no RN form) and trimmed by arc length.",
      "Each shape draws twice (window + wrapped remainder): React Native's trim takes one interval. The remainder is empty unless offset pushes the window past the end.",
      "A non-zero offset exports the windows as per-frame samples; an offset keyed from exactly 0 does too, with an export warning.",
      "mode=per subpath splits each shape into one shape per contour; an export then needs the contour count to stay constant.",
    ],
  },
  backend: "webgl2",
  skia: { class: "native", mirrors: "trim-path" },
  noMaskInput: true,
  inputs: [{ name: "drawing", label: "Drawing", type: "skia_draw", required: true }],
  params: [
    {
      name: "mode",
      label: "Mode",
      type: "enum",
      options: ["combined", "per subpath"],
      default: "combined",
      control: "segmented",
    },
    {
      name: "measure",
      label: "Measure",
      type: "enum",
      options: [...TRIM_MEASURES],
      default: "arc length",
      control: "segmented",
    },
    ...SPLINE_TRIM_PARAMS,
  ],
  primaryOutput: "skia_draw",
  auxOutputs: [],

  compute({ inputs, params, nodeId }) {
    const start = num(params.trim_start, 0);
    const end = num(params.trim_end, 1);
    const offset = num(params.trim_offset, 0);
    const w = trimWindows(start, end, offset);
    const deps: BindRef[] = ["trim_start", "trim_end", "trim_offset"].map((param) => ({ node: nodeId, param }));
    const derived = (v: number): Bind<number> => bindDerived(v, deps);
    // A plain window [start, end] reads the params straight (tracks); any
    // clamp, offset or emptiness makes it derived (sampled when animated).
    const a: [Bind<number>, Bind<number>] = w.plain
      ? [bindParam(w.a[0], nodeId, "trim_start"), bindParam(w.a[1], nodeId, "trim_end")]
      : [derived(w.a[0]), derived(w.a[1])];
    const b: [Bind<number>, Bind<number>] = [derived(w.b[0]), derived(w.b[1])];
    const problems: string[] = [];
    const measureProblem = skiaTrimMeasureProblem(nodeId, params);
    if (measureProblem) problems.push(measureProblem);

    // Trims go after the shape's own trims (they compose by length
    // fraction) and ahead of its other effects (Skia trims first anyway).
    const withTrim = (s: ShapeNode, t: [Bind<number>, Bind<number>]): ShapeNode => {
      const c = copyShape(s);
      const fx = c.paint.pathEffects ?? [];
      const lead = fx.findIndex((e) => e.k !== "trim");
      const at = lead < 0 ? fx.length : lead;
      const trim: PathEffectIR = { k: "trim", start: t[0], end: t[1] };
      c.paint.pathEffects = [...fx.slice(0, at), trim, ...fx.slice(at)];
      return c;
    };
    const pair = (s: ShapeNode): SkiaNode => ({ k: "group", id: nodeId, children: [withTrim(s, a), withTrim(s, b)] });

    const perSubpath = params.mode === "per subpath";
    const out = modifyDrawing(
      inputs.drawing,
      nodeId,
      (shape) => {
        const s = toolboxContour(shape);
        if (!perSubpath) return pair(s);
        const g = geomSubpaths(s.geom);
        if (!g) return pair(s); // one contour already (circle, oval, rounded rect)
        if ("problem" in g) {
          problems.push(`Trim Path (Skia) "${nodeId}": ${g.problem}; trimmed as one path.`);
          return pair(s);
        }
        return {
          k: "group",
          id: nodeId,
          children: g.subpaths.map((sub) =>
            pair({
              ...s,
              geom: { k: "path", d: bindDerived(subpathsToD([sub]), []), ...(g.fillType ? { fillType: g.fillType } : {}) },
            })
          ),
        };
      },
      problems
    );
    return { primary: out };
  },
};
