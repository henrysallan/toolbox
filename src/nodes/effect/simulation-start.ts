import type {
  ImageValue,
  InputSocketDef,
  NodeDefinition,
  PointsValue,
  RenderContext,
  SocketType,
  SplineSubpath,
  SplineValue,
} from "@/engine/types";
import { clonePoints, EMPTY_POINTS } from "@/engine/points";

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
// Three data kinds are supported. The state envelope discriminates on
// kind so a mid-run kind toggle resets the zone instead of crashing:
//
//   - image   : ping-pong pair of persistent GL textures. End blits
//               its `state` input into writeTex then swaps refs.
//   - points  : a single typed-array PointsValue — End just replaces it.
//   - spline  : a single CPU array of SplineSubpath — same idea.
//
// CPU-side kinds don't need ping-pong because their inputs are
// already immutable values produced fresh each frame; the previous
// frame's value can be dropped as soon as the new one is stored.

const COPY_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_src;
out vec4 outColor;
void main() {
  outColor = texture(u_src, v_uv);
}`;

export type SimZoneKind = "image" | "points" | "spline";

interface SimZoneStateImage {
  kind: "image";
  // Ping-pong pair. `readTex` is what Start emits this frame (last
  // frame's End output or the initial value). End writes into `writeTex`
  // and then swaps references so next frame's read reflects this frame.
  readTex: WebGLTexture;
  writeTex: WebGLTexture;
  width: number;
  height: number;
  initialized: boolean;
  lastTime: number;
}

interface SimZoneStatePoints {
  kind: "points";
  // Single typed-array PointsValue — replaced wholesale each frame by
  // End. Stored in the typed-array shape (not the legacy Point[] view)
  // so the hot per-frame path never round-trips through Point objects;
  // End retains the fresh value by reference, Start re-emits it.
  value: PointsValue;
  initialized: boolean;
  lastTime: number;
}

interface SimZoneStateSpline {
  kind: "spline";
  subpaths: SplineSubpath[];
  initialized: boolean;
  lastTime: number;
}

export type SimZoneState =
  | SimZoneStateImage
  | SimZoneStatePoints
  | SimZoneStateSpline;

export function zoneStateKey(zoneId: string): string {
  return `sim-zone:${zoneId}`;
}

// Allocate a fresh state for the requested kind. If existing state of a
// different kind (or for image, a different size) is present, tear it
// down first.
export function ensureZoneState(
  ctx: RenderContext,
  zoneId: string,
  kind: SimZoneKind
): SimZoneState {
  const key = zoneStateKey(zoneId);
  const existing = ctx.state[key] as SimZoneState | undefined;

  if (existing && existing.kind === kind) {
    if (existing.kind === "image") {
      if (existing.width === ctx.width && existing.height === ctx.height) {
        return existing;
      }
      // Canvas resized — release and reallocate.
      ctx.releaseTexture(existing.readTex);
      ctx.releaseTexture(existing.writeTex);
    } else {
      return existing;
    }
  } else if (existing) {
    // Kind switched mid-run. Release any GL textures we owned.
    if (existing.kind === "image") {
      ctx.releaseTexture(existing.readTex);
      ctx.releaseTexture(existing.writeTex);
    }
  }

  if (kind === "image") {
    const read = ctx.allocImage({ width: ctx.width, height: ctx.height });
    const write = ctx.allocImage({ width: ctx.width, height: ctx.height });
    ctx.clearTarget(read, [0, 0, 0, 0]);
    ctx.clearTarget(write, [0, 0, 0, 0]);
    const state: SimZoneStateImage = {
      kind: "image",
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

  if (kind === "points") {
    const state: SimZoneStatePoints = {
      kind: "points",
      value: EMPTY_POINTS,
      initialized: false,
      lastTime: ctx.time,
    };
    ctx.state[key] = state;
    return state;
  }

  const state: SimZoneStateSpline = {
    kind: "spline",
    subpaths: [],
    initialized: false,
    lastTime: ctx.time,
  };
  ctx.state[key] = state;
  return state;
}

// Copy an arbitrary ImageValue into a raw texture target. Used to seed
// the zone from the `initial` input on reset.
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

function socketTypeFor(kind: SimZoneKind): SocketType {
  if (kind === "points") return "points";
  if (kind === "spline") return "spline";
  return "image";
}

export const simulationStartNode: NodeDefinition = {
  type: "simulation-start",
  name: "Simulation",
  category: "effect",
  description:
    "Entry point of a simulation zone. Emits last frame's End output; feeds the `initial` input on frame 0 or after a scene-time reset. Supports image, points, and spline data — set the matching kind on both the Start and End sides.",
  backend: "webgl2",
  // Unstable — output depends on the persistent zone state, not just
  // params + inputs. We force re-eval each tick via ctx.time in the
  // fingerprint (see fingerprintExtras).
  stable: false,
  headerControl: { paramName: "kind" },
  inputs: [{ name: "initial", type: "image", required: false }],
  resolveInputs(params): InputSocketDef[] {
    const kind = ((params.kind as string) ?? "image") as SimZoneKind;
    return [{ name: "initial", type: socketTypeFor(kind), required: false }];
  },
  params: [
    {
      name: "kind",
      label: "Type",
      type: "enum",
      options: ["image", "points", "spline"],
      default: "image",
    },
    // Hidden — auto-generated when the pair is created, user never
    // edits it. Shared with the paired End node so they find the same
    // state blob.
    { name: "zone_id", type: "string", default: "", hidden: true },
  ],
  primaryOutput: "image",
  resolvePrimaryOutput(params): SocketType {
    return socketTypeFor(((params.kind as string) ?? "image") as SimZoneKind);
  },
  auxOutputs: [],

  // Include zone_id + kind so two zones in the same graph don't collide
  // and a kind toggle busts the cache. The reset-on-time-wrap behavior
  // needs ctx.time too — otherwise a paused scene would cache stale.
  fingerprintExtras(params, ctx) {
    return `z:${params.zone_id}|k:${params.kind ?? "image"}|t:${ctx.time.toFixed(4)}`;
  },

  compute({ inputs, params, ctx }) {
    const zoneId = (params.zone_id as string) ?? "";
    const kind = ((params.kind as string) ?? "image") as SimZoneKind;
    if (!zoneId) {
      // Unconfigured pair — emit an empty value of the right kind.
      if (kind === "points") {
        return { primary: EMPTY_POINTS };
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

    // Reset detection: if the scene time wrapped from >0 back to near 0
    // (RAF loop, or scrub to start), re-seed from the `initial` input.
    const wasNonZero = state.lastTime > 0.05;
    const isNearZero = ctx.time < 0.05;
    const shouldReset = !state.initialized || (wasNonZero && isNearZero);

    if (state.kind === "image") {
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
      return {
        // The texture is the zone's persistent ping-pong state — the
        // evaluator must not release it (see NodeOutput.ownsTextures).
        ownsTextures: false,
        primary: {
          kind: "image",
          texture: state.readTex,
          width: state.width,
          height: state.height,
        } satisfies ImageValue,
      };
    }

    if (state.kind === "points") {
      if (shouldReset) {
        const initial = inputs.initial;
        // Snapshot the seed so the zone evolves its own copy — the
        // `initial` upstream keeps producing its (possibly cached) value.
        state.value =
          initial && initial.kind === "points"
            ? clonePoints(initial)
            : EMPTY_POINTS;
        state.initialized = true;
      }
      state.lastTime = ctx.time;
      return { primary: state.value };
    }

    // spline
    if (shouldReset) {
      const initial = inputs.initial;
      state.subpaths =
        initial && initial.kind === "spline"
          ? initial.subpaths.map(cloneSubpath)
          : [];
      state.initialized = true;
    }
    state.lastTime = ctx.time;
    return {
      primary: {
        kind: "spline",
        subpaths: state.subpaths,
      } satisfies SplineValue,
    };
  },

  dispose(ctx, _nodeId) {
    // We DON'T release zone textures here — the paired End node's
    // dispose handles that (since either node's dispose running
    // without the other means the pair is broken anyway).
    void ctx;
    void _nodeId;
  },
};

function cloneSubpath(sp: SplineSubpath): SplineSubpath {
  return {
    closed: sp.closed,
    groupIndex: sp.groupIndex,
    anchors: sp.anchors.map((a) => ({
      pos: [a.pos[0], a.pos[1]],
      inHandle: a.inHandle ? [a.inHandle[0], a.inHandle[1]] : undefined,
      outHandle: a.outHandle ? [a.outHandle[0], a.outHandle[1]] : undefined,
    })),
  };
}
