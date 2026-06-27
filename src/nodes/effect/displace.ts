import type {
  InputSocketDef,
  NodeDefinition,
  Point,
  PointsValue,
  RenderContext,
  SocketType,
  SplineAnchor,
  SplineValue,
} from "@/engine/types";
import { ensurePointArray, pointsFromArray } from "@/engine/points";

// Displace — offset by a vector read from a displacement field. Polymorphic on
// the source: wire an IMAGE and each pixel is pushed (GPU); wire a SPLINE or
// POINTS value and each anchor / point is pushed (CPU, sampled at its own UV).
// The source socket retypes itself from whatever's connected (no mode toggle),
// and the output type follows. This subsumes the old "Jitter" node — geometry
// displacement is just the spline/points branch here.
//
// After-Effects-style channel selection per axis: `channelX` reads the X-axis
// offset, `channelY` the Y-axis. So an RG vector field (e.g. Perlin Noise in
// flow/curl mode) drives X from R and Y from G; a grayscale height map can
// drive both axes from luminance. `midlevel` is the neutral (no-offset) value
// — 0.5 for signed 8-bit maps. Offsets are in normalized [0,1] units, which is
// the same space pixels (UV) and geometry positions both live in, so one set
// of amount sliders works for every source type.
const FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_src;
uniform sampler2D u_disp;
uniform float u_amountX;
uniform float u_amountY;
uniform float u_midlevel;
uniform int u_channelX; // 0=R 1=G 2=B 3=A 4=luma
uniform int u_channelY;
uniform int u_wrap;     // 0=transparent 1=clamp 2=mirror
out vec4 outColor;

float pick(vec4 c, int ch) {
  if (ch == 0) return c.r;
  if (ch == 1) return c.g;
  if (ch == 2) return c.b;
  if (ch == 3) return c.a;
  return dot(c.rgb, vec3(0.2126, 0.7152, 0.0722));
}

vec2 wrapUv(vec2 uv) {
  if (u_wrap == 1) return clamp(uv, 0.0, 1.0);
  if (u_wrap == 2) return abs(fract(uv * 0.5) * 2.0 - 1.0);
  return uv;
}

