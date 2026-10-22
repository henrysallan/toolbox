// Can toolbox's own point / spline code run outside the browser?
// (specdocs/102126_ae-rig-export.md §6, the geometry host.) Evaluates every
// corpus project's active composition with the real evaluator on a GL-less
// RenderContext (dataOnlyContext, the Skia exporter's), at two frames, and
// records for each node that outputs points or a spline: did it compute,
// what did it produce, how long did it take, and does it read an image
// (a field another AE layer would have to supply).
//
//   npx tsx scripts/ae-rig/portability.mts [.corpus/ae-rig]
//
// GL is a permissive shim: every call is a no-op that returns a dummy
// object, and pixel readbacks return zeros. A node that only keeps GPU
// textures on the side (Points on Path's image aux) computes its geometry
// as usual. A node whose geometry comes FROM the GPU (a readback, a GPU
// solver) computes nothing, so it shows as empty. A node that samples a
// wired image computes from blank pixels; it counts as running, flagged
// `reads image`. Writes <corpus>/portability.json and portability.md.

/* eslint-disable @typescript-eslint/no-explicit-any */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { loadRegistry } from "../ae-export/harness.mts";

const corpus = resolve(process.argv[2] ?? ".corpus/ae-rig");

await loadRegistry();
// ML nodes report load progress through window events, after compute returns.
const g0 = globalThis as any;
g0.dispatchEvent ??= () => true;
g0.CustomEvent ??= class {
  constructor(public type: string, public init?: unknown) {}
};
const { deserializeGraph } = await import("@/lib/project");
const { flattenAeComposition } = await import("@/lib/ae-export/editor");
const { evaluateGraph } = await import("@/engine/evaluator");
const { dataOnlyContext } = await import("@/lib/skia-export/scene-sample");
const { getNodeDef } = await import("@/engine/registry");
const { DEFAULT_TICKS_PER_FRAME } = await import("@/engine/keyframes");

const GEOMETRY = new Set(["points", "spline", "points3d"]);
const FRAMES = [0, 30];

function glShim(): WebGL2RenderingContext {
  const dummy = () => ({});
  return new Proxy({} as any, {
    get(_t, prop) {
      if (typeof prop !== "string") return undefined;
      if (/^[A-Z0-9_]+$/.test(prop)) return 0; // enum constants
      if (prop === "drawingBufferWidth" || prop === "drawingBufferHeight") return 1;
      if (prop === "isContextLost") return () => false;
      if (prop.startsWith("create") || prop === "getExtension" || prop.startsWith("get")) return dummy;
      return () => undefined;
    },
  });
}

function shim(ctx: any): any {
  ctx.gl = glShim();
  const zeros = (img: any, w?: number, h?: number) => new Uint8ClampedArray(Math.max(1, (w ?? img?.width ?? 1) * (h ?? img?.height ?? 1) * 4));
  ctx.readImagePixels = zeros;
  ctx.readImageRegion = (_img: any, _x: number, _y: number, w: number, h: number) => new Uint8ClampedArray(Math.max(1, w * h * 4));
  ctx.getWebGPUDevice = async () => null;
  ctx.getShader ??= () => ({});
  ctx.tryShader ??= () => ({});
  return ctx;
}

// Same media drop as census.mts: the planner and these nodes never read it.
function dropMedia(graph: any): any {
  const isMedia = (v: any) =>
    (typeof v === "string" && v.startsWith("data:")) ||
    (v &&
      typeof v === "object" &&
      !Array.isArray(v) &&
      ("dataUrl" in v || "cloud" in v || ("asset" in v && "kind" in v) || /_file$/.test(String(v.kind ?? ""))));
  for (const n of graph.nodes ?? []) for (const [k, v] of Object.entries(n.params ?? {})) if (isMedia(v)) delete n.params[k];
  for (const c of graph.compositions ?? []) delete c.thumbnail;
  delete graph.assetLibrary;
  return graph;
}

