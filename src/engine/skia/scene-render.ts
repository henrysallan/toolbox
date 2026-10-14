// CanvasKit renderer for the Skia scene IR (specdocs/101326_skia-target.md
// §3.4): the preview half of "one description, two renderers". It draws a
// SkiaScene onto any CanvasKit canvas — the shared WebGL surface in the
// editor (sksl-render.ts renderSkiaToImage), a CPU surface (CK.MakeSurface)
// in the Node gates — using each Bind's `v`. Producers already evaluated
// every value at the current tick; nothing here reads the clock.
//
// The semantics are React Native Skia's (v3, react-native-skia/src/sksg),
// read from its recorder and player, because the exporter emits JSX that RN
// replays and the two must agree pixel for pixel:
//
//   group transform  M = T(origin) · T(translate) · R(rotate) · S(scale)
//                        · skewX · skewY · T(−origin)
//                    i.e. RN's `transform={[{translateX}, {translateY},
//                    {rotate}, {scaleX}, {scaleY}, {skewX}, {skewY}]}` with
//                    `origin` (processTransformProps2 + processTransform3d:
//                    each entry post-multiplies). Scale and rotation happen
//                    about the origin; translate moves the result. `matrix`
//                    (3×3 row-major) replaces the list: T(o) · matrix · T(−o).
//   group opacity    NOT a layer. RN multiplies it into an opacity stack
//                    (clamped to 0..1 at each level) and scales every
//                    descendant draw's paint alpha by the product, so
//                    overlapping children at 0.5 show their overlap.
//   group blendMode  Also inherited per draw (it is a paint prop on the
//                    group): each descendant draws with it unless its own
//                    paint sets one.
//   group layer      RN `layer={<Paint>…filters…</Paint>}` wraps the group:
//                    saveLayer(fresh paint + filters) OUTSIDE the group's
//                    own transform / clip / opacity, so those apply to the
//                    draws inside the layer and filter params are in the
//                    parent's coordinates.
//   group clip       Applied after the transform (local coordinates),
//                    anti-aliased; `invert` is ClipOp.Difference.
//   paint            Starts from RN's default paint (opaque black,
//                    antiAlias on). A shader replaces the color's RGB but
//                    the color's alpha still scales it, as in RN.
//   trim             RN <Path start end> trims the geometry FIRST (before
//                    fill type, stroke and every path effect), so `trim`
//                    entries apply first wherever they sit in pathEffects;
//                    several compose into one interval.
//   atlas            RN <Atlas> (drawAtlas: linear sampling, no mipmaps,
//                    the inherited paint). A `texture` sheet is a sub-scene
//                    rendered on its own (fresh paint stack) into an
//                    offscreen surface at the surface's density — RN
//                    useTexture — then pivots / rotate / scale post-compose
//                    each RSXform (composeAtlasXforms).
//
// Filter / effect arrays are in APPLICATION ORDER: index 0 sees the
// content (or path) first and each later entry wraps the previous one.
// React Native Skia composes SIBLING filters last-first
// (materializePaint's reduceRight), so the exporter emits them reversed or
// nests each earlier filter inside the later one. Same for colorFilters and
// pathEffects. On a layer, image filters run before the layer's color
// filters (Skia folds a layer paint's color filter outside its image
// filter).
//
// Units the exporter must convert for RN props: sweep gradient start / end
// are radians here (RN wants degrees); blur, shadow blur and mask-filter
// blur are Skia sigmas, which is what RN's `blur` props take.
//
// Where CanvasKit itself falls short of native React Native Skia (and so of
// what an exact preview needs), the renderer emulates and says so:
//   - `runtime` image filters (RN <RuntimeShader>) have no CanvasKit
//     factory (RN web throws too). The layer renders to an offscreen
//     surface and the chain runs over snapshots (drawEmulatedLayer); the
//     program's main() sees the group's parent-local coordinates, which is
//     what native Skia's parameter space gives it. To verify on device.
//   - Path effects cannot be composed in CanvasKit (RN web throws too).
//     A 2-interval dash ahead of the last effect is applied to the geometry
//     instead; anything else that would need composition is reported and
//     skipped.
//
// Contract: renderScene never throws on bad IR. Everything it cannot draw
// becomes a line in `problems` (deduplicated), and the rest still draws.

import type {
  Canvas,
  CanvasKit,
  ColorFilter,
  EmbindEnumEntity,
  EmbindObject,
  Image,
  ImageFilter,
  Paint,
  Path,
  PathEffect,
  Shader,
  Surface,
  Typeface,
  TypefaceFontProvider,
} from "canvaskit-wasm";
import type {
  AssetIR,
  Bind,
  BindXY,
  BlendMode,
  ColorFilterIR,
  GeomIR,
  GradientStopIR,
  ImageFilterIR,
  PaintIR,
  PathEffectIR,
  RGBA,
  ShaderIR,
  SkiaNode,
  SkiaScene,
  SkslProgramIR,
  TileMode,
  TransformIR,
} from "./scene-ir";
import { compileSksl, packUniforms, stripComments, type SkslUniformValues } from "./sksl-program";
import { gradientProgram, isGradientShader, type GradientShaderIR } from "./library/gradient-program";
import { bindStatic } from "./scene-ir";

// ---- public API -------------------------------------------------------------------

// Resolves an asset id to what CanvasKit draws: a decoded Image for image
// assets, the font file's bytes for fonts. `null` = unavailable (reported as
// a problem); `undefined` = still loading (skipped silently and listed in
// `pending`, so the caller can re-render when it lands).
export type SceneAssetResolver = (
  id: string,
  kind: "image" | "font",
  asset: AssetIR | undefined
) => Image | ArrayBuffer | Uint8Array | null | undefined;

export interface SceneRenderOptions {
  assets?: SceneAssetResolver;
  // The target surface's pixel size — offscreen layers are allocated at
  // this size. Defaults to the scene's own width × height (the canvas is
  // assumed to map scene px 1:1 to device px unless the caller concats a
  // scale first and says so here).
  surfaceSize?: [number, number];
  // Atlas sprite sheets drawn from a sub-scene (`atlas.texture`), keyed by
  // the sub-scene: reused across frames as React Native Skia's useTexture
  // renders once. Caller-owned (images stay valid for the canvas's GPU
  // context); entries over the cap are deleted oldest first. Absent: every
  // frame rasterises its sheets again. Additive (2026-10-14, lane A).
  textureCache?: Map<string, Image>;
  // Draw gradients with Skia's native gradient shaders instead of their
  // color-managed programs (library/gradient-program.ts) — what scenes drew
  // before 2026-10-14 lane C. Gates only: the export always ships the
  // program, so the preview must too.
  nativeGradients?: boolean;
}

// Sprite sheets larger than this on a side are refused (GPU texture limits
// on phones start at 4096).
export const ATLAS_TEXTURE_MAX = 4096;
const ATLAS_TEXTURE_CACHE = 16;

// The RSXforms an atlas draws (scene-ir.ts `atlas`): each xform (scos,
// ssin, tx, ty) post-composed with the uniform spin / zoom about its pivot,
//   x' = T(p) · R(rotate) · S(scale) · T(−p) · x,
// then its scale divided by k (the sheet is rasterised k× denser). The
// exported bundle's worklet does exactly this arithmetic, in this order
// (scene-emit.ts atlas), so the two agree to the last float.
export function composeAtlasXforms(
  xforms: readonly number[],
  o: { pivots?: readonly number[]; rotate?: number; scale?: number; k?: number } = {}
): number[] {
  const n = Math.floor(xforms.length / 4);
  const out = new Array<number>(n * 4);
  const k = o.k ?? 1;
  const mod = o.pivots && (o.rotate !== undefined || o.scale !== undefined);
  const s = o.scale ?? 1;
  const c = Math.cos(o.rotate ?? 0) * s;
  const d = Math.sin(o.rotate ?? 0) * s;
  for (let i = 0; i < n; i++) {
    let a = xforms[i * 4];
    let b = xforms[i * 4 + 1];
    let tx = xforms[i * 4 + 2];
    let ty = xforms[i * 4 + 3];
    if (mod) {
      const px = o.pivots![i * 2];
      const py = o.pivots![i * 2 + 1];
      const na = c * a - d * b;
      const nb = d * a + c * b;
      const ntx = px + c * (tx - px) - d * (ty - py);
      const nty = py + d * (tx - px) + c * (ty - py);
      a = na;
      b = nb;
      tx = ntx;
      ty = nty;
    }
    out[i * 4] = a / k;
    out[i * 4 + 1] = b / k;
    out[i * 4 + 2] = tx;
    out[i * 4 + 3] = ty;
  }
  return out;
}

