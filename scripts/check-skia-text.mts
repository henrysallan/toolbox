// check-skia-text: Text (Skia) and the text IR (specdocs/101326_skia-target.md
// §3.4b, Wave 3 lane T). Offline: CanvasKit on CPU surfaces in Node, the
// node's compute, the real exporter.
//
//   1. fonts: the bundled faces' tables, axes and licences are the files';
//      globals.css registers the very Inter file a Skia layer ships as
//      "Inter"; every family the Text node offers resolves or refuses with a
//      reason; an uploaded font ships its bytes as a data: asset; weights,
//      italic and axes a phone can't draw refuse — and the fact that forces
//      it (React Native Skia's native text never reads fontVariations) is
//      pinned, with the opsz gap automatic optical sizing would open and the
//      editor-side switch that closes it (text-raster.ts);
//   2. layout: the IR Text (Skia) emits puts every line's baseline exactly
//      where the Text node's drawTextBlock does, for every align × vAlign ×
//      leading × line count × box / translate × units;
//   3. the renderer means what the IR says: lines drawn one by one at
//      SkParagraph's own pitch are the paragraph drawn whole, pixel for
//      pixel; a fractional lineHeight lands each line exactly; every anchor
//      equals a baseline anchor at the computed baseline; letter spacing
//      sits half before each glyph (hence the node's −ls/2); a group's
//      blendMode blends a paragraph's glyphs;
//   4. the export: the emitted makeTextPicture / textBaselineY, run on
//      CanvasKit through a React-Native-Skia-shaped shim, draw exactly what
//      the renderer draws; blend modes and group opacity reach the
//      paragraph's own paint; v1 text keeps its one <Paragraph>; refusals;
//      worklet declaration order; every compare fixture canvas exports; the
//      harness bundle type-checks and skia-harness/src/bundle-text is
//      today's export.
//
// Pixel parity against the Text node needs Chromium: `npm run compare:skia
// -- --a text:<pair>n --b text:<pair>s --expect close` (pairs in
// scripts/fixtures/skia/text-graph.ts; it proves both faces first), and the
// RN web half is `npm run parity:skia -- --bundle text`.
//
//   npx tsx scripts/check-skia-text.mts

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import type { Canvas, CanvasKit, Paragraph } from "canvaskit-wasm";
import type { Bind, SkiaNode, SkiaScene } from "@/engine/skia/scene-ir";
import type { NodeDefinition } from "@/engine/types";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// lib/fonts' registration builds a FontFace (DOM) before it stores the bytes.
(globalThis as { FontFace?: unknown }).FontFace ??= class {
  load() {
    return Promise.resolve(this);
  }
};

const { registerAllNodes } = await import("@/nodes/index");
registerAllNodes();
const { getNodeDef } = await import("@/engine/registry");
const { renderScene } = await import("@/engine/skia/scene-render");
const { exportSkia, exportSkiaScene, collectSkiaExportAssets, resolveSkiaExportAssets } = await import("@/lib/skia-export");
const { nodeResolveAsset } = await import("./skia/node-assets");
const { MAKE_TEXT_PICTURE_SOURCE, TEXT_RUN_SOURCE, TEXT_BASELINE_Y_SOURCE } = await import("@/lib/skia-export/scene-emit");
const fonts = await import("@/nodes/skia/fonts");
const { parseVariableAxes } = await import("@/lib/font-parse");
const { registerCustomFontFromBuffer } = await import("@/lib/fonts");
const { checkExportable } = await import("./skia/export-check");
const fx = await import("./fixtures/skia/text-graph");
const aurora = await import("./fixtures/skia/aurora-graph");

const require = createRequire(path.join(ROOT, "package.json"));
const CK: CanvasKit = await require("canvaskit-wasm")();
const esbuild = await import("esbuild");

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  console.log(`${cond ? "ok  " : "FAIL"} ${name}${!cond && detail ? ` — ${detail}` : ""}`);
  if (!cond) failures++;
}
function note(s: string) {
  console.log(`     ${s}`);
}

const SIZE = fx.TEXT_SIZE;
const runtimeSource = fs.readFileSync(path.join(ROOT, "src/lib/skia-export/runtime/toolbox-timeline.ts"), "utf8");
const TIMELINE = { ...fx.TEXT_TIMELINE, sceneDurationTicks: fx.TEXT_SCENE_TICKS };
const fileBytes = (url: string) => {
  const b = fs.readFileSync(path.join(ROOT, "public", decodeURIComponent(url)));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
};
await fx.registerTextFixtureFonts(async (url) => fileBytes(url));

const s = <T,>(v: T): Bind<T> => ({ v });
const GEIST = fileBytes(fonts.SKIA_FONTS.Geist.asset.url);
const INTER = fileBytes(fonts.SKIA_FONTS.Inter.asset.url);
const assetBytes: Record<string, ArrayBuffer> = { geist: GEIST, inter: INTER };

// ---- rendering helpers ------------------------------------------------------------------------

type Px = Uint8Array;
function surface(draw: (c: Canvas) => void): Px {
  const surf = CK.MakeSurface(SIZE, SIZE)!;
  const c = surf.getCanvas();
  c.clear(CK.TRANSPARENT);
  draw(c);
  surf.flush();
  const px = c.readPixels(0, 0, { width: SIZE, height: SIZE, colorType: CK.ColorType.RGBA_8888, alphaType: CK.AlphaType.Premul, colorSpace: CK.ColorSpace.SRGB }) as Uint8Array;
  surf.delete();
  return px;
}
function sceneOf(children: SkiaNode[], background?: [number, number, number, number]): SkiaScene {
  const assets = {
    geist: { ...fonts.SKIA_FONTS.Geist.asset },
    inter: { ...fonts.SKIA_FONTS.Inter.asset },
  };
  return { version: 1, width: SIZE, height: SIZE, ...(background ? { background } : {}), root: { k: "group", children }, assets };
}
function render(scene: SkiaScene): { px: Px; problems: string[] } {
  let problems: string[] = [];
  const px = surface((c) => {
    const r = renderScene(CK, c, scene, { assets: (id, kind) => (kind === "font" ? (assetBytes[id] ?? null) : null) });
    problems = r.problems;
    // release after the CPU draw: the surface is flushed by readPixels' caller
    (globalThis as { __rel?: () => void }).__rel = r.release;
  });
  (globalThis as { __rel?: () => void }).__rel?.();
  return { px, problems };
}
function diff(a: Px, b: Px): { max: number; differing: number } {
  let max = 0;
  let differing = 0;
  for (let i = 0; i < a.length; i += 4) {
    let d = 0;
    for (let c = 0; c < 4; c++) d = Math.max(d, Math.abs(a[i + c] - b[i + c]));
    if (d) differing++;
    if (d > max) max = d;
  }
  return { max, differing };
}
const inkCount = (p: Px) => {
  let n = 0;
  for (let i = 3; i < p.length; i += 4) if (p[i] > 128) n++;
  return n;
};
function inkBox(p: Px) {
  let x0 = SIZE, x1 = -1, y0 = SIZE, y1 = -1;
  for (let y = 0; y < SIZE; y++)
    for (let x = 0; x < SIZE; x++)
      if (p[(y * SIZE + x) * 4 + 3] > 128) {
        x0 = Math.min(x0, x);
        x1 = Math.max(x1, x);
        y0 = Math.min(y0, y);
        y1 = Math.max(y1, y);
      }
  return { x0, x1, y0, y1 };
}

