// Control tiers for the AE rig census (specdocs/102126_ae-rig-export.md
// §3.1, §10): where a node's params live in After Effects today (the result
// export) and under the first draft's stock-AE expression rig, and the work
// or gap between the two.
//
// `today` comes from the real planner (planAeExport's per-node class and
// fidelity), so it tracks the exporter as it changes. `rig` is this table:
// a reviewed judgment per node type, with param-dependent cases (Advect's
// accumulate mode). The spec's direction is now the geometry host, whose
// tier census.mts derives from portability.json instead; this table stays
// as the comparison scenario and as the fallback route for fully native
// regions (§8.2).

/* eslint-disable @typescript-eslint/no-explicit-any */

export type Tier = "native" | "rig" | "shader" | "plugin" | "sampled" | "frozen" | "bake";

export const LIVE: ReadonlySet<Tier> = new Set(["native", "rig", "shader", "plugin"]);

// Why a node's rig tier isn't live, or what reaching it takes.
//   emitter            AE has a native mapping the planner doesn't take for
//                      these params or this context (exporter work only)
//   kernel             an expression kernel + rig emitter (toolbox work only)
//   state              stateful over time; replay from frame 0 is out of reach
//   pixel-to-geometry  geometry computed from an image
//   ae-missing         AE has no equivalent operation → plugin candidate
//   opaque             ML, element layout, audio synthesis: nothing to rig
//   live-input         needs a recorded take
export type Gap = "emitter" | "kernel" | "state" | "pixel-to-geometry" | "ae-missing" | "opaque" | "live-input";

export interface RigRule {
  tier: Tier;
  gap?: Gap;
  // Kernel cost class: light = one small function per copy per frame;
  // heavy = a whole-geometry algorithm per frame (M1 decides kernel vs plugin).
  cost?: "light" | "heavy";
  // Input sockets that carry liveness through this node, overriding the
  // default (every input passes when the tier is live, none when it isn't).
  pass?: Record<string, boolean>;
  note?: string;
}

// Drawn or imported paths: the exported path IS the authored content, so
// nothing is lost when it's written as vertices.
const AUTHORED_PATH = new Set(["spline-draw", "svg-source"]);

// Today's control tier from the planner's class, AE target and fidelity.
export function todayTier(cls: string, fidelity: string, type: string, ae?: string): Tier {
  switch (cls) {
    case "vector":
      // A parametric shape or shape modifier keeps its params; an evaluated
      // `shape:path` freezes them into vertices.
      if (fidelity === "sampled") return "frozen";
      return ae === "shape:path" && !AUTHORED_PATH.has(type) ? "frozen" : "native";
    case "style":
    case "transform":
    case "layer":
    case "mask":
    case "text":
    case "effect":
      return "native";
    case "expression":
      return fidelity === "sampled" ? "sampled" : "rig";
    case "instances":
      // Copies land at fixed positions; a static lattice of one plain shape
      // becomes a Repeater, whose Copies stay live.
      return type === "grid" || type === "array" ? "native" : "frozen";
    case "shader":
      return "shader";
    default:
      return "bake";
  }
}

// Sockets that pass liveness today even though the node's own tier blocks,
// or that block even though it's live.
export const TODAY_PASS: Record<string, Record<string, boolean>> = {
  // The instance lives in a precomp every copy shows: editing it edits all.
  "copy-to-points": { instance: true },
  // One text layer per point: the text is native, the positions are data.
  "point-labels": { points: false },
};

// Pure point / spline computations: one kernel per node, called per copy.
const KERNEL_LIGHT = new Set([
  "align-to-camera-3d",
  "arc",
  "array",
  "attribute-math",
  "attribute-read",
  "bezier-handles",
  "bounding-box",
  "connect-points",
  "copy-to-points",
  "copy-to-points-3d",
  "cross",
  "filter-points",
  "foreach",
  "grid",
  "instance-color-3d",
  "instance-transform-3d",
  "line",
  "lissajous-2d",
  "lissajous-3d",
  "map-attribute",
  "mirror",
  "modulate-points",
  "point",
  "point-expression",
  "points-on-path",
  "points-to-spline",
  "repeat",
  "sample-along-path",
  "sample-texture-at-points",
  "scatter-points",
  "scatter-points-3d",
  "set-named-attribute",
  "set-position",
  "set-spline-type",
  "spiral",
  "spline-interpolate",
  "spline-intersections",
  "spline-morph",
  "spline-resample",
  "spline-to-points",
  "stagger",
  "transform",
  "wave",
]);

// Whole-geometry algorithms: a kernel can run them, but per frame they may
// cost too much in an expression.
const KERNEL_HEAVY = new Set([
  // Element layout: positions from measured sizes, sourceRectAtTime() in AE.
  "autolayout",
  "blend-intersections",
  "frame",
  "loop-weave",
  "optimize-path",
  "points-to-surface",
  "proximity-merge",
  "relax",
  "space-fill",
  "spline-outline",
  "string-art",
]);

// Stateful: simulations, feedback, accumulation, and the inputs that only
// feed a simulation.
const STATE = new Set([
  "accretive-growth",
  "accumulator",
  "collider-image-mask",
  "differential-growth",
  "emitter-image-mask",
  "fluid-simulator",
  "iterate",
  "matter-simulator",
  "particle-simulator",
  "particles-to-image",
  "rigid-body-simulator",
  "rope-simulator",
  "shortest-path",
  "simulation-end",
  "simulation-start",
  "watercolor-ink",
]);

