import { OPACITY_PARAM } from "@/engine/conventions";
import { aspectUncorrectY } from "@/engine/aspect";
import { IDENTITY_TRANSFORM, transformSpline } from "@/engine/spline-transform";
import type {
  ImageValue,
  NodeDefinition,
  RenderContext,
  SplineSubpath,
  SplineValue,
} from "@/engine/types";
import { makeCircleSubpath } from "./circle";

// Source node for the pointer.
//
// Primary (spline): a shape sitting on the cursor — a circle of `radius`
//   by default, or the wired `shape` translated so its bounds centre lands
//   on the pointer. Authored [0,1]² Y-down like every spline source, so
//   Fill / Stroke / Rasterize / Copy to Points take it directly.
// Aux `image` (grayscale falloff): 1 at the cursor, 0 beyond `radius`,
//   aspect-corrected so the disc stays circular on non-square canvases.
//   Alpha IS the falloff — transparent outside the disc — so source-over
//   consumers (Merge, Trails) composite a soft disc rather than an opaque
//   black plate. RGB carries the min→max remap for colour-only readers.
// Aux `velocity` (image, R=vx, G=vy): signed velocity vector encoded
//   per pixel, zero outside the falloff region. Use with a Displace
//   node to drag pixels along the cursor's path, or with Math to drive
//   direction-aware effects.
//
// Velocity is measured in "UV per second" — a slow drag ~0.1, a fast
// swipe several units/sec. The `velocity_scale` param compensates so
// downstream displacements feel right. Wall-clock dt (not scene time)
// so the field still responds while playback is paused.

const FALLOFF_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform vec2 u_cursor;
uniform vec2 u_canvasSize;
uniform float u_active;
uniform float u_radius;
uniform float u_softness;
uniform float u_minVal;
uniform float u_maxVal;
out vec4 outColor;

void main() {
  vec2 dpx = (v_uv - u_cursor) * u_canvasSize;
  float d = length(dpx) / max(u_canvasSize.x, 1.0);
  float inner = u_radius * (1.0 - clamp(u_softness, 0.0, 1.0));
  float t = 1.0 - smoothstep(inner, u_radius, d);
  t *= u_active;
  float v = mix(u_minVal, u_maxVal, t);
  // Straight alpha = coverage. Transparent beyond the falloff so Merge /
  // Trails see a disc, not a full-frame plate; RGB keeps the remapped field.
  outColor = vec4(v, v, v, t);
}`;

const VELOCITY_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform vec2 u_cursor;
uniform vec2 u_canvasSize;
uniform float u_active;
uniform float u_radius;
uniform float u_softness;
uniform vec2 u_velocity;  // already scaled on CPU
out vec4 outColor;

void main() {
  vec2 dpx = (v_uv - u_cursor) * u_canvasSize;
  float d = length(dpx) / max(u_canvasSize.x, 1.0);
  float inner = u_radius * (1.0 - clamp(u_softness, 0.0, 1.0));
  float t = 1.0 - smoothstep(inner, u_radius, d);
  t *= u_active;
  // Modulate the global velocity vector by the falloff: near the
  // cursor, pixels get (vx, vy); far away they get zero. Encode
  // signed components in R/G — pipeline is RGBA16F so no shift needed.
  // Alpha stays 1: velocity producers are data fields, not visuals
  // (same convention as the flow-field nodes).
  outColor = vec4(u_velocity.x * t, u_velocity.y * t, 0.0, 1.0);
}`;

interface CursorNodeState {
  // Persistent render targets — the node is stable:false, so we pin
  // our own textures in ctx.state to avoid re-allocating every eval.
  falloff: ImageValue | null;
  velocity: ImageValue | null;
  // Motion tracking, wall-clock-based so it still advances while
  // scene time is paused.
  lastX: number;
  lastY: number;
  lastTime: number;
  smoothVx: number;
  smoothVy: number;
  initialized: boolean;
}

function stateKey(nodeId: string): string {
  return `cursor:${nodeId}`;
}

