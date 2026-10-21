// Single-node shader regions (src/lib/ae-export/shader/node-shaders.ts): a
// lone node runs in the Toolbox Shader host as its own fragment shader, its
// params the effect's controls — no fused GLSL Expression.
//
//   coverage   the AE class table flags exactly the NODE_SHADERS types
//              `ownShader`; every uniform the node's source declares has a
//              rule and every rule a uniform; every param is a control, a
//              bake or ignored; controls are scalar / boolean / color params
//   compute()  the node's real compute() on a recording GL (any platform):
//              it compiles spec.fs and binds every declared uniform; moving
//              a control changes what it binds, moving an ignored param
//              doesn't
//   bundles    every case builds and validateAeShader accepts it (pure,
//              plus the host's tbxshader-check — else Metal — on macOS)
//   parity     macOS + Electron: toolbox's render — the node's own source
//              with the uniforms compute() bound, WebGL2 (ANGLE) — against
//              the bundle's MSL on Metal with the bundle's control values and
//              the host clock, 581 uvs per case. Fast math is what the host
//              compiles (ae-host.md); IEEE is printed for reference. The
//              rewritten GLSL in WebGL2 with the controls isolates the rules
//              (must match compute() to float noise) from the translation.
//   scene      the v-noise fixtures: kernel "node" regions, one TBX Shader
//              effect each, Bundle ID first, controls by match name, the
//              keyed contrast as keys, mask + opacity outside the shader
//
//   npx tsx scripts/check-ae-export.mts shader-nodes

/* eslint-disable @typescript-eslint/no-explicit-any */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadRegistry, makeChecker } from "./harness.mts";
import { diff, f16, image, runGl, sampleUvs, type GlCase, type Rgba } from "./parity-gl.mts";
import type { NodeDefinition } from "@/engine/types";
import type { AeShaderBundle } from "@/lib/ae-export/types";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const W = 1280;
const H = 720;
const FPS = 30;

interface Recorded {
  fs: string | null;
  uniforms: Map<string, { kind: GlCase["uniforms"][number]["kind"]; v: number[] }>;
  draws: number;
}

// compute() against a GL that records what it compiles and binds. Image
// inputs arrive as opaque textures (the gate supplies their pixels itself).
function recordCompute(def: NodeDefinition, params: Record<string, unknown>, frame: number, inputs: Record<string, unknown> = {}): Recorded {
  const rec: Recorded = { fs: null, uniforms: new Map(), draws: 0 };
  const programs = new Map<object, string>();
  let binding: Recorded["uniforms"] | null = null;
  const gl: any = new Proxy(
    {},
    {
      get(_t, k) {
        if (k === "getUniformLocation") return (_p: unknown, name: string) => name;
        if (typeof k === "string" && /^uniform[1-4][fi]$/.test(k))
          return (loc: string, ...v: number[]) => binding?.set(loc, { kind: k.slice(7) as Recorded["uniforms"] extends Map<string, infer U> ? U extends { kind: infer K } ? K : never : never, v });
        if (k === "getExtension") return () => null;
        if (typeof k === "string" && /^[A-Z0-9_]+$/.test(k)) return 0;
        return () => ({});
      },
    }
  );
  const ctx: any = {
    gl,
    width: W,
    height: H,
    tick: frame * 1000,
    ticksPerFrame: 1000,
    fps: FPS,
    time: frame / FPS,
    frame,
    playing: false,
    offline: true,
    state: {},
    allocImage: () => ({ kind: "image", texture: {}, width: W, height: H }),
    getShader: (_key: string, fs: string) => {
      const p = {};
      programs.set(p, fs);
      return p;
    },
    drawFullscreen: (prog: object, _out: unknown, setup?: (g: any) => void) => {
      binding = new Map();
      setup?.(gl);
      rec.fs = programs.get(prog) ?? null;
      rec.uniforms = binding;
      binding = null;
      rec.draws++;
    },
  };
  def.compute!({ inputs: inputs as any, params, ctx, nodeId: "n", consumedOutputs: new Set(["primary"]) } as any);
  return rec;
}

