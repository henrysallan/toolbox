import type {
  InputSocketDef,
  NodeDefinition,
  PointsValue,
  SocketType,
  SplineAnchor,
  SplineSubpath,
  SplineValue,
} from "@/engine/types";
import {
  EMPTY_POINTS,
  gatherPoints,
  getRotation,
  getScaleX,
  getScaleY,
} from "@/engine/points";
import {
  clipSplineByHalfPlane,
  halfplaneAxis,
  isHalfplaneKeep,
  onKeepSide,
  onMirrorPlane,
  type HalfplaneKeep,
} from "@/engine/spline-halfplane";

// Duplicate under a symmetry: reflect across the X / Y axis (or both),
// or repeat radially around a center with a count slider.
// mode=bisect clips to a half-plane (keep = X / −X / Y / −Y) then
// mirrors the remainder — same axis flip as x/y, after the cut.
//
// Polymorphic source: spline / points run on CPU; an image (or mask,
// coerced to image) inverse-samples the same copy list in a fullscreen
// pass and source-overs the hits. The `source` socket retypes itself
// (and the output) from whatever is wired in via resolveInputs +
// connectedTypes, same mode-less pattern as Transform / Displace
// (registered in EffectsApp's CONNECTED_TYPE_RETYPE_NODES). Resting
// type is image so an image wire lands via the plain coercible table;
// editorCanCoerce lets a spline / points wire land on that socket.
//
// Each copy is a pre-reflection (flipX / flipY about the center line)
// followed by a rotation about the center. Axis reflections and the 180°
// copy are axis-aligned, so they're aspect-free; radial rotations run in
// pixel-isotropic space (dy scaled by 1/aspect, rotated, scaled back) so
// copies stay rigid on non-square canvases instead of shearing. Spec:
// specdocs/archive/072026_mirror-node.md.

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

export const MIRROR_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_src;
uniform vec2 u_center;     // canvas01, Y-down
uniform float u_aspect;    // width / height
uniform int u_mode;       // 0=x 1=y 2=both 3=radial 4=bisect
uniform int u_keep;       // 0=x 1=-x 2=y 3=-y
uniform int u_count;
uniform int u_kaleidoscope;
uniform int u_includeSource;
out vec4 outColor;

vec4 over(vec4 s, vec4 d) {
  float oa = s.a + d.a * (1.0 - s.a);
  vec3 oc = oa < 1e-4
    ? vec3(0.0)
    : (s.rgb * s.a + d.rgb * d.a * (1.0 - s.a)) / oa;
  return vec4(oc, oa);
}

vec2 toCanvas(vec2 uv) {
  return vec2(uv.x, 0.5 + (0.5 - uv.y) / max(u_aspect, 1e-6));
}

vec2 toUv(vec2 p) {
  return vec2(p.x, 0.5 - (p.y - 0.5) * u_aspect);
}

bool onKeep(vec2 src) {
  if (u_keep == 0) return src.x >= u_center.x;
  if (u_keep == 1) return src.x <= u_center.x;
  if (u_keep == 2) return src.y >= u_center.y;
  return src.y <= u_center.y;
}

void accum(inout vec4 acc, vec2 p, int flipX, int flipY, float angle) {
  vec2 d = p - u_center;
  if (angle != 0.0) {
    float iy = d.y / max(u_aspect, 1e-6);
    float cs = cos(angle);
    float sn = sin(angle);
    float rx = cs * d.x + sn * iy;
    float ry = -sn * d.x + cs * iy;
    d = vec2(rx, ry * u_aspect);
  }
  if (flipX == 1) d.x = -d.x;
  if (flipY == 1) d.y = -d.y;
  vec2 src = u_center + d;
  if (u_mode == 4 && !onKeep(src)) return;
  vec2 uv = toUv(src);
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) return;
  acc = over(texture(u_src, uv), acc);
}

