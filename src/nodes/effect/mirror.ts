import type {
  InputSocketDef,
  NodeDefinition,
  Point,
  SocketType,
  SplineAnchor,
  SplineSubpath,
  SplineValue,
} from "@/engine/types";
import { ensurePointArray, pointsFromArray } from "@/engine/points";

// Duplicate CPU geometry under a symmetry: reflect across the X / Y axis
// (or both), or repeat radially around a center with a count slider.
// Spline / points only — the `source` socket retypes itself (and the
// output) from whatever is wired in via resolveInputs + connectedTypes,
// same mode-less pattern as Transform / Displace (registered in
// EffectsApp's CONNECTED_TYPE_RETYPE_NODES; editorCanCoerce lets a
// points wire land on the spline-resting socket).
//
// Each copy is a pre-reflection (flipX / flipY about the center line)
// followed by a rotation about the center. Axis reflections and the 180°
// copy are axis-aligned, so they're aspect-free; radial rotations run in
// pixel-isotropic space (dy scaled by 1/aspect, rotated, scaled back) so
// copies stay rigid on non-square canvases instead of shearing. Spec:
// specdocs/072026_mirror-node.md.

interface CopyOp {
  flipX: boolean;
  flipY: boolean;
  angle: number; // radians, about the center, applied after the flips
  cos: number;
  sin: number;
}

function makeOp(flipX: boolean, flipY: boolean, angle: number): CopyOp {
  return { flipX, flipY, angle, cos: Math.cos(angle), sin: Math.sin(angle) };
}

function buildOps(
  mode: string,
  count: number,
  kaleidoscope: boolean,
  includeSource: boolean
): CopyOp[] {
  const ops: CopyOp[] = [];
  if (mode === "radial") {
    for (let k = 0; k < count; k++) {
      const angle = (k * Math.PI * 2) / count;
      ops.push(makeOp(false, false, angle));
      // Kaleidoscope: a mirrored copy per wedge (reflect across the
      // horizontal line through the center, then rotate with the wedge)
      // — the dihedral group D_count, mirror lines on wedge boundaries.
      if (kaleidoscope) ops.push(makeOp(false, true, angle));
    }
    return ops;
  }
  if (includeSource) ops.push(makeOp(false, false, 0));
  // "x" reads as mirror left↔right → reflect across the VERTICAL line.
  if (mode === "x" || mode === "both") ops.push(makeOp(true, false, 0));
  if (mode === "y" || mode === "both") ops.push(makeOp(false, true, 0));
  // Both flips compose to the 180° point reflection — the fourth quadrant.
  if (mode === "both") ops.push(makeOp(true, true, 0));
  return ops;
}