interface NodeCase {
  name: string;
  type: string;
  params: Record<string, unknown>;
  frame?: number;
  // A wired image input → its pixels.
  images?: Record<string, (u: number, v: number) => Rgba>;
  // Max |Δ| per component, toolbox (WebGL2) vs the host (Metal fast math).
  tol: number;
  why?: string;
}

const warp = (u: number, v: number): Rgba => [0.5 + 0.35 * Math.sin(u * 5.3 + v * 1.7), 0.5 + 0.35 * Math.cos(v * 4.1 - u * 2.2), 0, 1];

const CASES: NodeCase[] = [
  { name: "simplex, defaults", type: "noise", params: {}, tol: 1e-5 },
  {
    name: "simplex, looping evolution (frame 17 of 0–90, rate 1.3)",
    type: "noise",
    params: { animated: true, anim_end: 90, anim_rate: 1.3, scale: 3, octaves: 5, color_a: "#102040", color_b: "#ffcc66" },
    frame: 17,
    tol: 1e-5,
  },
  { name: "simplex, looping evolution (frame 89, the wrap)", type: "noise", params: { animated: true, anim_end: 90, anim_rate: 1.3, scale: 3, octaves: 5 }, frame: 89, tol: 1e-5 },
  { name: "perlin, W slice blend + seed + offsets", type: "noise", params: { type: "perlin", w: 2.37, seed: 1, offset_x: 0.7, offset_y: -1.3 }, tol: 1e-5 },
  { name: "value, contrast + rounded octaves + persistence / lacunarity + alpha", type: "noise", params: { type: "value", contrast: 2.5, octaves: 2.6, persistence: 0.7, lacunarity: 2.3, alpha: 0.6 }, tol: 1e-5 },
  { name: "opensimplex", type: "noise", params: { type: "opensimplex", scale: 6 }, tol: 1e-5 },
  { name: "opensimplex2", type: "noise", params: { type: "opensimplex2", scale: 6 }, tol: 1e-5 },
  { name: "opensimplex2s", type: "noise", params: { type: "opensimplex2s", scale: 6 }, tol: 1e-5 },
  { name: "super-simplex", type: "noise", params: { type: "super-simplex", scale: 6 }, tol: 1e-5 },
  { name: "perlin-deriv", type: "noise", params: { type: "perlin-deriv", scale: 5, octaves: 3 }, tol: 1e-5 },
  { name: "flow, animated (flow_time sweeps 2π over 0–48, frame 31)", type: "noise", params: { type: "flow", animated: true, anim_end: 48 }, frame: 31, tol: 1e-5 },
  { name: "flow, static flow_time", type: "noise", params: { type: "flow", flow_time: 3.3 }, tol: 1e-5 },
  { name: "curl (RG vector), W 0.5, alpha", type: "noise", params: { type: "curl", contrast: 1.5, alpha: 0.8, w: 0.5 }, tol: 1e-5 },
  { name: "phasor (degrees → radians in the shader)", type: "noise", params: { type: "phasor", phasor_frequency: 3.5, phasor_orientation: 30, phasor_isotropy: 0.6 }, tol: 1e-5 },
  { name: "animated, degenerate window (end < start)", type: "noise", params: { animated: true, anim_start: 50, anim_end: 20 }, frame: 7, tol: 1e-5 },
  { name: "animated, rate 0", type: "noise", params: { animated: true, anim_rate: 0, w: 3 }, frame: 7, tol: 1e-5 },
  {
    name: "UV input wired (domain warp) → image slot a",
    type: "noise",
    params: { scale: 4 },
    images: { uv_in: warp },
    tol: 1e-4,
    why: "msl-compile's probe samples with hardware bilinear like WebGL; the host's own float bilinear (sub-texel weights) is not measured here",
  },
];

