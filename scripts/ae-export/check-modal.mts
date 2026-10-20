// ExportAeModal's pure helpers (src/components/effects/ae-export-ui.ts): the
// coverage tree, override choices, options ↔ policy, and the Claude prompt.
// The modal itself can't be rendered offline (the editor needs sign-in), so
// everything it decides lives in these functions.

import { makeChecker } from "./harness.mts";
import {
  AE_CLASS_CHIP,
  AE_ROUTE_TEXT,
  aeConvertPrompt,
  aeCoverage,
  aeOptionsFromPolicy,
  aeOverridesFor,
  aePolicyFromOptions,
  aeSummaryLine,
  aeWithBudget,
} from "@/components/effects/ae-export-ui";
import { AE_CLASS_ORDER, DEFAULT_AE_POLICY, type AeExportPlan, type AePlanNode } from "@/lib/ae-export/types";

function node(id: string, type: string, cls: AePlanNode["class"], fidelity: AePlanNode["fidelity"], notes: string[] = []): AePlanNode {
  return { id, type, class: cls, fidelity, notes, segment: 0 };
}

const PLAN: AeExportPlan = {
  route: "direct+shader",
  composition: { id: "comp", name: "Main", width: 1920, height: 1080, fps: 30, durationFrames: 120 },
  layers: [
    {
      id: "L1",
      name: "Shapes",
      windows: [{ inFrame: 0, outFrame: 120, sourceInFrame: 0 }],
      segments: [],
      nodes: [
        node("c1", "circle", "vector", "exact"),
        node("f1", "spline-fill", "style", "exact"),
        node("b1", "blur", "effect", "approx", ["Gaussian Blur, uncalibrated"]),
        node("p1", "copy-to-points", "instances", "bake", ["500 copies exceed the 200-layer budget"]),
      ],
    },
    {
      id: "L2",
      name: "Fx",
      windows: [
        { inFrame: 0, outFrame: 30, sourceInFrame: 0 },
        { inFrame: 60, outFrame: 90, sourceInFrame: 0 },
      ],
      segments: [],
      nodes: [node("n1", "noise", "shader", "exact"), node("d1", "displace", "shader", "exact"), node("ptr", "pointer", "unsupported", "bake")],
    },
  ],
  shaderRegions: [{ id: "r1", target: "d1:out", nodes: ["n1", "d1"], frames: [0, 60], summary: "2 nodes, 9 evals/px" }],
  bakes: [],
  expressions: [],
  blocked: [],
  approximations: [{ id: "b1", type: "blur", note: "Gaussian Blur" }],
  estimates: { layers: 3, keyframes: 1, footageMB: 0 },
  fonts: [],
  policy: DEFAULT_AE_POLICY,
  warnings: [],
};

export default async function run(): Promise<number> {
  const c = makeChecker("modal");

  c.check("every class has a chip", AE_CLASS_ORDER.every((k) => !!AE_CLASS_CHIP[k]?.label && AE_CLASS_CHIP[k].color.startsWith("var(--tb-")));
  c.check("every route has text", (["direct", "direct+bake", "direct+shader", "blocked"] as const).every((r) => !!AE_ROUTE_TEXT[r]?.detail));

  const cov = aeCoverage(PLAN);
  c.check("coverage keeps one entry per plan layer, in order", cov.map((l) => l.id).join() === "L1,L2");
  c.check("windows render as inclusive frame ranges", cov[0].windows === "frames 0–119" && cov[1].windows === "frames 0–29, 60–89", cov.map((l) => l.windows));
  c.check(
    "counts follow the ladder order",
    cov[0].counts.map((x) => `${x.n} ${x.class}`).join(", ") === "1 vector, 1 style, 1 effect, 1 instances",
    cov[0].counts
  );

  c.check("a native node can be forced to bake or skipped", aeOverridesFor(node("x", "circle", "vector", "exact")).join() === "bake,skip");
  c.check("an over-budget instance node offers keep-procedural", aeOverridesFor(PLAN.layers[0].nodes[3]).includes("procedural"));
  c.check("a bake node can't be forced to bake again", !aeOverridesFor(node("x", "particles", "bake", "bake")).includes("bake"));
  c.check("a live input can only be skipped", aeOverridesFor(node("x", "pointer", "unsupported", "bake")).join() === "skip");

  const opts = aeOptionsFromPolicy();
  c.check("default options are the §11 policy", opts.fidelity === "editable" && opts.color === "auto" && opts.layerBudget === 200);
  c.check("unchanged options give an empty policy", Object.keys(aePolicyFromOptions(opts)).length === 0);
  c.check("changed options give only the diff", JSON.stringify(aePolicyFromOptions({ ...opts, fidelity: "exact", bitsPerChannel: 32 })) === '{"fidelity":"exact","bitsPerChannel":32}');
  c.check("layer budget clamps and rounds", aeWithBudget(opts, "12.6").layerBudget === 13 && aeWithBudget(opts, "-4").layerBudget === 1 && aeWithBudget(opts, "abc").layerBudget === 200);

  c.check("summary line", aeSummaryLine(PLAN) === "3 layers · 1 keyframe", aeSummaryLine(PLAN));
  c.check("summary shows footage when there is some", aeSummaryLine({ ...PLAN, estimates: { layers: 1, keyframes: 0, footageMB: 42.4 } }) === "1 layer · 0 keyframes · 42 MB footage");

  const prompt = aeConvertPrompt(PLAN, "Launch", { fidelity: "exact" });
  c.check("prompt names the package", prompt.includes('"Launch"'));
  c.check("prompt lists every region target with its frames", prompt.includes("target d1:out (2 nodes; check frames 0, 60)"), prompt);
  for (const tool of ["plan_ae_export", "plan_glsl_translation", "get_glsl_docs", "get_shader_errors", "compare_renders", "validate_ae_shader", "export_ae_package", "run_ae_script", "compare_ae_renders"]) {
    c.check(`prompt uses ${tool}`, prompt.includes(tool));
  }
  c.check("prompt passes the policy diff and asks for the fused map", prompt.includes('{"fidelity":"exact"}') && prompt.includes("fused = {"));
  c.check("prompt keeps the bake-honesty rule", prompt.includes("Never call a bake a port."));
  c.check("no-region prompt says so", aeConvertPrompt({ ...PLAN, shaderRegions: [] }, "X", {}).includes("no shader regions"));

  return c.failures;
}
