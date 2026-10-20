// Synthesized After Effects animation presets (.ffx) that set a shape
// Gradient Fill / Gradient Stroke's stop colors (spec 091926 §1, §4.5).
//
// `ADBE Vector Grad Colors` is NO_VALUE to scripting (unchanged through 26.5),
// so build.jsx cannot setValue it. An animation preset can carry the value:
// build.jsx selects the gradient's Colors property and calls
// `layer.applyPreset(file)` with one of these files. Google's AEUX (Apache
// 2.0), LottieFiles for AE and several CEP panels ship the same technique as
// hex templates; this module writes the container from its structure instead,
// so every size is computed and the property path is data.
//
// Format, as AE writes presets (all integers big-endian):
//
//   RIFX <size> "FaFX"
//     head  16 bytes            preset header (version words)
//     LIST "besc"
//       beso  56 bytes          preset settings block (unchanged by us)
//       LIST "tdsp"             property path, root first:
//         tdot  -1
//         tdpl  <depth>
//         LIST "tdsi" { tdix <index | -1>  tdmn <match name, 40 bytes NUL-padded> } × depth
//       tdsn  "Colors\0"        the property's display name
//       LIST "tdsp"             the end-of-path sentinel
//       LIST "GCst"             the gradient value:
//         LIST "tdbs"           property descriptor (stream type, flags)
//         LIST "GCky" { Utf8 <prop.map XML with the stops> }
//
// A chunk's size counts its payload (a LIST's includes its 4-byte type); an
// odd payload is followed by one pad byte that the size does not count.
// AE reads the stops from the XML: per alpha stop [offset, midpoint, alpha],
// per color stop [offset, midpoint, r, g, b, 1], all 0–1.

import type { AeGradientStops, AeScene, AeShapeItem } from "../types";

export type GradientPresetKind = "fill" | "stroke";

export interface GradientPresetInput {
  kind: GradientPresetKind;
  stops: AeGradientStops;
  // Where the gradient sits in the layer's Contents: 0-based indices of the
  // nested Vector Groups, then of the gradient item inside the innermost one.
  // Defaults to AEUX's { groups: [0], item: 2 }. build.jsx also selects the
  // property before applying, which is what AE resolves against.
  path?: { groups: number[]; item: number };
}

const MATCH = {
  root: "ADBE Root Vectors Group",
  group: "ADBE Vector Group",
  contents: "ADBE Vectors Group",
  fill: "ADBE Vector Graphic - G-Fill",
  stroke: "ADBE Vector Graphic - G-Stroke",
  colors: "ADBE Vector Grad Colors",
  sentinel: "ADBE End of path sentinel",
} as const;

// Preset header and settings block, as AE 26.x reads them in the presets
// AEUX-derived tools ship; we do not interpret their fields.
const HEAD = hex("00000003 00000057 00000001 00000000");
const BESO = hex(
  "00000001 00000001 00000000 00006000 00180000 00000004 00010001 07800438 " +
    "3ff00000 00000000 3ff00000 00000000 00000000 ffffffff"
);
// Stream descriptor for a gradient Colors property ("tdb4"): magic 0xdb99,
// dimension/flags words, and the 1e-4 / 1.0 doubles AE writes for it.
const TDB4 = hex(
  "db990001 00070000 ffffffff 00006000 3f1a36e2 eb1c432d 3ff00000 00000000 " +
    "3ff00000 00000000 3ff00000 00000000 3ff00000 00000000 00010008 00000000 " +
    "00000000 00000000 00000000 00000001 00000000 00000000 00000000 00000000 " +
    "00000000 00000000 00000000 00000000 00000000 00000000 00000000"
);

function hex(s: string): Uint8Array {
  const clean = s.replace(/\s+/g, "");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.substr(i * 2, 2), 16);
  return out;
}

function ascii(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c > 0x7f) throw new Error(`ffx: non-ASCII character in ${JSON.stringify(s)}`);
    out[i] = c;
  }
  return out;
}

function u32(n: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, n >>> 0, false);
  return out;
}

