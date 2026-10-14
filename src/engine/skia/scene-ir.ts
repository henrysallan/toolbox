// Skia scene IR — the data every Skia-layer node produces and both consumers
// read (specdocs/101326_skia-target.md §3.4):
//   preview  engine/skia/scene-render.ts   CanvasKit draws it at the current tick
//   export   lib/skia-export/scene-*.ts    React Native Skia JSX + timeline
// One description, two renderers: that is the parity guarantee.
//
// FROZEN 2026-10-13 for the Wave 1 lanes. Additive changes only (a new
// optional field, a new union member) without the owner's sign-off; bump
// SKIA_IR_VERSION on anything breaking.
//
// Space: the toolbox composition's canvas PIXELS (SkiaScene.width × height),
// Y-DOWN, origin top-left — Skia's own convention. The exporter scales the
// root group to the React Native canvas size. Angles are radians. Colors are
// straight-alpha sRGB in 0..1 (the owner's color policy, §5.5: sRGB colors
// on any canvas; programs convert to a Display P3 canvas themselves).
//
// The SDF socket is the precedent: nodes return small data trees and do no
// GL work; one terminal (Skia Canvas) renders the tree.
//
// Semantics both consumers implement (scene-render.ts draws them, the
// exporter maps them to React Native Skia — recorded 2026-10-13 from
// lanes L1 / L3):
//   - imageFilters / colorFilters / pathEffects apply in ARRAY order
//     (index 0 first); RN composes siblings last-first, so the emitter
//     reverses or nests them.
//   - Group transform = T(origin)·T(translate)·R·S·skewX·skewY·T(−origin);
//     skew values are angles (RN applies tan); `matrix` is 9 row-major
//     numbers.
//   - Group opacity / blendMode are per-draw props, not a layer; `layer`
//     is a saveLayer outside the group's own transform/clip/opacity, image
//     filters before its color filters. Clips are local and anti-aliased.
//   - A paint's shader replaces its color's RGB; the color's alpha still
//     scales. Default paint: opaque black, antiAlias on.
//   - `trim` applies to the geometry first wherever it sits in pathEffects.
//   - Blur / shadow / mask sizes are sigmas. Sweep start/end are radians
//     (RN takes degrees — the emitter converts).
//   - Image shaders default to decal tiling, gradients to clamp.
//   - A runtime ImageFilter's `content` must be its only child shader.

export const SKIA_IR_VERSION = 1;

// ---- binding ------------------------------------------------------------------
//
// Producers never resolve animation themselves. They evaluate at the current
// tick (`v` — what the preview draws) and TAG the value with where it came
// from; the exporter reads the graph to turn a ref into a static value, a
// timeline track (following wires to Animated Value / Color drivers, as
// planSkiaExport does in M0) or a refusal with a reason.

export interface BindRef {
  // Flattened engine node id (the id the evaluator sees).
  node: string;
  // Param name, or "ch:<name>" for an expression channel.
  param: string;
  // When the bind is one component of a vector / color param.
  component?: number;
  // The IR value is the param value × scale (degrees param → radians IR:
  // Math.PI / 180). Tracks export scaled. Additive (2026-10-13, lane L1).
  scale?: number;
}

export interface Bind<T> {
  v: T;
  // A value read straight from one param (wired or keyframed or static).
  ref?: BindRef;
  // A value DERIVED from several params (a generator's path, a composed
  // matrix). If any dep animates, the exporter samples the producer per
  // frame instead of shipping a track (spec §3.4 "derived binds").
  deps?: BindRef[];
}

export type RGBA = [number, number, number, number];
export type BindXY = [Bind<number>, Bind<number>];

// React Native Skia's blendMode strings, verbatim.
export type BlendMode =
  | "clear" | "src" | "dst" | "srcOver" | "dstOver" | "srcIn" | "dstIn"
  | "srcOut" | "dstOut" | "srcATop" | "dstATop" | "xor" | "plus" | "modulate"
  | "screen" | "overlay" | "darken" | "lighten" | "colorDodge" | "colorBurn"
  | "hardLight" | "softLight" | "difference" | "exclusion" | "multiply"
  | "hue" | "saturation" | "color" | "luminosity";

export type TileMode = "clamp" | "repeat" | "mirror" | "decal";

// ---- transforms -----------------------------------------------------------------

