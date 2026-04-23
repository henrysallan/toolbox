import type {
  ImageValue,
  NodeDefinition,
  RenderContext,
} from "@/engine/types";

// Simulation Zone — Start half.
//
// This node is the ENTRY to a feedback loop. Every frame it emits what
// the paired Simulation End wrote last frame (the "state"), letting the
// zone in between transform state → new state. On frame 0 (or after a
// scene-time wrap) it emits the `initial` input instead so the sim has
// a clean slate to evolve from.
//
// The pair is identified by a shared `zone_id` param, auto-generated
// when the pair is created and NEVER edited by the user. End stores
// its computed state in ctx.state[`sim-zone:${zone_id}`]; Start reads
// it back here.
//
// Textures are persistent (owned by this pair) and ping-pong each frame
// — same pattern as Trails. We don't allocate through ctx.allocImage
// because the evaluator would reclaim those between frames.

const COPY_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_src;
out vec4 outColor;
void main() {
  outColor = texture(u_src, v_uv);
}`;

export interface SimZoneState {
  // Ping-pong pair. `readTex` is what Start emits this frame (last
  // frame's End output or the initial value). End writes into `writeTex`
  // and then swaps references so next frame's read reflects this frame.
  readTex: WebGLTexture;
  writeTex: WebGLTexture;
  width: number;
  height: number;
  // Has at least one frame run? Gates the "use initial input" branch.
  initialized: boolean;
  // Track last eval's scene time — if the current time is near 0 and the
  // previous was non-zero, treat it as a loop/reset boundary.
  lastTime: number;
}

export function zoneStateKey(zoneId: string): string {
  return `sim-zone:${zoneId}`;
}

export function ensureZoneState(
  ctx: RenderContext,
  zoneId: string
): SimZoneState {
  const key = zoneStateKey(zoneId);
  const existing = ctx.state[key] as SimZoneState | undefined;
  if (existing && existing.width === ctx.width && existing.height === ctx.height) {
    return existing;
  }
  // New zone or canvas resize — (re)allocate the pair. If we had a prior
  // state at a different size, release its textures first.
  if (existing) {
    ctx.releaseTexture(existing.readTex);
    ctx.releaseTexture(existing.writeTex);
  }
  // Allocate via allocImage so we get the pipeline's RGBA16F format.
  // These are PERSISTENT — we never pass them back to the pool
  // (`releaseTexture`) until the zone itself is torn down.
  const read = ctx.allocImage({ width: ctx.width, height: ctx.height });
  const write = ctx.allocImage({ width: ctx.width, height: ctx.height });
  ctx.clearTarget(read, [0, 0, 0, 0]);
  ctx.clearTarget(write, [0, 0, 0, 0]);
  const state: SimZoneState = {
    readTex: read.texture,
    writeTex: write.texture,
    width: ctx.width,
    height: ctx.height,
    initialized: false,
    lastTime: ctx.time,
  };
  ctx.state[key] = state;
  return state;
}

// Copy an arbitrary ImageValue into a raw texture target. Used to seed
// the zone from the `initial` input on reset. We can't release the
// persistent target texture after — it's owned by the zone.
function blitInto(
  ctx: RenderContext,
  src: ImageValue,
  dstTex: WebGLTexture,
  width: number,
  height: number
) {
  const dst: ImageValue = {
    kind: "image",
    texture: dstTex,
    width,
    height,
  };
  const prog = ctx.getShader("sim-zone/copy", COPY_FS);
  ctx.drawFullscreen(prog, dst, (gl) => {
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, src.texture);
    gl.uniform1i(gl.getUniformLocation(prog, "u_src"), 0);
  });
}

export const simulationStartNode: NodeDefinition = {
  type: "simulation-start",
  name: "Simulation",
  category: "effect",
  description:
    "Entry point of a simulation zone. Emits last frame's End output; feeds the `initial` input on frame 0 or after a scene-time reset.",
  backend: "webgl2",
  // Unstable — output depends on the persistent zone state, not just
  // params + inputs. We force re-eval each tick via ctx.time in the
  // fingerprint (see fingerprintExtras).
  stable: false,
  inputs: [{ name: "initial", type: "image", required: false }],
  params: [
    // Hidden — auto-generated when the pair is created, user never
    // edits it. Shared with the paired End node so they find the same
    // state blob.
    { name: "zone_id", type: "string", default: "", hidden: true },
  ],
  primaryOutput: "image",
  auxOutputs: [],

  // Include the zone_id so two zones in the same graph don't collide
  // on fingerprint. The reset-on-time-wrap behavior needs ctx.time in
  // the fingerprint too — otherwise a paused scene would cache stale.
  fingerprintExtras(params, ctx) {
    return `z:${params.zone_id}|t:${ctx.time.toFixed(4)}`;
  },

  compute({ inputs, params, ctx }) {
    const zoneId = (params.zone_id as string) ?? "";
    if (!zoneId) {
      // Unconfigured pair — treat as identity passthrough.
      const out = ctx.allocImage();
      ctx.clearTarget(out, [0, 0, 0, 0]);
      return { primary: out };
    }
    const state = ensureZoneState(ctx, zoneId);

    // Reset detection: if the scene time wrapped from >0 back to near 0
    // (RAF loop, or scrub to start), re-seed from the `initial` input.
    const wasNonZero = state.lastTime > 0.05;
    const isNearZero = ctx.time < 0.05;
    const shouldReset = !state.initialized || (wasNonZero && isNearZero);

    if (shouldReset) {
      const initial = inputs.initial;
      if (initial && initial.kind === "image") {
        blitInto(ctx, initial, state.readTex, state.width, state.height);
      } else {
        ctx.clearTarget(
          {
            kind: "image",
            texture: state.readTex,
            width: state.width,
            height: state.height,
          },
          [0, 0, 0, 0]
        );
      }
      state.initialized = true;
    }
    state.lastTime = ctx.time;

    // Emit the READ texture — Start and downstream nodes in the zone
    // see "state at the start of this frame." End will later write into
    // writeTex and swap, so subsequent frames' reads reflect this
    // frame's output.
    return {
      primary: {
        kind: "image",
        texture: state.readTex,
        width: state.width,
        height: state.height,
      } satisfies ImageValue,
    };
  },

  dispose(ctx, _nodeId) {
    // We DON'T release zone textures here — the paired End node's
    // dispose handles that (since either node's dispose running
    // without the other means the pair is broken anyway). The zone
    // state is keyed by zone_id, which survives until both sides go.
    // In practice both fire on node deletion so only one needs to
    // do the cleanup; we pick End (see simulation-end.ts).
    void ctx;
    void _nodeId;
  },
};
