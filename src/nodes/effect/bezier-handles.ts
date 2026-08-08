import type {
  NodeDefinition,
  RenderContext,
  SplineAnchor,
  SplineSubpath,
  SplineValue,
} from "@/engine/types";
import { buildPath2D, hexToRgba } from "@/engine/spline-raster";
import { aspectCorrectY } from "@/engine/aspect";
import { OPACITY_PARAM } from "@/engine/conventions";

// Bezier Handles — an editor-style visualizer for a spline's control structure.
// Pipe in any spline and get back, as BOTH an image (primary) and a spline
// (aux), the bezier "skeleton": the curve itself (optional), the tangent
// handle lines from each anchor to its control points, an anchor dot at every
// anchor, and a handle dot at every control-point endpoint. Each layer styles
// independently (color / thickness / dashed·dotted for lines; radius / fill /
// stroke for each dot family).
//
// It's a pure visualizer over the input geometry — no time, no state, no async
// — so it caches as a constant whenever its input and params are unchanged.
// Spec: specdocs/archive/062926_bezier-handles-node.md.

// Y-flip blit: the 2D canvas is row-0-top; flip to the pipeline's Y-up.
const BLIT_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_src;
out vec4 outColor;
void main() {
  outColor = texture(u_src, vec2(v_uv.x, 1.0 - v_uv.y));
}`;

interface VizState {
  canvas: HTMLCanvasElement;
  tex: WebGLTexture | null;
  lastSig: string | null;
}

function stateKey(nodeId: string): string {
  return `bezier-handles:${nodeId}`;
}

function ensureState(ctx: RenderContext, nodeId: string): VizState {
  const key = stateKey(nodeId);
  const existing = ctx.state[key] as VizState | undefined;
  if (existing) return existing;
  const gl = ctx.gl;
  const tex = gl.createTexture();
  if (!tex) throw new Error("bezier-handles: failed to create texture");
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.bindTexture(gl.TEXTURE_2D, null);
  const s: VizState = {
    canvas: document.createElement("canvas"),
    tex,
    lastSig: null,
  };
  ctx.state[key] = s;
  return s;
}

// A handle offset counts as "present" only when it actually pulls away from
// the anchor — zero-length handles (corner points / straight segments) draw
// no line and no dot.
function nonZero(h: [number, number] | undefined): h is [number, number] {
  return !!h && (h[0] !== 0 || h[1] !== 0);
}

// Apply the shared solid / dashed / dotted line style to a 2D context. Dashed
// is [len, gap]; dotted is [0, spacing] with a round cap (the zero-width
// "dash" renders as a dot) — same convention as Rasterize Spline.
function setLineStyle(
  c2d: CanvasRenderingContext2D,
  style: string,
  dash: number,
  gap: number,
  dotGap: number
) {
  if (style === "dashed") {
    c2d.setLineDash([Math.max(0.5, dash), Math.max(0.5, gap)]);
    c2d.lineCap = "round";
  } else if (style === "dotted") {
    c2d.setLineDash([0, Math.max(1, dotGap)]);
    c2d.lineCap = "round";
  } else {
    c2d.setLineDash([]);
    c2d.lineCap = "round";
  }
}

// A closed 4-anchor bezier circle in normalized space. Radius R is uniform on
// both axes; downstream rasterization aspect-corrects Y (aspect = W/H), which
// makes R = rPx/W reproduce a round dot of pixel radius rPx — matching the
// `arc()` dots drawn into the image here.
const KAPPA = 0.5522847498307936;
function circleSubpath(
  cx: number,
  cy: number,
  R: number,
  groupIndex: number
): SplineSubpath {
  const k = KAPPA * R;
  return {
    anchors: [
      { pos: [cx + R, cy], inHandle: [0, -k], outHandle: [0, k] },
      { pos: [cx, cy + R], inHandle: [k, 0], outHandle: [-k, 0] },
      { pos: [cx - R, cy], inHandle: [0, k], outHandle: [0, -k] },
      { pos: [cx, cy - R], inHandle: [-k, 0], outHandle: [k, 0] },
    ],
    closed: true,
    groupIndex,
  };
}

// One anchor's drawable parts in normalized [0,1]² space.
interface AnchorViz {
  anchor: [number, number];
  inEnd: [number, number] | null;
  outEnd: [number, number] | null;
}

function collectAnchors(spline: SplineValue): AnchorViz[] {
  const out: AnchorViz[] = [];
  for (const sub of spline.subpaths) {
    for (const a of sub.anchors) {
      const inEnd = nonZero(a.inHandle)
        ? ([a.pos[0] + a.inHandle[0], a.pos[1] + a.inHandle[1]] as [
            number,
            number,
          ])
        : null;
      const outEnd = nonZero(a.outHandle)
        ? ([a.pos[0] + a.outHandle[0], a.pos[1] + a.outHandle[1]] as [
            number,
            number,
          ])
        : null;
      out.push({ anchor: a.pos, inEnd, outEnd });
    }
  }
  return out;
}

// Dash/dotted sub-params shared by every line/stroke family. `prefix` keeps
// the three families' param names distinct; `vis` gates the row on its
// family's enable + style.
function dashParams(
  prefix: string,
  vis: (p: Record<string, unknown>) => boolean
): NodeDefinition["params"] {
  return [
    {
      name: `${prefix}_dash`,
      label: "Dash length (px)",
      type: "scalar",
      min: 0.5,
      max: 200,
      softMax: 40,
      step: 0.5,
      default: 6,
      visibleIf: (p) => vis(p) && p[`${prefix}_style`] === "dashed",
    },
    {
      name: `${prefix}_gap`,
      label: "Dash gap (px)",
      type: "scalar",
      min: 0.5,
      max: 200,
      softMax: 40,
      step: 0.5,
      default: 4,
      visibleIf: (p) => vis(p) && p[`${prefix}_style`] === "dashed",
    },
    {
      name: `${prefix}_dot_gap`,
      label: "Dot spacing (px)",
      type: "scalar",
      min: 1,
      max: 200,
      softMax: 40,
      step: 0.5,
      default: 6,
      visibleIf: (p) => vis(p) && p[`${prefix}_style`] === "dotted",
    },
  ];
}

export const bezierHandlesNode: NodeDefinition = {
  type: "bezier-handles",
  name: "Bezier Handles",
  category: "spline",
  subcategory: "utility",
  description:
    "Visualize a spline's bezier control structure like a pen-tool editor view: the path (optional), the tangent handle lines, anchor dots, and handle-end dots — each independently styled (color/thickness/dashed·dotted for lines; radius/fill/stroke for dots). Outputs both an image (primary) and a spline (aux: the handle lines + dots as vectors, group-tagged 0=lines, 1=anchors, 2=handles).",
  backend: "webgl2",
  inputs: [{ name: "path", type: "spline", required: true }],
  params: [
    // ---- Source path overlay (the curve itself, solid) ----
    { name: "show_path", label: "Show path", type: "boolean", default: true },
    {
      name: "path_color",
      label: "Path color",
      type: "color",
      default: "#8a8a8a",
      visibleIf: (p) => p.show_path !== false,
    },
    {
      name: "path_width",
      label: "Path width (px)",
      type: "scalar",
      min: 0,
      max: 50,
      softMax: 8,
      step: 0.5,
      default: 1.5,
      visibleIf: (p) => p.show_path !== false,
    },

    // ---- Handle lines (tangents) ----
    {
      name: "show_handles",
      label: "Show handle lines",
      type: "boolean",
      default: true,
    },
    {
      name: "handle_color",
      label: "Handle color",
      type: "color",
      default: "#4a90ff",
      visibleIf: (p) => p.show_handles !== false,
    },
    {
      name: "handle_width",
      label: "Handle width (px)",
      type: "scalar",
      min: 0,
      max: 50,
      softMax: 6,
      step: 0.5,
      default: 1,
      visibleIf: (p) => p.show_handles !== false,
    },
    {
      name: "handle_style",
      label: "Handle style",
      type: "enum",
      options: ["solid", "dashed", "dotted"],
      default: "solid",
      visibleIf: (p) => p.show_handles !== false,
    },
    ...dashParams("handle", (p) => p.show_handles !== false),

    // ---- Anchor dots ----
    {
      name: "show_anchor_dots",
      label: "Show anchor dots",
      type: "boolean",
      default: true,
    },
    {
      name: "anchor_radius",
      label: "Anchor radius (px)",
      type: "scalar",
      min: 0,
      max: 50,
      softMax: 10,
      step: 0.5,
      default: 4,
      visibleIf: (p) => p.show_anchor_dots !== false,
    },
    {
      name: "anchor_fill",
      label: "Anchor fill",
      type: "boolean",
      default: true,
      visibleIf: (p) => p.show_anchor_dots !== false,
    },
    {
      name: "anchor_fill_color",
      label: "Anchor fill color",
      type: "color",
      default: "#ffffff",
      visibleIf: (p) => p.show_anchor_dots !== false && p.anchor_fill !== false,
    },
    {
      name: "anchor_stroke",
      label: "Anchor stroke",
      type: "boolean",
      default: true,
      visibleIf: (p) => p.show_anchor_dots !== false,
    },
    {
      name: "anchor_stroke_color",
      label: "Anchor stroke color",
      type: "color",
      default: "#4a90ff",
      visibleIf: (p) =>
        p.show_anchor_dots !== false && p.anchor_stroke !== false,
    },
    {
      name: "anchor_stroke_width",
      label: "Anchor stroke (px)",
      type: "scalar",
      min: 0,
      max: 50,
      softMax: 6,
      step: 0.5,
      default: 1.5,
      visibleIf: (p) =>
        p.show_anchor_dots !== false && p.anchor_stroke !== false,
    },
    {
      name: "anchor_stroke_style",
      label: "Anchor stroke style",
      type: "enum",
      options: ["solid", "dashed", "dotted"],
      default: "solid",
      visibleIf: (p) =>
        p.show_anchor_dots !== false && p.anchor_stroke !== false,
    },
    ...dashParams(
      "anchor_stroke",
      (p) => p.show_anchor_dots !== false && p.anchor_stroke !== false
    ),

    // ---- Handle dots (control-point endpoints) ----
    {
      name: "show_handle_dots",
      label: "Show handle dots",
      type: "boolean",
      default: true,
    },
    {
      name: "cp_radius",
      label: "Handle dot radius (px)",
      type: "scalar",
      min: 0,
      max: 50,
      softMax: 10,
      step: 0.5,
      default: 3,
      visibleIf: (p) => p.show_handle_dots !== false,
    },
    {
      name: "cp_fill",
      label: "Handle dot fill",
      type: "boolean",
      default: true,
      visibleIf: (p) => p.show_handle_dots !== false,
    },
    {
      name: "cp_fill_color",
      label: "Handle dot fill color",
      type: "color",
      default: "#4a90ff",
      visibleIf: (p) => p.show_handle_dots !== false && p.cp_fill !== false,
    },
    {
      name: "cp_stroke",
      label: "Handle dot stroke",
      type: "boolean",
      default: false,
      visibleIf: (p) => p.show_handle_dots !== false,
    },
    {
      name: "cp_stroke_color",
      label: "Handle dot stroke color",
      type: "color",
      default: "#ffffff",
      visibleIf: (p) => p.show_handle_dots !== false && p.cp_stroke === true,
    },
    {
      name: "cp_stroke_width",
      label: "Handle dot stroke (px)",
      type: "scalar",
      min: 0,
      max: 50,
      softMax: 6,
      step: 0.5,
      default: 1,
      visibleIf: (p) => p.show_handle_dots !== false && p.cp_stroke === true,
    },
    {
      name: "cp_stroke_style",
      label: "Handle dot stroke style",
      type: "enum",
      options: ["solid", "dashed", "dotted"],
      default: "solid",
      visibleIf: (p) => p.show_handle_dots !== false && p.cp_stroke === true,
    },
    ...dashParams(
      "cp_stroke",
      (p) => p.show_handle_dots !== false && p.cp_stroke === true
    ),

    OPACITY_PARAM,
  ],
  primaryOutput: "image",
  // The vector form of the visualization: handle lines + dot circles, group-
  // tagged so a downstream Select by Index can restyle each family.
  auxOutputs: [{ name: "spline", type: "spline" }],

  compute({ inputs, params, ctx, nodeId }) {
    const src = inputs.path;
    const W = ctx.width;
    const H = ctx.height;
    const state = ensureState(ctx, nodeId);

    const anchors =
      src && src.kind === "spline" ? collectAnchors(src) : [];
    const subpaths =
      src && src.kind === "spline" ? src.subpaths : [];

    const num = (k: string, d: number) => {
      const v = params[k];
      return typeof v === "number" ? v : d;
    };
    const bool = (k: string, d: boolean) => {
      const v = params[k];
      return typeof v === "boolean" ? v : d;
    };
    const str = (k: string, d: string) => {
      const v = params[k];
      return typeof v === "string" ? v : d;
    };

    const showPath = bool("show_path", true);
    const showHandles = bool("show_handles", true);
    const showAnchorDots = bool("show_anchor_dots", true);
    const showHandleDots = bool("show_handle_dots", true);
    const anchorRadius = Math.max(0, num("anchor_radius", 4));
    const cpRadius = Math.max(0, num("cp_radius", 3));

    // ---- Image output ----
    // One mapping for path, handle lines, and dot centers so every layer
    // aligns; dots use a pixel radius so they stay round on any aspect.
    const aspect = W / H;
    const toPx = (p: [number, number]): [number, number] => [
      p[0] * W,
      aspectCorrectY(p[1], aspect) * H,
    ];

    const sig = JSON.stringify({ p: subpaths, params, W, H });
    if (sig !== state.lastSig) {
      const canvas = state.canvas;
      if (canvas.width !== W || canvas.height !== H) {
        canvas.width = W;
        canvas.height = H;
      }
      const c2d = canvas.getContext("2d");
      if (c2d) {
        c2d.clearRect(0, 0, W, H);
        c2d.lineJoin = "round";

        // (1) source path overlay
        if (showPath) {
          const path = buildPath2D(subpaths, W, H, false);
          if (path) {
            c2d.setLineDash([]);
            c2d.lineCap = "round";
            c2d.lineWidth = Math.max(0, num("path_width", 1.5));
            c2d.strokeStyle = hexToRgba(str("path_color", "#8a8a8a"));
            c2d.stroke(path);
          }
        }

        // (2) handle lines (one path, stroked once)
        if (showHandles && anchors.length > 0) {
          const hp = new Path2D();
          let any = false;
          for (const a of anchors) {
            const ap = toPx(a.anchor);
            if (a.inEnd) {
              const e = toPx(a.inEnd);
              hp.moveTo(ap[0], ap[1]);
              hp.lineTo(e[0], e[1]);
              any = true;
            }
            if (a.outEnd) {
              const e = toPx(a.outEnd);
              hp.moveTo(ap[0], ap[1]);
              hp.lineTo(e[0], e[1]);
              any = true;
            }
          }
          if (any) {
            c2d.lineWidth = Math.max(0, num("handle_width", 1));
            c2d.strokeStyle = hexToRgba(str("handle_color", "#4a90ff"));
            setLineStyle(
              c2d,
              str("handle_style", "solid"),
              num("handle_dash", 6),
              num("handle_gap", 4),
              num("handle_dot_gap", 6)
            );
            c2d.stroke(hp);
          }
        }

        // (3) handle dots (under anchors)
        if (showHandleDots && cpRadius > 0) {
          const fillOn = bool("cp_fill", true);
          const strokeOn = bool("cp_stroke", false);
          const strokeW = Math.max(0, num("cp_stroke_width", 1));
          const fillStyle = hexToRgba(str("cp_fill_color", "#4a90ff"));
          const strokeStyle = hexToRgba(str("cp_stroke_color", "#ffffff"));
          for (const a of anchors) {
            for (const end of [a.inEnd, a.outEnd]) {
              if (!end) continue;
              const [cx, cy] = toPx(end);
              c2d.beginPath();
              c2d.arc(cx, cy, cpRadius, 0, Math.PI * 2);
              if (fillOn) {
                c2d.fillStyle = fillStyle;
                c2d.fill();
              }
              if (strokeOn && strokeW > 0) {
                c2d.lineWidth = strokeW;
                c2d.strokeStyle = strokeStyle;
                setLineStyle(
                  c2d,
                  str("cp_stroke_style", "solid"),
                  num("cp_stroke_dash", 6),
                  num("cp_stroke_gap", 4),
                  num("cp_stroke_dot_gap", 6)
                );
                c2d.stroke();
              }
            }
          }
        }

        // (4) anchor dots (on top)
        if (showAnchorDots && anchorRadius > 0) {
          const fillOn = bool("anchor_fill", true);
          const strokeOn = bool("anchor_stroke", true);
          const strokeW = Math.max(0, num("anchor_stroke_width", 1.5));
          const fillStyle = hexToRgba(str("anchor_fill_color", "#ffffff"));
          const strokeStyle = hexToRgba(str("anchor_stroke_color", "#4a90ff"));
          for (const a of anchors) {
            const [cx, cy] = toPx(a.anchor);
            c2d.beginPath();
            c2d.arc(cx, cy, anchorRadius, 0, Math.PI * 2);
            if (fillOn) {
              c2d.fillStyle = fillStyle;
              c2d.fill();
            }
            if (strokeOn && strokeW > 0) {
              c2d.lineWidth = strokeW;
              c2d.strokeStyle = strokeStyle;
              setLineStyle(
                c2d,
                str("anchor_stroke_style", "solid"),
                num("anchor_stroke_dash", 6),
                num("anchor_stroke_gap", 4),
                num("anchor_stroke_dot_gap", 6)
              );
              c2d.stroke();
            }
          }
        }

        c2d.setLineDash([]);
        const gl = ctx.gl;
        gl.bindTexture(gl.TEXTURE_2D, state.tex);
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

    const image = ctx.allocImage();
    const prog = ctx.getShader("bezier-handles/blit", BLIT_FS);
    ctx.drawFullscreen(prog, image, (gl2) => {
      gl2.activeTexture(gl2.TEXTURE0);
      gl2.bindTexture(gl2.TEXTURE_2D, state.tex);
      gl2.uniform1i(gl2.getUniformLocation(prog, "u_src"), 0);
    });

    // ---- Spline (aux) output: vectors mirroring what's drawn ----
    // Radii are normalized so a downstream raster (which aspect-corrects Y)
    // reproduces the same round pixel-radius dots — see circleSubpath.
    const outSub: SplineSubpath[] = [];
    const aR = anchorRadius / W;
    const cR = cpRadius / W;
    for (const a of anchors) {
      if (showHandles) {
        if (a.inEnd) outSub.push(lineSubpath(a.anchor, a.inEnd));
        if (a.outEnd) outSub.push(lineSubpath(a.anchor, a.outEnd));
      }
      if (showAnchorDots && aR > 0) {
        outSub.push(circleSubpath(a.anchor[0], a.anchor[1], aR, 1));
      }
      if (showHandleDots && cR > 0) {
        if (a.inEnd) outSub.push(circleSubpath(a.inEnd[0], a.inEnd[1], cR, 2));
        if (a.outEnd) outSub.push(circleSubpath(a.outEnd[0], a.outEnd[1], cR, 2));
      }
    }
    const splineOut: SplineValue = { kind: "spline", subpaths: outSub };

    return { primary: image, aux: { spline: splineOut } };
  },

  dispose(ctx, nodeId) {
    const key = stateKey(nodeId);
    const state = ctx.state[key] as VizState | undefined;
    if (state?.tex) ctx.gl.deleteTexture(state.tex);
    delete ctx.state[key];
  },
};

// A straight two-anchor open subpath (no handles → straight line), tagged as
// a handle line (groupIndex 0).
function lineSubpath(
  a: [number, number],
  b: [number, number]
): SplineSubpath {
  const anchors: SplineAnchor[] = [{ pos: [a[0], a[1]] }, { pos: [b[0], b[1]] }];
  return { anchors, closed: false, groupIndex: 0 };
}
