import type {
  ImageValue,
  InputSocketDef,
  NodeDefinition,
  RenderContext,
  UvValue,
} from "@/engine/types";
import {
  disposePlaceholderTex,
  getPlaceholderTex,
} from "@/engine/placeholder-tex";

// ─── Shaders ───────────────────────────────────────────────────────────────

// Copies the input into our persistent prev buffer. Used once per reset /
// canvas resize so we don't feed the user garbage history.
const COPY_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_src;
out vec4 outColor;
void main() {
  outColor = texture(u_src, v_uv);
}`;

// Feedback/ring blend. `u_prev` is already decayed by u_decay on the CPU side
// (we do it here so the ring path can skip-update without also decaying the
// not-yet-replaced history — cleaner weighting).
const BLEND_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_cur;
uniform sampler2D u_prev;
uniform float u_decay;
uniform int u_blend;
out vec4 outColor;

void main() {
  vec4 c = texture(u_cur, v_uv);
  vec4 p = texture(u_prev, v_uv);
  vec3 pRgb = p.rgb * u_decay;
  float pA = p.a * u_decay;
  vec3 r;
  if (u_blend == 0)       r = max(c.rgb, pRgb);                              // max
  else if (u_blend == 1)  r = c.rgb + pRgb;                                   // add
  else if (u_blend == 2)  r = 1.0 - (1.0 - c.rgb) * (1.0 - pRgb);             // screen
  else                    r = mix(pRgb, c.rgb, c.a);                          // over (alpha)
  float a = max(c.a, pA);
  outColor = vec4(r, a);
}`;

// Velocity directional blur. Samples prev N times backwards along the
// velocity vector, falling off geometrically by u_decay per tap. When a
// per-pixel UV-velocity field is connected, u_hasVelUv = 1 and we read the
// local velocity from it instead of using the global uniform.
const VELOCITY_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_cur;
uniform sampler2D u_prev;
uniform vec2 u_velocity;
uniform int u_taps;
uniform float u_decay;
uniform int u_hasVelUv;
uniform sampler2D u_velUv;
out vec4 outColor;

