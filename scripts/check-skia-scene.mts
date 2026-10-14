// check-skia-scene: the Skia scene renderer + the first native Skia nodes
// (specdocs/101326_skia-target.md §3.4, lane L1). CanvasKit on a CPU
// surface in Node — no GPU, no device, deterministic:
//
//   1. every SkiaNode kind (group, fill, shape, image, text, atlas), every
//      GeomIR, ShaderIR, ColorFilterIR, ImageFilterIR and PathEffectIR kind
//      renders hand-written IR to the pixels its definition says, sampled at
//      chosen points;
//   2. the semantics follow React Native Skia, not intuition: group opacity
//      and blendMode apply per child draw, layer filters sit outside the
//      group's transform, clips are local, trim runs first, filter arrays
//      are in application order;
//   3. the group transform is React Native Skia's: transformMatrix() equals
//      RN's processTransformProps2 math (the gate ports it; when
//      skia-harness/node_modules is installed it also runs RN's own
//      Matrix4.ts), and a rotated + scaled marker about an origin lands
//      where that matrix says, not where the other orders would put it;
//   4. bad IR never throws — it becomes problems while the rest draws;
//   5. skia-fill / skia-group / skia-shape emit the IR (and binds) their
//      contract says, and skia-shape's path renders where Rasterize Spline
//      puts the spline (aspect-corrected y on a non-square canvas).
//
// The editor half (the shared WebGL surface, premul → straight hand-off)
// is exercised by `npm run parity:skia` through the SkSL Shader node, which
// shares that path with Skia Canvas.
//
//   npx tsx scripts/check-skia-scene.mts

/* eslint-disable @typescript-eslint/no-explicit-any */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { CanvasKit } from "canvaskit-wasm";
import type { NodeOutput, RenderContext, SkiaDrawValue, SocketValue, SplineValue } from "@/engine/types";
import type {
  AssetIR,
  Bind,
  BindXY,
  ColorFilterIR,
  GeomIR,
  ImageFilterIR,
  PaintIR,
  PathEffectIR,
  RGBA,
  ShaderIR,
  SkiaNode,
  TransformIR,
} from "@/engine/skia/scene-ir";
import type { SceneAssetResolver } from "@/engine/skia/scene-render";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const { registerAllNodes } = await import("@/nodes/index");
registerAllNodes();
const { getNodeDef } = await import("@/engine/registry");
const { coerceValue } = await import("@/engine/coerce");
const { SKIA_IR_VERSION } = await import("@/engine/skia/scene-ir");
const { renderScene, transformMatrix } = await import("@/engine/skia/scene-render");
const { makeCircleSubpath } = await import("@/nodes/source/circle");
const { aspectCorrectY } = await import("@/engine/aspect");

const require = createRequire(path.join(ROOT, "package.json"));
const CK: CanvasKit = await require("canvaskit-wasm")();

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  console.log(`${cond ? "ok  " : "FAIL"} ${name}${!cond && detail ? ` — ${detail}` : ""}`);
  if (!cond) failures++;
}

// ---- IR builders ---------------------------------------------------------------

const b = <T,>(v: T): Bind<T> => ({ v });
const xy = (x: number, y: number): BindXY => [b(x), b(y)];
const RED: RGBA = [1, 0, 0, 1];
const GREEN: RGBA = [0, 1, 0, 1];
const BLUE: RGBA = [0, 0, 1, 1];
const WHITE: RGBA = [1, 1, 1, 1];
const solid = (c: RGBA, extra: Partial<PaintIR> = {}): PaintIR => ({ style: "fill", color: b(c), ...extra });
const stroke = (c: RGBA, w: number, extra: Partial<PaintIR> = {}): PaintIR => ({ style: "stroke", color: b(c), strokeWidth: b(w), ...extra });
const rectG = (x: number, y: number, w: number, h: number, r?: number): GeomIR => ({
  k: "rect", x: b(x), y: b(y), w: b(w), h: b(h), ...(r !== undefined ? { r: b(r) } : {}),
});
const shape = (geom: GeomIR, paint: PaintIR): SkiaNode => ({ k: "shape", geom, paint });
const rect = (x: number, y: number, w: number, h: number, paint: PaintIR = solid(RED)) => shape(rectG(x, y, w, h), paint);
const fill = (paint: PaintIR): SkiaNode => ({ k: "fill", paint });
const group = (children: SkiaNode[], extra: Partial<Extract<SkiaNode, { k: "group" }>> = {}): SkiaNode => ({ k: "group", children, ...extra });
const line = (x1: number, y1: number, x2: number, y2: number, paint: PaintIR) => shape({ k: "line", p1: xy(x1, y1), p2: xy(x2, y2) }, paint);
const stops = (...cs: RGBA[]) => cs.map((c, i) => ({ pos: b(i / Math.max(1, cs.length - 1)), color: b(c) }));
const program = (sksl: string, uniforms: Record<string, number | number[]> = {}, children: { name: string; shader: ShaderIR }[] = []): ShaderIR => ({
  k: "runtime",
  program: { sksl, uniforms: Object.fromEntries(Object.entries(uniforms).map(([k, v]) => [k, b(v)])), children },
});
const colorShader = (c: RGBA): ShaderIR => ({ k: "color", color: b(c) });

// ---- render + sample -----------------------------------------------------------

interface Rendered {
  px: Uint8Array;
  w: number;
  h: number;
  problems: string[];
  pending: string[];
  threw: string | null;
}

function render(
  root: SkiaNode,
  o: { w?: number; h?: number; bg?: RGBA; assets?: SceneAssetResolver; assetIR?: Record<string, AssetIR> } = {}
): Rendered {
  const w = o.w ?? 64;
  const h = o.h ?? 64;
  const surface = CK.MakeSurface(w, h)!;
  const canvas = surface.getCanvas();
  canvas.clear(CK.TRANSPARENT);
  let threw: string | null = null;
  let res: ReturnType<typeof renderScene> | null = null;
  try {
    res = renderScene(CK, canvas, {
      version: SKIA_IR_VERSION,
      width: w,
      height: h,
      root,
      assets: o.assetIR ?? {},
      ...(o.bg ? { background: o.bg } : {}),
    }, { assets: o.assets });
  } catch (e) {
    threw = e instanceof Error ? e.message : String(e);
  }
  surface.flush();
  const snap = surface.makeImageSnapshot();
  const px = snap.readPixels(0, 0, {
    width: w,
    height: h,
    colorType: CK.ColorType.RGBA_8888,
    alphaType: CK.AlphaType.Unpremul,
    colorSpace: CK.ColorSpace.SRGB,
  }) as Uint8Array;
  res?.release();
  snap.delete();
  surface.delete();
  return { px: new Uint8Array(px), w, h, problems: res?.problems ?? [], pending: res?.pending ?? [], threw };
}

const at = (r: Rendered, x: number, y: number) => Array.from(r.px.subarray((y * r.w + x) * 4, (y * r.w + x) * 4 + 4));

// `want` entries of null are not compared.
function px(name: string, r: Rendered, x: number, y: number, want: (number | null)[], tol = 3) {
  const got = at(r, x, y);
  const ok = !r.threw && want.every((v, i) => v === null || Math.abs(got[i] - v) <= tol);
  check(name, ok, r.threw ? `threw: ${r.threw}` : `(${x},${y}) = [${got}] want [${want.map((v) => v ?? "_")}]`);
}
const clear = (name: string, r: Rendered, x: number, y: number) => px(name, r, x, y, [null, null, null, 0], 0);
const clean = (name: string, r: Rendered) =>
  check(name, !r.threw && r.problems.length === 0, r.threw ? `threw: ${r.threw}` : r.problems.join(" | "));
const alphaOf = (r: Rendered, x: number, y: number) => at(r, x, y)[3];

