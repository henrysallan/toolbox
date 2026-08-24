import type {
  ExprInput,
  ImageValue,
  InputSocketDef,
  NodeDefinition,
  RenderContext,
} from "@/engine/types";

// GLSL Expression — the per-pixel member of the expression family
// (081426_glsl-expression.md M1). The user writes the BODY of main() in
// GLSL 300 es; the node owns the template (#version, precision, io,
// uniforms), compiles through ctx.tryShader (per-node key, in-place
// recompile on edit, cached failures), and draws one fullscreen pass.
//
// Contract the template exposes:
//   v_uv               — Y-UP canvas UV (the engine texture convention)
//   u_a..u_d           — wired image inputs (unwired = 1×1 transparent)
//   u_res / u_aspect   — canvas px size / w÷h
//   u_time / u_frame   — the clock (folded into the fingerprint only when
//                        referenced, so static shaders cache)
//   <name>             — one float uniform per ch() channel: declare
//                        tunables as `// ch("name", default, min, max)`
//                        comments and hit Sync (the Point Expression
//                        machinery, verbatim — the comment syntax is
//                        GLSL-legal and the scanner doesn't care).
//   fragColor          — the output, STRAIGHT alpha (engine invariant —
//                        do not premultiply).
//
// A compile error keeps the last intent visible: output follows On error
// (pass `a` through, or transparent black), and the trimmed info log
// warns once per source to the console.

const DEFAULT_SOURCE = `// Body of main(). Read inputs with texture(u_a, v_uv) (u_b..u_d),
// the clock with u_time, canvas size with u_res. Declare tunables as
// comments — // ch("amount", 0.5, 0, 1) — hit Sync, then read \`amount\`
// as a float uniform. Write fragColor (straight alpha).
vec4 a = texture(u_a, v_uv);
fragColor = a;`;

// Uniform names come from user channel names — only clean GLSL
// identifiers that don't shadow the template's own declarations compile.
const GLSL_IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const TEMPLATE_NAMES = new Set([
  "u_a",
  "u_b",
  "u_c",
  "u_d",
  "u_res",
  "u_time",
  "u_frame",
  "u_aspect",
  "v_uv",
  "fragColor",
  "main",
]);

function usableChannelName(name: string): boolean {
  return (
    GLSL_IDENT_RE.test(name) &&
    !TEMPLATE_NAMES.has(name) &&
    !name.startsWith("gl_")
  );
}

function buildSource(body: string, channelNames: string[]): string {
  return `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 fragColor;
uniform sampler2D u_a;
uniform sampler2D u_b;
uniform sampler2D u_c;
uniform sampler2D u_d;
uniform vec2 u_res;
uniform float u_time;
uniform float u_frame;
uniform float u_aspect;
${channelNames.map((n) => `uniform float ${n};`).join("\n")}
void main() {
${body}
}`;
}

interface GlslState {
  // 1×1 transparent fallback bound to unwired samplers (allocated once,
  // released in dispose).
  blank?: ImageValue;
  lastWarned?: string | null;
}

function getState(ctx: RenderContext, nodeId: string): GlslState {
  const key = `glsl-expression:${nodeId}`;
  let s = ctx.state[key] as GlslState | undefined;
  if (!s) {
    s = {};
    ctx.state[key] = s;
  }
  return s;
}

const IMAGE_INPUTS = ["a", "b", "c", "d"] as const;
const TIME_RE = /\bu_(time|frame)\b/;