// Applied as React Native Skia applies a Group transform about `origin`:
// translate, then rotate, then scale, then skew. A producer that only has a
// matrix sets `matrix` (3×3 row-major) and nothing else.
export interface TransformIR {
  translate?: BindXY;
  rotate?: Bind<number>;
  scale?: BindXY;
  skew?: BindXY;
  origin?: BindXY;
  matrix?: Bind<number[]>;
}

// ---- geometry -------------------------------------------------------------------

export type GeomIR =
  | { k: "rect"; x: Bind<number>; y: Bind<number>; w: Bind<number>; h: Bind<number>; r?: Bind<number> }
  | { k: "circle"; cx: Bind<number>; cy: Bind<number>; r: Bind<number> }
  | { k: "oval"; x: Bind<number>; y: Bind<number>; w: Bind<number>; h: Bind<number> }
  | { k: "line"; p1: BindXY; p2: BindXY }
  // SVG path data in canvas px. Generator nodes (star, spiral, spline-draw…)
  // emit this with `deps` on their params.
  | { k: "path"; d: Bind<string>; fillType?: "winding" | "evenOdd" }
  // Flat x,y pairs in canvas px.
  | { k: "points"; pts: Bind<number[]>; mode: "points" | "lines" | "polygon" };

// ---- paint / shaders / filters ------------------------------------------------------

export interface GradientStopIR {
  pos: Bind<number>;
  color: Bind<RGBA>;
}

// A complete Skia runtime effect plus everything needed to run it.
export interface SkslProgramIR {
  sksl: string;
  // Every uniform the program declares, by name (iResolution / iTime too).
  uniforms: Record<string, Bind<number | number[]>>;
  // In `uniform shader` declaration order.
  children: { name: string; shader: ShaderIR }[];
  // Library functions fused into this program (manifest / cost readout).
  fused?: string[];
}

// Note: Skia gradients interpolate in sRGB. A toolbox ramp in OKLab / linear
// must lower to a runtime program, not to these.
export type ShaderIR =
  | { k: "runtime"; program: SkslProgramIR }
  | { k: "linear"; start: BindXY; end: BindXY; stops: GradientStopIR[]; tile?: TileMode }
  | { k: "radial"; c: BindXY; r: Bind<number>; stops: GradientStopIR[]; tile?: TileMode }
  | { k: "sweep"; c: BindXY; start?: Bind<number>; end?: Bind<number>; stops: GradientStopIR[] }
  | { k: "conical"; c0: BindXY; r0: Bind<number>; c1: BindXY; r1: Bind<number>; stops: GradientStopIR[]; tile?: TileMode }
  | { k: "image"; asset: string; fit: "fill" | "contain" | "cover" | "none"; rect: [Bind<number>, Bind<number>, Bind<number>, Bind<number>]; tile?: TileMode }
  | { k: "color"; color: Bind<RGBA> };

export type ColorFilterIR =
  | { k: "matrix"; m: Bind<number[]> } // 20 floats, Skia/RN row-major 4×5
  | { k: "blend"; color: Bind<RGBA>; mode: BlendMode }
  | { k: "lerp"; t: Bind<number>; a: ColorFilterIR; b: ColorFilterIR }
  | { k: "luma" }
  | { k: "linearToSrgb" }
  | { k: "srgbToLinear" };

export type ImageFilterIR =
  | { k: "blur"; sx: Bind<number>; sy: Bind<number>; tile?: TileMode }
  | { k: "shadow"; dx: Bind<number>; dy: Bind<number>; blur: Bind<number>; color: Bind<RGBA>; inner?: boolean; shadowOnly?: boolean }
  | { k: "offset"; dx: Bind<number>; dy: Bind<number> }
  | { k: "morphology"; op: "dilate" | "erode"; r: Bind<number> }
  | { k: "displacement"; channelX: "r" | "g" | "b" | "a"; channelY: "r" | "g" | "b" | "a"; scale: Bind<number>; map: ShaderIR }
  // An SkSL program over the rendered content, which it reads through the
  // child named `content` (RN Skia <RuntimeShader>). Color management
  // applies as to every program (engine/skia/library/color-management.ts):
  // the `content` sample is in the canvas's working space — read it through
  // tbx_cm_child / tbx_cm_premul_in (helper `tbx.color.cm`) — and the
  // result goes back through tbx_cm_out / tbx_cm_premul_out, so the math in
  // between is sRGB on a Display P3 canvas too.
  | { k: "runtime"; program: SkslProgramIR; content: string };

