// Pure helpers behind ExportAeModal (spec 091926_after-effects-handoff.md
// §5.4): the coverage tree, rung chips, per-node override choices, the
// modal's options ↔ policy, and the prompt "Convert shader regions with
// Claude" sends. No React here, so scripts/ae-export/check-modal.mts can
// gate it offline.

import {
  AE_CLASS_ORDER,
  DEFAULT_AE_POLICY,
  type AeExportClass,
  type AeExportPlan,
  type AeExportPolicy,
  type AeFidelity,
  type AePlanNode,
  type AeRoute,
} from "@/lib/ae-export/types";
import type { AeNodeOverride } from "@/lib/ae-export/scene";

export const AE_CLASS_CHIP: Record<AeExportClass, { label: string; color: string; title: string }> = {
  vector: { label: "vector", color: "var(--tb-a-emerald-400)", title: "Editable shape-layer path" },
  style: { label: "style", color: "var(--tb-a-emerald-400)", title: "Shape Fill / Stroke / Gradient" },
  transform: { label: "transform", color: "var(--tb-a-emerald-400)", title: "Layer transform, parenting" },
  layer: { label: "layer", color: "var(--tb-a-emerald-400)", title: "Comp layers, blend modes, mattes" },
  mask: { label: "mask", color: "var(--tb-a-emerald-400)", title: "Layer mask, track matte or effect mask" },
  effect: { label: "effect", color: "var(--tb-a-cyan-400)", title: "An AE built-in effect stands in" },
  expression: { label: "expr", color: "var(--tb-a-blue-300)", title: "AE expression or per-frame keys" },
  instances: { label: "instances", color: "var(--tb-a-green-400)", title: "Repeater or one layer per copy" },
  text: { label: "text", color: "var(--tb-a-green-400)", title: "AE text layer (needs the font installed)" },
  shader: { label: "shader", color: "var(--tb-a-violet-400)", title: "Fused GLSL run by the Toolbox Shader plug-in" },
  bake: { label: "bake", color: "var(--tb-a-amber-400)", title: "Rendered to footage: keeps the look, not editable" },
  unsupported: { label: "live", color: "var(--tb-a-red-400)", title: "Live input: record a take or replace it with keyframes" },
};

export const AE_FIDELITY_COLOR: Record<AeFidelity, string> = {
  exact: "var(--tb-n-11)",
  approx: "var(--tb-a-yellow-400)",
  sampled: "var(--tb-a-blue-300)",
  bake: "var(--tb-a-amber-400)",
};

export const AE_ROUTE_TEXT: Record<AeRoute, { label: string; color: string; detail: string }> = {
  direct: {
    label: "Direct",
    color: "var(--tb-a-emerald-400)",
    detail: "Everything exports as editable After Effects layers, masks, effects and keyframes.",
  },
  "direct+bake": {
    label: "Direct + baked footage",
    color: "var(--tb-a-amber-400)",
    detail: "Some regions render to footage layers: they keep the look but aren't editable in AE.",
  },
  "direct+shader": {
    label: "Direct + shader regions",
    color: "var(--tb-a-violet-400)",
    detail:
      "Some regions have no AE equivalent. Convert them with Claude to run as Toolbox Shader effects (the AE user installs the plug-in), or they bake.",
  },
  blocked: {
    label: "Blocked",
    color: "var(--tb-a-red-400)",
    detail: "Live inputs (pointer, webcam, audio-in…) drive this graph. Record a take or replace them with keyframes first.",
  },
};

const NATIVE_CLASSES: ReadonlySet<AeExportClass> = new Set(["vector", "style", "transform", "layer", "mask", "text", "instances"]);

// What the modal offers per node. "bake" forces footage; "skip" drops the
// node's contribution; "procedural" keeps a node the planner would bake for
// budget / stability reasons as native or sampled layers anyway.
export function aeOverridesFor(node: AePlanNode): AeNodeOverride[] {
  const out: AeNodeOverride[] = [];
  if (node.class !== "bake" && node.class !== "unsupported") out.push("bake");
  if (node.fidelity === "bake" && NATIVE_CLASSES.has(node.class)) out.push("procedural");
  out.push("skip");
  return out;
}

export const AE_OVERRIDE_LABEL: Record<AeNodeOverride, string> = {
  bake: "Force bake",
  procedural: "Keep procedural",
  skip: "Skip",
};

export interface AeCoverageNode extends AePlanNode {
  overrides: AeNodeOverride[];
}

export interface AeCoverageLayer {
  id: string;
  name: string;
  // "frames 0–120" or "frames 0–30, 60–90".
  windows: string;
  nodes: AeCoverageNode[];
  // Node count per class, in ladder order.
  counts: { class: AeExportClass; n: number }[];
}

export function aeCoverage(plan: AeExportPlan): AeCoverageLayer[] {
  return plan.layers.map((layer) => {
    const tally = new Map<AeExportClass, number>();
    for (const n of layer.nodes) tally.set(n.class, (tally.get(n.class) ?? 0) + 1);
    const windows = (layer.windows ?? [])
      .map((w) => `${w.inFrame}–${Math.max(w.inFrame, w.outFrame - 1)}`)
      .join(", ");
    return {
      id: layer.id,
      name: layer.name,
      windows: windows ? `frames ${windows}` : "",
      nodes: layer.nodes.map((n) => ({ ...n, overrides: aeOverridesFor(n) })),
      counts: AE_CLASS_ORDER.filter((c) => tally.has(c)).map((c) => ({ class: c, n: tally.get(c)! })),
    };
  });
}

