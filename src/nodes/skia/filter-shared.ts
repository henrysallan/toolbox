import type { SkiaDrawValue, SocketValue } from "@/engine/types";
import type { AssetIR, BlendMode, ColorFilterIR, ImageFilterIR, SkiaNode, SkslProgramIR } from "@/engine/skia/scene-ir";
import { colorManagementSksl } from "@/engine/skia/library/color-management";

// Shared by the Skia filter family (the `filter` lowering class,
// specdocs/101326_skia-target.md §3.2, Wave 3 lane F): Blur, Bloom, Grain,
// Drop Shadow, Morphology, Color Matrix, SkSL Filter, Lens Flare (Skia).
//
// Every filter node takes the drawing below it (`content`, a skia_draw)
// and returns a Skia Group whose `layer` filters it — React Native Skia's
// <Group layer={<Paint>…filters…</Paint>}>: a saveLayer OUTSIDE the
// group's own transform, image filters before colour filters, composited
// with the layer's blend mode (scene-ir.ts). Filter params are therefore in
// the coordinates of whatever encloses the filter node: canvas px at the
// scene root, and on device the exported root group scales the canvas to
// the React Native view, so a blur sigma scales with it (proven by
// parity:skia at a size other than the composition's).
//
// Hand-assembled runtime filter programs (Grain, Bloom's threshold, Lens
// Flare, SkSL Filter) read the content through the colour-management
// helpers (tbx.color.cm) and return through them, so their math is sRGB on
// a Display P3 canvas too (§5.5).

export const CONTENT_CHILD = "content";

export const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);

export function drawInput(v: SocketValue | undefined): SkiaDrawValue | null {
  return v && v.kind === "skia_draw" ? (v as SkiaDrawValue) : null;
}

// The filter's output: `content` inside a group with `layer`. Nothing
// wired is an empty group (the canvas draws nothing rather than failing).
export function filterGroup(
  input: SocketValue | undefined,
  nodeId: string,
  layer: { imageFilters?: ImageFilterIR[]; colorFilters?: ColorFilterIR[]; blendMode?: BlendMode },
  problems: string[] = []
): SkiaDrawValue {
  return wrapDrawing(input, nodeId, problems, (content) => ({ k: "group", id: nodeId, layer, children: [content] }));
}

// `build(content)` → the node's own subtree (it may use `content` several
// times — a bloom glow is drawn from its own copy of the content). Assets
// and producer problems of the input are carried through.
export function wrapDrawing(
  input: SocketValue | undefined,
  nodeId: string,
  problems: string[],
  build: (content: SkiaNode) => SkiaNode
): SkiaDrawValue {
  const d = drawInput(input);
  if (!d) {
    return { kind: "skia_draw", node: { k: "group", id: nodeId, children: [] }, ...(problems.length ? { problems } : {}) };
  }
  const all = [...(d.problems ?? []), ...problems];
  return {
    kind: "skia_draw",
    node: build(d.node),
    ...(d.assets ? { assets: d.assets as Record<string, AssetIR> } : {}),
    ...(all.length ? { problems: [...new Set(all)] } : {}),
  };
}

// ---- hand-assembled runtime filter programs ------------------------------------------

// A runtime image filter program over `content` (RN <RuntimeShader>, whose
// one child is the rendered layer). `body` defines
//   float4 tbx_filter(float2 p)
// returning a STRAIGHT-alpha sRGB colour, or — with `premulOut` — a
// PREMULTIPLIED one (a glow with alpha 0 is additive light, converted as it
// is). It reads the content with tbx_content(p) (straight sRGB) or
// tbx_content_premul(p) (premultiplied sRGB). `uniforms` are declaration
// lines (iResolution is always declared: canvas px).
export function filterProgramSksl(o: { name: string; uniforms: string[]; body: string; premulOut?: boolean }): string {
  return [
    `// toolbox ${o.name} — a runtime image filter over the rendered content`,
    "// (React Native Skia <RuntimeShader>; its only child is the layer).",
    `uniform shader ${CONTENT_CHILD};`,
    "uniform float3 iResolution;  // canvas px, z = 1",
    ...o.uniforms,
    "// Color management (engine/skia/library/color-management.ts): the math",
    "// below is sRGB on every canvas, Display P3 included.",
    colorManagementSksl(),
    `float4 tbx_content(float2 p) { return tbx_cm_child(float4(${CONTENT_CHILD}.eval(p))); }`,
    `float4 tbx_content_premul(float2 p) { return float4(tbx_cm_premul_in(${CONTENT_CHILD}.eval(p))); }`,
    o.body.trim(),
    "half4 main(float2 p) {",
    o.premulOut ? "  return tbx_cm_premul_out(tbx_filter(p));" : "  return tbx_cm_out(tbx_filter(p));",
    "}",
    "",
  ].join("\n");
}

export function runtimeFilter(program: SkslProgramIR): ImageFilterIR {
  return { k: "runtime", program, content: CONTENT_CHILD };
}