const sizeOf = (v: any): number => {
  if (!v) return 0;
  if (v.kind === "points") return v.count ?? v.points?.length ?? 0;
  if (v.kind === "spline") return (v.subpaths ?? []).reduce((s: number, p: any) => s + (p.anchors?.length ?? 0), 0);
  return 0;
};

interface Stat {
  type: string;
  nodes: number;
  ok: number;
  empty: number;
  readsImage: number;
  errors: Map<string, number>;
  ms: number[];
  projects: Set<string>;
}
const stats = new Map<string, Stat>();
const loadErrors: string[] = [];
// Whole-composition eval time per project, warm (the last frame evaluated).
const evalMs: { name: string; ms: number; geometry: number }[] = [];
const LOAD_TIMEOUT_MS = 20_000;

for (const f of readdirSync(join(corpus, "projects")).filter((x) => x.endsWith(".json"))) {
  const { meta, graph } = JSON.parse(readFileSync(join(corpus, "projects", f), "utf8"));
  let timer: ReturnType<typeof setTimeout> | undefined;
  let g: any;
  try {
    g = await Promise.race([
      deserializeGraph(dropMedia(graph), undefined, { deferRemoteMedia: true }),
      new Promise<never>((_, rej) => (timer = setTimeout(() => rej(new Error("load timed out")), LOAD_TIMEOUT_MS))),
    ]);
  } catch (e) {
    loadErrors.push(`${meta.name}: ${(e as Error).message}`);
    continue;
  } finally {
    clearTimeout(timer);
  }
  const comp = g.compositions.find((c: any) => c.id === g.activeCompositionId);
  const sc = comp?.scene ?? {};
  const flat = flattenAeComposition(g.nodes, g.edges, g.activeCompositionId);
  // The editor hands evaluateGraph its own nodes; it flattens internally.
  const nodes = flat.comp.nodes.map((n: any) => ({
    id: n.id,
    type: n.data.defType,
    parentId: n.data.parentId,
    params: n.data.params,
    exposedParams: n.data.exposedParams,
    animation: n.data.animation,
    clips: n.data.clips,
    bypassed: !!n.data.bypassed,
  }));
  const edges = flat.comp.edges.map((e: any) => ({
    id: e.id,
    source: e.source,
    sourceHandle: e.sourceHandle ?? "out:primary",
    target: e.target,
    targetHandle: e.targetHandle ?? "in:image",
  }));
  // Polymorphic nodes (Copy to Points, Mirror, Transform) take their output
  // type from what's wired in.
  const outType = (n: any) => {
    const def = getNodeDef(n.type);
    try {
      return def?.resolvePrimaryOutput?.(n.params ?? {}, { connectedTypes: flat.connectedTypes(n.id) }) ?? def?.primaryOutput;
    } catch {
      return def?.primaryOutput;
    }
  };
  const geo = flat.allNodes.filter((n) => !n.bypassed && GEOMETRY.has(String(outType(n))));
  if (!geo.length) continue;
  const ctx = shim(dataOnlyContext({ width: sc.width ?? 1920, height: sc.height ?? 1080 }, { fps: sc.fps ?? 60, ticksPerFrame: DEFAULT_TICKS_PER_FRAME }));
  const cache = new Map();
  const results = new Map<string, { err?: string; size: number; ms: number }>();
  for (const frame of FRAMES) {
    ctx.frame = frame;
    ctx.tick = frame * DEFAULT_TICKS_PER_FRAME;
    ctx.time = frame / (sc.fps ?? 60);
    const t0 = performance.now();
    let r: any;
    try {
      r = evaluateGraph(nodes as any, edges as any, ctx, cache as any, null, undefined, null, {
        extraTargets: geo.map((n) => n.id),
        extraConsumed: new Map(geo.map((n) => [n.id, ["primary"]])),
      });
    } catch (e) {
      for (const n of geo) results.set(n.id, { err: `evaluator threw: ${(e as Error).message}`, size: 0, ms: 0 });
      break;
    }
    const ms = performance.now() - t0;
    if (frame === FRAMES[FRAMES.length - 1]) evalMs.push({ name: meta.name, ms, geometry: geo.length });
    for (const n of geo) {
      const err = r.errors?.[n.id];
      const prev = results.get(n.id);
      const size = sizeOf(r.outputs.get(n.id)?.primary);
      results.set(n.id, { err: err ?? prev?.err, size: Math.max(size, prev?.size ?? 0), ms: Math.max(ms, prev?.ms ?? 0) });
    }
  }
  for (const n of geo) {
    const res = results.get(n.id)!;
    const st =
      stats.get(n.type) ??
      stats.set(n.type, { type: n.type, nodes: 0, ok: 0, empty: 0, readsImage: 0, errors: new Map(), ms: [], projects: new Set() }).get(n.type)!;
    st.nodes++;
    st.projects.add(meta.name);
    const imageIn = Object.values(flat.connectedTypes(n.id)).some((t) => t === "image" || t === "mask");
    if (imageIn) st.readsImage++;
    if (res.err) {
      const k = res.err.slice(0, 90);
      st.errors.set(k, (st.errors.get(k) ?? 0) + 1);
    } else if (res.size === 0) st.empty++;
    else st.ok++;
    st.ms.push(res.ms);
  }
}