function concat(parts: Uint8Array[]): Uint8Array {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function fourcc(id: string): Uint8Array {
  if (id.length !== 4) throw new Error(`ffx: chunk id ${JSON.stringify(id)} is not 4 characters`);
  return ascii(id);
}

function chunk(id: string, payload: Uint8Array): Uint8Array {
  const pad = payload.length % 2 ? [new Uint8Array(1)] : [];
  return concat([fourcc(id), u32(payload.length), payload, ...pad]);
}

function list(type: string, children: Uint8Array[]): Uint8Array {
  return chunk("LIST", concat([fourcc(type), ...children]));
}

function matchName40(name: string): Uint8Array {
  const b = ascii(name);
  if (b.length > 39) throw new Error(`ffx: match name ${JSON.stringify(name)} exceeds 39 bytes`);
  const out = new Uint8Array(40);
  out.set(b, 0);
  return out;
}

function pathStep(index: number | null, matchName: string): Uint8Array {
  return list("tdsi", [chunk("tdix", u32(index === null ? 0xffffffff : index)), chunk("tdmn", matchName40(matchName))]);
}

function propertyPath(steps: [number | null, string][]): Uint8Array {
  return list("tdsp", [chunk("tdot", u32(0xffffffff)), chunk("tdpl", u32(steps.length)), ...steps.map(([i, m]) => pathStep(i, m))]);
}

function cString(s: string): Uint8Array {
  return concat([ascii(s), new Uint8Array(1)]);
}

// A number as AE's prop.map XML writes it: plain decimal, no exponent.
function xmlFloat(v: number): string {
  const x = Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0;
  const s = x.toFixed(9).replace(/0+$/, "").replace(/\.$/, "");
  return s === "-0" || s === "" ? "0" : s;
}

interface NormalizedStops {
  colors: { offset: number; midpoint: number; color: [number, number, number] }[];
  opacities: { offset: number; midpoint: number; opacity: number }[];
}

// Sorted by offset (stable), at least two of each: a lone stop is repeated at
// the far end, and no opacity stops means fully opaque.
export function normalizeGradientStops(stops: AeGradientStops): NormalizedStops {
  const colors = stops.colors
    .map((s, i) => ({ i, offset: s.offset, midpoint: s.midpoint ?? 0.5, color: [s.color[0], s.color[1], s.color[2]] as [number, number, number] }))
    .sort((a, b) => a.offset - b.offset || a.i - b.i)
    .map(({ offset, midpoint, color }) => ({ offset, midpoint, color }));
  if (colors.length === 0) throw new Error("ffx: a gradient needs at least one color stop");
  if (colors.length === 1) colors.push({ ...colors[0], offset: colors[0].offset < 1 ? 1 : 0 });
  colors.sort((a, b) => a.offset - b.offset);
  let opacities = stops.opacities
    .map((s, i) => ({ i, offset: s.offset, midpoint: s.midpoint ?? 0.5, opacity: s.opacity }))
    .sort((a, b) => a.offset - b.offset || a.i - b.i)
    .map(({ offset, midpoint, opacity }) => ({ offset, midpoint, opacity }));
  if (opacities.length === 0) opacities = [{ offset: 0, midpoint: 0.5, opacity: 1 }, { offset: 1, midpoint: 0.5, opacity: 1 }];
  if (opacities.length === 1) opacities.push({ ...opacities[0], offset: opacities[0].offset < 1 ? 1 : 0 });
  opacities.sort((a, b) => a.offset - b.offset);
  return { colors, opacities };
}

// The XML AE stores a gradient's stops in ("Gradient Color Data").
export function gradientColorsXml(stops: AeGradientStops): string {
  const n = normalizeGradientStops(stops);
  const L: string[] = ["<?xml version='1.0'?>", "<prop.map version='4'>", "<prop.list>", "<prop.pair>", "<key>Gradient Color Data</key>", "<prop.list>"];
  const section = (key: string, rows: string[][], rowKey: string) => {
    L.push("<prop.pair>", `<key>${key}</key>`, "<prop.list>", "<prop.pair>", "<key>Stops List</key>", "<prop.list>");
    rows.forEach((row, i) => {
      L.push("<prop.pair>", `<key>Stop-${i}</key>`, "<prop.list>", "<prop.pair>", `<key>${rowKey}</key>`, "<array>", "<array.type><float/></array.type>");
      for (const v of row) L.push(`<float>${v}</float>`);
      L.push("</array>", "</prop.pair>", "</prop.list>", "</prop.pair>");
    });
    L.push("</prop.list>", "</prop.pair>", "<prop.pair>", "<key>Stops Size</key>", `<int type='unsigned' size='32'>${rows.length}</int>`, "</prop.pair>", "</prop.list>", "</prop.pair>");
  };
  section("Alpha Stops", n.opacities.map((s) => [xmlFloat(s.offset), xmlFloat(s.midpoint), xmlFloat(s.opacity)]), "Stops Alpha");
  section(
    "Color Stops",
    n.colors.map((s) => [xmlFloat(s.offset), xmlFloat(s.midpoint), xmlFloat(s.color[0]), xmlFloat(s.color[1]), xmlFloat(s.color[2]), "1"]),
    "Stops Color"
  );
  L.push("</prop.list>", "</prop.pair>", "<prop.pair>", "<key>Gradient Colors</key>", "<string>1.0</string>", "</prop.pair>", "</prop.list>", "</prop.map>");
  return L.join("\n");
}

// The whole .ffx file for one gradient's stops.
export function synthesizeGradientPreset(input: GradientPresetInput): Uint8Array {
  const path = input.path ?? { groups: [0], item: 2 };
  if (!path.groups.length) throw new Error("ffx: a gradient lives inside at least one Vector Group");
  const steps: [number | null, string][] = [[null, MATCH.root]];
  for (const g of path.groups) {
    if (!Number.isInteger(g) || g < 0) throw new Error(`ffx: bad group index ${g}`);
    steps.push([g, MATCH.group], [null, MATCH.contents]);
  }
  if (!Number.isInteger(path.item) || path.item < 0) throw new Error(`ffx: bad item index ${path.item}`);
  steps.push([path.item, input.kind === "stroke" ? MATCH.stroke : MATCH.fill], [null, MATCH.colors]);

  const xml = ascii(gradientColorsXml(input.stops));
  const besc = list("besc", [
    chunk("beso", BESO),
    propertyPath(steps),
    chunk("tdsn", cString("Colors")),
    propertyPath([[null, MATCH.sentinel]]),
    list("GCst", [
      list("tdbs", [chunk("tdsb", u32(1)), chunk("tdsn", cString("Colors")), chunk("tdb4", TDB4), chunk("cdat", u32(0))]),
      list("GCky", [chunk("Utf8", xml)]),
    ]),
  ]);
  const body = concat([fourcc("FaFX"), chunk("head", HEAD), besc]);
  return concat([fourcc("RIFX"), u32(body.length), body]);
}

// ---------------------------------------------------------------------------
// Reading (for the gate and the spike: the file must parse back to the same
// tree, and the stops back to the same numbers).
// ---------------------------------------------------------------------------

export interface RifxNode {
  id: string;
  // LIST type, or undefined for a leaf chunk.
  type?: string;
  offset: number;
  size: number;
  data?: Uint8Array;
  children?: RifxNode[];
}

export function parseRifx(bytes: Uint8Array): RifxNode {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const id = (o: number) => String.fromCharCode(bytes[o], bytes[o + 1], bytes[o + 2], bytes[o + 3]);
  if (bytes.length < 12 || id(0) !== "RIFX") throw new Error("not a RIFX file");
  const total = dv.getUint32(4, false);
  if (total + 8 !== bytes.length) throw new Error(`RIFX size ${total + 8} ≠ file size ${bytes.length}`);
  const readChildren = (start: number, end: number): RifxNode[] => {
    const out: RifxNode[] = [];
    let o = start;
    while (o < end) {
      if (o + 8 > end) throw new Error(`truncated chunk header at ${o}`);
      const cid = id(o);
      const size = dv.getUint32(o + 4, false);
      const dataStart = o + 8;
      const dataEnd = dataStart + size;
      if (dataEnd > end) throw new Error(`chunk ${cid} at ${o} overruns its parent`);
      if (cid === "LIST") {
        out.push({ id: cid, type: id(dataStart), offset: o, size, children: readChildren(dataStart + 4, dataEnd) });
      } else {
        out.push({ id: cid, offset: o, size, data: bytes.subarray(dataStart, dataEnd) });
      }
      o = dataEnd + (size % 2);
    }
    if (o !== end) throw new Error(`chunk list ends at ${o}, parent at ${end}`);
    return out;
  };
  return { id: "RIFX", type: id(8), offset: 0, size: total, children: readChildren(12, bytes.length) };
}

// ---------------------------------------------------------------------------
// Scene helpers (for the package writer)
// ---------------------------------------------------------------------------

type GradientItem = Extract<AeShapeItem, { kind: "gradient-fill" | "gradient-stroke" }>;

// Where a gradient item sits in a layer's contents, as the preset path wants
// it: 0-based Vector Group indices, then the item's index in the innermost
// group. null when it is not inside a group (AE keeps gradients in groups).
export function gradientPresetPath(contents: AeShapeItem[], target: AeShapeItem): { groups: number[]; item: number } | null {
  const walk = (items: AeShapeItem[], groups: number[]): { groups: number[]; item: number } | null => {
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (it === target) return groups.length ? { groups, item: i } : null;
      if (it.kind === "group") {
        const found = walk(it.contents, [...groups, i]);
        if (found) return found;
      }
    }
    return null;
  };
  return walk(contents, []);
}

