import type { ExprInput, InputSocketDef, NodeDefinition, RenderContext } from "@/engine/types";
import { channelSocketType, readChannelValues, syncChannelInputs } from "@/engine/expr-channels";
import {
  canvasKit,
  canvasKitError,
  canvasKitReady,
  ensureCanvasKit,
} from "@/engine/skia/canvaskit";
import {
  buildSkslProgram,
  channelUniformValues,
  compileSksl,
  lintSksl,
  packUniforms,
  SKSL_CHILD_NAMES,
  userLineError,
} from "@/engine/skia/sksl-program";
import { renderSkslToImage, skiaGpuError } from "@/engine/skia/sksl-render";

// SkSL Shader — a Skia runtime shader authored in toolbox and rendered BY
// Skia (CanvasKit), so the preview is the program React Native Skia runs,
// not a GLSL translation of it (specdocs/101326_skia-target.md, M0).
// Contract and prelude: engine/skia/sksl-program.ts. Rendering and the
// premultiplied → straight hand-off: engine/skia/sksl-render.ts.

const DEFAULT_SOURCE = `// SkSL runtime shader — the same file React Native Skia runs.
// fragCoord is in pixels, Y-DOWN. iResolution.xy = canvas size,
// iTime = seconds. Wired images are iImage1..iImage4: iImage1.eval(xy).
// Return PREMULTIPLIED color. Tunables are one-line comments that Sync
// turns into controls: ch → float, color → float4 (straight alpha),
// toggle → int 0/1 (SkSL has no bool uniforms), pick → int + consts.
// ch("amount", 0.5, 0, 1)
// color("tint", "#3d7bff")

half4 main(float2 fragCoord) {
  float2 uv = fragCoord / iResolution.xy;
  float w = 0.5 + 0.5 * sin(uv.x * 12.0 + iTime * 2.0);
  float3 c = mix(tint.rgb, float3(uv, 1.0 - uv.x), amount * w);
  return half4(float4(c, 1.0));
}`;

// The default source's channels, minted once so a freshly added node
// compiles without a Sync (Sync only runs when `expression` is authored).
const DEFAULT_CHANNELS = syncChannelInputs([], DEFAULT_SOURCE);

const IMAGE_SOCKETS = ["image1", "image2", "image3", "image4"] as const;
const TIME_RE = /\biTime\b/;

interface SkslState {
  lastWarned?: string | null;
}

function getState(ctx: RenderContext, nodeId: string): SkslState {
  const key = `sksl-shader:${nodeId}`;
  let s = ctx.state[key] as SkslState | undefined;
  if (!s) {
    s = {};
    ctx.state[key] = s;
  }
  return s;
}

// Text + compile status for MCP (get_shader_errors / get_graph) — null error
// when the program compiled. Without CanvasKit loaded only text checks run.
export function inspectSkslShader(params: Record<string, unknown>): {
  ok: boolean;
  compiled: boolean;
  error?: string;
  preludeLines: number;
  problems: string[];
  warnings: string[];
  unsupported: string[];
} {
  const prog = buildSkslProgram(params);
  const lint = lintSksl(typeof params.expression === "string" ? params.expression : "");
  const kit = canvasKit();
  let error: string | undefined;
  if (kit) {
    const r = compileSksl(kit, prog.sksl);
    if (r.error) error = userLineError(r.error, prog.preludeLines);
  }
  return {
    ok: !error && lint.problems.length === 0 && prog.unsupported.length === 0,
    compiled: !!kit,
    ...(error ? { error } : {}),
    preludeLines: prog.preludeLines,
    problems: lint.problems,
    warnings: lint.warnings,
    unsupported: prog.unsupported,
  };
}

