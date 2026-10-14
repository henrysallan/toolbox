// Runtime image filters on React Native Skia WEB — a harness-only shim
// (specdocs/101326_skia-target.md §3.3 "built and measured"). Web only;
// index.web.ts installs it before the app loads.
//
// React Native Skia 3.4's web target throws on `<RuntimeShader>` (an SkSL
// program over a Group's rendered layer): CanvasKit has no factory for a
// runtime image filter, so `Skia.RuntimeShaderBuilder` and
// `Skia.ImageFilter.MakeRuntimeShader` are throwNotImplementedOnRNWeb.
// Native Skia runs it. toolbox's stage splitter (src/engine/skia/split.ts)
// exports exactly that shape — `<Group layer={<Paint><RuntimeShader/>
// </Paint>}>` — so without this the ?bundle=split slot can't render here.
//
// The shim plays the SAME emitted JSX and does what toolbox's preview does
// for such a layer (src/engine/skia/scene-render.ts drawEmulatedLayer):
//   1. RuntimeShaderBuilder records the uniforms RN sets on it;
//      MakeRuntimeShader returns a marker filter carrying the builder;
//   2. a layer paint holding that marker (JsiSkPaint.setImageFilter) makes
//      the canvas's saveLayer redirect drawing into a sub-recording in DEVICE
//      space (the CTM concatenated), instead of a real layer;
//   3. at the matching restore the sub-picture becomes the program's
//      `content` child — a picture shader (rasterized 1:1 at device
//      resolution, 8-bit like a layer, sampled nearest) under the inverse
//      CTM — and the program runs with the CTM as its local matrix, so
//      main() sees the group's parent-local coordinates, as native Skia's
//      parameter space gives it; its output is rasterized once more (8-bit,
//      as a filter result is) and composited srcOver under the inverse CTM.
// RN web records every frame into an SkPicture, so all of it happens in
// recordings: nothing renders until the view replays the frame.
//
// What it is not: native Skia (Graphite / Ganesh on a device) — the CI
// device lanes measure that. One runtime filter per layer, no composition
// with other filters, the layer paint's own alpha / blend / color filter
// ignored: exactly what the splitter emits. Anything else still throws or
// draws unfiltered.

import type { Canvas, CanvasKit, Paint, PictureRecorder, RuntimeEffect } from "canvaskit-wasm";
import { Skia } from "react-native-skia";

interface Builder {
  readonly __typename__: "RuntimeShaderBuilder";
  readonly effect: RuntimeEffect;
  readonly values: Map<string, number[]>;
  setUniform(name: string, value: readonly number[]): void;
  dispose(): void;
}

interface RuntimeFilter {
  readonly __typename__: "ImageFilter";
  readonly __tbxRuntime: Builder;
  dispose(): void;
}

interface LayerFrame {
  parent: Canvas;
  recorder: PictureRecorder;
  sub: Canvas;
  base: number;
  ctm: number[];
  bounds: Float32Array;
  builder: Builder;
}

const isRuntimeFilter = (f: unknown): f is RuntimeFilter =>
  !!f && typeof f === "object" && "__tbxRuntime" in (f as Record<string, unknown>);

let installed = false;

