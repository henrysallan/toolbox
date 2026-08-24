import type { NodeDefinition, RenderContext } from "@/engine/types";
import { easeOf, type EasingPreset } from "@/engine/keyframes";

// Trigger Envelope — pulse in, motion out (081726_pointer-interaction.md
// §3.2). A rising edge through 0.5 on `trigger` starts an
// attack / hold / release envelope; the output is the 0→1→0 scalar.
// Built for the Pointer node's press/click pulses, but any scalar edge
// works — an audio beat, a Compare crossing, a keyframed step.
//
// `clock` picks the timebase: `wall` responds while playback is paused
// (interaction feel, the default); `timeline` runs on scene time, which
// makes deterministic triggers (audio analysis, keyframes) render
// identically in offline export.
//
// Edge detection is per-node state diffed against the wired value —
// safe under re-entrant evals because every eval in a pass sees the
// same input (Time Offset boundary-feeds non-retimeable branches, so a
// nested eval can't present a second edge).

interface EnvelopeState {
  lastTrigger: number;
  // Envelope start in the ACTIVE clock's units; null = never fired.
  t0: number | null;
  clockWasWall: boolean;
}

function stateKey(nodeId: string): string {
  return `trigger-envelope:${nodeId}`;
}

function ensureState(ctx: RenderContext, nodeId: string): EnvelopeState {
  const key = stateKey(nodeId);
  const existing = ctx.state[key] as EnvelopeState | undefined;
  if (existing) return existing;
  const s: EnvelopeState = { lastTrigger: 0, t0: null, clockWasWall: true };
  ctx.state[key] = s;
  return s;
}

const CURVES: EasingPreset[] = [
  "linear",
  "easeOutSine",
  "easeInSine",
  "easeInOutSine",
  "easeOutQuad",
  "easeInQuad",
  "easeInOutQuad",
  "easeOutCubic",
  "easeInCubic",
];

function envelopeValue(
  elapsed: number,
  attack: number,
  hold: number,
  release: number,
  attackCurve: EasingPreset,
  releaseCurve: EasingPreset
): { value: number; active: boolean } {
  if (elapsed < 0) return { value: 0, active: false };
  if (elapsed < attack) {
    return { value: easeOf(attackCurve, elapsed / attack), active: true };
  }
  const afterAttack = elapsed - attack;
  if (afterAttack < hold) return { value: 1, active: true };
  const afterHold = afterAttack - hold;
  if (afterHold < release) {
    return {
      value: 1 - easeOf(releaseCurve, afterHold / release),
      active: true,
    };
  }
  return { value: 0, active: false };
}

function readParams(params: Record<string, unknown>) {
  return {
    attack: Math.max(0, (params.attack as number) ?? 0.05),
    hold: Math.max(0, (params.hold as number) ?? 0.1),
    release: Math.max(0, (params.release as number) ?? 0.4),
    attackCurve: (params.attack_curve as EasingPreset) ?? "easeOutQuad",
    releaseCurve: (params.release_curve as EasingPreset) ?? "easeOutQuad",
    wallClock: (params.clock ?? "wall") !== "timeline",
  };
}

function currentValue(
  params: Record<string, unknown>,
  ctx: RenderContext,
  s: EnvelopeState
): { value: number; active: boolean } {
  const p = readParams(params);
  if (s.t0 === null) return { value: 0, active: false };
  const nowClock = p.wallClock ? performance.now() / 1000 : ctx.time;
  return envelopeValue(
    Math.max(0, nowClock - s.t0),
    p.attack,
    p.hold,
    p.release,
    p.attackCurve,
    p.releaseCurve
  );
}

export const triggerEnvelopeNode: NodeDefinition = {
  type: "trigger-envelope",
  name: "Trigger Envelope",
  category: "utility",
  subcategory: "modifier",
  description:
    "Rising edge in, attack / hold / release envelope out (0→1→0 scalar). Stretches a one-frame pulse — a Pointer click, an audio beat, a Compare crossing — into usable motion. Wall clock responds while paused; timeline clock makes deterministic triggers export-exact. Retrigger restarts or ignores edges mid-envelope.",
  backend: "webgl2",
  // Wall-clock envelope + edge state — recompute every eval.
  stable: false,
  retimeable: false,
  inputs: [{ name: "trigger", type: "scalar", required: false }],
  params: [
    {
      name: "attack",
      label: "Attack (s)",
      type: "scalar",
      min: 0,
      max: 30,
      softMax: 2,
      step: 0.01,
      default: 0.05,
    },
    {
      name: "hold",
      label: "Hold (s)",
      type: "scalar",
      min: 0,
      max: 30,
      softMax: 2,
      step: 0.01,
      default: 0.1,
    },
    {
      name: "release",
      label: "Release (s)",
      type: "scalar",
      min: 0,
      max: 30,
      softMax: 5,
      step: 0.01,
      default: 0.4,
    },
    {
      name: "attack_curve",
      label: "Attack curve",
      type: "enum",
      options: CURVES,
      default: "easeOutQuad",
    },
    {
      name: "release_curve",
      label: "Release curve",
      type: "enum",
      options: CURVES,
      default: "easeOutQuad",
    },
    {
      name: "retrigger",
      label: "Retrigger",
      type: "enum",
      options: ["restart", "ignore"],
      default: "restart",
    },
    {
      name: "clock",
      label: "Clock",
      type: "enum",
      options: ["wall", "timeline"],
      default: "wall",
    },
  ],
  primaryOutput: "scalar",
  auxOutputs: [],

  // The output glides continuously while the envelope runs — fold the
  // quantized value so downstream caches follow it, and nothing else so
  // they settle the moment it lands back at rest.
  fingerprintExtras(params, ctx, nodeId) {
    const s = nodeId
      ? (ctx.state[stateKey(nodeId)] as EnvelopeState | undefined)
      : undefined;
    if (!s) return "env:idle";
    const { value, active } = currentValue(params, ctx, s);
    return `env:${active ? 1 : 0}:${value.toFixed(4)}`;
  },

  compute({ inputs, params, ctx, nodeId }) {
    const s = ensureState(ctx, nodeId);
    const p = readParams(params);

    // Switching clocks mid-envelope would compare a wall t0 against
    // scene time (or vice versa) — kill the running envelope instead.
    if (p.wallClock !== s.clockWasWall) {
      s.t0 = null;
      s.clockWasWall = p.wallClock;
    }

    const trig = inputs.trigger?.kind === "scalar" ? inputs.trigger.value : 0;
    const rising = s.lastTrigger <= 0.5 && trig > 0.5;
    s.lastTrigger = trig;

    const before = currentValue(params, ctx, s);
    if (rising && (params.retrigger !== "ignore" || !before.active)) {
      s.t0 = p.wallClock ? performance.now() / 1000 : ctx.time;
    }

    const { value, active } = currentValue(params, ctx, s);

    // A running wall-clock envelope must keep animating while playback
    // is paused (the timeline clock only moves with playback, so it
    // needs no bump).
    if (active && p.wallClock && typeof window !== "undefined") {
      window.dispatchEvent(new Event("pipeline-bump"));
    }

    return { primary: { kind: "scalar", value } };
  },

  dispose(ctx: RenderContext, nodeId: string) {
    delete ctx.state[stateKey(nodeId)];
  },
};