export const skslShaderNode: NodeDefinition = {
  type: "sksl-shader",
  name: "SkSL Shader",
  category: "image",
  subcategory: "generator",
  description:
    "A Skia runtime shader (SkSL) rendered by Skia itself through CanvasKit — the same program React Native Skia runs on device, so the preview is the shipped shader rather than a translation. Write helpers plus `half4 main(float2 fragCoord)`: fragCoord is pixels Y-DOWN, iResolution.xy is the canvas size, iTime is seconds, wired images are iImage1..iImage4 (sample with iImage1.eval(xy)), and the return value is PREMULTIPLIED. Tunables are // comments synced into controls: // ch(\"k\", 0.5, 0, 1) → float k; // color(\"tint\", \"#ff8800\") → float4 tint (straight alpha, layout(color)); // toggle(\"on\", true) → int on (SkSL forbids bool uniforms); // pick(\"mode\", \"a\", \"b\") → int mode plus const int mode_a, mode_b. Skia compiles strict GLSL ES 1.0: no uint or bitwise ops, no while loops, constant loop bounds (break out early), no dFdx/fwidth. Scalar/toggle/color channels are wireable — drive them from keyframed Animated Value / Color nodes to export a Reanimated timeline.",
  searchAliases: ["skia", "sksl", "react native", "runtime effect", "shader", "canvaskit"],
  facts: {
    reads: ["time"],
    gotchas: [
      "fragCoord is Y-DOWN pixels (Skia local coords), unlike GLSL Expression's Y-up v_uv; divide by iResolution.xy for 0..1.",
      "Return premultiplied color (rgb * a); an unpremultiplied return with alpha < 1 renders too bright, exactly as on device.",
      "Rendered by CanvasKit in its own WebGL context: the first frames are transparent until the 7 MB WASM loads, then it re-renders.",
      "Wired images cross into Skia as 8-bit RGBA through a CPU readback per frame, so HDR input values clip and large inputs cost.",
      "ramp() and curve() channels have no SkSL lowering yet; they are reported as unsupported and their uniforms are not declared.",
      "`half` is 16-bit on iOS Metal but 32-bit in this preview — keep hashes and large coordinates in float.",
    ],
  },
  backend: "webgl2",
  inputs: IMAGE_SOCKETS.map((name, i) => ({
    name,
    label: SKSL_CHILD_NAMES[i],
    type: "image",
    required: false,
  })),
  resolveInputs(params): InputSocketDef[] {
    const entries = (params.inputs as ExprInput[]) ?? [];
    return [
      ...IMAGE_SOCKETS.map<InputSocketDef>((name, i) => ({
        name,
        label: SKSL_CHILD_NAMES[i],
        type: "image",
        required: false,
      })),
      ...entries
        .filter((e) => channelSocketType(e) !== null)
        .map<InputSocketDef>((e) => ({
          name: `in:${e.id}`,
          label: e.name,
          type: channelSocketType(e)!,
          required: false,
        })),
    ];
  },
  params: [
    {
      name: "inputs",
      label: "Channels",
      type: "expr_inputs",
      default: DEFAULT_CHANNELS,
      channelSync: true,
    },
    {
      name: "expression",
      label: "SkSL",
      type: "string",
      multiline: true,
      default: DEFAULT_SOURCE,
    },
    {
      name: "on_error",
      label: "On error",
      type: "enum",
      options: ["transparent", "magenta"],
      default: "transparent",
    },
  ],
  primaryOutput: "image",
  auxOutputs: [],
  // The clock only when the source reads iTime; CanvasKit readiness always,
  // so the transparent placeholder rendered before the WASM landed is not
  // served from cache afterwards.
  fingerprintExtras(params, ctx) {
    const source = (params.expression as string) ?? "";
    const ck = canvasKitReady() ? "ck1" : "ck0";
    return TIME_RE.test(source) ? `${ck}|t:${ctx.time}` : ck;
  },

  compute({ inputs, params, ctx, nodeId }) {
    const state = getState(ctx, nodeId);
    const fail = (msg: string) => {
      if (state.lastWarned !== msg) {
        console.warn(`[SkSL Shader ${nodeId}] ${msg}`);
        state.lastWarned = msg;
      }
      const out = ctx.allocImage();
      ctx.clearTarget(out, params.on_error === "magenta" ? [1, 0, 1, 1] : [0, 0, 0, 0]);
      return { primary: out };
    };

    const kit = canvasKit();
    if (!kit) {
      const err = canvasKitError();
      if (err) return fail(err);
      void ensureCanvasKit().catch(() => {});
      const out = ctx.allocImage();
      ctx.clearTarget(out, [0, 0, 0, 0]);
      return { primary: out };
    }

    const prog = buildSkslProgram(params);
    const lint = lintSksl(typeof params.expression === "string" ? params.expression : "");
    if (lint.problems.length) return fail(lint.problems.join(" "));
    const compiled = compileSksl(kit, prog.sksl);
    if (!compiled.effect) return fail(userLineError(compiled.error, prog.preludeLines));
    if (prog.unsupported.length && state.lastWarned !== "unsupported") {
      console.warn(
        `[SkSL Shader ${nodeId}] ramp/curve channels have no SkSL lowering yet: ${prog.unsupported.join(", ")}`
      );
      state.lastWarned = "unsupported";
    } else if (!prog.unsupported.length) {
      state.lastWarned = null;
    }

    const width = ctx.width;
    const height = ctx.height;
    const uniforms = packUniforms(compiled.effect, {
      iResolution: [width, height, 1],
      iTime: ctx.time,
      ...channelUniformValues(prog.channels, readChannelValues(prog.channels, inputs)),
    });
    const children = prog.children.map((name) => {
      const v = inputs[IMAGE_SOCKETS[SKSL_CHILD_NAMES.indexOf(name as (typeof SKSL_CHILD_NAMES)[number])]];
      return v && v.kind === "image" ? v : undefined;
    });
    const out = renderSkslToImage(ctx, kit, compiled.effect, uniforms, children, width, height);
    if (!out) return fail(skiaGpuError() ?? "CanvasKit render failed");
    return { primary: out };
  },

  dispose(ctx, nodeId) {
    delete ctx.state[`sksl-shader:${nodeId}`];
  },

  validateParams(params) {
    const src = typeof params.expression === "string" ? params.expression : "";
    if (!src.trim()) return ["SkSL source is empty."];
    return lintSksl(src).problems;
  },
};