// ---- 1. fills, background, shapes ------------------------------------------------------
{
  const r = render(fill(solid(RED)));
  clean("fill renders without problems", r);
  px("fill: flat color everywhere", r, 32, 32, [255, 0, 0, 255], 0);
  const half = render(fill(solid(BLUE, { opacity: b(0.5) })));
  px("fill: opacity scales alpha", half, 10, 10, [0, 0, 255, 128], 1);
  const bg = render(fill(solid(RED, { opacity: b(0.5) })), { bg: GREEN });
  px("scene background under a half-opacity fill (srcOver in sRGB)", bg, 5, 5, [128, 127, 0, 255], 2);
  const bgOnly = render(group([]), { bg: [0, 0, 1, 0.5] });
  px("background alone: translucent stays translucent", bgOnly, 0, 0, [0, 0, 255, 128], 1);
}
{
  const r = render(rect(10, 10, 20, 20));
  clean("rect: no problems", r);
  px("rect: inside", r, 20, 20, [255, 0, 0, 255], 0);
  px("rect: last pixel inside", r, 29, 29, [255, 0, 0, 255], 0);
  clear("rect: outside left/top", r, 5, 5);
  clear("rect: outside right", r, 31, 20);
  const rr = render(shape(rectG(10, 10, 30, 30, 8), solid(RED)));
  clear("rounded rect: corner cut", rr, 11, 11);
  px("rounded rect: straight edge kept", rr, 11, 25, [255, 0, 0, 255], 0);
  px("rounded rect: center", rr, 25, 25, [255, 0, 0, 255], 0);

  const c = render(shape({ k: "circle", cx: b(32), cy: b(32), r: b(10) }, solid(RED)));
  px("circle: center", c, 32, 32, [255, 0, 0, 255], 0);
  px("circle: inside near the edge", c, 40, 32, [255, 0, 0, 255], 0);
  clear("circle: outside", c, 44, 32);

  const ov = render(shape({ k: "oval", x: b(8), y: b(24), w: b(48), h: b(16) }, solid(RED)));
  px("oval: wide axis", ov, 12, 32, [255, 0, 0, 255], 0);
  px("oval: inside short axis", ov, 32, 26, [255, 0, 0, 255], 0);
  clear("oval: outside short axis", ov, 32, 21);

  const ln = render(line(8, 32, 56, 32, stroke(RED, 4)));
  px("line: stroked", ln, 32, 31, [255, 0, 0, 255], 0);
  clear("line: off the stroke", ln, 32, 40);
  clear("line: butt cap stops at the endpoint", ln, 5, 32);
  const sq = render(line(8, 32, 56, 32, stroke(RED, 4, { strokeCap: "square" })));
  px("line: square cap extends half the width", sq, 6, 32, [255, 0, 0, 255], 0);
  const rd = render(line(8, 32, 56, 32, stroke(RED, 8, { strokeCap: "round" })));
  px("line: round cap covers the endpoint disc", rd, 5, 32, [255, 0, 0, null], 0);
  clear("line: round cap is round, not square", rd, 4, 28);

  const d = "M8 8 H56 V56 H8 Z M24 24 H40 V40 H24 Z";
  const eo = render(shape({ k: "path", d: b(d), fillType: "evenOdd" }, solid(RED)));
  const nz = render(shape({ k: "path", d: b(d), fillType: "winding" }, solid(RED)));
  clear("path evenOdd: inner square is a hole", eo, 32, 32);
  px("path evenOdd: ring filled", eo, 16, 16, [255, 0, 0, 255], 0);
  px("path winding: same-direction contours fill the middle", nz, 32, 32, [255, 0, 0, 255], 0);

  const pts = render(shape({ k: "points", pts: b([16, 16, 48, 48]), mode: "points" }, stroke(RED, 6, { strokeCap: "round" })));
  px("points: a dot per point", pts, 16, 16, [255, 0, 0, 255], 0);
  clear("points: nothing between", pts, 32, 32);
  const lns = render(shape({ k: "points", pts: b([8, 32, 56, 32]), mode: "lines" }, stroke(RED, 2)));
  px("points mode=lines: segment pairs", lns, 32, 32, [255, 0, 0, 255], 0);
  const poly = render(shape({ k: "points", pts: b([8, 8, 56, 8, 56, 56]), mode: "polygon" }, stroke(RED, 2)));
  px("points mode=polygon: polyline edge 1", poly, 32, 8, [255, 0, 0, 255], 0);
  px("points mode=polygon: polyline edge 2", poly, 56, 32, [255, 0, 0, 255], 0);
  clear("points mode=polygon: open, not filled", poly, 32, 32);
}

// ---- 2. paint ------------------------------------------------------------------------
{
  const mul = render(group([rect(0, 0, 64, 64, solid(RED)), rect(32, 0, 32, 64, solid(BLUE, { blendMode: "multiply" }))]));
  px("paint blendMode multiply: red × blue = black", mul, 48, 32, [0, 0, 0, 255], 0);
  px("paint blendMode: untouched region", mul, 16, 32, [255, 0, 0, 255], 0);
  const inh = render(group([rect(0, 0, 64, 64, solid(RED)), group([rect(32, 0, 32, 64, solid(BLUE))], { blendMode: "multiply" })]));
  px("group blendMode is inherited by child draws", inh, 48, 32, [0, 0, 0, 255], 0);
  const own = render(group([rect(0, 0, 64, 64, solid(RED)), group([rect(32, 0, 32, 64, solid(BLUE, { blendMode: "srcOver" }))], { blendMode: "multiply" })]));
  px("a child's own blendMode overrides the group's", own, 48, 32, [0, 0, 255, 255], 0);

  const partial = (r: Rendered) => {
    let n = 0;
    for (let i = 3; i < r.px.length; i += 4) if (r.px[i] > 0 && r.px[i] < 255) n++;
    return n;
  };
  const aaOn = render(shape({ k: "circle", cx: b(32), cy: b(32), r: b(10.3) }, solid(RED)));
  const aaOff = render(shape({ k: "circle", cx: b(32), cy: b(32), r: b(10.3) }, solid(RED, { antiAlias: false })));
  check("antiAlias defaults on (RN's default paint): soft edge pixels", partial(aaOn) > 10, `${partial(aaOn)}`);
  check("antiAlias false: hard edges", partial(aaOff) === 0, `${partial(aaOff)}`);

  const shown = render(rect(16, 16, 32, 32, solid(RED)));
  clear("no mask filter: hard rect edge", shown, 13, 32);
  for (const style of ["normal", "solid", "outer", "inner"] as const) {
    const r = render(rect(16, 16, 32, 32, solid(RED, { maskFilter: { k: "blur", sigma: b(3), style } })));
    const outside = alphaOf(r, 13, 32);
    const center = alphaOf(r, 32, 32);
    const wantOutside = style === "inner" ? outside === 0 : outside > 5 && outside < 250;
    const wantCenter = style === "outer" ? center === 0 : center > 250;
    check(`mask blur style=${style}: outside ${wantOutside ? "ok" : outside} / center ${wantCenter ? "ok" : center}`, wantOutside && wantCenter);
  }

  const SWAP_RB = [0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0];
  const IDENT = [1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0];
  const cf = (f: ColorFilterIR[], c: RGBA = RED) => render(fill(solid(c, { colorFilters: f })));
  px("color filter matrix (swap r↔b)", cf([{ k: "matrix", m: b(SWAP_RB) }]), 8, 8, [0, 0, 255, 255], 0);
  px("color filter blend (green, srcIn)", cf([{ k: "blend", color: b(GREEN), mode: "srcIn" }]), 8, 8, [0, 255, 0, 255], 0);
  const lerp = (t: number) => cf([{ k: "lerp", t: b(t), a: { k: "matrix", m: b(IDENT) }, b: { k: "matrix", m: b(SWAP_RB) } }]);
  px("color filter lerp t=0 → a", lerp(0), 8, 8, [255, 0, 0, 255], 0);
  px("color filter lerp t=1 → b", lerp(1), 8, 8, [0, 0, 255, 255], 0);
  px("color filter lerp t=0.5 → mix", lerp(0.5), 8, 8, [128, 0, 128, 255], 1);
  px("color filter luma: rgb 0, alpha = Rec.709 luma", cf([{ k: "luma" }]), 8, 8, [0, 0, 0, 54], 1);
  px("color filter linearToSrgb (0.5 → 188)", cf([{ k: "linearToSrgb" }], [0.5, 0.5, 0.5, 1]), 8, 8, [188, 188, 188, 255], 2);
  px("color filter srgbToLinear (0.5 → 55)", cf([{ k: "srgbToLinear" }], [0.5, 0.5, 0.5, 1]), 8, 8, [55, 55, 55, 255], 2);
  // A = constant blue (matrix translate column is 0..1), B = r ← b.
  // [A, B] on red: A first → blue, then B → magenta. [B, A] would be blue.
  const A: ColorFilterIR = { k: "matrix", m: b([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0]) };
  const B: ColorFilterIR = { k: "matrix", m: b([0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0]) };
  px("color filters run in array order (index 0 first)", cf([A, B]), 8, 8, [255, 0, 255, 255], 0);
  px("… and the reverse order gives the other answer", cf([B, A]), 8, 8, [0, 0, 255, 255], 0);
}

