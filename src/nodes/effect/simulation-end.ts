import type {
  ImageValue,
  NodeDefinition,
  RenderContext,
} from "@/engine/types";
import { ensureZoneState } from "./simulation-start";

// Simulation Zone — End half. Paired with a Simulation Start via a
// shared `zone_id` param.
//
// Per frame:
//   - Takes the `state` input (the result of whatever compute the zone
//     ran this frame) and blits it into the zone's write buffer.
//   - If `skip` is true, doesn't advance — just emits the read buffer
//     (same as what Start emitted this frame) so the rest of the graph
//     sees a frozen state.
//   - Swaps read/write so NEXT frame's Start reads this frame's output.
//
// Emits the just-committed state as its primary output — that's what
// downstream nodes outside the zone see.

const COPY_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_src;
out vec4 outColor;
void main() {
  outColor = texture(u_src, v_uv);
}`;

function blitInto(
  ctx: RenderContext,
  srcTex: WebGLTexture,
  dstTex: WebGLTexture,
  width: number,
  height: number
) {
  const dst: ImageValue = { kind: "image", texture: dstTex, width, height };
  const prog = ctx.getShader("sim-zone/copy", COPY_FS);
  ctx.drawFullscreen(prog, dst, (gl) => {
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, srcTex);
    gl.uniform1i(gl.getUniformLocation(prog, "u_src"), 0);
  });
}

export const simulationEndNode: NodeDefinition = {
  type: "simulation-end",
  name: "Simulation",
  category: "effect",
  description:
    "Exit point of a simulation zone. Commits the `state` input as next frame's starting state; pass `skip` high to pause advancement without losing state.",
  backend: "webgl2",
  stable: false,
  inputs: [
    { name: "state", type: "image", required: true },
    { name: "skip", type: "scalar", required: false },
  ],
  params: [
    { name: "zone_id", type: "string", default: "", hidden: true },
  ],
  primaryOutput: "image",
  auxOutputs: [],

  fingerprintExtras(params, ctx) {
    return `z:${params.zone_id}|t:${ctx.time.toFixed(4)}`;
  },

  compute({ inputs, params, ctx }) {
    const zoneId = (params.zone_id as string) ?? "";
    if (!zoneId) {
      const out = ctx.allocImage();
      ctx.clearTarget(out, [0, 0, 0, 0]);
      return { primary: out };
    }
    const state = ensureZoneState(ctx, zoneId);
    const skip = inputs.skip?.kind === "scalar" ? inputs.skip.value > 0.5 : false;
    const stateInput = inputs.state;

    if (skip || !stateInput || stateInput.kind !== "image") {
      // Pass through — emit read tex (what Start emitted this frame).
      // No swap, so next frame's Start sees the same state. That's
      // exactly the "pause the sim" semantic.
      return {
        primary: {
          kind: "image",
          texture: state.readTex,
          width: state.width,
          height: state.height,
        } satisfies ImageValue,
      };
    }

    // Commit: copy `state` input into the write buffer, then swap
    // read/write so next frame's Start reads this frame's output.
    blitInto(
      ctx,
      stateInput.texture,
      state.writeTex,
      state.width,
      state.height
    );
    const tmp = state.readTex;
    state.readTex = state.writeTex;
    state.writeTex = tmp;

    // Emit the just-committed state (now in readTex after the swap).
    // Downstream nodes outside the zone see this.
    return {
      primary: {
        kind: "image",
        texture: state.readTex,
        width: state.width,
        height: state.height,
      } satisfies ImageValue,
    };
  },

  // End is the owner of the zone's persistent textures in our
  // cleanup contract — if End gets disposed, tear down the zone. Start's
  // dispose is a no-op. (Both fire together on pair deletion, but we
  // only need one side to release.)
  dispose(ctx, _nodeId) {
    void _nodeId;
    // Find the zone_id from the currently-evaluating params. The
    // dispose hook doesn't get params; we'd need to store them. Skip
    // per-node teardown for v1 — textures outlive pair deletion until
    // the render context itself is torn down. Small leak, acceptable
    // for v1 since recreating a zone reuses the same texture pool on
    // subsequent allocImage calls anyway.
    void ctx;
  },
};
