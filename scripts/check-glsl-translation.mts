// check-glsl-translation: the graph → GLSL gate (spec 091626_graph-to-glsl.md
// §Verification). Offline, in `npm run check`.
//
//   1. Every visible node that emits an image (primary or aux) has an entry
//      in src/lib/glsl-translation/classes.ts.
//   2. Every entry that names a `doc` has the doc; every node doc's
//      frontmatter (`type`, `class`) agrees with the table.
//   3. docs.generated.ts is up to date with docs/**/*.md.
//   4. get_glsl_docs: core docs lead, unknown slugs are reported not
//      swallowed, the size cap cuts and says so.
//   5. planTranslation on fixture graphs built from the REAL registry:
//      a pure chain fuses whole (zero frontier), a video source becomes a
//      sampler, a stateful node splits the region, an interior matte is a
//      matte, the target's own mask goes to the fused node's mask socket,
//      and a graph past the sampler cap shrinks with a named exclusion.
//
//   npx tsx scripts/check-glsl-translation.mts
import { execFileSync } from "node:child_process";
import { registerAllNodes } from "@/nodes";

registerAllNodes();
const { allNodeDefs, getNodeDef } = await import("@/engine/registry");
const { withMaskInput } = await import("@/engine/conventions");
const { SETTABLE_PARAM_TYPES } = await import("@/engine/node-catalog");
const {
  TRANSLATION_CLASSES,
  FUSABLE_CLASSES,
  GLSL_DOCS,
  getGlslDocs,
  planTranslation,
  proposeFrames,
  compareRgba,
  diffHeatRgba,
} = await import("@/lib/glsl-translation");
type PlanInput = import("@/lib/glsl-translation").PlanInput;
type PlanNode = import("@/lib/glsl-translation").PlanNode;
type PlanEdge = import("@/lib/glsl-translation").PlanEdge;

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

// --- 1. coverage ------------------------------------------------------------
const visible = allNodeDefs().filter((d) => !d.hidden);
const imageProducers = visible.filter(
  (d) =>
    d.primaryOutput === "image" ||
    d.primaryOutput === "mask" ||
    d.primaryOutput === "uv" ||
    (d.auxOutputs ?? []).some((a) => a.type === "image")
);
const unclassified = imageProducers.filter((d) => !(d.type in TRANSLATION_CLASSES)).map((d) => d.type);
check(
  `every visible image producer is classified (${imageProducers.length} defs)`,
  unclassified.length === 0,
  unclassified.length ? `missing: ${unclassified.join(", ")}` : undefined
);
const stale = Object.keys(TRANSLATION_CLASSES).filter((t) => !getNodeDef(t));
check("no table entry names an unregistered type", stale.length === 0, stale.join(", "));