// ---- 3. path effects ------------------------------------------------------------------
{
  const hline = (effects: PathEffectIR[], w = 2) => render(line(0, 32, 64, 32, stroke(RED, w, { pathEffects: effects })));
  const dash = hline([{ k: "dash", intervals: [b(4), b(4)], phase: b(0) }]);
  clean("dash: no problems", dash);
  px("dash: on", dash, 1, 32, [255, 0, 0, 255], 0);
  clear("dash: off", dash, 5, 32);
  px("dash: on again", dash, 9, 32, [255, 0, 0, 255], 0);
  const phased = hline([{ k: "dash", intervals: [b(4), b(4)], phase: b(4) }]);
  clear("dash phase shifts the pattern", phased, 1, 32);

  const corner = render(shape(rectG(8, 8, 48, 48), solid(RED, { pathEffects: [{ k: "corner", r: b(16) }] })));
  clear("corner: rect corner rounded", corner, 9, 9);
  px("corner: middle of an edge kept", corner, 9, 32, [255, 0, 0, 255], 0);

  const disc = () => hline([{ k: "discrete", length: b(4), deviation: b(3), seed: 7 }]);
  const d1 = disc();
  const d2 = disc();
  const plain = hline([]);
  let diff = 0;
  for (let i = 0; i < d1.px.length; i++) if (d1.px[i] !== plain.px[i]) diff++;
  check("discrete: displaces the path", diff > 20, `${diff} bytes differ`);
  check("discrete: deterministic for a seed", Buffer.compare(Buffer.from(d1.px), Buffer.from(d2.px)) === 0);

  const trim = hline([{ k: "trim", start: b(0), end: b(0.5) }]);
  px("trim [0, 0.5]: first half drawn", trim, 16, 32, [255, 0, 0, 255], 0);
  clear("trim [0, 0.5]: second half gone", trim, 48, 32);
  const trim2 = hline([{ k: "trim", start: b(0), end: b(0.5) }, { k: "trim", start: b(0.5), end: b(1) }]);
  px("two trims compose by length: [0.25, 0.5]", trim2, 24, 32, [255, 0, 0, 255], 0);
  clear("two trims: before 0.25", trim2, 8, 32);
  clear("two trims: after 0.5", trim2, 40, 32);
  // Skia's circle contour starts at the rightmost point and runs
  // clockwise on screen (Y-down): the first quarter is right → bottom.
  const arc = render(shape({ k: "circle", cx: b(32), cy: b(32), r: b(20) }, stroke(RED, 4, { pathEffects: [{ k: "trim", start: b(0), end: b(0.25) }] })));
  px("trim on a circle: first quarter is right → bottom", arc, 46, 46, [255, 0, 0, 255], 0);
  clear("trim on a circle: the opposite quarter is gone", arc, 17, 17);

  const dashCorner = hline([{ k: "dash", intervals: [b(4), b(4)], phase: b(0) }, { k: "corner", r: b(2) }]);
  clean("dash then corner: dash goes on the geometry, corner on the paint", dashCorner);
  clear("dash then corner: still dashed", dashCorner, 5, 32);
  const cornerDash = hline([{ k: "corner", r: b(2) }, { k: "dash", intervals: [b(4), b(4)], phase: b(0) }]);
  check("corner then dash: reported (CanvasKit cannot compose)", cornerDash.problems.some((p) => p.includes("cannot compose")), cornerDash.problems.join(" | "));
  const late = hline([{ k: "dash", intervals: [b(4), b(4)], phase: b(0) }, { k: "trim", start: b(0), end: b(0.5) }]);
  check("trim after another effect: reported (RN trims first)", late.problems.some((p) => p.includes("trim applies before")));
  clear("trim after dash still trims the geometry first", late, 49, 32);
}

// ---- 4. shaders ------------------------------------------------------------------------
{
  const sh = (s: ShaderIR, extra: Partial<PaintIR> = {}) => render(fill({ style: "fill", shader: s, ...extra }));
  px("shader color", sh(colorShader(GREEN)), 8, 8, [0, 255, 0, 255], 0);
  px("paint color alpha still scales a shader (RN)", sh(colorShader(GREEN), { color: b([1, 1, 1, 0.5]) }), 8, 8, [0, 255, 0, 128], 1);

  const lin = sh({ k: "linear", start: xy(0, 0), end: xy(64, 0), stops: stops([0, 0, 0, 1], WHITE) });
  px("linear: start", lin, 0, 8, [2, 2, 2, 255], 2);
  px("linear: middle", lin, 32, 8, [130, 130, 130, 255], 2);
  px("linear: end", lin, 63, 8, [253, 253, 253, 255], 2);
  const tiled = (tile: "clamp" | "repeat" | "mirror" | "decal") => sh({ k: "linear", start: xy(16, 0), end: xy(48, 0), stops: stops(RED, BLUE), tile });
  px("linear tile=clamp: past the end", tiled("clamp"), 56, 8, [0, 0, 255, 255], 0);
  px("linear tile=repeat: wraps", tiled("repeat"), 50, 8, [235, 0, 20, 255], 3);
  px("linear tile=mirror: reflects", tiled("mirror"), 50, 8, [20, 0, 235, 255], 3);
  clear("linear tile=decal: transparent outside", tiled("decal"), 56, 8);

  const rad = sh({ k: "radial", c: xy(32, 32), r: b(32), stops: stops(RED, BLUE) });
  px("radial: center", rad, 32, 32, [251, 0, 4, 255], 3);
  px("radial: rim", rad, 63, 32, [4, 0, 251, 255], 3);
  // start/end in RADIANS (the exporter converts to RN's degrees).
  const sw = sh({ k: "sweep", c: xy(32, 32), start: b(0), end: b(Math.PI), stops: stops(RED, BLUE) });
  px("sweep: 45° of a 0..π sweep is a quarter in", sw, 44, 44, [191, 0, 64, 255], 1);
  px("sweep: past π clamps to the last stop", sw, 20, 20, [0, 0, 255, 255], 0);
  const con = sh({ k: "conical", c0: xy(32, 32), r0: b(0), c1: xy(32, 32), r1: b(32), stops: stops(RED, BLUE) });
  px("conical (concentric) behaves like radial", con, 63, 32, [4, 0, 251, 255], 3);

  const quad = CK.MakeImage(
    { width: 2, height: 2, alphaType: CK.AlphaType.Unpremul, colorType: CK.ColorType.RGBA_8888, colorSpace: CK.ColorSpace.SRGB },
    new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255]),
    8
  )!;
  const assets: SceneAssetResolver = (id) => (id === "quad" ? quad : null);
  const img = render(fill({ style: "fill", shader: { k: "image", asset: "quad", fit: "fill", rect: [b(0), b(0), b(64), b(64)] } }), { assets });
  px("image shader fit=fill: top-left texel", img, 16, 16, [251, 4, 0, 255], 6);
  px("image shader fit=fill: top-right texel", img, 48, 16, [4, 251, 0, 255], 6);
  px("image shader fit=fill: bottom-left texel", img, 16, 48, [4, 0, 251, 255], 6);
  // (decal on both axes: the corner texel's bilinear footprint is 0.984² inside)
  px("image shader fit=fill: bottom-right texel", img, 48, 48, [247, 247, 247, 247], 6);
  const none = render(fill({ style: "fill", shader: { k: "image", asset: "quad", fit: "none", rect: [b(0), b(0), b(64), b(64)] } }), { assets });
  clear("image shader fit=none + default decal tile: only the image's own pixels", none, 4, 4);
  px("image shader fit=none: centered at native size", none, 31, 31, [255, 0, 0, 255], 8);

  px("runtime: uniform drives the color", sh(program("uniform float4 c; half4 main(float2 p){ return half4(c); }", { c: [0, 1, 0, 1] })), 8, 8, [0, 255, 0, 255], 0);
  const named = sh(program("uniform shader b; uniform shader a; half4 main(float2 p){ return a.eval(p); }", {}, [
    { name: "a", shader: colorShader(RED) },
    { name: "b", shader: colorShader(BLUE) },
  ]));
  clean("runtime children: no problems", named);
  px("runtime children bind by name, not list order", named, 8, 8, [255, 0, 0, 255], 0);
  const res = sh(program("uniform float3 iResolution; half4 main(float2 p){ return half4(p.x / iResolution.x, 0, 0, 1); }", { iResolution: [64, 64, 1] }));
  check("runtime: main() gets Y-down pixel coords (iResolution in px)", at(res, 56, 8)[0] > at(res, 8, 8)[0] + 150);
  const nested = sh(program("uniform shader inner; half4 main(float2 p){ half4 c = inner.eval(p); return half4(c.b, c.g, c.r, c.a); }", {}, [
    { name: "inner", shader: program("uniform float4 c; half4 main(float2 p){ return half4(c); }", { c: [1, 0, 0, 1] }) },
  ]));
  px("runtime child can itself be a runtime program", nested, 8, 8, [0, 0, 255, 255], 0);
  const missing = sh(program("uniform float k; half4 main(float2 p){ return half4(k); }"));
  check("runtime: a declared uniform without a bind is reported", missing.problems.some((p) => p.includes('"k" has no value')));
  const broken = sh(program("half4 main(float2 p){ return undefined_thing; }"));
  check("runtime: compile errors are reported, not thrown", !broken.threw && broken.problems.some((p) => p.includes("SkSL compile failed")));
  const orphan = sh(program("uniform shader a; half4 main(float2 p){ return a.eval(p); }"));
  check("runtime: an unsupplied child is reported", orphan.problems.some((p) => p.includes('"a" is not supplied')));
  quad.delete();
}

