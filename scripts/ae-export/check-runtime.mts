// The After Effects runtime (src/lib/ae-export/runtime): build.jsx is ES3 and
// evaluates nothing, its tables cover every scene.json enum, its hand-written
// JSON reader agrees with JSON.parse (run under Node), the fixtures validate,
// and the synthesized gradient preset (.ffx) keeps its golden bytes.
//
// The live half — the same fixtures built, read back and rendered in After
// Effects 26.5 — is scripts/ae-export-spike/run.mts (needs AE; not a gate).

import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import * as acorn from "acorn";

import { makeChecker } from "./harness.mts";
import { generatedModule } from "../ae-export-spike/gen-runtime.mts";
import { BUILD_JSX_SOURCE, BUILD_JSX_VERSION } from "@/lib/ae-export/runtime";
import {
  gradientColorsXml,
  gradientPresetPath,
  parseRifx,
  synthesizeGradientPreset,
  synthesizeScenePresets,
  type RifxNode,
} from "@/lib/ae-export/runtime/ffx";
import { validateAeScene } from "@/lib/ae-export/runtime/validate";
import type { AeBlendMode, AeLayerKind, AeScene, AeShapeItem, AeTextDocument } from "@/lib/ae-export/types";

/* eslint-disable @typescript-eslint/no-explicit-any */

const REPO = join(dirname(fileURLToPath(import.meta.url)), "../..");
const RUNTIME = join(REPO, "src/lib/ae-export/runtime");
const FIXTURES = join(REPO, "scripts/fixtures/ae-export");

// sha256 of synthesizeGradientPreset(GOLDEN) — change only with a reason
// (and re-run the spike's GUI check, spec §13).
const GOLDEN = {
  kind: "fill" as const,
  stops: {
    colors: [
      { offset: 0, color: [1, 0, 0] as [number, number, number] },
      { offset: 0.5, color: [0, 1, 0] as [number, number, number], midpoint: 0.4 },
      { offset: 1, color: [0, 0, 1] as [number, number, number] },
    ],
    opacities: [
      { offset: 0, opacity: 1 },
      { offset: 1, opacity: 0.25 },
    ],
  },
};
const GOLDEN_SHA256 = "1c510da8883039cd35dcdf558194e0093a67f8a21a83d586b1621f63a0fab2f1";
const GOLDEN_LENGTH = 2804;

