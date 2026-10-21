// The AE class table (src/lib/ae-export/classes.ts, spec §3): coverage over
// the real registry, no stale entries, and the `shader` rung agreeing with
// the GLSL translation table.

import { makeChecker, loadRegistry } from "./harness.mts";
import { AE_CLASS_ORDER, TBX_SHADER_MATCH_NAME, type AeExportClass } from "@/lib/ae-export/types";

export default async function run(): Promise<number> {
  const c = makeChecker("classes");
  await loadRegistry();
  const { allNodeDefs, getNodeDef } = await import("@/engine/registry");
  const { TRANSLATION_CLASSES } = await import("@/lib/glsl-translation/classes");
  const { BLEND_MODE_ORDER } = await import("@/nodes/effect/merge");
  const {
    AE_EXPORT_CLASSES,
    AE_MISSING_BLEND_MODES,
    AE_STRUCTURAL_TYPES,
    LIVE_INPUT_TYPES,
    SDF_CHAIN_TYPES,
    aeBlendModeOf,
    aeExportEntry,
    isAeClassified,
    isGlslFusable,
  } = await import("@/lib/ae-export/classes");

  const defs = allNodeDefs();
  const visible = defs.filter((d) => !d.hidden);

  // --- coverage ----------------------------------------------------------------
  const missing = visible.filter((d) => !isAeClassified(d.type)).map((d) => d.type);
  c.check(`every visible node type is classified (${visible.length} types)`, missing.length === 0, `missing: ${missing.join(", ")}`);
  const hiddenMissing = defs.filter((d) => d.hidden && !isAeClassified(d.type)).map((d) => d.type);
  c.check(`every hidden type is classified or structural (${defs.length - visible.length} types)`, hiddenMissing.length === 0, hiddenMissing.join(", "));
  const stale = Object.keys(AE_EXPORT_CLASSES).filter((t) => !getNodeDef(t));
  c.check("no entry names an unregistered type", stale.length === 0, stale.join(", "));
  c.check("an unknown type is unsupported, never guessed", aeExportEntry("no-such-node").class === "unsupported" && !isAeClassified("no-such-node"));

  // --- entry shape ----------------------------------------------------------------
  const bad: string[] = [];
  for (const [type, e] of Object.entries(AE_EXPORT_CLASSES)) {
    if (!AE_CLASS_ORDER.includes(e.class)) bad.push(`${type}: class ${e.class}`);
    if (e.class === "shader" && (e.ae !== TBX_SHADER_MATCH_NAME || !e.requires?.includes("host"))) bad.push(`${type}: shader without the host`);
    if (e.class === "bake" && !e.requires?.includes("footage")) bad.push(`${type}: bake without footage`);
    if (e.class === "bake" && e.fidelity !== "bake" && type !== "audio-source") bad.push(`${type}: bake fidelity ${e.fidelity}`);
    if (e.fidelity === "approx" && !e.note) bad.push(`${type}: approx without a note`);
    if (e.class === "effect" && !e.ae) bad.push(`${type}: effect without an AE match name`);
  }
  c.check("entries are well-formed (shader → host, bake → footage, approx → note, effect → match name)", bad.length === 0, bad.join("; "));

  // --- consistency with the GLSL translation table --------------------------------
  // A `shader` entry must be something planTranslation can fuse…
  const shaderNotFusable = Object.entries(AE_EXPORT_CLASSES)
    .filter(([t, e]) => e.class === "shader" && !isGlslFusable(t))
    .map(([t]) => `${t} (${TRANSLATION_CLASSES[t]?.class ?? "unclassified"})`);
  c.check("every shader entry is GLSL-fusable (pure|gather|multipass|compiled, or an SDF tree node)", shaderNotFusable.length === 0, shaderNotFusable.join(", "));
  // …and every fusable GLSL node without an AE twin is `shader`.
  const fusableNoTwin = Object.entries(TRANSLATION_CLASSES)
    .filter(([t, g]) => ["pure", "gather", "multipass", "compiled"].includes(g.class) && getNodeDef(t))
    .filter(([t]) => {
      const e = aeExportEntry(t);
      return e.class !== "shader" && !e.ae;
    })
    .map(([t]) => t);
  c.check("every fusable GLSL node is shader unless it names an AE twin", fusableNoTwin.length === 0, fusableNoTwin.join(", "));
  const statefulShader = Object.entries(TRANSLATION_CLASSES)
    .filter(([t, g]) => (g.class === "stateful" || g.class === "opaque") && aeExportEntry(t).class === "shader")
    .map(([t]) => t);
  c.check("no stateful/opaque GLSL node sits on the shader rung", statefulShader.length === 0, statefulShader.join(", "));
  const sdfTree = visible.filter((d) => d.type.startsWith("sdf-") && (d.primaryOutput === "sdf" || d.primaryOutput === "position")).map((d) => d.type);
  const sdfDrift = sdfTree.filter((t) => !SDF_CHAIN_TYPES.has(t) && aeExportEntry(t).class !== "bake");
  const sdfStale = [...SDF_CHAIN_TYPES].filter((t) => !sdfTree.includes(t));
  c.check("SDF_CHAIN_TYPES lists the registry's SDF tree nodes (texture-backed ones bake)", sdfDrift.length === 0 && sdfStale.length === 0, JSON.stringify({ sdfDrift, sdfStale }));
  // The GLSL table classes the same tree nodes `compiled` (they fuse into
  // their consumer), and the texture-backed ones opaque.
  const sdfGlsl = sdfTree.filter((t) => (TRANSLATION_CLASSES[t]?.class === "compiled") !== SDF_CHAIN_TYPES.has(t));
  c.check("the GLSL table classes exactly the SDF chain nodes compiled", sdfGlsl.length === 0, sdfGlsl.join(", "));

  // --- the rungs the v1 scope (§11.8) and the task pin ------------------------------
  const blur = aeExportEntry("blur");
  c.check("blur → effect ADBE Gaussian Blur 2, approx, notes the calibrated radius map", blur.class === "effect" && blur.ae === "ADBE Gaussian Blur 2" && blur.fidelity === "approx" && /calibrat/.test(blur.note ?? ""));
  const grad = aeExportEntry("gradient");
  c.check("gradient → effect ADBE Ramp, exact (2-stop linear/radial)", grad.class === "effect" && grad.ae === "ADBE Ramp" && grad.fidelity === "exact");
  c.check("text → text layer, approx", aeExportEntry("text").class === "text" && aeExportEntry("text").fidelity === "approx");
  c.check(
    "spline-fill / spline-stroke / rasterize-spline → style; gradients route through .ffx",
    ["spline-fill", "spline-stroke", "rasterize-spline"].every((t) => aeExportEntry(t).class === "style") &&
      /\.ffx/.test(aeExportEntry("spline-stroke").note ?? "") &&
      /\.ffx/.test(aeExportEntry("rasterize-spline").note ?? "")
  );
  c.check("transform / gizmo → transform; merge → layer", aeExportEntry("transform").class === "transform" && aeExportEntry("gizmo").class === "transform" && aeExportEntry("merge").class === "layer");
  c.check("circle stays parametric (shape:ellipse)", aeExportEntry("circle").ae === "shape:ellipse" && aeExportEntry("circle").fidelity === "exact");
  const liveWrong = [...LIVE_INPUT_TYPES].filter((t) => aeExportEntry(t).class !== "unsupported" || !getNodeDef(t));
  c.check("live inputs (pointer, draggable, hit-region, cursor, cursor-trail-points, drag-points, webcam) are unsupported", liveWrong.length === 0, liveWrong.join(", "));
  const unsupportedNotLive = Object.entries(AE_EXPORT_CLASSES).filter(([t, e]) => e.class === "unsupported" && !LIVE_INPUT_TYPES.has(t)).map(([t]) => t);
  c.check("only live inputs are unsupported", unsupportedNotLive.length === 0, unsupportedNotLive.join(", "));
  const sims = defs.filter((d) => d.simulation && !d.hidden).map((d) => d.type).filter((t) => aeExportEntry(t).class !== "bake" && aeExportEntry(t).fidelity !== "sampled" && aeExportEntry(t).class !== "effect");
  c.check("simulation nodes bake (or are sampled value/path nodes, or name an AE effect twin like Echo)", sims.length === 0, sims.join(", "));
  c.check("structural types are classified", [...AE_STRUCTURAL_TYPES].every((t) => isAeClassified(t)));

  // --- blend modes ---------------------------------------------------------------------
  const unmapped = BLEND_MODE_ORDER.filter((m) => !AE_MISSING_BLEND_MODES.has(m) && !aeBlendModeOf(m));
  c.check(`every toolbox blend mode maps to AE or is one of the five without (${BLEND_MODE_ORDER.length} modes)`, unmapped.length === 0, unmapped.join(", "));
  c.check(
    "Average, Negation, Reflect, Glow, Phoenix have no AE mode; mix is Normal",
    ["average", "negation", "reflect", "glow", "phoenix"].every((m) => aeBlendModeOf(m) === null) && aeBlendModeOf("mix") === "normal" && BLEND_MODE_ORDER.length - AE_MISSING_BLEND_MODES.size === 24
  );

  // --- counts per rung (informational) -------------------------------------------------
  const counts = new Map<AeExportClass, number>();
  for (const d of visible) {
    const k = aeExportEntry(d.type).class;
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  console.log(`  ·    visible types per rung: ${AE_CLASS_ORDER.map((k) => `${k} ${counts.get(k) ?? 0}`).join(", ")}`);
  return c.failures;
}