export interface SceneRenderResult {
  problems: string[];
  // Asset ids the resolver reported as still loading.
  pending: string[];
  // Deletes the CanvasKit objects this frame created (paints, shaders,
  // filters, paths, offscreen layers). Call it once the surface has been
  // flushed — on a CPU surface, after reading the pixels — so nothing a
  // recorded draw references is deleted before Skia executes it.
  release: () => void;
}

export function renderScene(
  kit: CanvasKit,
  canvas: Canvas,
  scene: SkiaScene,
  opts: SceneRenderOptions = {}
): SceneRenderResult {
  const r = new SceneRenderer(kit, canvas, scene, opts);
  r.run();
  return { problems: [...r.problems], pending: [...r.pending], release: () => r.release() };
}

// The group's 3×3 row-major matrix (CanvasKit's InputMatrix layout), or
// null when the transform does nothing RN would record (no transform /
// matrix — `origin` alone is not a transform in RN). Exported for the gate,
// which checks it against React Native Skia's own math.
export function transformMatrix(t: TransformIR | undefined): number[] | null {
  if (!t) return null;
  const o: [number, number] = t.origin ? [t.origin[0].v, t.origin[1].v] : [0, 0];
  const pivot = (m: number[]) =>
    t.origin ? mul3(mul3(translate3(o[0], o[1]), m), translate3(-o[0], -o[1])) : m;
  if (t.matrix) {
    const m = t.matrix.v;
    if (!Array.isArray(m) || m.length !== 9) return null;
    return pivot(m.slice());
  }
  if (!t.translate && !t.rotate && !t.scale && !t.skew) return null;
  let m = IDENTITY3.slice();
  if (t.translate) m = mul3(m, translate3(t.translate[0].v, t.translate[1].v));
  if (t.rotate) m = mul3(m, rotate3(t.rotate.v));
  if (t.scale) m = mul3(m, scale3(t.scale[0].v, t.scale[1].v));
  if (t.skew) {
    m = mul3(m, [1, Math.tan(t.skew[0].v), 0, 0, 1, 0, 0, 0, 1]);
    m = mul3(m, [1, 0, 0, Math.tan(t.skew[1].v), 1, 0, 0, 0, 1]);
  }
  return pivot(m);
}

// ---- matrix helpers (row-major 3×3, doubles) ---------------------------------------

const IDENTITY3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];

function mul3(a: number[], b: number[]): number[] {
  const out = new Array<number>(9);
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      out[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j];
    }
  }
  return out;
}

function translate3(x: number, y: number): number[] {
  return [1, 0, x, 0, 1, y, 0, 0, 1];
}

function rotate3(a: number): number[] {
  const c = Math.cos(a);
  const s = Math.sin(a);
  return [c, -s, 0, s, c, 0, 0, 0, 1];
}

function scale3(x: number, y: number): number[] {
  return [x, 0, 0, 0, y, 0, 0, 0, 1];
}

// ---- small helpers ---------------------------------------------------------------------

const MAX_DEPTH = 64;
const BLACK: RGBA = [0, 0, 0, 1];

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

function enumKey(k: string): string {
  return k.charAt(0).toUpperCase() + k.slice(1);
}

// `uniform shader <name>;` declarations in source order — the order
// CanvasKit expects children in (it does not expose child names).
function declaredChildren(sksl: string): string[] {
  const out: string[] = [];
  const re = /\buniform\s+shader\s+([A-Za-z_]\w*)\s*;/g;
  const code = stripComments(sksl);
  for (let m = re.exec(code); m; m = re.exec(code)) out.push(m[1]);
  return out;
}

// RN's fitRects (dom/nodes/datatypes/Fitting.ts) for the fits the IR has.
type XYWH = { x: number; y: number; width: number; height: number };
function fitRects(fit: "fill" | "contain" | "cover" | "none", src: XYWH, dst: XYWH): { src: XYWH; dst: XYWH } {
  let s = { width: 0, height: 0 };
  let d = { width: 0, height: 0 };
  if (src.width > 0 && src.height > 0 && dst.width > 0 && dst.height > 0) {
    switch (fit) {
      case "fill":
        s = src;
        d = dst;
        break;
      case "contain":
        s = src;
        d =
          dst.width / dst.height > src.width / src.height
            ? { width: (src.width * dst.height) / src.height, height: dst.height }
            : { width: dst.width, height: (src.height * dst.width) / src.width };
        break;
      case "cover":
        s =
          dst.width / dst.height > src.width / src.height
            ? { width: src.width, height: (src.width * dst.height) / dst.width }
            : { width: (src.height * dst.width) / dst.height, height: src.height };
        d = dst;
        break;
      case "none":
        s = { width: Math.min(src.width, dst.width), height: Math.min(src.height, dst.height) };
        d = s;
        break;
    }
  }
  const inscribe = (size: { width: number; height: number }, r: XYWH): XYWH => ({
    x: r.x + (r.width - size.width) / 2,
    y: r.y + (r.height - size.height) / 2,
    width: size.width,
    height: size.height,
  });
  return { src: inscribe(s, src), dst: inscribe(d, dst) };
}

// RN's MakeInnerShadow (sksg/Recorder/commands/ImageFilters.ts), verbatim
// in structure: the shadow is generated outside the alpha-saturated shape
// and clipped back into it.
const ALPHA_SATURATE = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 255, 0];

// Typefaces and font providers are built once per font buffer (per kit).
const typefaceCache = new WeakMap<CanvasKit, WeakMap<object, Typeface | null>>();
const providerCache = new WeakMap<CanvasKit, WeakMap<object, TypefaceFontProvider | null>>();
const FONT_FAMILY = "tbx-scene-font";

// Text `anchor` → the share of the block's height above y.
const TEXT_ANCHOR_K: Record<"baseline" | "top" | "middle" | "bottom", number> = { baseline: 0, top: 0, middle: 0.5, bottom: 1 };