// A CanvasKit paragraph of `text` in a bundled face (what the renderer builds).
const provs: Record<string, ReturnType<CanvasKit["TypefaceFontProvider"]["Make"]>> = {};
function provider(id: string) {
  if (!provs[id]) {
    provs[id] = CK.TypefaceFontProvider.Make();
    provs[id].registerFont(assetBytes[id], "f");
  }
  return provs[id];
}
// Painted the way the renderer paints text: an anti-aliased white paint
// (a paragraph without a foreground paint draws aliased glyphs).
const WHITE_AA = new CK.Paint();
WHITE_AA.setColor(CK.WHITE);
WHITE_AA.setAntiAlias(true);
const CLEAR = new CK.Paint();
CLEAR.setColor(CK.TRANSPARENT);
function layout(id: string, text: string, size: number, width: number, align = CK.TextAlign.Left, spacing = 0): Paragraph {
  const ts = { fontFamilies: ["f"], fontSize: size, ...(spacing ? { letterSpacing: spacing } : {}) };
  const b = CK.ParagraphBuilder.MakeFromFontProvider(new CK.ParagraphStyle({ textStyle: ts, textAlign: align }), provider(id));
  b.pushPaintStyle(new CK.TextStyle(ts), WHITE_AA, CLEAR);
  b.addText(text);
  const p = b.build();
  p.layout(width);
  b.delete();
  return p;
}
type TextIR = Extract<SkiaNode, { k: "text" }>;
const textNode = (o: Omit<Partial<TextIR>, "text" | "x" | "y"> & { text: string; size: number; x: number; y: number }): TextIR => {
  const { text, size, x, y, ...rest } = o;
  return {
    k: "text",
    text: s(text),
    font: { asset: "geist", size: s(size) },
    x: s(x),
    y: s(y),
    paint: { style: "fill", color: s([1, 1, 1, 1] as [number, number, number, number]) },
    ...rest,
  } as Extract<SkiaNode, { k: "text" }>;
};

// ---- 1. fonts ---------------------------------------------------------------------------------

function nameTable(buf: Buffer): Record<number, string> {
  const n = buf.readUInt16BE(4);
  const t: Record<string, number> = {};
  for (let i = 0; i < n; i++) t[buf.toString("ascii", 12 + i * 16, 16 + i * 16)] = buf.readUInt32BE(12 + i * 16 + 8);
  const name = t.name;
  const count = buf.readUInt16BE(name + 2);
  const strOff = name + buf.readUInt16BE(name + 4);
  const out: Record<number, string> = {};
  for (let i = 0; i < count; i++) {
    const r = name + 6 + i * 12;
    if (buf.readUInt16BE(r) !== 3 || buf.readUInt16BE(r + 4) !== 0x409) continue;
    const len = buf.readUInt16BE(r + 8);
    const off = buf.readUInt16BE(r + 10);
    let str = "";
    for (let k = 0; k < len; k += 2) str += String.fromCharCode(buf.readUInt16BE(strOff + off + k));
    out[buf.readUInt16BE(r + 6)] = str;
  }
  return out;
}
{
  for (const face of Object.values(fonts.SKIA_FONTS)) {
    const bytes = fileBytes(face.asset.url);
    const m = fonts.readSfntMetrics(bytes)!;
    check(
      `${face.family}: upem / typo metrics / weight class are the file's`,
      !!m && m.unitsPerEm === face.unitsPerEm && m.typoAscender === face.ascender && m.typoDescender === face.descender && m.weightClass === face.weight,
      JSON.stringify(m)
    );
    const axes = parseVariableAxes(bytes) ?? [];
    const want = (face.axes ?? []).map((a) => `${a.tag} ${a.min}..${a.default}..${a.max}`).join(", ");
    const got = axes.map((a) => `${a.tag} ${a.min}..${a.default}..${a.max}`).join(", ");
    check(`${face.family}: fvar axes are the file's (${got || "static"})`, want === got, `${want} vs ${got}`);
    const names = nameTable(Buffer.from(bytes));
    const lic = face.asset.license ? path.join(ROOT, "public", face.asset.license) : "";
    const text = lic && fs.existsSync(lic) ? fs.readFileSync(lic, "utf8") : "";
    check(
      `${face.family}: ships under the SIL OFL 1.1 with its licence beside it (${face.asset.license}, the file's own copyright line)`,
      /SIL Open Font License, Version 1\.1/.test(names[13] ?? "") && text.startsWith(`${names[0]}\n`) && /SIL OPEN FONT LICENSE Version 1\.1/.test(text),
      `${names[0]} / ${text.split("\n")[0]}`
    );
  }
  // The editor's Text node draws "Inter" from globals.css's @font-face —
  // the same file a Skia layer ships (and the compare fixture mirrors it).
  const css = fs.readFileSync(path.join(ROOT, "src/app/globals.css"), "utf8");
  const block = /@font-face\s*{[^}]*font-family:\s*"Inter"[^}]*}/.exec(css)?.[0] ?? "";
  check(
    "globals.css registers the bundled Inter file as \"Inter\" (weight 100 900): the Text node's Inter is the shipped Inter",
    block.includes(`url("${fonts.SKIA_FONTS.Inter.asset.url}")`) && /font-weight:\s*100 900/.test(block) && fx.EDITOR_INTER_FACE.weight === "100 900" && fx.EDITOR_INTER_FACE.url === fonts.SKIA_FONTS.Inter.asset.url,
    block
  );
  // Every family the Text node offers has an answer.
  const answers = fonts.TEXT_NODE_FAMILIES.map((f) => [f, fonts.skiaFamilyRefusal(f)] as const);
  check("of the Text node's curated families, only Inter draws in a Skia layer", answers.filter(([, r]) => r === null).map(([f]) => f).join() === "Inter");
  check(
    "…the system families refuse as OS-licensed, the Google ones as not bundled",
    answers.every(([f, r]) => r === null || (["Helvetica", "Arial", "Georgia", "Times New Roman", "Courier New"].includes(f) ? /system font/.test(r) : /Google Fonts family/.test(r))),
    answers.map(([f, r]) => `${f}: ${r?.slice(0, 30)}`).join(" | ")
  );
  check("an unknown (installed) family refuses with the upload hint", /Custom font/.test(fonts.skiaFamilyRefusal("SF Pro Display") ?? ""));

  // Uploads: the bytes ship as a data: asset.
  const up = fonts.customSkiaFace({ family: fx.UPLOADS.geist.family, filename: fx.UPLOADS.geist.filename });
  const upOk = typeof up !== "string";
  const b64 = upOk ? up.asset.url.slice(up.asset.url.indexOf(",") + 1) : "";
  check(
    "an uploaded font becomes a face whose asset is a data: URL of its exact bytes",
    upOk && up.asset.url.startsWith("data:font/ttf;base64,") && Buffer.from(b64, "base64").equals(Buffer.from(GEIST)) && up.source === "custom",
    typeof up === "string" ? up : up.asset.url.slice(0, 40)
  );
  check(
    "…with the file's own metrics (the same as the bundled Geist's table)",
    upOk && up.unitsPerEm === 1000 && up.ascender === fonts.SKIA_FONTS.Geist.ascender && up.descender === fonts.SKIA_FONTS.Geist.descender && up.weight === 400
  );
  check("…and the same asset object every call (the data: URL is built once)", upOk && fonts.customSkiaFace({ family: fx.UPLOADS.geist.family }) === up);
  const upInter = fonts.customSkiaFace({ family: fx.UPLOADS.inter.family });
  check("an uploaded variable font knows its axes (default instance: opsz 14, wght 400)", typeof upInter !== "string" && upInter.axes?.map((a) => `${a.tag}${a.default}`).join() === "opsz14,wght400");
  const woff = new Uint8Array(64);
  woff.set([0x77, 0x4f, 0x46, 0x46]);
  await registerCustomFontFromBuffer(woff.buffer, { family: "tbx-check-woff", filename: "x.woff" });
  check("a WOFF upload refuses (TrueType / OpenType only)", /isn't a TrueType/.test(String(fonts.customSkiaFace({ family: "tbx-check-woff", filename: "x.woff" }))));
  check("an upload whose bytes this session lost refuses", /no bytes in this session/.test(String(fonts.customSkiaFace({ family: "tbx-never-registered" }))));

  const R = (p: Record<string, unknown>) => fonts.resolveSkiaTextFace(p);
  const cases: [string, Record<string, unknown>, RegExp | null, string][] = [
    ["Inter at weight 400", { font_family: "Inter", font_weight: 400 }, null, "inter"],
    ["Inter at weight 700 (a variable axis a phone ignores)", { font_family: "Inter", font_weight: 700 }, /default instance \(wght 400\)/, "inter"],
    ["Geist at weight 500 (Chromium draws the Regular too)", { font_family: "Geist", font_weight: 500 }, null, "geist"],
    ["Geist at weight 700 (Chromium synthesizes bold)", { font_family: "Geist", font_weight: 700 }, /synthesizes bold/, "geist"],
    ["italic", { font_family: "Geist", italic: true }, /no italic face/, "geist"],
    ["Inter wght 650 in font_variations", { font_family: "Inter", font_variations: { wght: 650 } }, /"wght" axis at 650/, "inter"],
    ["Inter opsz at its default", { font_family: "Inter", font_variations: { opsz: { mode: "constant", value: 14 } } }, null, "inter"],
    ["a modulated axis", { font_family: "Inter", font_variations: { wght: { mode: "sine", center: 400, amplitude: 100, frequency: 1, phase: 0 } } }, /Per-character "wght"/, "inter"],
    ["Roboto (draws Inter meanwhile)", { font_family: "Roboto" }, /Google Fonts family/, "inter"],
    ["a Custom font wins over font_family", { font_family: "Roboto", custom_font: { family: fx.UPLOADS.geist.family } }, null, (up as { asset: { id: string } }).asset.id],
  ];
  for (const [label, p, want, face] of cases) {
    const r = R(p);
    const ok = want ? r.problems.some((x) => want.test(x)) : r.problems.length === 0;
    check(`face: ${label} → ${want ? "refuses" : "draws"}${face ? ` (${face})` : ""}`, ok && r.face.asset.id === face, `${r.face.asset.id}: ${r.problems.join(" | ")}`);
  }

  // Why variable axes refuse: React Native Skia's native text never reads them.
  const jsi = path.join(ROOT, "skia-harness/node_modules/react-native-skia/cpp/api/JsiSkTextStyle.h");
  if (fs.existsSync(jsi)) {
    const src = fs.readFileSync(jsi, "utf8");
    const web = fs.readFileSync(path.join(ROOT, "skia-harness/node_modules/react-native-skia/src/skia/web/JsiSkTextStyle.ts"), "utf8");
    check(
      "pinned: react-native-skia 3.4's native JsiSkTextStyle ignores fontVariations (only the web build passes them) — revisit the axis refusals when this flips",
      !/fontVariations|FontArguments/.test(src) && /fontVariations/.test(web) && /letterSpacing/.test(src)
    );
  } else note("skia-harness/node_modules absent — the native fontVariations pin is skipped");

  // The opsz gap Chromium's automatic optical sizing opens for Inter above 14 px.
  const w = (v: { axis: string; value: number }[]) => {
    const ts = { fontFamilies: ["f"], fontSize: 64, fontVariations: v };
    const b = CK.ParagraphBuilder.MakeFromFontProvider(new CK.ParagraphStyle({ textStyle: ts, applyRoundingHack: false }), provider("inter"));
    b.pushStyle(new CK.TextStyle({ ...ts, color: CK.BLACK }));
    b.addText("Hello Skia");
    const p = b.build();
    p.layout(1e6);
    const out = p.getLongestLine();
    p.delete();
    b.delete();
    return out;
  };
  const dflt = w([]);
  const opsz32 = w([{ axis: "opsz", value: 32 }]);
  const pct = (1 - opsz32 / dflt) * 100;
  check(`Inter "Hello Skia" 64 px: opsz 32 (Chromium's automatic optical size) runs ${pct.toFixed(1)} % narrower than the default instance a Skia layer ships`, pct > 7.5 && pct < 9, `${dflt} vs ${opsz32}`);

  // …so the editor's text rasterizer turns automatic optical sizing off: the
  // Text node (and Copy to Points' text mode, Point Labels — every caller of
  // text-raster.ts) draws a variable font's default opsz, what React Native
  // Skia draws. Pinned on the styling call every draw and measure goes
  // through; the measured effect in Chromium is the text compare fixture's
  // face proof (f_inter64: Chromium = the opsz-14 width).
  const { applyAxisStyling } = await import("@/engine/text-raster");
  const fakeCanvas = () => {
    const props: Record<string, string> = {};
    return {
      props,
      el: { style: { fontVariationSettings: "", setProperty: (k: string, v: string) => void (props[k] = v) } } as unknown as HTMLCanvasElement,
      c2d: { font: "", fontStretch: "" } as unknown as CanvasRenderingContext2D,
    };
  };
  const plain = fakeCanvas();
  applyAxisStyling(plain.el, plain.c2d, undefined, {}, 0, 0, "Inter", 64, null, 400, false);
  const custom = fakeCanvas();
  applyAxisStyling(custom.el, custom.c2d, [{ tag: "opsz" }, { tag: "wght" }], { opsz: 32, wght: { mode: "constant", value: 650 } }, 0, 0, "tbx-up", 64, null, 400, false);
  check(
    "editor: text-raster sets font-optical-sizing: none on the raster canvas (Inter draws opsz 14 at every size), and a Custom font's explicit opsz / wght still reach font-variation-settings",
    plain.props["font-optical-sizing"] === "none" &&
      plain.c2d.font === '400 64px "Inter", sans-serif' &&
      custom.props["font-optical-sizing"] === "none" &&
      custom.el.style.fontVariationSettings === "'opsz' 32, 'wght' 650",
    `${JSON.stringify(plain.props)} / ${custom.el.style.fontVariationSettings}`
  );
}

