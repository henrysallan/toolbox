// Proof: a group fragment survives the clipboard round trip.
//   preset.build() → serializeFragmentToText → (looksLike?) → parseFragmentText
//   → deserializeGraph → validateGraph still passes, node/edge counts preserved.
//
//   npx tsx scripts/check-fragment-roundtrip.mts

/* eslint-disable @typescript-eslint/no-explicit-any */
const g = globalThis as any;
const stub = () => ({ getContext: () => null, style: {}, addEventListener() {}, toDataURL: () => "" });
g.window ??= g;
g.self ??= g;
g.document ??= { createElement: stub, createElementNS: stub, fonts: { add() {}, forEach() {} }, body: { appendChild() {} }, addEventListener() {} };
g.navigator ??= { userAgent: "node" };
g.HTMLCanvasElement ??= class {};
g.HTMLImageElement ??= class {};
g.HTMLVideoElement ??= class {};
g.HTMLMediaElement ??= class {};
g.Image ??= class {};
g.Audio ??= class {};
g.Path2D ??= class {};
g.OffscreenCanvas ??= class { getContext() { return null; } };
g.WebGL2RenderingContext ??= class {};
g.AudioContext ??= class {};
g.requestAnimationFrame ??= () => 0;

const { registerAllNodes } = await import("@/nodes/index");
registerAllNodes();
const { PRESETS } = await import("@/state/presets");
const { serializeFragmentToText, parseFragmentText, looksLikeFragmentText } =
  await import("@/lib/fragment-clipboard");
const { deserializeGraph } = await import("@/lib/project");
const { validateGraph } = await import("@/engine/graph-validation");

const adapt = (nodes: any[], edges: any[]) => ({
  nodes: nodes.map((n) => ({ id: n.id, defType: n.data.defType, params: n.data.params })),
  edges: edges.map((e) => ({
    id: e.id, source: e.source, sourceHandle: e.sourceHandle, target: e.target, targetHandle: e.targetHandle,
  })),
});

let failures = 0;
const check = (label: string, cond: boolean, detail = "") => {
  if (!cond) failures++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${cond ? "" : `  — ${detail}`}`);
};

for (const p of PRESETS) {
  const frag = p.build();
  const text = await serializeFragmentToText(frag.nodes, frag.edges);
  const recognized = looksLikeFragmentText(text);
  const parsed = parseFragmentText(text);
  if (!parsed) {
    check(`${p.name}: round-trips`, false, "parseFragmentText returned null");
    continue;
  }
  const { nodes, edges } = await deserializeGraph(parsed);
  const r = validateGraph(adapt(nodes, edges).nodes, adapt(nodes, edges).edges);
  const errs = r.issues.filter((i) => i.severity === "error");
  const ok =
    recognized &&
    nodes.length === frag.nodes.length &&
    edges.length === frag.edges.length &&
    r.ok &&
    errs.length === 0;
  check(
    `${p.name.padEnd(22)} ${frag.nodes.length}n/${frag.edges.length}e → ${nodes.length}n/${edges.length}e`,
    ok,
    JSON.stringify({ recognized, errs: errs.map((e) => e.code) })
  );
}

// A non-fragment clipboard string must NOT be recognized.
check("plain text is not mistaken for a fragment", !looksLikeFragmentText("hello world"));

console.log(`\n${failures === 0 ? "ALL GREEN ✅" : `${failures} FAILURE(S) ❌`}`);
if (failures) process.exit(1);