const PIXEL_TO_GEOMETRY = new Set(["image-trace", "sdf-from-image", "sdf-spline", "sdf-to-spline"]);

// AE has no equivalent; each is a plugin candidate with its working name.
const PRIMITIVE_3D = "no parametric 3D primitives in AE: the geometry ships as a GLB";
const AE_MISSING: Record<string, string> = {
  "spline-merge": "smooth union of splines (gooey bridges between shapes)",
  "spline-flow-field": "flow-field line render (overlaps Line Runners)",
  voronoi: "Voronoi cells",
  "cube-3d": PRIMITIVE_3D,
  "circle-3d": PRIMITIVE_3D,
  "plane-3d": PRIMITIVE_3D,
  "rounded-cube-3d": PRIMITIVE_3D,
  "torus-3d": PRIMITIVE_3D,
  "material-3d": "AE 3D models take the GLB's materials",
};

// Native in AE, but the static class or today's planner bakes them.
const NATIVE_RIG: Record<string, { tier: Tier; note: string }> = {
  "scene-render": { tier: "native", note: "Advanced 3D comp (M4 3D lane); its geometry nodes decide" },
  "import-3d": { tier: "native", note: "M4 3D lane: GLB / OBJ as a 3D model layer" },
  "transform-3d": { tier: "native", note: "M4 3D lane: Transform 3D null" },
  "camera-3d": { tier: "native", note: "M4 3D lane: AE camera" },
  "light-3d": { tier: "native", note: "M4 3D lane: AE light" },
  "extrude-spline-3d": { tier: "native", note: "shape-layer extrusion in Advanced 3D (unverified)" },
  "bevel-3d": { tier: "native", note: "shape-layer bevel in Advanced 3D (unverified)" },
  "perlin-noise": { tier: "shader", note: "legacy node: swap in Noise's own shader" },
};

const OPAQUE_PREFIXES = ["audio-"];
const OPAQUE = new Set([
  "bg-remove",
  "hand-tracker",
  "image-generate",
  "midi-editor",
  "object-tracker",
  "paint",
]);

const LIVE_INPUT = new Set([
  "cursor",
  "cursor-trail-points",
  "drag-points",
  "draggable",
  "hit-region",
  "pointer",
  "webcam-source",
]);

// The rig export's tier for one node. `today` is what the planner says for
// this node now; `staticTier` is the class table's default for its type, so
// a node the planner bakes for its params or context (Rasterize Spline with
// holes, a Circle inside a baked region) keeps its native route as exporter
// work. Anything already live stays as it is.
export function rigRule(type: string, params: Record<string, any>, today: Tier, staticTier: Tier, def: any): RigRule {
  if (type in NATIVE_RIG) {
    const n = NATIVE_RIG[type];
    return LIVE.has(today) ? { tier: today } : { tier: n.tier, gap: "emitter", note: n.note };
  }
  if (type === "advect-points") {
    return params.mode === "accumulate"
      ? { tier: "sampled", gap: "state", note: "accumulate: persistent positions advance once per frame" }
      : { tier: "rig", gap: "kernel", cost: "heavy", pass: { field: true, speed: true }, note: "integrate: steps × copies field samples per frame" };
  }
  if (type === "copy-to-points") {
    return { tier: "rig", gap: "kernel", cost: "light", note: "copy groups read the points bus; fields through sampleImage()" };
  }
  if (type === "point-labels") return { tier: "rig", gap: "kernel", cost: "light", note: "text layers placed from the points bus" };
  if (type.startsWith("force-")) return { tier: "sampled", gap: "state", note: "simulation force" };
  if (LIVE_INPUT.has(type)) return { tier: "bake", gap: "live-input" };
  if (OPAQUE.has(type) || OPAQUE_PREFIXES.some((p) => type.startsWith(p))) {
    return LIVE.has(today) ? { tier: today } : { tier: today, gap: "opaque" };
  }
  // A dead node that outputs geometry ships its evaluated result as path /
  // position keys, so what's downstream of it can stay native; only an image
  // output has to bake (and takes its consumers with it).
  const dead: Tier = def?.primaryOutput === "image" ? "bake" : "sampled";
  if (type in AE_MISSING) return { tier: dead, gap: "ae-missing", note: AE_MISSING[type] };
  if (PIXEL_TO_GEOMETRY.has(type)) return { tier: dead, gap: "pixel-to-geometry" };
  if (STATE.has(type)) return { tier: dead, gap: "state" };
  if (LIVE.has(today)) return { tier: today };
  if (KERNEL_LIGHT.has(type)) return { tier: "rig", gap: "kernel", cost: "light" };
  if (KERNEL_HEAVY.has(type)) return { tier: "rig", gap: "kernel", cost: "heavy" };
  if (LIVE.has(staticTier)) return { tier: staticTier, gap: "emitter", note: "the planner doesn't take its native route for these params / this context" };
  // Unlisted and not live today: simulations stay sampled; anything else is
  // assumed to be a light kernel, and the census lists it for review.
  if (def?.simulation) return { tier: dead, gap: "state", note: "def.simulation (unlisted)" };
  return { tier: "rig", gap: "kernel", cost: "light", note: "unlisted: assumed a light kernel" };
}
