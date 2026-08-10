import type {
  AudioChainMixInput,
  AudioChainNode,
  AudioValue,
  InputSocketDef,
  NodeDefinition,
  ParamDef,
} from "@/engine/types";

// Audio Merge — the mixer (specdocs/080826_audio-nodes.md). N audio lanes
// summed through per-lane gain / pan / mute strips: emits one "mix"
// descriptor and the audio engine reconciles it into per-lane Gain→Panner
// strips feeding a sum (audio-adapters-routing.ts). Gain/pan changes ramp
// in place; lane membership changes arrive as a rewire.
//
// The ParamPanel stays plain: a `lanes` count plus declared per-lane
// gain/pan/mute/solo rows gated by visibleIf. Every knob is an ordinary
// scalar ParamDef, so gains and pans are keyframable/exposable for free.
// Solo resolves at descriptor build time (the M1 reservation, shipped in
// M-D): when any wired lane is soloed, every other lane leaves compute()
// with `mute: true`, so the engine only ever sees effective mutes.
//
// Zero audio work in compute() — descriptors in, one descriptor out.

const MAX_LANES = 8;

function laneCount(params: Record<string, unknown>): number {
  const n = Math.round((params.lanes as number) ?? 2);
  return Math.max(2, Math.min(MAX_LANES, n));
}

// gain1..gain8 / pan1..pan8 / mute1..mute8 / solo1..solo8, each row hidden
// while its lane is beyond the current `lanes` count. Solo sits right after
// its lane's mute; saved projects predating solo just take the false
// default (additive — names and existing rows unchanged).
function laneParamDefs(): ParamDef[] {
  const defs: ParamDef[] = [];
  for (let i = 1; i <= MAX_LANES; i++) {
    const visibleIf = (params: Record<string, unknown>) =>
      laneCount(params) >= i;
    defs.push(
      {
        name: `gain${i}`,
        label: `Gain ${i}`,
        type: "scalar",
        min: 0,
        max: 2,
        step: 0.01,
        default: 1,
        visibleIf,
      },
      {
        name: `pan${i}`,
        label: `Pan ${i}`,
        type: "scalar",
        min: -1,
        max: 1,
        step: 0.01,
        default: 0,
        visibleIf,
      },
      {
        name: `mute${i}`,
        label: `Mute ${i}`,
        type: "boolean",
        default: false,
        visibleIf,
      },
      {
        name: `solo${i}`,
        label: `Solo ${i}`,
        type: "boolean",
        default: false,
        visibleIf,
      }
    );
  }
  return defs;
}

export const audioMergeNode: NodeDefinition = {
  type: "audio-merge",
  name: "Audio Merge",
  category: "audio",
  subcategory: "utility",
  description:
    "Mixes up to 8 audio inputs into one signal with per-lane gain, pan, mute, and solo. Set `lanes` to grow the input sockets; gains and pans are keyframable — or drive them from any scalar — for automated mixes.",
  backend: "webgl2",
  noMaskInput: true,
  inputs: [
    { name: "in1", label: "In 1", type: "audio", required: false },
    { name: "in2", label: "In 2", type: "audio", required: false },
  ],
  // Sockets derive from `lanes` ALONE — no ResolveCtx, no dependence on
  // what's wired. That exact property is what lets the evaluator's
  // audio-routing pre-pass (the transitive audioRoutedToOutput walk) see
  // these sockets before anything evaluates, so a source feeding lane 3
  // still un-mutes when this node reaches Output (M0-as-built delta #4).
  resolveInputs(params) {
    const n = laneCount(params);
    const result: InputSocketDef[] = [];
    for (let i = 1; i <= n; i++) {
      result.push({
        name: `in${i}`,
        label: `In ${i}`,
        type: "audio",
        required: false,
      });
    }
    return result;
  },
  params: [
    {
      name: "lanes",
      label: "Lanes",
      type: "scalar",
      min: 2,
      max: MAX_LANES,
      step: 1,
      default: 2,
    },
    ...laneParamDefs(),
  ],
  primaryOutput: "audio",
  auxOutputs: [],

  compute({ inputs, params, nodeId }) {
    const lanes = laneCount(params);
    const mixInputs: AudioChainMixInput[] = [];
    // Per pushed lane: was its solo on? Parallel to mixInputs so the solo
    // pass below only considers lanes that are visible AND wired.
    const soloed: boolean[] = [];
    let first: AudioValue | null = null;

    for (let i = 1; i <= lanes; i++) {
      const input = inputs[`in${i}`];
      // Unwired lanes are skipped entirely — no strip, no silent lane.
      if (!input || input.kind !== "audio") continue;

      // Upstream chain, or — for an element-only value from a producer that
      // predates chains — a leaf minted here with a this-node+lane-derived
      // id (stable across evals, distinct from our own stage id).
      let chain: AudioChainNode | null = input.chain ?? null;
      if (!chain && input.element) {
        chain = {
          kind: "element",
          nodeId: `${nodeId}:src${i}`,
          element: input.element,
          source: input.source ?? "file",
          url: null,
        };
      }
      if (!chain) continue;

      if (!first) first = input;
      // Gain and mute travel separately — the mix descriptor has its own
      // mute field, and keeping the authored gain alongside it means
      // un-muting ramps back to the set level instead of from zero.
      mixInputs.push({
        chain,
        gain: (params[`gain${i}`] as number) ?? 1,
        pan: (params[`pan${i}`] as number) ?? 0,
        mute: (params[`mute${i}`] as boolean) ?? false,
      });
      soloed.push((params[`solo${i}`] as boolean) ?? false);
    }

    if (mixInputs.length === 0) return {};

    // Solo resolves HERE, at descriptor build (the reserved contract —
    // audio-adapters-routing.ts never learns about solo): any soloed lane
    // forces every non-soloed lane's mute on. A soloed lane still honors
    // its OWN mute, and the authored gain rides alongside untouched, so
    // dropping solo ramps lanes back to their set levels.
    if (soloed.some(Boolean)) {
      for (let k = 0; k < mixInputs.length; k++) {
        if (!soloed[k]) mixInputs[k].mute = true;
      }
    }

    const value: AudioValue = {
      kind: "audio",
      chain: { kind: "mix", nodeId, params: {}, inputs: mixInputs },
      // Pass the first wired lane's source element through so existing
      // element-tap consumers (audio→scalar, Audio Bands) keep reading
      // SOMETHING — that lane's raw pre-mix signal. M2 replaces this with
      // true post-stage chain taps (audioEngine.getTapAnalyser).
      element: first?.element,
      source: first?.source,
    };
    return { primary: value };
  },
};