// ---- 5. image, text, atlas ------------------------------------------------------------------
{
  // 4×2: left half red, right half blue.
  const wideBytes = new Uint8Array(4 * 2 * 4);
  for (let y = 0; y < 2; y++) for (let x = 0; x < 4; x++) wideBytes.set(x < 2 ? [255, 0, 0, 255] : [0, 0, 255, 255], (y * 4 + x) * 4);
  const wide = CK.MakeImage(
    { width: 4, height: 2, alphaType: CK.AlphaType.Unpremul, colorType: CK.ColorType.RGBA_8888, colorSpace: CK.ColorSpace.SRGB },
    wideBytes,
    16
  )!;
  const assets: SceneAssetResolver = (id) => (id === "wide" ? wide : id === "loading" ? undefined : null);
  const imgNode = (fit: "fill" | "contain" | "cover" | "none"): SkiaNode => ({ k: "image", asset: "wide", x: b(0), y: b(0), w: b(64), h: b(64), fit });
  const contain = render(imgNode("contain"), { assets });
  clear("image fit=contain: letterboxed above", contain, 32, 8);
  px("image fit=contain: left half", contain, 12, 32, [255, 0, 0, 255], 6);
  px("image fit=contain: right half", contain, 52, 32, [0, 0, 255, 255], 6);
  const cover = render(imgNode("cover"), { assets });
  px("image fit=cover: fills the box (cropped)", cover, 12, 8, [255, 0, 0, 255], 6);
  px("image fit=cover: right half", cover, 52, 56, [0, 0, 255, 255], 6);
  const fillFit = render(imgNode("fill"), { assets });
  px("image fit=fill: stretched", fillFit, 4, 4, [255, 0, 0, 255], 8);
  const none = render(imgNode("none"), { assets });
  clear("image fit=none: native size, centered", none, 20, 32);
  px("image fit=none: its pixels", none, 30, 31, [255, 0, 0, 255], 8);
  const gone = render(group([{ k: "image", asset: "nope", x: b(0), y: b(0), w: b(64), h: b(64), fit: "fill" }, rect(0, 0, 8, 8)]), { assets });
  check("image: missing asset is a problem, not a throw", !gone.threw && gone.problems.some((p) => p.includes('"nope" is not available')));
  px("image: siblings of a missing asset still draw", gone, 4, 4, [255, 0, 0, 255], 0);
  const pend = render({ k: "image", asset: "loading", x: b(0), y: b(0), w: b(8), h: b(8), fit: "fill" }, { assets });
  check("image: a still-loading asset is pending, not a problem", pend.problems.length === 0 && pend.pending.includes("loading"));

  // Atlas: 2×1 (red | blue), each 1-px sprite scaled 16×.
  const pair = CK.MakeImage(
    { width: 2, height: 1, alphaType: CK.AlphaType.Unpremul, colorType: CK.ColorType.RGBA_8888, colorSpace: CK.ColorSpace.SRGB },
    new Uint8Array([255, 0, 0, 255, 0, 0, 255, 255]),
    8
  )!;
  const atlasAssets: SceneAssetResolver = (id) => (id === "pair" ? pair : null);
  const atlas = render({ k: "atlas", asset: "pair", sprites: [[0, 0, 1, 1], [1, 0, 1, 1]], xforms: b([16, 0, 8, 8, 16, 0, 40, 8]) }, { assets: atlasAssets });
  clean("atlas: no problems", atlas);
  px("atlas: sprite 1 placed by its RSXform", atlas, 16, 16, [255, 0, 0, 255], 10);
  px("atlas: sprite 2 placed by its RSXform", atlas, 48, 16, [0, 0, 255, 255], 10);
  clear("atlas: nothing between sprites", atlas, 32, 16);
  const badAtlas = render({ k: "atlas", asset: "pair", sprites: [[0, 0, 1, 1]], xforms: b([1, 0, 0]) }, { assets: atlasAssets });
  check("atlas: wrong xform count is reported", badAtlas.problems.some((p) => p.includes("xforms")));

  // Text with a bundled font.
  const fontBytes = fs.readFileSync(path.join(ROOT, "public/fonts/Inter-VariableFont_opsz,wght.ttf"));
  const font = new Uint8Array(fontBytes);
  const fonts: SceneAssetResolver = (id, kind) => (id === "inter" && kind === "font" ? font : null);
  const ink = (r: Rendered, pred: (p: number[]) => boolean = (p) => p[3] > 128) => {
    let n = 0, sx = 0, minY = Infinity, maxY = -Infinity;
    for (let y = 0; y < r.h; y++)
      for (let x = 0; x < r.w; x++)
        if (pred(at(r, x, y))) {
          n++;
          sx += x;
          minY = Math.min(minY, y);
          maxY = Math.max(maxY, y);
        }
    return { n, cx: n ? sx / n : NaN, minY, maxY };
  };
  const hi = render({ k: "text", text: b("HI"), font: { asset: "inter", size: b(32) }, x: b(4), y: b(40), paint: solid(RED) }, { assets: fonts });
  const hiInk = ink(hi);
  clean("text: no problems", hi);
  check("text: glyphs drawn in the paint color", ink(hi, (p) => p[3] > 128 && p[0] > 200 && p[2] < 50).n > 60, `${hiInk.n}`);
  check("text: y is the baseline (cap glyphs sit on it)", hiInk.maxY <= 40 && hiInk.maxY >= 37 && hiInk.minY >= 8, `rows ${hiInk.minY}..${hiInk.maxY}`);
  const centered = render({ k: "text", text: b("HI"), font: { asset: "inter", size: b(32) }, x: b(32), y: b(40), align: "center", paint: solid(RED) }, { assets: fonts });
  check("text align=center: ink centered on x", Math.abs(ink(centered).cx - 32) < 3, `cx ${ink(centered).cx.toFixed(1)}`);
  const para = render({ k: "text", text: b("hello world hello world"), font: { asset: "inter", size: b(12) }, x: b(2), y: b(2), width: b(40), paint: solid(RED) }, { assets: fonts });
  const paraInk = ink(para);
  check("text with width: wraps into a paragraph (top-left at x, y)", paraInk.minY >= 2 && paraInk.maxY - paraInk.minY > 24, `rows ${paraInk.minY}..${paraInk.maxY}`);
  const shaded = render({ k: "text", text: b("HI"), font: { asset: "inter", size: b(32) }, x: b(4), y: b(40), paint: { style: "fill", shader: colorShader(GREEN) } }, { assets: fonts });
  check("text: paint shader fills the glyphs", ink(shaded, (p) => p[3] > 128 && p[1] > 200 && p[0] < 50).n > 60);
  const noFont = render(group([{ k: "text", text: b("HI"), font: { asset: "gone", size: b(32) }, x: b(4), y: b(40), paint: solid(RED) }, rect(0, 0, 4, 4)]), { assets: fonts });
  check("text: missing font is a problem, not a throw", !noFont.threw && noFont.problems.some((p) => p.includes('"gone"')));
  px("text: siblings still draw", noFont, 1, 1, [255, 0, 0, 255], 0);
  wide.delete();
  pair.delete();
}