export default async function run(): Promise<number> {
  const c = makeChecker("runtime");
  const src = readFileSync(join(RUNTIME, "build.jsx"), "utf8");

  // ---- build.jsx is ES3, ASCII, static ---------------------------------------
  for (const f of ["src/lib/ae-export/runtime/build.jsx", "scripts/ae-export-spike/hook.jsx", "scripts/ae-export-spike/probe.jsx"]) {
    const text = readFileSync(join(REPO, f), "utf8");
    let err = "";
    try {
      acorn.parse(text, { ecmaVersion: 3, sourceType: "script" });
    } catch (e) {
      err = (e as Error).message;
    }
    c.check(`${f} parses as ES3 (acorn ecmaVersion 3)`, err === "", err);
  }
  const nonAscii = [...src].findIndex((ch) => ch.charCodeAt(0) > 0x7e || (ch.charCodeAt(0) < 0x20 && ch !== "\n"));
  c.check("build.jsx is plain ASCII (ExtendScript's source decoding is not trusted)", nonAscii < 0, nonAscii >= 0 ? `offset ${nonAscii}` : undefined);
  const code = stripComments(src);
  for (const [re, what] of [
    [/\beval\s*\(/, "eval("],
    [/\bnew\s+Function\b|\bFunction\s*\(/, "Function constructor"],
    [/\$\.evalFile|\.evalFile\s*\(/, "$.evalFile"],
    [/#include|@include/, "#include"],
    [/\bapp\.newProject\s*\(/, "app.newProject() (blocks aerender's core)"],
  ] as const) {
    c.check(`build.jsx never uses ${what}`, !re.test(code));
  }
  c.check("build-jsx.generated.ts is build.jsx verbatim", BUILD_JSX_SOURCE === src && readFileSync(join(RUNTIME, "build-jsx.generated.ts"), "utf8") === generatedModule(src),
    "run npx tsx scripts/ae-export-spike/gen-runtime.mts");
  c.check("BUILD_JSX_VERSION is read from build.jsx", /^\d+\.\d+\.\d+$/.test(BUILD_JSX_VERSION), BUILD_JSX_VERSION);

  // ---- tables cover the scene.json enums --------------------------------------
  const table = (name: string): Record<string, unknown> => {
    const m = new RegExp(`var ${name} = (\\{[\\s\\S]*?\\});`).exec(src);
    if (!m) throw new Error(`no table ${name} in build.jsx`);
    return vm.runInNewContext(`(${m[1]})`);
  };
  const BLEND: Record<AeBlendMode, true> = {
    normal: true, dissolve: true, darken: true, multiply: true, "color-burn": true, "classic-color-burn": true,
    "linear-burn": true, "darker-color": true, add: true, lighten: true, screen: true, "color-dodge": true,
    "classic-color-dodge": true, "linear-dodge": true, "lighter-color": true, overlay: true, "soft-light": true,
    "hard-light": true, "linear-light": true, "vivid-light": true, "pin-light": true, "hard-mix": true, difference: true,
    "classic-difference": true, exclusion: true, subtract: true, divide: true, hue: true, saturation: true, color: true,
    luminosity: true, "stencil-alpha": true, "stencil-luma": true, "silhouette-alpha": true, "silhouette-luma": true,
    "alpha-add": true, "luminescent-premul": true,
  };
  const SHAPE: Record<AeShapeItem["kind"], true> = {
    group: true, path: true, rect: true, ellipse: true, polystar: true, fill: true, stroke: true, "gradient-fill": true,
    "gradient-stroke": true, trim: true, offset: true, "round-corners": true, repeater: true, merge: true,
  };
  const JUSTIFY: Record<AeTextDocument["justification"], true> = {
    left: true, center: true, right: true, "full-left": true, "full-center": true, "full-right": true, full: true,
  };
  const KINDS: Record<AeLayerKind, true> = {
    shape: true, solid: true, footage: true, precomp: true, null: true, text: true, adjustment: true, camera: true, light: true,
  };
  const same = (a: object, b: object) => JSON.stringify(Object.keys(a).sort()) === JSON.stringify(Object.keys(b).sort());
  c.check("BLEND maps every AeBlendMode", same(table("BLEND"), BLEND), Object.keys(BLEND).filter((k) => !(k in table("BLEND"))));
  c.check("SHAPE_MATCH maps every AeShapeItem kind", same(table("SHAPE_MATCH"), SHAPE));
  c.check("JUSTIFY maps every justification", same(table("JUSTIFY"), JUSTIFY));
  c.check("MASK_MODE maps every mask mode", same(table("MASK_MODE"), { none: 1, add: 1, subtract: 1, intersect: 1, lighten: 1, darken: 1, difference: 1 }));
  c.check("MATTE maps every matte type", same(table("MATTE"), { LUMA: 1, LUMA_INVERTED: 1, ALPHA: 1, ALPHA_INVERTED: 1 }));
  for (const k of Object.keys(KINDS)) c.check(`createLayer handles layer kind "${k}"`, new RegExp(`k === "${k}"`).test(code));
  const shapeBlend = table("SHAPE_BLEND") as Record<string, number>;
  c.check("SHAPE_BLEND values are AE's 1-based menu positions 1–26", Object.values(shapeBlend).every((v) => Number.isInteger(v) && v >= 1 && v <= 26));

  // ---- the JSON reader, under Node ----------------------------------------------
  const m = /\/\* @json-begin[\s\S]*?\*\/([\s\S]*?)\/\* @json-end \*\//.exec(src);
  c.check("build.jsx marks its JSON reader with @json-begin / @json-end", !!m);
  if (m) {
    const J: { parse(s: string): any; stringify(v: unknown): string } = vm.runInNewContext(`${m[1]}\nTbxJson;`, {});
    const tricky = [
      "", "plain", 'quote " and backslash \\', "tab\tnew\nline\rcr\bb\ff", "slash / \u0000 nul", "\u2028 line sep \u2029 para sep",
      "\u00e9 caf\u00e9 \u2192 arrow \u2713", "\ud83d\ude00 astral (surrogate pair)", "\ud800 lone high surrogate", "\\u0041 not an escape",
      "\u001f\u007f", "x".repeat(70000), "\\".repeat(5000) + '"'.repeat(5000),
    ];
    for (const s of tricky) {
      const enc = JSON.stringify(s);
      let ok = false;
      try {
        ok = J.parse(enc) === s && JSON.parse(J.stringify(s)) === s && J.parse(J.stringify(s)) === s;
      } catch {
        ok = false;
      }
      c.check(`JSON reader round-trips ${JSON.stringify(s.length > 40 ? s.slice(0, 40) + "…" : s)}`, ok);
    }
    const nums = ["0", "-0", "1", "-1", "0.5", "-0.5", "1e3", "1E-7", "1.5e+300", "123456789012345680000", "5e-324", "0.1", "-12.75e-3"];
    for (const n of nums) {
      const got = J.parse(n);
      c.check(`number ${n}`, Object.is(got, JSON.parse(n)), got);
    }
    const docs = [
      "{}", "[]", '{"a":[1,{"b":null}],"c":true,"d":false}', ' \n\t{ "a" : [ 1 , 2 ] } \r\n', '{"a":1,"a":2}', '[[[[[]]]]]',
      "\ufeff" + '{"bom":1}', '{"constructor":1,"hasOwnProperty":2,"toString":"x"}',
    ];
    for (const d of docs) {
      let ok = false;
      try {
        ok = JSON.stringify(J.parse(d)) === JSON.stringify(JSON.parse(d.replace(/^\ufeff/, "")));
      } catch {
        ok = false;
      }
      c.check(`parses ${JSON.stringify(d).slice(0, 50)} like JSON.parse`, ok);
    }
    const bad = [
      "", " ", "{", "[1,]", '{"a":1,}', "01", "1.", ".5", "+1", "-", "1e", "tru", "nul", "NaN", "Infinity", "'x'", '"unterminated',
      '"bad \\x escape"', '"\\u12"', '"raw \n newline"', '{"a" 1}', '{a:1}', "[1 2]", "1 2", '{"__proto__":{"polluted":1}}',
      "[".repeat(300) + "]".repeat(300),
    ];
    for (const b of bad) {
      let threw = false;
      try {
        J.parse(b);
      } catch {
        threw = true;
      }
      c.check(`rejects ${JSON.stringify(b).slice(0, 40)}`, threw);
    }
    c.check("a rejected __proto__ key cannot pollute Object.prototype", ({} as any).polluted === undefined);
    // Random structures (seeded): parse(stringify) is the identity both ways.
    let seed = 0x9e3779b9;
    const rnd = () => ((seed = (Math.imul(seed ^ (seed >>> 15), 0x2c1b3c6d) + 0x6d2b79f5) >>> 0) / 4294967296);
    const rstr = () => {
      let s = "";
      const n = Math.floor(rnd() * 12);
      for (let i = 0; i < n; i++) s += String.fromCharCode(rnd() < 0.7 ? 32 + Math.floor(rnd() * 95) : Math.floor(rnd() * 0xffff));
      return s;
    };
    const rval = (d: number): unknown => {
      const t = rnd();
      if (d > 4 || t < 0.3) return [null, true, false, rnd() * 2e6 - 1e6, Math.floor(rnd() * 100), rstr()][Math.floor(rnd() * 6)];
      if (t < 0.65) return Array.from({ length: Math.floor(rnd() * 5) }, () => rval(d + 1));
      const o: Record<string, unknown> = {};
      for (let i = Math.floor(rnd() * 5); i > 0; i--) o[rstr() || "k"] = rval(d + 1);
      return o;
    };
    let fuzzOk = 0;
    const FUZZ = 400;
    for (let i = 0; i < FUZZ; i++) {
      const v = rval(0);
      const a = JSON.stringify(v);
      // Stringify values of the reader's own realm (vm arrays are not this
      // realm's Array; in ExtendScript there is one realm).
      if (JSON.stringify(J.parse(a)) === a && JSON.stringify(JSON.parse(J.stringify(J.parse(a)))) === a) fuzzOk++;
    }
    c.check(`${FUZZ} random documents round-trip both ways`, fuzzOk === FUZZ, `${fuzzOk}/${FUZZ}`);
    const big = JSON.stringify({ keys: Array.from({ length: 20000 }, (_, i) => ({ t: i / 30, v: [i * 0.5, -i], inInterp: "bezier", outInterp: "linear", easeIn: [{ speed: i, influence: 33.3 }] })) });
    const t0 = performance.now();
    const parsed = J.parse(big);
    const ms = performance.now() - t0;
    c.check(`a ${(big.length / 1e6).toFixed(1)} MB scene parses in linear time (${ms.toFixed(0)} ms under Node)`, parsed.keys.length === 20000 && ms < 2000, ms);

    // ---- fixtures ---------------------------------------------------------------
    const files = readdirSync(FIXTURES).filter((f) => f.endsWith(".scene.json")).sort();
    c.check("fixtures A (circle), B (matte/blur), gradient, text present", ["a-circle", "b-matte-blur", "c-gradient", "d-text"].every((n) => files.includes(`${n}.scene.json`)), files);
    for (const f of files) {
      const raw = readFileSync(join(FIXTURES, f), "utf8");
      const scene = JSON.parse(raw);
      const problems = validateAeScene(scene);
      c.check(`${f} validates against types.ts`, problems.length === 0, problems.slice(0, 5));
      c.check(`${f}: build.jsx's reader agrees with JSON.parse`, JSON.stringify(J.parse(raw)) === JSON.stringify(scene));
    }
  }

  // ---- the validator catches what build.jsx would trip on ----------------------
  const base = JSON.parse(readFileSync(join(FIXTURES, "b-matte-blur.scene.json"), "utf8")) as AeScene;
  const mutate = (label: string, fn: (s: any) => void, expect: RegExp) => {
    const s = structuredClone(base) as any;
    fn(s);
    const p = validateAeScene(s);
    c.check(`validator: ${label}`, p.some((x) => expect.test(x)), p);
  };
  mutate("effect mask of mode none (AE ignores it)", (s) => (s.comps[0].layers[2].masks[0].mode = "none"), /ignores a mask whose mode is "none"/);
  mutate("unknown blend mode", (s) => (s.comps[0].layers[2].blendingMode = "average"), /blendingMode: unknown/);
  mutate("key times not increasing", (s) => (s.comps[0].layers[0].transform.position.keys[1].t = 0), /key times must increase/);
  mutate("influence outside 0.1–100", (s) => (s.comps[0].layers[0].transform.position.keys[0].easeOut = [{ speed: 1, influence: 0 }]), /influence/);
  mutate("dangling parent", (s) => (s.comps[0].layers[1].parent = "nope"), /parent: no layer/);
  mutate("dangling matte", (s) => (s.comps[0].layers[2].matte.layer = "nope"), /matte.layer: no layer/);
  mutate("compositing mask past the last mask", (s) => (s.comps[0].layers[2].effects[0].compositingMask.mask = 2), /mask index 1–1/);
  mutate("footage path leaving the package", (s) => s.footage.push({ id: "x", path: "../x.png", kind: "image", alpha: "straight" }), /relative package path/);
  mutate("position and separated together", (s) => (s.comps[0].layers[3].transform.separated = { x: { v: 0 }, y: { v: 0 } }), /exactly one of position \/ separated/);
  mutate("4 dash pairs", (s) => s.comps[0].layers[1].contents[0].contents.push({ kind: "stroke", color: { v: [1, 1, 1] }, opacity: { v: 100 }, width: { v: 1 }, cap: "butt", join: "miter", miterLimit: 4, dashes: [1, 2, 3, 4].map(() => ({ dash: { v: 1 }, gap: { v: 1 } })) }), /at most 3/);
  mutate("path keys changing vertex count", (s) => {
    const sq = (n: number) => ({ vertices: Array.from({ length: n }, () => [0, 0]), inTangents: Array.from({ length: n }, () => [0, 0]), outTangents: Array.from({ length: n }, () => [0, 0]), closed: true });
    s.comps[0].layers[2].masks[0].path = { dims: 1, keys: [{ t: 0, v: sq(4), inInterp: "linear", outInterp: "linear" }, { t: 1, v: sq(5), inInterp: "linear", outInterp: "linear" }] };
  }, /constant vertex count/);
  mutate("main pointing nowhere", (s) => (s.main = "nope"), /main: no comp/);
  mutate("layer ref to a missing layer", (s) => (s.comps[0].layers[2].effects[0].props["ADBE Gaussian Blur 2-0003"] = { layerRef: "nope" }), /no layer "nope"/);
  mutate("keyed layer ref", (s) => (s.comps[0].layers[2].effects[0].props["ADBE Gaussian Blur 2-0003"] = { dims: 1, keys: [{ t: 0, v: { layerRef: "bg" }, inInterp: "hold", outInterp: "hold" }] }), /layer refs are static/);
  mutate("effect param by display name", (s) => (s.comps[0].layers[2].effects[0].props["Blurriness"] = { v: 1 }), /not display name/);
  mutate("dissolve on a shape group (no shape-content form)", (s) => (s.comps[0].layers[1].contents[0].blendMode = "dissolve"), /no shape-content form/);

  // ---- .ffx ------------------------------------------------------------------------
  const bytes = synthesizeGradientPreset(GOLDEN);
  const sha = createHash("sha256").update(bytes).digest("hex");
  c.check(`golden .ffx bytes (${bytes.length} bytes, sha256 ${sha.slice(0, 16)}…)`, sha === GOLDEN_SHA256 && bytes.length === GOLDEN_LENGTH, { sha, length: bytes.length });
  let tree: RifxNode | null = null;
  try {
    tree = parseRifx(bytes);
  } catch (e) {
    c.check("the .ffx parses back as RIFX", false, (e as Error).message);
  }
  if (tree) {
    const shape = (n: RifxNode): unknown => (n.children ? [n.type ?? n.id, ...n.children.map(shape)] : n.id);
    c.check("RIFX tree: FaFX → head, besc{beso, tdsp, tdsn, tdsp, GCst{tdbs, GCky{Utf8}}}",
      JSON.stringify(shape(tree)) === JSON.stringify(["FaFX", "head", ["besc", "beso", ["tdsp", "tdot", "tdpl", ["tdsi", "tdix", "tdmn"], ["tdsi", "tdix", "tdmn"], ["tdsi", "tdix", "tdmn"], ["tdsi", "tdix", "tdmn"], ["tdsi", "tdix", "tdmn"]], "tdsn", ["tdsp", "tdot", "tdpl", ["tdsi", "tdix", "tdmn"]], ["GCst", ["tdbs", "tdsb", "tdsn", "tdb4", "cdat"], ["GCky", "Utf8"]]]]),
      shape(tree));
    const find = (n: RifxNode, id: string, acc: RifxNode[] = []): RifxNode[] => {
      if (n.id === id || n.type === id) acc.push(n);
      for (const ch of n.children ?? []) find(ch, id, acc);
      return acc;
    };
    const dec = (b: Uint8Array) => Buffer.from(b).toString("latin1");
    const names = find(tree, "tdmn").map((n) => dec(n.data!).replace(/\0+$/, ""));
    c.check("property path names the G-Fill's Colors", JSON.stringify(names) === JSON.stringify(["ADBE Root Vectors Group", "ADBE Vector Group", "ADBE Vectors Group", "ADBE Vector Graphic - G-Fill", "ADBE Vector Grad Colors", "ADBE End of path sentinel"]), names);
    const idx = find(tree, "tdix").map((n) => Buffer.from(n.data!).readUInt32BE(0));
    c.check("default path indices are AEUX's (group 0, item 2)", JSON.stringify(idx) === JSON.stringify([0xffffffff, 0, 0xffffffff, 2, 0xffffffff, 0xffffffff]), idx);
    c.check("every tdmn is 40 bytes", find(tree, "tdmn").every((n) => n.size === 40));
    const xml = dec(find(tree, "Utf8")[0].data!);
    c.check("the Utf8 chunk holds gradientColorsXml(stops)", xml === gradientColorsXml(GOLDEN.stops));
    const floats = (key: string) => [...xml.matchAll(new RegExp(`<key>${key}</key>\\n<array>\\n<array.type><float/></array.type>\\n((?:<float>[^<]*</float>\\n?)+)</array>`, "g"))].map((mm) => [...mm[1].matchAll(/<float>([^<]*)<\/float>/g)].map((f) => Number(f[1])));
    c.check("color stops read back [offset, midpoint, r, g, b, 1]", JSON.stringify(floats("Stops Color")) === JSON.stringify([[0, 0.5, 1, 0, 0, 1], [0.5, 0.4, 0, 1, 0, 1], [1, 0.5, 0, 0, 1, 1]]), floats("Stops Color"));
    c.check("alpha stops read back [offset, midpoint, alpha]", JSON.stringify(floats("Stops Alpha")) === JSON.stringify([[0, 0.5, 1], [1, 0.5, 0.25]]), floats("Stops Alpha"));
    c.check("Stops Size counts both lists", /<key>Stops Size<\/key>\n<int type='unsigned' size='32'>2<\/int>[\s\S]*<key>Stops Size<\/key>\n<int type='unsigned' size='32'>3<\/int>/.test(xml));
  }
  const stroke = parseRifx(synthesizeGradientPreset({ kind: "stroke", stops: GOLDEN.stops, path: { groups: [1, 0], item: 3 } }));
  const strokeIdx: number[] = [];
  const strokeNames: string[] = [];
  const walk = (n: RifxNode) => {
    if (n.id === "tdix") strokeIdx.push(Buffer.from(n.data!).readUInt32BE(0));
    if (n.id === "tdmn") strokeNames.push(Buffer.from(n.data!).toString("latin1").replace(/\0+$/, ""));
    (n.children ?? []).forEach(walk);
  };
  walk(stroke);
  c.check("nested path: groups [1, 0], G-Stroke at 3", JSON.stringify(strokeIdx.slice(0, 7)) === JSON.stringify([0xffffffff, 1, 0xffffffff, 0, 0xffffffff, 3, 0xffffffff]) && strokeNames[5] === "ADBE Vector Graphic - G-Stroke", { strokeIdx, strokeNames });
  const one = gradientColorsXml({ colors: [{ offset: 0.3, color: [0.25, 0.5, 0.75] }], opacities: [] });
  c.check("a single color stop is repeated; no opacity stops = opaque", (one.match(/<key>Stop-/g) ?? []).length === 4 && one.includes("<float>0.3</float>") && one.includes("<float>0.25</float>"));
  c.check("floats never use exponent notation", !/e-?\d/.test(gradientColorsXml({ colors: [{ offset: 1e-9, color: [1e-7, 0, 1] }, { offset: 1, color: [0, 0, 0] }], opacities: [] }).replace(/<key>[^<]*<\/key>|<\?xml[^>]*>|<prop\.map[^>]*>/g, "")));
  const sceneC = JSON.parse(readFileSync(join(FIXTURES, "c-gradient.scene.json"), "utf8")) as AeScene;
  const presets = synthesizeScenePresets(sceneC);
  c.check("synthesizeScenePresets writes one preset per gradient", JSON.stringify(presets.map((p) => p.path).sort()) === JSON.stringify(["presets/bar.ffx", "presets/nested.ffx", "presets/ring.ffx"]));
  const nestedLayer = sceneC.comps[0].layers.find((l) => l.id === "nestedLayer")!;
  const inner = ((nestedLayer.contents![0] as any).contents[0] as any).contents[1] as AeShapeItem;
  c.check("gradientPresetPath finds nested gradients", JSON.stringify(gradientPresetPath(nestedLayer.contents!, inner)) === JSON.stringify({ groups: [0, 0], item: 1 }));

  return c.failures;
}

function stripComments(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:"'\\])\/\/.*$/gm, "$1");
}
