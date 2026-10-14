// Text (Skia) vs the Text node, option by option (specdocs/101326_skia-target.md
// §7 Wave 3, lane T). Every pair draws the same text with the same params:
// `<pair>n` is the native Text node (Chromium's canvas 2D), `<pair>s` a Skia
// Canvas over Text (Skia) (CanvasKit, the scene IR's renderer).
//
//   pair     what varies
//   f_geist  Geist 64 px, "Hello Skia" (the Text node draws it as an upload)
//   f_custom both sides on the same uploaded font (Custom font: its bytes
//            ship as a data: asset)
//   f_inter14  Inter 14 px through the curated family name — the file
//            globals.css registers as "Inter"
//   f_inter64  Inter 64 px: the Text node draws Inter's default optical size
//            (opsz 14) since lane T, as a Skia layer does — before, Chromium's
//            automatic opsz (32 here) drew it 8.2 % narrower
//   a_left / a_center / a_right   three unwrapped lines in a box
//   v_top / v_middle / v_bottom   vertical alignment, leading 1.5, translated box
//   l_090 / l_120 / l_160         wrapped, leading 0.9 / 1.2 / 1.6
//   w_208 / w_320 / w_464         wrap widths (px of 512) with mixed align / vAlign
//   ls_px / ls_pct                letter spacing in px; in % (wrapped)
//   c_upper / c_title             text case
//   b_multiply / b_difference / b_screen / b_opacity
//            blend: Merge (base Solid Color, the text as a layer, that mode)
//            vs Skia Group{Skia Fill, Skia Group{blendMode} → Text (Skia)}
//            over the same opaque color; b_opacity = multiply at 0.6
//
//   npm run compare:skia -- --a text:f_geistn --b text:f_geists --expect close
//
// Fonts. The Text node resolves "Inter" to the FontFace globals.css
// registers (the bundled /fonts/ file, weight range 100 900) — mirrored here
// on the first build, before anything computes, so lib/fonts.ts never asks
// Google for it. Geist is not a curated family: the Text node draws it as an
// uploaded Custom font (registerCustomFontFromBuffer), which the f_custom
// pair also gives Text (Skia). The first build starts every load; later
// builds PROVE the faces (the trap in 2026-09: curated Google families fell
// back to sans-serif while every check still passed): each Text node's text
// is measured through the engine's own styling (text-raster.ts
// applyAxisStyling on a DOM-attached canvas, as the node draws), and must
// equal the width SkParagraph shapes from the intended file with the axes
// the node draws with (the default opsz — automatic optical sizing is off
// — and wght = weight), within 0.05 px, and differ from the sans-serif
// fallback. The Skia side can't fall back (its font provider
// holds one face), so its proof is the asset: the same bytes, and a
// typeface CanvasKit names as that family. Both proofs print as
// `[page:warning] face proof …` lines.

import type { GraphEdge, GraphNode } from "@/engine/evaluator";
import type { CanvasKit } from "canvaskit-wasm";
import { canvasKit } from "@/engine/skia/canvaskit";
import { makeSceneAssetResolver } from "@/engine/skia/scene-assets";
import { applyAxisStyling } from "@/engine/text-raster";
import { getCustomFontBuffer, registerCustomFontFromBuffer } from "@/lib/fonts";
import { SKIA_FONTS, customSkiaFace, type SkiaFontFace } from "@/nodes/skia/fonts";
import type { SkiaGraphFixture } from "../../skia/fixture";

export const TEXT_TIMELINE = { fps: 60, ticksPerFrame: 1000 };
export const TEXT_SCENE_TICKS = 300_000;
export const TEXT_SIZE = 512;

// The uploaded fonts the fixture registers (lib/fonts customFontBuffers):
// the families stand in for the synthetic ones an upload gets.
export const UPLOADS = {
  geist: { family: "tbx-text-geist", filename: "Geist-Regular.ttf", url: SKIA_FONTS.Geist.asset.url },
  inter: { family: "tbx-text-inter", filename: "Inter-VariableFont_opsz,wght.ttf", url: SKIA_FONTS.Inter.asset.url },
} as const;
const customFont = (u: (typeof UPLOADS)[keyof typeof UPLOADS]) => ({ family: u.family, filename: u.filename });

