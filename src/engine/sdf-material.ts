// Shared "paint this shape" params + the AST wrap behind them.
//
// Lives engine-side (invariant #1) because both the SDF primitives and
// the SDF Material node build the same `material` node, and because the
// hex→vec3 conversion has to agree with what the compiler binds as a
// `vec3` uniform.
//
// Why TWO params rather than one colour: a colour swatch has no natural
// "unset" state, and the compiler's inheritance rule needs one. With
// `paint` off, the primitive emits its bare shape and every leaf below
// takes whatever material encloses it — ultimately the terminal's own
// foreground, which is exactly how SDF graphs rendered before materials
// existed. Old saves have no `paint` key, so they default to off and
// render unchanged.

import type { ParamDef, SdfNode } from "./types";

// Straight 0..1 RGB. Accepts 3-, 6-, and 8-digit hex; an alpha pair is
// parsed but DROPPED — the material AST carries vec3, and per-material
// alpha is a separate design question from per-material colour (the
// terminal still owns coverage). Malformed input falls back to white
// rather than NaN, which would poison the whole distance field.
export function sdfHexToRgb01(hex: string): [number, number, number] {
  const raw = (hex ?? "").trim().replace(/^#/, "");
  const s =
    raw.length === 3
      ? raw
          .split("")
          .map((c) => c + c)
          .join("")
      : raw.length === 8
        ? raw.slice(0, 6)
        : raw;
  if (s.length !== 6 || !/^[0-9a-fA-F]{6}$/.test(s)) return [1, 1, 1];
  const n = parseInt(s, 16);
  return [
    ((n >> 16) & 0xff) / 255,
    ((n >> 8) & 0xff) / 255,
    (n & 0xff) / 255,
  ];
}

// Declared by every SDF primitive. Spread into the def's `params` —
// order matters only for panel layout, so put them last.
export const SDF_PAINT_PARAMS: ParamDef[] = [
  // Off: the shape inherits — from an enclosing SDF Material, or from
  // the terminal's Foreground if there is none.
  {
    name: "paint",
    label: "Paint",
    type: "boolean",
    default: false,
  },
  // Blends with neighbouring colours across a Smooth Union's join,
  // driven by that node's own Smoothness.
  {
    name: "color",
    label: "Color",
    type: "color",
    default: "#ffffff",
    visibleIf: (p) => p.paint === true,
  },
];

// Wrap a freshly-built leaf in a `material` when its `paint` param is
// on. `paint` off returns the node untouched, so the tree — and its
// structural hash, and therefore the shader cache — is identical to a
// pre-materials build.
export function paintSdf(
  node: SdfNode,
  params: Record<string, unknown>
): SdfNode {
  if (params.paint !== true) return node;
  return {
    kind: "material",
    child: node,
    color: sdfHexToRgb01((params.color as string) ?? "#ffffff"),
    // Per-material bleed weighting is a knob on the shading terminal
    // that reads the accumulator; until that exists every material
    // participates normally.
    bleed: 1,
  };
}