// ---- 2. layout: the IR's baselines are the Text node's -------------------------------------------

{
  const def = getNodeDef("skia-text") as NodeDefinition;
  const compute = (params: Record<string, unknown>) =>
    (def.compute as unknown as (a: unknown) => { primary: { node: SkiaNode; problems?: string[] } })({
      params: { ...Object.fromEntries(def.params.map((p) => [p.name, p.default])), ...params },
      ctx: { width: SIZE, height: SIZE * 0.75 },
      nodeId: "t",
      inputs: {},
    }).primary;
  let worst = 0;
  let worstAt = "";
  let combos = 0;
  const W = SIZE;
  const H = SIZE * 0.75;
  for (const alignment of ["left", "center", "right"])
    for (const vAlign of ["top", "middle", "bottom"])
      for (const leading of [0.8, 1.2, 1.75])
        for (const lines of [1, 2, 4])
          for (const [boxWidth, boxHeight, translateX, translateY] of [[1, 1, 0, 0], [0.6, 0.5, 0.11, -0.07]])
            for (const units of ["px", "%"]) {
              const font_size = units === "%" ? 7.3 : 37.5;
              const text = Array.from({ length: lines }, (_, i) => `Line ${i + 1}`).join("\n");
              const out = compute({ text, alignment, vAlign, leading, boxWidth, boxHeight, translateX, translateY, units, font_size, font_family: "Geist", letter_spacing: 0 });
              const n = out.node as Extract<SkiaNode, { k: "text" }>;
              combos++;
              // The Text node (engine/text-raster.ts drawTextBlock).
              const size = units === "%" ? (font_size * W) / 100 : font_size;
              const L = size * leading;
              const bw = boxWidth * W;
              const bh = boxHeight * H;
              const ox = W / 2 - bw / 2 + translateX * W;
              const oy = H / 2 - bh / 2 + translateY * H;
              const total = lines * L;
              const blockTop = vAlign === "top" ? oy : vAlign === "bottom" ? oy + bh - total : oy + bh / 2 - total / 2;
              const m2a = fonts.canvasMiddleToAlphabetic(fonts.SKIA_FONTS.Geist, size);
              const k = alignment === "left" ? 0 : alignment === "right" ? 1 : 0.5;
              // The IR, read the way scene-render.ts places it.
              const kv = n.anchor === "top" ? 0 : n.anchor === "bottom" ? 1 : 0.5;
              const top = n.y.v - kv * lines * n.lineHeight!.v;
              for (let i = 0; i < lines; i++) {
                const want = blockTop + L / 2 + i * L + m2a;
                const got = top + i * n.lineHeight!.v + n.baselineOffset!.v;
                const ax = n.x.v + n.width!.v * k + (n.letterSpacing?.v ?? 0) / 2;
                const d = Math.max(Math.abs(want - got), Math.abs(ax - (ox + bw * k)));
                if (d > worst) {
                  worst = d;
                  worstAt = `${alignment}/${vAlign}/${leading}/${lines}/${units}: line ${i} ${got} vs ${want}`;
                }
              }
            }
  check(`Text (Skia)'s IR puts every baseline where the Text node does (${combos} align × vAlign × leading × lines × box × units combos, ≤ 1e-9 px)`, worst <= 1e-9, worstAt);
  // Wrapped: the same block math, any line count shaping finds.
  const wrapped = compute({ text: "a b c", wrap: true, vAlign: "bottom", leading: 1.3, boxWidth: 0.5, font_family: "Geist", font_size: 30 }).node as Extract<SkiaNode, { k: "text" }>;
  check(
    "wrapped text anchors at the box's vAlign edge with leading × size line height (any line count)",
    wrapped.anchor === "bottom" && Math.abs(wrapped.y.v - (H / 2 + (0.5 * H) / 2 + 0)) > -1 && Math.abs(wrapped.lineHeight!.v - 39) < 1e-12 && wrapped.width!.v === 256,
    JSON.stringify({ a: wrapped.anchor, y: wrapped.y.v, lh: wrapped.lineHeight?.v, w: wrapped.width?.v })
  );
  const spaced = compute({ text: "x", letter_spacing: 2, units: "%", font_family: "Geist" }).node as Extract<SkiaNode, { k: "text" }>;
  check(
    "letter_spacing in % is a scaled track of the param, and x steps back half of it",
    spaced.letterSpacing?.v === (2 * W) / 100 && spaced.letterSpacing?.ref?.scale === W / 100 && Math.abs(spaced.x.v - (W / 2 - 32768 / 2 - (2 * W) / 100 / 2)) < 1e-9
  );
  const runs = compute({ text: "a\nb", shaping: "line", letter_spacing: 3, font_family: "Geist" });
  check("simple runs with letter spacing refuse (a <Text> run can't space letters)", !!runs.problems?.some((p) => /can't space letters/.test(p)));
  const cased = compute({ text: "title case words", textCase: "title", font_family: "Geist" }).node as Extract<SkiaNode, { k: "text" }>;
  check("textCase is applied (title) and tagged as derived from text + textCase", cased.text.v === "Title Case Words" && cased.text.deps?.map((d) => d.param).join() === "text,textCase");
  const roboto = compute({ font_family: "Roboto" });
  check("an unshippable family reports why on the drawing (the canvas lists it, the export refuses)", !!roboto.problems?.some((p) => /Roboto/.test(p)));
}

// ---- 3. the renderer means what the IR says -----------------------------------------------------

{
  // a. lines drawn one by one at SkParagraph's own pitch = the paragraph whole.
  const texts = [
    "Wrapped text breaks at the width, kerned and aligned by SkParagraph — every line.",
    "Hard\n   indented after a break\n\nthen a blank line, “quotes”, ünïcödé and 12345",
  ];
  // Glyph ids and pen positions, line by line, of a laid-out paragraph.
  const glyphs = (p: Paragraph, dx = 0, dy = 0) =>
    p.getShapedLines().map((l) =>
      l.runs.flatMap((r) => Array.from(r.glyphs).map((g, i) => [g, r.positions[i * 2] + dx, r.positions[i * 2 + 1] + dy] as [number, number, number]))
    );
  let worstGeo = 0;
  let worst = { max: 0, differing: 0 };
  let totalDiffering = 0;
  let totalInk = 0;
  const flips: string[] = [];
  let at = "";
  let cases = 0;
  for (const text of texts)
    for (const [align, key] of [[CK.TextAlign.Left, "left"], [CK.TextAlign.Center, "center"], [CK.TextAlign.Right, "right"]] as const)
      for (const width of [180, 333.7])
        for (const size of [20, 37.5]) {
          const p = layout("geist", text, size, width, align);
          const lm = p.getLineMetrics();
          // Geometry: each line's own run (the renderer's algorithm) puts the
          // same glyphs at the same pen positions as the whole paragraph.
          // (Shaped lines skip empty lines and report whole-px baselines: match
          // them to the line metrics by baseline.)
          const shaped = p.getShapedLines();
          const whole = glyphs(p);
          lm.forEach((l, i) => {
            const sub = text.slice(l.startIndex, l.endExcludingWhitespaces);
            if (!sub) return;
            const q = layout("geist", sub, size, width, CK.TextAlign.Left);
            const mine = glyphs(q, l.left, l.baseline - q.getLineMetrics()[0].baseline)[0] ?? [];
            const j = shaped.findIndex((sl) => Math.abs(sl.baseline - l.baseline) < 0.5);
            const theirs = j >= 0 ? whole[j] : [];
            const n = Math.max(mine.length, theirs.length);
            for (let k = 0; k < n; k++) {
              const a = mine[k];
              const b = theirs[k];
              const d = !a || !b || a[0] !== b[0] ? Infinity : Math.max(Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]));
              if (d > worstGeo) {
                worstGeo = d;
                at = `${key} ${width} ${size} line ${i} glyph ${k}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`;
              }
            }
            q.delete();
          });
          // Pixels, at the pitch SkParagraph used (whole px: the rounding
          // hack; its float32 baselines sit ~2e-6 off it) and off the
          // position grid's boundaries (glyphs snap to it, so a 1-ulp
          // difference in a coordinate that lands ON a boundary flips a
          // glyph a pixel — x 31.3 / y 40.3 never do here).
          const pitch = lm.length > 1 ? Math.round(lm[1].baseline - lm[0].baseline) : 0;
          const base = { text, size, x: 31.3, y: 40.3, width: s(width), align: key as "left" | "center" | "right" };
          const v1 = render(sceneOf([textNode(base)]));
          const lines = render(sceneOf([textNode({ ...base, lineHeight: s(pitch || 30), baselineOffset: s(lm[0].baseline), anchor: "top" })]));
          p.delete();
          cases++;
          const d = diff(v1.px, lines.px);
          totalDiffering += d.differing;
          totalInk += inkCount(v1.px);
          if (d.differing) flips.push(`${key} ${width} ${size}: ${d.differing} px (max ${d.max})`);
          if (v1.problems.length || lines.problems.length) worst = { max: 255, differing: -1 };
        }
  check(
    `lines drawn one by one put every glyph where SkParagraph's whole paragraph does (${cases} text × align × width × size cases: same glyphs, pen positions within 1e-3 px — measured ≤ ${worstGeo.toExponential(1)})`,
    worstGeo <= 1e-3,
    at
  );
  // SkParagraph's own run positions accumulate across lines in float32
  // (~3e-4 px off at line 10); a glyph whose position lands near a subpixel
  // bin edge then draws one bin over — measured, not pixel-identical.
  check(
    `…and draw the same pixels but for those float32 bin flips (${totalDiffering} of ${totalInk} ink px over ${cases} cases${flips.length ? `: ${flips.join("; ")}` : ""})`,
    worst.max === 0 && totalDiffering <= totalInk * 0.002
  );

  // b. a fractional lineHeight lands each line exactly: = one-line blocks
  //    anchored at their own baselines.
  const L = 47.3;
  const text = "First line\nsecond line\nthird";
  const block = render(sceneOf([textNode({ text, size: 36, x: 0, y: 100.25, width: s(SIZE), align: "center", lineHeight: s(L), anchor: "baseline" })]));
  const parts = render(sceneOf(text.split("\n").map((t, i) => textNode({ text: t, size: 36, x: 0, y: 100.25 + i * L, width: s(SIZE), align: "center", lineHeight: s(L), anchor: "baseline" }))));
  const db = diff(block.px, parts.px);
  check(`lineHeight ${L}: line i lands exactly i × ${L} below the first (≡ ${text.split("\n").length} one-line blocks at their baselines, pixel-identical)`, db.max === 0 && inkCount(block.px) > 1500, JSON.stringify(db));
  // …and the first baseline really is y: the same as a raw CanvasKit paragraph
  // drawn at y − its own baseline.
  const raw = surface((c) => {
    const p = layout("geist", "First line", 36, SIZE, CK.TextAlign.Left);
    c.drawParagraph(p, 20, 100.25 - p.getLineMetrics()[0].baseline);
    p.delete();
  });
  const one = render(sceneOf([textNode({ text: "First line", size: 36, x: 20, y: 100.25, width: s(SIZE), align: "left", lineHeight: s(L), anchor: "baseline" })]));
  // (raw paragraph paints black by default — compare alpha only)
  let am = 0;
  for (let i = 3; i < raw.length; i += 4) am = Math.max(am, Math.abs(raw[i] - one.px[i]));
  check("anchor baseline puts the first baseline exactly at y (alpha ≡ a CanvasKit paragraph at y − baseline)", am === 0, `max alpha Δ ${am}`);

  // c. every anchor = a baseline anchor at the computed baseline.
  const asc = (1005 / 1000) * 30;
  const desc = (295 / 1000) * 30;
  let worstA = 0;
  let atA = "";
  for (const anchor of ["top", "middle", "bottom"] as const) {
    const k = anchor === "top" ? 0 : anchor === "middle" ? 0.5 : 1;
    // paragraph with lineHeight (+ default and explicit baselineOffset)
    for (const off of [undefined, 21.7]) {
      const lh = 41.2;
      const n = 3;
      const o = off ?? (lh - (asc + desc)) / 2 + asc;
      const a = render(sceneOf([textNode({ text: "a\nbb\nccc", size: 30, x: 10, y: 260, width: s(400), lineHeight: s(lh), anchor, ...(off !== undefined ? { baselineOffset: s(off) } : {}) })]));
      const b = render(sceneOf([textNode({ text: "a\nbb\nccc", size: 30, x: 10, y: 260 - k * n * lh + o, width: s(400), lineHeight: s(lh), anchor: "baseline", baselineOffset: s(o) })]));
      const d = diff(a.px, b.px).max;
      if (d > worstA) [worstA, atA] = [d, `paragraph ${anchor} off ${off}`];
    }
    // paragraph without lineHeight: the laid-out height
    const p = layout("geist", "a\nbb", 30, 400);
    const h = p.getHeight();
    p.delete();
    const a2 = render(sceneOf([textNode({ text: "a\nbb", size: 30, x: 10, y: 260, width: s(400), anchor })]));
    const b2 = render(sceneOf([textNode({ text: "a\nbb", size: 30, x: 10, y: 260 - k * h, width: s(400) })]));
    const d2 = diff(a2.px, b2.px).max;
    if (d2 > worstA) [worstA, atA] = [d2, `paragraph ${anchor} no lineHeight`];
    // one line (no width): the line box
    const tf = CK.Typeface.MakeFreeTypeFaceFromData(GEIST)!;
    const font = new CK.Font(tf, 30);
    const m = font.getMetrics();
    const A = -m.ascent;
    const D = m.descent;
    for (const lh of [undefined, 50]) {
      const box = lh ?? A + D;
      const base = 260 - k * box + (box - (A + D)) / 2 + A;
      const a3 = render(sceneOf([textNode({ text: "One line", size: 30, x: 100, y: 260, anchor, ...(lh ? { lineHeight: s(lh) } : {}) })]));
      const b3 = render(sceneOf([textNode({ text: "One line", size: 30, x: 100, y: base })]));
      const d3 = diff(a3.px, b3.px).max;
      if (d3 > worstA) [worstA, atA] = [d3, `one line ${anchor} lh ${lh}`];
    }
    font.delete();
    tf.delete();
  }
  check("every anchor (top / middle / bottom; paragraph with and without lineHeight, default and explicit baselineOffset; one line) ≡ a baseline anchor at the computed baseline", worstA === 0, atA);

  // d. letter spacing: half before each glyph, every advance + ls.
  const p0 = layout("geist", "Spaced", 48, 1e5);
  const p6 = layout("geist", "Spaced", 48, 1e5, CK.TextAlign.Left, 6);
  const pos = (p: Paragraph) => Array.from(p.getShapedLines()[0].runs[0].positions).filter((_, i) => i % 2 === 0);
  const x0 = pos(p0);
  const x6 = pos(p6);
  const halfBefore = x6.every((x, i) => Math.abs(x - (x0[i] + 3 + i * 6)) < 1e-3);
  check("SkParagraph letter spacing: glyph i moves by ls / 2 + i·ls, the run grows by n·ls (so the node shifts x by −ls / 2 to match Chromium's all-after)", halfBefore && Math.abs(p6.getLongestLine() - p0.getLongestLine() - 36) < 1e-3, `${x0.slice(0, 3)} / ${x6.slice(0, 3)}`);
  p0.delete();
  p6.delete();
  const r0 = render(sceneOf([textNode({ text: "Spaced", size: 48, x: 0, y: 200, width: s(SIZE), align: "left", anchor: "baseline" })]));
  const r6 = render(sceneOf([textNode({ text: "Spaced", size: 48, x: 0, y: 200, width: s(SIZE), align: "left", anchor: "baseline", letterSpacing: s(6) })]));
  const b0 = inkBox(r0.px);
  const b6 = inkBox(r6.px);
  check("…and the renderer draws it (ink starts 3 px later, ends 3 + 5×6 px later)", b6.x0 - b0.x0 === 3 && b6.x1 - b0.x1 === 33, `${JSON.stringify(b0)} → ${JSON.stringify(b6)}`);
  const bad = render(sceneOf([textNode({ text: "x", size: 20, x: 10, y: 50, letterSpacing: s(2) })]));
  check("letterSpacing on one-line text is reported (a run can't space letters)", bad.problems.some((p) => /letterSpacing needs a width/.test(p)));

  // e. a group's blendMode blends a paragraph's glyphs.
  const bg: [number, number, number, number] = [0.2, 0.5, 0.8, 1];
  const color: [number, number, number, number] = [1, 0.6, 0.2, 1];
  const para = (blendMode?: "multiply" | "difference") =>
    render(
      sceneOf(
        [{ k: "group", ...(blendMode ? { blendMode } : {}), children: [{ ...textNode({ text: "I", size: 400, x: 0, y: 470, width: s(SIZE), align: "center", anchor: "baseline", lineHeight: s(400) }), paint: { style: "fill", color: s(color) } }] }],
        bg
      )
    );
  const over = para();
  const mul = para("multiply");
  const dif = para("difference");
  // The middle of the I's stem, fully covered.
  const at2 = (p: Px) => Array.from(p.slice((300 * SIZE + 256) * 4, (300 * SIZE + 256) * 4 + 3));
  const want = (f: (a: number, b: number) => number) => bg.slice(0, 3).map((b, i) => Math.round(f(color[i], b) * 255));
  const close = (a: number[], b: number[]) => a.every((x, i) => Math.abs(x - b[i]) <= 1);
  check(
    "a paragraph under a multiply / difference group blends its glyphs (stem = the formula ±1/255; srcOver = the text color)",
    close(at2(mul.px), want((s2, d) => s2 * d)) && close(at2(dif.px), want((s2, d) => Math.abs(s2 - d))) && close(at2(over.px), color.slice(0, 3).map((c) => Math.round(c * 255))),
    `${at2(mul.px)} / ${at2(dif.px)} / ${at2(over.px)}`
  );
  // Why the mode rides the paragraph's paint rather than a layer Group with
  // the blend: a layer composites its whole bounds, so a mode that acts on
  // transparent source (srcIn, dstIn, src…) wipes the backdrop around the
  // glyphs; per-glyph blending (the renderer, React Native's own paint)
  // leaves it. Measured over the same backdrop, CanvasKit CPU:
  for (const mode of ["multiply", "srcIn", "dstIn"] as const) {
    const viaPaint = render(sceneOf([{ k: "group", blendMode: mode, children: [{ ...textNode({ text: "Layer", size: 160, x: 0, y: 300, width: s(SIZE), align: "center", anchor: "baseline", lineHeight: s(160) }), paint: { style: "fill", color: s(color) } }] }], bg));
    const viaLayer = surface((c) => {
      c.drawColor(CK.Color4f(...bg));
      const lp = new CK.Paint();
      lp.setBlendMode((CK.BlendMode as unknown as Record<string, never>)[mode.charAt(0).toUpperCase() + mode.slice(1)]);
      c.saveLayer(lp);
      const r = renderScene(CK, c, sceneOf([{ ...textNode({ text: "Layer", size: 160, x: 0, y: 300, width: s(SIZE), align: "center", anchor: "baseline", lineHeight: s(160) }), paint: { style: "fill", color: s(color) } }]), { assets: (id) => assetBytes[id] ?? null });
      c.restore();
      (globalThis as { __rel?: () => void }).__rel = r.release;
      lp.delete();
    });
    (globalThis as { __rel?: () => void }).__rel?.();
    const d = diff(viaPaint.px, viaLayer);
    note(`blend ${mode}: per-glyph paint vs a layer Group — ${d.differing} px differ (max ${d.max}/255)${d.differing > SIZE * SIZE * 0.5 ? " — the layer wipes the backdrop" : ""}`);
    if (mode === "multiply") check("…a separable mode (multiply) is the same either way (≤ 1/255)", d.max <= 1, JSON.stringify(d));
    else check(`…but ${mode} as a layer clears the backdrop around the glyphs (> half the canvas differs): the paint is the only exact carrier`, d.differing > SIZE * SIZE * 0.5, JSON.stringify(d));
  }
  const unknown = render(sceneOf([textNode({ text: "x", size: 20, x: 10, y: 50, anchor: "baseline-ish" as never })]));
  check("an unknown anchor is reported, not guessed", unknown.problems.some((p) => /unknown anchor/.test(p)));
}