export default async function run(): Promise<number> {
  const c = makeChecker("shader-nodes");
  await loadRegistry();
  const { NODE_SHADERS } = await import("@/lib/ae-export/shader/node-shaders");
  const { bundleFromNodeShader, nodeShaderParams } = await import("@/lib/ae-export/shader/node-bundle");
  const { listGlslUniforms } = await import("@/lib/ae-export/shader/translate");
  const { validateAeShader } = await import("@/lib/ae-export/shader/validate");
  const { AE_EXPORT_CLASSES } = await import("@/lib/ae-export/classes");

  // --- coverage ------------------------------------------------------------------
  const flagged = Object.entries(AE_EXPORT_CLASSES)
    .filter(([, e]) => e.ownShader)
    .map(([t]) => t)
    .sort();
  c.check(
    `AE class table flags ownShader on exactly the NODE_SHADERS types (${Object.keys(NODE_SHADERS).join(", ")})`,
    flagged.join() === Object.keys(NODE_SHADERS).sort().join(),
    { flagged }
  );
  for (const [type, spec] of Object.entries(NODE_SHADERS)) {
    c.check(`${type}: AE class is shader`, AE_EXPORT_CLASSES[type]?.class === "shader");
    const env = { params: nodeShaderParams(spec, {}), inputs: {} };
    const declared = listGlslUniforms(spec.fs(env));
    if (!declared.ok) {
      c.check(`${type}: its source parses`, false, declared.errors);
      continue;
    }
    const names = declared.uniforms.map((u) => u.name);
    const rules = Object.keys(spec.uniforms);
    c.check(`${type}: every uniform its source declares has a rule (${names.length})`, names.every((n) => rules.includes(n)), names.filter((n) => !rules.includes(n)));
    c.check(`${type}: every rule names a declared uniform`, rules.every((n) => names.includes(n)), rules.filter((n) => !names.includes(n)));
    const controls = spec.controls.map((x) => (typeof x === "string" ? x : x.param));
    const defs = new Map(spec.node.params.map((d) => [d.name, d]));
    const bad = controls.filter((p) => !["scalar", "boolean", "color"].includes(defs.get(p)?.type ?? ""));
    c.check(`${type}: controls are scalar / boolean / color params`, bad.length === 0, bad);
    const classified = new Set([...controls, ...(spec.bakes ?? []), ...(spec.ignores ?? [])]);
    const loose = spec.node.params.map((d) => d.name).filter((p) => !classified.has(p));
    c.check(`${type}: every param is a control, a bake or ignored`, loose.length === 0, { unclassified: loose });
  }

  // --- compute() on a recording GL ---------------------------------------------------
  for (const [type, spec] of Object.entries(NODE_SHADERS)) {
    const base = nodeShaderParams(spec, {});
    const env = { params: base, inputs: {} };
    const r = recordCompute(spec.node, base, 0);
    c.check(`${type}: compute() draws once, with spec.fs`, r.draws === 1 && r.fs === spec.fs(env), { draws: r.draws });
    const declared = listGlslUniforms(spec.fs(env));
    const names = declared.ok ? declared.uniforms.map((u) => u.name) : [];
    const unbound = names.filter((n) => !r.uniforms.has(n));
    c.check(`${type}: compute() binds every declared uniform`, unbound.length === 0, unbound);
    // Move each control / ignored param and watch the bindings.
    const sig = (p: Record<string, unknown>, frame = 5) => JSON.stringify([...recordCompute(spec.node, p, frame).uniforms]);
    const moved = (p: string): Record<string, unknown> => {
      const d = spec.node.params.find((x) => x.name === p)!;
      const v = base[p];
      if (d.type === "boolean") return { ...base, [p]: !v, ...(p === "animated" ? {} : {}) };
      if (d.type === "color") return { ...base, [p]: v === "#336699" ? "#996633" : "#336699" };
      return { ...base, [p]: (typeof v === "number" ? v : 0) + (d.name === "octaves" ? 2 : 0.37) };
    };
    const at = sig(base);
    const typed = (p: string): Record<string, unknown> => {
      // Branch-only controls read under the type that uses them.
      const ctl = spec.controls.find((x) => typeof x !== "string" && x.param === p);
      if (!ctl || typeof ctl === "string" || !ctl.when) return base;
      for (const t of (spec.node.params.find((d) => d.name === "type")?.options ?? []) as string[]) if (ctl.when({ params: { ...base, type: t }, inputs: {} })) return { ...base, type: t };
      return base;
    };
    // anim_* only feed the shader while animated; w only while not.
    const withAnim = (p: string) => (/^anim_/.test(p) ? { animated: true } : {});
    const dead: string[] = [];
    for (const x of spec.controls) {
      const p = typeof x === "string" ? x : x.param;
      const b0 = { ...typed(p), ...withAnim(p) };
      const m = { ...moved(p), ...typed(p), ...withAnim(p), [p]: moved(p)[p] };
      if (sig(b0) === sig(m)) dead.push(p);
    }
    c.check(`${type}: every control changes what compute() binds`, dead.length === 0, dead);
    const live = (spec.ignores ?? []).filter((p) => sig(moved(p)) !== at);
    c.check(`${type}: no ignored param changes what compute() binds (${(spec.ignores ?? []).join(", ")})`, live.length === 0, live);
  }

  // --- bundles ---------------------------------------------------------------------------
  const native = process.platform === "darwin" ? await import("@/lib/ae-export/shader/native") : null;
  const compiler = native?.nativeShaderCompiler({ repoRoot: ROOT });
  const built = CASES.map((k) => {
    const inputs = Object.fromEntries(Object.keys(k.images ?? {}).map((s) => [s, "image" as const]));
    const res = bundleFromNodeShader(k.type, k.params, inputs, { name: k.name, fps: FPS, canvas: { width: W, height: H } });
    return { k, res };
  });
  for (const { k, res } of built) {
    if (!res.ok) {
      c.check(`${k.name}: bundle builds`, false, "refused" in res ? res.refused : res.errors.slice(0, 3));
      continue;
    }
    const v = validateAeShader(res.bundle, { compiler: compiler?.ok ? compiler.compiler : null });
    const how = "skipped" in v.compile ? `structural (${v.compile.skipped})` : v.compile.validator;
    c.check(`${k.name}: validateAeShader accepts the bundle (${how}; ${res.controls.length} controls)`, v.ok, v.errors.slice(0, 3));
  }

  // --- parity -----------------------------------------------------------------------------
  if (process.platform !== "darwin") console.log(`  note parity needs Metal (macOS); skipped on ${process.platform}`);
  else {
    const mc = native!.buildMslCompile({ repoRoot: ROOT });
    if (!mc.ok) {
      if ("skipped" in mc) console.log(`  note parity skipped: ${mc.skipped}`);
      else c.check("msl-compile builds", false, mc.error);
    } else {
      const uvs = sampleUvs();
      const ready = built.filter((b) => b.res.ok) as { k: NodeCase; res: Extract<(typeof built)[number]["res"], { ok: true }> }[];
      const glCases: GlCase[] = [];
      const probes: { k: NodeCase; bundle: AeShaderBundle; job: Parameters<NonNullable<typeof native>["probeShade"]>[2] }[] = [];
      for (const { k, res } of ready) {
        const spec = NODE_SHADERS[k.type];
        const frame = k.frame ?? 0;
        const tex = Object.fromEntries(Object.entries(k.images ?? {}).map(([s, fn]) => [s, image(fn)]));
        const rec = recordCompute(spec.node, nodeShaderParams(spec, k.params), frame, Object.fromEntries(Object.keys(tex).map((s) => [s, { kind: "uv", texture: { socket: s } }])));
        // The node's own source with compute()'s bindings: toolbox's render.
        const samplers = Object.fromEntries(Object.entries(spec.uniforms).filter(([, r]) => typeof r === "object").map(([u, r]) => [u, (r as { input: string }).input]));
        glCases.push({
          name: `${k.name} · node`,
          fs: rec.fs!,
          uvs,
          uniforms: [...rec.uniforms].filter(([n]) => !(n in samplers)).map(([name, u]) => ({ name, kind: u.kind, v: u.v })),
          textures: Object.fromEntries(Object.entries(samplers).flatMap(([u, s]) => (tex[s] ? [[u, tex[s]]] : []))),
          luts: [],
        });
        // The rewritten source with the bundle's controls: the rules alone.
        const b = res.bundle;
        glCases.push({
          name: `${k.name} · rules`,
          fs: res.glsl,
          uvs,
          uniforms: [
            { name: "u_res", kind: "2f", v: [W, H] },
            { name: "u_time", kind: "1f", v: [frame / FPS] },
            { name: "u_frame", kind: "1f", v: [frame] },
            { name: "u_aspect", kind: "1f", v: [W / H] },
            ...b.params.map((p) => ({ name: p.name, kind: (p.kind === "slider" ? "1f" : p.kind === "checkbox" ? "1i" : "4f") as GlCase["uniforms"][number]["kind"], v: p.kind === "slider" ? [p.default as number] : p.kind === "checkbox" ? [p.default ? 1 : 0] : (p.default as number[]) })),
          ],
          textures: Object.fromEntries(Object.entries(res.inputs).map(([s, slot]) => [`u_${slot}`, tex[s]])),
          luts: [],
        });
        const sliders = new Array(32).fill(0);
        const colors = Array.from({ length: 8 }, () => [0, 0, 0, 0]);
        const checkboxes = new Array(8).fill(0);
        for (const p of b.params) {
          if (p.kind === "slider") sliders[p.slot - 1] = p.default as number;
          else if (p.kind === "color") colors[p.slot - 1] = p.default as number[];
          else if (p.kind === "checkbox") checkboxes[p.slot - 1] = p.default ? 1 : 0;
        }
        const textures: (any | null)[] = new Array(12).fill(null);
        for (const [s, slot] of Object.entries(res.inputs)) textures["abcd".indexOf(slot)] = { ...tex[s], data: tex[s].data.map(f16), format: "rgba16f" };
        probes.push({ k, bundle: b, job: { uniforms: { res: [W, H], time: frame / FPS, frame, aspect: W / H, sliders, colors, checkboxes }, textures, uvs } });
      }
      const gl = runGl(glCases);
      if (gl.fatal || !gl.results) console.log(`  note parity skipped: WebGL2 reference unavailable (${gl.fatal})`);
      else {
        console.log(`  reference: WebGL2 · ${gl.renderer} — the node's own source, compute()'s uniforms`);
        console.log(`  candidate: Metal probe · ${mc.device} — the bundle's MSL, its control values (fast math, as the host compiles)`);
        for (const p of probes) {
          const node = gl.results.find((r) => r.name === `${p.k.name} · node`);
          const rules = gl.results.find((r) => r.name === `${p.k.name} · rules`);
          if (!node?.out || !rules?.out) {
            c.check(`${p.k.name}: WebGL2 renders both sources`, false, node?.error ?? rules?.error ?? "no result");
            continue;
          }
          const fast = native!.probeShade(mc.bin, p.bundle.source.msl!, { ...p.job, fastMath: true });
          const ieee = native!.probeShade(mc.bin, p.bundle.source.msl!, p.job);
          if (!fast.ok || !ieee.ok) {
            c.check(`${p.k.name}: Metal runs the bundle`, false, (!fast.ok ? fast.log : !ieee.ok ? ieee.log : "").slice(0, 1500));
            continue;
          }
          const dr = diff(node.out, rules.out, uvs);
          const df = diff(node.out, fast.out, uvs);
          const di = diff(node.out, ieee.out, uvs);
          c.check(
            `${p.k.name}: host max |Δ| ${df.max.toExponential(2)} (p99 ${df.p99.toExponential(1)}) ≤ ${p.k.tol.toExponential(0)} · rules ${dr.max.toExponential(2)} · IEEE ${di.max.toExponential(2)}${p.k.why ? ` — ${p.k.why}` : ""}`,
            df.max <= p.k.tol && df.nan === 0 && dr.max <= p.k.tol && dr.nan === 0,
            `host: ${df.nan} non-finite, worst ${df.where}; rules: ${dr.nan} non-finite, worst ${dr.where}`
          );
        }
      }
    }
  }

  // --- scene ------------------------------------------------------------------------------
  const { SCENE_FIXTURES, sceneOf } = await import("../fixtures/ae-export/graphs/fixtures.mts");
  const { tbxShaderParamMatch } = await import("@/lib/ae-export/types");
  const { aeConvertPrompt, aeRegionsToFuse } = await import("@/components/effects/ae-export-ui");
  for (const name of ["v-noise", "v-noise-masked"]) {
    const f = SCENE_FIXTURES.find((x) => x.name === name)!;
    const b = await sceneOf(f);
    const regions = b.plan.shaderRegions;
    c.check(`${name}: one shader region, kernel "node"`, regions.length === 1 && regions[0].kernel === "node", regions);
    c.check(`${name}: nothing to fuse, nothing baked, no problems`, aeRegionsToFuse(b.plan).length === 0 && b.bakes.length === 0 && b.problems.length === 0, { bakes: b.bakes.map((x) => x.id), problems: b.problems });
    const fx = b.scene.comps.flatMap((cp) => cp.layers).flatMap((L) => (L.effects ?? []).map((e) => ({ L, e }))).filter(({ e }) => e.match === "TBX Shader");
    c.check(`${name}: one TBX Shader effect, its bundle in the build`, fx.length === 1 && b.bundles.length === 1 && fx[0].e.bundle === String(b.bundles[0].id));
    if (fx.length !== 1 || b.bundles.length !== 1) continue;
    const { L, e } = fx[0];
    const bundle = b.bundles[0];
    const keys = Object.keys(e.props);
    c.check(`${name}: Bundle ID is the first prop`, keys[0] === tbxShaderParamMatch("bundle") && (e.props[keys[0]] as { v: number }).v === bundle.id);
    const want = bundle.params.map((p) => tbxShaderParamMatch(p.kind, p.slot));
    c.check(`${name}: one prop per bundle control, by match name`, keys.slice(1).sort().join() === [...want].sort().join(), { keys, want });
    const v = validateAeShader(bundle);
    c.check(`${name}: validateAeShader accepts the scene's bundle`, v.ok, v.errors);
    if (name === "v-noise") {
      const contrast = bundle.params.find((p) => p.name === "contrast");
      const prop = contrast && (e.props[tbxShaderParamMatch("slider", contrast.slot)] as { keys?: unknown[] });
      c.check("v-noise: the keyed contrast is a keyed slider labelled Contrast", contrast?.label === "Contrast" && (prop?.keys?.length ?? 0) >= 2);
      c.check("v-noise: the bundle reads the clock (looping evolution in the shader)", bundle.readsTime && bundle.loopFrames === 0);
      const labels = bundle.params.map((p) => p.label);
      c.check("v-noise: controls are labelled after the params", ["Scale", "Octaves", "Seed", "W (Evolution)", "Animated", "Rate", "Color A (low)"].every((l) => labels.includes(l)), labels);
      c.check("v-noise: type is baked, not a control", !bundle.params.some((p) => p.name === "type") && /const int u_type = 1;/.test(bundle.source.glsl ?? ""));
      const prompt = aeConvertPrompt(b.plan, "x", {});
      c.check("v-noise: the Convert prompt says it exports as is and asks to fuse nothing", /own shader/.test(prompt) && /no shader regions to fuse/.test(prompt));
    } else {
      // AE masks a layer before its effects, so the mask goes on a precomp.
      const inner = b.scene.comps.find((cp) => cp.layers.includes(L))!;
      const holder = b.scene.comps.flatMap((cp) => cp.layers).find((x) => x.kind === "precomp" && x.source === inner.id);
      c.check(
        "v-noise-masked: the spline mask and the opacity are on a precomp of the shader layer, not on the shader layer",
        !L.masks?.length && (holder?.masks?.length ?? 0) === 1 && (holder?.transform.opacity as { v?: number } | undefined)?.v === 50,
        { holder: holder?.name, masks: holder?.masks?.length, opacity: holder?.transform.opacity }
      );
      c.check("v-noise-masked: phasor's own controls ship (Orientation in degrees)", bundle.params.some((p) => p.label === "Orientation (deg)" && p.default === 30));
    }
  }
  // A multi-node region still needs its fused node.
  const cs = await sceneOf(SCENE_FIXTURES.find((x) => x.name === "c-shader")!);
  c.check("c-shader: multi-node regions carry no kernel (they still need opts.fused)", cs.plan.shaderRegions.every((r) => r.kernel === undefined) && aeRegionsToFuse(cs.plan).length === cs.plan.shaderRegions.length);
  return c.failures;
}