export function aeSummaryLine(plan: AeExportPlan): string {
  const { layers, keyframes, footageMB } = plan.estimates;
  const parts = [
    `${layers} layer${layers === 1 ? "" : "s"}`,
    `${keyframes} keyframe${keyframes === 1 ? "" : "s"}`,
  ];
  if (footageMB > 0) parts.push(`${footageMB < 10 ? footageMB.toFixed(1) : Math.round(footageMB)} MB footage`);
  return parts.join(" · ");
}

// The modal's option controls, flat.
export type AeModalOptions = Pick<
  AeExportPolicy,
  "fidelity" | "color" | "layerBudget" | "bakeCodec" | "bitsPerChannel" | "acceptApprox" | "shaderHost"
>;

export function aeOptionsFromPolicy(p: Partial<AeExportPolicy> = {}): AeModalOptions {
  const full = { ...DEFAULT_AE_POLICY, ...p };
  return {
    fidelity: full.fidelity,
    color: full.color,
    layerBudget: full.layerBudget,
    bakeCodec: full.bakeCodec,
    bitsPerChannel: full.bitsPerChannel,
    acceptApprox: full.acceptApprox,
    shaderHost: full.shaderHost,
  };
}

// Only the fields that differ from the defaults, so the tool calls and the
// report stay short.
export function aePolicyFromOptions(o: AeModalOptions): Partial<AeExportPolicy> {
  const out: Partial<AeExportPolicy> = {};
  for (const k of Object.keys(o) as (keyof AeModalOptions)[]) {
    const v = o[k];
    if (v !== DEFAULT_AE_POLICY[k]) (out as Record<string, unknown>)[k] = v;
  }
  return out;
}

function clampBudget(n: number): number {
  return Number.isFinite(n) ? Math.min(5000, Math.max(1, Math.round(n))) : DEFAULT_AE_POLICY.layerBudget;
}

export function aeWithBudget(o: AeModalOptions, raw: string): AeModalOptions {
  return { ...o, layerBudget: clampBudget(Number(raw)) };
}

// Shader regions that need a fused GLSL Expression: not the ones the host
// runs as their node's own shader (kernel "node").
export function aeRegionsToFuse(plan: AeExportPlan): AeExportPlan["shaderRegions"] {
  return plan.shaderRegions.filter((r) => r.kernel !== "node");
}

// What "Convert shader regions with Claude" sends to the agent panel. It
// names every region and the exact tool sequence (spec §7.6), and asks for
// the fused map export_ae_package takes.
export function aeConvertPrompt(plan: AeExportPlan, name: string, policy: Partial<AeExportPolicy>): string {
  const regions = aeRegionsToFuse(plan);
  const own = plan.shaderRegions.filter((r) => r.kernel === "node");
  const lines: string[] = [];
  lines.push(`Export this composition to After Effects as "${name}". Use the graph-to-after-effects skill if you have it.`);
  lines.push("");
  lines.push(`1. Call plan_ae_export and confirm the route (it is currently "${plan.route}").`);
  if (own.length > 0)
    lines.push(
      `   ${own.map((r) => r.target).join(", ")} ${own.length === 1 ? "runs" : "run"} as ${own.length === 1 ? "its node's" : "their nodes'"} own shader in the Toolbox Shader plug-in — export ${own.length === 1 ? "it" : "them"} as is, no fusing.`
    );
  if (regions.length > 0) {
    lines.push(
      `2. These ${regions.length} shader region${regions.length === 1 ? " has" : "s have"} no native AE form. Fuse each into one GLSL Expression node:`
    );
    for (const r of regions) {
      const frames = r.frames.length ? `; check frames ${r.frames.join(", ")}` : "";
      lines.push(`   - target ${r.target} (${r.nodes.length} node${r.nodes.length === 1 ? "" : "s"}${frames})${r.summary ? ` — ${r.summary}` : ""}`);
    }
    lines.push(
      "   For each: plan_glsl_translation → get_glsl_docs → write the glsl-expression node, unwired downstream → get_shader_errors → compare_renders until it matches. Then call validate_ae_shader on the new node and fix anything it refuses."
    );
  } else {
    lines.push("2. There are no shader regions to fuse.");
  }
  const policyText = Object.keys(policy).length ? JSON.stringify(policy) : "{} (the defaults)";
  lines.push(
    `3. Call export_ae_package with policy ${policyText} and fused = { "<region target>": "<your glsl-expression node id>", … } for every region you converted.`
  );
  lines.push(
    "4. If run_ae_script is available (desktop app with After Effects), build the package, then compare_ae_renders at the plan's frames. Fix the biggest cause and re-export; stop on a match, after 4 rounds, or when nothing improves, and say which."
  );
  lines.push(
    "5. Report what is native, what is approximate and by how much, what is baked, and what the AE user must install (the Toolbox Shader plug-in version, fonts). Never call a bake a port."
  );
  return lines.join("\n");
}