// globals.css's @font-face for "Inter" (check-skia-text holds this to the file).
export const EDITOR_INTER_FACE = { family: "Inter", url: SKIA_FONTS.Inter.asset.url, weight: "100 900" };

// Register the uploads from bytes. `read` fetches in the browser, reads the
// file in Node (the export CLI, the gate — with a FontFace stub).
export async function registerTextFixtureFonts(read: (url: string) => Promise<ArrayBuffer>): Promise<void> {
  for (const u of Object.values(UPLOADS)) {
    if (getCustomFontBuffer(u.family)) continue;
    await registerCustomFontFromBuffer(await read(u.url), { family: u.family, filename: u.filename });
  }
}

// ---- graph ---------------------------------------------------------------------------------------

// Every param both nodes read (the Text node's extra rows at their no-op values).
const TEXT_BASE = {
  opacity: 1,
  text: "Hello Skia",
  font_family: "Inter",
  custom_font: null as null | { family: string; filename: string },
  font_size: 64,
  units: "px",
  font_weight: 400,
  italic: false,
  color: "#ffffff",
  alignment: "center",
  vAlign: "middle",
  textCase: "none",
  leading: 1.2,
  letter_spacing: 0,
  boxWidth: 1,
  boxHeight: 1,
  wrap: false,
  translateX: 0,
  translateY: 0,
};
const NATIVE_ONLY = { fillMode: "solid", strokeEnabled: false, scaleX: 1, scaleY: 1, rotate: 0, pivotX: 0.5, pivotY: 0.5 };

const edge = (source: string, target: string, targetHandle: string): GraphEdge => ({
  id: `${source}->${target}:${targetHandle}`,
  source,
  sourceHandle: "out:primary",
  target,
  targetHandle,
});

export const TEXT_PAIRS: { pair: string; expect: "match" | "close" | "off"; note?: string }[] = [];

