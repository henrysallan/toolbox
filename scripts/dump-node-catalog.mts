// Prototype runner for the AI-recipe node catalog (spec milestone 1).
// Enumerates the registered NodeDefinitions, builds the catalog, and reports
// how heavy it is across several serializations / token estimates.
//
//   npx tsx scripts/dump-node-catalog.mts
//
// The node tree is browser-oriented, so we shim the browser globals a handful
// of modules touch at import time, then dynamic-import the tree (static
// imports would hoist above the shims).

/* eslint-disable @typescript-eslint/no-explicit-any */
const g = globalThis as any;

const stubCanvas = () => ({
  width: 0,
  height: 0,
  style: {},
  getContext: () => null,
  toDataURL: () => "",
  addEventListener() {},
  remove() {},
});

g.window ??= g;
g.self ??= g;
g.document ??= {
  createElement: () => stubCanvas(),
  createElementNS: () => stubCanvas(),
  fonts: { add() {}, delete() {}, forEach() {}, [Symbol.iterator]: function* () {} },
  body: { appendChild() {}, removeChild() {} },
  head: { appendChild() {} },
  addEventListener() {},
};
g.navigator ??= { userAgent: "node", gpu: undefined, mediaDevices: undefined };
g.location ??= { href: "http://localhost/", origin: "http://localhost" };
g.HTMLCanvasElement ??= class {};
g.HTMLImageElement ??= class {};
g.HTMLVideoElement ??= class {};
g.HTMLMediaElement ??= class {};
g.Image ??= class {};
g.Audio ??= class {};
g.Path2D ??= class {};
g.OffscreenCanvas ??= class {
  getContext() {
    return null;
  }
};
g.WebGL2RenderingContext ??= class {};
g.WebGLRenderingContext ??= class {};
g.AudioContext ??= class {};
g.requestAnimationFrame ??= () => 0;
g.cancelAnimationFrame ??= () => {};
g.matchMedia ??= () => ({ matches: false, addEventListener() {} });

// Register every built-in, then read the registry.
const { registerAllNodes } = await import("@/nodes/index");
registerAllNodes();
const { allNodeDefs } = await import("@/engine/registry");
const { buildNodeCatalog } = await import("@/engine/node-catalog");
const { writeFileSync } = await import("node:fs");

const defs = allNodeDefs();
const visible = defs.filter((d) => !d.hidden);

// Rough token estimate. Dense JSON runs ~3.7 chars/token; we report a range.
const est = (s: string) => ({
  chars: s.length,
  tokLo: Math.round(s.length / 4),
  tokHi: Math.round(s.length / 3.3),
});

const variants: Record<string, string> = {
  "full (pretty JSON)": JSON.stringify(buildNodeCatalog(defs), null, 2),
  "full (minified JSON)": JSON.stringify(buildNodeCatalog(defs)),
  "no descriptions (min)": JSON.stringify(
    buildNodeCatalog(defs, { omitDescriptions: true })
  ),
  "sockets only, no params (min)": JSON.stringify(
    buildNodeCatalog(defs, { omitParams: true, omitDescriptions: true })
  ),
  "compact DSL": compactDsl(),
};

console.log(`\nRegistered defs: ${defs.length}  (visible after hidden filter: ${visible.length})`);
console.log(
  `Total params across visible nodes: ${visible.reduce((n, d) => n + d.params.length, 0)}`
);

console.log("\n" + "format".padEnd(32) + "chars".padStart(10) + "  ~tokens (lo–hi)");
console.log("-".repeat(64));
for (const [name, str] of Object.entries(variants)) {
  const e = est(str);
  console.log(
    name.padEnd(32) +
      String(e.chars).padStart(10) +
      `  ${e.tokLo.toLocaleString()}–${e.tokHi.toLocaleString()}`
  );
}

// Dump the canonical full catalog for inspection.
const outPath = "specdocs/node-catalog.sample.json";
writeFileSync(outPath, JSON.stringify(buildNodeCatalog(defs), null, 2));
writeFileSync("specdocs/node-catalog.dsl.txt", variants["compact DSL"]);
console.log(`\nWrote full catalog → ${outPath}  + DSL → specdocs/node-catalog.dsl.txt`);

// A terse line-per-node DSL — denser than JSON, candidate prompt format.
function compactDsl(): string {
  const cat = buildNodeCatalog(defs, { omitDescriptions: true });
  return cat
    .map((n) => {
      const ins = n.inputs.map((i) => `${i.name}:${i.type}${i.required ? "!" : ""}`).join(",");
      const aux = n.aux.length ? ` aux=${n.aux.map((a) => `${a.name}:${a.type}`).join(",")}` : "";
      const ps = n.params
        .filter((p) => p.settable)
        .map((p) => {
          let s = `${p.name}:${p.type}`;
          if (p.default !== undefined) s += `=${JSON.stringify(p.default)}`;
          if (p.options) s += `[${p.options.join("|")}]`;
          else if (p.min !== undefined || p.max !== undefined) s += `(${p.min ?? ""}..${p.max ?? ""})`;
          return s;
        })
        .join(" ");
      const dyn = n.dynamic ? " ~dyn" : "";
      return `${n.type} (${n.name}) [${n.category}${n.subcategory ? "/" + n.subcategory : ""}]${dyn}: in ${ins} -> ${n.primaryOutput ?? "none"}${aux}${ps ? ` | ${ps}` : ""}`;
    })
    .join("\n");
}