function ensureState(ctx: RenderContext, nodeId: string): CursorNodeState {
  const key = stateKey(nodeId);
  const existing = ctx.state[key] as CursorNodeState | undefined;
  if (existing) return existing;
  const s: CursorNodeState = {
    falloff: null,
    velocity: null,
    lastX: ctx.cursor.x,
    lastY: ctx.cursor.y,
    lastTime: performance.now() / 1000,
    smoothVx: 0,
    smoothVy: 0,
    initialized: false,
  };
  ctx.state[key] = s;
  return s;
}

function ensureTargets(ctx: RenderContext, state: CursorNodeState) {
  const needResize =
    !state.falloff ||
    state.falloff.width !== ctx.width ||
    state.falloff.height !== ctx.height;
  if (needResize) {
    if (state.falloff) ctx.releaseTexture(state.falloff.texture);
    if (state.velocity) ctx.releaseTexture(state.velocity.texture);
    state.falloff = ctx.allocImage();
    state.velocity = ctx.allocImage();
  }
}

// Bounds centre of the anchor positions — the same "content centre" Copy
// to Points anchors its spline instances by. Null for an anchorless spline.
function boundsCenter(subpaths: SplineSubpath[]): [number, number] | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const s of subpaths) {
    for (const a of s.anchors) {
      if (a.pos[0] < minX) minX = a.pos[0];
      if (a.pos[0] > maxX) maxX = a.pos[0];
      if (a.pos[1] < minY) minY = a.pos[1];
      if (a.pos[1] > maxY) maxY = a.pos[1];
    }
  }
  return Number.isFinite(minX)
    ? [(minX + maxX) / 2, (minY + maxY) / 2]
    : null;
}

const EMPTY_SPLINE: SplineValue = { kind: "spline", subpaths: [] };

// The primary spline: the wired shape re-centred on the pointer (translate
// only — never scaled to `radius`), or the default circle. Both in authored
// canvas01 space; equal radii stay round because the rasterizer scales y
// about 0.5 by W/H, the same width-relative rule the falloff disc follows.
function shapeAt(
  shape: SplineValue | null,
  cx: number,
  cy: number,
  radius: number
): SplineValue {
  if (shape) {
    const c = boundsCenter(shape.subpaths);
    if (!c) return EMPTY_SPLINE;
    return transformSpline(shape, {
      ...IDENTITY_TRANSFORM,
      translateX: cx - c[0],
      translateY: cy - c[1],
    });
  }
  return {
    kind: "spline",
    subpaths: [makeCircleSubpath(cx, cy, radius, radius)],
  };
}