// ---- 4. the export ---------------------------------------------------------------------------------

// The emitted text helpers, run on CanvasKit through a React-Native-Skia-
// shaped shim (RN web's JsiSk* wrappers are this thin over CanvasKit).
const RN_BLEND = ["Clear", "Src", "Dst", "SrcOver", "DstOver", "SrcIn", "DstIn", "SrcOut", "DstOut", "SrcATop", "DstATop", "Xor", "Plus", "Modulate", "Screen", "Overlay", "Darken", "Lighten", "ColorDodge", "ColorBurn", "HardLight", "SoftLight", "Difference", "Exclusion", "Multiply", "Hue", "Saturation", "Color", "Luminosity"];
const BlendMode = Object.fromEntries(RN_BLEND.map((n, i) => [n, i]));
const TextAlign = { Left: 0, Right: 1, Center: 2 };
const transparent = new CK.Paint();
transparent.setColor(CK.TRANSPARENT);
const Skia = {
  XYWHRect: (x: number, y: number, w: number, h: number) => CK.XYWHRect(x, y, w, h),
  Color: (c: number[]) => CK.Color4f(c[0], c[1], c[2], c[3]),
  Paint: () => {
    const p = new CK.Paint();
    return {
      raw: p,
      setColor: (c: Float32Array) => p.setColor(c),
      setAlphaf: (a: number) => p.setAlphaf(a),
      setBlendMode: (m: number) => p.setBlendMode((CK.BlendMode as unknown as Record<string, unknown>)[RN_BLEND[m]] as never),
    };
  },
  PictureRecorder: () => {
    const r = new CK.PictureRecorder();
    return { beginRecording: (rect: Float32Array) => r.beginRecording(rect), finishRecordingAsPicture: () => r.finishRecordingAsPicture() };
  },
  ParagraphBuilder: {
    Make: (ps: { textAlign: number; textStyle: Record<string, unknown> }, prov: unknown) => {
      const b = CK.ParagraphBuilder.MakeFromFontProvider(
        new CK.ParagraphStyle({ textStyle: { color: CK.BLACK, ...ps.textStyle }, textAlign: { value: ps.textAlign } as never }),
        prov as never
      );
      const shim = {
        pushStyle: (style: Record<string, unknown>, paint: { raw: InstanceType<CanvasKit["Paint"]> }) => {
          b.pushPaintStyle(new CK.TextStyle(style), paint.raw, transparent);
          return shim;
        },
        addText: (t: string) => {
          b.addText(t);
          return shim;
        },
        build: () => {
          const p = b.build();
          return {
            layout: (w: number) => p.layout(w),
            paint: (c: { drawParagraph: (p: Paragraph, x: number, y: number) => void }, x: number, y: number) => c.drawParagraph(p, x, y),
            getLineMetrics: () => p.getLineMetrics(),
            getHeight: () => p.getHeight(),
          };
        },
      };
      return shim;
    },
  },
};
const helperJs = (await esbuild.transform(`${TEXT_BASELINE_Y_SOURCE}\n${TEXT_RUN_SOURCE}\n${MAKE_TEXT_PICTURE_SOURCE}`, { loader: "ts" })).code;
const helpers = new Function("Skia", "TextAlign", "BlendMode", `${helperJs}\nreturn { makeTextPicture, textBaselineY };`)(Skia, TextAlign, BlendMode) as {
  makeTextPicture: (...a: unknown[]) => InstanceType<CanvasKit["SkPicture" & keyof CanvasKit]>;
  textBaselineY: (...a: unknown[]) => number;
};

