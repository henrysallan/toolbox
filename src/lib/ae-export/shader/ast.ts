// AST for the GLSL ES 3.00 fragment subset the fused shaders use. The parser
// (parse.ts) builds it, the checker (check.ts) annotates `ty` / `sym` / `call`
// in place, and the emitter (emit-msl.ts) prints MSL from the annotations.

import type { BuiltinCall } from "./builtins";
import type { Ty } from "./glsl-types";

export interface TypeSpec {
  // A built-in type name ("float", "vec3", "mat2x3", "sampler2D", "void") or
  // a struct name.
  name: string;
  // Array suffix on the TYPE (`float[3] x`): an expression, or "unsized"
  // for `float[]`.
  array?: Expr | "unsized";
  line: number;
}

// Resolved by the checker.
export interface Sym {
  kind: "local" | "param" | "const" | "global" | "uniform" | "builtin";
  name: string;
  // The MSL spelling (renamed for keywords / shadowing).
  msl: string;
  ty: Ty;
  // const globals that MSL can't hold at program scope (built-in calls in
  // the initializer) become TbxProgram members.
  member?: boolean;
  // Compile-time value of an int/uint const, for array sizes.
  constValue?: number;
  // params: out / inout.
  outParam?: boolean;
}

export interface FnSig {
  name: string;
  msl: string;
  params: { ty: Ty; qual: "in" | "out" | "inout" }[];
  ret: Ty;
  decl: FnDecl | null;
}

export type CallInfo =
  | { kind: "ctor"; ty: Ty }
  | { kind: "struct"; ty: Ty }
  | { kind: "array"; ty: Ty }
  | { kind: "builtin"; name: string; impl: BuiltinCall }
  | { kind: "user"; sig: FnSig };

interface ExprBase {
  line: number;
  ty?: Ty;
}

export type Expr =
  | (ExprBase & { k: "lit"; lit: "float" | "int" | "uint" | "bool"; text: string })
  | (ExprBase & { k: "id"; name: string; sym?: Sym })
  | (ExprBase & { k: "bin"; op: string; l: Expr; r: Expr })
  | (ExprBase & { k: "un"; op: string; e: Expr })
  | (ExprBase & { k: "post"; op: "++" | "--"; e: Expr })
  | (ExprBase & { k: "assign"; op: string; l: Expr; r: Expr })
  | (ExprBase & { k: "cond"; c: Expr; t: Expr; f: Expr })
  | (ExprBase & { k: "comma"; l: Expr; r: Expr })
  // `callee` is a function name, a built-in type name (constructor) or a
  // struct name. `array` is set for array constructors `float[3](…)`.
  | (ExprBase & { k: "call"; callee: string; array?: Expr | "unsized"; args: Expr[]; call?: CallInfo })
  | (ExprBase & { k: "index"; e: Expr; i: Expr })
  // Swizzle or struct member; the checker sets `swizzle`.
  | (ExprBase & { k: "field"; e: Expr; name: string; swizzle?: string; member?: string })
  // `x.length()`; the checker folds it to `value`.
  | (ExprBase & { k: "length"; e: Expr; value?: number });

export interface VarDecl {
  name: string;
  // Array suffix on the NAME (`float x[3]`).
  array?: Expr | "unsized";
  init?: Expr;
  line: number;
  sym?: Sym;
}

export type Stmt =
  | { k: "block"; body: Stmt[]; line: number }
  | { k: "decl"; isConst: boolean; type: TypeSpec; vars: VarDecl[]; line: number }
  | { k: "expr"; e: Expr; line: number }
  | { k: "if"; c: Expr; t: Stmt; f?: Stmt; line: number }
  | { k: "for"; init?: Stmt; c?: Expr; step?: Expr; body: Stmt; line: number }
  | { k: "while"; c: Expr; body: Stmt; line: number }
  | { k: "do"; body: Stmt; c: Expr; line: number }
  | { k: "switch"; e: Expr; body: Stmt[]; line: number }
  | { k: "case"; e?: Expr; line: number }
  | { k: "break"; line: number }
  | { k: "continue"; line: number }
  | { k: "discard"; line: number }
  | { k: "return"; e?: Expr; line: number }
  | { k: "empty"; line: number };

export interface ParamDecl {
  qual: "in" | "out" | "inout";
  type: TypeSpec;
  name?: string;
  array?: Expr | "unsized";
  line: number;
  sym?: Sym;
}

export interface FnDecl {
  k: "fn";
  ret: TypeSpec;
  name: string;
  params: ParamDecl[];
  // Undefined for a prototype.
  body?: Stmt & { k: "block" };
  line: number;
  sig?: FnSig;
}

export interface StructDecl {
  k: "struct";
  name: string;
  fields: { type: TypeSpec; name: string; array?: Expr | "unsized"; line: number }[];
  line: number;
  msl?: string;
}

export type TopDecl =
  | FnDecl
  | StructDecl
  | { k: "io"; dir: "in" | "out"; type: TypeSpec; name: string; line: number }
  | { k: "uniform"; type: TypeSpec; name: string; line: number }
  | { k: "global"; isConst: boolean; type: TypeSpec; vars: VarDecl[]; line: number };

export interface Program {
  decls: TopDecl[];
}
