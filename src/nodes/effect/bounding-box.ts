import type {
  InputSocketDef,
  MaskValue,
  NodeDefinition,
  OutputSocketDef,
  PointsValue,
  RenderContext,
  ScalarValue,
  SocketType,
  SplineValue,
  Vec2Value,
} from "@/engine/types";
import { flattenSpline } from "@/engine/spline-flatten";
import { pointsFromArray } from "@/engine/points";
import {
  alphaBoundingBox,
  renderRegionToRect,
  type UvRegion,
} from "@/engine/element";
import { aspectUncorrectY } from "@/engine/aspect";

// Measure the axis-aligned bounding box of whatever is wired in and expose
// it every way downstream work wants it: scalar edges, midpoint/corner point
// sockets, the rectangle as a spline, and (behind a toggle) full-canvas
// guide lines through the four edges.
//
// The `source` socket is polymorphic — image, mask, spline, or points —
// retyped from `connectedTypes` like Transform/Displace (the matching
// editorCanCoerce exception lives in graph-validation.ts). All outputs are
// in AUTHORED [0,1]² Y-down space, the same space every points/spline
// socket speaks:
//   - splines measure off the flattened curve (bezier bulge, not just
//     anchors) plus raw anchor positions (1-anchor subpaths flatten away).
//     splineBbox in spline-fill.ts is deliberately NOT reused — it rejects
//     zero-extent axes, but a horizontal line legitimately has h = 0 here.
//   - points measure off the typed positions array.
//   - images use element.ts's alphaBoundingBox (≤256px proxy readback,
//     cached per value identity); its Y-up canvas-UV region converts to
//     authored space through aspectUncorrectY.
//   - masks get the same proxy measure on the R channel. NOT the
//     mask→image coercion path: that shader writes alpha = 1 everywhere,
//     so an alpha bbox of a coerced mask is always the full canvas.
// No content (fully transparent image / empty geometry) → empty outputs,
// not a full-canvas fallback.

type BBox = { left: number; top: number; right: number; bottom: number };

function modeForType(
  t: SocketType | undefined
): "image" | "mask" | "spline" | "points" {
  if (t === "spline") return "spline";
  if (t === "points") return "points";
  if (t === "mask") return "mask";
  return "image";
}

function splineBounds(src: SplineValue): BBox | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const { segments, segCount } = flattenSpline(src, 24);
  for (let i = 0; i < segCount * 4; i += 2) {
    const x = segments[i];
    const y = segments[i + 1];
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  for (const sub of src.subpaths) {
    for (const a of sub.anchors) {
      if (a.pos[0] < minX) minX = a.pos[0];
      if (a.pos[0] > maxX) maxX = a.pos[0];
      if (a.pos[1] < minY) minY = a.pos[1];
      if (a.pos[1] > maxY) maxY = a.pos[1];
    }
  }
  return Number.isFinite(minX)
    ? { left: minX, top: minY, right: maxX, bottom: maxY }
    : null;
}

function pointsBounds(src: PointsValue): BBox | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const pos = src.positions;
  for (let i = 0; i < src.count * 2; i += 2) {
    const x = pos[i];
    const y = pos[i + 1];
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return Number.isFinite(minX)
    ? { left: minX, top: minY, right: maxX, bottom: maxY }
    : null;
}

// Canvas-UV (Y-up) content region → authored bbox.
function regionToAuthored(region: UvRegion, aspect: number): BBox {
  return {
    left: region.x,
    right: region.x + region.width,
    top: aspectUncorrectY(1 - (region.y + region.height), aspect),
    bottom: aspectUncorrectY(1 - region.y, aspect),
  };
}

// Mask sibling of element.ts's alphaBoundingBox: same ≤256px proxy + one
// readback, same per-value-identity cache, thresholding coverage on the R
// channel (a sampled R-format texture reads (r, 0, 0, 1)).
const maskBboxCache = new WeakMap<MaskValue, UvRegion | null>();
const PROXY_MAX = 256;