export type PathEffectIR =
  | { k: "dash"; intervals: Bind<number>[]; phase: Bind<number> }
  | { k: "corner"; r: Bind<number> }
  | { k: "discrete"; length: Bind<number>; deviation: Bind<number>; seed: number }
  // Trim to [start, end] of the path's length, 0..1 (RN <Path start end>).
  | { k: "trim"; start: Bind<number>; end: Bind<number> };

export interface PaintIR {
  style: "fill" | "stroke";
  color?: Bind<RGBA>;
  shader?: ShaderIR;
  opacity?: Bind<number>;
  strokeWidth?: Bind<number>;
  strokeCap?: "butt" | "round" | "square";
  strokeJoin?: "miter" | "round" | "bevel";
  strokeMiter?: number;
  blendMode?: BlendMode;
  antiAlias?: boolean;
  maskFilter?: { k: "blur"; sigma: Bind<number>; style: "normal" | "solid" | "outer" | "inner" };
  colorFilters?: ColorFilterIR[];
  pathEffects?: PathEffectIR[];
}

// ---- drawing ---------------------------------------------------------------------------

// `id` on every node is the producing engine node — error messages, the
// manifest, and the editor's "which node made this" all key on it.
export type SkiaNode =
  | {
      k: "group";
      id?: string;
      transform?: TransformIR;
      opacity?: Bind<number>;
      blendMode?: BlendMode;
      clip?: { geom: GeomIR; invert?: boolean };
      // Rendered to an offscreen layer, then filtered (RN Group `layer`).
      layer?: { imageFilters?: ImageFilterIR[]; colorFilters?: ColorFilterIR[] };
      children: SkiaNode[];
    }
  | { k: "fill"; id?: string; paint: PaintIR }
  | { k: "shape"; id?: string; geom: GeomIR; paint: PaintIR }
  | {
      k: "image";
      id?: string;
      asset: string;
      x: Bind<number>;
      y: Bind<number>;
      w: Bind<number>;
      h: Bind<number>;
      fit: "fill" | "contain" | "cover" | "none";
    }
  | {
      k: "text";
      id?: string;
      text: Bind<string>;
      // Fonts ship as assets; system fonts are a parity hazard (spec §4).
      font: { asset: string; size: Bind<number> };
      // No `width`: one line, y = the BASELINE, `align` anchors the line's
      // advance at x (RN <Text>). With `width`: a paragraph wrapped to that
      // width, top-left at (x, y), aligned within it (RN <Paragraph>).
      x: Bind<number>;
      y: Bind<number>;
      width?: Bind<number>;
      align?: "left" | "center" | "right";
      paint: PaintIR;
    }
  | {
      k: "atlas";
      id?: string;
      asset: string;
      sprites: [number, number, number, number][];
      // 4 floats per sprite: scos, ssin, tx, ty (RSXform).
      xforms: Bind<number[]>;
    };

// ---- scene + assets ------------------------------------------------------------------------

export interface AssetIR {
  id: string;
  kind: "image" | "font" | "svg";
  mime: string;
  // Where the bytes live in the editor (a project media URL / data URL);
  // the exporter copies them into the bundle's assets/.
  url: string;
  width?: number;
  height?: number;
  // The licence text that must ship beside the bytes (a font's OFL file),
  // by URL like `url`; the exporter writes it next to the asset. Additive
  // (2026-10-14, Wave 3 lane I).
  license?: string;
}

export interface SkiaScene {
  version: typeof SKIA_IR_VERSION;
  width: number;
  height: number;
  // Undefined = transparent.
  background?: RGBA;
  root: SkiaNode;
  assets: Record<string, AssetIR>;
}

// ---- helpers --------------------------------------------------------------------------------

export function bindStatic<T>(v: T): Bind<T> {
  return { v };
}

export function bindParam<T>(v: T, node: string, param: string, component?: number): Bind<T> {
  return { v, ref: component === undefined ? { node, param } : { node, param, component } };
}

export function bindDerived<T>(v: T, deps: BindRef[]): Bind<T> {
  return { v, deps };
}