// ---- 6. groups: transform, opacity, clip --------------------------------------------------
{
  const moved = render(group([rect(0, 0, 10, 10)], { transform: { translate: xy(20, 0) } }));
  px("group translate", moved, 25, 5, [255, 0, 0, 255], 0);
  clear("group translate: source position empty", moved, 5, 5);
  const mat = render(group([rect(0, 0, 4, 4)], { transform: { matrix: b([1, 0, 30, 0, 1, 0, 0, 0, 1]) } }));
  px("group matrix (3×3 row-major)", mat, 31, 1, [255, 0, 0, 255], 0);
  const skew = render(group([rect(0, 32, 8, 8)], { transform: { skew: [b(Math.atan(0.5)), b(0)] } }));
  px("group skewX shears x by tan(angle)·y", skew, 20, 36, [255, 0, 0, 255], 0);
  clear("group skewX: unsheared spot empty", skew, 4, 36);

  // Per-draw opacity: two overlapping white rects at 0.5 → overlap 0.75.
  const op = render(group([rect(8, 8, 32, 32, solid(WHITE)), rect(24, 8, 32, 32, solid(WHITE))], { opacity: b(0.5) }));
  px("group opacity is per draw: single coverage 0.5", op, 12, 16, [255, 255, 255, 128], 1);
  px("group opacity is per draw: overlap 0.75 (not a layer)", op, 32, 16, [255, 255, 255, 191], 1);
  const nest = render(group([group([fill(solid(WHITE))], { opacity: b(0.5) })], { opacity: b(0.5) }));
  px("nested group opacity multiplies", nest, 8, 8, [255, 255, 255, 64], 1);
  // RN clamps at every multiply: group 4 → 1, then the draw's 0.5 → 0.5
  // (an unclamped product 4 × 0.5 = 2 would read opaque).
  const over = render(group([fill(solid(WHITE, { opacity: b(0.5) }))], { opacity: b(4) }));
  px("opacity clamps to 0..1 at each level (RN setOpacity)", over, 8, 8, [255, 255, 255, 128], 1);

  const clipR = render(group([fill(solid(RED))], { clip: { geom: rectG(16, 16, 32, 32) } }));
  clear("clip rect: outside", clipR, 8, 8);
  px("clip rect: inside", clipR, 32, 32, [255, 0, 0, 255], 0);
  const inv = render(group([fill(solid(RED))], { clip: { geom: rectG(16, 16, 32, 32), invert: true } }));
  px("clip invert: outside drawn", inv, 8, 8, [255, 0, 0, 255], 0);
  clear("clip invert: inside cut", inv, 32, 32);
  const clipC = render(group([fill(solid(RED))], { clip: { geom: { k: "circle", cx: b(32), cy: b(32), r: b(10) } } }));
  px("clip circle: inside", clipC, 32, 32, [255, 0, 0, 255], 0);
  clear("clip circle: outside", clipC, 46, 32);
  const clipRR = render(group([fill(solid(RED))], { clip: { geom: rectG(8, 8, 48, 48, 12) } }));
  clear("clip rounded rect: corner", clipRR, 9, 9);
  const local = render(group([fill(solid(RED))], { transform: { translate: xy(20, 0) }, clip: { geom: rectG(0, 0, 10, 64) } }));
  px("clip is local (after the transform)", local, 25, 32, [255, 0, 0, 255], 0);
  clear("clip is local: the untransformed region is cut", local, 5, 32);
  clear("clip is local: beyond the transformed region", local, 35, 32);
}