void main() {
  vec4 c = texture(u_cur, v_uv);
  vec2 vel = u_hasVelUv == 1 ? (texture(u_velUv, v_uv).rg - 0.5) * 2.0 : u_velocity;
  vec4 acc = c;
  float wsum = 1.0;
  float w = 1.0;
  for (int i = 1; i <= 64; i++) {
    if (i > u_taps) break;
    w *= u_decay;
    // Step back along velocity (earlier in time as i grows).
    vec2 uv = v_uv - vel * (float(i) / float(u_taps));
    if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) continue;
    vec4 s = texture(u_prev, uv);
    acc += s * w;
    wsum += w;
  }
  outColor = acc / wsum;
}`;

// ─── State ─────────────────────────────────────────────────────────────────

type TrailsMode = "feedback" | "ring" | "velocity";

interface TrailsState {
  mode: TrailsMode;
  width: number;
  height: number;
  // Persistent history buffer — holds the previous accumulated output. We
  // ping-pong with a scratch buffer every frame to avoid writing to a
  // currently-bound sampler.
  prev: ImageValue;
  scratch: ImageValue;
  // Frame counter used by ring mode to decide when to actually update prev.
  // Initialized fresh on reset so the user sees a clean starting state.
  frameCounter: number;
  lastResetCounter: number;
}

function stateKey(nodeId: string): string {
  return `trails:${nodeId}`;
}

function ensureState(
  ctx: RenderContext,
  nodeId: string,
  mode: TrailsMode,
  resetCounter: number
): TrailsState {
  const key = stateKey(nodeId);
  const existing = ctx.state[key] as TrailsState | undefined;
  const W = ctx.width;
  const H = ctx.height;

  const shouldReset =
    !existing ||
    existing.mode !== mode ||
    existing.width !== W ||
    existing.height !== H ||
    existing.lastResetCounter !== resetCounter;

  if (!shouldReset) return existing;

  if (existing) {
    ctx.releaseTexture(existing.prev.texture);
    ctx.releaseTexture(existing.scratch.texture);
  }
  const prev = ctx.allocImage({ width: W, height: H });
  const scratch = ctx.allocImage({ width: W, height: H });
  ctx.clearTarget(prev, [0, 0, 0, 0]);
  ctx.clearTarget(scratch, [0, 0, 0, 0]);

  const state: TrailsState = {
    mode,
    width: W,
    height: H,
    prev,
    scratch,
    frameCounter: 0,
    lastResetCounter: resetCounter,
  };
  ctx.state[key] = state;
  return state;
}

// Copies a source image into the persistent prev buffer (via the scratch
// ping-pong partner). After this call `state.prev` holds `src`.
function captureInto(
  ctx: RenderContext,
  state: TrailsState,
  src: ImageValue
): void {
  const prog = ctx.getShader("trails/copy", COPY_FS);
  ctx.drawFullscreen(prog, state.scratch, (gl) => {
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, src.texture);
    gl.uniform1i(gl.getUniformLocation(prog, "u_src"), 0);
  });
  // Swap: scratch now holds the newly-captured frame, prev becomes the
  // write target for future passes.
  const tmp = state.prev;
  state.prev = state.scratch;
  state.scratch = tmp;
}

const BLEND_OPTIONS = ["max", "add", "screen", "over"] as const;
function blendToInt(s: string): number {
  switch (s) {
    case "max":
      return 0;
    case "add":
      return 1;
    case "screen":
      return 2;
    case "over":
    default:
      return 3;
  }
}

// ─── Node ──────────────────────────────────────────────────────────────────

export const trailsNode: NodeDefinition = {
  type: "trails",
  name: "Trails",
  category: "effect",
  description:
    "Temporal trails. Feedback mode: exponential analog-video look. Ring: stepped stop-motion feel. Velocity: directional motion blur along a vector or UV field.",
  backend: "webgl2",
  // Time-dependent by nature — each eval reads last frame's output.
  stable: false,
  inputs: [{ name: "image", type: "image", required: true }],
  resolveInputs(params) {
    const mode = (params.mode as string) ?? "feedback";
    const inputs: InputSocketDef[] = [
      { name: "image", label: "image", type: "image", required: true },
    ];
    if (mode === "velocity") {
      inputs.push({
        name: "vel_uv",
        label: "velocity UV",
        type: "uv",
        required: false,
      });
    }
    return inputs;
  },
  params: [
    {
      name: "mode",
      label: "Mode",
      type: "enum",
      options: ["feedback", "ring", "velocity"],
      default: "feedback",
    },
    {
      name: "decay",
      label: "Decay",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.001,
      default: 0.92,
    },
    {
      name: "blend_mode",
      label: "Blend",
      type: "enum",
      options: BLEND_OPTIONS as unknown as string[],
      default: "max",
      visibleIf: (p) => p.mode === "feedback" || p.mode === "ring",
    },
    {
      name: "step_frames",
      label: "Step (frames)",
      type: "scalar",
      min: 1,
      max: 30,
      step: 1,
      default: 2,
      visibleIf: (p) => p.mode === "ring",
    },
    {
      name: "velocity_x",
      label: "Velocity X",
      type: "scalar",
      min: -0.5,
      max: 0.5,
      step: 0.001,
      default: 0,
      visibleIf: (p) => p.mode === "velocity",
    },
    {
      name: "velocity_y",
      label: "Velocity Y",
      type: "scalar",
      min: -0.5,
      max: 0.5,
      step: 0.001,
      default: 0,
      visibleIf: (p) => p.mode === "velocity",
    },
    {
      name: "taps",
      label: "Taps",
      type: "scalar",
      min: 1,
      max: 64,
      softMax: 32,
      step: 1,
      default: 8,
      visibleIf: (p) => p.mode === "velocity",
    },
    // Hidden counter — the reset header button bumps this, which triggers
    // ensureState to wipe prev.
    {
      name: "_reset_counter",
      label: "Reset counter",
      type: "scalar",
      default: 0,
      hidden: true,
    },
  ],
  primaryOutput: "image",
  auxOutputs: [],

  compute({ inputs, params, ctx, nodeId }) {
    const src = inputs.image;
    if (!src || src.kind !== "image") {
      const out = ctx.allocImage();
      ctx.clearTarget(out, [0, 0, 0, 0]);
      return { primary: out };
    }

    const mode = ((params.mode as string) ?? "feedback") as TrailsMode;
    const decay = Math.max(0, Math.min(1, (params.decay as number) ?? 0.92));
    const resetCounter = (params._reset_counter as number) ?? 0;
    const state = ensureState(ctx, nodeId, mode, resetCounter);
    state.frameCounter += 1;

    const output = ctx.allocImage();

    if (mode === "feedback" || mode === "ring") {
      const stepFrames = Math.max(
        1,
        Math.floor((params.step_frames as number) ?? 2)
      );
      // Ring quantizes history captures: only blend on an on-step frame so
      // visible echoes land at fixed temporal intervals.
      const shouldUpdate =
        mode === "feedback" || state.frameCounter % stepFrames === 0;

      if (!shouldUpdate) {
        // Output unchanged prev; downstream sees the same image as last frame.
        const copy = ctx.getShader("trails/copy", COPY_FS);
        ctx.drawFullscreen(copy, output, (gl) => {
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, state.prev.texture);
          gl.uniform1i(gl.getUniformLocation(copy, "u_src"), 0);
        });
        return { primary: output };
      }

      const blendMode = blendToInt((params.blend_mode as string) ?? "max");
      const prog = ctx.getShader("trails/blend", BLEND_FS);
      ctx.drawFullscreen(prog, output, (gl) => {
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, src.texture);
        gl.uniform1i(gl.getUniformLocation(prog, "u_cur"), 0);
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, state.prev.texture);
        gl.uniform1i(gl.getUniformLocation(prog, "u_prev"), 1);
        gl.uniform1f(gl.getUniformLocation(prog, "u_decay"), decay);
        gl.uniform1i(gl.getUniformLocation(prog, "u_blend"), blendMode);
      });
      // Commit the new output into prev for next frame.
      captureInto(ctx, state, output);
      return { primary: output };
    }

    // Velocity mode.
    const vx = (params.velocity_x as number) ?? 0;
    const vy = (params.velocity_y as number) ?? 0;
    const taps = Math.max(
      1,
      Math.min(64, Math.floor((params.taps as number) ?? 8))
    );
    const velUv = inputs.vel_uv;
    const placeholder = getPlaceholderTex(
      ctx.gl,
      ctx.state,
      `trails:${nodeId}:zero`
    );
    let hasVelUv = 0;
    let velUvTex: WebGLTexture = placeholder;
    if (velUv && velUv.kind === "uv") {
      hasVelUv = 1;
      velUvTex = (velUv as UvValue).texture;
    }

    const prog = ctx.getShader("trails/velocity", VELOCITY_FS);
    ctx.drawFullscreen(prog, output, (gl) => {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, src.texture);
      gl.uniform1i(gl.getUniformLocation(prog, "u_cur"), 0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, state.prev.texture);
      gl.uniform1i(gl.getUniformLocation(prog, "u_prev"), 1);
      gl.uniform2f(gl.getUniformLocation(prog, "u_velocity"), vx, vy);
      gl.uniform1i(gl.getUniformLocation(prog, "u_taps"), taps);
      gl.uniform1f(gl.getUniformLocation(prog, "u_decay"), decay);
      gl.uniform1i(gl.getUniformLocation(prog, "u_hasVelUv"), hasVelUv);
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, velUvTex);
      gl.uniform1i(gl.getUniformLocation(prog, "u_velUv"), 2);
    });
    // Velocity mode remembers raw current input as history; the next frame
    // smears along the new velocity, not the blurred output (avoids runaway
    // compounding of the directional blur).
    captureInto(ctx, state, src);
    return { primary: output };
  },

  dispose(ctx, nodeId) {
    const key = stateKey(nodeId);
    const state = ctx.state[key] as TrailsState | undefined;
    if (state) {
      ctx.releaseTexture(state.prev.texture);
      ctx.releaseTexture(state.scratch.texture);
      delete ctx.state[key];
    }
    disposePlaceholderTex(ctx.gl, ctx.state, `trails:${nodeId}:zero`);
  },
};