// The balanced call `name(…)` expressions in a source.
function calls(src: string, name: string): string[] {
  const out: string[] = [];
  let i = src.indexOf(`${name}(`);
  while (i >= 0) {
    let depth = 0;
    let j = i + name.length;
    for (; j < src.length; j++) {
      if (src[j] === "(") depth++;
      else if (src[j] === ")" && --depth === 0) break;
    }
    out.push(src.slice(i, j + 1));
    i = src.indexOf(`${name}(`, j);
  }
  return out;
}

{
  // a. the emitted helpers ≡ the renderer, through the static calls the
  //    emitter writes for a matrix of hand-built scenes.
  let worst = 0;
  let at = "";
  let n = 0;
  const geistProv = provider("geist");
  const variants: { label: string; node: Extract<SkiaNode, { k: "text" }>; group?: { opacity?: number; blendMode?: "multiply" | "difference" } }[] = [];
  const para = "Exported paragraphs place every line where the preview does, wrapped or not.";
  for (const anchor of [undefined, "baseline", "top", "middle", "bottom"] as const)
    for (const lh of [undefined, 33.3])
      for (const align of ["left", "center", "right"] as const) {
        variants.push({
          label: `${anchor ?? "∅"}/${lh ?? "∅"}/${align}`,
          node: textNode({ text: para, size: 24, x: 20.5, y: 250.25, width: s(300.4), align, ...(anchor ? { anchor } : {}), ...(lh ? { lineHeight: s(lh) } : {}), letterSpacing: s(1.5) }),
        });
      }
  variants.push({ label: "offset + multiply group at 0.6", node: textNode({ text: "Two\nlines", size: 60, x: -16128, y: 256, width: s(32768), align: "center", anchor: "middle", lineHeight: s(70.7), baselineOffset: s(50.1) }), group: { opacity: 0.6, blendMode: "multiply" } });
  variants.push({ label: "paint blend wins over the group's", node: { ...textNode({ text: "Own mode", size: 60, x: 0, y: 256, width: s(SIZE), align: "center", anchor: "middle" }), paint: { style: "fill", color: s([1, 0.5, 0.2, 0.9] as [number, number, number, number]), opacity: s(0.8), blendMode: "difference" } }, group: { blendMode: "multiply" } });
  const bg: [number, number, number, number] = [0.2, 0.4, 0.7, 1];
  for (const v of variants) {
    const child: SkiaNode = v.group ? { k: "group", ...(v.group.opacity !== undefined ? { opacity: s(v.group.opacity) } : {}), ...(v.group.blendMode ? { blendMode: v.group.blendMode } : {}), children: [v.node] } : v.node;
    const scene = sceneOf([child], v.group ? bg : undefined);
    const r = exportSkiaScene(scene, [], [], { name: "t", timeline: TIMELINE, runtimeSource });
    const tsx = r.files?.["ToolboxScene.tsx"] ?? "";
    const call = calls(tsx, "makeTextPicture").find((c) => /^makeTextPicture\(FONTS\d+/.test(c));
    const legacy = /makeParagraph\(FONTS/.test(tsx);
    let got: Px | null = null;
    if (call) {
      const ids = [...new Set(call.match(/FONTS\d+/g) ?? [])];
      const pic = new Function("makeTextPicture", "TextAlign", "BlendMode", ...ids, `return ${call};`)(helpers.makeTextPicture, TextAlign, BlendMode, ...ids.map(() => geistProv)) as { delete(): void };
      got = surface((c) => {
        if (v.group) c.drawColor(CK.Color4f(...bg));
        c.drawPicture(pic as never);
      });
      pic.delete();
    }
    const want = render(scene);
    n++;
    if (!got) {
      if (!(legacy && v.label.startsWith("∅/∅"))) {
        worst = 255;
        at = `${v.label}: no makeTextPicture call (${r.problems.join(" | ")})`;
      }
      continue;
    }
    const d = diff(want.px, got).max;
    if (d > worst) [worst, at] = [d, `${v.label}: max ${d}`];
    // What Wave 2's export shipped for it: RN draws a paragraph with its own
    // paint, so without the fold the group's mode never reached the glyphs.
    if (call && v.group?.blendMode) {
      const plain = call.replace(/BlendMode\.\w+\)$/, "BlendMode.SrcOver)");
      const ids = [...new Set(plain.match(/FONTS\d+/g) ?? [])];
      const pic = new Function("makeTextPicture", "TextAlign", "BlendMode", ...ids, `return ${plain};`)(helpers.makeTextPicture, TextAlign, BlendMode, ...ids.map(() => geistProv)) as { delete(): void };
      const dropped = surface((c) => {
        c.drawColor(CK.Color4f(...bg));
        c.drawPicture(pic as never);
      });
      pic.delete();
      const dd = diff(want.px, dropped);
      note(`${v.label}: with the blend dropped (Wave 2's export) ${dd.differing} px differ, max ${dd.max}/255`);
    }
  }
  check(`the emitted makeTextPicture (run through an RN-Skia shim on CanvasKit) draws what the renderer draws — ${n} anchor × lineHeight × align × spacing × group opacity / blend cases, pixel-identical`, worst === 0, at);

  // b. one-line anchors: the emitted textBaselineY = the renderer's line box.
  let worstY = 0;
  const tf = CK.Typeface.MakeFreeTypeFaceFromData(GEIST)!;
  for (const anchor of ["top", "middle", "bottom"] as const)
    for (const lh of [undefined, 44.4]) {
      const node = textNode({ text: "One run", size: 30, x: 60, y: 200, anchor, ...(lh ? { lineHeight: s(lh) } : {}) });
      const r = exportSkiaScene(sceneOf([node]), [], [], { name: "t", timeline: TIMELINE, runtimeSource });
      const call = calls(r.files?.["ToolboxScene.tsx"] ?? "", "textBaselineY").find((c) => /^textBaselineY\(FONT\d+/.test(c)) ?? "";
      const ids = [...new Set(call.match(/FONT\d+/g) ?? [])];
      const font = new CK.Font(tf, 30);
      const y = call ? (new Function("textBaselineY", ...ids, `return ${call};`)(helpers.textBaselineY, ...ids.map(() => font)) as number) : NaN;
      const got = surface((c) => {
        const p = new CK.Paint();
        p.setColor(CK.WHITE);
        p.setAntiAlias(true);
        c.drawText("One run", 60, y, p, font);
        p.delete();
      });
      font.delete();
      const d = Number.isFinite(y) ? diff(render(sceneOf([node])).px, got).max : 255;
      worstY = Math.max(worstY, d);
    }
  tf.delete();
  check("one-line text: the emitted textBaselineY puts the run's baseline where the renderer does (every anchor, with and without lineHeight)", worstY === 0, `max ${worstY}`);

  // c. what reaches the paint, and what stays v1.
  const fold = exportSkiaScene(sceneOf([{ k: "group", opacity: s(0.5), blendMode: "screen", children: [{ k: "group", opacity: s(0.8), children: [textNode({ text: "x", size: 20, x: 0, y: 30, width: s(100) })] }] }]), [], [], { name: "t", timeline: TIMELINE, runtimeSource });
  const foldCall = calls(fold.files?.["ToolboxScene.tsx"] ?? "", "makeTextPicture").find((c) => c.startsWith("makeTextPicture(FONTS")) ?? "";
  check("a group's blendMode alone sends a v1 paragraph through makeTextPicture, its mode and every enclosing opacity folded into the paint", /, BlendMode\.Screen\)$/.test(foldCall) && /1 \* 0\.5\)\) \* 0\.8\)\)/.test(foldCall), foldCall);
  const v1 = exportSkiaScene(sceneOf([textNode({ text: "x", size: 20, x: 0, y: 30, width: s(100) })]), [], [], { name: "t", timeline: TIMELINE, runtimeSource });
  check("v1 paragraph text (no lineHeight / anchor / spacing / blend) still ships as one <Paragraph> + makeParagraph", /<Paragraph/.test(v1.files?.["ToolboxScene.tsx"] ?? "") && !/makeTextPicture/.test(v1.files?.["ToolboxScene.tsx"] ?? ""));

  // d. refusals.
  const lsRun = exportSkiaScene(sceneOf([textNode({ text: "x", size: 20, x: 0, y: 30, letterSpacing: s(1) })]), [], [], { name: "t", timeline: TIMELINE, runtimeSource });
  check("export: letterSpacing on one-line text refuses", !lsRun.files && lsRun.problems.some((p) => /letterSpacing needs a width/.test(p)), lsRun.problems.join(" | "));
  const badAnchor = exportSkiaScene(sceneOf([textNode({ text: "x", size: 20, x: 0, y: 30, anchor: "centre" as never })]), [], [], { name: "t", timeline: TIMELINE, runtimeSource });
  check("export: an unknown anchor refuses", !badAnchor.files && badAnchor.problems.some((p) => /unknown text anchor/.test(p)));
  const blendPara = exportSkiaScene(sceneOf([{ ...textNode({ text: "x", size: 20, x: 0, y: 30, width: s(100) }), paint: { style: "fill", color: s([1, 1, 1, 1] as [number, number, number, number]), blendMode: "multiply" } }]), [], [], { name: "t", timeline: TIMELINE, runtimeSource });
  check("export: a paragraph's own blend mode exports now (it rides its paint)", !!blendPara.files, blendPara.problems.join(" | "));
  const node = (params: Record<string, unknown>) => {
    const g = { nodes: [{ id: "k", type: "skia-text", params: { ...Object.fromEntries((getNodeDef("skia-text") as NodeDefinition).params.map((p) => [p.name, p.default])), ...params } }, { id: "c", type: "skia-canvas", params: { background_on: false } }], edges: [{ id: "e", source: "k", sourceHandle: "out:primary", target: "c", targetHandle: "in:scene" }] };
    return { nodes: g.nodes, edges: g.edges, targetId: "c", name: "t", canvas: { width: SIZE, height: SIZE }, timeline: TIMELINE, runtimeSource };
  };
  for (const [label, p, re] of [
    ["Roboto", { font_family: "Roboto" }, /Google Fonts family/],
    ["Inter weight 700", { font_family: "Inter", font_weight: 700 }, /default instance/],
    ["italic", { italic: true }, /no italic face/],
  ] as const) {
    const r = exportSkia(node(p));
    check(`export: Text (Skia) with ${label} refuses with the reason`, !r.files && r.problems.some((x) => re.test(x)), r.problems.join(" | "));
  }
  // Through lane I's asset seam (collect → resolve → exportSkia({ assets })),
  // as the editor and the CLI export: the font's bytes and its OFL text ship.
  const req = node({ font_family: "Inter" });
  const ok = exportSkia({ ...req, assets: await resolveSkiaExportAssets(collectSkiaExportAssets(req), nodeResolveAsset()) });
  const m = ok.files ? JSON.parse(ok.files["manifest.json"]) : null;
  const interFile = ok.files?.["assets/inter.ttf.b64"];
  check(
    "export: the bundled Inter ships its bytes and its OFL text (assets/inter.ttf + assets/Inter-OFL.txt)",
    !!m &&
      m.assets.some((a: { id: string; bundled?: boolean; license?: string }) => a.id === "inter" && a.bundled && a.license === "assets/Inter-OFL.txt") &&
      !!interFile &&
      Buffer.from(interFile, "base64").equals(Buffer.from(INTER)) &&
      ok.files?.["assets/Inter-OFL.txt"] === fs.readFileSync(path.join(ROOT, "public/fonts/Inter-OFL.txt"), "utf8"),
    JSON.stringify(m?.assets)
  );
  const bare = exportSkia(req);
  check("…and without the seam it lists the editor URL and warns, rather than ship nothing silently", !!bare.files && bare.warnings.some((w) => /Asset "inter"/.test(w)), bare.warnings.join(" | "));
}

