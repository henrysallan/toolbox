import type {
  ImageValue,
  NodeDefinition,
  RenderContext,
} from "@/engine/types";
import { buildPath2D, hexToRgba } from "@/engine/spline-raster";
import {
  defaultFloatCurve,
  sampleFloatCurve,
  sanitizeFloatCurve,
} from "@/engine/float-curve";
import {
  buildRepeatStrokes,
  type RepeatDirection,
} from "@/engine/spline-repeat";
import type { OverlapStyle } from "@/engine/spline-offset-resolve";
import {
  sampleColorRamp,
  type ColorRampStop,
} from "@/engine/color-ramp";
import { resolveStrokePx, strokeUnitsParam } from "@/engine/stroke-units";

// Rasterize a spline's outline. Output is transparent everywhere except
// the stroked pixels — composite over other layers with a Merge node.
//
// Same 2D-canvas → GL-texture flow as Spline Draw's built-in stroke. A
// signature of the params + input identity lets us skip re-rasterizing
// when nothing has changed (spline values round-trip by reference, so the
// object identity IS the signature for the input).
//
// Repeats (spec 071226_multi-stroke.md): the stroke can draw as N
// parallel-offset rings via engine/spline-repeat.ts, with per-ring styling
// (thickness/opacity falloff curves, color ramp). Geometry is cached on a
// second signature tier so styling-only edits re-stroke cached Path2Ds
// without re-running the bezier offsets.

