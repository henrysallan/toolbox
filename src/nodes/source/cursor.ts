import type { ImageValue, NodeDefinition, RenderContext } from "@/engine/types";

// Source node emitting a circular falloff field centered on the pointer,
// plus a velocity aux output that carries the cursor's instantaneous
// direction × magnitude modulated by the same falloff.
//
// Primary (grayscale): 1 at the cursor, 0 beyond `radius`. Aspect-
//   corrected so the falloff stays circular on non-square canvases.
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
  outColor = vec4(v, v, v, 1.0);
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
  outColor = vec4(u_velocity.x * t, u_velocity.y * t, 0.0, 1.0);
}`;

interface CursorNodeState {
  // Persistent render targets — the node is stable:false, so we pin
  // our own textures in ctx.state to avoid re-allocating every eval.
  primary: ImageValue | null;
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
    primary: null,
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
    !state.primary ||
    state.primary.width !== ctx.width ||
    state.primary.height !== ctx.height;
  if (needResize) {
    if (state.primary) ctx.releaseTexture(state.primary.texture);
    if (state.velocity) ctx.releaseTexture(state.velocity.texture);
    state.primary = ctx.allocImage();
    state.velocity = ctx.allocImage();
  }
}

export const cursorNode: NodeDefinition = {
  type: "cursor",
  name: "Cursor",
  category: "source",
  description:
    "Circular falloff field centered on the pointer, plus an aux velocity field encoded as RG (direction × magnitude, modulated by the same falloff). Radius and softness are in fractions of canvas width — circular on any aspect.",
  backend: "webgl2",
  // Cursor changes every frame (externally tracked) — want compute to
  // re-run even when params are identical.
  stable: false,
  inputs: [],
  params: [
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
  primaryOutput: "image",
  auxOutputs: [
    { name: "velocity", type: "image" },
    // Raw vec2 flavor of the smoothed velocity — same scaled
    // (smoothVx, smoothVy) the image field uses. Wire this into any
    // vec2 input (or a scalar input, which reads .x) without needing
    // to sample the image first.
    { name: "velocity_vec", type: "vec2" },
  ],

  // Mix live cursor state into this node's fingerprint so downstream
  // caches bust every time the pointer moves.
  fingerprintExtras(_params, ctx) {
    const c = ctx.cursor;
    return `cur:${c.x.toFixed(5)},${c.y.toFixed(5)},${c.active ? 1 : 0}`;
  },

  compute({ params, ctx, nodeId }) {
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

    // Primary: scalar falloff.
    const falloff = ctx.getShader("cursor/falloff", FALLOFF_FS);
    ctx.drawFullscreen(falloff, state.primary!, (gl) => {
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

    return {
      primary: state.primary!,
      aux: {
        velocity: state.velocity!,
        velocity_vec: {
          kind: "vec2",
          value: [state.smoothVx * velScale, state.smoothVy * velScale],
        },
      },
    };
  },

  dispose(ctx: RenderContext, nodeId: string) {
    const key = stateKey(nodeId);
    const s = ctx.state[key] as CursorNodeState | undefined;
    if (s) {
      if (s.primary) ctx.releaseTexture(s.primary.texture);
      if (s.velocity) ctx.releaseTexture(s.velocity.texture);
    }
    delete ctx.state[key];
  },
};
