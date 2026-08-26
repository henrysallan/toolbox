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

// Current frame over faded history. Decay scales history alpha only —
// RGB of each echo stays the original color, just more transparent.
// Straight-alpha src-over (same formula as Merge).
export const OVER_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_cur;
uniform sampler2D u_prev;
uniform float u_decay;
out vec4 outColor;

void main() {
  vec4 c = texture(u_cur, v_uv);
  vec4 p = texture(u_prev, v_uv);
  float pA = p.a * u_decay;
  float outA = c.a + pA * (1.0 - c.a);
  vec3 outRgb;
  if (outA < 1e-4) {
    outRgb = vec3(0.0);
  } else {
    outRgb = (c.rgb * c.a + p.rgb * pA * (1.0 - c.a)) / outA;
  }
  outColor = vec4(outRgb, outA);
}`;

// History-only fade: RGB stays put, alpha scales. Used for the `trail` aux
// (echoes without the current frame) and as a decayed source for `over`.
export const FADE_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_src;
uniform float u_decay;
out vec4 outColor;
void main() {
  vec4 p = texture(u_src, v_uv);
  outColor = vec4(p.rgb, p.a * u_decay);
}`;

// Velocity directional blur. Samples prev N times backwards along the
// velocity vector, falling off geometrically by u_decay per tap. When a
// per-pixel UV-velocity field is connected, u_hasVelUv = 1 and we read the
// local velocity from it instead of using the global uniform.
export const VELOCITY_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_cur;
uniform sampler2D u_prev;
uniform vec2 u_velocity;
uniform int u_taps;
uniform float u_decay;
uniform int u_hasVelUv;
uniform sampler2D u_velUv;
uniform int u_includeCur;
out vec4 outColor;

void main() {
  vec4 c = texture(u_cur, v_uv);
  vec2 vel = u_hasVelUv == 1 ? (texture(u_velUv, v_uv).rg - 0.5) * 2.0 : u_velocity;
  vec4 acc = u_includeCur == 1 ? c : vec4(0.0);
  float wsum = u_includeCur == 1 ? 1.0 : 0.0;
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
  if (wsum < 1e-4) {
    outColor = vec4(0.0);
  } else {
    outColor = acc / wsum;
  }
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
  // Last ctx.time we considered for the play-gate. -1 so the first playing
  // eval after a reset always counts as a time change.
  lastTime: number;
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

  if (!shouldReset) {
    if (typeof existing.lastTime !== "number") existing.lastTime = -1;
    return existing;
  }

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
    lastTime: -1,
  };
  ctx.state[key] = state;
  return state;
}

// Fullscreen blit. captureInto uses this into the ping-pong scratch.
function copyImage(
  ctx: RenderContext,
  src: ImageValue,
  dest: ImageValue
): void {
  const prog = ctx.getShader("trails/copy", COPY_FS);
  ctx.drawFullscreen(prog, dest, (gl) => {
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, src.texture);
    gl.uniform1i(gl.getUniformLocation(prog, "u_src"), 0);
  });
}

function fadeImage(
  ctx: RenderContext,
  src: ImageValue,
  dest: ImageValue,
  decay: number
): void {
  if (decay >= 1 - 1e-6) {
    copyImage(ctx, src, dest);
    return;
  }
  const prog = ctx.getShader("trails/fade", FADE_FS);
  ctx.drawFullscreen(prog, dest, (gl) => {
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, src.texture);
    gl.uniform1i(gl.getUniformLocation(prog, "u_src"), 0);
    gl.uniform1f(gl.getUniformLocation(prog, "u_decay"), decay);
  });
}

function captureInto(
  ctx: RenderContext,
  state: TrailsState,
  src: ImageValue
): void {
  copyImage(ctx, src, state.scratch);
  // Swap: scratch now holds the newly-captured frame, prev becomes the
  // write target for future passes.
  const tmp = state.prev;
  state.prev = state.scratch;
  state.scratch = tmp;
}

function resultOf(
  primary: ImageValue,
  trail: ImageValue | null
): { primary: ImageValue; aux?: { trail: ImageValue } } {
  return trail ? { primary, aux: { trail } } : { primary };
}

function compositeOver(
  ctx: RenderContext,
  cur: ImageValue,
  prev: ImageValue,
  dest: ImageValue,
  decay: number
): void {
  const prog = ctx.getShader("trails/over", OVER_FS);
  ctx.drawFullscreen(prog, dest, (gl) => {
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, cur.texture);
    gl.uniform1i(gl.getUniformLocation(prog, "u_cur"), 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, prev.texture);
    gl.uniform1i(gl.getUniformLocation(prog, "u_prev"), 1);
    gl.uniform1f(gl.getUniformLocation(prog, "u_decay"), decay);
  });
}

