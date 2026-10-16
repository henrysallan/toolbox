// check-aspect-rigid: the wiring and compat of aspect-rigid image rotation
// (specdocs/101526_aspect-rigid-rotation.md). The math itself is gated in
// check-layer-transform-math (shader inverse ≡ composeOpsToCanvasAffine,
// Text rigid, legacy bit-identical, gizmo frame box) and the Skia mirrors in
// check-skia-warp / check-skia-assets. This gate covers:
//   1. every LEGACY_SKEW_TYPES type is registered and declares `legacySkew`
//      (hidden unless on), and the Skia mirrors share the original's def;
//   2. the v13 migration pins ≤v12 nodes of those types to legacySkew and
//      leaves v13 saves and other types alone; a re-save keeps the flag;
//   3. Transform's compute binds the uniforms the math gate holds: own TRS
//      through imageTrsUniforms (u_aspect = W / H, translate / pivot Y
//      converted), a wired transform through composeOpsToCanvasAffine, and
//      legacySkew through the raw params / composeOpsToAffine with
//      u_aspect = 1 — on a stub GL that records uniforms.
//
//   npx tsx scripts/check-aspect-rigid.mts
/* eslint-disable @typescript-eslint/no-explicit-any */
import type { SavedProject } from "@/lib/project";

const g = globalThis as any;
const stub = () => ({ getContext: () => null, style: {}, addEventListener() {} });
g.window ??= g;
g.self ??= g;
g.document ??= {
  createElement: stub,
  createElementNS: stub,
  fonts: { add() {}, forEach() {} },
  body: { appendChild() {} },
  addEventListener() {},
};
g.navigator ??= { userAgent: "node" };
g.HTMLCanvasElement ??= class {};
g.OffscreenCanvas ??= class { getContext() { return null; } };
g.WebGL2RenderingContext ??= class {};

