// EXR layer grouping heuristics. EXR has no formal layer object — layers are
// dot-separated channel-name prefixes with renderer-specific suffix
// conventions. This module shapes raw part headers into the layer list the
// UI dropdown shows and the decoder consumes.
// Spec: specdocs/archive/070926_exr-color-pipeline.md.

import type { ExrRawPartHeader } from "./exr-core";

export interface ExrChannelInfo {
  name: string;
  // 0 = UINT, 1 = HALF, 2 = FLOAT
  pixelType: number;
}

export interface ExrPartInfo {
  // Part name attribute (multi-part files); undefined on single-part.
  name?: string;
  width: number;
  height: number;
  compression: string;
  channels: ExrChannelInfo[];
}

export interface ExrHeaderInfo {
  parts: ExrPartInfo[];
}

export interface ExrLayerMapping {
  r?: string;
  g?: string;
  b?: string;
  a?: string;
}

export interface ExrLayer {
  // Stable identifier persisted in params — survives re-picking a file with
  // the same structure. `p<part>/<label>`.
  id: string;
  // Dropdown label.
  label: string;
  part: number;
  // Channel names for the RGBA output slots. Undefined ⇒ the decoder's
  // default behavior (top-level RGBA, or Y/RY/BY luminance-chroma).
  mapping?: ExrLayerMapping;
}

export function shapeExrHeader(raw: ExrRawPartHeader[]): ExrHeaderInfo {
  return {
    parts: raw.map((p) => ({
      name: typeof p.name === "string" ? p.name : undefined,
      width: p.dataWindow.xMax - p.dataWindow.xMin + 1,
      height: p.dataWindow.yMax - p.dataWindow.yMin + 1,
      compression: p.compression,
      channels: p.channels.map((c) => ({
        name: c.name,
        pixelType: c.pixelType,
      })),
    })),
  };
}

// Suffix sets that group into an RGB(A) mapping, in slot order.
const COLOR_SETS: [string, string, string][] = [
  ["R", "G", "B"],
  ["X", "Y", "Z"],
  ["U", "V", "W"],
];

function splitName(name: string): { prefix: string; suffix: string } {
  const dot = name.lastIndexOf(".");
  return dot >= 0
    ? { prefix: name.slice(0, dot), suffix: name.slice(dot + 1) }
    : { prefix: "", suffix: name };
}

// Rank for dropdown ordering within a part: the beauty/default layer first,
// then color groups, then vector groups, then mono channels.
function layerRank(prefix: string, setIdx: number): number {
  if (prefix === "") return 0;
  if (/(^|\.)(combined|beauty|rgba|default)$/i.test(prefix)) return 1;
  return setIdx === 0 ? 2 : 3;
}

export function groupExrLayers(header: ExrHeaderInfo): ExrLayer[] {
  const layers: (ExrLayer & { rank: number; order: number })[] = [];
  const multiPart = header.parts.length > 1;
  let order = 0;

  header.parts.forEach((part, partIndex) => {
    const partLabel = multiPart ? (part.name ?? `part ${partIndex}`) : "";
    const withPart = (s: string) =>
      partLabel && s ? `${partLabel} / ${s}` : partLabel || s;

    // UINT channels can't be selected (crypto/id passes) — drop them here so
    // they neither group nor appear as mono layers.
    const usable = part.channels.filter((c) => c.pixelType !== 0);

    // Group by prefix, preserving channel order (EXR headers sort channels,
    // so groups come out alphabetical).
    const groups = new Map<string, { suffix: string; name: string }[]>();
    for (const c of usable) {
      const { prefix, suffix } = splitName(c.name);
      let g = groups.get(prefix);
      if (!g) groups.set(prefix, (g = []));
      g.push({ suffix, name: c.name });
    }

    for (const [prefix, members] of groups) {
      const bySuffix = new Map(
        members.map((m) => [m.suffix.toUpperCase(), m.name])
      );
      const claimed = new Set<string>();

      for (let si = 0; si < COLOR_SETS.length; si++) {
        const [s0, s1, s2] = COLOR_SETS[si];
        if (bySuffix.has(s0) && bySuffix.has(s1) && bySuffix.has(s2)) {
          const mapping: ExrLayerMapping = {
            r: bySuffix.get(s0),
            g: bySuffix.get(s1),
            b: bySuffix.get(s2),
          };
          // Alpha only pairs with the RGB set — XYZ/UVW carry no coverage.
          if (si === 0 && bySuffix.has("A")) {
            mapping.a = bySuffix.get("A");
            claimed.add("A");
          }
          // Claim by (uppercase) suffix — the mono fallthrough checks the
          // same key.
          for (const s of [s0, s1, s2]) claimed.add(s);
          const label = withPart(prefix) || "RGBA";
          layers.push({
            id: `p${partIndex}/${prefix || "@rgba"}${si ? `@${s0}${s1}${s2}` : ""}`,
            label,
            part: partIndex,
            mapping,
            rank: layerRank(prefix, si),
            order: order++,
          });
        }
      }

      // Luminance-chroma root (Y/RY/BY) — let the decoder's default path
      // handle the chroma upsample + conversion.
      if (
        prefix === "" &&
        bySuffix.has("Y") &&
        bySuffix.has("RY") &&
        bySuffix.has("BY")
      ) {
        for (const s of ["Y", "RY", "BY"]) claimed.add(s);
        layers.push({
          id: `p${partIndex}/@luma`,
          label: withPart("") || "Luminance",
          part: partIndex,
          mapping: undefined,
          rank: 0,
          order: order++,
        });
      }

      // Everything unclaimed becomes a mono (broadcast) layer.
      for (const m of members) {
        if (claimed.has(m.suffix.toUpperCase())) continue;
        layers.push({
          id: `p${partIndex}/${m.name}`,
          label: withPart(m.name),
          part: partIndex,
          mapping: { r: m.name },
          rank: 4,
          order: order++,
        });
      }
    }
  });

  layers.sort((a, b) => a.part - b.part || a.rank - b.rank || a.order - b.order);
  return layers.map((l) => ({
    id: l.id,
    label: l.label,
    part: l.part,
    mapping: l.mapping,
  }));
}

// Resolve a persisted layer id against a (possibly different) file's layer
// list — falls back to the first (default) layer.
export function findExrLayer(
  layers: ExrLayer[],
  id: string | null | undefined
): ExrLayer | undefined {
  if (!layers.length) return undefined;
  return layers.find((l) => l.id === id) ?? layers[0];
}
