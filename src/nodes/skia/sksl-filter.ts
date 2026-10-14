import type { ExprInput, InputSocketDef, NodeDefinition } from "@/engine/types";
import { channelSocketType, readChannelValues, syncChannelInputs } from "@/engine/expr-channels";
import { canvasKit } from "@/engine/skia/canvaskit";
import { bindParam, bindStatic, type Bind, type SkslProgramIR } from "@/engine/skia/scene-ir";
import { channelUniformValues, compileSksl } from "@/engine/skia/sksl-program";
import { buildSkslFilterProgram, lintSkslFilter, skslFilterError } from "@/engine/skia/sksl-filter";
import { CONTENT_CHILD, filterGroup, runtimeFilter, wrapDrawing } from "./filter-shared";

// SkSL Filter (Skia) — the RuntimeShader stage as an authoring node: an
// SkSL program over the rendered drawing below it (React Native Skia
// <RuntimeShader> on a Group layer). The SkSL Shader node's contract —
// prelude, lints, `// ch(…)` channels, error lines mapped to the user's
// source — with the input as `content` (engine/skia/sksl-filter.ts).
// Channels are uniforms bound to `ch:<name>`: keyframe them (set_keyframes
// with the channel name) or wire Animated Value / Color into them, exactly
// as on SkSL Shader, and they export as timeline tracks.
//
// The node compiles its program when CanvasKit is loaded so a Skia error
// shows as a problem on the drawing (the Skia Canvas lists it, the export
// refuses); the drawing then passes through unfiltered.

const DEFAULT_SOURCE = `// SkSL filter over the drawing wired into this node — the same program
// React Native Skia runs as a <RuntimeShader> image filter.
// content.eval(xy) is that drawing, PREMULTIPLIED sRGB; fragCoord is px,
// Y-DOWN; iResolution.xy = canvas size, iTime = seconds. Return
// PREMULTIPLIED sRGB. Tunables are comments Sync turns into controls:
// ch → float, color → float4, toggle → int 0/1, pick → int + consts.
// ch("amount", 0.6, 0, 1)
// color("tint", "#ffb070")

half4 main(float2 fragCoord) {
  float4 c = content.eval(fragCoord);
  float2 uv = fragCoord / iResolution.xy;
  float vignette = 1.0 - amount * smoothstep(0.25, 0.75, length(uv - 0.5));
  float3 rgb = mix(c.rgb, c.rgb * tint.rgb, 0.5 * amount) * vignette;
  return half4(float4(rgb, c.a));
}`;

const DEFAULT_CHANNELS = syncChannelInputs([], DEFAULT_SOURCE);

export const skiaSkslFilterNode: NodeDefinition = {
  type: "skia-sksl-filter",
  name: "SkSL Filter (Skia)",
  category: "image",
  subcategory: "modifier",
  description:
    "An SkSL program over the Skia drawing wired into it — React Native Skia's <RuntimeShader> image filter on a Group layer. Write helpers plus `half4 main(float2 fragCoord)`; sample the input with content.eval(xy) (premultiplied sRGB), fragCoord is px Y-DOWN, iResolution.xy the canvas size, iTime seconds; return premultiplied sRGB. Tunables are // ch(\"k\", 0.5, 0, 1) / color() / toggle() / pick() comments synced into channels — keyframe them or wire Animated Value / Color in, as on SkSL Shader. Colors are sRGB numbers on every canvas (the node converts for Display P3).",
  searchAliases: ["skia", "sksl", "runtime shader", "filter", "post", "react native"],
  facts: {
    reads: ["time"],
    gotchas: [
      "content.eval is the drawing below, premultiplied; fragCoord is the filter layer's local px, Y-DOWN (canvas px at the scene root).",
      "Return premultiplied colour (rgb * a), as on device.",
      "A runtime image filter: native React Native Skia only — RN web has no RuntimeShader filter, so a web export doesn't play it.",
      "Sampling content far from fragCoord reads transparent past the drawn area; Skia doesn't promise content outside the layer.",
      "ramp() and curve() channels are refused: their lookup tables would be extra child shaders, and an RN RuntimeShader filter binds only content.",
    ],
  },
  backend: "webgl2",
  skia: { class: "filter" },
  noMaskInput: true,
  inputs: [{ name: "content", label: "Content", type: "skia_draw", required: true }],
  resolveInputs(params): InputSocketDef[] {
    const entries = (params.inputs as ExprInput[]) ?? [];
    return [
      { name: "content", label: "Content", type: "skia_draw", required: true },
      ...entries
        .filter((e) => e.name !== CONTENT_CHILD && channelSocketType(e) !== null)
        .map<InputSocketDef>((e) => ({ name: `in:${e.id}`, label: e.name, type: channelSocketType(e)!, required: false })),
    ];
  },
  params: [
    { name: "inputs", label: "Channels", type: "expr_inputs", default: DEFAULT_CHANNELS, channelSync: true },
    { name: "expression", label: "SkSL", type: "string", multiline: true, default: DEFAULT_SOURCE },
  ],
  primaryOutput: "skia_draw",
  auxOutputs: [],
  tickDriven: true,
  // The clock only when the source reads iTime (the bound iTime advances).
  fingerprintExtras(params, ctx) {
    return /\biTime\b/.test(String(params.expression ?? "")) ? `t:${ctx.time}` : "";
  },

  compute({ inputs, params, ctx, nodeId }) {
    const prog = buildSkslFilterProgram(params);
    const lint = lintSkslFilter(typeof params.expression === "string" ? params.expression : "");
    const problems = [...lint.problems.map((p) => `SkSL Filter (Skia) "${nodeId}": ${p}`)];
    if (prog.unsupported.length) {
      problems.push(
        `SkSL Filter (Skia) "${nodeId}": ramp / curve channels (${prog.unsupported.join(", ")}) need lookup-table child shaders, and a RuntimeShader image filter binds only its content — use scalar / color channels.`
      );
    }
    const kit = canvasKit();
    if (kit && !problems.length) {
      const c = compileSksl(kit, prog.sksl);
      if (!c.effect) problems.push(`SkSL Filter (Skia) "${nodeId}": ${skslFilterError(c.error, prog)}`);
    }
    if (problems.length) return { primary: wrapDrawing(inputs.content, nodeId, problems, (content) => content) };

    const values = channelUniformValues(prog.channels, readChannelValues(prog.channels, inputs));
    const uniforms: Record<string, Bind<number | number[]>> = {
      iResolution: bindStatic([ctx.width, ctx.height, 1]),
      iTime: bindStatic(ctx.time),
    };
    for (const ch of prog.channels) {
      const v = values[ch.name];
      if (v === undefined) continue;
      uniforms[ch.name] = bindParam(typeof v === "number" ? v : [...v], nodeId, `ch:${ch.name}`);
    }
    const program: SkslProgramIR = { sksl: prog.sksl, uniforms, children: [], fused: ["sksl filter"] };
    return { primary: filterGroup(inputs.content, nodeId, { imageFilters: [runtimeFilter(program)] }) };
  },

  validateParams(params) {
    const src = typeof params.expression === "string" ? params.expression : "";
    if (!src.trim()) return ["SkSL source is empty."];
    return lintSkslFilter(src).problems;
  },
};