const rows = [...stats.values()].sort((a, b) => b.nodes - a.nodes);
const total = rows.reduce((s, r) => s + r.nodes, 0);
const ok = rows.reduce((s, r) => s + r.ok, 0);
const empty = rows.reduce((s, r) => s + r.empty, 0);
const failed = rows.reduce((s, r) => s + [...r.errors.values()].reduce((a, b) => a + b, 0), 0);
const sortedMs = [...evalMs].sort((a, b) => a.ms - b.ms);
const pctl = (q: number) => (sortedMs.length ? sortedMs[Math.min(sortedMs.length - 1, Math.floor(q * (sortedMs.length - 1)))].ms.toFixed(1) : "–");
const slowest = [...sortedMs]
  .reverse()
  .slice(0, 5)
  .map((e) => `${e.name} ${e.ms.toFixed(0)} ms (${e.geometry} geometry nodes)`)
  .join(", ");
const md = [
  "# Geometry portability",
  "",
  `Generated ${new Date().toISOString()} by scripts/ae-rig/portability.mts. Points / spline nodes in each project's active composition, evaluated by the real evaluator with no GL at frames ${FRAMES.join(" and ")}.`,
  "",
  `${total} nodes of ${rows.length} types: ${ok} computed geometry, ${empty} computed nothing (often an unwired or image-fed input), ${failed} threw.`,
  "",
  `Whole-composition eval at frame ${FRAMES[FRAMES.length - 1]} (warm cache, Node / V8, GL stubbed so image nodes cost ~nothing): ${pctl(0.5)} ms median, ${pctl(0.95)} ms p95, ${pctl(1)} ms max over ${evalMs.length} projects. Slowest: ${slowest}.`,
  "",
  "| type | nodes | ok | empty | threw | reads image | projects | first error |",
  "|---|---|---|---|---|---|---|---|",
  ...rows.map((r) => {
    const threw = [...r.errors.values()].reduce((a, b) => a + b, 0);
    const first = [...r.errors.keys()][0] ?? "";
    return `| ${r.type} | ${r.nodes} | ${r.ok} | ${r.empty} | ${threw} | ${r.readsImage} | ${r.projects.size} | ${first.replace(/\|/g, "/")} |`;
  }),
  ...(loadErrors.length ? ["", "## Load errors", "", ...loadErrors.map((e) => `- ${e}`)] : []),
];
writeFileSync(join(corpus, "portability.md"), md.join("\n") + "\n");
writeFileSync(
  join(corpus, "portability.json"),
  JSON.stringify(rows.map((r) => ({ ...r, errors: Object.fromEntries(r.errors), projects: r.projects.size })), null, 1)
);
console.log(`portability: ${total} geometry nodes, ${rows.length} types · ok ${ok} · empty ${empty} · threw ${failed}${loadErrors.length ? ` · ${loadErrors.length} load errors` : ""}`);
console.log(`  wrote ${join(corpus, "portability.md")}`);