// Every preset a scene references, synthesized at its package path. Gradients
// on SVG-seeded shape layers (`source` set) need none: the SVG carries them.
export function synthesizeScenePresets(scene: AeScene): { path: string; bytes: Uint8Array }[] {
  const byId = new Map(scene.presets.map((p) => [p.id, p.path]));
  const out: { path: string; bytes: Uint8Array }[] = [];
  const seen = new Set<string>();
  for (const comp of scene.comps) {
    for (const layer of comp.layers) {
      const contents = layer.contents ?? [];
      const visit = (items: AeShapeItem[]) => {
        for (const it of items) {
          if (it.kind === "group") visit(it.contents);
          else if ((it.kind === "gradient-fill" || it.kind === "gradient-stroke") && it.preset) {
            const g = it as GradientItem;
            const path = byId.get(g.preset!);
            if (!path) throw new Error(`ffx: preset "${g.preset}" is not in scene.presets`);
            if (seen.has(g.preset!)) throw new Error(`ffx: preset "${g.preset}" is used by two gradients`);
            if (layer.source) throw new Error(`ffx: ${layer.name} is seeded from an SVG; its gradients need no preset`);
            seen.add(g.preset!);
            const at = gradientPresetPath(contents, g);
            if (!at) throw new Error(`ffx: the gradient for "${g.preset}" is not inside a group`);
            out.push({ path, bytes: synthesizeGradientPreset({ kind: g.kind === "gradient-stroke" ? "stroke" : "fill", stops: g.stops, path: at }) });
          }
        }
      };
      visit(contents);
    }
  }
  return out;
}