export const mirrorNode: NodeDefinition = {
  type: "mirror",
  name: "Mirror",
  category: "utility",
  description:
    "Mirror a spline or points across the X / Y axis (or both), or repeat them radially around a center with a count slider — with an optional kaleidoscope reflection per wedge. Copies can tag groupIndex per copy for ramp-by-group fills or Group Pick downstream.",
  backend: "webgl2",
  noMaskInput: true,
  // Resting type is spline; retypes to points from the connected wire.
  inputs: [{ name: "source", type: "spline", required: true }],
  resolveInputs(params, ctx): InputSocketDef[] {
    const pts = ctx?.connectedTypes?.source === "points";
    return [
      {
        name: "source",
        label: pts ? "Points" : "Spline",
        type: pts ? "points" : "spline",
        required: true,
      },
    ];
  },
  params: [
    {
      name: "mode",
      label: "Mode",
      type: "enum",
      options: ["x", "y", "both", "radial"],
      control: "segmented",
      default: "x",
    },
    {
      name: "centerX",
      label: "Center X",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.001,
      default: 0.5,
      visibleIf: (p) => p.mode !== "y",
    },
    {
      name: "centerY",
      label: "Center Y",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.001,
      default: 0.5,
      visibleIf: (p) => p.mode !== "x",
    },
    {
      name: "count",
      label: "Count",
      type: "scalar",
      min: 1,
      max: 64,
      softMax: 24,
      step: 1,
      default: 6,
      visibleIf: (p) => p.mode === "radial",
    },
    {
      name: "kaleidoscope",
      label: "Kaleidoscope",
      type: "boolean",
      default: false,
      visibleIf: (p) => p.mode === "radial",
    },
    {
      // Off = only the reflected copies. Transform can't fake a pure
      // reflection (its scale is clamped positive), so this is the one
      // way to get just the mirror image.
      name: "includeSource",
      label: "Keep source",
      type: "boolean",
      default: true,
      visibleIf: (p) => p.mode !== "radial",
    },
    {
      // groupIndex = copy index on every emitted subpath / point
      // (otherwise incoming groupIndex is preserved) — same convention
      // as Repeat Path's per-ring tags.
      name: "tagGroups",
      label: "Group per copy",
      type: "boolean",
      default: false,
    },
  ],
  primaryOutput: "spline",
  resolvePrimaryOutput(params, ctx): SocketType {
    return ctx?.connectedTypes?.source === "points" ? "points" : "spline";
  },
  auxOutputs: [],

  compute({ inputs, params, ctx }) {
    const src = inputs.source;
    const mode = (params.mode as string) ?? "x";
    const cx = (params.centerX as number) ?? 0.5;
    const cy = (params.centerY as number) ?? 0.5;
    const count = Math.max(1, Math.floor((params.count as number) ?? 6));
    const kaleidoscope = params.kaleidoscope === true;
    const includeSource = params.includeSource !== false;
    const tagGroups = params.tagGroups === true;
    const aspect = ctx.width / Math.max(1, ctx.height);

    const ops = buildOps(mode, count, kaleidoscope, includeSource);

    const mapPos = (
      x: number,
      y: number,
      op: CopyOp
    ): [number, number] => {
      let dx = x - cx;
      let dy = y - cy;
      if (op.flipX) dx = -dx;
      if (op.flipY) dy = -dy;
      if (op.angle !== 0) {
        // Rotate in pixel-isotropic space so radial copies stay rigid
        // on non-square canvases.
        const iy = dy / aspect;
        const rx = op.cos * dx - op.sin * iy;
        const ry = op.sin * dx + op.cos * iy;
        dx = rx;
        dy = ry * aspect;
      }
      return [cx + dx, cy + dy];
    };
    // Handles are deltas — flip/rotate, never translate.
    const mapDelta = (
      d: [number, number],
      op: CopyOp
    ): [number, number] => {
      let dx = op.flipX ? -d[0] : d[0];
      let dy = op.flipY ? -d[1] : d[1];
      if (op.angle !== 0) {
        const iy = dy / aspect;
        const rx = op.cos * dx - op.sin * iy;
        const ry = op.sin * dx + op.cos * iy;
        dx = rx;
        dy = ry * aspect;
      }
      return [dx, dy];
    };

    if (src?.kind === "points") {
      const pts = ensurePointArray(src);
      const out: Point[] = [];
      ops.forEach((op, copyIdx) => {
        for (const p of pts) {
          const pos = mapPos(p.pos[0], p.pos[1], op);
          // A single flip is orientation-reversing — no rotation +
          // positive scale can represent it, so the point's frame
          // mirrors: rotation negates and the flipped axis's scale
          // negates (M·R(θ) = R(−θ)·diag(−1,1) for an X flip), so
          // Copy-to-Points stamps genuinely mirrored instances. Two
          // flips compose to a pure 180° rotation.
          const theta = p.rotation ?? 0;
          let rot: number;
          let sx = p.scale?.[0] ?? 1;
          let sy = p.scale?.[1] ?? 1;
          if (op.flipX && op.flipY) {
            rot = theta + Math.PI;
          } else if (op.flipX) {
            rot = -theta;
            sx = -sx;
          } else if (op.flipY) {
            rot = -theta;
            sy = -sy;
          } else {
            rot = theta;
          }
          out.push({
            pos,
            rotation: rot + op.angle,
            scale: [sx, sy],
            groupIndex: tagGroups ? copyIdx : p.groupIndex,
          });
        }
      });
      return { primary: pointsFromArray(out) };
    }

    if (src?.kind === "spline") {
      const subpaths: SplineSubpath[] = [];
      ops.forEach((op, copyIdx) => {
        for (const sub of src.subpaths) {
          const anchors = sub.anchors.map((a) => {
            const na: SplineAnchor = { pos: mapPos(a.pos[0], a.pos[1], op) };
            if (a.inHandle) na.inHandle = mapDelta(a.inHandle, op);
            if (a.outHandle) na.outHandle = mapDelta(a.outHandle, op);
            return na;
          });
          subpaths.push({
            closed: sub.closed,
            anchors,
            groupIndex: tagGroups ? copyIdx : sub.groupIndex,
          });
        }
      });
      const out: SplineValue = { kind: "spline", subpaths };
      return { primary: out };
    }

    // Nothing wired (the evaluator has already coerced any wired value
    // to the resolved socket type): emit an empty spline.
    const empty: SplineValue = { kind: "spline", subpaths: [] };
    return { primary: empty };
  },
};