// ---- 7. transform order == React Native Skia ---------------------------------------------
{
  // RN: processTransformProps2 → Skia.Matrix().translate(o).concat(m4).translate(−o),
  // m4 = processTransform3d(transforms) (each entry post-multiplied), and
  // JsiSkMatrix.translate / concat are PRE-multiplies (ref · m). Ported from
  // react-native-skia/src/{dom/nodes/datatypes/Transform.ts, skia/types/Matrix4.ts,
  // skia/web/JsiSkMatrix.ts}; RN's own Matrix4.ts runs too when installed.
  type M4 = number[];
  const t4 = (x: number, y: number): M4 => [1, 0, 0, x, 0, 1, 0, y, 0, 0, 1, 0, 0, 0, 0, 1];
  const mul4 = (a: M4, c: M4): M4 => {
    const r = new Array(16).fill(0);
    for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) r[i * 4 + j] = a[i * 4] * c[j] + a[i * 4 + 1] * c[j + 4] + a[i * 4 + 2] * c[j + 8] + a[i * 4 + 3] * c[j + 12];
    return r;
  };
  const rot4 = (a: number): M4 => [Math.cos(a), -Math.sin(a), 0, 0, Math.sin(a), Math.cos(a), 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const sc4 = (x: number, y: number): M4 => [x, 0, 0, 0, 0, y, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const skx4 = (a: number): M4 => [1, Math.tan(a), 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const sky4 = (a: number): M4 => [1, 0, 0, 0, Math.tan(a), 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const to3 = (m: M4) => [m[0], m[1], m[3], m[4], m[5], m[7], m[12], m[13], m[15]];
  type RNList = Record<string, number | number[]>[];
  const rnList = (t: TransformIR): RNList => [
    ...(t.translate ? [{ translateX: t.translate[0].v }, { translateY: t.translate[1].v }] : []),
    ...(t.rotate ? [{ rotate: t.rotate.v }] : []),
    ...(t.scale ? [{ scaleX: t.scale[0].v }, { scaleY: t.scale[1].v }] : []),
    ...(t.skew ? [{ skewX: t.skew[0].v }, { skewY: t.skew[1].v }] : []),
  ];
  const port3d = (list: RNList): M4 =>
    list.reduce<M4>((acc, e) => {
      const [k, v] = Object.entries(e)[0] as [string, number];
      const m =
        k === "translateX" ? t4(v, 0) : k === "translateY" ? t4(0, v) : k === "rotate" ? rot4(v) : k === "scaleX" ? sc4(v, 1) : k === "scaleY" ? sc4(1, v) : k === "skewX" ? skx4(v) : sky4(v);
      return mul4(acc, m);
    }, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  let rnProcess: ((list: RNList) => M4) | null = null;
  const rnSrc = path.join(ROOT, "skia-harness/node_modules/react-native-skia/src/skia/types/Matrix4.ts");
  if (fs.existsSync(rnSrc)) {
    const rn = await import(pathToFileURL(rnSrc).href);
    rnProcess = (list) => rn.processTransform3d(list) as M4;
  }
  const rnMatrix = (t: TransformIR, process: (list: RNList) => M4) => {
    // CanvasKit.Matrix.multiply is what RN web's JsiSkMatrix runs.
    let m = CK.Matrix.identity();
    if (t.origin) m = CK.Matrix.multiply(m, CK.Matrix.translated(t.origin[0].v, t.origin[1].v));
    m = CK.Matrix.multiply(m, t.matrix ? t.matrix.v : to3(process(rnList(t))));
    if (t.origin) m = CK.Matrix.multiply(m, CK.Matrix.translated(-t.origin[0].v, -t.origin[1].v));
    return m;
  };
  const cases: TransformIR[] = [
    { translate: xy(5, 0), rotate: b(Math.PI / 2), scale: xy(2, 1), origin: xy(32, 32) },
    { translate: xy(-13.5, 7.25), rotate: b(-0.7), scale: xy(0.5, -1.5), skew: [b(0.3), b(-0.2)], origin: xy(10, 50) },
    { rotate: b(1.1) },
    { scale: xy(3, 3), origin: xy(64, 0) },
    { matrix: b([0, -1, 10, 1, 0, 20, 0, 0, 1]), origin: xy(30, 40) },
  ];
  let worstPort = 0;
  let worstRn = 0;
  for (const t of cases) {
    const ours = transformMatrix(t)!;
    const viaPort = rnMatrix(t, port3d);
    worstPort = Math.max(worstPort, ...ours.map((v, i) => Math.abs(v - viaPort[i])));
    if (rnProcess) {
      const viaRn = rnMatrix(t, rnProcess);
      worstRn = Math.max(worstRn, ...ours.map((v, i) => Math.abs(v - viaRn[i])));
    }
  }
  check(`transformMatrix == RN's composition (ported), ${cases.length} transforms`, worstPort < 1e-9, `max |Δ| ${worstPort}`);
  if (rnProcess) check(`transformMatrix == RN's own Matrix4.ts processTransform3d`, worstRn < 1e-9, `max |Δ| ${worstRn}`);
  else console.log("skip transformMatrix vs RN's own source (skia-harness/node_modules not installed)");
  check("origin alone records no transform (RN processCTM)", transformMatrix({ origin: xy(5, 5) }) === null);

  // Marker 40..44 × 30..34 under origin (32,32), rotate 90°, scale (2,1),
  // translate (5,0). RN's matrix: (x, y) → (37 − (y − 32), 52 + 2(x − 42)) …
  const t = cases[0];
  const m = rnMatrix(t, port3d);
  const map = (x: number, y: number) => [m[0] * x + m[1] * y + m[2], m[3] * x + m[4] * y + m[5]];
  const [ex, ey] = map(42, 32);
  const r = render(group([rect(40, 30, 4, 4)], { transform: t }));
  check(`RN math puts the marker center at (${ex.toFixed(1)}, ${ey.toFixed(1)})`, Math.abs(ex - 37) < 1e-9 && Math.abs(ey - 52) < 1e-9);
  px("rotated + scaled marker lands where RN's matrix says", r, 37, 52, [255, 0, 0, 255], 0);
  px("… its scaled long axis runs along y (scale before rotate)", r, 37, 49, [255, 0, 0, 255], 0);
  clear("not where rotate-before-scale would put it", r, 33, 42);
  clear("not where translate-before-rotate would put it", r, 32, 47);
  clear("not where ignoring the origin would put it", r, 42, 32);
}

// ---- 8. layers: image filters + color filters ------------------------------------------------
{
  const layer = (children: SkiaNode[], imageFilters: ImageFilterIR[], colorFilters: ColorFilterIR[] = [], extra: Partial<Extract<SkiaNode, { k: "group" }>> = {}) =>
    render(group(children, { layer: { imageFilters, colorFilters }, ...extra }));

  const blur = layer([rect(16, 16, 32, 32)], [{ k: "blur", sx: b(3), sy: b(3) }]);
  clean("blur: no problems", blur);
  check("blur: soft edge outside the rect", alphaOf(blur, 13, 32) > 5 && alphaOf(blur, 13, 32) < 250, `${alphaOf(blur, 13, 32)}`);
  px("blur: interior unchanged", blur, 32, 32, [255, 0, 0, 255], 2);
  // Layer filters sit OUTSIDE the group transform: sigma 2 stays 2 device px
  // under scale 4 (inside it, the edge would spread like sigma 8).
  const scaled = layer([rect(4, 4, 8, 8)], [{ k: "blur", sx: b(2), sy: b(2) }], [], { transform: { scale: xy(4, 4) } });
  check("layer filter params are in the parent's coordinates (not scaled by the group)", alphaOf(scaled, 13, 32) < 60, `${alphaOf(scaled, 13, 32)}`);

  const off = layer([rect(0, 0, 10, 10)], [{ k: "offset", dx: b(10), dy: b(0) }]);
  px("offset", off, 15, 5, [255, 0, 0, 255], 0);
  clear("offset: origin vacated", off, 5, 5);
  const dil = layer([rect(20, 20, 24, 24)], [{ k: "morphology", op: "dilate", r: b(3) }]);
  px("morphology dilate grows", dil, 18, 32, [255, 0, 0, 255], 0);
  const ero = layer([rect(20, 20, 24, 24)], [{ k: "morphology", op: "erode", r: b(3) }]);
  clear("morphology erode shrinks", ero, 21, 32);
  px("morphology erode keeps the core", ero, 32, 32, [255, 0, 0, 255], 0);

  const drop = layer([rect(0, 0, 20, 20)], [{ k: "shadow", dx: b(10), dy: b(0), blur: b(0), color: b([0, 0, 0, 1]) }]);
  px("drop shadow: content over its shadow", drop, 10, 10, [255, 0, 0, 255], 0);
  px("drop shadow: shadow beside it", drop, 25, 10, [0, 0, 0, 255], 0);
  const only = layer([rect(0, 0, 20, 20)], [{ k: "shadow", dx: b(10), dy: b(0), blur: b(0), color: b([0, 0, 0, 1]), shadowOnly: true }]);
  px("shadowOnly: the shadow replaces the content", only, 15, 10, [0, 0, 0, 255], 0);
  clear("shadowOnly: content itself not drawn", only, 5, 5);
  const inner = layer([rect(8, 8, 48, 48, solid(WHITE))], [{ k: "shadow", dx: b(0), dy: b(0), blur: b(4), color: b([0, 0, 0, 1]), inner: true }]);
  check("inner shadow darkens inside the edge", at(inner, 9, 32)[0] < at(inner, 32, 32)[0] - 30 && alphaOf(inner, 9, 32) === 255, `edge ${at(inner, 9, 32)} center ${at(inner, 32, 32)}`);
  clear("inner shadow stays inside the shape", inner, 4, 32);

  // displacement: out(x) = in(x + scale·(map − 0.5)); r = 1, scale 20 → reads 10 px right.
  const disp = layer([rect(30, 0, 10, 64)], [{ k: "displacement", channelX: "r", channelY: "g", scale: b(20), map: colorShader([1, 0.5, 0.5, 1]) }]);
  px("displacement moves content by scale·(channel − 0.5)", disp, 25, 32, [255, 0, 0, 255], 0);
  clear("displacement: original spot vacated", disp, 35, 32);

  const SWAP_RB = [0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0];
  const lcf = layer([rect(0, 0, 10, 10)], [{ k: "offset", dx: b(10), dy: b(0) }], [{ k: "matrix", m: b(SWAP_RB) }]);
  px("layer image filter then color filter", lcf, 15, 5, [0, 0, 255, 255], 0);
  const nativeOrder = layer([rect(28, 28, 8, 8)], [{ k: "morphology", op: "dilate", r: b(4) }, { k: "offset", dx: b(16), dy: b(0) }]);
  px("native image filters compose in array order (dilate, then offset)", nativeOrder, 46, 32, [255, 0, 0, 255], 0);

  // Runtime filters (emulated: CanvasKit has no RuntimeShader image filter).
  const SWAP_SKSL = "uniform shader content; half4 main(float2 p){ half4 c = content.eval(p); return half4(c.b, c.g, c.r, c.a); }";
  const MASK_SKSL = "uniform shader content; half4 main(float2 p){ return p.x < 32.0 ? content.eval(p) : half4(0); }";
  const rt = (sksl: string): ImageFilterIR => ({ k: "runtime", program: { sksl, uniforms: {}, children: [] }, content: "content" });
  const swap = layer([fill(solid(RED))], [rt(SWAP_SKSL)]);
  clean("runtime filter: no problems", swap);
  px("runtime filter reads the layer through `content`", swap, 32, 32, [0, 0, 255, 255], 0);
  const maskThenOffset = layer([fill(solid(RED))], [rt(MASK_SKSL), { k: "offset", dx: b(20), dy: b(0) }]);
  px("runtime then offset: masked first, then moved", maskThenOffset, 45, 32, [255, 0, 0, 255], 0);
  clear("runtime then offset: right of the moved mask edge", maskThenOffset, 55, 32);
  const offsetThenMask = layer([fill(solid(RED))], [{ k: "offset", dx: b(20), dy: b(0) }, rt(MASK_SKSL)]);
  clear("offset then runtime: masked after moving", offsetThenMask, 45, 32);
  px("offset then runtime: moved content left of the edge", offsetThenMask, 25, 32, [255, 0, 0, 255], 0);
  const clipped = render(group([group([fill(solid(RED))], { layer: { imageFilters: [rt(SWAP_SKSL)] } })], { clip: { geom: rectG(0, 0, 32, 64) } }));
  clear("runtime filter output respects the parent clip", clipped, 48, 32);
  px("runtime filter inside the parent clip", clipped, 16, 32, [0, 0, 255, 255], 0);
  // The program sees the parent's LOCAL coordinates: under a translate of
  // 10 the x < 32 mask edge lands at device x = 42.
  const shifted = render(group([group([rect(0, 0, 64, 64)], { layer: { imageFilters: [rt(MASK_SKSL)] } })], { transform: { translate: xy(10, 0) } }));
  px("runtime filter coords are parent-local: inside the moved edge", shifted, 40, 32, [255, 0, 0, 255], 0);
  clear("runtime filter coords are parent-local: past the moved edge", shifted, 45, 32);
  clear("runtime filter: left of the translated content", shifted, 5, 32);
  const noContent = layer([fill(solid(RED))], [{ k: "runtime", program: { sksl: "half4 main(float2 p){ return half4(1); }", uniforms: {}, children: [] }, content: "content" }]);
  check("runtime filter without the content child is reported", noContent.problems.some((p) => p.includes("uniform shader content")));
}

// ---- 9. bad IR never throws ----------------------------------------------------------------------
{
  const garbage: any[] = [
    { k: "nope" },
    { k: "shape", geom: { k: "triangle" }, paint: solid(RED) },
    { k: "shape", geom: { k: "path", d: b("M 0 0 L banana") }, paint: solid(RED) },
    { k: "shape", geom: rectG(0, 0, NaN, 10), paint: solid(RED) },
    { k: "fill", paint: { style: "fill", color: b([1, 0]) } },
    { k: "fill", paint: { style: "fill", shader: { k: "warp" } } },
    { k: "fill", paint: { style: "fill", blendMode: "glow" } },
    { k: "group", children: "x" },
    { k: "group", children: [], transform: { matrix: b([1, 2, 3]) } },
    { k: "group", children: [rect(0, 0, 4, 4)], layer: { imageFilters: [{ k: "fog" }], colorFilters: [{ k: "matrix", m: b([1]) }] } },
    { k: "shape", geom: rectG(0, 0, 4, 4), paint: { style: "stroke", pathEffects: [{ k: "wiggle" }] } },
    { k: "fill", paint: { style: "fill", shader: { k: "linear", start: xy(0, 0), end: xy(1, 0), stops: [] } } },
    null,
  ];
  const cyc: any = { k: "group", children: [] };
  cyc.children.push(cyc);
  const r = render(group([...garbage, cyc, rect(60, 60, 4, 4)]));
  check("garbage IR: no throw", r.threw === null, r.threw ?? "");
  check(`garbage IR: every bad node reported (${r.problems.length} problems)`, r.problems.length >= garbage.length, r.problems.join("\n      "));
  px("garbage IR: the valid sibling still draws", r, 62, 62, [255, 0, 0, 255], 0);
  const empty = render({ k: "shape", geom: { k: "path", d: b("") }, paint: solid(RED) });
  check("an empty path draws nothing and is not a problem", empty.problems.length === 0 && alphaOf(empty, 32, 32) === 0);
  const noRoot = (() => {
    const s = CK.MakeSurface(8, 8)!;
    try {
      const res = renderScene(CK, s.getCanvas(), { version: SKIA_IR_VERSION, width: 8, height: 8, root: undefined as any, assets: {} });
      res.release();
      return res.problems;
    } finally {
      s.delete();
    }
  })();
  check("a scene without a root is a problem, not a throw", noRoot.some((p) => p.includes("no root")));

  // Determinism: a busy scene renders byte-identically twice.
  const busy = group([
    fill({ style: "fill", shader: { k: "radial", c: xy(20, 20), r: b(40), stops: stops(RED, GREEN, BLUE) } }),
    group([shape({ k: "circle", cx: b(40), cy: b(30), r: b(14) }, stroke(WHITE, 3, { pathEffects: [{ k: "dash", intervals: [b(5), b(3)], phase: b(1) }] }))], { transform: { rotate: b(0.4), origin: xy(32, 32) }, opacity: b(0.8) }),
    group([rect(8, 40, 30, 16, solid([1, 1, 0, 1]))], { layer: { imageFilters: [{ k: "blur", sx: b(2), sy: b(1) }] } }),
  ]);
  const one = render(busy);
  const two = render(busy);
  check("deterministic: identical bytes on a re-render", Buffer.compare(Buffer.from(one.px), Buffer.from(two.px)) === 0);
}

// ---- 10. the native nodes ---------------------------------------------------------------------
{
  const ctxOf = (w: number, h: number, time = 0) => ({ width: w, height: h, time, state: {} }) as unknown as RenderContext;
  const run = (type: string, inputs: Record<string, SocketValue | undefined>, params: Record<string, unknown> = {}, ctx = ctxOf(64, 64), nodeId = type) => {
    const def = getNodeDef(type)!;
    const defaults = Object.fromEntries(def.params.map((p) => [p.name, p.default]));
    const coerced: Record<string, SocketValue | undefined> = {};
    for (const [name, v] of Object.entries(inputs)) {
      const sock = def.inputs.find((s) => s.name === name);
      if (!sock) throw new Error(`${type} has no "${name}" socket`);
      coerced[name] = coerceValue(v, sock.type, ctx);
    }
    return (def.compute({ inputs: coerced, auxIn: {}, params: { ...defaults, ...params }, ctx, nodeId }) as NodeOutput).primary as SkiaDrawValue;
  };

  for (const type of ["skia-canvas", "skia-fill", "skia-group", "skia-shape"]) {
    const def = getNodeDef(type);
    check(`${type} is registered with a skia class`, !!def?.skia && !!def.facts, type);
  }
  check("skia-canvas is the terminal (skia_draw in, image out)", getNodeDef("skia-canvas")?.skia?.class === "terminal" && getNodeDef("skia-canvas")?.primaryOutput === "image" && getNodeDef("skia-canvas")?.inputs[0]?.type === "skia_draw");
  check(
    "native nodes declare what they mirror",
    getNodeDef("skia-fill")?.skia?.mirrors === "solid-color" && getNodeDef("skia-group")?.skia?.mirrors === "transform" && getNodeDef("skia-shape")?.skia?.mirrors === "rasterize-spline"
  );
  check("skia-canvas fingerprint folds CanvasKit readiness", /^ck[01]\|a:\d+$/.test(getNodeDef("skia-canvas")!.fingerprintExtras!({}, ctxOf(8, 8), "c")));

  // Fill: params → paint binds.
  const f = run("skia-fill", {}, { color: "#ff000080", opacity: 0.5, blendMode: "screen" }, ctxOf(64, 64), "f1");
  const fp = f.node.k === "fill" ? f.node.paint : null;
  check("skia-fill emits a fill with its id", f.kind === "skia_draw" && f.node.k === "fill" && f.node.id === "f1");
  check("skia-fill color is an RGBA bind on the color param", !!fp?.color && fp.color.ref?.param === "color" && fp.color.ref.node === "f1" && Math.abs(fp.color.v[3] - 128 / 255) < 1e-9);
  check("skia-fill opacity / blendMode", fp?.opacity?.v === 0.5 && fp.opacity.ref?.param === "opacity" && fp.blendMode === "screen");
  const lf = render(run("skia-fill", {}, { color: "#00ff00" }).node);
  px("skia-fill renders its color", lf, 8, 8, [0, 255, 0, 255], 0);
  const withLeaf = run("skia-fill", { shader: { kind: "skia_shader", expr: { k: "leaf", shader: colorShader(BLUE) } } });
  check("skia-fill fuses a wired leaf shader into the paint", withLeaf.node.k === "fill" && withLeaf.node.paint.shader?.k === "color");
  px("skia-fill with a shader draws the shader", render(withLeaf.node), 8, 8, [0, 0, 255, 255], 0);
  const warn = console.warn;
  let warned = 0;
  console.warn = () => void warned++;
  const fctx = ctxOf(64, 64);
  const call = { kind: "skia_shader" as const, expr: { k: "call" as const, fn: "tbx.noise.simplex@1", node: "n", params: {}, inputs: {} } };
  const fallback = run("skia-fill", { shader: call }, { color: "#ff0000" }, fctx, "f2");
  run("skia-fill", { shader: call }, { color: "#ff0000" }, fctx, "f2");
  console.warn = warn;
  check("skia-fill: an unfusable shader falls back to color and warns once", fallback.node.k === "fill" && !fallback.node.paint.shader && warned === 1, `warned ${warned}`);
  const timed = { kind: "skia_shader" as const, expr: { k: "program" as const, node: "s", program: { sksl: "uniform float3 iResolution; uniform float iTime; half4 main(float2 p){ return half4(fract(iTime), 0, 0, 1); }", uniforms: { iResolution: b([64, 64, 1]), iTime: b(0.25) }, children: [] } } };
  const tctx = ctxOf(64, 64, 1.5);
  run("skia-fill", { shader: timed }, {}, tctx, "f3");
  check("skia-fill folds the clock into its fingerprint when the program reads iTime", getNodeDef("skia-fill")!.fingerprintExtras!({}, tctx, "f3") === "t:1.5");
  const sctx = ctxOf(64, 64, 1.5);
  run("skia-fill", { shader: { kind: "skia_shader", expr: { k: "program", node: "s", program: { sksl: "uniform float iTime; half4 main(float2 p){ return half4(1); }", uniforms: { iTime: b(0) }, children: [] } } } }, {}, sctx, "f4");
  check("… but not when iTime is only declared", getNodeDef("skia-fill")!.fingerprintExtras!({}, sctx, "f4") === "");

  // Group: children in socket order, transform binds.
  const kid1 = run("skia-fill", {}, { color: "#ff0000" }, ctxOf(64, 64), "k1");
  const kid2: SkiaDrawValue = { kind: "skia_draw", node: rect(0, 0, 16, 16, solid(BLUE)), assets: { a: { id: "a", kind: "image", mime: "image/png", url: "x" } } };
  const g = run("skia-group", { child1: kid1, child3: kid2 }, { translateX: 16, translateY: 8, rotate: 90, scaleX: 2, scaleY: 1, originX: 8, originY: 8, opacity: 0.5, blendMode: "multiply" }, ctxOf(64, 64), "g1");
  const gn = g.node.k === "group" ? g.node : null;
  check("skia-group: children in socket order, empty sockets skipped", gn?.children.length === 2 && gn.children[0] === kid1.node && gn.children[1] === kid2.node);
  check("skia-group: child assets are carried up", !!g.assets?.a);
  check("skia-group: translate/scale/origin/opacity are refs to their params", gn?.transform?.translate?.[0].ref?.param === "translateX" && gn.transform.scale?.[1].ref?.param === "scaleY" && gn.transform.origin?.[0].ref?.param === "originX" && gn.opacity?.ref?.param === "opacity" && gn.opacity.v === 0.5);
  check(
    "skia-group: rotate is radians, DERIVED from the degrees param (no straight ref)",
    !!gn?.transform?.rotate && Math.abs(gn.transform.rotate.v - Math.PI / 2) < 1e-12 && !gn.transform.rotate.ref && gn.transform.rotate.deps?.[0]?.param === "rotate" && gn.transform.rotate.deps[0].node === "g1"
  );
  check("skia-group: blendMode passes through; srcOver is left to inherit", gn?.blendMode === "multiply" && (run("skia-group", {}).node as any).blendMode === undefined);
  const gr = render(run("skia-group", { child1: { kind: "skia_draw", node: rect(0, 0, 8, 8) } }, { translateX: 20 }).node);
  px("skia-group renders its translate", gr, 24, 4, [255, 0, 0, 255], 0);

  // Shape: a real Circle-node spline on a non-square canvas stays round and
  // lands where Rasterize Spline puts it.
  const W = 128;
  const H = 64;
  const circle: SplineValue = { kind: "spline", subpaths: [makeCircleSubpath(0.5, 0.5, 0.2, 0.2)] };
  const sh = run("skia-shape", { spline: circle }, { color: "#ff0000" }, ctxOf(W, H), "s1");
  const sn = sh.node.k === "shape" ? sh.node : null;
  check("skia-shape: a path geom", sn?.geom.k === "path" && sn.id === "s1");
  const pathBind = sn?.geom.k === "path" ? sn.geom.d : null;
  check("skia-shape: path bind is derived with deps: [] (exporter resolves the spline's producer)", !!pathBind && Array.isArray(pathBind.deps) && pathBind.deps.length === 0 && !pathBind.ref);
  check("skia-shape: fill uses evenOdd by default (Rasterize Spline's fill_rule)", sn?.geom.k === "path" && sn.geom.fillType === "evenOdd" && sn.paint.style === "fill");
  const sr = render(sh.node, { w: W, h: H });
  clean("skia-shape renders without problems", sr);
  const r = 0.2 * W; // width-relative radius, in px on both axes
  px("skia-shape: circle center", sr, 64, 32, [255, 0, 0, 255], 0);
  px("skia-shape: inside the x radius", sr, Math.round(64 + r - 3), 32, [255, 0, 0, 255], 0);
  px("skia-shape: inside the y radius (aspect-corrected, still round)", sr, 64, Math.round(32 + r - 3), [255, 0, 0, 255], 0);
  clear("skia-shape: outside the x radius", sr, Math.round(64 + r + 2), 32);
  check("skia-shape y mapping is Rasterize Spline's (aspectCorrectY)", Math.abs(aspectCorrectY(0.5 + 0.2, W / H) * H - (32 + r)) < 1e-9);
  const st = run("skia-shape", { spline: circle }, { style: "stroke", stroke_width: 6, cap: "butt", join: "bevel", color: "#00ff00" }, ctxOf(W, H), "s2");
  const sp = st.node.k === "shape" ? st.node.paint : null;
  check("skia-shape stroke: width/cap/join on the paint, width a param ref", sp?.style === "stroke" && sp.strokeWidth?.v === 6 && sp.strokeWidth.ref?.param === "stroke_width" && sp.strokeCap === "butt" && sp.strokeJoin === "bevel" && (st.node as any).geom.fillType === undefined);
  const strokeR = render(st.node, { w: W, h: H });
  clear("skia-shape stroke: hollow center", strokeR, 64, 32);
  px("skia-shape stroke: on the ring", strokeR, Math.round(64 + r), 32, [0, 255, 0, 255], 0);
  const open: SplineValue = { kind: "spline", subpaths: [{ closed: false, anchors: [{ pos: [0.1, 0.2] }, { pos: [0.9, 0.2] }, { pos: [0.5, 0.9] }] }] };
  const openFill = render(run("skia-shape", { spline: open }, { color: "#ff0000" }).node);
  px("skia-shape fill closes open subpaths", openFill, 32, 24, [255, 0, 0, 255], 0);
  const empty = render(run("skia-shape", {}, {}).node);
  check("skia-shape without a spline draws nothing, quietly", empty.problems.length === 0 && alphaOf(empty, 32, 32) === 0);
}

console.log(`\n${failures === 0 ? "all checks passed" : `${failures} failure(s)`}`);
process.exit(failures === 0 ? 0 : 1);