export function textGraph(): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  TEXT_PAIRS.length = 0;
  const add = (n: GraphNode, from?: [string, string]) => {
    nodes.push(n);
    if (from) edges.push(edge(from[0], n.id, from[1]));
  };
  const canvas = (id: string, last: string) => add({ id, type: "skia-canvas", params: { background_on: false } }, [last, "in:scene"]);
  // `native` / `skia` override the shared params on one side only.
  const pair = (
    id: string,
    p: Record<string, unknown>,
    o: { native?: Record<string, unknown>; skia?: Record<string, unknown>; expect?: "match" | "close" | "off"; note?: string } = {}
  ) => {
    add({ id: `${id}n`, type: "text", params: { ...TEXT_BASE, ...NATIVE_ONLY, ...p, ...o.native } });
    add({ id: `${id}k`, type: "skia-text", params: { ...TEXT_BASE, shaping: "paragraph", ...p, ...o.skia } });
    canvas(`${id}s`, `${id}k`);
    TEXT_PAIRS.push({ pair: id, expect: o.expect ?? "close", ...(o.note ? { note: o.note } : {}) });
  };
  // The Text node can only draw Geist as an upload; Text (Skia) has it bundled.
  const geist = { native: { custom_font: customFont(UPLOADS.geist) }, skia: { font_family: "Geist" } };

  // ---- fonts ----
  pair("f_geist", {}, geist);
  pair("f_custom", { custom_font: customFont(UPLOADS.geist), text: "Custom font" });
  pair("f_inter14", { font_size: 14, text: "The quick brown fox jumps over the lazy dog, 0123456789" });
  pair("f_inter64", {});

  // ---- alignment (three unwrapped lines in a 0.8 × 0.8 box) ----
  for (const a of ["left", "center", "right"]) {
    pair(`a_${a}`, { text: "Align\nthree short lines\nof text", font_size: 40, alignment: a, boxWidth: 0.8, boxHeight: 0.8 }, geist);
  }
  // ---- vertical alignment, translated box (whole-px moves: the Text node
  //      resamples its raster for a translate, which blurs a fractional one) ----
  for (const v of ["top", "middle", "bottom"]) {
    pair(`v_${v}`, { text: "Anchored\nblock", font_size: 48, vAlign: v, leading: 1.5, boxWidth: 0.9, boxHeight: 0.7, translateX: 16 / 512, translateY: -24 / 512, color: "#ffd166" }, geist);
  }
  // ---- leading on wrapped text ----
  const para = "Paragraphs wrap inside the text box, and every line sits leading times the size below the last.";
  for (const [tag, l] of [["090", 0.9], ["120", 1.2], ["160", 1.6]] as const) {
    pair(`l_${tag}`, { text: para, font_size: 30, wrap: true, boxWidth: 0.75, leading: l, color: "#a0e7e5" }, geist);
  }
  // ---- wrap widths (whole px: SkParagraph floors its layout width) ----
  pair("w_208", { text: para, font_size: 24, wrap: true, boxWidth: 208 / 512, alignment: "left", vAlign: "top", leading: 1.25 }, geist);
  pair("w_320", { text: para, font_size: 28, wrap: true, boxWidth: 320 / 512, alignment: "right", vAlign: "bottom", leading: 1.25 }, geist);
  pair("w_464", { text: para, font_size: 34, wrap: true, boxWidth: 464 / 512, alignment: "center", vAlign: "middle", leading: 1.25 }, geist);
  // ---- letter spacing ----
  pair("ls_px", { text: "Spaced out", font_size: 48, letter_spacing: 6 }, geist);
  pair("ls_pct", { text: "Tracking in percent wraps too", font_size: 8, units: "%", letter_spacing: 0.5, wrap: true, boxWidth: 0.75 }, geist);
  // ---- case ----
  pair("c_upper", { text: "upper case", textCase: "upper" }, geist);
  pair("c_title", { text: "title case words", textCase: "title", font_size: 52 }, geist);

  // ---- blend over an opaque color ----
  const blendPair = (id: string, mode: string, opacity = 1) => {
    const bg = "#3a7bd5";
    const p = { text: "Blend", font_size: 150, color: "#ff8a3d" };
    add({ id: `${id}bg`, type: "solid-color", params: { color: bg, alpha: 1, opacity: 1 } });
    add({ id: `${id}t`, type: "text", params: { ...TEXT_BASE, ...NATIVE_ONLY, ...p, ...geist.native } });
    add({ id: `${id}n`, type: "merge", params: { layers: [{ id: "L", mode, opacity }] } });
    edges.push(edge(`${id}bg`, `${id}n`, "in:base"), edge(`${id}t`, `${id}n`, "in:layer:L"));
    add({ id: `${id}f`, type: "skia-fill", params: { color: bg, opacity: 1, blendMode: "srcOver" } });
    add({ id: `${id}k`, type: "skia-text", params: { ...TEXT_BASE, shaping: "paragraph", ...p, ...geist.skia } });
    add({ id: `${id}g`, type: "skia-group", params: { translateX: 0, translateY: 0, rotate: 0, scaleX: 1, scaleY: 1, originX: 0, originY: 0, opacity, blendMode: mode } }, [`${id}k`, "in:child1"]);
    add({ id: `${id}r`, type: "skia-group", params: { translateX: 0, translateY: 0, rotate: 0, scaleX: 1, scaleY: 1, originX: 0, originY: 0, opacity: 1, blendMode: "srcOver" } }, [`${id}f`, "in:child1"]);
    edges.push(edge(`${id}g`, `${id}r`, "in:child2"));
    canvas(`${id}s`, `${id}r`);
    TEXT_PAIRS.push({ pair: id, expect: "close" });
  };
  blendPair("b_multiply", "multiply");
  blendPair("b_difference", "difference");
  blendPair("b_screen", "screen");
  blendPair("b_opacity", "multiply", 0.6);

  return { nodes, edges };
}

// ---- the harness bundle (skia-harness/src/bundle-text, ?bundle=text) ------------------------------
//
// One Skia Canvas holding every text path the exporter has, animated so the
// parity run's motion check moves: a wrapped paragraph with leading and a
// keyframed size (sampled line metrics), Inter (default instance) with
// letter spacing and a keyframed vertical move, a paragraph under a
// difference-blend group at 0.85 opacity over the background, and a
// simple run (<Text>). Fonts are the bundled families (Geist, Inter): the
// export resolves their /fonts/ URLs through lane I's asset seam
// (lib/skia-export/assets.ts) and ships the bytes and OFL texts in assets/.