void main() {
  vec2 p = toCanvas(v_uv);
  vec4 acc = vec4(0.0);
  int axis = u_mode;
  if (u_mode == 4) axis = (u_keep == 2 || u_keep == 3) ? 1 : 0;
  if (u_mode == 3) {
    int n = max(u_count, 1);
    for (int k = 0; k < 64; k++) {
      if (k >= n) break;
      float ang = float(k) * 6.283185307179586 / float(n);
      accum(acc, p, 0, 0, ang);
      if (u_kaleidoscope == 1) accum(acc, p, 0, 1, ang);
    }
  } else {
    if (u_includeSource == 1) accum(acc, p, 0, 0, 0.0);
    if (axis == 0 || axis == 2) accum(acc, p, 1, 0, 0.0);
    if (axis == 1 || axis == 2) accum(acc, p, 0, 1, 0.0);
    if (axis == 2) accum(acc, p, 1, 1, 0.0);
  }
  outColor = acc;
}`;

function sourceKind(
  t: SocketType | undefined
): "image" | "spline" | "points" {
  if (t === "points") return "points";
  if (t === "spline") return "spline";
  // image, mask, or unwired — rest as image so an image wire is an exact
  // match (Transform / Displace / Bounding Box). A spline default would
  // drop a wired image at coerceValue (no image→spline row).
  return "image";
}

function clipPointsByHalfPlane(
  src: PointsValue,
  keep: HalfplaneKeep,
  cx: number,
  cy: number
): PointsValue {
  const n = src.count;
  const map = new Int32Array(n);
  let w = 0;
  for (let i = 0; i < n; i++) {
    if (onKeepSide(src.positions[i * 2], src.positions[i * 2 + 1], keep, cx, cy)) {
      map[w++] = i;
    }
  }
  if (w === 0) return EMPTY_POINTS;
  if (w === n) return src;
  return gatherPoints(src, map, w);
}

export const mirrorNode: NodeDefinition = {
  type: "mirror",
  name: "Mirror",
  category: "utility",
  description:
    "Mirror an image, spline, or points across the X / Y axis (or both), or repeat them radially around a center with a count slider — with an optional kaleidoscope reflection per wedge. Bisect cuts the input to one half-plane (X / −X / Y / −Y) before mirroring, so only the kept side is reflected. Copies can tag groupIndex per copy for ramp-by-group fills or Group Pick downstream.",
  facts: {
    space: {
      "in:source": ["canvas01", "raster"],
      out: "in:source",
      "param:centerX": "canvas01",
      "param:centerY": "canvas01",
    },
    writes: ["attr:rotation", "attr:scale.x", "attr:scale.y", "attr:group"],
    gotchas: [
      "Radial copies rotate in pixel-isotropic space (dy/aspect) so they stay rigid on non-square canvases; axis flips and the 180 degree copy are aspect-free.",
      "On points, a single flip mirrors the point's frame: rotation negates and the flipped axis's scale.x/scale.y negates; two flips compose to a plain 180 degree rotation.",
      "tagGroups stamps group as the copy index (0..copies-1) on every emitted point/subpath; off, the incoming group passes through unchanged. Hidden when an image is wired.",
      "kaleidoscope (mode=radial only) adds one Y-flipped mirror copy per wedge, doubling the copy count to build dihedral symmetry.",
      "mode=bisect clips to the keep half-plane then mirrors. keep=x is x≥centerX (right), -x is x≤centerX (left), y is y≥centerY (down), -y is y≤centerY (up).",
      "In mode=bisect, points on the mirror plane are kept once (not doubled by the reflected copy); closed curves that cross the plane become open arcs with endpoints on the plane.",
      "An image is inverse-sampled per copy and source-overed (later copies win where they overlap); opaque full-frame plates should use mode=bisect so each pixel has one contributor.",
    ],
  },
  backend: "webgl2",
  // Resting type is image; retypes to spline or points from the connected wire.
  inputs: [{ name: "source", type: "image", required: true }],
  resolveInputs(params, ctx): InputSocketDef[] {
    const kind = sourceKind(ctx?.connectedTypes?.source);
    const type: SocketType =
      kind === "points" ? "points" : kind === "spline" ? "spline" : "image";
    const label =
      kind === "points" ? "Points" : kind === "spline" ? "Spline" : "Image";
    return [{ name: "source", label, type, required: true }];
  },
  params: [
    {
      name: "mode",
      label: "Mode",
      type: "enum",
      options: ["x", "y", "both", "radial", "bisect"],
      optionLabels: {
        x: "X",
        y: "Y",
        both: "Both",
        radial: "Radial",
        bisect: "Bisect",
      },
      control: "segmented",
      default: "x",
    },
    {
      name: "keep",
      label: "Side",
      type: "enum",
      options: ["x", "-x", "y", "-y"],
      optionLabels: { x: "X", "-x": "−X", y: "Y", "-y": "−Y" },
      control: "segmented",
      default: "x",
      visibleIf: (p) => p.mode === "bisect",
    },
    {
      name: "centerX",
      label: "Center X",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.001,
      default: 0.5,
      visibleIf: (p) =>
        p.mode === "bisect"
          ? p.keep !== "y" && p.keep !== "-y"
          : p.mode !== "y",
    },
    {
      name: "centerY",
      label: "Center Y",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.001,
      default: 0.5,
      visibleIf: (p) =>
        p.mode === "bisect"
          ? p.keep === "y" || p.keep === "-y"
          : p.mode !== "x",
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
      visibleIf: (_p, meta) => {
        const t = meta?.inputTypes?.source;
        return t !== "image" && t !== "mask";
      },
    },
  ],
  primaryOutput: "image",
  resolvePrimaryOutput(params, ctx): SocketType {
    const kind = sourceKind(ctx?.connectedTypes?.source);
    if (kind === "points") return "points";
    if (kind === "spline") return "spline";
    return "image";
  },
  auxOutputs: [],

  compute({ inputs, params, ctx }) {
    const raw = inputs.source;
    const mode = (params.mode as string) ?? "x";
    const keep: HalfplaneKeep = isHalfplaneKeep(params.keep) ? params.keep : "x";
    const cx = (params.centerX as number) ?? 0.5;
    const cy = (params.centerY as number) ?? 0.5;
    const count = Math.max(1, Math.floor((params.count as number) ?? 6));
    const kaleidoscope = params.kaleidoscope === true;
    const includeSource = params.includeSource !== false;
    const tagGroups = params.tagGroups === true;
    const aspect = ctx.width / Math.max(1, ctx.height);
    const bisect = mode === "bisect";
    const axisMode = bisect ? halfplaneAxis(keep) : mode;

    if (raw?.kind === "image" || raw?.kind === "mask") {
      const output = ctx.allocImage();
      const prog = ctx.getShader("mirror/fs", MIRROR_FS);
      const modeId =
        mode === "y" ? 1 : mode === "both" ? 2 : mode === "radial" ? 3 : mode === "bisect" ? 4 : 0;
      const keepId = keep === "-x" ? 1 : keep === "y" ? 2 : keep === "-y" ? 3 : 0;
      ctx.drawFullscreen(prog, output, (gl) => {
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, raw.texture);
        gl.uniform1i(gl.getUniformLocation(prog, "u_src"), 0);
        gl.uniform2f(gl.getUniformLocation(prog, "u_center"), cx, cy);
        gl.uniform1f(gl.getUniformLocation(prog, "u_aspect"), aspect);
        gl.uniform1i(gl.getUniformLocation(prog, "u_mode"), modeId);
        gl.uniform1i(gl.getUniformLocation(prog, "u_keep"), keepId);
        gl.uniform1i(gl.getUniformLocation(prog, "u_count"), count);
        gl.uniform1i(gl.getUniformLocation(prog, "u_kaleidoscope"), kaleidoscope ? 1 : 0);
        gl.uniform1i(gl.getUniformLocation(prog, "u_includeSource"), includeSource ? 1 : 0);
      });
      return { primary: output };
    }

    const ops = buildOps(axisMode, count, kaleidoscope, includeSource);

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

    if (raw?.kind === "points") {
      const src = bisect ? clipPointsByHalfPlane(raw, keep, cx, cy) : raw;
      // Tiled gather (copy c, row i ← source row i) carries every channel
      // — z/normals/attributes/groups — then the geometry is overwritten
      // per copy in the fresh arrays the gather minted.
      const n = src.count;
      const copies = ops.length;
      // Bisect: a point on the plane is already the seam. Skip it in
      // any flipped copy so includeSource doesn't emit it twice.
      const skipFlipOnPlane = (op: CopyOp, i: number) =>
        bisect &&
        (op.flipX || op.flipY) &&
        onMirrorPlane(src.positions[i * 2], src.positions[i * 2 + 1], keep, cx, cy);
      let emitCount = 0;
      const map = new Int32Array(n * copies);
      const copyOf = new Int32Array(n * copies);
      ops.forEach((op, copyIdx) => {
        for (let i = 0; i < n; i++) {
          if (skipFlipOnPlane(op, i)) continue;
          map[emitCount] = i;
          copyOf[emitCount] = copyIdx;
          emitCount++;
        }
      });
      const out = gatherPoints(src, map, emitCount);
      const rotations = new Float32Array(emitCount);
      const scales = new Float32Array(emitCount * 2);
      const groupIndices = tagGroups ? new Int32Array(emitCount) : out.groupIndices;
      for (let w = 0; w < emitCount; w++) {
        const i = map[w];
        const op = ops[copyOf[w]];
        const pos = mapPos(src.positions[i * 2], src.positions[i * 2 + 1], op);
        out.positions[w * 2] = pos[0];
        out.positions[w * 2 + 1] = pos[1];
        // A single flip is orientation-reversing — no rotation +
        // positive scale can represent it, so the point's frame
        // mirrors: rotation negates and the flipped axis's scale
        // negates (M·R(θ) = R(−θ)·diag(−1,1) for an X flip), so
        // Copy-to-Points stamps genuinely mirrored instances. Two
        // flips compose to a pure 180° rotation.
        const theta = getRotation(src, i);
        let rot: number;
        let sx = getScaleX(src, i);
        let sy = getScaleY(src, i);
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
        rotations[w] = rot + op.angle;
        scales[w * 2] = sx;
        scales[w * 2 + 1] = sy;
        if (tagGroups) (groupIndices as Int32Array)[w] = copyOf[w];
      }
      out.rotations = rotations;
      out.scales = scales;
      out.groupIndices = groupIndices;
      return { primary: out };
    }

    if (raw?.kind === "spline") {
      const src = bisect ? clipSplineByHalfPlane(raw, keep, cx, cy) : raw;
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
            ...(sub.driver !== undefined ? { driver: sub.driver } : {}),
            ...(sub.attrs ? { attrs: sub.attrs } : {}),
          });
        }
      });
      const out: SplineValue = { kind: "spline", subpaths };
      return { primary: out };
    }

    // Nothing wired (the evaluator has already coerced any wired value
    // to the resolved socket type): empty image, matching the resting type.
    const output = ctx.allocImage();
    ctx.clearTarget(output, [0, 0, 0, 0]);
    return { primary: output };
  },
};