function fontBuffer(bytes: ArrayBuffer | Uint8Array): ArrayBuffer {
  if (bytes instanceof ArrayBuffer) return bytes;
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function cachedTypeface(kit: CanvasKit, bytes: ArrayBuffer | Uint8Array): Typeface | null {
  let per = typefaceCache.get(kit);
  if (!per) typefaceCache.set(kit, (per = new WeakMap()));
  if (per.has(bytes)) return per.get(bytes) ?? null;
  const tf = kit.Typeface.MakeFreeTypeFaceFromData(fontBuffer(bytes));
  per.set(bytes, tf);
  return tf;
}

function cachedProvider(kit: CanvasKit, bytes: ArrayBuffer | Uint8Array): TypefaceFontProvider | null {
  let per = providerCache.get(kit);
  if (!per) providerCache.set(kit, (per = new WeakMap()));
  if (per.has(bytes)) return per.get(bytes) ?? null;
  const prov = kit.TypefaceFontProvider.Make();
  prov.registerFont(fontBuffer(bytes), FONT_FAMILY);
  per.set(bytes, prov);
  return prov;
}

// What the draw inherits from its ancestors (RN's paint + opacity stacks;
// IR groups carry only these two paint props).
interface PaintCtx {
  opacity: number;
  blendMode?: BlendMode;
}

type Deletable = Pick<EmbindObject<string>, "delete">;

// ---- the renderer --------------------------------------------------------------------------

class SceneRenderer {
  readonly problems = new Set<string>();
  readonly pending = new Set<string>();
  // Everything created for this frame; deleted by release() after the
  // caller's flush (renderSkiaToImage runs it as the draw's cleanup).
  private frame: Deletable[] = [];
  private canvas: Canvas;
  private readonly size: [number, number];

  constructor(
    private readonly kit: CanvasKit,
    canvas: Canvas,
    private readonly scene: SkiaScene,
    private readonly opts: SceneRenderOptions
  ) {
    this.canvas = canvas;
    this.size = opts.surfaceSize ?? [scene.width, scene.height];
  }

  run(): void {
    const { canvas, scene } = this;
    const saves = canvas.getSaveCount();
    try {
      if (!scene || typeof scene !== "object" || !scene.root) {
        this.problem("scene has no root node");
        return;
      }
      if (scene.background) {
        canvas.drawColor(this.color({ v: scene.background }, "scene background"));
      }
      this.drawNode(scene.root, { opacity: 1 }, 0);
    } catch (e) {
      this.problem(`scene: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      canvas.restoreToCount(saves);
    }
  }

  release(): void {
    for (const o of this.frame) {
      try {
        if (!(o as Partial<EmbindObject<string>>).isDeleted?.()) o.delete();
      } catch {
        // Already released on the Skia side; nothing left to free.
      }
    }
    this.frame = [];
  }

  // ---- bookkeeping ----

  problem(msg: string): void {
    this.problems.add(msg);
  }

  private track<T extends Deletable | null>(o: T): T {
    if (o) this.frame.push(o);
    return o;
  }

  private label(node: { k: string; id?: string }): string {
    return node.id ? `${node.k} "${node.id}"` : node.k;
  }

  // ---- bind readers ----

  private num(b: Bind<number> | undefined, fallback: number, what: string): number {
    if (!b) return fallback;
    const v = b.v;
    if (typeof v !== "number" || !Number.isFinite(v)) {
      this.problem(`${what}: not a finite number (${String(v)})`);
      return fallback;
    }
    return v;
  }

  private xy(b: BindXY | undefined, fallback: [number, number], what: string): [number, number] {
    if (!b) return fallback;
    return [this.num(b[0], fallback[0], `${what}.x`), this.num(b[1], fallback[1], `${what}.y`)];
  }

  private color(b: Bind<RGBA> | undefined, what: string, fallback: RGBA = BLACK): Float32Array {
    const v = b?.v;
    if (b === undefined) return this.kit.Color4f(...fallback);
    if (!Array.isArray(v) || v.length !== 4 || v.some((x) => typeof x !== "number" || !Number.isFinite(x))) {
      this.problem(`${what}: not an RGBA 0..1 quad (${JSON.stringify(v)})`);
      return this.kit.Color4f(...fallback);
    }
    return this.kit.Color4f(v[0], v[1], v[2], v[3]);
  }

  private blend(mode: BlendMode | undefined, what: string): EmbindEnumEntity {
    if (mode === undefined) return this.kit.BlendMode.SrcOver;
    const e = (this.kit.BlendMode as unknown as Record<string, EmbindEnumEntity | undefined>)[enumKey(mode)];
    if (!e) {
      this.problem(`${what}: unknown blend mode "${mode}"`);
      return this.kit.BlendMode.SrcOver;
    }
    return e;
  }

  private tile(mode: TileMode | undefined, fallback: TileMode, what: string) {
    const t = mode ?? fallback;
    switch (t) {
      case "clamp":
        return this.kit.TileMode.Clamp;
      case "repeat":
        return this.kit.TileMode.Repeat;
      case "mirror":
        return this.kit.TileMode.Mirror;
      case "decal":
        return this.kit.TileMode.Decal;
      default:
        this.problem(`${what}: unknown tile mode "${String(t)}"`);
        return this.kit.TileMode.Clamp;
    }
  }

  private asset(id: string, kind: "image" | "font", owner: string): Image | ArrayBuffer | Uint8Array | null {
    const info = this.scene.assets?.[id];
    if (info && info.kind !== kind && !(kind === "image" && info.kind === "svg")) {
      this.problem(`${owner}: asset "${id}" is a ${info.kind}, not a ${kind}`);
      return null;
    }
    const got = this.opts.assets ? this.opts.assets(id, kind, info) : null;
    if (got === undefined) {
      this.pending.add(id);
      return null;
    }
    if (got === null) {
      this.problem(`${owner}: ${kind} asset "${id}" is not available`);
      return null;
    }
    return got;
  }

  private imageAsset(id: string, owner: string): Image | null {
    const a = this.asset(id, "image", owner);
    if (!a) return null;
    if (a instanceof ArrayBuffer || a instanceof Uint8Array) {
      this.problem(`${owner}: asset "${id}" resolved to bytes, expected a decoded image`);
      return null;
    }
    return a;
  }

  // ---- drawing ----

  private drawNode(node: SkiaNode, pc: PaintCtx, depth: number): void {
    if (!node || typeof node !== "object") {
      this.problem("draw tree contains a non-object node");
      return;
    }
    if (depth > MAX_DEPTH) {
      this.problem(`draw tree deeper than ${MAX_DEPTH} — cycle?`);
      return;
    }
    const saves = this.canvas.getSaveCount();
    try {
      switch (node.k) {
        case "group":
          this.drawGroup(node, pc, depth);
          break;
        case "fill":
          this.canvas.drawPaint(this.paint(node.paint, pc, this.label(node)));
          break;
        case "shape":
          this.drawShape(node, pc);
          break;
        case "image":
          this.drawImage(node, pc);
          break;
        case "text":
          this.drawText(node, pc);
          break;
        case "atlas":
          this.drawAtlas(node, pc, depth);
          break;
        default:
          this.problem(`unknown draw node kind "${String((node as { k?: unknown }).k)}"`);
      }
    } catch (e) {
      this.problem(`${this.label(node)}: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      this.canvas.restoreToCount(saves);
    }
  }

  private drawGroup(node: Extract<SkiaNode, { k: "group" }>, pc: PaintCtx, depth: number): void {
    const what = this.label(node);
    const children = Array.isArray(node.children) ? node.children : [];
    if (!Array.isArray(node.children)) this.problem(`${what}: children is not an array`);
    const imageFilters = node.layer?.imageFilters ?? [];
    const colorFilters = node.layer?.colorFilters ?? [];

    const body = () => {
      const inner: PaintCtx = {
        opacity: clamp01(pc.opacity * this.num(node.opacity, 1, `${what} opacity`)),
        blendMode: node.blendMode ?? pc.blendMode,
      };
      const m = transformMatrix(node.transform);
      if (node.transform?.matrix && !m) this.problem(`${what}: matrix must be 9 numbers (3×3 row-major)`);
      if (m && m.some((x) => !Number.isFinite(x))) {
        this.problem(`${what}: transform is not finite`);
        return;
      }
      if (m || node.clip) this.canvas.save();
      if (m) this.canvas.concat(m);
      if (node.clip) this.clip(node.clip.geom, !!node.clip.invert, what);
      for (const c of children) this.drawNode(c, inner, depth + 1);
    };

    if (!node.layer) {
      body();
      return;
    }
    if (imageFilters.some((f) => f?.k === "runtime")) {
      this.drawEmulatedLayer(imageFilters, colorFilters, body, what);
      return;
    }
    const lp = this.track(new this.kit.Paint());
    const imf = this.composeImageFilters(imageFilters, what);
    if (imf) lp.setImageFilter(imf);
    const cf = this.composeColorFilters(colorFilters, what);
    if (cf) lp.setColorFilter(cf);
    this.canvas.saveLayer(lp);
    body();
  }

  // Layer whose filter chain contains a runtime program. The group renders
  // into an offscreen surface at device resolution; each step of the chain
  // then reads the previous snapshot:
  //   - native filters run through a real saveLayer under the same CTM, so
  //     Skia maps their params (blur sigma, offsets) exactly as it would
  //     for the live layer;
  //   - a runtime program is drawn with the CTM as its local matrix, so its
  //     main() sees the group's parent-LOCAL coordinates (Skia's parameter
  //     space, what native RN Skia hands a RuntimeShader filter), and the
  //     content child maps those back onto the device-space snapshot.
  // The result composites back under the inverse CTM, inside the parent's
  // clip. Programs evaluate per device pixel; under a rotated or skewed CTM
  // native Skia evaluates on a layer grid and resamples, which can differ
  // by edge AA.
  private drawEmulatedLayer(
    imageFilters: ImageFilterIR[],
    colorFilters: ColorFilterIR[],
    body: () => void,
    what: string
  ): void {
    const { kit } = this;
    const [w, h] = this.size;
    const info = {
      width: Math.max(1, Math.round(w)),
      height: Math.max(1, Math.round(h)),
      colorType: kit.ColorType.RGBA_8888,
      alphaType: kit.AlphaType.Premul,
      colorSpace: kit.ColorSpace.SRGB,
    };
    const parent = this.canvas;
    const ctm = parent.getTotalMatrix();
    const inv = kit.Matrix.invert(ctm);
    if (!inv) return; // a degenerate CTM draws nothing anyway
    const mk = (): Surface | null => this.track(parent.makeSurface(info));
    const first = mk();
    if (!first) {
      this.problem(`${what}: could not allocate an offscreen layer; filters skipped`);
      body();
      return;
    }
    const sub = first.getCanvas();
    sub.clear(kit.TRANSPARENT);
    const subSaves = sub.getSaveCount();
    sub.concat(ctm);
    this.canvas = sub;
    try {
      body();
    } finally {
      sub.restoreToCount(subSaves);
      this.canvas = parent;
    }
    let img = this.track(first.makeImageSnapshot());

    // Consecutive native filters run as one composed filter.
    let run: ImageFilterIR[] = [];
    const flushNative = () => {
      if (!run.length) return;
      const f = this.composeImageFilters(run, what);
      run = [];
      if (!f) return;
      const s = mk();
      if (!s) return;
      const c = s.getCanvas();
      c.clear(kit.TRANSPARENT);
      const lp = this.track(new kit.Paint());
      lp.setImageFilter(f);
      c.concat(ctm);
      c.saveLayer(lp);
      c.concat(inv);
      c.drawImage(img, 0, 0);
      c.restore();
      img = this.track(s.makeImageSnapshot());
    };
    for (const f of imageFilters) {
      if (f?.k !== "runtime") {
        run.push(f);
        continue;
      }
      flushNative();
      const content = this.track(
        img.makeShaderOptions(kit.TileMode.Decal, kit.TileMode.Decal, kit.FilterMode.Nearest, kit.MipmapMode.None, inv)
      );
      const shader = this.program(f.program, `${what} runtime filter`, 0, { name: f.content, shader: content }, ctm);
      if (!shader) continue;
      const s = mk();
      if (!s) continue;
      const c = s.getCanvas();
      c.clear(kit.TRANSPARENT);
      const p = this.track(new kit.Paint());
      p.setShader(shader);
      p.setBlendMode(kit.BlendMode.Src);
      c.drawPaint(p);
      img = this.track(s.makeImageSnapshot());
    }
    flushNative();

    const p = this.track(new kit.Paint());
    const cf = this.composeColorFilters(colorFilters, what);
    if (cf) p.setColorFilter(cf);
    parent.save();
    parent.concat(inv);
    parent.drawImage(img, 0, 0, p);
    parent.restore();
  }

  private clip(geom: GeomIR, invert: boolean, what: string): void {
    const { kit, canvas } = this;
    const op = invert ? kit.ClipOp.Difference : kit.ClipOp.Intersect;
    if (geom?.k === "rect") {
      const rect = kit.XYWHRect(
        this.num(geom.x, 0, `${what} clip x`),
        this.num(geom.y, 0, `${what} clip y`),
        this.num(geom.w, 0, `${what} clip w`),
        this.num(geom.h, 0, `${what} clip h`)
      );
      const r = this.num(geom.r, 0, `${what} clip r`);
      if (r > 0) canvas.clipRRect(kit.RRectXY(rect, r, r), op, true);
      else canvas.clipRect(rect, op, true);
      return;
    }
    const path = this.geomPath(geom, `${what} clip`);
    if (path) canvas.clipPath(path, op, true);
  }

  private drawShape(node: Extract<SkiaNode, { k: "shape" }>, pc: PaintCtx): void {
    const what = this.label(node);
    const { kit, canvas } = this;
    const geom = node.geom;
    const effects = Array.isArray(node.paint?.pathEffects) ? node.paint.pathEffects : [];
    const trims = effects.filter((e) => e?.k === "trim") as Extract<PathEffectIR, { k: "trim" }>[];
    const rest = effects.filter((e) => e?.k !== "trim");
    const firstOther = effects.findIndex((e) => e?.k !== "trim");
    const lastTrim = effects.map((e) => e?.k).lastIndexOf("trim");
    if (firstOther !== -1 && firstOther < lastTrim) {
      this.problem(`${what}: trim applies before every other path effect (React Native Skia trims the geometry first)`);
    }
    const paint = this.paint(node.paint, pc, what, /* withEffects */ false);

    // Geometry-level work (trim, pre-applied dashes) needs a Path.
    const needPath = geom?.k === "path" || trims.length > 0 || rest.length > 1;
    let path: Path | null = null;
    if (needPath) {
      path = this.geomPath(geom, what);
      if (!path) return;
      if (trims.length) path = this.trimPath(path, trims, what);
      if (!path) return;
    }
    // CanvasKit cannot compose path effects: everything but the last must
    // be expressible on the geometry.
    for (let i = 0; i < rest.length - 1 && path; i++) {
      const e = rest[i];
      if (e.k === "dash" && Array.isArray(e.intervals) && e.intervals.length === 2) {
        const dashed = path.makeDashed(
          this.num(e.intervals[0], 0, `${what} dash`),
          this.num(e.intervals[1], 0, `${what} dash`),
          this.num(e.phase, 0, `${what} dash phase`)
        );
        if (dashed) path = this.track(dashed);
      } else {
        this.problem(
          `${what}: cannot compose a ${e?.k} path effect with the ones after it (CanvasKit has no PathEffect compose); skipped`
        );
      }
    }
    const last = rest.length ? this.pathEffect(rest[rest.length - 1], what) : null;
    if (last) paint.setPathEffect(last);

    if (path) {
      canvas.drawPath(path, paint);
      return;
    }
    switch (geom?.k) {
      case "rect": {
        const rect = kit.XYWHRect(
          this.num(geom.x, 0, `${what} x`),
          this.num(geom.y, 0, `${what} y`),
          this.num(geom.w, 0, `${what} w`),
          this.num(geom.h, 0, `${what} h`)
        );
        const r = this.num(geom.r, 0, `${what} r`);
        if (r > 0) canvas.drawRRect(kit.RRectXY(rect, r, r), paint);
        else canvas.drawRect(rect, paint);
        return;
      }
      case "circle":
        canvas.drawCircle(
          this.num(geom.cx, 0, `${what} cx`),
          this.num(geom.cy, 0, `${what} cy`),
          this.num(geom.r, 0, `${what} r`),
          paint
        );
        return;
      case "oval":
        canvas.drawOval(
          kit.XYWHRect(
            this.num(geom.x, 0, `${what} x`),
            this.num(geom.y, 0, `${what} y`),
            this.num(geom.w, 0, `${what} w`),
            this.num(geom.h, 0, `${what} h`)
          ),
          paint
        );
        return;
      case "line": {
        const [x1, y1] = this.xy(geom.p1, [0, 0], `${what} p1`);
        const [x2, y2] = this.xy(geom.p2, [0, 0], `${what} p2`);
        canvas.drawLine(x1, y1, x2, y2, paint);
        return;
      }
      case "points": {
        const pts = this.flatPoints(geom.pts, what);
        if (!pts) return;
        const mode =
          geom.mode === "lines" ? kit.PointMode.Lines : geom.mode === "polygon" ? kit.PointMode.Polygon : kit.PointMode.Points;
        canvas.drawPoints(mode, pts, paint);
        return;
      }
      default:
        this.problem(`${what}: unknown geometry kind "${String((geom as { k?: unknown } | undefined)?.k)}"`);
    }
  }

  private flatPoints(b: Bind<number[]> | undefined, what: string): Float32Array | null {
    const v = b?.v;
    if (!Array.isArray(v) || v.length % 2 !== 0 || v.some((x) => typeof x !== "number" || !Number.isFinite(x))) {
      this.problem(`${what}: points must be a flat even-length array of finite numbers`);
      return null;
    }
    return Float32Array.from(v);
  }

  // Any geometry as a Path (tracked), with Skia's PathBuilder defaults for
  // the primitives (clockwise contours; where trim starts depends on them).
  private geomPath(geom: GeomIR, what: string): Path | null {
    const { kit } = this;
    if (!geom || typeof geom !== "object") {
      this.problem(`${what}: missing geometry`);
      return null;
    }
    if (geom.k === "path") {
      const d = geom.d?.v;
      if (typeof d !== "string") {
        this.problem(`${what}: path data is not a string`);
        return null;
      }
      if (!d.trim()) return null; // empty geometry draws nothing
      const p = this.track(kit.Path.MakeFromSVGString(d));
      if (!p) {
        this.problem(`${what}: invalid SVG path data`);
        return null;
      }
      if (geom.fillType) p.setFillType(geom.fillType === "evenOdd" ? kit.FillType.EvenOdd : kit.FillType.Winding);
      return p;
    }
    const b = new kit.PathBuilder();
    switch (geom.k) {
      case "rect": {
        const rect = kit.XYWHRect(
          this.num(geom.x, 0, `${what} x`),
          this.num(geom.y, 0, `${what} y`),
          this.num(geom.w, 0, `${what} w`),
          this.num(geom.h, 0, `${what} h`)
        );
        const r = this.num(geom.r, 0, `${what} r`);
        if (r > 0) b.addRRect(kit.RRectXY(rect, r, r));
        else b.addRect(rect);
        break;
      }
      case "circle":
        b.addCircle(this.num(geom.cx, 0, `${what} cx`), this.num(geom.cy, 0, `${what} cy`), this.num(geom.r, 0, `${what} r`));
        break;
      case "oval":
        b.addOval(
          kit.XYWHRect(
            this.num(geom.x, 0, `${what} x`),
            this.num(geom.y, 0, `${what} y`),
            this.num(geom.w, 0, `${what} w`),
            this.num(geom.h, 0, `${what} h`)
          )
        );
        break;
      case "line": {
        const [x1, y1] = this.xy(geom.p1, [0, 0], `${what} p1`);
        const [x2, y2] = this.xy(geom.p2, [0, 0], `${what} p2`);
        b.moveTo(x1, y1);
        b.lineTo(x2, y2);
        break;
      }
      case "points": {
        const pts = this.flatPoints(geom.pts, what);
        if (pts && pts.length >= 2) b.addPolygon(pts, geom.mode === "polygon");
        break;
      }
      default:
        b.delete();
        this.problem(`${what}: unknown geometry kind "${String((geom as { k?: unknown }).k)}"`);
        return null;
    }
    return this.track(b.detachAndDelete());
  }

  // RN drawPath: start/end = Math.fround(saturate(·)); untouched when the
  // interval is the whole path. Several trims compose by length fraction.
  private trimPath(path: Path, trims: Extract<PathEffectIR, { k: "trim" }>[], what: string): Path | null {
    let s = 0;
    let e = 1;
    for (const t of trims) {
      const ts = clamp01(this.num(t.start, 0, `${what} trim start`));
      const te = clamp01(this.num(t.end, 1, `${what} trim end`));
      const span = e - s;
      [s, e] = [s + ts * span, s + te * span];
    }
    const start = Math.fround(clamp01(s));
    const end = Math.fround(clamp01(e));
    if (start === 0 && end === 1) return path;
    const out = path.makeTrimmed(start, end, false);
    if (!out) {
      this.problem(`${what}: trim failed`);
      return path;
    }
    return this.track(out);
  }

  private drawImage(node: Extract<SkiaNode, { k: "image" }>, pc: PaintCtx): void {
    const what = this.label(node);
    const img = this.imageAsset(node.asset, what);
    if (!img) return;
    const dst = {
      x: this.num(node.x, 0, `${what} x`),
      y: this.num(node.y, 0, `${what} y`),
      width: this.num(node.w, 0, `${what} w`),
      height: this.num(node.h, 0, `${what} h`),
    };
    const { src, dst: d } = fitRects(node.fit, { x: 0, y: 0, width: img.width(), height: img.height() }, dst);
    const { kit } = this;
    this.canvas.drawImageRectOptions(
      img,
      kit.XYWHRect(src.x, src.y, src.width, src.height),
      kit.XYWHRect(d.x, d.y, d.width, d.height),
      kit.FilterMode.Linear,
      kit.MipmapMode.None,
      this.paint(undefined, pc, what)
    );
  }

  // No `width`: one line at (x, y) with y the BASELINE (RN <Text>); `align`
  // anchors the line's advance at x. With `width`: a paragraph laid out to
  // that width, top-left at (x, y), aligned within it (RN <Paragraph>).
  // `anchor` / `lineHeight` / `baselineOffset` / `letterSpacing` (lane T,
  // scene-ir.ts) move and space it; the exporter's makeTextPicture
  // (scene-emit.ts) is this same algorithm as a worklet.
  private drawText(node: Extract<SkiaNode, { k: "text" }>, pc: PaintCtx): void {
    const what = this.label(node);
    const { kit } = this;
    const text = node.text?.v;
    if (typeof text !== "string") {
      this.problem(`${what}: text is not a string`);
      return;
    }
    const bytes = this.asset(node.font?.asset, "font", what);
    if (!bytes) return;
    if (!(bytes instanceof ArrayBuffer || bytes instanceof Uint8Array)) {
      this.problem(`${what}: font asset "${node.font.asset}" must resolve to font bytes`);
      return;
    }
    const size = this.num(node.font.size, 16, `${what} font size`);
    const x = this.num(node.x, 0, `${what} x`);
    const y = this.num(node.y, 0, `${what} y`);
    const paint = this.paint(node.paint, pc, what);
    const anchor = node.anchor;
    if (anchor !== undefined && !(anchor in TEXT_ANCHOR_K)) {
      this.problem(`${what}: unknown anchor "${String(anchor)}"`);
      return;
    }
    const lineHeight = node.lineHeight ? this.num(node.lineHeight, NaN, `${what} lineHeight`) : undefined;
    const offset = node.baselineOffset ? this.num(node.baselineOffset, NaN, `${what} baselineOffset`) : undefined;
    const spacing = node.letterSpacing ? this.num(node.letterSpacing, 0, `${what} letterSpacing`) : 0;
    if (Number.isNaN(lineHeight) || Number.isNaN(offset)) return;
    if (node.width) {
      const width = this.num(node.width, 0, `${what} width`);
      const prov = cachedProvider(kit, bytes);
      if (!prov) {
        this.problem(`${what}: font asset "${node.font.asset}" could not be loaded`);
        return;
      }
      const align =
        node.align === "center" ? kit.TextAlign.Center : node.align === "right" ? kit.TextAlign.Right : kit.TextAlign.Left;
      const bg = this.track(new kit.Paint());
      bg.setColor(kit.TRANSPARENT);
      // One paragraph of `s` in the scene font, painted with the text's paint
      // (color, opacity and the inherited blendMode: RN paints a paragraph
      // with its own foreground paint, which the exporter builds the same).
      const run = (s: string, a: EmbindEnumEntity) => {
        const ts = { fontFamilies: [FONT_FAMILY], fontSize: size, ...(spacing ? { letterSpacing: spacing } : {}) };
        const builder = this.track(kit.ParagraphBuilder.MakeFromFontProvider(new kit.ParagraphStyle({ textStyle: ts, textAlign: a }), prov));
        builder.pushPaintStyle(new kit.TextStyle(ts), paint, bg);
        builder.addText(s);
        return this.track(builder.build());
      };
      const para = run(text, align);
      para.layout(width);
      const lines = para.getLineMetrics();
      if (lineHeight === undefined) {
        // SkParagraph's own pitch, the block anchored as a whole (v1: top).
        const a = anchor ?? "top";
        const top = a === "baseline" ? y - (lines[0]?.baseline ?? 0) : y - TEXT_ANCHOR_K[a] * para.getHeight();
        this.canvas.drawParagraph(para, x, top);
        return;
      }
      // SkParagraph breaks the lines and places each one horizontally; each
      // is drawn as its own run, exactly lineHeight below the one before.
      const asc = lines[0]?.ascent ?? 0;
      const desc = lines[0]?.descent ?? 0;
      const off = offset ?? (lineHeight - (asc + desc)) / 2 + asc;
      const a = anchor ?? "top";
      // The first baseline, computed once (a "baseline" anchor is y itself:
      // glyphs snap to a position grid, so a round trip through the block
      // top could flip a pixel).
      const first = a === "baseline" ? y : y - TEXT_ANCHOR_K[a] * lines.length * lineHeight + off;
      lines.forEach((lm, i) => {
        const s = text.slice(lm.startIndex, lm.endExcludingWhitespaces);
        if (!s) return;
        const line = run(s, kit.TextAlign.Left);
        line.layout(width);
        const own = line.getLineMetrics()[0]?.baseline ?? 0;
        this.canvas.drawParagraph(line, x + lm.left, first + i * lineHeight - own);
      });
      return;
    }
    if (spacing) this.problem(`${what}: letterSpacing needs a width (a paragraph) — a one-line run can't space letters`);
    const tf = cachedTypeface(kit, bytes);
    if (!tf) {
      this.problem(`${what}: font asset "${node.font.asset}" could not be loaded`);
      return;
    }
    const font = this.track(new kit.Font(tf, size));
    let baseline = y;
    if (anchor !== undefined && anchor !== "baseline") {
      // The line box: lineHeight (default ascent + descent) tall, y at its
      // top / middle / bottom, the baseline baselineOffset into it.
      const m = font.getMetrics();
      const asc = -m.ascent;
      const desc = m.descent;
      const lh = lineHeight ?? asc + desc;
      baseline = y - TEXT_ANCHOR_K[anchor] * lh + (offset ?? (lh - (asc + desc)) / 2 + asc);
    }
    let dx = 0;
    if (node.align === "center" || node.align === "right") {
      const adv = font.getGlyphWidths(font.getGlyphIDs(text)).reduce((a, b) => a + b, 0);
      dx = node.align === "center" ? -adv / 2 : -adv;
    }
    this.canvas.drawText(text, x + dx, baseline, paint, font);
  }

  // Sprites are [x, y, w, h] in sheet px; xforms are RSXforms (scos, ssin,
  // tx, ty), one per sprite, mapping a sprite's local px (from its rect's
  // top-left) to scene px. The sheet is an image asset, or a sub-scene
  // rasterised offscreen over `texture.rect` (RN useTexture) at the
  // surface's scale k — then sprite rects × k and xform scales ÷ k, so the
  // sheet is crisp at device resolution. pivots / rotate / scale
  // post-compose a uniform spin / zoom about each sprite's pivot
  // (composeAtlasXforms). Sampling is linear without mipmaps: RN's
  // drawAtlas default on web (JsiSkCanvas.ts) and native (JsiSkCanvas.h).
  private drawAtlas(node: Extract<SkiaNode, { k: "atlas" }>, pc: PaintCtx, depth: number): void {
    const what = this.label(node);
    const sprites = Array.isArray(node.sprites) ? node.sprites : [];
    const xf = node.xforms?.v;
    if (!Array.isArray(xf) || xf.length !== sprites.length * 4 || xf.some((v) => !Number.isFinite(v))) {
      this.problem(`${what}: xforms must hold 4 finite numbers per sprite (${sprites.length} sprites)`);
      return;
    }
    let pivots: number[] | undefined;
    if (node.rotate || node.scale) {
      const pv = node.pivots?.v;
      if (!Array.isArray(pv) || pv.length !== sprites.length * 2 || pv.some((v) => !Number.isFinite(v))) {
        this.problem(`${what}: rotate / scale need 2 finite pivot numbers per sprite (${sprites.length} sprites)`);
        return;
      }
      pivots = pv;
    }
    const rotate = node.rotate ? this.num(node.rotate, 0, `${what} rotate`) : undefined;
    const scale = node.scale ? this.num(node.scale, 1, `${what} scale`) : undefined;
    let img: Image | null;
    let k = 1;
    if (node.texture) {
      const t = this.atlasTexture(node, depth);
      if (!t) return;
      img = t.image;
      k = t.k;
    } else {
      img = this.imageAsset(node.asset, what);
    }
    if (!img) return;
    const rects = new Float32Array(sprites.length * 4);
    sprites.forEach((s, i) => {
      rects.set([s[0] * k, s[1] * k, (s[0] + s[2]) * k, (s[1] + s[3]) * k], i * 4);
    });
    const out = composeAtlasXforms(xf, { pivots, rotate, scale, k });
    this.canvas.drawAtlas(img, rects, Float32Array.from(out), this.paint(undefined, pc, what));
  }

  // The sub-scene sprite sheet: rendered into an offscreen surface of the
  // parent canvas's kind (GPU on the editor's WebGL surface, raster on a
  // CPU surface) at k = surface px per scene px, then snapshotted. With a
  // caller-owned `textureCache` it renders once per distinct sub-scene —
  // what RN's useTexture does — unless something in it is still loading.
  private atlasTexture(node: Extract<SkiaNode, { k: "atlas" }>, depth: number): { image: Image; k: number } | null {
    const what = this.label(node);
    const t = node.texture!;
    const r = t.rect;
    if (!Array.isArray(r) || r.length !== 4 || r.some((v) => !Number.isFinite(v)) || r[2] <= 0 || r[3] <= 0) {
      this.problem(`${what}: texture.rect must be 4 finite numbers with a positive size`);
      return null;
    }
    const k0 = this.size[0] / (this.scene.width || 1);
    const k = Number.isFinite(k0) && k0 > 0 ? k0 : 1;
    const tw = Math.max(1, Math.ceil(r[2] * k));
    const th = Math.max(1, Math.ceil(r[3] * k));
    if (tw > ATLAS_TEXTURE_MAX || th > ATLAS_TEXTURE_MAX) {
      this.problem(`${what}: the sprite sheet would be ${tw}×${th} px — over ${ATLAS_TEXTURE_MAX} px on a side`);
      return null;
    }
    const cache = this.opts.textureCache;
    const key = cache ? JSON.stringify([tw, th, k, r, t.node]) : "";
    const hit = cache?.get(key);
    if (hit && !(hit as Partial<EmbindObject<string>>).isDeleted?.()) return { image: hit, k };
    const { kit } = this;
    const surf = this.track(
      this.canvas.makeSurface({
        width: tw,
        height: th,
        colorType: kit.ColorType.RGBA_8888,
        alphaType: kit.AlphaType.Premul,
        colorSpace: kit.ColorSpace.SRGB,
      })
    );
    if (!surf) {
      this.problem(`${what}: could not allocate the ${tw}×${th} sprite sheet`);
      return null;
    }
    const c = surf.getCanvas();
    c.clear(kit.TRANSPARENT);
    c.scale(k, k);
    c.translate(-r[0], -r[1]);
    const parent = this.canvas;
    const pendingBefore = this.pending.size;
    const problemsBefore = this.problems.size;
    this.canvas = c;
    try {
      this.drawNode(t.node, { opacity: 1 }, depth + 1);
    } finally {
      this.canvas = parent;
    }
    const image = surf.makeImageSnapshot();
    if (cache && this.pending.size === pendingBefore && this.problems.size === problemsBefore) {
      cache.set(key, image);
      // A small LRU: the oldest sheet goes once the cache outgrows its cap.
      while (cache.size > ATLAS_TEXTURE_CACHE) {
        const oldest = cache.keys().next().value as string;
        const img = cache.get(oldest);
        cache.delete(oldest);
        try {
          img?.delete();
        } catch {
          /* already gone */
        }
      }
    } else {
      this.track(image);
    }
    return { image, k };
  }

  // ---- paint ----

  private paint(ir: PaintIR | undefined, pc: PaintCtx, what: string, withEffects = true): Paint {
    const { kit } = this;
    const p = this.track(new kit.Paint());
    p.setAntiAlias(ir?.antiAlias ?? true);
    if (ir?.style === "stroke") p.setStyle(kit.PaintStyle.Stroke);
    else if (ir && ir.style !== "fill") this.problem(`${what}: unknown paint style "${String(ir.style)}"`);
    const color = this.color(ir?.color, `${what} color`);
    p.setColor(color);
    if (ir?.shader) {
      const s = this.shader(ir.shader, `${what} shader`, 0);
      if (s) p.setShader(s);
    }
    p.setBlendMode(this.blend(ir?.blendMode ?? pc.blendMode, what));
    if (ir?.strokeWidth) p.setStrokeWidth(Math.max(0, this.num(ir.strokeWidth, 0, `${what} strokeWidth`)));
    if (ir?.strokeCap) {
      p.setStrokeCap(
        ir.strokeCap === "round" ? kit.StrokeCap.Round : ir.strokeCap === "square" ? kit.StrokeCap.Square : kit.StrokeCap.Butt
      );
    }
    if (ir?.strokeJoin) {
      p.setStrokeJoin(
        ir.strokeJoin === "round" ? kit.StrokeJoin.Round : ir.strokeJoin === "bevel" ? kit.StrokeJoin.Bevel : kit.StrokeJoin.Miter
      );
    }
    if (ir?.strokeMiter !== undefined) p.setStrokeMiter(ir.strokeMiter);
    if (ir?.maskFilter) {
      const mf = ir.maskFilter;
      if (mf.k !== "blur") this.problem(`${what}: unknown mask filter "${String(mf.k)}"`);
      else {
        const style =
          mf.style === "solid"
            ? kit.BlurStyle.Solid
            : mf.style === "outer"
              ? kit.BlurStyle.Outer
              : mf.style === "inner"
                ? kit.BlurStyle.Inner
                : kit.BlurStyle.Normal;
        const sigma = this.num(mf.sigma, 0, `${what} mask blur`);
        if (sigma > 0) p.setMaskFilter(this.track(kit.MaskFilter.MakeBlur(style, sigma, true)));
      }
    }
    const cf = this.composeColorFilters(ir?.colorFilters ?? [], what);
    if (cf) p.setColorFilter(cf);
    if (withEffects && ir?.pathEffects?.length) {
      // Only shapes use path effects (drawShape handles trim + composition);
      // Skia ignores them for fills, images and text.
      const pe = this.pathEffect(ir.pathEffects[ir.pathEffects.length - 1], what);
      if (pe) p.setPathEffect(pe);
    }
    // RN: paint alpha × the clamped opacity product (setOpacity + Player).
    const opacity = clamp01(pc.opacity * this.num(ir?.opacity, 1, `${what} opacity`));
    p.setAlphaf(color[3] * opacity);
    return p;
  }

  private pathEffect(e: PathEffectIR, what: string): PathEffect | null {
    const { kit } = this;
    switch (e?.k) {
      case "dash": {
        const iv = Array.isArray(e.intervals) ? e.intervals.map((b, i) => this.num(b, 0, `${what} dash[${i}]`)) : [];
        if (iv.length < 2 || iv.length % 2 !== 0) {
          this.problem(`${what}: dash needs an even number (≥ 2) of intervals`);
          return null;
        }
        return this.track(kit.PathEffect.MakeDash(iv, this.num(e.phase, 0, `${what} dash phase`)));
      }
      case "corner": {
        const r = this.num(e.r, 0, `${what} corner r`);
        return r > 0 ? this.track(kit.PathEffect.MakeCorner(r)) : null;
      }
      case "discrete":
        return this.track(
          kit.PathEffect.MakeDiscrete(
            this.num(e.length, 1, `${what} discrete length`),
            this.num(e.deviation, 0, `${what} discrete deviation`),
            Number.isFinite(e.seed) ? e.seed : 0
          )
        );
      case "trim":
        return null; // geometry-level, see drawShape
      default:
        this.problem(`${what}: unknown path effect "${String((e as { k?: unknown } | undefined)?.k)}"`);
        return null;
    }
  }

  // ---- shaders ----

  private stops(stops: GradientStopIR[] | undefined, what: string): { colors: Float32Array[]; pos: number[] } | null {
    if (!Array.isArray(stops) || stops.length < 1) {
      this.problem(`${what}: a gradient needs at least one stop`);
      return null;
    }
    return {
      colors: stops.map((s, i) => this.color(s?.color, `${what} stop ${i} color`)),
      pos: stops.map((s, i) => this.num(s?.pos, i / Math.max(1, stops.length - 1), `${what} stop ${i} pos`)),
    };
  }

  // A gradient as the color-managed program the exporter ships
  // (library/gradient-program.ts): its values checked and sanitized the way
  // the native path reads them, then bound statically — the preview draws
  // the current tick.
  private gradient(ir: GradientShaderIR, what: string, depth: number): Shader | null {
    const st = this.stops(ir.stops, what);
    if (!st) return null;
    const b = <T,>(v: T) => bindStatic(v);
    const xy = (v: BindXY | undefined, name: string): BindXY => {
      const [x, y] = this.xy(v, [0, 0], `${what} ${name}`);
      return [b(x), b(y)];
    };
    const stops = st.colors.map((c, i) => ({ pos: b(st.pos[i]), color: b([c[0], c[1], c[2], c[3]] as RGBA) }));
    const tile = (t: TileMode | undefined) => {
      this.tile(t, "clamp", what); // reports an unknown mode
      return t === "repeat" || t === "mirror" || t === "decal" ? t : undefined;
    };
    let clean: GradientShaderIR;
    switch (ir.k) {
      case "linear":
        clean = { k: "linear", start: xy(ir.start, "start"), end: xy(ir.end, "end"), stops, tile: tile(ir.tile) };
        break;
      case "radial":
        clean = { k: "radial", c: xy(ir.c, "c"), r: b(this.num(ir.r, 0, `${what} r`)), stops, tile: tile(ir.tile) };
        break;
      case "sweep":
        clean = { k: "sweep", c: xy(ir.c, "c"), start: b(this.num(ir.start, 0, `${what} start`)), end: b(this.num(ir.end, 2 * Math.PI, `${what} end`)), stops };
        break;
      default:
        clean = {
          k: "conical",
          c0: xy(ir.c0, "c0"),
          r0: b(this.num(ir.r0, 0, `${what} r0`)),
          c1: xy(ir.c1, "c1"),
          r1: b(this.num(ir.r1, 0, `${what} r1`)),
          stops,
          tile: tile(ir.tile),
        };
    }
    return this.program(gradientProgram(clean), what, depth);
  }

  private shader(ir: ShaderIR, what: string, depth: number): Shader | null {
    const { kit } = this;
    if (depth > MAX_DEPTH) {
      this.problem(`${what}: shader tree deeper than ${MAX_DEPTH} — cycle?`);
      return null;
    }
    if (isGradientShader(ir) && !this.opts.nativeGradients) return this.gradient(ir, what, depth);
    switch (ir?.k) {
      case "color":
        return this.track(kit.Shader.MakeColor(this.color(ir.color, `${what} color`), kit.ColorSpace.SRGB));
      case "linear": {
        const st = this.stops(ir.stops, what);
        if (!st) return null;
        return this.track(
          kit.Shader.MakeLinearGradient(
            this.xy(ir.start, [0, 0], `${what} start`),
            this.xy(ir.end, [0, 0], `${what} end`),
            st.colors,
            st.pos,
            this.tile(ir.tile, "clamp", what)
          )
        );
      }
      case "radial": {
        const st = this.stops(ir.stops, what);
        if (!st) return null;
        return this.track(
          kit.Shader.MakeRadialGradient(
            this.xy(ir.c, [0, 0], `${what} c`),
            this.num(ir.r, 0, `${what} r`),
            st.colors,
            st.pos,
            this.tile(ir.tile, "clamp", what)
          )
        );
      }
      case "sweep": {
        const st = this.stops(ir.stops, what);
        if (!st) return null;
        const [cx, cy] = this.xy(ir.c, [0, 0], `${what} c`);
        const deg = 180 / Math.PI;
        return this.track(
          kit.Shader.MakeSweepGradient(
            cx,
            cy,
            st.colors,
            st.pos,
            kit.TileMode.Clamp,
            null,
            0,
            this.num(ir.start, 0, `${what} start`) * deg,
            this.num(ir.end, 2 * Math.PI, `${what} end`) * deg
          )
        );
      }
      case "conical": {
        const st = this.stops(ir.stops, what);
        if (!st) return null;
        return this.track(
          kit.Shader.MakeTwoPointConicalGradient(
            this.xy(ir.c0, [0, 0], `${what} c0`),
            this.num(ir.r0, 0, `${what} r0`),
            this.xy(ir.c1, [0, 0], `${what} c1`),
            this.num(ir.r1, 0, `${what} r1`),
            st.colors,
            st.pos,
            this.tile(ir.tile, "clamp", what)
          )
        );
      }
      case "image": {
        const img = this.imageAsset(ir.asset, what);
        if (!img) return null;
        const rect = Array.isArray(ir.rect) ? ir.rect : [];
        const dst = {
          x: this.num(rect[0], 0, `${what} x`),
          y: this.num(rect[1], 0, `${what} y`),
          width: this.num(rect[2], img.width(), `${what} w`),
          height: this.num(rect[3], img.height(), `${what} h`),
        };
        // RN ImageShader: local matrix = translate · scale from fitRects.
        const { src, dst: d } = fitRects(ir.fit, { x: 0, y: 0, width: img.width(), height: img.height() }, dst);
        const sx = src.width > 0 ? d.width / src.width : 0;
        const sy = src.height > 0 ? d.height / src.height : 0;
        const lm = [sx, 0, d.x - src.x * sx, 0, sy, d.y - src.y * sy, 0, 0, 1];
        const tm = this.tile(ir.tile, "decal", what);
        return this.track(img.makeShaderOptions(tm, tm, kit.FilterMode.Linear, kit.MipmapMode.None, lm));
      }
      case "runtime":
        return this.program(ir.program, what, depth);
      default:
        this.problem(`${what}: unknown shader kind "${String((ir as { k?: unknown } | undefined)?.k)}"`);
        return null;
    }
  }

  // A runtime program as a shader. `content` (runtime image filters only)
  // supplies the named child that receives the rendered layer;
  // `localMatrix` maps the coordinates main() receives.
  private program(
    prog: SkslProgramIR,
    what: string,
    depth: number,
    content?: { name: string; shader: Shader },
    localMatrix?: number[]
  ): Shader | null {
    const { kit } = this;
    if (!prog || typeof prog.sksl !== "string") {
      this.problem(`${what}: runtime program has no SkSL source`);
      return null;
    }
    const compiled = compileSksl(kit, prog.sksl);
    if (!compiled.effect) {
      this.problem(`${what}: SkSL compile failed: ${compiled.error.split("\n").filter((l) => l.trim())[0] ?? compiled.error}`);
      return null;
    }
    const effect = compiled.effect;
    const values: SkslUniformValues = {};
    const binds = prog.uniforms ?? {};
    for (let i = 0; i < effect.getUniformCount(); i++) {
      const name = effect.getUniformName(i);
      const b = binds[name];
      if (!b) {
        this.problem(`${what}: uniform "${name}" has no value (React Native Skia throws on a missing uniform)`);
        continue;
      }
      const v = b.v;
      const ok = typeof v === "number" ? Number.isFinite(v) : Array.isArray(v) && v.every((x) => Number.isFinite(x));
      if (!ok) {
        this.problem(`${what}: uniform "${name}" is not finite`);
        continue;
      }
      values[name] = v;
    }
    const uniforms = packUniforms(effect, values);

    // Children bind by NAME in declaration order, whatever order the IR
    // lists them in.
    const kids = Array.isArray(prog.children) ? prog.children : [];
    const names = declaredChildren(prog.sksl);
    for (const k of kids) {
      if (k && !names.includes(k.name)) this.problem(`${what}: child "${k?.name}" is not declared by the program`);
    }
    const children: Shader[] = names.map((name) => {
      if (content && name === content.name) return content.shader;
      const child = kids.find((c) => c?.name === name);
      const s = child ? this.shader(child.shader, `${what} child "${name}"`, depth + 1) : null;
      if (!child) this.problem(`${what}: child shader "${name}" is not supplied`);
      return s ?? this.track(kit.Shader.MakeColor(kit.TRANSPARENT, kit.ColorSpace.SRGB));
    });
    if (content && !names.includes(content.name)) {
      this.problem(`${what}: the program declares no \`uniform shader ${content.name};\` to receive the layer`);
    }
    const shader = children.length
      ? effect.makeShaderWithChildren(uniforms, children, localMatrix)
      : effect.makeShader(uniforms, localMatrix);
    if (!shader) this.problem(`${what}: CanvasKit could not instantiate the program`);
    return this.track(shader);
  }

  // ---- filters ----

  private composeImageFilters(list: ImageFilterIR[], what: string): ImageFilter | null {
    let acc: ImageFilter | null = null;
    for (const f of Array.isArray(list) ? list : []) {
      const one = this.imageFilter(f, what);
      if (!one) continue;
      acc = acc ? this.track(this.kit.ImageFilter.MakeCompose(one, acc)) : one;
    }
    return acc;
  }

  private imageFilter(f: ImageFilterIR, what: string): ImageFilter | null {
    const { kit } = this;
    switch (f?.k) {
      case "blur":
        return this.track(
          kit.ImageFilter.MakeBlur(
            Math.max(0, this.num(f.sx, 0, `${what} blur sx`)),
            Math.max(0, this.num(f.sy, 0, `${what} blur sy`)),
            this.tile(f.tile, "decal", what),
            null
          )
        );
      case "offset":
        return this.track(kit.ImageFilter.MakeOffset(this.num(f.dx, 0, `${what} offset dx`), this.num(f.dy, 0, `${what} offset dy`), null));
      case "morphology": {
        const r = Math.max(0, this.num(f.r, 0, `${what} morphology r`));
        return this.track(f.op === "erode" ? kit.ImageFilter.MakeErode(r, r, null) : kit.ImageFilter.MakeDilate(r, r, null));
      }
      case "shadow": {
        const dx = this.num(f.dx, 0, `${what} shadow dx`);
        const dy = this.num(f.dy, 0, `${what} shadow dy`);
        const sigma = Math.max(0, this.num(f.blur, 0, `${what} shadow blur`));
        const color = this.color(f.color, `${what} shadow color`);
        if (f.inner) return this.innerShadow(!!f.shadowOnly, dx, dy, sigma, color);
        return this.track(
          f.shadowOnly
            ? kit.ImageFilter.MakeDropShadowOnly(dx, dy, sigma, sigma, color, null)
            : kit.ImageFilter.MakeDropShadow(dx, dy, sigma, sigma, color, null)
        );
      }
      case "displacement": {
        const map = this.shader(f.map, `${what} displacement map`, 0);
        if (!map) return null;
        const ch = (c: string) =>
          c === "g" ? kit.ColorChannel.Green : c === "b" ? kit.ColorChannel.Blue : c === "a" ? kit.ColorChannel.Alpha : kit.ColorChannel.Red;
        return this.track(
          kit.ImageFilter.MakeDisplacementMap(
            ch(f.channelX),
            ch(f.channelY),
            this.num(f.scale, 0, `${what} displacement scale`),
            this.track(kit.ImageFilter.MakeShader(map)),
            null
          )
        );
      }
      case "runtime":
        // Only reachable outside a layer chain (handled by drawEmulatedLayer).
        this.problem(`${what}: runtime image filters run only in a group layer`);
        return null;
      default:
        this.problem(`${what}: unknown image filter "${String((f as { k?: unknown } | undefined)?.k)}"`);
        return null;
    }
  }

  private innerShadow(shadowOnly: boolean, dx: number, dy: number, sigma: number, color: Float32Array): ImageFilter {
    const { kit } = this;
    const IF = kit.ImageFilter;
    const black = kit.Color4f(0, 0, 0, 1);
    const t = <T extends Deletable>(o: T) => this.track(o);
    const sourceGraphic = t(IF.MakeColorFilter(t(kit.ColorFilter.MakeBlend(black, kit.BlendMode.Dst)), null));
    const sourceAlpha = t(IF.MakeColorFilter(t(kit.ColorFilter.MakeBlend(black, kit.BlendMode.SrcIn)), null));
    const coverage = t(IF.MakeColorFilter(t(kit.ColorFilter.MakeMatrix(ALPHA_SATURATE)), null));
    const f1 = t(IF.MakeColorFilter(t(kit.ColorFilter.MakeBlend(color, kit.BlendMode.SrcOut)), coverage));
    const f2 = t(IF.MakeOffset(dx, dy, f1));
    const f3 = t(IF.MakeBlur(sigma, sigma, kit.TileMode.Decal, f2));
    const f4 = t(IF.MakeBlend(kit.BlendMode.SrcIn, sourceAlpha, f3));
    if (shadowOnly) return f4;
    return t(IF.MakeCompose(null, t(IF.MakeBlend(kit.BlendMode.SrcOver, sourceGraphic, f4))));
  }

  private composeColorFilters(list: ColorFilterIR[], what: string): ColorFilter | null {
    let acc: ColorFilter | null = null;
    for (const f of Array.isArray(list) ? list : []) {
      const one = this.colorFilter(f, what, 0);
      if (!one) continue;
      acc = acc ? this.track(this.kit.ColorFilter.MakeCompose(one, acc)) : one;
    }
    return acc;
  }

  private colorFilter(f: ColorFilterIR, what: string, depth: number): ColorFilter | null {
    const { kit } = this;
    if (depth > MAX_DEPTH) {
      this.problem(`${what}: color filter tree deeper than ${MAX_DEPTH}`);
      return null;
    }
    switch (f?.k) {
      case "matrix": {
        const m = f.m?.v;
        if (!Array.isArray(m) || m.length !== 20 || m.some((x) => !Number.isFinite(x))) {
          this.problem(`${what}: color matrix must be 20 finite numbers (4×5 row-major)`);
          return null;
        }
        return this.track(kit.ColorFilter.MakeMatrix(m));
      }
      case "blend":
        return this.track(kit.ColorFilter.MakeBlend(this.color(f.color, `${what} blend color`), this.blend(f.mode, what)));
      case "lerp": {
        const a = this.colorFilter(f.a, what, depth + 1);
        const b = this.colorFilter(f.b, what, depth + 1);
        if (!a || !b) return a ?? b;
        // CanvasKit MakeLerp(t, dst, src): t = 0 → a, t = 1 → b (RN Lerp's
        // first child is dst).
        return this.track(kit.ColorFilter.MakeLerp(clamp01(this.num(f.t, 0, `${what} lerp t`)), a, b));
      }
      case "luma":
        return this.track(kit.ColorFilter.MakeLuma());
      case "linearToSrgb":
        return this.track(kit.ColorFilter.MakeLinearToSRGBGamma());
      case "srgbToLinear":
        return this.track(kit.ColorFilter.MakeSRGBToLinearGamma());
      default:
        this.problem(`${what}: unknown color filter "${String((f as { k?: unknown } | undefined)?.k)}"`);
        return null;
    }
  }
}