void main() {
  vec4 d = texture(u_disp, v_uv);
  float vx = pick(d, u_channelX);
  float vy = pick(d, u_channelY);
  // Midlevel is the "no displacement" value. 0.5 is the standard encoding
  // for signed displacement in an 8-bit texture.
  vec2 offset = vec2(
    (vx - u_midlevel) * u_amountX,
    (vy - u_midlevel) * u_amountY
  );
  vec2 uv = v_uv + offset;
  if (u_wrap == 0 && (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0)) {
    outColor = vec4(0.0);
    return;
  }
  outColor = texture(u_src, wrapUv(uv));
}`;

const CHANNEL_OPTIONS = ["r", "g", "b", "a", "luminance"] as const;
const WRAP_OPTIONS = ["transparent", "clamp", "mirror"] as const;

function channelToInt(s: string): number {
  switch (s) {
    case "r":
      return 0;
    case "g":
      return 1;
    case "b":
      return 2;
    case "a":
      return 3;
    case "luminance":
    default:
      return 4;
  }
}

function wrapToInt(s: string): number {
  switch (s) {
    case "transparent":
      return 0;
    case "clamp":
      return 1;
    case "mirror":
      return 2;
    default:
      return 0;
  }
}

// --- CPU path (spline / points): sample the displacement field per anchor ---

interface FieldBuffer {
  data: Uint8ClampedArray;
  w: number;
  h: number;
}

function ensureCanvas(ctx: RenderContext, nodeId: string): HTMLCanvasElement {
  const key = `displace:${nodeId}`;
  const existing = ctx.state[key] as HTMLCanvasElement | undefined;
  if (existing) return existing;
  const c = document.createElement("canvas");
  ctx.state[key] = c;
  return c;
}

// Read a displacement image into a CPU pixel buffer (one readback per eval).
function readFieldToBuffer(
  ctx: RenderContext,
  canvas: HTMLCanvasElement,
  img: { texture: WebGLTexture; width: number; height: number }
): FieldBuffer | null {
  if (img.width <= 0 || img.height <= 0) return null;
  if (canvas.width !== img.width || canvas.height !== img.height) {
    canvas.width = img.width;
    canvas.height = img.height;
  }
  try {
    ctx.blitToCanvas(
      { kind: "image", texture: img.texture, width: img.width, height: img.height },
      canvas
    );
  } catch {
    return null;
  }
  const c2d = canvas.getContext("2d", { willReadFrequently: true });
  if (!c2d) return null;
  const imgData = c2d.getImageData(0, 0, canvas.width, canvas.height);
  return { data: imgData.data, w: canvas.width, h: canvas.height };
}

// Sample one channel (0..1) at UV. UV is Y-DOWN for splines/points and the
// blitted canvas is row-0-top, so they line up with no explicit Y flip
// (matches the old Jitter sampler).
function sampleChannel(buf: FieldBuffer, u: number, v: number, ch: number): number {
  const px = Math.max(0, Math.min(buf.w - 1, Math.floor(u * buf.w)));
  const py = Math.max(0, Math.min(buf.h - 1, Math.floor(v * buf.h)));
  const i = (py * buf.w + px) * 4;
  const r = buf.data[i] / 255;
  const g = buf.data[i + 1] / 255;
  const b = buf.data[i + 2] / 255;
  const a = buf.data[i + 3] / 255;
  switch (ch) {
    case 0:
      return r;
    case 1:
      return g;
    case 2:
      return b;
    case 3:
      return a;
    default:
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }
}

export const displaceNode: NodeDefinition = {
  type: "displace",
  name: "Displace",
  category: "image",
  subcategory: "modifier",
  description:
    "Offset by a vector read from a displacement field. Wire an image and each pixel is pushed; wire a spline or points value and each anchor/point is pushed (sampled at its own UV). Channel X/Y pick the per-axis channels (RG vector field, or luminance for both); midlevel is the neutral value (0.5 for signed maps).",
  backend: "webgl2",
  inputs: [
    { name: "image", label: "image", type: "image", required: true },
    { name: "displacement", label: "displace", type: "image", required: true },
  ],
  // The source socket adapts to what's wired in — image (default), spline, or
  // points — so one Displace node warps any of them. The displacement field
  // stays an image regardless.
  resolveInputs(params, ctx): InputSocketDef[] {
    const c = ctx?.connectedTypes ?? {};
    const t = c.image;
    const inType: SocketType =
      t === "spline" ? "spline" : t === "points" ? "points" : "image";
    const label = inType === "spline" ? "spline" : inType === "points" ? "points" : "image";
    return [
      { name: "image", label, type: inType, required: true },
      { name: "displacement", label: "displace", type: "image", required: true },
    ];
  },
  params: [
    {
      name: "amountX",
      label: "Amount X",
      type: "scalar",
      min: -1,
      max: 1,
      softMax: 0.5,
      step: 0.001,
      default: 0.05,
    },
    {
      name: "amountY",
      label: "Amount Y",
      type: "scalar",
      min: -1,
      max: 1,
      softMax: 0.5,
      step: 0.001,
      default: 0.05,
    },
    {
      name: "channelX",
      label: "Channel X",
      type: "enum",
      options: CHANNEL_OPTIONS as unknown as string[],
      default: "r",
    },
    {
      name: "channelY",
      label: "Channel Y",
      type: "enum",
      options: CHANNEL_OPTIONS as unknown as string[],
      default: "g",
    },
    {
      name: "midlevel",
      label: "Midlevel",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.01,
      default: 0.5,
    },
    {
      name: "wrap",
      label: "Edge",
      type: "enum",
      options: WRAP_OPTIONS as unknown as string[],
      default: "clamp",
    },
  ],
  primaryOutput: "image",
  // Output type follows the source input.
  resolvePrimaryOutput(params, ctx): SocketType {
    const t = ctx?.connectedTypes?.image;
    return t === "spline" ? "spline" : t === "points" ? "points" : "image";
  },
  auxOutputs: [],

  compute({ inputs, params, ctx, nodeId }) {
    const src = inputs.image;
    const disp = inputs.displacement;
    const channelX = channelToInt((params.channelX as string) ?? "r");
    const channelY = channelToInt((params.channelY as string) ?? "g");
    const amountX = (params.amountX as number) ?? 0;
    const amountY = (params.amountY as number) ?? 0;
    const midlevel = (params.midlevel as number) ?? 0.5;

    // --- Geometry path: spline / points pushed per anchor on the CPU. ---
    if (src && (src.kind === "spline" || src.kind === "points")) {
      const buf =
        disp && disp.kind === "image"
          ? readFieldToBuffer(ctx, ensureCanvas(ctx, nodeId), disp)
          : null;
      // No field wired (or unreadable) → pass through unchanged.
      const offsetAt = (x: number, y: number): [number, number] => {
        if (!buf) return [0, 0];
        const vx = sampleChannel(buf, x, y, channelX);
        const vy = sampleChannel(buf, x, y, channelY);
        return [(vx - midlevel) * amountX, (vy - midlevel) * amountY];
      };

      if (src.kind === "points") {
        const inPts = ensurePointArray(src);
        const out: Point[] = inPts.map((p) => {
          const [dx, dy] = offsetAt(p.pos[0], p.pos[1]);
          return { ...p, pos: [p.pos[0] + dx, p.pos[1] + dy] };
        });
        return { primary: pointsFromArray(out) };
      }
      // spline
      const out: SplineValue = {
        kind: "spline",
        subpaths: src.subpaths.map((sub) => ({
          // Handles are stored relative to their anchor, so shifting the
          // anchor carries them along. groupIndex rides on the subpath.
          closed: sub.closed,
          groupIndex: sub.groupIndex,
          anchors: sub.anchors.map<SplineAnchor>((a) => {
            const [dx, dy] = offsetAt(a.pos[0], a.pos[1]);
            return { ...a, pos: [a.pos[0] + dx, a.pos[1] + dy] };
          }),
        })),
      };
      return { primary: out };
    }

    // --- Image path: per-pixel GPU displacement (original behavior). ---
    const output = ctx.allocImage();
    if (!src || src.kind !== "image") {
      ctx.clearTarget(output, [0, 0, 0, 0]);
      return { primary: output };
    }

    const prog = ctx.getShader("displace/fs", FS);
    // Missing displacement: degrade to a straight pass-through so the graph
    // stays visible while the user wires things up.
    const dispTex = disp && disp.kind === "image" ? disp.texture : src.texture;
    const wrap = wrapToInt((params.wrap as string) ?? "clamp");
    const axEff = disp && disp.kind === "image" ? amountX : 0;
    const ayEff = disp && disp.kind === "image" ? amountY : 0;

    ctx.drawFullscreen(prog, output, (gl) => {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, src.texture);
      gl.uniform1i(gl.getUniformLocation(prog, "u_src"), 0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, dispTex);
      gl.uniform1i(gl.getUniformLocation(prog, "u_disp"), 1);
      gl.uniform1f(gl.getUniformLocation(prog, "u_amountX"), axEff);
      gl.uniform1f(gl.getUniformLocation(prog, "u_amountY"), ayEff);
      gl.uniform1f(gl.getUniformLocation(prog, "u_midlevel"), midlevel);
      gl.uniform1i(gl.getUniformLocation(prog, "u_channelX"), channelX);
      gl.uniform1i(gl.getUniformLocation(prog, "u_channelY"), channelY);
      gl.uniform1i(gl.getUniformLocation(prog, "u_wrap"), wrap);
    });

    return { primary: output };
  },

  dispose(ctx, nodeId) {
    delete ctx.state[`displace:${nodeId}`];
  },
};
