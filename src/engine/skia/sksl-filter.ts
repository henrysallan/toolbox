// SkSL Filter program assembly (Skia layers, spec 101326_skia-target.md
// §3.2 `filter` class, Wave 3 lane F): the SkSL Shader node's authoring
// contract (sksl-program.ts) applied to a RUNTIME IMAGE FILTER — React
// Native Skia <RuntimeShader> on a Group layer, whose one child is the
// rendered content below it.
//
// Same prelude, lints, channel declarations and error mapping as the SkSL
// Shader node, with one child instead of iImage1..4:
//   content       the rendered drawing under the filter; sample it with
//                 content.eval(xy) (premultiplied, sRGB numbers — the
//                 prelude rewrites the call to a colour-managed sampler)
//   fragCoord     LOCAL coords of the filter's layer, Y-DOWN px (canvas px
//                 at the scene root; on device the exported root group
//                 scales them with the canvas)
//   iResolution   float3: xy = canvas size (toolbox px), z = 1
//   iTime         seconds
//   return value  PREMULTIPLIED sRGB colour
// As with every toolbox program, main() is renamed and wrapped so the
// result and the content sample are converted for a Display P3 canvas
// (library/color-management.ts) — identity on sRGB.

import { colorManagementSksl } from "./library/color-management";
import {
  SKSL_USER_MAIN,
  lintSksl,
  skslChannelDecls,
  skslChannels,
  stripComments,
  userLineError,
} from "./sksl-program";
import type { ExprInput } from "../types";

export const SKSL_FILTER_CHILD = "content";
export const SKSL_FILTER_EVAL = "tbx_eval_content";
export const SKSL_FILTER_SOURCE_MARKER = "// ---- filter source ----";

export interface SkslFilterProgram {
  sksl: string;
  preludeLines: number;
  sourceLines: number;
  channels: ExprInput[];
  unsupported: string[];
  // The source samples `content` (else the filter ignores what's below it).
  readsContent: boolean;
  readsTime: boolean;
}

// Channels the filter may declare: the SkSL Shader node's rule, minus the
// child's own name.
export function skslFilterChannels(params: Record<string, unknown>): ExprInput[] {
  return skslChannels(params).filter((c) => c.name !== SKSL_FILTER_CHILD);
}

// `main(` → tbx_user_main(, `content.eval(` → tbx_eval_content( — code
// only (comments untouched), no line moves, as rewriteSkslSource does for
// the SkSL Shader's iImageN.
export function rewriteSkslFilterSource(source: string): { code: string; hasMain: boolean } {
  let hasMain = false;
  const code = source
    .split(/(\/\*[\s\S]*?\*\/|\/\/[^\n]*)/)
    .map((part, i) => {
      if (i % 2 === 1) return part;
      return part
        .replace(/\bmain(\s*\()/g, (_m, paren: string) => {
          hasMain = true;
          return `${SKSL_USER_MAIN}${paren}`;
        })
        .replace(/\bcontent\s*\.\s*eval\s*\(/g, (m: string) => `${SKSL_FILTER_EVAL}${m.replace(/[^\n]/g, "")}(`);
    })
    .join("");
  return { code, hasMain };
}

export function buildSkslFilterProgram(params: Record<string, unknown>): SkslFilterProgram {
  const source = typeof params.expression === "string" ? params.expression : "";
  const channels = skslFilterChannels(params);
  // Ramp / curve channels lower to LUT child shaders on the SkSL Shader node;
  // a RuntimeShader image filter binds ONE child (the content), so here
  // they are unsupported and their child declarations are left out.
  const decls = skslChannelDecls(channels);
  const lutChildren = new Set(decls.luts.map((l) => l.child));
  const lines = decls.lines.filter((l) => !/^uniform shader /.test(l) || !lutChildren.has(l.replace(/^uniform shader (\w+).*$/, "$1")));
  const unsupported = [...decls.unsupported, ...decls.luts.map((l) => l.name)];
  const prelude = [
    "// Prelude owned by the toolbox SkSL Filter node.",
    `uniform shader ${SKSL_FILTER_CHILD};  // the rendered content below the filter`,
    "uniform float3 iResolution;  // xy = canvas size, z = 1",
    "uniform float iTime;         // seconds",
    ...lines,
    "// Color management: your code runs on sRGB numbers on any canvas.",
    ...colorManagementSksl().split("\n"),
    `half4 ${SKSL_FILTER_EVAL}(float2 p) { return tbx_cm_premul_in(${SKSL_FILTER_CHILD}.eval(p)); }  // content.eval(p), in sRGB`,
    SKSL_FILTER_SOURCE_MARKER,
  ];
  const { code, hasMain } = rewriteSkslFilterSource(source);
  const wrapper = hasMain
    ? [
        "",
        "// ---- toolbox color management: main() above runs on sRGB numbers; this",
        "// hands its premultiplied result to the canvas's color space (identity on sRGB).",
        "half4 main(float2 tbx_p) {",
        `  return tbx_cm_premul_out(float4(${SKSL_USER_MAIN}(tbx_p)));`,
        "}",
        "",
      ].join("\n")
    : "";
  const stripped = stripComments(source);
  return {
    sksl: `${prelude.join("\n")}\n${code}${wrapper && !code.endsWith("\n") ? "\n" : ""}${wrapper}`,
    preludeLines: prelude.length,
    sourceLines: source.split("\n").length,
    channels: channels.filter((c) => !unsupported.includes(c.name)),
    unsupported,
    readsContent: /\bcontent\s*\.\s*eval\s*\(/.test(stripped),
    readsTime: /\biTime\b/.test(stripped),
  };
}

// Skia's error, in the user's lines and names.
export function skslFilterError(raw: string, prog: Pick<SkslFilterProgram, "preludeLines" | "sourceLines">): string {
  return userLineError(raw, prog.preludeLines, prog.sourceLines).replace(new RegExp(`\\b${SKSL_FILTER_EVAL}\\b`, "g"), "content.eval");
}

// The SkSL Shader node's lints plus the filter's own.
export function lintSkslFilter(source: string): { problems: string[]; warnings: string[] } {
  const base = lintSksl(source);
  const problems = [...base.problems];
  const warnings = [...base.warnings];
  const code = stripComments(source);
  if (/\biImage[1-4]\b/.test(code)) {
    problems.push("An SkSL Filter has one input, `content` (the drawing below it) — iImage1..4 belong to the SkSL Shader node.");
  }
  if (!/\bcontent\s*\.\s*eval\s*\(/.test(code)) {
    warnings.push("The source never samples content.eval(…) — the filter ignores the drawing below it (use Skia Fill + SkSL for a generator).");
  }
  return { problems, warnings };
}