type K = [frame: number, value: number, easing: "linear" | "easeInOutSine" | "easeInOutCubic"];
const block = (keys: K[]) => ({
  animated: true,
  trackVisible: true,
  keyframes: keys.map(([f, value, easingOut]) => ({ tick: f * TEXT_TIMELINE.ticksPerFrame, value, easingOut })),
});

export function textBundleGraph(): { nodes: GraphNode[]; edges: GraphEdge[]; targetId: string } {
  const g = (id: string, p: Record<string, unknown> = {}): GraphNode => ({
    id,
    type: "skia-group",
    params: { translateX: 0, translateY: 0, rotate: 0, scaleX: 1, scaleY: 1, originX: 0, originY: 0, opacity: 1, blendMode: "srcOver", ...p },
  });
  const t = (id: string, p: Record<string, unknown>, animation?: GraphNode["animation"]): GraphNode => ({
    id,
    type: "skia-text",
    params: { ...TEXT_BASE, shaping: "paragraph", font_family: "Geist", ...p },
    ...(animation ? { animation } : {}),
  });
  const nodes: GraphNode[] = [
    { id: "bg", type: "skia-fill", params: { color: "#14213d", opacity: 1, blendMode: "srcOver" } },
    t(
      "para",
      {
        text: "Skia layers ship text as code: SkParagraph breaks the lines, toolbox places them.",
        font_size: 24,
        wrap: true,
        boxWidth: 0.8,
        vAlign: "top",
        alignment: "left",
        leading: 1.35,
        translateY: 0.06,
        color: "#a0e7e5",
      },
      { font_size: block([[0, 22, "easeInOutSine"], [150, 30, "easeInOutSine"], [299, 22, "linear"]]) }
    ),
    t(
      "inter",
      { font_family: "Inter", text: "Anchored\nand spaced", font_size: 44, letter_spacing: 3, vAlign: "middle", leading: 1.1, color: "#ffd166" },
      { translateY: block([[0, 0, "easeInOutCubic"], [150, 0.08, "easeInOutCubic"], [299, 0, "linear"]]) }
    ),
    t("blend", { text: "Blend", font_size: 132, vAlign: "bottom", alignment: "right", translateY: -0.04, translateX: -0.03, color: "#ff8a3d" }),
    g("blendg", { opacity: 0.85, blendMode: "difference" }),
    t("run", { text: "simple <Text> run", font_size: 20, shaping: "line", alignment: "left", vAlign: "bottom", translateX: 0.04, translateY: -0.02, color: "#ffffff" }),
    g("root1"),
    g("root"),
    { id: "skc", type: "skia-canvas", params: { background_on: false } },
  ];
  const edges = [
    edge("blend", "blendg", "in:child1"),
    edge("bg", "root1", "in:child1"),
    edge("para", "root1", "in:child2"),
    edge("inter", "root1", "in:child3"),
    edge("blendg", "root1", "in:child4"),
    edge("root1", "root", "in:child1"),
    edge("run", "root", "in:child2"),
    edge("root", "skc", "in:scene"),
  ];
  return { nodes, edges, targetId: "skc" };
}

// ---- fonts in the browser + the face proof -------------------------------------------------------

let started = false;
let interFace: FontFace | null = null;
let loading: Promise<void> | null = null;

// The Skia side's font assets: the bundled files and the uploads' data: URLs.
function skiaAssets() {
  return [
    ...Object.values(SKIA_FONTS).map((f) => f.asset),
    ...Object.values(UPLOADS).flatMap((u) => {
      const c = customSkiaFace(customFont(u));
      return typeof c === "string" ? [] : [c.asset];
    }),
  ];
}