{
  // e. every compare fixture canvas exports; the harness bundle type-checks
  //    and is today's export; its worklets are declared above their callers.
  const G = fx.textGraph();
  const canvases = G.nodes.filter((n) => n.type === "skia-canvas").map((n) => n.id);
  const bad: string[] = [];
  for (const id of canvases) {
    const r = await checkExportable({ nodes: G.nodes, edges: G.edges, canvasId: id, canvas: { width: SIZE, height: SIZE }, timeline: TIMELINE, slot: `text-${id}` });
    if (r.problems.length || !r.files) bad.push(`${id}: ${r.problems.join(" | ")}`);
  }
  check(`every Skia Canvas of the compare fixture exports (${canvases.length} pairs)`, !bad.length, bad.join(" ; "));

  const B = fx.textBundleGraph();
  const timeline = { ...TIMELINE, markers: aurora.AURORA_MARKERS };
  const r = await checkExportable({ nodes: B.nodes, edges: B.edges, canvasId: B.targetId, name: "Text (Skia)", canvas: { width: SIZE, height: SIZE }, timeline, typecheck: true, slot: "text-bundle" });
  check("the harness text bundle exports", !!r.files && !r.problems.length, r.problems.join(" | "));
  check(`…and type-checks in skia-harness${r.typecheck.ran ? "" : " — skipped"}`, r.typecheck.ok, r.typecheck.output);
  for (const animation of ["native", "baked"] as const) {
    const m = await checkExportable({ nodes: B.nodes, edges: B.edges, canvasId: B.targetId, name: "Text (Skia)", canvas: { width: SIZE, height: SIZE }, timeline, typecheck: true, animation, slot: `text-bundle-${animation}` });
    check(`…and in ${animation} mode it exports and type-checks${m.typecheck.ran ? "" : " (type-check skipped)"}`, !!m.files && !m.problems.length && m.typecheck.ok, [...m.problems, m.typecheck.output].join(" | "));
  }
  const bundleReq = { nodes: B.nodes, edges: B.edges, targetId: B.targetId, name: "Text (Skia)", canvas: { width: SIZE, height: SIZE }, timeline, runtimeSource };
  const fresh = exportSkia({ ...bundleReq, assets: await resolveSkiaExportAssets(collectSkiaExportAssets(bundleReq), nodeResolveAsset()) });
  const dir = path.join(ROOT, "skia-harness/src/bundle-text");
  const stale = Object.entries(fresh.files ?? {}).filter(([f, text]) => {
    if (f.endsWith(".b64")) {
      const bin = path.join(dir, f.slice(0, -4));
      return !fs.existsSync(bin) || !fs.readFileSync(bin).equals(Buffer.from(text, "base64"));
    }
    const p = path.join(dir, f);
    return !fs.existsSync(p) || fs.readFileSync(p, "utf8") !== text;
  });
  check(
    "skia-harness/src/bundle-text is today's export (fonts included)",
    !!fresh.files && !stale.length,
    `${stale.map(([f]) => f).join(", ")} differ — npx tsx scripts/export-skia.mts --fixture text --out skia-harness/src/bundle-text`
  );
  const tsx = fresh.files?.["ToolboxScene.tsx"] ?? "";
  check(
    "…its paragraphs carry their blend and the group opacity (difference at 0.85), and the bundled Geist / Inter ship as bytes with their OFL texts",
    /BlendMode\.Difference\)/.test(tsx) &&
      /\* 0\.85\)/.test(tsx) &&
      !!fresh.files?.["assets/geist.ttf.b64"] &&
      !!fresh.files?.["assets/inter.ttf.b64"] &&
      !!fresh.files?.["assets/Geist-OFL.txt"] &&
      !!fresh.files?.["assets/Inter-OFL.txt"] &&
      !fresh.warnings.length,
    fresh.warnings.join(" | ")
  );
  // Worklet capture order: a worklet may call only worklets declared above it.
  const decl = /^function (\w+)\(/gm;
  const found: { name: string; at: number }[] = [];
  for (let m2 = decl.exec(tsx); m2; m2 = decl.exec(tsx)) found.push({ name: m2[1], at: m2.index });
  const errs: string[] = [];
  found.forEach((d, i) => {
    const body = tsx.slice(d.at, found[i + 1]?.at ?? tsx.length);
    if (!/"worklet";/.test(body)) return;
    for (const later of found.slice(i + 1)) if (new RegExp(`\\b${later.name}\\(`).test(body)) errs.push(`${d.name} calls ${later.name}, declared below it`);
  });
  check(`the text helpers are declared above their callers (${found.map((f) => f.name).join(", ")})`, !errs.length && found.some((f) => f.name === "makeTextPicture"), errs.join("; "));
}

for (const p of Object.values(provs)) p.delete();
transparent.delete();
WHITE_AA.delete();
CLEAR.delete();

if (failures) {
  console.error(`\ncheck-skia-text: ${failures} failure(s)`);
  process.exit(1);
}
console.log("\ncheck-skia-text: all checks passed.");
