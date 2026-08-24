import {
  disposeEvalCache,
  evaluateGraph,
  type EvalCache,
  type GraphEdge,
  type GraphNode,
} from "@/engine/evaluator";
import {
  TIME_OFFSET_CARRIED_TYPES,
  TIME_OFFSET_FEED_TYPE,
  TIME_OFFSET_STASH_KEY,
  TIME_OFFSET_TYPE,
  type TimeOffsetStash,
} from "@/engine/time-offset";
import type {
  ImageValue,
  InputSocketDef,
  MaskValue,
  NodeDefinition,
  RenderContext,
  ResolveCtx,
  SocketType,
  SocketValue,
  UvValue,
} from "@/engine/types";

// Time Offset (specdocs/081426_time-offset.md, Part 1). Drop it onto any
// wire and everything upstream of `in` re-evaluates at `tick − offset`:
// keyframes, clip windows, Scene Time / LFO / procedural animation — the
// whole branch plays shifted by the given number of frames. Positive
// offset = later (samples the past, AE convention); negative looks ahead,
// which pure upstreams support exactly (keyframes clamp at their ends).
//
// Mechanically this is a one-pass Iterate: the evaluator stashes the
// upstream closure (engine/time-offset.ts — the branch STAYS in the outer
// graph for other consumers; we hold references), and compute re-runs it
// through a nested evaluateGraph over a private cache with the clock
// shifted. Non-retimeable upstream nodes (video / webcam / audio / cursor
// / trackers / every simulation — anything that can't exist at two clocks
// in one eval) are closure BOUNDARIES: their outer value arrives on hidden
// mirror inputs and a synthetic feed node re-emits it un-shifted inside
// the nested pass. Chained Time Offsets are rejected — sum into one node's
// offset instead (spec Decision 3).
//
// Texture lifetime: the nested pass's next run releases its previous
// transients, and private-cache entries can be evicted under the outer
// consumer — so a texture-backed result is copied into a node-owned
// texture immediately (the Iterate copy-out pattern; freed at the next
// compute and in dispose, emitted with ownsTextures:false). CPU values
// pass by reference — consumers treat SocketValues as immutable and
// private-cache eviction only releases textures.
//
// The offset param is wirable/keyframable like any scalar param — its own
// keyframes sample on the OUTER clock (this node retimes upstream, not
// itself) — so LFO- or audio-driven time warping falls out for free.
//
// v1 scope: the `in` socket carries TIME_OFFSET_CARRIED_TYPES only (plain
// CPU values + canvas textures). The stream is exactly one output handle —
// upstream aux outputs don't tunnel through.

const RESTING_TYPE: SocketType = "scalar";

