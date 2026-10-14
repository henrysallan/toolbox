// The easing half of MCP set_keyframes / get_keyframes, as pure functions
// (src/components/effects/mcp-handlers.ts calls them; scripts/
// check-spring-easing.mts drives them directly). A key's `easing` is a
// preset name; `spring` (only with easing "spring") carries its params.

import { EASING_PRESET_ORDER, type EasingPreset, type Keyframe } from "./keyframes";
import {
  DEFAULT_SPRING,
  resolveSpring,
  sanitizeSpringEasing,
  type SpringEasing,
} from "./spring-easing";

const EASING_SET = new Set<string>(EASING_PRESET_ORDER);

export type KeyEasingVet =
  | { ok: true; easingOut: EasingPreset; spring?: SpringEasing }
  | { ok: false; reason: string };

// One remote key's easing fields → what the keyframe stores. Defaults to
// easeInOutQuad; step-only tracks (boolean / enum) force hold and ignore
// spring params; `easing: "spring"` without params writes DEFAULT_SPRING
// explicitly so get_keyframes reports what plays.
export function vetKeyframeEasing(
  raw: { easing?: unknown; spring?: unknown },
  stepOnly: boolean
): KeyEasingVet {
  const easing = raw.easing ?? "easeInOutQuad";
  if (easing === "customBezier") {
    return { ok: false, reason: "customBezier is hand-authored in the graph editor — pick a preset." };
  }
  if (easing === "cubicBezier") {
    return { ok: false, reason: "cubicBezier is shaped in the tracks editor's easing overlay — pick a preset." };
  }
  if (typeof easing !== "string" || !EASING_SET.has(easing)) {
    return {
      ok: false,
      reason: `Unknown easing "${String(easing)}". Presets: ${EASING_PRESET_ORDER.filter(
        (e) => e !== "customBezier"
      ).join(", ")}.`,
    };
  }
  if (stepOnly) return { ok: true, easingOut: "hold" };
  if (easing !== "spring") {
    if (raw.spring !== undefined) {
      return { ok: false, reason: `\`spring\` params apply only with easing "spring" (got "${easing}").` };
    }
    return { ok: true, easingOut: easing as EasingPreset };
  }
  if (raw.spring === undefined) {
    return { ok: true, easingOut: "spring", spring: { ...DEFAULT_SPRING } };
  }
  // Either field may be left out (the default fills it); junk refuses.
  const given = raw.spring;
  const spring =
    given != null && typeof given === "object" && !Array.isArray(given)
      ? sanitizeSpringEasing({ ...DEFAULT_SPRING, ...given })
      : null;
  if (!spring) {
    return {
      ok: false,
      reason:
        "`spring` must be { dampingRatio?: number > 0, settle?: number > 0 } " +
        "(dampingRatio clamps into 0.01–10, settle into 0.05–1).",
    };
  }
  return { ok: true, easingOut: "spring", spring };
}

// get_keyframes' per-key spring report: the params that play (defaults
// filled in, clamped) on spring keys, nothing on the others.
export function keyframeSpringReport(k: Keyframe): { spring?: Required<SpringEasing> } {
  if (k.easingOut !== "spring") return {};
  const { zeta, settle } = resolveSpring(k.spring);
  return { spring: { dampingRatio: zeta, settle } };
}