const STROKE_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_src;
out vec4 outColor;
void main() {
  outColor = texture(u_src, vec2(v_uv.x, 1.0 - v_uv.y));
}`;

interface StrokeRing {
  t: number;
  path: Path2D;
}

interface StrokeState {
  rasterCanvas: HTMLCanvasElement;
  rasterTex: WebGLTexture | null;
  lastSig: string | null;
  // Geometry tier: offset rings survive styling-only re-rasters.
  ringGeomSig: string | null;
  rings: StrokeRing[] | null;
}

function ensureState(ctx: RenderContext, nodeId: string): StrokeState {
  const key = `spline-stroke:${nodeId}`;
  const existing = ctx.state[key] as StrokeState | undefined;
  if (existing) return existing;
  const gl = ctx.gl;
  const tex = gl.createTexture();
  if (!tex) throw new Error("spline-stroke: failed to create texture");
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.bindTexture(gl.TEXTURE_2D, null);
  const s: StrokeState = {
    rasterCanvas: document.createElement("canvas"),
    rasterTex: tex,
    lastSig: null,
    ringGeomSig: null,
    rings: null,
  };
  ctx.state[key] = s;
  return s;
}

const repeatsVisible = (p: Record<string, unknown>) =>
  ((p.repeats as number) ?? 1) > 1;

export const strokeNode: NodeDefinition = {
  type: "spline-stroke",
  name: "Stroke",
  category: "spline",
  subcategory: "modifier",
  description:
    "Render a spline as a stroked outline. Three styles: solid (continuous), dashed (alternating dashes and gaps), dotted (round dots at a fixed spacing). Repeats draws N parallel-offset rings — inner/outer/both, a band width, and a spacing curve placing each ring within the band (closed shapes always expand outward regardless of draw direction; for open paths inner/outer mean left/right of travel). Per-ring styling: thickness and opacity falloff curves, plus an optional color ramp across the rings.",
  backend: "webgl2",
  inputs: [{ name: "path", type: "spline", required: true }],
  params: [
    {
      name: "color",
      label: "Color",
      type: "color",
      default: "#ffffff",
    },
    {
      name: "thickness",
      label: "Thickness",
      type: "scalar",
      min: 0,
      max: 200,
      softMax: 40,
      step: 0.5,
      default: 4,
    },
    // px = absolute pixels (legacy, resolution-dependent); % = percent of
    // canvas width, so the stroke keeps its look at any resolution (#174).
    // Applies to thickness and the dash/dot metrics below.
    strokeUnitsParam("units"),
    {
      name: "style",
      label: "Style",
      type: "enum",
      options: ["solid", "dashed", "dotted"],
      default: "solid",
    },
    {
      name: "dash_length",
      label: "Dash length",
      type: "scalar",
      min: 0.5,
      max: 200,
      softMax: 40,
      step: 0.5,
      default: 10,
      visibleIf: (p) => p.style === "dashed",
    },
    {
      name: "dash_gap",
      label: "Dash gap",
      type: "scalar",
      min: 0.5,
      max: 200,
      softMax: 40,
      step: 0.5,
      default: 8,
      visibleIf: (p) => p.style === "dashed",
    },
    {
      name: "dot_spacing",
      label: "Dot spacing",
      type: "scalar",
      min: 1,
      max: 200,
      softMax: 40,
      step: 0.5,
      default: 12,
      visibleIf: (p) => p.style === "dotted",
    },
    {
      name: "cap",
      label: "Cap",
      type: "enum",
      options: ["round", "butt", "square"],
      default: "round",
      // Dotted mode forces lineCap=round to make the dots circular,
      // so the user-selectable cap is only meaningful for solid and
      // dashed styles.
      visibleIf: (p) => p.style !== "dotted",
    },
    {
      name: "join",
      label: "Join",
      type: "enum",
      options: ["round", "miter", "bevel"],
      default: "round",
    },
    {
      name: "miter_limit",
      label: "Miter limit",
      type: "scalar",
      min: 1,
      max: 20,
      step: 0.1,
      default: 10,
      visibleIf: (p) => p.join === "miter",
    },
    {
      name: "close_open_paths",
      label: "Close open paths",
      type: "boolean",
      default: false,
    },
    // ── Repeats (multi-stroke) ─────────────────────────────────────────
    {
      name: "repeats",
      label: "Repeats",
      type: "scalar",
      min: 1,
      max: 32,
      softMax: 8,
      step: 1,
      default: 1,
      group: "repeats",
      groupHeader: true,
    },
    {
      name: "repeat_direction",
      label: "Direction",
      type: "enum",
      options: ["outer", "inner", "both"],
      default: "outer",
      visibleIf: repeatsVisible,
      group: "repeats",
    },
    {
      name: "repeat_width",
      label: "Band width",
      type: "scalar",
      min: 0,
      max: 0.5,
      softMax: 0.2,
      step: 0.001,
      default: 0.05,
      visibleIf: repeatsVisible,
      group: "repeats",
    },
    {
      name: "repeat_spacing",
      label: "Spacing",
      type: "float_curve",
      default: defaultFloatCurve(0, 1),
      visibleIf: repeatsVisible,
      group: "repeats",
    },
    {
      name: "repeat_overlap",
      label: "Overlap",
      type: "enum",
      options: ["keep", "sharp", "smooth"],
      default: "keep",
      control: "segmented",
      visibleIf: repeatsVisible,
      group: "repeats",
    },
    {
      name: "repeat_smoothing",
      label: "Smoothing",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.01,
      default: 0.5,
      visibleIf: (p) => repeatsVisible(p) && p.repeat_overlap === "smooth",
      group: "repeats",
    },
    {
      name: "repeat_thickness",
      label: "Thickness falloff",
      type: "float_curve",
      default: defaultFloatCurve(1, 1),
      visibleIf: repeatsVisible,
      group: "repeats",
    },
    {
      name: "repeat_opacity",
      label: "Opacity falloff",
      type: "float_curve",
      default: defaultFloatCurve(1, 1),
      visibleIf: repeatsVisible,
      group: "repeats",
    },
    {
      name: "repeat_color_mode",
      label: "Ring color",
      type: "enum",
      options: ["solid", "ramp"],
      default: "solid",
      control: "segmented",
      visibleIf: repeatsVisible,
      group: "repeats",
    },
    {
      name: "repeat_colors",
      label: "Ring ramp",
      type: "color_ramp",
      default: [
        { id: "stop-a", position: 0, color: "#ffffff" },
        { id: "stop-b", position: 1, color: "#000000" },
      ] as ColorRampStop[],
      visibleIf: (p) =>
        repeatsVisible(p) && p.repeat_color_mode === "ramp",
      group: "repeats",
    },
  ],
  primaryOutput: "image",
  auxOutputs: [],

  compute({ inputs, params, ctx, nodeId }) {
    const output = ctx.allocImage();
    const src = inputs.path;
    if (!src || src.kind !== "spline") {
      ctx.clearTarget(output, [0, 0, 0, 0]);
      return { primary: output };
    }

    const state = ensureState(ctx, nodeId);
    const W = ctx.width;
    const H = ctx.height;

    const repeats = Math.max(1, Math.round((params.repeats as number) ?? 1));
    const closeOpen = !!params.close_open_paths;
    const spacingCurve = sanitizeFloatCurve(params.repeat_spacing, 0, 1);

    // Geometry-tier signature: everything that changes the ring Path2Ds.
    // The spline value itself rides the input reference — when the upstream
    // evaluator re-emits, it's typically a new object, which busts this
    // cache naturally.
    const geomSig = JSON.stringify({
      subRef: src.subpaths,
      n: repeats,
      dir: repeats > 1 ? params.repeat_direction : 0,
      w: repeats > 1 ? params.repeat_width : 0,
      sc: repeats > 1 ? spacingCurve : 0,
      ov: repeats > 1 ? params.repeat_overlap : 0,
      ovs:
        repeats > 1 && params.repeat_overlap === "smooth"
          ? params.repeat_smoothing
          : 0,
      close: closeOpen,
      W,
      H,
    });

    // Full signature adds styling — covers everything that changes the
    // raster output.
    const sig = JSON.stringify({
      g: geomSig,
      c: params.color,
      t: params.thickness,
      u: params.units,
      st: params.style,
      dl: params.dash_length,
      dg: params.dash_gap,
      ds: params.dot_spacing,
      cap: params.cap,
      jn: params.join,
      ml: params.miter_limit,
      rtc: repeats > 1 ? params.repeat_thickness : 0,
      roc: repeats > 1 ? params.repeat_opacity : 0,
      rcm: repeats > 1 ? params.repeat_color_mode : 0,
      rcl:
        repeats > 1 && params.repeat_color_mode === "ramp"
          ? params.repeat_colors
          : 0,
    });

    if (sig !== state.lastSig) {
      if (geomSig !== state.ringGeomSig || !state.rings) {
        // repeats === 1 keeps the legacy single-path build — no offset
        // math, identical output to the pre-repeats node.
        if (repeats <= 1) {
          const path = buildPath2D(src.subpaths, W, H, closeOpen);
          state.rings = path ? [{ t: 0, path }] : [];
        } else {
          const strokes = buildRepeatStrokes(src.subpaths, {
            count: repeats,
            direction:
              (params.repeat_direction as RepeatDirection) ?? "outer",
            width: (params.repeat_width as number) ?? 0.05,
            spacingCurve,
            widthPx: W,
            heightPx: H,
            overlap: {
              style: (params.repeat_overlap as OverlapStyle) ?? "keep",
              smoothing: (params.repeat_smoothing as number) ?? 0.5,
            },
          });
          const rings: StrokeRing[] = [];
          for (const s of strokes) {
            const path = buildPath2D(s.subpaths, W, H, closeOpen);
            if (path) rings.push({ t: s.t, path });
          }
          state.rings = rings;
        }
        state.ringGeomSig = geomSig;
      }

      const canvas = state.rasterCanvas;
      if (canvas.width !== W || canvas.height !== H) {
        canvas.width = W;
        canvas.height = H;
      }
      const c2d = canvas.getContext("2d");
      if (c2d) {
        c2d.clearRect(0, 0, W, H);
        if (state.rings && state.rings.length > 0) {
          const style = (params.style as string) ?? "solid";
          const units = params.units;
          const thickness = Math.max(
            0,
            resolveStrokePx((params.thickness as number) ?? 4, units, W)
          );
          c2d.lineJoin =
            (params.join as CanvasLineJoin) ?? ("round" as CanvasLineJoin);
          if (params.join === "miter") {
            c2d.miterLimit = (params.miter_limit as number) ?? 10;
          }
          // Style-specific setup: dashed uses setLineDash with a
          // [dash, gap] pattern; dotted leans on Canvas's "dash of
          // length 0 + round cap" idiom so each dash collapses to a
          // single round dot whose diameter equals the stroke width.
          if (style === "dashed") {
            const dash = Math.max(
              0.5,
              resolveStrokePx((params.dash_length as number) ?? 10, units, W)
            );
            const gap = Math.max(
              0.5,
              resolveStrokePx((params.dash_gap as number) ?? 8, units, W)
            );
            c2d.setLineDash([dash, gap]);
            c2d.lineCap =
              (params.cap as CanvasLineCap) ?? ("round" as CanvasLineCap);
          } else if (style === "dotted") {
            const spacing = Math.max(
              1,
              resolveStrokePx((params.dot_spacing as number) ?? 12, units, W)
            );
            c2d.setLineDash([0, spacing]);
            c2d.lineCap = "round";
          } else {
            c2d.setLineDash([]);
            c2d.lineCap =
              (params.cap as CanvasLineCap) ?? ("round" as CanvasLineCap);
          }

          // Per-ring styling. repeats === 1 resolves to the plain
          // color/thickness/alpha so the legacy path stays exact.
          const thicknessCurve = sanitizeFloatCurve(
            params.repeat_thickness,
            1,
            1
          );
          const opacityCurve = sanitizeFloatCurve(
            params.repeat_opacity,
            1,
            1
          );
          const stops =
            repeats > 1 && params.repeat_color_mode === "ramp"
              ? ((params.repeat_colors as ColorRampStop[]) ?? [])
              : null;
          const solid = hexToRgba((params.color as string) ?? "#ffffff");

          for (const ring of state.rings) {
            const w =
              repeats > 1
                ? thickness * sampleFloatCurve(thicknessCurve, ring.t)
                : thickness;
            const a =
              repeats > 1
                ? Math.max(
                    0,
                    Math.min(1, sampleFloatCurve(opacityCurve, ring.t))
                  )
                : 1;
            // Canvas ignores a lineWidth of 0 (keeps the previous value),
            // so skip invisible rings explicitly.
            if (w <= 0 || a <= 0) continue;
            c2d.lineWidth = w;
            c2d.strokeStyle = stops
              ? sampleColorRamp(stops, ring.t)
              : solid;
            c2d.globalAlpha = a;
            c2d.stroke(ring.path);
          }
          c2d.globalAlpha = 1;
        }
        const gl = ctx.gl;
        gl.bindTexture(gl.TEXTURE_2D, state.rasterTex);
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 0);
        gl.texImage2D(
          gl.TEXTURE_2D,
          0,
          gl.RGBA,
          gl.RGBA,
          gl.UNSIGNED_BYTE,
          canvas
        );
        gl.bindTexture(gl.TEXTURE_2D, null);
      }
      state.lastSig = sig;
    }

    const prog = ctx.getShader("spline-stroke/blit", STROKE_FS);
    const image: ImageValue = output;
    ctx.drawFullscreen(prog, image, (gl2) => {
      gl2.activeTexture(gl2.TEXTURE0);
      gl2.bindTexture(gl2.TEXTURE_2D, state.rasterTex);
      gl2.uniform1i(gl2.getUniformLocation(prog, "u_src"), 0);
    });

    return { primary: image };
  },

  dispose(ctx, nodeId) {
    const key = `spline-stroke:${nodeId}`;
    const state = ctx.state[key] as StrokeState | undefined;
    if (state?.rasterTex) ctx.gl.deleteTexture(state.rasterTex);
    delete ctx.state[key];
  },
};