export function installRuntimeFilterShim(): void {
  if (installed) return;
  installed = true;
  const CK = (globalThis as unknown as { CanvasKit: CanvasKit }).CanvasKit;
  const api = Skia as unknown as Record<string, unknown> & { ImageFilter: Record<string, unknown> };

  api.RuntimeShaderBuilder = (source: { ref: RuntimeEffect }): Builder => {
    const values = new Map<string, number[]>();
    return {
      __typename__: "RuntimeShaderBuilder",
      effect: source.ref,
      values,
      setUniform(name, value) {
        values.set(name, Array.from(value));
      },
      dispose() {},
    };
  };
  api.ImageFilter.MakeRuntimeShader = (builder: Builder): RuntimeFilter => ({
    __typename__: "ImageFilter",
    __tbxRuntime: builder,
    dispose() {},
  });

  // The classes to patch, from live instances: metro resolves
  // react-native-skia to its src/ ("react-native" field), so a deep import
  // of lib/module/… would patch a second copy nothing uses.
  const probePaint = Skia.Paint();
  const probeRecorder = Skia.PictureRecorder();
  const probeCanvas = probeRecorder.beginRecording();
  const PaintClass = Object.getPrototypeOf(probePaint) as object;
  const CanvasClass = Object.getPrototypeOf(probeCanvas) as object;
  probeRecorder.finishRecordingAsPicture().dispose();
  probeRecorder.dispose();
  probePaint.dispose();

  // The marker rides the JS paint wrapper (CanvasKit gets no filter).
  const marked = new WeakMap<object, Builder>();
  const paintProto = PaintClass as unknown as {
    ref: Paint;
    setImageFilter(f: unknown): void;
    assign(p: object): void;
    reset(): void;
    copy(): object;
  };
  const setImageFilter = paintProto.setImageFilter;
  paintProto.setImageFilter = function (this: typeof paintProto, f: unknown) {
    if (isRuntimeFilter(f)) {
      marked.set(this, f.__tbxRuntime);
      this.ref.setImageFilter(null);
      return;
    }
    marked.delete(this);
    setImageFilter.call(this, f);
  };
  const assign = paintProto.assign;
  paintProto.assign = function (this: typeof paintProto, p: object) {
    assign.call(this, p);
    const b = marked.get(p);
    if (b) marked.set(this, b);
    else marked.delete(this);
  };
  const reset = paintProto.reset;
  paintProto.reset = function (this: typeof paintProto) {
    reset.call(this);
    marked.delete(this);
  };
  const copy = paintProto.copy;
  paintProto.copy = function (this: typeof paintProto) {
    const out = copy.call(this);
    const b = marked.get(this);
    if (b) marked.set(out, b);
    return out;
  };

  const frames: LayerFrame[] = [];
  const canvasProto = CanvasClass as unknown as {
    ref: Canvas;
    saveLayer(paint?: object, ...rest: unknown[]): number;
    restore(): void;
  };
  const saveLayer = canvasProto.saveLayer;
  canvasProto.saveLayer = function (this: typeof canvasProto, paint?: object, ...rest: unknown[]) {
    const builder = paint ? marked.get(paint) : undefined;
    if (!builder) return saveLayer.call(this, paint, ...rest);
    const parent = this.ref;
    const ctm = parent.getTotalMatrix();
    // The program's canvas (iResolution, toolbox's scene px) in device px.
    const res = builder.values.get("iResolution") ?? [0, 0];
    const corners = [
      [0, 0],
      [res[0], 0],
      [0, res[1]],
      [res[0], res[1]],
    ].map(([x, y]) => {
      const w = ctm[6] * x + ctm[7] * y + ctm[8];
      return [(ctm[0] * x + ctm[1] * y + ctm[2]) / w, (ctm[3] * x + ctm[4] * y + ctm[5]) / w];
    });
    const xs = corners.map((c) => c[0]);
    const ys = corners.map((c) => c[1]);
    const bounds = CK.LTRBRect(Math.floor(Math.min(...xs)), Math.floor(Math.min(...ys)), Math.ceil(Math.max(...xs)), Math.ceil(Math.max(...ys)));
    const recorder = new CK.PictureRecorder();
    const sub = recorder.beginRecording(bounds);
    sub.concat(ctm);
    frames.push({ parent, recorder, sub, base: sub.getSaveCount(), ctm, bounds, builder });
    this.ref = sub;
    return parent.getSaveCount();
  };
  const restore = canvasProto.restore;
  canvasProto.restore = function (this: typeof canvasProto) {
    const top = frames[frames.length - 1];
    if (!top || this.ref !== top.sub || top.sub.getSaveCount() > top.base) {
      restore.call(this);
      return;
    }
    frames.pop();
    this.ref = top.parent;
    finishLayer(CK, top);
  };
}

function finishLayer(CK: CanvasKit, f: LayerFrame): void {
  const inv = CK.Matrix.invert(f.ctm);
  const picture = f.recorder.finishRecordingAsPicture();
  f.recorder.delete();
  if (!inv) {
    picture.delete();
    return;
  }
  // The layer: device-space picture, rasterized 1:1, sampled at the
  // program's coordinates mapped back to device px.
  const content = picture.makeShader(CK.TileMode.Decal, CK.TileMode.Decal, CK.FilterMode.Nearest, inv, f.bounds);
  const effect = f.builder.effect;
  const uniforms: number[] = [];
  for (let i = 0; i < effect.getUniformCount(); i++) {
    const v = f.builder.values.get(effect.getUniformName(i));
    if (!v) throw new Error(`runtime filter shim: uniform "${effect.getUniformName(i)}" was never set`);
    uniforms.push(...v);
  }
  const shader = effect.makeShaderWithChildren(uniforms, [content], f.ctm);
  // The filter's result, rasterized once (a filtered layer is an image).
  const outRec = new CK.PictureRecorder();
  const out = outRec.beginRecording(f.bounds);
  const p = new CK.Paint();
  p.setShader(shader);
  p.setBlendMode(CK.BlendMode.Src);
  out.drawRect(f.bounds, p);
  const result = outRec.finishRecordingAsPicture();
  const resultShader = result.makeShader(CK.TileMode.Decal, CK.TileMode.Decal, CK.FilterMode.Nearest, undefined, f.bounds);
  const q = new CK.Paint();
  q.setShader(resultShader);
  f.parent.save();
  f.parent.concat(inv);
  f.parent.drawRect(f.bounds, q);
  f.parent.restore();
  // The parent recording holds its own references.
  for (const o of [q, resultShader, result, p, outRec, shader, content, picture]) o.delete();
}