const { registerAllNodes } = await import("@/nodes/index");
registerAllNodes();
const { getNodeDef } = await import("@/engine/registry");
const { deserializeGraph, serializeGraph, CURRENT_SCHEMA, LEGACY_SKEW_TYPES } = await import("@/lib/project");
const { aspectCorrectY } = await import("@/engine/aspect");
const tv = await import("@/engine/transform-value");

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  console.log(`${cond ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures++;
}

// ---- 1. the param on every type ------------------------------------------------------
{
  const missing: string[] = [];
  for (const t of LEGACY_SKEW_TYPES) {
    const p = getNodeDef(t)?.params.find((q) => q.name === "legacySkew");
    if (!p || p.type !== "boolean" || p.default !== false) missing.push(t);
    else if (p.visibleIf?.({ legacySkew: false }) !== false || p.visibleIf?.({ legacySkew: true }) === false) missing.push(`${t} (visibility)`);
  }
  check(`every LEGACY_SKEW_TYPES type declares legacySkew: boolean, default false, shown only when on (${LEGACY_SKEW_TYPES.size} types)`, missing.length === 0, missing.join(", "));
  const def = (t: string) => getNodeDef(t)!.params.find((q) => q.name === "legacySkew");
  check(
    "the Skia mirrors share their original's legacySkew ParamDef",
    def("skia-transform") === def("transform") && def("skia-image") === def("image-source")
  );
}

// ---- 2. the v13 migration --------------------------------------------------------------
const nodesOf = (types: string[]) =>
  types.map((t, i) => ({ id: `n${i}`, defType: t, position: { x: i * 200, y: 0 }, params: {} }));
const TYPES = [...LEGACY_SKEW_TYPES];
{
  const old = { schemaVersion: 12, nodes: nodesOf([...TYPES, "circle", "gizmo"]), edges: [] } as unknown as SavedProject;
  const res = await deserializeGraph(old);
  const flagged = res.nodes.filter((n) => n.data.params.legacySkew === true).map((n) => n.data.defType);
  check(
    "v12 save: every LEGACY_SKEW_TYPES node loads with legacySkew, other types untouched",
    flagged.length === TYPES.length && TYPES.every((t) => flagged.includes(t)),
    `flagged [${flagged.join(", ")}]`
  );
  const resaved = await serializeGraph(res.nodes, res.edges);
  const again = await deserializeGraph(resaved);
  check(
    `re-saved at v${CURRENT_SCHEMA}: the flag survives the round trip`,
    resaved.schemaVersion === CURRENT_SCHEMA && again.nodes.filter((n) => n.data.params.legacySkew === true).length === TYPES.length
  );
  const fresh = await deserializeGraph({ schemaVersion: CURRENT_SCHEMA, nodes: nodesOf(TYPES), edges: [] } as unknown as SavedProject);
  check(
    `v${CURRENT_SCHEMA} save: nothing gets legacySkew (new nodes are rigid)`,
    fresh.nodes.every((n) => n.data.params.legacySkew !== true)
  );
}

// ---- 3. Transform's compute on a stub GL ---------------------------------------------
const W = 1920;
const H = 1080;
const A = W / H;
function run(params: Record<string, unknown>, transform?: unknown) {
  const uniforms: Record<string, number[]> = {};
  let shader = "";
  const gl: any = {
    TEXTURE0: 0,
    TEXTURE_2D: 0,
    activeTexture() {},
    bindTexture() {},
    getUniformLocation: (_p: unknown, name: string) => name,
    uniform1i: (n: string, ...v: number[]) => (uniforms[n] = v),
    uniform1f: (n: string, ...v: number[]) => (uniforms[n] = v),
    uniform2f: (n: string, ...v: number[]) => (uniforms[n] = v),
    uniform4f: (n: string, ...v: number[]) => (uniforms[n] = v),
  };
  const ctx: any = {
    gl,
    width: W,
    height: H,
    state: {},
    allocImage: () => ({ kind: "image", texture: {}, width: W, height: H }),
    clearTarget() {},
    getShader: (key: string) => ((shader = key), {}),
    drawFullscreen: (_p: unknown, _o: unknown, fn: (gl: any) => void) => fn(gl),
  };
  const def = getNodeDef("transform")!;
  const defaults = Object.fromEntries(def.params.map((p) => [p.name, p.default]));
  def.compute({
    inputs: { image: { kind: "image", texture: {}, width: W, height: H } as any, ...(transform ? { transform: transform as any } : {}) },
    auxIn: {},
    params: { ...defaults, ...params },
    ctx,
    nodeId: "t",
  } as any);
  return { uniforms, shader };
}
const close = (a: number, b: number) => Math.abs(a - b) < 1e-6;
const TRS = { translateX: 0.1, translateY: -0.12, scaleX: 0.8, scaleY: 1.3, rotate: 33, pivotX: 0.3, pivotY: 0.7 };
{
  const { uniforms: u, shader } = run(TRS);
  check(
    "Transform own TRS: u_aspect = W / H, translate Y × a, pivot Y aspect-corrected, X untouched",
    shader === "transform/tile" &&
      close(u.u_aspect[0], A) &&
      close(u.u_translate[0], 0.1) &&
      close(u.u_translate[1], -0.12 * A) &&
      close(u.u_pivot[0], 0.3) &&
      close(u.u_pivot[1], aspectCorrectY(0.7, A)) &&
      close(u.u_angle[0], (33 * Math.PI) / 180),
    JSON.stringify(u)
  );
  const { uniforms: l } = run({ ...TRS, legacySkew: true });
  check(
    "Transform own TRS, legacySkew: raw params, u_aspect = 1",
    l.u_aspect[0] === 1 && l.u_translate[1] === -0.12 && l.u_pivot[1] === 0.7,
    JSON.stringify(l)
  );
}
{
  const ops = [tv.opFromParams(TRS), tv.opFromParams({ rotate: -20, translateX: 0.05 })];
  const wired = { kind: "transform", ops };
  const sameAs = (u: Record<string, number[]>, m: ReturnType<typeof tv.composeOpsToAffine>) => {
    const inv = tv.invertAffine(m)!;
    return [inv.a, inv.b, inv.c, inv.d].every((v, i) => close(u.u_invA[i], v)) && close(u.u_invT[0], inv.tx) && close(u.u_invT[1], inv.ty);
  };
  const { uniforms: u, shader } = run({}, wired);
  check(
    "Transform wired: the inverse of composeOpsToCanvasAffine(ops, W / H)",
    shader === "transform/matrix" && sameAs(u, tv.composeOpsToCanvasAffine(ops, A))
  );
  const { uniforms: l } = run({ legacySkew: true }, wired);
  check("Transform wired, legacySkew: the inverse of composeOpsToAffine(ops)", sameAs(l, tv.composeOpsToAffine(ops)));
}

if (failures > 0) {
  console.error(`\ncheck-aspect-rigid: ${failures} failure(s)`);
  process.exit(1);
}
console.log("\ncheck-aspect-rigid: all passed");
