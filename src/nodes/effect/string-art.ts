import type {
  NodeDefinition,
  PointsValue,
  SplineSubpath,
  SplineValue,
} from "@/engine/types";
import { ensurePointArray, pointsFromArray } from "@/engine/points";

// Times-table string art: connect ordered point i to point (i·k + offset)
// mod N with a straight chord. The classic "multiplication on a circle"
// construction — connecting i → 2i on N points draws a cardioid, 3i a
// nephroid, and so on; the line *envelopes* are the visible curve. Feed
// evenly-spaced points (Points on Path around a circle / rectangle) in,
// get the chord set out.
//
// This is deliberately separate from Connect Points: that node joins by
// PROXIMITY (every pair within a distance), which is the wrong topology for
// string art — here the connection is an INDEX rule, independent of where
// the points sit. Keeping them separate leaves both nodes' contracts clean.
//
// Classification: Spline → Generator (points in, spline out). Pure CPU.
// A passthrough `points` aux keeps the source points on the same wire,
// mirroring Connect Points.

// Build chords i → (i·k + offset) mod N for a given multiplier, tagging
// each with `group` so a second layer is distinguishable downstream
// (Copy to Points variant pick, or a Spline Intersections pass that wants
// to treat the two layers as separate subpath sets).
function addChords(
  pts: PointsValue["points"],
  k: number,
  offset: number,
  group: number,
  out: SplineSubpath[]
): void {
  const N = pts.length;
  if (N < 2 || k < 1) return;
  for (let i = 0; i < N; i++) {
    const j = (((i * k + offset) % N) + N) % N;
    if (j === i) continue; // zero-length chord — skip
    const a = pts[i];
    const b = pts[j];
    out.push({
      closed: false,
      anchors: [{ pos: [a.pos[0], a.pos[1]] }, { pos: [b.pos[0], b.pos[1]] }],
      groupIndex: group,
    });
  }
}

export const stringArtNode: NodeDefinition = {
  type: "string-art",
  name: "String Art",
  category: "spline",
  subcategory: "generator",
  description:
    "Times-table string art: connect ordered point i to point (i·k + offset) mod N with a straight chord. Connecting i → 2i around a circle draws a cardioid, 3i a nephroid, etc. — the line envelopes are the curve. Feed evenly-spaced points (e.g. Points on Path around a circle or rectangle). Optional second layer with its own multiplier. Pairs with Spline Intersections to mark the chord crossings.",
  backend: "webgl2",
  inputs: [{ name: "points", type: "points", required: true }],
  params: [
    {
      name: "k",
      label: "Multiplier k",
      type: "scalar",
      min: 2,
      max: 200,
      softMax: 60,
      step: 1,
      default: 2,
    },
    {
      // Rotates which partner each point connects to — shifts the whole
      // envelope around the figure.
      name: "offset",
      label: "Offset",
      type: "scalar",
      min: 0,
      max: 200,
      step: 1,
      default: 0,
    },
    {
      name: "layer2",
      label: "Second layer",
      type: "boolean",
      default: false,
    },
    {
      name: "k2",
      label: "Multiplier k₂",
      type: "scalar",
      min: 2,
      max: 200,
      softMax: 60,
      step: 1,
      default: 5,
      visibleIf: (p) => !!p.layer2,
    },
  ],
  primaryOutput: "spline",
  auxOutputs: [{ name: "points", type: "points" }],

  compute({ inputs, params }) {
    const src = inputs.points;
    const pts =
      src?.kind === "points" ? ensurePointArray(src) : [];

    const k = Math.max(1, Math.floor((params.k as number) ?? 2));
    const offset = Math.floor((params.offset as number) ?? 0);
    const layer2 = !!params.layer2;
    const k2 = Math.max(1, Math.floor((params.k2 as number) ?? 5));

    const subpaths: SplineSubpath[] = [];
    addChords(pts, k, offset, 0, subpaths);
    if (layer2) addChords(pts, k2, offset, 1, subpaths);

    const spline: SplineValue = { kind: "spline", subpaths };
    // Pass the source points through untouched so a downstream node can
    // consume both the chords and the original ring without a re-wire.
    const passthrough: PointsValue =
      src?.kind === "points" ? src : pointsFromArray([]);
    return { primary: spline, aux: { points: passthrough } };
  },
};