function startFonts(): Promise<void> {
  if (loading) return loading;
  started = true;
  // globals.css's Inter, verbatim (family, weight range, file).
  interFace = new FontFace(EDITOR_INTER_FACE.family, `url(${EDITOR_INTER_FACE.url})`, { weight: EDITOR_INTER_FACE.weight, style: "normal" });
  document.fonts.add(interFace);
  loading = (async () => {
    await interFace!.load();
    await registerTextFixtureFonts(async (url) => (await fetch(url)).arrayBuffer());
    // Warm the Skia side's asset cache (scene-assets.ts fetches fonts
    // without CanvasKit) and wait for every one to land.
    const warm = makeSceneAssetResolver(null as unknown as CanvasKit);
    for (let i = 0; i < 300; i++) {
      const states = skiaAssets().map((a) => warm(a.id, "font", a));
      if (states.some((s) => s === null)) throw new Error("a Skia font asset failed to load");
      if (states.every((s) => s !== undefined)) return;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error("the Skia font assets didn't land within 6 s");
  })();
  return loading;
}

// SkiaGraphFixture.ready: every font landed, then the face proof.
async function fontsReady(): Promise<void> {
  if (typeof document === "undefined" || typeof FontFace === "undefined") return;
  await startFonts();
  if (!proven && canvasKit()) proveFaces(textGraph().nodes, TEXT_SIZE);
}

const facesFor = (params: Record<string, unknown>): { family: string; face: SkiaFontFace; bytesUrl: string } => {
  const cf = params.custom_font as { family: string } | null;
  if (cf?.family) {
    const up = Object.values(UPLOADS).find((u) => u.family === cf.family)!;
    const face = up.family === UPLOADS.inter.family ? SKIA_FONTS.Inter : SKIA_FONTS.Geist;
    return { family: cf.family, face, bytesUrl: up.url };
  }
  const fam = String(params.font_family ?? "Inter");
  return { family: fam, face: SKIA_FONTS[fam] ?? SKIA_FONTS.Inter, bytesUrl: (SKIA_FONTS[fam] ?? SKIA_FONTS.Inter).asset.url };
};

let proven = false;
function proveFaces(nodes: GraphNode[], size: number): void {
  const kit = canvasKit();
  if (!kit) throw new Error("text fixture: CanvasKit isn't loaded yet — can't prove the faces");
  // Measured the way the Text node draws: a DOM-attached canvas styled by
  // the engine's own applyAxisStyling (text-raster.ts) — which since lane T
  // turns Chromium's automatic optical sizing off. A detached canvas with a
  // bare font string measures what the Text node drew before (auto opsz).
  const raster = document.createElement("canvas");
  raster.style.position = "fixed";
  raster.style.left = "-99999px";
  raster.style.visibility = "hidden";
  document.body.appendChild(raster);
  const ctx2d = raster.getContext("2d")!;
  const auto2d = document.createElement("canvas").getContext("2d")!;
  const bytes: Record<string, ArrayBuffer> = {};
  for (const u of Object.values(UPLOADS)) bytes[u.url] = getCustomFontBuffer(u.family)!;
  const lines: string[] = [];
  for (const n of nodes) {
    if (n.type !== "text") continue;
    const p = n.params;
    const { family, face, bytesUrl } = facesFor(p);
    const px = p.units === "%" ? ((p.font_size as number) * size) / 100 : (p.font_size as number);
    const ls = p.units === "%" ? ((p.letter_spacing as number) * size) / 100 : (p.letter_spacing as number);
    const weight = Math.round(p.font_weight as number);
    const font = `${p.italic ? "italic " : ""}${weight} ${px}px "${family}", sans-serif`;
    // The axes the Text node now draws with: the default optical size,
    // wght = the weight.
    const vars = (face.axes ?? []).map((a) => ({ axis: a.tag, value: a.tag === "wght" ? weight : a.default }));
    const prov = kit.TypefaceFontProvider.Make();
    prov.registerFont(bytes[bytesUrl], "proof");
    for (const line of String(p.text).split("\n")) {
      if (!line) continue;
      const shape = (variations: { axis: string; value: number }[]) => {
        const ts = { fontFamilies: ["proof"], fontSize: px, letterSpacing: ls, fontVariations: variations };
        const b = kit.ParagraphBuilder.MakeFromFontProvider(new kit.ParagraphStyle({ textStyle: ts, applyRoundingHack: false }), prov);
        b.pushStyle(new kit.TextStyle({ ...ts, color: kit.BLACK }));
        b.addText(line);
        const para = b.build();
        para.layout(1e6);
        const w = para.getLongestLine();
        para.delete();
        b.delete();
        return w;
      };
      const file = shape(vars);
      const asShipped = shape([]);
      applyAxisStyling(raster, ctx2d, undefined, {}, 0, 0, family, px, null, weight, p.italic === true);
      (ctx2d as unknown as { letterSpacing: string }).letterSpacing = `${ls}px`;
      const chromium = ctx2d.measureText(line).width;
      (auto2d as unknown as { letterSpacing: string }).letterSpacing = `${ls}px`;
      auto2d.font = font;
      const auto = auto2d.measureText(line).width;
      ctx2d.font = `${weight} ${px}px sans-serif`;
      const fallback = ctx2d.measureText(line).width;
      const tag = `${n.id} "${line.slice(0, 18)}" ${px}px`;
      // FreeType (CanvasKit) sets the size in 26.6 fixed point: a fractional
      // size shapes up to 1/128 px per px of size off Chromium's exact one.
      const tol = 0.05 + (Number.isInteger(px * 64) ? 0 : (file * (0.5 / 64)) / px);
      if (Math.abs(chromium - file) > tol || Math.abs(fallback - file) < 0.5) {
        throw new Error(
          `text fixture: the Text node ${tag} did not draw ${bytesUrl}${vars.length ? ` (${vars.map((v) => `${v.axis} ${v.value}`).join(", ")})` : ""}: Chromium measures ${chromium.toFixed(3)} px, the file shapes ${file.toFixed(3)} px, sans-serif ${fallback.toFixed(3)} px — refusing to compare a fallback face`
        );
      }
      lines.push(`${tag}: Chromium ${chromium.toFixed(3)} = file ${file.toFixed(3)} (Δ ${(chromium - file).toFixed(4)}; sans-serif ${fallback.toFixed(2)}; shipped instance ${asShipped.toFixed(3)}${Math.abs(auto - chromium) > 0.01 ? `; auto opsz would draw ${auto.toFixed(3)}` : ""})`);
    }
    prov.delete();
  }
  raster.remove();
  // The Skia side: the asset bytes are the file, and CanvasKit names the face.
  for (const f of Object.values(SKIA_FONTS)) {
    const tf = kit.Typeface.MakeFreeTypeFaceFromData(bytes[f.asset.url]);
    if (!tf || tf.getFamilyName() !== f.family) throw new Error(`text fixture: ${f.asset.url} did not load as "${f.family}" in CanvasKit (${tf?.getFamilyName()})`);
    tf.delete();
  }
  for (const u of Object.values(UPLOADS)) {
    const c = customSkiaFace(customFont(u));
    if (typeof c === "string") throw new Error(`text fixture: ${u.filename}: ${c}`);
    const b64 = c.asset.url.slice(c.asset.url.indexOf(",") + 1);
    const raw = atob(b64);
    const want = new Uint8Array(bytes[u.url]);
    let same = raw.length === want.length;
    for (let i = 0; same && i < raw.length; i += 997) same = raw.charCodeAt(i) === want[i];
    if (!same) throw new Error(`text fixture: the Custom font asset for ${u.filename} is not the uploaded bytes`);
  }
  console.warn(`face proof (${lines.length} lines, every Text node; Skia assets = the files):\n  ${lines.join("\n  ")}`);
  proven = true;
}

// First build (compare:skia's info(), before CanvasKit): start the loads,
// so nothing the Text node computes ever sees "Inter" unregistered. Builds
// after ready(): everything has landed and the faces were proven.
function fixtureFonts(): void {
  if (typeof document === "undefined" || typeof FontFace === "undefined") return;
  if (!started) {
    void startFonts().catch(() => {});
    return;
  }
  if (!proven) throw new Error("text fixture: the fonts aren't proven — ready() must resolve before the sides are prepared");
}

export const fixture: SkiaGraphFixture = {
  description: "Text (Skia) vs the Text node per option — fonts, align, vAlign, leading, wrap width, letter spacing, case, blend (`<pair>n` vs `<pair>s`)",
  timeline: TEXT_TIMELINE,
  frames: [0],
  size: TEXT_SIZE,
  build: () => {
    const g = textGraph();
    fixtureFonts();
    return g;
  },
  ready: fontsReady,
};
