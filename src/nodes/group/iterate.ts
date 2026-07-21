import type {
  ImageGroupValue,
  ImageValue,
  InputSocketDef,
  NodeDefinition,
  OutputSocketDef,
  Point,
  PointsValue,
  RenderContext,
  SocketType,
  SocketValue,
  SplineSubpath,
  SplineValue,
} from "@/engine/types";
import {
  ITERATE_EDGE_PREFIX,
  ITERATE_FEED_TYPE,
  ITERATE_INPUT_TYPE,
  ITERATE_LOOP_PARAMS,
  ITERATE_PARAM_PREFIX,
  ITERATE_PASSTHROUGH_PREFIX,
  VIRTUAL_SOCKET,
  readBoundarySockets,
  readGroupInterface,
} from "@/engine/groups";
import { evaluateKeyframesAt } from "@/engine/keyframes";
import {
  disposeEvalCache,
  evaluateGraph,
  ITERATE_STASH_KEY,
  type EvalCache,
  type IterateStash,
} from "@/engine/evaluator";
import { resolveInteriorProducer } from "@/engine/flatten";
import { ensurePointArray, pointsFromArray } from "@/engine/points";
import { hash01 } from "@/engine/spline-color-source";

// Iteration Output — the computing half of an Iterate zone
// (071826_iterate-node.md; zone presentation 071926_iterate-zone-view.md
// rev 3). The zone is exactly two nodes: Iteration Input (loop params +
// per-iteration values) and this node, which:
//
//  - anchors membership (zone members carry parentId = this node's id;
//    flatten removes them from the outer graph and stashes them on ctx),
//  - collects results: wiring a member into the virtual input mints a
//    collect socket (any number of them); each iteration's value lands
//    there and the same-named aux output carries the GROUPED result
//    onward (image → image_group of K items; spline/points → merged,
//    each iteration's items groupIndex-tagged by iteration),
//  - carries hidden `zi__<name>` passthrough inputs (flatten reroutes
//    exterior wires that land on the Iteration Input's exterior face
//    here, so the values are evaluated outer-side and re-injected per
//    iteration through ctx.iteration.values).
//
// Compute runs the members K times through a nested evaluateGraph over
// a PRIVATE cache in ctx.state ({nested:true} skips the outer-only side
// effects). K / seed / the random range come from the Iteration Input's
// params, read out of the interior stash — which also feeds this def's
// fingerprintExtras, so any member edit (params included) busts the
// outer cache.
//
// Texture lifetime: each nested eval releases the PREVIOUS call's
// transient textures, and cached interior textures can be evicted
// between iterations — so every collected image is copied into an
// iterate-owned texture immediately, before the next iteration runs.
// Those copies are node-owned (ownsTextures:false — the evaluator can't
// release image_group items anyway): freed at the next compute and in
// dispose.

const MAX_COUNT = 64;