export const glslExpressionNode: NodeDefinition = {
  type: "glsl-expression",
  name: "GLSL Expression",
  category: "image",
  subcategory: "modifier",
  description:
    "Write the body of a GLSL fragment shader and run it as one fullscreen pass — the per-pixel counterpart to Point Expression. Read wired images with texture(u_a, v_uv) (u_b–u_d), the clock with u_time/u_frame, and canvas size with u_res; write fragColor with straight alpha. Declare tunables as // ch(\"name\", default, min, max) comments and hit Sync to mint sliders that are also wireable inputs, readable as float uniforms. A compile error shows once in the console and the output follows On error.",
  backend: "webgl2",
  inputs: [
    { name: "a", type: "image", required: false },
    { name: "b", type: "image", required: false },
    { name: "c", type: "image", required: false },
    { name: "d", type: "image", required: false },
  ],
  resolveInputs(params): InputSocketDef[] {
    const entries = (params.inputs as ExprInput[]) ?? [];
    return [
      { name: "a", type: "image", required: false },
      { name: "b", type: "image", required: false },
      { name: "c", type: "image", required: false },
      { name: "d", type: "image", required: false },
      ...entries
        .filter((e) => !e.options)
        .map<InputSocketDef>((e) => ({
          name: `in:${e.id}`,
          label: e.name,
          type: "scalar",
          required: false,
        })),
    ];
  },
  params: [
    {
      name: "inputs",
      label: "Channels",
      type: "expr_inputs",
      default: [],
      channelSync: true,
    },
    {
      name: "expression",
      label: "Shader",
      type: "string",
      multiline: true,
      default: DEFAULT_SOURCE,
    },
    {
      name: "on_error",
      label: "On error",
      type: "enum",
      options: ["passthrough", "transparent"],
      default: "passthrough",
    },
  ],
  primaryOutput: "image",
  auxOutputs: [],
  // Fold time into the fingerprint only when the source references the
  // clock — static shaders cache as constants (the Point Expression
  // TIME_RE pattern, textually on the GLSL source).
  fingerprintExtras(params, ctx) {
    const source = (params.expression as string) ?? "";
    return TIME_RE.test(source) ? `t:${ctx.time}` : "";
  },

  compute({ inputs, params, ctx, nodeId }) {
    const entries = (params.inputs as ExprInput[]) ?? [];
    const body = (params.expression as string) ?? "";
    const state = getState(ctx, nodeId);

    // Channel values by name (wired scalar wins over the slider default);
    // only GLSL-safe names become uniforms.
    const channelNames: string[] = [];
    const channelValues: number[] = [];
    for (const e of entries) {
      if (e.options || !usableChannelName(e.name)) continue;
      const sock = inputs[`in:${e.id}`];
      channelNames.push(e.name);
      channelValues.push(
        sock && sock.kind === "scalar"
          ? sock.value
          : typeof e.default === "number"
            ? e.default
            : 0
      );
    }

    const { program, error } = ctx.tryShader(
      `glsl-expr:${nodeId}`,
      buildSource(body, channelNames)
    );
    if (!program) {
      // Trim the source echo off the compiler message; warn once per
      // source. Line numbers in the log include the template prelude.
      const msg = (error ?? "unknown error").split("\n--\n")[0];
      if (state.lastWarned !== msg) {
        console.warn(`[GLSL Expression ${nodeId}] ${msg}`);
        state.lastWarned = msg;
      }
      const a = inputs.a;
      if ((params.on_error as string) !== "transparent" && a?.kind === "image") {
        return { primary: a };
      }
      const out = ctx.allocImage();
      ctx.clearTarget(out, [0, 0, 0, 0]);
      return { primary: out };
    }
    state.lastWarned = null;

    if (!state.blank) {
      state.blank = ctx.uploadFloat32ToImage(new Float32Array(4), 1, 1);
    }
    const blank = state.blank;

    const out = ctx.allocImage();
    ctx.drawFullscreen(program, out, (gl) => {
      for (let i = 0; i < IMAGE_INPUTS.length; i++) {
        const v = inputs[IMAGE_INPUTS[i]];
        const tex = v && v.kind === "image" ? v.texture : blank.texture;
        gl.activeTexture(gl.TEXTURE0 + i);
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.uniform1i(
          gl.getUniformLocation(program, `u_${IMAGE_INPUTS[i]}`),
          i
        );
      }
      gl.uniform2f(
        gl.getUniformLocation(program, "u_res"),
        out.width,
        out.height
      );
      gl.uniform1f(gl.getUniformLocation(program, "u_time"), ctx.time);
      gl.uniform1f(gl.getUniformLocation(program, "u_frame"), ctx.frame);
      gl.uniform1f(
        gl.getUniformLocation(program, "u_aspect"),
        out.height > 0 ? out.width / out.height : 1
      );
      for (let c = 0; c < channelNames.length; c++) {
        gl.uniform1f(
          gl.getUniformLocation(program, channelNames[c]),
          channelValues[c]
        );
      }
    });
    return { primary: out };
  },

  dispose(ctx, nodeId) {
    const key = `glsl-expression:${nodeId}`;
    const s = ctx.state[key] as GlslState | undefined;
    if (s?.blank) ctx.releaseTexture(s.blank.texture);
    delete ctx.state[key];
  },

  // Text-level sanity only — the offline validator stubs GL, so real
  // compilation happens at first eval through the tryShader error path.
  validateParams(params) {
    const raw = params.expression;
    if (raw === undefined) return [];
    if (typeof raw !== "string")
      return ["expression must be a string of GLSL."];
    const problems: string[] = [];
    if (raw.includes("#version"))
      problems.push(
        "expression is the BODY of main() — the node owns #version; remove it."
      );
    if (/\bvoid\s+main\b/.test(raw))
      problems.push(
        "expression is the BODY of main() — remove the main() declaration."
      );
    if (raw.trim() !== "" && !raw.includes("fragColor"))
      problems.push(
        "expression never writes fragColor — the output would be undefined."
      );
    return problems;
  },
};