const COPY_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_src;
out vec4 outColor;
void main() { outColor = texture(u_src, v_uv); }`;

interface TimeOffsetState {
  cache: EvalCache;
  // Bumped per compute; the feed def folds it into its fingerprint so the
  // private cache re-runs boundary-fed branches when the outer value
  // changes (the iterate-feed runId contract).
  runId: number;
  // Textures backing the current output (node-owned).
  owned: WebGLTexture[];
  // Last closure hash we warned about boundary feeds for, so the console
  // warning fires once per structure rather than every eval.
  warnedHash?: string;
}

function ensureState(ctx: RenderContext, nodeId: string): TimeOffsetState {
  const key = `${TIME_OFFSET_TYPE}:${nodeId}`;
  const existing = ctx.state[key] as TimeOffsetState | undefined;
  if (existing) return existing;
  const s: TimeOffsetState = { cache: new Map(), runId: 0, owned: [] };
  ctx.state[key] = s;
  return s;
}

function carriedType(
  _params: Record<string, unknown>,
  ctx?: ResolveCtx
): SocketType {
  const wired = ctx?.connectedTypes?.in;
  return wired && TIME_OFFSET_CARRIED_TYPES.includes(wired)
    ? wired
    : RESTING_TYPE;
}

export const timeOffsetNode: NodeDefinition = {
  type: TIME_OFFSET_TYPE,
  name: "Time Offset",
  category: "utility",
  description:
    "Shifts everything upstream in time: the branch wired into it re-evaluates at the playhead minus Offset (in frames), so its keyframes, clips, and procedural animation play later — or earlier with a negative offset. Wire or keyframe Offset for time-warping. Live and simulated nodes upstream (video, webcam, audio, cursor, sims) can't time-travel and pass through un-shifted.",
  searchAliases: ["delay", "retime", "shift", "timeshift", "echo"],
  backend: "webgl2",
  noMaskInput: true,
  inputs: [{ name: "in", type: RESTING_TYPE, required: false, label: "In" }],
  resolveInputs(params, ctx): InputSocketDef[] {
    return [
      {
        name: "in",
        type: carriedType(params, ctx),
        required: false,
        label: "In",
      },
    ];
  },
  params: [
    {
      name: "offset",
      label: "Offset (frames)",
      type: "scalar",
      min: -10000,
      max: 10000,
      softMax: 120,
      step: 0.5,
      default: 0,
    },
  ],
  primaryOutput: RESTING_TYPE,
  resolvePrimaryOutput(params, ctx): SocketType {
    return carriedType(params, ctx);
  },
  auxOutputs: [],

  // Member edits (params, keyframes, wiring, clips) must bust the outer
  // cache — the evaluator precomputes the closure hash into the stash, and
  // appends the scoped tick when the closure is time-driven (so a paused
  // playhead keeps the cache warm while a static upstream stays cached
  // across the whole timeline).
  fingerprintExtras(_params, ctx, nodeId) {
    if (!nodeId) return "";
    const stash = ctx.state[TIME_OFFSET_STASH_KEY] as
      | TimeOffsetStash
      | undefined;
    const entry = stash?.get(nodeId);
    if (!entry) return "";
    return entry.timeDriven ? `${entry.hash}|t:${ctx.tick}` : entry.hash ?? "";
  },

  compute({ inputs, params, ctx, nodeId }) {
    const stash = ctx.state[TIME_OFFSET_STASH_KEY] as
      | TimeOffsetStash
      | undefined;
    const entry = stash?.get(nodeId);
    if (!entry || !entry.tap) return {};
    if (entry.chained) {
      throw new Error(
        "Time Offset can't be wired through another Time Offset — add the offsets into one node instead."
      );
    }

    const state = ensureState(ctx, nodeId);
    if (entry.boundaryTypes.length > 0 && state.warnedHash !== entry.hash) {
      state.warnedHash = entry.hash;
      console.warn(
        `[time-offset] upstream contains live/simulated nodes that can't ` +
          `time-travel — passed through un-shifted: ${entry.boundaryTypes.join(", ")}`
      );
    }

    // Tap producer itself is a boundary — pure passthrough of the outer
    // value (the `in` edge stayed in the outer needed set for this case).
    if (entry.tapIsBoundary) {
      const v = inputs.in;
      return v ? { primary: v, ownsTextures: false } : {};
    }

    // Previous output's textures are node-owned — release now that no
    // downstream consumer can still be reading them (our cached output was
    // invalidated or we wouldn't be computing).
    for (const t of state.owned) ctx.releaseTexture(t);
    state.owned = [];

    const offsetFrames =
      typeof params.offset === "number" && Number.isFinite(params.offset)
        ? (params.offset as number)
        : 0;
    const offsetTicks = Math.round(offsetFrames * ctx.ticksPerFrame);

    // Boundary feeds: outer values arrive on our hidden mirror inputs; a
    // synthetic feed node per crossing edge re-emits each inside the
    // nested pass (the iterate-feed pattern on our own ctx channel).
    const values: Record<string, SocketValue | undefined> = {};
    const feedNodes: GraphNode[] = [];
    const nestedEdges: GraphEdge[] = [...entry.edges];
    for (const f of entry.feeds) {
      const v = inputs[f.inputName];
      values[f.inputName] = v;
      const feedId = `__tofeed_${f.edge.id}`;
      feedNodes.push({
        id: feedId,
        type: TIME_OFFSET_FEED_TYPE,
        params: { key: f.inputName, kind: v?.kind ?? "image" },
      });
      nestedEdges.push({
        ...f.edge,
        source: feedId,
        sourceHandle: "out:aux:value",
      });
    }
    const nestedNodes = [...entry.nodes, ...feedNodes];

    const tap = entry.tap;
    const tapHandleKey =
      tap.sourceHandle === "out:primary"
        ? "primary"
        : tap.sourceHandle.startsWith("out:aux:")
          ? `aux:${tap.sourceHandle.slice("out:aux:".length)}`
          : "primary";

    const runId = ++state.runId;
    // ctx.tick here is our SCOPED tick (layer-local time included), so a
    // Time Offset inside a layer composes with the layer's clock.
    const savedTick = ctx.tick;
    const savedTime = ctx.time;
    const savedFrame = ctx.frame;
    const savedFeed = ctx.timeOffsetFeed;
    const savedAudio = ctx.audioRoutedToOutput;
    const shifted = savedTick - offsetTicks;
    ctx.tick = shifted;
    ctx.frame = Math.floor(shifted / ctx.ticksPerFrame);
    ctx.time = shifted / (ctx.ticksPerFrame * ctx.fps);
    ctx.timeOffsetFeed = { runId, values };
    let v: SocketValue | undefined;
    try {
      const res = evaluateGraph(
        nestedNodes,
        nestedEdges,
        ctx,
        state.cache,
        tap.producerId,
        undefined,
        undefined,
        {
          nested: true,
          extraConsumed: new Map([[tap.producerId, [tapHandleKey]]]),
        }
      );
      const out = res.outputs.get(tap.producerId);
      v =
        tap.sourceHandle === "out:primary"
          ? out?.primary
          : tap.sourceHandle.startsWith("out:aux:")
            ? out?.aux?.[tap.sourceHandle.slice("out:aux:".length)]
            : undefined;

      // Copy texture-backed results into node-owned textures BEFORE
      // returning — the next nested pass frees this one's transients, and
      // cached interior textures can be evicted under our cached output.
      if (
        v &&
        (v.kind === "image" || v.kind === "mask" || v.kind === "uv")
      ) {
        const src = v as ImageValue | MaskValue | UvValue;
        const target =
          v.kind === "image"
            ? ctx.allocImage({ width: src.width, height: src.height })
            : v.kind === "mask"
              ? ctx.allocMask({ width: src.width, height: src.height })
              : ctx.allocUv({ width: src.width, height: src.height });
        const prog = ctx.getShader("time-offset/copy", COPY_FS);
        ctx.drawFullscreen(prog, target, (gl) => {
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, src.texture);
          gl.uniform1i(gl.getUniformLocation(prog, "u_src"), 0);
        });
        state.owned.push(target.texture);
        v = target;
      }
    } finally {
      ctx.tick = savedTick;
      ctx.time = savedTime;
      ctx.frame = savedFrame;
      ctx.timeOffsetFeed = savedFeed;
      ctx.audioRoutedToOutput = savedAudio;
    }

    return v ? { primary: v, ownsTextures: false } : {};
  },

  dispose(ctx, nodeId) {
    const key = `${TIME_OFFSET_TYPE}:${nodeId}`;
    const state = ctx.state[key] as TimeOffsetState | undefined;
    if (state) {
      for (const t of state.owned) ctx.releaseTexture(t);
      disposeEvalCache(ctx, state.cache);
    }
    delete ctx.state[key];
  },
};
