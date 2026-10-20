// The .tbxfx text and the bundle id (AeShaderBundle, ABI.md). No node or
// engine imports, so the validator and the host-facing tools can use it.

import type { AeShaderBundle } from "../types";

// The shortest decimal that reads back as the same float32: the host parses
// floats, so this is exact there and keeps the JSON small.
export function f32(x: number): number {
  const v = Math.fround(x);
  if (!Number.isFinite(v) || v === 0) return v === 0 ? 0 : v;
  for (let p = 1; p <= 9; p++) {
    const s = Number(v.toPrecision(p));
    if (Math.fround(s) === v) return s;
  }
  return v;
}

// ---------------------------------------------------------------------------
// id + .tbxfx text
// ---------------------------------------------------------------------------

// Key order is irrelevant to the id: object keys sort recursively.
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

// A stable 24-bit id (< 2^24, so build.jsx's float slider holds it exactly):
// FNV-1a over the canonical JSON of the bundle minus `id`, xor-folded. 0 is
// kept free for "no bundle".
export function bundleId(bundle: Omit<AeShaderBundle, "id"> | AeShaderBundle): number {
  const rest: Record<string, unknown> = { ...bundle };
  delete rest.id;
  const bytes = new TextEncoder().encode(canonicalJson(rest));
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  const id = ((h >>> 24) ^ h) & 0xffffff;
  return id === 0 ? 1 : id;
}

const KEY_ORDER: (keyof AeShaderBundle)[] = [
  "format", "version", "id", "hostMin", "name", "source", "inputs", "params", "luts", "readsTime", "fps", "loopFrames", "canvas",
];

// The `.tbxfx` file: the bundle as JSON, top-level keys in AeShaderBundle
// order, two-space indent, number arrays on one line.
export function writeTbxfx(bundle: AeShaderBundle): string {
  const ordered: Record<string, unknown> = {};
  for (const k of KEY_ORDER) if (bundle[k] !== undefined) ordered[k] = bundle[k];
  for (const k of Object.keys(bundle) as (keyof AeShaderBundle)[]) if (!(k in ordered) && bundle[k] !== undefined) ordered[k] = bundle[k];
  return `${pretty(ordered, "")}\n`;
}

function pretty(v: unknown, indent: string): string {
  if (Array.isArray(v)) {
    if (v.every((x) => typeof x === "number" || typeof x === "boolean" || typeof x === "string")) return `[${v.map((x) => JSON.stringify(x)).join(", ")}]`;
    if (!v.length) return "[]";
    const inner = indent + "  ";
    return `[\n${v.map((x) => inner + pretty(x, inner)).join(",\n")}\n${indent}]`;
  }
  if (v && typeof v === "object") {
    const entries = Object.entries(v as Record<string, unknown>).filter(([, x]) => x !== undefined);
    if (!entries.length) return "{}";
    const inner = indent + "  ";
    return `{\n${entries.map(([k, x]) => `${inner}${JSON.stringify(k)}: ${pretty(x, inner)}`).join(",\n")}\n${indent}}`;
  }
  return JSON.stringify(v);
}