function drawVelocity(
  ctx: RenderContext,
  dest: ImageValue,
  src: ImageValue,
  prev: ImageValue,
  vx: number,
  vy: number,
  taps: number,
  decay: number,
  hasVelUv: number,
  velUvTex: WebGLTexture,
  includeCur: boolean
): void {
  const prog = ctx.getShader("trails/velocity-v2", VELOCITY_FS);
  ctx.drawFullscreen(prog, dest, (gl) => {
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, src.texture);
    gl.uniform1i(gl.getUniformLocation(prog, "u_cur"), 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, prev.texture);
    gl.uniform1i(gl.getUniformLocation(prog, "u_prev"), 1);
    gl.uniform2f(gl.getUniformLocation(prog, "u_velocity"), vx, vy);
    gl.uniform1i(gl.getUniformLocation(prog, "u_taps"), taps);
    gl.uniform1f(gl.getUniformLocation(prog, "u_decay"), decay);
    gl.uniform1i(gl.getUniformLocation(prog, "u_hasVelUv"), hasVelUv);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, velUvTex);
    gl.uniform1i(gl.getUniformLocation(prog, "u_velUv"), 2);
    gl.uniform1i(
      gl.getUniformLocation(prog, "u_includeCur"),
      includeCur ? 1 : 0
    );
  });
}

// ─── Node ──────────────────────────────────────────────────────────────────

export const trailsNode: NodeDefinition = {
  type: "trails",
  name: "Trails",
  category: "image",
  subcategory: "modifier",
  description:
    "Temporal trails — each echo is a faded copy of an earlier frame (opacity only, no color mix). Primary is the current frame over the echoes; the trail aux is echoes only. Feedback: continuous motion trail. Ring: stepped stop-motion echoes. Velocity: directional motion blur along a vector or UV field. History advances only while the timeline plays.",
  backend: "webgl2",
  // Time-dependent by nature — each eval reads last frame's output.
  stable: false,
  simulation: true,
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
  auxOutputs: [
    {
      name: "trail",
      type: "image",
      label: "trail",
      description:
        "Faded echoes only — the current frame is not composited on top.",
    },
  ],

  compute({ inputs, params, ctx, nodeId, consumedOutputs }) {
    const wantTrail =
      !consumedOutputs || consumedOutputs.has("aux:trail");
    const allocTrail = (): ImageValue | null => {
      if (!wantTrail) return null;
      const t = ctx.allocImage();
      ctx.clearTarget(t, [0, 0, 0, 0]);
      return t;
    };

    const src = inputs.image;
    if (!src || src.kind !== "image") {
      const out = ctx.allocImage();
      ctx.clearTarget(out, [0, 0, 0, 0]);
      return resultOf(out, allocTrail());
    }

    const mode = ((params.mode as string) ?? "feedback") as TrailsMode;
    const decay = Math.max(0, Math.min(1, (params.decay as number) ?? 0.92));
    const resetCounter = (params._reset_counter as number) ?? 0;
    const state = ensureState(ctx, nodeId, mode, resetCounter);

    // House sim contract: history only advances while the timeline is
    // playing (or an offline export is stepping). Same-time re-evals —
    // paused param tweaks, cursor, split-view second pass, export settle
    // re-render — freeze the buffer so trails don't keep decaying or
    // picking up extra echoes. Time going backward (loop wrap) still
    // counts as a change so the next loop doesn't freeze.
    const timeChanged = Math.abs(ctx.time - state.lastTime) > 1e-6;
    const active = (ctx.playing || ctx.offline) && timeChanged;
    state.lastTime = ctx.time;

    const output = ctx.allocImage();

    if (mode === "feedback" || mode === "ring") {
      const stepFrames = Math.max(
        1,
        Math.floor((params.step_frames as number) ?? 2)
      );
      if (active) state.frameCounter += 1;
      // Ring quantizes history captures: only commit on an on-step frame
      // so visible echoes land at fixed temporal intervals.
      const shouldCapture =
        active &&
        (mode === "feedback" || state.frameCounter % stepFrames === 0);
      const fade = shouldCapture ? decay : 1;

      if (mode === "ring" && active && !shouldCapture) {
        // Stop-motion hold: primary is the last captured composite. Trail
        // aux copies that same freeze (the hold has no separate live current
        // to strip — the next on-step frame will).
        copyImage(ctx, state.prev, output);
        const trail = wantTrail ? ctx.allocImage() : null;
        if (trail) fadeImage(ctx, state.prev, trail, fade);
        return resultOf(output, trail);
      }

      // Trail aux = faded history without this frame's current. Primary
      // then sits current over that. Paused evals use fade=1 so history
      // doesn't decay, and we skip capture so the live frame isn't baked in.
      const trail = wantTrail ? ctx.allocImage() : null;
      if (trail) {
        fadeImage(ctx, state.prev, trail, fade);
        compositeOver(ctx, src, trail, output, 1);
      } else {
        compositeOver(ctx, src, state.prev, output, fade);
      }
      if (shouldCapture) captureInto(ctx, state, output);
      return resultOf(output, trail);
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

    drawVelocity(
      ctx,
      output,
      src,
      state.prev,
      vx,
      vy,
      taps,
      decay,
      hasVelUv,
      velUvTex,
      true
    );
    const trail = wantTrail ? ctx.allocImage() : null;
    if (trail) {
      drawVelocity(
        ctx,
        trail,
        src,
        state.prev,
        vx,
        vy,
        taps,
        decay,
        hasVelUv,
        velUvTex,
        false
      );
    }
    // Velocity mode remembers raw current input as history; the next frame
    // smears along the new velocity, not the blurred output (avoids runaway
    // compounding of the directional blur). Skip the capture while paused.
    if (active) captureInto(ctx, state, src);
    return resultOf(output, trail);
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
