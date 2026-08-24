// Proof: user node presets ("Save as Preset", 081226_user-node-presets.md).
//   1. A single node (params changed from defaults, custom name, keyframes)
//      and a group-with-interior both survive the preset round trip:
//      serializeGraph → sanitize (untrusted-JSON gate) → deserializeGraph,
//      with node/edge counts, params, and data.name preserved.
//   2. sanitize drops malformed rows (non-array, missing name, fragment
//      without a nodes array) and caps the list length.
//
//   npx tsx scripts/check-node-presets.mts

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
// state/node-presets.ts pulls the Supabase browser client transitively;
// give it env so the import doesn't throw in Node.
process.env.NEXT_PUBLIC_SUPABASE_URL ??= "http://localhost";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "anon";
g.localStorage ??= {
  getItem: () => null,
  setItem() {},
  removeItem() {},
};

const { registerAllNodes } = await import("@/nodes/index");
registerAllNodes();
const { makeInstanceNode, refreshNodeSockets, expandWithDescendants, newEdgeId } =
  await import("@/state/graph-ops");
const { groupFragment } = await import("@/state/group-fragment");
const { serializeGraph, deserializeGraph } = await import("@/lib/project");
const { sanitizeNodePresets } = await import("@/state/node-presets");

let failures = 0;
const check = (label: string, cond: boolean, detail = "") => {
  if (!cond) failures++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${cond ? "" : `  — ${detail}`}`);
};

// --- 1a. Single node, non-default params + custom name + keyframes -------
{
  const n = makeInstanceNode("circle", { x: 40, y: 60 });
  n.data.params = { ...n.data.params, radiusX: 0.31, radiusY: 0.07 };
  n.data.name = "My Special Circle";
  n.data.animation = {
    radiusX: {
      keyframes: [
        { tick: 0, value: 0.1, easing: "linear" },
        { tick: 60, value: 0.31, easing: "linear" },
      ],
    },
  } as any;
  refreshNodeSockets(n);

  const saved = await serializeGraph([n], []);
  const [preset] = sanitizeNodePresets([
    { id: "p1", name: "  My Circle  ", fragment: saved },
  ]);
  if (!preset) {
    check("single node: sanitize accepts a real fragment", false, "row dropped");
  } else {
    check("single node: name trimmed", preset.name === "My Circle", preset.name);
    const { nodes, edges } = await deserializeGraph(preset.fragment);
    const rn = nodes[0];
    check(
      "single node: round-trips 1n/0e",
      nodes.length === 1 && edges.length === 0,
      `${nodes.length}n/${edges.length}e`
    );
    check(
      "single node: params survive",
      rn?.data.params.radiusX === 0.31 && rn?.data.params.radiusY === 0.07,
      JSON.stringify(rn?.data.params)
    );
    check("single node: custom name survives", rn?.data.name === "My Special Circle", String(rn?.data.name));
    check(
      "single node: keyframes survive",
      (rn?.data.animation as any)?.radiusX?.keyframes?.length === 2,
      JSON.stringify(rn?.data.animation ?? null)
    );
  }
}

// --- 1b. Group with interior (the Save-as-Preset capture shape) ----------
{
  const a = makeInstanceNode("circle", { x: 0, y: 0 });
  const b = makeInstanceNode("spline-stroke", { x: 240, y: 0 });
  const frag = groupFragment({
    name: "Preset Group",
    interior: [a, b],
    edges: [
      { id: newEdgeId(), source: a.id, sourceHandle: "out:primary", target: b.id, targetHandle: "in:path" },
    ],
    outputs: [
      { from: { nodeId: b.id, handle: "out:primary" }, name: "image", type: "image" },
    ],
  });
  // Same expansion the save path runs: the shell brings its interior.
  const shell = frag.nodes.find((n) => !n.data.parentId)!;
  const ids = expandWithDescendants(frag.nodes, [shell.id]);
  check(
    "group: expandWithDescendants captures the interior",
    ids.size === frag.nodes.length,
    `${ids.size} of ${frag.nodes.length}`
  );
  const saved = await serializeGraph(frag.nodes, frag.edges);
  const [preset] = sanitizeNodePresets([{ id: "p2", name: "G", fragment: saved }]);
  const { nodes, edges } = await deserializeGraph(preset!.fragment);
  check(
    "group: round-trips node/edge counts",
    nodes.length === frag.nodes.length && edges.length === frag.edges.length,
    `${frag.nodes.length}n/${frag.edges.length}e → ${nodes.length}n/${edges.length}e`
  );
}

// --- 2. sanitize gates untrusted JSON ------------------------------------
{
  check("sanitize: non-array → []", sanitizeNodePresets("junk").length === 0);
  check(
    "sanitize: rows without name/fragment dropped",
    sanitizeNodePresets([
      null,
      42,
      { name: "", fragment: { nodes: [] } },
      { name: "no fragment" },
      { name: "bad fragment", fragment: { nodes: "not an array" } },
    ]).length === 0
  );
  const minted = sanitizeNodePresets([
    { name: "no id", fragment: { nodes: [] } },
  ]);
  check(
    "sanitize: missing id re-minted",
    minted.length === 1 && typeof minted[0].id === "string" && minted[0].id.length > 0
  );
  const overCap = sanitizeNodePresets(
    Array.from({ length: 100 }, (_, i) => ({
      id: `p${i}`,
      name: `P${i}`,
      fragment: { nodes: [] },
    }))
  );
  check("sanitize: list capped at 60", overCap.length === 60, String(overCap.length));
}

console.log(`\n${failures === 0 ? "ALL GREEN ✅" : `${failures} FAILURE(S) ❌`}`);
if (failures) process.exit(1);
