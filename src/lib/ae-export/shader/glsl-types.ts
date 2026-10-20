// GLSL ES 3.00 value types and their MSL spellings (ABI.md table, row 1:
// vecN / ivecN / uvecN / bvecN / matCxR → floatN / intN / uintN / boolN /
// floatCxR — GLSL and MSL name matrices columns × rows, both column-major).

export type BaseTy = "float" | "int" | "uint" | "bool" | "void" | "sampler" | "struct";

export interface Ty {
  b: BaseTy;
  // Vector size, or a matrix's row count. 1 = scalar.
  n: number;
  // Matrix column count; 0 = not a matrix.
  m: number;
  // Struct name (GLSL spelling) when b === "struct".
  s?: string;
  // Array length when this is an array type.
  a?: number;
}

export const T = {
  void: { b: "void", n: 1, m: 0 } as Ty,
  float: { b: "float", n: 1, m: 0 } as Ty,
  int: { b: "int", n: 1, m: 0 } as Ty,
  uint: { b: "uint", n: 1, m: 0 } as Ty,
  bool: { b: "bool", n: 1, m: 0 } as Ty,
  sampler: { b: "sampler", n: 1, m: 0 } as Ty,
};

export function vec(b: BaseTy, n: number): Ty {
  return { b, n, m: 0 };
}

export function mat(cols: number, rows: number): Ty {
  return { b: "float", n: rows, m: cols };
}

const VEC_PREFIX: Record<string, BaseTy> = { vec: "float", ivec: "int", uvec: "uint", bvec: "bool" };

// GLSL built-in type name → Ty, or null.
export function builtinType(name: string): Ty | null {
  switch (name) {
    case "void":
      return T.void;
    case "float":
      return T.float;
    case "int":
      return T.int;
    case "uint":
      return T.uint;
    case "bool":
      return T.bool;
    case "sampler2D":
      return T.sampler;
  }
  const v = /^(vec|ivec|uvec|bvec)([234])$/.exec(name);
  if (v) return vec(VEC_PREFIX[v[1]], Number(v[2]));
  const sq = /^mat([234])$/.exec(name);
  if (sq) return mat(Number(sq[1]), Number(sq[1]));
  const cr = /^mat([234])x([234])$/.exec(name);
  if (cr) return mat(Number(cr[1]), Number(cr[2]));
  return null;
}

// Type names the GLSL ES 3.00 grammar knows but the fused subset refuses.
export const UNSUPPORTED_TYPES = new Set([
  "double", "dvec2", "dvec3", "dvec4",
  "samplerCube", "sampler3D", "sampler2DArray", "sampler2DShadow", "samplerCubeShadow", "sampler2DArrayShadow",
  "isampler2D", "isampler3D", "isamplerCube", "isampler2DArray",
  "usampler2D", "usampler3D", "usamplerCube", "usampler2DArray",
]);

export function isScalar(t: Ty): boolean {
  return t.a === undefined && t.m === 0 && t.n === 1 && t.b !== "struct" && t.b !== "sampler" && t.b !== "void";
}

export function isVector(t: Ty): boolean {
  return t.a === undefined && t.m === 0 && t.n > 1;
}

export function isMatrix(t: Ty): boolean {
  return t.a === undefined && t.m > 0;
}

export function isNumeric(t: Ty): boolean {
  return t.a === undefined && (t.b === "float" || t.b === "int" || t.b === "uint");
}

export function sameTy(a: Ty, b: Ty): boolean {
  return a.b === b.b && a.n === b.n && a.m === b.m && a.s === b.s && a.a === b.a;
}

export function elemOf(t: Ty): Ty {
  const { a: _a, ...rest } = t;
  void _a;
  return rest;
}

export function scalarOf(t: Ty): Ty {
  return { b: t.b, n: 1, m: 0 };
}

export function withArray(t: Ty, a: number): Ty {
  return { ...t, a };
}

// Number of scalar components (constructor arithmetic).
export function components(t: Ty): number {
  return t.m > 0 ? t.m * t.n : t.n;
}

export function glslName(t: Ty): string {
  let s: string;
  if (t.b === "struct") s = t.s ?? "?";
  else if (t.b === "sampler") s = "sampler2D";
  else if (t.m > 0) s = t.m === t.n ? `mat${t.m}` : `mat${t.m}x${t.n}`;
  else if (t.n > 1) s = `${t.b === "float" ? "" : t.b[0]}vec${t.n}`;
  else s = t.b;
  return t.a !== undefined ? `${s}[${t.a}]` : s;
}

// MSL spelling. `structName` maps a GLSL struct name to its MSL name.
export function mslTypeName(t: Ty, structName: (glsl: string) => string = (s) => s): string {
  let s: string;
  if (t.b === "struct") s = structName(t.s ?? "?");
  else if (t.b === "sampler") s = "TbxImage";
  else if (t.m > 0) s = `float${t.m}x${t.n}`;
  else if (t.n > 1) s = `${t.b}${t.n}`;
  else s = t.b;
  return t.a !== undefined ? `array<${s}, ${t.a}>` : s;
}