const COPY_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_src;
out vec4 outColor;
void main() { outColor = texture(u_src, v_uv); }`;

interface IterateState {
  cache: EvalCache;
  // Bumped per compute; folded into Iteration Input's fingerprint so
  // the private cache re-runs boundary-fed branches when passthrough
  // values change without the iteration index changing.
  runId: number;
  // Textures backing the current collection (node-owned).
  owned: WebGLTexture[];
}

function ensureState(ctx: RenderContext, nodeId: string): IterateState {
  const key = `iterate:${nodeId}`;
  const existing = ctx.state[key] as IterateState | undefined;
  if (existing) return existing;
  const s: IterateState = { cache: new Map(), runId: 0, owned: [] };
  ctx.state[key] = s;
  return s;
}

export const iterateNode: NodeDefinition = {
  type: "iterate",
  name: "Iteration Output",
  // Hidden from the generic add path — the menus surface a compound
  // "iterate" entry that mints the Input/Output pair together.
  hidden: true,
  category: "utility",
  description:
    "The collecting end of an Iterate zone. Wire member results into it to define what gets collected (each wire mints its own collect socket): an image comes out as an image group (one item per iteration); a spline or points value comes out merged with each iteration's items groupIndex-tagged by iteration — ready for Copy to Points' variant picks and per-group styling. Iteration count, seed, and the random range live on the zone's Iteration Input node.",
  backend: "webgl2",
  noMaskInput: true,
  inputs: [],
  resolveInputs(params): InputSocketDef[] {
    const out: InputSocketDef[] = [];
    // Minted collect sockets — every one is collected into its own
    // grouped aux output. The trailing virtual port mints the next.
    const minted = readBoundarySockets(params);
    for (const s of minted) {
      out.push({ name: s.name, type: s.type as SocketType, required: false });
    }
    out.push({
      name: VIRTUAL_SOCKET,
      type: "image" as SocketType,
      required: false,
    });
    // Hidden passthrough inputs — synced from the Iteration Input's
    // minted (non-reserved) sockets; flatten lands the rerouted
    // exterior edges here.
    for (const s of readGroupInterface(params).inputs) {
      out.push({
        name: `${ITERATE_PASSTHROUGH_PREFIX}${s.name}`,
        type: s.type as SocketType,
        required: false,
        hidden: true,
      });
    }
    // Hidden loop-param inputs — flatten reroutes an exterior wire into
    // the Iteration Input's EXPOSED count/seed/random-range params here,
    // so the value evaluates outer-side and wins the wire > keyframe >
    // constant resolution in compute.
    for (const p of ITERATE_LOOP_PARAMS) {
      out.push({
        name: `${ITERATE_PARAM_PREFIX}${p}`,
        type: "scalar" as SocketType,
        required: false,
        hidden: true,
      });
    }
    return out;
  },
  params: [],
  primaryOutput: null,
  auxOutputs: [],
  resolveAuxOutputs(params): OutputSocketDef[] {
    // One grouped output per collect socket.
    return readBoundarySockets(params).map((s) => ({
      name: s.name,
      type: (s.type === "image"
        ? "image_group"
        : s.type) as SocketType,
    }));
  },
  // Member edits must bust the outer cache; the evaluator precomputes
  // the interior hash (params/structure/animation + time when the
  // interior is time-driven) into the stash.
  fingerprintExtras(_params, ctx, nodeId) {
    if (!nodeId) return "";
    const stash = ctx.state[ITERATE_STASH_KEY] as IterateStash | undefined;
    return stash?.get(nodeId)?.hash ?? "";
  },

  compute({ inputs, params, ctx, nodeId }) {
    const state = ensureState(ctx, nodeId);
    // Previous collection's textures are node-owned — release them now
    // that no downstream consumer can still be reading them (our cached
    // output was invalidated or we wouldn't be computing).
    for (const t of state.owned) ctx.releaseTexture(t);
    state.owned = [];

    const minted = readBoundarySockets(params);
    if (minted.length === 0) return {};
    const emptyFor = (type: string): SocketValue =>
      type === "spline"
        ? ({ kind: "spline", subpaths: [] } satisfies SplineValue)
        : type === "points"
          ? pointsFromArray([])
          : ({ kind: "image_group", items: [] } satisfies ImageGroupValue);
    const allEmpty = () => {
      const aux: Record<string, SocketValue> = {};
      for (const s of minted) aux[s.name] = emptyFor(s.type);
      return { aux, ownsTextures: false as const };
    };

    // Nested Iterate: structurally representable, not yet supported.
    if (ctx.iteration) {
      console.warn("[iterate] nested Iterate is not supported yet");
      return allEmpty();
    }
    const stash = ctx.state[ITERATE_STASH_KEY] as IterateStash | undefined;
    const interior = stash?.get(nodeId);
    if (!interior) return allEmpty();

    // Loop params live on the zone's Iteration Input, which never runs
    // through the outer evaluator — so the house wire > keyframe >
    // constant precedence is resolved HERE: a wired value arrives on our
    // hidden zi__param input (flatten rerouted it), keyframes come off
    // the stashed node's animation at the scoped clock (layer-local time
    // included, since compute runs under it), and the stored constant is
    // the fallback. Cache correctness is inherited: wired values ride
    // this node's input fingerprints; an animated block marks the
    // interior time-driven, folding ctx.tick into the stash hash.
    const iterInput = interior.nodes.find(
      (n) => n.type === ITERATE_INPUT_TYPE && n.parentId === nodeId
    );
    const loopParam = (name: string, fallback: number): number => {
      const wired = inputs[`${ITERATE_PARAM_PREFIX}${name}`];
      if (wired?.kind === "scalar" && Number.isFinite(wired.value)) {
        return wired.value;
      }
      const block = iterInput?.animation?.[name];
      if (block?.animated && block.keyframes.length > 0) {
        const v = evaluateKeyframesAt(block, "scalar", ctx.tick);
        if (typeof v === "number" && Number.isFinite(v)) return v;
      }
      const stored = iterInput?.params[name];
      return typeof stored === "number" && Number.isFinite(stored)
        ? stored
        : fallback;
    };
    const K = Math.max(
      1,
      Math.min(MAX_COUNT, Math.round(loopParam("count", 1)))
    );
    const seed = Math.floor(loopParam("seed", 0));
    const rMin = loopParam("random_min", 0);
    const rMax = loopParam("random_max", 1);

    // The collect taps: member edges into our minted sockets ride the
    // interior record (flatten moves them there — their sources don't
    // exist in the outer graph). Every wired socket collects; unwired
    // ones emit empty.
    const taps = minted
      .map((s) => ({
        socket: s,
        producer: resolveInteriorProducer(
          interior.nodes,
          interior.edges,
          nodeId,
          s.name
        ),
      }))
      .filter(
        (t): t is typeof t & { producer: { nodeId: string; handle: string } } =>
          t.producer !== null
      );
    if (taps.length === 0) return allEmpty();

    // Passthrough values by socket name, from our hidden zi__ inputs.
    const values: Record<string, SocketValue | undefined> = {};
    for (const s of readGroupInterface(params).inputs) {
      values[s.name] = inputs[`${ITERATE_PASSTHROUGH_PREFIX}${s.name}`];
    }

    // Members evaluate as-is (Iteration Input computes natively from
    // ctx.iteration); tap edges into this node are filtered out. Direct
    // crossing wires (exterior→member, kept exactly as the user drew
    // them) arrive as interior edges whose source ISN'T a member: for
    // each, the mirrored per-edge shell input carries the outer value,
    // and an eval-only feed node re-emits it inside the loop.
    const interiorIds = new Set(interior.nodes.map((n) => n.id));
    const feedNodes: typeof interior.nodes = [];
    const nestedEdges = interior.edges
      .filter((e) => e.target !== nodeId)
      .map((e) => {
        if (interiorIds.has(e.source)) return e;
        const key = `${ITERATE_EDGE_PREFIX}${e.id}`;
        const v = inputs[key];
        values[key] = v;
        feedNodes.push({
          id: `__iterfeed_${e.id}`,
          type: ITERATE_FEED_TYPE,
          params: { key, kind: v?.kind ?? "image" },
        });
        return { ...e, source: `__iterfeed_${e.id}`, sourceHandle: "out:aux:value" };
      });
    const nestedNodes = [...interior.nodes, ...feedNodes];

    const runId = ++state.runId;
    // Per-tap accumulators, keyed by socket name.
    const acc = new Map<
      string,
      { items: ImageValue[]; subpaths: SplineSubpath[]; points: Point[] }
    >();
    for (const t of taps) {
      acc.set(t.socket.name, { items: [], subpaths: [], points: [] });
    }
    const savedAudio = ctx.audioRoutedToOutput;
    try {
      for (let i = 0; i < K; i++) {
        ctx.iteration = {
          index: i,
          count: K,
          t: K > 1 ? i / (K - 1) : 0,
          random: rMin + hash01(i, seed) * (rMax - rMin),
          runId,
          values,
        };
        // One nested pass per iteration evaluates every tap's producer
        // (extraTargets forces the additional branches into the needed
        // set).
        const res = evaluateGraph(
          nestedNodes,
          nestedEdges,
          ctx,
          state.cache,
          taps[0].producer.nodeId,
          undefined,
          undefined,
          {
            nested: true,
            extraTargets: taps.slice(1).map((t) => t.producer.nodeId),
          }
        );
        for (const tap of taps) {
          const out = res.outputs.get(tap.producer.nodeId);
          const v =
            tap.producer.handle === "out:primary"
              ? out?.primary
              : tap.producer.handle.startsWith("out:aux:")
                ? out?.aux?.[tap.producer.handle.slice("out:aux:".length)]
                : undefined;
          if (!v) continue;
          const a = acc.get(tap.socket.name)!;
          if (v.kind === "image") {
            // Copy into an iterate-owned texture BEFORE the next nested
            // eval — that call frees this one's transients, and cached
            // interior textures can be evicted under it.
            const copy = ctx.allocImage();
            const prog = ctx.getShader("iterate/copy", COPY_FS);
            ctx.drawFullscreen(prog, copy, (gl) => {
              gl.activeTexture(gl.TEXTURE0);
              gl.bindTexture(gl.TEXTURE_2D, (v as ImageValue).texture);
              gl.uniform1i(gl.getUniformLocation(prog, "u_src"), 0);
            });
            a.items.push(copy);
            state.owned.push(copy.texture);
          } else if (v.kind === "spline") {
            // CPU values: tag each iteration's subpaths with the
            // iteration index — the variant identity CTP's pick modes
            // and per-group styling key off.
            for (const sub of v.subpaths) {
              a.subpaths.push({ ...sub, groupIndex: i });
            }
          } else if (v.kind === "points") {
            for (const p of ensurePointArray(v as PointsValue)) {
              a.points.push({ ...p, groupIndex: i });
            }
          }
        }
      }
    } finally {
      ctx.iteration = undefined;
      ctx.audioRoutedToOutput = savedAudio;
    }

    const aux: Record<string, SocketValue> = {};
    for (const s of minted) {
      const a = acc.get(s.name);
      if (!a) {
        aux[s.name] = emptyFor(s.type);
      } else if (s.type === "spline") {
        aux[s.name] = {
          kind: "spline",
          subpaths: a.subpaths,
        } satisfies SplineValue;
      } else if (s.type === "points") {
        aux[s.name] = pointsFromArray(a.points);
      } else {
        aux[s.name] = {
          kind: "image_group",
          items: a.items,
        } satisfies ImageGroupValue;
      }
    }
    return { aux, ownsTextures: false };
  },

  dispose(ctx, nodeId) {
    const key = `iterate:${nodeId}`;
    const state = ctx.state[key] as IterateState | undefined;
    if (state) {
      for (const t of state.owned) ctx.releaseTexture(t);
      disposeEvalCache(ctx, state.cache);
    }
    delete ctx.state[key];
  },
};