// --- 2. docs ↔ table -------------------------------------------------------
const docMissing: string[] = [];
for (const [type, entry] of Object.entries(TRANSLATION_CLASSES)) {
  if (!entry.doc) continue;
  if (!GLSL_DOCS[`nodes/${entry.doc}`]) docMissing.push(`${type} → nodes/${entry.doc}`);
}
check("every `doc` in the table exists", docMissing.length === 0, docMissing.join(", "));
const docMismatch: string[] = [];
for (const doc of Object.values(GLSL_DOCS)) {
  if (!doc.slug.startsWith("nodes/")) continue;
  if (!doc.type) {
    docMismatch.push(`${doc.slug}: no type`);
    continue;
  }
  const entry = TRANSLATION_CLASSES[doc.type];
  if (!entry) docMismatch.push(`${doc.slug}: type ${doc.type} not in table`);
  else if (doc.class && doc.class !== entry.class)
    docMismatch.push(`${doc.slug}: class ${doc.class} ≠ table ${entry.class}`);
  else if (!FUSABLE_CLASSES.has(entry.class)) docMismatch.push(`${doc.slug}: ${entry.class} nodes need no doc`);
  else if (`nodes/${entry.doc}` !== doc.slug) docMismatch.push(`${doc.slug}: table points at ${entry.doc}`);
}
check("node docs agree with the table", docMismatch.length === 0, docMismatch.join("; "));
for (const doc of Object.values(GLSL_DOCS)) {
  const fences = doc.body.match(/```glsl-body/g)?.length ?? 0;
  if (doc.slug.startsWith("nodes/"))
    check(`${doc.slug} carries a glsl-body snippet`, fences >= 1);
}

// --- 3. generated module is fresh -------------------------------------------
try {
  execFileSync("npx", ["tsx", "scripts/gen-glsl-docs.mts", "--check"], { stdio: "pipe" });
  check("docs.generated.ts is up to date", true);
} catch (e) {
  check("docs.generated.ts is up to date", false, String((e as { stderr?: Buffer }).stderr ?? e).trim());
}

// --- 4. get_glsl_docs -------------------------------------------------------
{
  const all = getGlslDocs();
  check(
    "default docs lead with conventions, fusion, parity",
    all.indexOf("## conventions") < all.indexOf("## fusion") && all.indexOf("## fusion") < all.indexOf("## parity")
  );
  check("conventions state the Y orientation", all.includes("Y-UP") && all.includes("Y-DOWN"));
  check("conventions state straight alpha", /straight alpha/i.test(all));
  check("conventions carry the p-space formula", all.includes("(v_uv.y - 0.5) / u_aspect + 0.5"));
  const miss = getGlslDocs({ slugs: ["conventions", "nodes/does-not-exist"] });
  check("unknown slug is reported, not swallowed", miss.includes("No doc for: nodes/does-not-exist") && miss.includes("## conventions"));
  const byType = getGlslDocs({ types: ["displace"] });
  check(
    "types= resolves through the table (displace has no doc yet → reported)",
    byType.includes("## conventions") && /No doc for: nodes\/(displace)/.test(byType) === !GLSL_DOCS["nodes/displace"]
  );
  const capped = getGlslDocs({ cap: 3000 });
  check("size cap cuts and names the cut docs", capped.includes("Cut for size") && capped.includes("## conventions"));
}

// --- 5. planner fixtures ------------------------------------------------------
function info(type: string, params: Record<string, unknown>) {
  const def = getNodeDef(type);
  if (!def) throw new Error(`fixture uses unknown type ${type}`);
  let ins = def.inputs;
  try {
    ins = def.resolveInputs?.(params) ?? def.inputs;
  } catch {
    ins = def.inputs;
  }
  ins = withMaskInput(ins, def);
  return {
    inputs: ins.map((i) => ({ name: i.name, type: i.type as string })),
    primaryOutput: def.primaryOutput as string | undefined,
    auxOutputs: (def.auxOutputs ?? []).map((a) => ({ name: a.name, type: a.type as string })),
    readsTime: !!def.facts?.reads?.includes("time"),
    simulation: !!def.simulation,
    params: def.params
      .filter((p) => SETTABLE_PARAM_TYPES.has(p.type))
      .map((p) => ({ name: p.name, type: p.type as string, min: p.min, max: p.max, options: p.options as string[] | undefined, default: p.default })),
  };
}
function defaults(type: string): Record<string, unknown> {
  const def = getNodeDef(type)!;
  const out: Record<string, unknown> = {};
  for (const p of def.params) out[p.name] = p.default;
  return out;
}
function fixture(
  nodes: { id: string; type: string; params?: Record<string, unknown>; keyframed?: string[]; parent?: string }[],
  edges: PlanEdge[],
  target: string,
  extra: Partial<PlanInput> = {}
): PlanInput {
  const values = new Map(nodes.map((n) => [n.id, { ...defaults(n.type), ...(n.params ?? {}) }]));
  const planNodes: PlanNode[] = nodes.map((n) => ({ id: n.id, type: n.type, params: n.params ?? {}, keyframed: n.keyframed ?? [], ...(n.parent ? { parent: n.parent } : {}) }));
  return {
    nodes: planNodes,
    edges,
    target,
    scopeId: "layer-1",
    infoOf: (id) => {
      const n = nodes.find((x) => x.id === id);
      return n ? info(n.type, values.get(id)!) : undefined;
    },
    valuesOf: (id) => values.get(id) ?? {},
    keyframeFramesOf: (id) => (id === "ramp" ? [12, 48] : []),
    frame: 10,
    fps: 60,
    loopFrames: 120,
    canvas: { width: 1920, height: 1080 },
    ...extra,
  };
}

// (a) pure chain: noise → color-ramp → displace(map: noise2) → mirror
{
  const plan = planTranslation(
    fixture(
      [
        { id: "noise", type: "noise", params: { scale: 3 } },
        { id: "ramp", type: "color-ramp", keyframed: ["offset"] },
        { id: "noise2", type: "noise", params: { seed: 7 } },
        { id: "disp", type: "displace", params: { amountX: 0.05 } },
        { id: "mir", type: "mirror" },
      ],
      [
        { from: "noise:out", to: "ramp:in:image" },
        { from: "ramp:out", to: "disp:in:source" },
        { from: "noise2:out", to: "disp:in:map" },
        { from: "disp:out", to: "mir:in:image" },
      ],
      "mir"
    )
  );
  check("(a) whole pure chain fuses", plan.region.length === 5 && !plan.refusal, JSON.stringify({ region: plan.region, refusal: plan.refusal, excluded: plan.excluded }));
  check("(a) zero frontier", plan.frontier.length === 0, JSON.stringify(plan.frontier));
  check("(a) producers first, target last", plan.region[plan.region.length - 1] === "mir" && plan.region.indexOf("noise") < plan.region.indexOf("ramp"));
  check("(a) time dependent (noise reads time) with proposed frames", plan.time.dependent && plan.time.frames.length >= 4 && plan.time.frames.includes(12) && plan.time.frames.includes(48), JSON.stringify(plan.time));
  const rampNode = plan.nodes.find((n) => n.id === "ramp")!;
  check("(a) paramDefs carry current values + ranges", rampNode.paramDefs.length > 0 && rampNode.paramDefs.every((p) => "value" in p), JSON.stringify(rampNode.paramDefs.slice(0, 2)));
  check("(a) displace is a gather: upstream evaluations ≥ 1 and cost sums", plan.cost.evaluationsPerPixel >= 5, String(plan.cost.evaluationsPerPixel));
  const addNode = plan.skeleton.ops.find((o) => o.op === "add_node") as { params?: { on_error?: string } };
  check("(a) skeleton adds a glsl-expression with on_error transparent and no output wire", addNode?.params?.on_error === "transparent" && !plan.skeleton.ops.some((o) => String(o.to ?? "").includes("output")), JSON.stringify(plan.skeleton.ops));
  check(
    "(a) core docs + node docs listed; undocumented types become source hints",
    plan.docs.includes("conventions") &&
      plan.docs.includes("nodes/noise") &&
      plan.docs.includes("nodes/displace") &&
      plan.sourceHints.some((h) => h.type === "color-ramp") &&
      !plan.sourceHints.some((h) => h.type === "noise"),
    JSON.stringify({ docs: plan.docs, hints: plan.sourceHints.map((h) => h.type) })
  );
}

// (b) video → blur → threshold: the video is a sampler; blur is multipass (warned)
{
  const plan = planTranslation(
    fixture(
      [
        { id: "vid", type: "video-source" },
        { id: "blur", type: "blur", params: { radius: 12 } },
        { id: "thr", type: "threshold" },
      ],
      [
        { from: "vid:out", to: "blur:in:image" },
        { from: "blur:out", to: "thr:in:image" },
      ],
      "thr"
    )
  );
  check("(b) blur + threshold fuse, video is excluded as stateful", plan.region.join(",") === "blur,thr" && plan.excluded.some((x) => x.id === "vid" && x.class === "stateful"), JSON.stringify({ region: plan.region, excluded: plan.excluded }));
  check("(b) video becomes sampler a", plan.frontier.length === 1 && plan.frontier[0].kind === "image" && plan.frontier[0].slot === "a" && plan.frontier[0].from === "vid:out", JSON.stringify(plan.frontier));
  check("(b) skeleton wires vid:out → glsl:in:a", plan.skeleton.ops.some((o) => o.op === "add_edge" && o.from === "vid:out" && o.to === "glsl:in:a"));
  check("(b) multipass approximation is warned", plan.cost.warnings.some((w) => w.includes("blur") && w.includes("approximation")), plan.cost.warnings.join(" | "));
}

// (c) stateful in the middle: noise → trails → posterize. Only posterize fuses.
{
  const plan = planTranslation(
    fixture(
      [
        { id: "noise", type: "noise" },
        { id: "trails", type: "trails" },
        { id: "post", type: "posterize" },
      ],
      [
        { from: "noise:out", to: "trails:in:image" },
        { from: "trails:out", to: "post:in:image" },
      ],
      "post"
    )
  );
  check("(c) region stops at the stateful node", plan.region.join(",") === "post" && plan.frontier.some((f) => f.from === "trails:out" && f.slot === "a"), JSON.stringify({ region: plan.region, frontier: plan.frontier }));
  check("(c) the noise upstream of trails is not visited", !plan.excluded.some((x) => x.id === "noise") && !plan.region.includes("noise"));
}

// (d) refusal: target is stateful
{
  const plan = planTranslation(
    fixture([{ id: "trails", type: "trails" }], [], "trails")
  );
  check("(d) stateful target refuses with a reason", plan.region.length === 0 && !!plan.refusal && /stateful/.test(plan.refusal), plan.refusal);
}

// (e) interior matte + target mask + target opacity + channel wire
{
  const plan = planTranslation(
    fixture(
      [
        { id: "img", type: "image-source" },
        { id: "shape", type: "circle" },
        { id: "shape2", type: "rectangle" },
        { id: "lfo", type: "lfo" },
        { id: "post", type: "posterize" },
        { id: "thr", type: "threshold", params: { opacity: 0.5 } },
      ],
      [
        { from: "img:out", to: "post:in:image" },
        { from: "shape:aux:image", to: "post:in:mask" }, // interior matte on posterize
        { from: "lfo:out", to: "post:param:levels" }, // wired scalar param
        { from: "post:out", to: "thr:in:image" },
        { from: "shape2:aux:image", to: "thr:in:mask" }, // target's own mask
      ],
      "thr"
    )
  );
  const matte = plan.frontier.find((f) => f.matte);
  check("(e) interior matte is a matte frontier with a slot", !!matte && matte.toNode === "post" && !!matte.slot, JSON.stringify(plan.frontier));
  check("(e) target's own mask leaves the frontier and wires to glsl:in:mask", plan.targetMask === "shape2:aux:image" && !plan.frontier.some((f) => f.from === "shape2:aux:image") && plan.skeleton.ops.some((o) => o.to === "glsl:in:mask"), JSON.stringify({ mask: plan.targetMask, ops: plan.skeleton.ops }));
  check("(e) target opacity is reported", plan.targetOpacity === 0.5, String(plan.targetOpacity));
  check("(e) wired scalar param is a channel wire", plan.frontier.some((f) => f.kind === "channel" && f.from === "lfo:out") && plan.skeleton.channelEdges.some((c) => c.drives === "post.levels"), JSON.stringify(plan.skeleton.channelEdges));
  const slots = new Set(plan.frontier.filter((f) => f.kind === "image").map((f) => f.slot));
  check("(e) image slots are distinct", slots.size === plan.frontier.filter((f) => f.kind === "image").length, [...slots].join(","));
}

// (f) sampler cap: a 5-layer merge of textures → threshold. Merge must be
//     excluded (it alone needs 5 samplers) and wired in as one input.
{
  const layers = [1, 2, 3, 4, 5].map((i) => ({ id: `L${i}`, mode: "normal", opacity: 1 }));
  const nodes = [
    ...[1, 2, 3, 4, 5].map((i) => ({ id: `img${i}`, type: "image-source" })),
    { id: "merge", type: "merge", params: { layers } },
    { id: "thr", type: "threshold" },
  ];
  const edges: PlanEdge[] = [
    ...[1, 2, 3, 4, 5].map((i) => ({ from: `img${i}:out`, to: `merge:in:layer:L${i}` })),
    { from: "merge:out", to: "thr:in:image" },
  ];
  const plan = planTranslation(fixture(nodes, edges, "thr"));
  const mergeExcluded = plan.excluded.find((x) => x.id === "merge");
  check("(f) over-cap merge is excluded with the cap reason", !!mergeExcluded && /sampler cap/.test(mergeExcluded.reason), JSON.stringify(plan.excluded));
  check("(f) region shrinks to the target and merge is one sampler", plan.region.join(",") === "thr" && plan.frontier.length === 1 && plan.frontier[0].from === "merge:out", JSON.stringify({ region: plan.region, frontier: plan.frontier }));
}

// (g) proposeFrames
{
  check("static graph → the current frame only", proposeFrames(false, 10, 120, []).join(",") === "10");
  const f = proposeFrames(true, 10, 120, [12, 48]);
  check("animated → keyframes kept, evenly filled, sorted, ≤ 8", f.includes(12) && f.includes(48) && f.length >= 4 && f.length <= 8 && f.every((v, i) => i === 0 || v > f[i - 1]), f.join(","));
  const many = proposeFrames(true, 0, 300, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  check("too many keyframes → capped at 8 and still sorted", many.length <= 8 && many.every((v, i) => i === 0 || v > many[i - 1]), many.join(","));
}

// (h) zone boundary: a node inside a Repeat zone does not fuse with a target outside
{
  const plan = planTranslation(
    fixture(
      [
        { id: "noise", type: "noise", parent: "repeat-1" },
        { id: "post", type: "posterize" },
      ],
      [{ from: "noise:out", to: "post:in:image" }],
      "post"
    )
  );
  check("(h) zone member is excluded and becomes a sampler", plan.region.join(",") === "post" && plan.excluded.some((x) => x.id === "noise" && /zone/.test(x.reason)) && plan.frontier[0]?.from === "noise:out", JSON.stringify(plan.excluded));
}

// --- 6. compare metrics -------------------------------------------------------
{
  const W = 32,
    H = 16;
  const make = (fill: (x: number, y: number) => [number, number, number, number]) => {
    const out = new Uint8ClampedArray(W * H * 4);
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const [r, g, b, a] = fill(x, y);
        out.set([r, g, b, a], (y * W + x) * 4);
      }
    return out;
  };
  const grad = make((x) => [Math.round((255 * x) / (W - 1)), 128, 64, 255]);
  const same = compareRgba(grad, grad, W, H);
  check("identical buffers → match with zero error", same.verdict === "match" && same.meanAbs === 0 && same.p95Abs === 0 && same.worstBox === null && same.compared === 1, JSON.stringify(same));
  // Right half wrong by a lot → off, worst box on the right (x0 ≥ 0.5).
  const rightBad = make((x) => [x >= W / 2 ? 0 : Math.round((255 * x) / (W - 1)), 128, 64, 255]);
  const off = compareRgba(grad, rightBad, W, H);
  check("gross right-half error → off with the worst box on the right", off.verdict === "off" && !!off.worstBox && off.worstBox.x0 >= 0.5 && off.worstBox.x1 === 1 && off.overThreshold > 0.4, JSON.stringify(off));
  // Tiny uniform error (2/255) → match: under the floor.
  const tiny = make((x) => [Math.min(255, Math.round((255 * x) / (W - 1)) + 2), 128, 64, 255]);
  const near = compareRgba(grad, tiny, W, H);
  check("2/255 uniform error → match", near.verdict === "match" && near.overThreshold === 0, JSON.stringify(near));
  // Alpha-only difference: RGB equal, alpha halved on the left → alpha error, RGB still compared.
  const alphaHalf = make((x) => [Math.round((255 * x) / (W - 1)), 128, 64, x < W / 2 ? 128 : 255]);
  const am = compareRgba(grad, alphaHalf, W, H);
  check("alpha-only mismatch shows in alphaMeanAbs, not meanAbs", am.meanAbs === 0 && am.alphaMeanAbs > 0.2 && am.verdict === "off", JSON.stringify(am));
  // Transparent pixels are skipped for RGB: garbage under alpha 0 is invisible.
  const transparentGarbage = make((x, y) => (y < H / 2 ? [255, 0, 255, 0] : [Math.round((255 * x) / (W - 1)), 128, 64, 255]));
  const transparentClean = make((x, y) => (y < H / 2 ? [0, 0, 0, 0] : [Math.round((255 * x) / (W - 1)), 128, 64, 255]));
  const tm = compareRgba(transparentGarbage, transparentClean, W, H);
  check("RGB under alpha 0 is ignored; compared fraction reports it", tm.verdict === "match" && tm.compared === 0.5, JSON.stringify(tm));
  // Heat image: same size, opaque, red where the error is.
  const heat = diffHeatRgba(grad, rightBad, W, H);
  check("diff heat is opaque RGBA at analysis size, hot on the right", heat.length === W * H * 4 && heat[(W - 1) * 4] > 200 && heat[3] === 255 && heat[0] === 0, `${heat.length} ${heat[(W - 1) * 4]}`);
}

console.log(failures ? `\n${failures} failure(s)` : "\nall checks passed");
process.exit(failures ? 1 : 0);
