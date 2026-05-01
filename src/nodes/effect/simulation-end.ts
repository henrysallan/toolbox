import type {
  ImageValue,
  InputSocketDef,
  NodeDefinition,
  PointsValue,
  RenderContext,
  SocketType,
  SplineValue,
} from "@/engine/types";
import { ensureZoneState, type SimZoneKind } from "./simulation-start";
import { ensurePointArray, pointsFromArray } from "@/engine/points";

// Simulation Zone — End half. Paired with a Simulation Start via a
// shared `zone_id` param.
//
// Per frame:
//   - Takes the `state` input (the result of whatever compute the zone
//     ran this frame) and stores it as next frame's starting state.
//   - If `skip` is true, doesn't advance — just emits the current
//     stored state so the rest of the graph sees a frozen frame.
//
// Three data kinds — must match the Start's `kind` for the zone to
// behave. A mismatch causes the state blob to reset on next eval.

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

function socketTypeFor(kind: SimZoneKind): SocketType {
  if (kind === "points") return "points";
  if (kind === "spline") return "spline";
  return "image";
}

export const simulationEndNode: NodeDefinition = {
  type: "simulation-end",
  name: "Simulation",
  category: "effect",
  description:
    "Exit point of a simulation zone. Commits the `state` input as next frame's starting state; pass `skip` high to pause advancement without losing state. Set `kind` to match the paired Simulation Start.",
  backend: "webgl2",
  stable: false,
  headerControl: { paramName: "kind" },
  inputs: [
    { name: "state", type: "image", required: true },
    { name: "skip", type: "scalar", required: false },
  ],
  resolveInputs(params): InputSocketDef[] {
    const kind = ((params.kind as string) ?? "image") as SimZoneKind;
    return [
      { name: "state", type: socketTypeFor(kind), required: true },
      { name: "skip", type: "scalar", required: false },
    ];
  },
  params: [
    {
      name: "kind",
      label: "Type",
      type: "enum",
      options: ["image", "points", "spline"],
      default: "image",
    },
    { name: "zone_id", type: "string", default: "", hidden: true },
  ],
  primaryOutput: "image",
  resolvePrimaryOutput(params): SocketType {
    return socketTypeFor(((params.kind as string) ?? "image") as SimZoneKind);
  },
  auxOutputs: [],

  fingerprintExtras(params, ctx) {
    return `z:${params.zone_id}|k:${params.kind ?? "image"}|t:${ctx.time.toFixed(4)}`;
  },

  compute({ inputs, params, ctx }) {
    const zoneId = (params.zone_id as string) ?? "";
    const kind = ((params.kind as string) ?? "image") as SimZoneKind;
    if (!zoneId) {
      if (kind === "points") {
        return { primary: pointsFromArray([]) satisfies PointsValue };
      }
      if (kind === "spline") {
        return {
          primary: { kind: "spline", subpaths: [] } satisfies SplineValue,
        };
      }
      const out = ctx.allocImage();
      ctx.clearTarget(out, [0, 0, 0, 0]);
      return { primary: out };
    }
    const state = ensureZoneState(ctx, zoneId, kind);
    const skip = inputs.skip?.kind === "scalar" ? inputs.skip.value > 0.5 : false;
    const stateInput = inputs.state;

    if (state.kind === "image") {
      if (skip || !stateInput || stateInput.kind !== "image") {
        // Pass through — emit read tex (what Start emitted this frame).
        // No swap, so next frame's Start sees the same state.
        return {
          primary: {
            kind: "image",
            texture: state.readTex,
            width: state.width,
            height: state.height,
          } satisfies ImageValue,
        };
      }
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
      return {
        primary: {
          kind: "image",
          texture: state.readTex,
          width: state.width,
          height: state.height,
        } satisfies ImageValue,
      };
    }

    if (state.kind === "points") {
      if (skip || !stateInput || stateInput.kind !== "points") {
        return {
          primary: pointsFromArray(state.points) satisfies PointsValue,
        };
      }
      // CPU array swap: the input is already a fresh array produced this
      // frame, so we can just retain it. No copy needed — the state
      // reference IS the new authoritative value.
      state.points = ensurePointArray(stateInput);
      return {
        primary: pointsFromArray(state.points) satisfies PointsValue,
      };
    }

    // spline
    if (skip || !stateInput || stateInput.kind !== "spline") {
      return {
        primary: {
          kind: "spline",
          subpaths: state.subpaths,
        } satisfies SplineValue,
      };
    }
    state.subpaths = stateInput.subpaths;
    return {
      primary: {
        kind: "spline",
        subpaths: state.subpaths,
      } satisfies SplineValue,
    };
  },

  dispose(ctx, _nodeId) {
    void _nodeId;
    void ctx;
    // Texture cleanup deferred to render-context teardown for v1 — same
    // approach as image-only zones used. Future: stash zone_id at
    // dispose time so we can release ping-pong textures eagerly.
  },
};