export const cursorNode: NodeDefinition = {
  type: "cursor",
  name: "Cursor",
  category: "spline",
  subcategory: "generator",
  description:
    "Pointer source. Primary is a spline riding the cursor — a circle of `radius` by default, or a wired custom shape re-centred on the pointer — ready for Fill, Stroke, Rasterize or Copy to Points. Aux image is the circular falloff field (1 at the cursor, 0 beyond radius) on a transparent background, plus an aux velocity field encoded as RG (direction × magnitude, modulated by the same falloff). Radius and softness are fractions of canvas width — circular on any aspect.",
  facts: {
    space: {
      out: "canvas01",
      "in:shape": "canvas01",
      "param:radius": "canvas01",
      "aux:position": "canvas01",
    },
    gotchas: [
      "The primary output is a SPLINE, not the falloff raster: a radius circle at the pointer, or the wired shape moved so its anchor-bounds centre sits there. Wire aux image for the grayscale field.",
      "A wired shape is only moved, never scaled or rotated — radius shapes the falloff and the default circle only.",
      "The aux image's alpha is the falloff itself — transparent beyond radius — so Merge / Trails composite a soft disc; RGB still carries the min→max remap for colour-only readers like Displace or Math.",
      "While the pointer is off the canvas (cursor inactive) the spline is empty and the falloff is all-zero with alpha 0; nothing holds the last position.",
      "Velocity is timed against wall-clock performance.now(), not scene time, so it keeps responding while playback is paused and does not replay identically across two exports of the same timeline.",
      "velocity_vec and the aux velocity image's R/G are canvas-UV units per second scaled by velocity_scale, distinct from aux position which is authored canvas coordinates (y-down, aspect-uncorrected).",
      "velocity_smoothing 0 is instant/unsmoothed, 1 freezes the value entirely (EMA alpha = 1 − smoothing); default 0.3 is light smoothing.",
      "min/max remap the falloff's RGB (default 0 outside, 1 at the cursor) and are not clamped, so max < min inverts the field; alpha ignores them and always follows coverage.",
    ],
  },
  backend: "webgl2",
  // Cursor changes every frame (externally tracked) — want compute to
  // re-run even when params are identical.
  stable: false,
  // Live pointer state — no past/future to sample. Time Offset
  // boundary-feeds the current field through un-shifted.
  retimeable: false,
  inputs: [
    {
      name: "shape",
      label: "shape",
      type: "spline",
      required: false,
    },
  ],
  params: [
    OPACITY_PARAM,
    {
      name: "radius",
      label: "Radius",
      type: "scalar",
      min: 0.001,
      max: 1,
      softMax: 0.5,
      step: 0.001,
      default: 0.15,
    },
    {
      name: "softness",
      label: "Softness",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.01,
      default: 0.5,
    },
    {
      name: "min",
      label: "Min (outside)",
      type: "scalar",
      min: -10,
      max: 10,
      softMax: 1,
      step: 0.001,
      default: 0,
    },
    {
      name: "max",
      label: "Max (at cursor)",
      type: "scalar",
      min: -10,
      max: 10,
      softMax: 1,
      step: 0.001,
      default: 1,
    },
    {
      name: "velocity_scale",
      label: "Velocity scale",
      type: "scalar",
      min: 0,
      max: 10,
      softMax: 2,
      step: 0.01,
      default: 1,
    },
    {
      name: "velocity_smoothing",
      label: "Velocity smoothing",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.01,
      default: 0.3,
    },
  ],
  primaryOutput: "spline",
  auxOutputs: [
    {
      name: "image",
      type: "image",
      label: "image",
      description:
        "Circular falloff field: RGB = min→max by falloff, alpha = falloff (transparent beyond radius).",
    },
    { name: "velocity", type: "image" },
    // Raw vec2 flavor of the smoothed velocity — same scaled
    // (smoothVx, smoothVy) the image field uses. Wire this into any
    // vec2 input (or a scalar input, which reads .x) without needing
    // to sample the image first.
    { name: "velocity_vec", type: "vec2" },
    // Live pointer position in AUTHORED space (y-down [0,1]², like
    // points/splines/transform params) — Shortest Path's start/end and
    // any vec2 param take it directly. Note velocity_vec stays in
    // canvas-UV units per second; position is the one authored-space
    // output here. The Pointer node is the full signal vocabulary.
    { name: "position", type: "vec2" },
  ],

  // Mix live cursor state into this node's fingerprint so downstream
  // caches bust every time the pointer moves.
  fingerprintExtras(_params, ctx) {
    const c = ctx.cursor;
    return `cur:${c.x.toFixed(5)},${c.y.toFixed(5)},${c.active ? 1 : 0}`;
  },

  compute({ inputs, params, ctx, nodeId }) {
    const state = ensureState(ctx, nodeId);
    ensureTargets(ctx, state);

    const radius = (params.radius as number) ?? 0.15;
    const softness = (params.softness as number) ?? 0.5;
    const minVal = (params.min as number) ?? 0;
    const maxVal = (params.max as number) ?? 1;
    const velScale = (params.velocity_scale as number) ?? 1;
    const smoothingParam = Math.max(
      0,
      Math.min(1, (params.velocity_smoothing as number) ?? 0.3)
    );
    // EMA coefficient. 0 = no smoothing (alpha=1, instant). 1 = maximum
    // smoothing (alpha=0, frozen). Map to a useful mid-range so the
    // default 0.3 feels like "light smoothing."
    const alpha = 1 - smoothingParam;

    const { x, y, active } = ctx.cursor;

    // Wall-clock dt so pausing the scene doesn't freeze the velocity
    // reading. Clamp tiny dt (eval ran twice within a frame) and
    // large dt (cursor was inactive for a while) to keep the smoothed
    // value well-behaved.
    const now = performance.now() / 1000;
    const rawDt = now - state.lastTime;
    const dt = Math.max(0.001, Math.min(0.2, rawDt));

    let vx = 0;
    let vy = 0;
    if (state.initialized && active) {
      vx = (x - state.lastX) / dt;
      vy = (y - state.lastY) / dt;
    }
    state.initialized = true;
    state.smoothVx = state.smoothVx * (1 - alpha) + vx * alpha;
    state.smoothVy = state.smoothVy * (1 - alpha) + vy * alpha;
    state.lastX = x;
    state.lastY = y;
    state.lastTime = now;

    // Aux image: scalar falloff on transparency.
    const falloff = ctx.getShader("cursor/falloff-v2", FALLOFF_FS);
    ctx.drawFullscreen(falloff, state.falloff!, (gl) => {
      gl.uniform2f(gl.getUniformLocation(falloff, "u_cursor"), x, y);
      gl.uniform2f(
        gl.getUniformLocation(falloff, "u_canvasSize"),
        ctx.width,
        ctx.height
      );
      gl.uniform1f(
        gl.getUniformLocation(falloff, "u_active"),
        active ? 1 : 0
      );
      gl.uniform1f(gl.getUniformLocation(falloff, "u_radius"), radius);
      gl.uniform1f(gl.getUniformLocation(falloff, "u_softness"), softness);
      gl.uniform1f(gl.getUniformLocation(falloff, "u_minVal"), minVal);
      gl.uniform1f(gl.getUniformLocation(falloff, "u_maxVal"), maxVal);
    });

    // Aux: velocity field, same falloff shape with R=vx, G=vy.
    const velocity = ctx.getShader("cursor/velocity", VELOCITY_FS);
    ctx.drawFullscreen(velocity, state.velocity!, (gl) => {
      gl.uniform2f(gl.getUniformLocation(velocity, "u_cursor"), x, y);
      gl.uniform2f(
        gl.getUniformLocation(velocity, "u_canvasSize"),
        ctx.width,
        ctx.height
      );
      gl.uniform1f(
        gl.getUniformLocation(velocity, "u_active"),
        active ? 1 : 0
      );
      gl.uniform1f(gl.getUniformLocation(velocity, "u_radius"), radius);
      gl.uniform1f(gl.getUniformLocation(velocity, "u_softness"), softness);
      gl.uniform2f(
        gl.getUniformLocation(velocity, "u_velocity"),
        state.smoothVx * velScale,
        state.smoothVy * velScale
      );
    });

    // ctx.cursor is y-UP canvas UV; authored space is y-DOWN and
    // aspect-uncorrected (engine/aspect.ts) — flip at the socket.
    const aspect = ctx.height > 0 ? ctx.width / ctx.height : 1;
    const px = x;
    const py = aspectUncorrectY(1 - y, aspect);

    // Primary spline: the custom shape (or default circle) on the pointer.
    // Off-canvas the cursor is inactive and the falloff is all zeros, so
    // the shape vanishes too — the two outputs agree about "no pointer".
    const shape =
      inputs.shape && inputs.shape.kind === "spline"
        ? (inputs.shape as SplineValue)
        : null;
    const spline = active ? shapeAt(shape, px, py, radius) : EMPTY_SPLINE;

    return {
      // Textures live in this node's persistent state (redrawn in place) —
      // the evaluator must not release them (see NodeOutput.ownsTextures).
      ownsTextures: false,
      primary: spline,
      aux: {
        // FRESH wrapper objects every eval, same underlying textures.
        // Consumers key CPU-readback caches on ImageValue IDENTITY (Copy
        // to Points / Modulate Points field samplers: "a new object means
        // the upstream recomputed") — returning the persistent state
        // objects directly made those caches read the falloff once and
        // freeze, so Cursor → scale_field/rotate_field never responded to
        // the pointer. Identity must track content: redrawn-in-place ⇒
        // re-wrap.
        image: { ...state.falloff! },
        velocity: { ...state.velocity! },
        velocity_vec: {
          kind: "vec2",
          value: [state.smoothVx * velScale, state.smoothVy * velScale],
        },
        position: {
          kind: "vec2",
          value: [px, py],
        },
      },
    };
  },

  dispose(ctx: RenderContext, nodeId: string) {
    const key = stateKey(nodeId);
    const s = ctx.state[key] as CursorNodeState | undefined;
    if (s) {
      if (s.falloff) ctx.releaseTexture(s.falloff.texture);
      if (s.velocity) ctx.releaseTexture(s.velocity.texture);
    }
    delete ctx.state[key];
  },
};