function maskBoundingBox(ctx: RenderContext, src: MaskValue): UvRegion | null {
  const hit = maskBboxCache.get(src);
  if (hit !== undefined) return hit;

  const scale = Math.min(1, PROXY_MAX / Math.max(src.width, src.height, 1));
  const pw = Math.max(1, Math.round(src.width * scale));
  const ph = Math.max(1, Math.round(src.height * scale));
  const proxy = renderRegionToRect(
    ctx,
    src,
    { x: 0, y: 0, width: 1, height: 1 },
    pw,
    ph,
    "stretch"
  );
  const data = ctx.readImageToFloat32(proxy);
  ctx.releaseTexture(proxy.texture);

  const threshold = 1 / 255;
  let minX = pw;
  let minY = ph;
  let maxX = -1;
  let maxY = -1;
  // readPixels rows come back bottom-up, which IS Y-up — exactly the
  // orientation the region wants, so no flip.
  for (let y = 0; y < ph; y++) {
    for (let x = 0; x < pw; x++) {
      if (data[(y * pw + x) * 4] > threshold) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  const region: UvRegion | null =
    maxX < 0
      ? null
      : {
          x: minX / pw,
          y: minY / ph,
          width: (maxX - minX + 1) / pw,
          height: (maxY - minY + 1) / ph,
        };
  maskBboxCache.set(src, region);
  return region;
}

function scalar(value: number): ScalarValue {
  return { kind: "scalar", value };
}

function singlePoint(x: number, y: number): PointsValue {
  return pointsFromArray([{ pos: [x, y] }]);
}

function line(
  ax: number,
  ay: number,
  bx: number,
  by: number
): SplineValue["subpaths"][number] {
  return {
    closed: false,
    anchors: [{ pos: [ax, ay] }, { pos: [bx, by] }],
  };
}

const EMPTY_SPLINE: SplineValue = { kind: "spline", subpaths: [] };

// Aux socket list, in display order — edges, edge midpoints, corners,
// extras. Grouping on the node is by ordering + labels.
const AUX_OUTPUTS: OutputSocketDef[] = [
  { name: "left", label: "Left", type: "scalar", description: "Left edge x (authored space)." },
  { name: "right", label: "Right", type: "scalar", description: "Right edge x (authored space)." },
  { name: "top", label: "Top", type: "scalar", description: "Top edge y (authored space)." },
  { name: "bottom", label: "Bottom", type: "scalar", description: "Bottom edge y (authored space)." },
  { name: "mid_left", label: "Mid Left", type: "points", description: "Midpoint of the left edge (single point)." },
  { name: "mid_right", label: "Mid Right", type: "points", description: "Midpoint of the right edge (single point)." },
  { name: "mid_top", label: "Mid Top", type: "points", description: "Midpoint of the top edge (single point)." },
  { name: "mid_bottom", label: "Mid Bottom", type: "points", description: "Midpoint of the bottom edge (single point)." },
  { name: "corner_tl", label: "Top Left", type: "points", description: "Top-left corner (single point)." },
  { name: "corner_tr", label: "Top Right", type: "points", description: "Top-right corner (single point)." },
  { name: "corner_bl", label: "Bottom Left", type: "points", description: "Bottom-left corner (single point)." },
  { name: "corner_br", label: "Bottom Right", type: "points", description: "Bottom-right corner (single point)." },
  { name: "center", label: "Center", type: "points", description: "Center of the box (single point)." },
  { name: "size", label: "Size", type: "vec2", description: "Box (width, height) in authored units." },
];

const GUIDE_OUTPUTS: OutputSocketDef[] = [
  {
    name: "guides_v",
    label: "V Guides",
    type: "spline",
    description:
      "Two vertical canvas-height lines through the left and right edges.",
  },
  {
    name: "guides_h",
    label: "H Guides",
    type: "spline",
    description:
      "Two horizontal canvas-width lines through the top and bottom edges.",
  },
];

export const boundingBoxNode: NodeDefinition = {
  type: "bounding-box",
  name: "Bounding Box",
  category: "utility",
  description:
    "Measure the bounding box of an image (alpha extent), mask, spline, or points and output it as edge scalars, midpoint/corner points, the box as a spline, and optional full-canvas guide lines.",
  backend: "webgl2",
  noMaskInput: true,
  inputs: [{ name: "source", type: "image", required: true }],
  resolveInputs(params, ctx): InputSocketDef[] {
    const mode = modeForType(ctx?.connectedTypes?.source);
    const label =
      mode === "spline"
        ? "Spline"
        : mode === "points"
          ? "Points"
          : mode === "mask"
            ? "Mask"
            : "Image";
    return [{ name: "source", label, type: mode, required: true }];
  },
  params: [
    {
      name: "guides",
      label: "Canvas Guides",
      type: "boolean",
      default: false,
    },
  ],
  primaryOutput: "spline",
  auxOutputs: AUX_OUTPUTS,
  resolveAuxOutputs(params): OutputSocketDef[] {
    return params.guides ? [...AUX_OUTPUTS, ...GUIDE_OUTPUTS] : AUX_OUTPUTS;
  },

  compute({ inputs, params, ctx }) {
    const src = inputs["source"];
    const aspect = ctx.width / Math.max(1, ctx.height);
    const wantGuides = params.guides === true;

    let bbox: BBox | null = null;
    if (src?.kind === "spline") {
      bbox = splineBounds(src);
    } else if (src?.kind === "points") {
      bbox = pointsBounds(src);
    } else if (src?.kind === "mask") {
      const region = maskBoundingBox(ctx, src);
      bbox = region ? regionToAuthored(region, aspect) : null;
    } else if (src?.kind === "image") {
      const region = alphaBoundingBox(ctx, src);
      bbox = region ? regionToAuthored(region, aspect) : null;
    }

    if (!bbox) {
      const none = pointsFromArray([]);
      const aux: Record<string, ScalarValue | PointsValue | Vec2Value | SplineValue> = {
        left: scalar(0),
        right: scalar(0),
        top: scalar(0),
        bottom: scalar(0),
        mid_left: none,
        mid_right: none,
        mid_top: none,
        mid_bottom: none,
        corner_tl: none,
        corner_tr: none,
        corner_bl: none,
        corner_br: none,
        center: none,
        size: { kind: "vec2", value: [0, 0] } satisfies Vec2Value,
      };
      if (wantGuides) {
        aux.guides_v = EMPTY_SPLINE;
        aux.guides_h = EMPTY_SPLINE;
      }
      return { primary: EMPTY_SPLINE, aux };
    }

    const { left, right, top, bottom } = bbox;
    const midX = (left + right) / 2;
    const midY = (top + bottom) / 2;

    const box: SplineValue = {
      kind: "spline",
      subpaths: [
        {
          closed: true,
          anchors: [
            { pos: [left, top] },
            { pos: [right, top] },
            { pos: [right, bottom] },
            { pos: [left, bottom] },
          ],
        },
      ],
    };

    const aux: Record<string, ScalarValue | PointsValue | Vec2Value | SplineValue> = {
      left: scalar(left),
      right: scalar(right),
      top: scalar(top),
      bottom: scalar(bottom),
      mid_left: singlePoint(left, midY),
      mid_right: singlePoint(right, midY),
      mid_top: singlePoint(midX, top),
      mid_bottom: singlePoint(midX, bottom),
      corner_tl: singlePoint(left, top),
      corner_tr: singlePoint(right, top),
      corner_bl: singlePoint(left, bottom),
      corner_br: singlePoint(right, bottom),
      center: singlePoint(midX, midY),
      size: {
        kind: "vec2",
        value: [right - left, bottom - top],
      } satisfies Vec2Value,
    };

    if (wantGuides) {
      // Full canvas height in authored space is aspectUncorrectY(0..1),
      // NOT 0..1 — on a non-square canvas those differ. X is uncorrected,
      // so full width is plainly 0..1.
      const canvasTop = aspectUncorrectY(0, aspect);
      const canvasBottom = aspectUncorrectY(1, aspect);
      aux.guides_v = {
        kind: "spline",
        subpaths: [
          line(left, canvasTop, left, canvasBottom),
          line(right, canvasTop, right, canvasBottom),
        ],
      };
      aux.guides_h = {
        kind: "spline",
        subpaths: [line(0, top, 1, top), line(0, bottom, 1, bottom)],
      };
    }

    return { primary: box, aux };
  },
};
