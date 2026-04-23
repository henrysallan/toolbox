import type {
  InputSocketDef,
  NodeDefinition,
  SocketType,
  SocketValue,
  UvValue,
} from "@/engine/types";
import {
  disposePlaceholderTex,
  getPlaceholderTex,
} from "@/engine/placeholder-tex";

// Human-readable labels double as enum values so the param dropdown needs no
// extra mapping. The switch in `compute` keys off these exact strings.
const OPERATIONS = [
  // Functions
  "Add",
  "Subtract",
  "Multiply",
  "Divide",
  "Multiply Add",
  "Power",
  "Logarithm",
  "Square Root",
  "Inverse Square Root",
  "Absolute",
  "Exponent",
  // Comparison
  "Minimum",
  "Maximum",
  "Less Than",
  "Greater Than",
  "Sign",
  "Compare",
  "Smooth Minimum",
  "Smooth Maximum",
  // Rounding
  "Round",
  "Floor",
  "Ceiling",
  "Truncate",
  "Fraction",
  "Truncated Modulo",
  "Floored Modulo",
  "Wrap",
  "Snap",
  "Ping-Pong",
  // Trig
  "Sine",
  "Cosine",
  "Tangent",
  "Arcsine",
  "Arccosine",
  "Arctangent",
  "Arctan2",
  "Hyperbolic Sine",
  "Hyperbolic Cosine",
  "Hyperbolic Tangent",
  // Conversion
  "To Radians",
  "To Degrees",
] as const;

type Operation = (typeof OPERATIONS)[number];

// How many of the three inputs a given operation actually reads. Anything
// not listed here is treated as 1-input. Drives both the UI (which input
// fields show) and the socket list (how many input handles render).
const INPUT_COUNT: Record<string, 1 | 2 | 3> = {
  Add: 2,
  Subtract: 2,
  Multiply: 2,
  Divide: 2,
  "Multiply Add": 3,
  Power: 2,
  Logarithm: 2,
  Minimum: 2,
  Maximum: 2,
  "Less Than": 2,
  "Greater Than": 2,
  Compare: 3,
  "Smooth Minimum": 3,
  "Smooth Maximum": 3,
  "Truncated Modulo": 2,
  "Floored Modulo": 2,
  Wrap: 3,
  Snap: 2,
  "Ping-Pong": 2,
  Arctan2: 2,
};

function inputCountFor(op: string): 1 | 2 | 3 {
  return INPUT_COUNT[op] ?? 1;
}

// "A" labels are fine for Add/Subtract/etc., but for operations like Wrap
// (value, min, max) or Snap (value, increment) the labels make the node
// self-documenting. Unlisted ops fall through to A/B/C.
const INPUT_LABELS: Record<string, [string, string?, string?]> = {
  "Multiply Add": ["Value", "Multiplier", "Addend"],
  Compare: ["A", "B", "Epsilon"],
  "Smooth Minimum": ["A", "B", "Distance"],
  "Smooth Maximum": ["A", "B", "Distance"],
  Wrap: ["Value", "Min", "Max"],
  Snap: ["Value", "Increment"],
  "Ping-Pong": ["Value", "Scale"],
};

function labelsFor(op: string): [string, string, string] {
  const custom = INPUT_LABELS[op];
  return [custom?.[0] ?? "A", custom?.[1] ?? "B", custom?.[2] ?? "C"];
}

function readScalar(
  sock: SocketValue | undefined,
  fallback: number
): number {
  if (sock && sock.kind === "scalar") return sock.value;
  return fallback ?? 0;
}

// UV-mode shader: each op gets its own index matching OPERATIONS above so
// TS and GLSL stay in lockstep. Ops that don't vectorize sensibly (Smooth
// Min/Max, Wrap, Arctan2) fall through to a passthrough of A.
const MATH_UV_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform int u_op;
uniform int u_clamp;
uniform int u_hasUvA;
uniform sampler2D u_aUv;
uniform vec2 u_aConst;
uniform int u_hasUvB;
uniform sampler2D u_bUv;
uniform vec2 u_bConst;
uniform int u_hasUvC;
uniform sampler2D u_cUv;
uniform vec2 u_cConst;
out vec4 outColor;

vec2 safeDiv(vec2 a, vec2 b) {
  return vec2(
    abs(b.x) < 1e-5 ? 0.0 : a.x / b.x,
    abs(b.y) < 1e-5 ? 0.0 : a.y / b.y
  );
}

vec2 modTrunc(vec2 a, vec2 b) {
  return vec2(
    abs(b.x) < 1e-5 ? 0.0 : a.x - trunc(a.x / b.x) * b.x,
    abs(b.y) < 1e-5 ? 0.0 : a.y - trunc(a.y / b.y) * b.y
  );
}
vec2 modFloor(vec2 a, vec2 b) {
  return vec2(
    abs(b.x) < 1e-5 ? 0.0 : a.x - floor(a.x / b.x) * b.x,
    abs(b.y) < 1e-5 ? 0.0 : a.y - floor(a.y / b.y) * b.y
  );
}
vec2 snap(vec2 a, vec2 b) {
  return vec2(
    abs(b.x) < 1e-5 ? a.x : floor(a.x / b.x + 0.5) * b.x,
    abs(b.y) < 1e-5 ? a.y : floor(a.y / b.y + 0.5) * b.y
  );
}
vec2 pingPong2(vec2 v, vec2 s) {
  vec2 twoS = 2.0 * s;
  vec2 phased = mod(mod(v, twoS) + twoS, twoS);
  return s - abs(phased - s);
}

void main() {
  vec2 a = u_hasUvA == 1 ? texture(u_aUv, v_uv).rg : u_aConst;
  vec2 b = u_hasUvB == 1 ? texture(u_bUv, v_uv).rg : u_bConst;
  vec2 c = u_hasUvC == 1 ? texture(u_cUv, v_uv).rg : u_cConst;
  vec2 r = a;

  if (u_op == 0) r = a + b;
  else if (u_op == 1) r = a - b;
  else if (u_op == 2) r = a * b;
  else if (u_op == 3) r = safeDiv(a, b);
  else if (u_op == 4) r = a * b + c;
  else if (u_op == 5) r = pow(max(a, vec2(0.0)), b);
  else if (u_op == 7) r = sqrt(max(a, vec2(0.0)));
  else if (u_op == 8) r = vec2(a.x <= 0.0 ? 0.0 : 1.0 / sqrt(a.x),
                                a.y <= 0.0 ? 0.0 : 1.0 / sqrt(a.y));
  else if (u_op == 9) r = abs(a);
  else if (u_op == 10) r = exp(a);
  else if (u_op == 11) r = min(a, b);
  else if (u_op == 12) r = max(a, b);
  else if (u_op == 13) r = vec2(a.x < b.x ? 1.0 : 0.0, a.y < b.y ? 1.0 : 0.0);
  else if (u_op == 14) r = vec2(a.x > b.x ? 1.0 : 0.0, a.y > b.y ? 1.0 : 0.0);
  else if (u_op == 15) r = sign(a);
  else if (u_op == 16) r = vec2(abs(a.x - b.x) <= c.x ? 1.0 : 0.0,
                                 abs(a.y - b.y) <= c.y ? 1.0 : 0.0);
  else if (u_op == 19) r = vec2(floor(a.x + 0.5), floor(a.y + 0.5));
  else if (u_op == 20) r = floor(a);
  else if (u_op == 21) r = ceil(a);
  else if (u_op == 22) r = trunc(a);
  else if (u_op == 23) r = fract(a);
  else if (u_op == 24) r = modTrunc(a, b);
  else if (u_op == 25) r = modFloor(a, b);
  else if (u_op == 27) r = snap(a, b);
  else if (u_op == 28) r = pingPong2(a, b);
  else if (u_op == 29) r = sin(a);
  else if (u_op == 30) r = cos(a);
  else if (u_op == 31) r = tan(a);
  else if (u_op == 32) r = asin(clamp(a, -1.0, 1.0));
  else if (u_op == 33) r = acos(clamp(a, -1.0, 1.0));
  else if (u_op == 34) r = atan(a);
  else if (u_op == 36) r = vec2(sinh(a.x), sinh(a.y));
  else if (u_op == 37) r = vec2(cosh(a.x), cosh(a.y));
  else if (u_op == 38) r = vec2(tanh(a.x), tanh(a.y));
  else if (u_op == 39) r = a * (3.14159265358979 / 180.0);
  else if (u_op == 40) r = a * (180.0 / 3.14159265358979);

  if (u_clamp == 1) r = clamp(r, 0.0, 1.0);
  outColor = vec4(r, 0.0, 1.0);
}`;

// Blender-style smooth min: the `distance` param controls how broad the
// blend between the two values is. Zero degenerates to plain min.
function smoothMin(a: number, b: number, k: number): number {
  if (k <= 0) return Math.min(a, b);
  const h = Math.max(0, Math.min(1, 0.5 + (0.5 * (b - a)) / k));
  return b * (1 - h) + a * h - k * h * (1 - h);
}

function smoothMax(a: number, b: number, k: number): number {
  return -smoothMin(-a, -b, k);
}

function wrap(v: number, lo: number, hi: number): number {
  const range = hi - lo;
  if (range === 0) return lo;
  return v - Math.floor((v - lo) / range) * range;
}

function pingpong(v: number, scale: number): number {
  if (scale === 0) return 0;
  const twoScale = 2 * scale;
  const phased = ((v % twoScale) + twoScale) % twoScale;
  return scale - Math.abs(phased - scale);
}

function evalOp(op: Operation, a: number, b: number, c: number): number {
  switch (op) {
    case "Add":
      return a + b;
    case "Subtract":
      return a - b;
    case "Multiply":
      return a * b;
    case "Divide":
      return b === 0 ? 0 : a / b;
    case "Multiply Add":
      return a * b + c;
    case "Power":
      return Math.pow(a, b);
    case "Logarithm":
      return a <= 0 || b <= 0 || b === 1 ? 0 : Math.log(a) / Math.log(b);
    case "Square Root":
      return a < 0 ? 0 : Math.sqrt(a);
    case "Inverse Square Root":
      return a <= 0 ? 0 : 1 / Math.sqrt(a);
    case "Absolute":
      return Math.abs(a);
    case "Exponent":
      return Math.exp(a);
    case "Minimum":
      return Math.min(a, b);
    case "Maximum":
      return Math.max(a, b);
    case "Less Than":
      return a < b ? 1 : 0;
    case "Greater Than":
      return a > b ? 1 : 0;
    case "Sign":
      return Math.sign(a);
    case "Compare":
      return Math.abs(a - b) <= c ? 1 : 0;
    case "Smooth Minimum":
      return smoothMin(a, b, c);
    case "Smooth Maximum":
      return smoothMax(a, b, c);
    case "Round":
      return Math.round(a);
    case "Floor":
      return Math.floor(a);
    case "Ceiling":
      return Math.ceil(a);
    case "Truncate":
      return Math.trunc(a);
    case "Fraction":
      return a - Math.floor(a);
    case "Truncated Modulo":
      return b === 0 ? 0 : a - Math.trunc(a / b) * b;
    case "Floored Modulo":
      return b === 0 ? 0 : a - Math.floor(a / b) * b;
    case "Wrap":
      return wrap(a, b, c);
    case "Snap":
      return b === 0 ? a : Math.round(a / b) * b;
    case "Ping-Pong":
      return pingpong(a, b);
    case "Sine":
      return Math.sin(a);
    case "Cosine":
      return Math.cos(a);
    case "Tangent":
      return Math.tan(a);
    case "Arcsine":
      return Math.asin(Math.max(-1, Math.min(1, a)));
    case "Arccosine":
      return Math.acos(Math.max(-1, Math.min(1, a)));
    case "Arctangent":
      return Math.atan(a);
    case "Arctan2":
      return Math.atan2(a, b);
    case "Hyperbolic Sine":
      return Math.sinh(a);
    case "Hyperbolic Cosine":
      return Math.cosh(a);
    case "Hyperbolic Tangent":
      return Math.tanh(a);
    case "To Radians":
      return (a * Math.PI) / 180;
    case "To Degrees":
      return (a * 180) / Math.PI;
  }
}

export const mathNode: NodeDefinition = {
  type: "math",
  name: "Math",
  category: "utility",
  description:
    "Scalar math: arithmetic, comparison, rounding, trig, and conversion. Each input can be a connected scalar or a value typed in the panel.",
  backend: "webgl2",
  // Scalar math has no GL work and no per-frame state — cache-safe.
  stable: true,
  inputs: [
    { name: "a", label: "A", type: "scalar", required: false },
    { name: "b", label: "B", type: "scalar", required: false },
    { name: "c", label: "C", type: "scalar", required: false },
  ],
  resolveInputs(params) {
    const op = (params.operation as string) ?? "Add";
    const mode = (params.mode as string) ?? "scalar";
    const n = inputCountFor(op);
    const [la, lb, lc] = labelsFor(op);
    const type: SocketType = mode === "uv" ? "uv" : "scalar";
    const sockets: InputSocketDef[] = [
      { name: "a", label: la, type, required: false },
    ];
    if (n >= 2) sockets.push({ name: "b", label: lb, type, required: false });
    if (n >= 3) sockets.push({ name: "c", label: lc, type, required: false });
    return sockets;
  },
  resolvePrimaryOutput(params) {
    return (params.mode as string) === "uv" ? "uv" : "scalar";
  },
  params: [
    {
      name: "mode",
      label: "Mode",
      type: "enum",
      options: ["scalar", "uv"],
      default: "scalar",
    },
    {
      name: "operation",
      label: "Operation",
      type: "enum",
      options: OPERATIONS as unknown as string[],
      default: "Add",
    },
    {
      name: "a",
      label: "A",
      type: "scalar",
      min: -1000,
      max: 1000,
      softMax: 10,
      step: 0.01,
      default: 0,
    },
    {
      name: "b",
      label: "B",
      type: "scalar",
      min: -1000,
      max: 1000,
      softMax: 10,
      step: 0.01,
      default: 0,
      visibleIf: (p) => inputCountFor(p.operation as string) >= 2,
    },
    {
      name: "c",
      label: "C",
      type: "scalar",
      min: -1000,
      max: 1000,
      softMax: 10,
      step: 0.01,
      default: 0,
      visibleIf: (p) => inputCountFor(p.operation as string) >= 3,
    },
    {
      name: "clamp",
      label: "Clamp to 0-1",
      type: "boolean",
      default: false,
    },
  ],
  primaryOutput: "scalar",
  auxOutputs: [],

  compute({ inputs, params, ctx, nodeId }) {
    const mode = (params.mode as string) ?? "scalar";
    const op = ((params.operation as string) ?? "Add") as Operation;
    const clamp = !!params.clamp;

    if (mode === "uv") {
      const output = ctx.allocUv();
      const prog = ctx.getShader("math/uv", MATH_UV_FS);
      const opIdx = OPERATIONS.indexOf(op);
      const placeholder = getPlaceholderTex(
        ctx.gl,
        ctx.state,
        `math:${nodeId}:zero`
      );

      const resolved = (
        sock: SocketValue | undefined,
        paramVal: number
      ): { hasUv: 0 | 1; tex: WebGLTexture; cx: number; cy: number } => {
        if (sock?.kind === "uv") {
          return {
            hasUv: 1,
            tex: (sock as UvValue).texture,
            cx: 0,
            cy: 0,
          };
        }
        // Scalar input overrides the typed param; otherwise fall back to it.
        const s = sock?.kind === "scalar" ? sock.value : paramVal;
        return { hasUv: 0, tex: placeholder, cx: s, cy: s };
      };

      const A = resolved(inputs.a, (params.a as number) ?? 0);
      const B = resolved(inputs.b, (params.b as number) ?? 0);
      const C = resolved(inputs.c, (params.c as number) ?? 0);

      ctx.drawFullscreen(prog, output, (gl) => {
        gl.uniform1i(gl.getUniformLocation(prog, "u_op"), opIdx);
        gl.uniform1i(gl.getUniformLocation(prog, "u_clamp"), clamp ? 1 : 0);

        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, A.tex);
        gl.uniform1i(gl.getUniformLocation(prog, "u_aUv"), 0);
        gl.uniform1i(gl.getUniformLocation(prog, "u_hasUvA"), A.hasUv);
        gl.uniform2f(gl.getUniformLocation(prog, "u_aConst"), A.cx, A.cy);

        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, B.tex);
        gl.uniform1i(gl.getUniformLocation(prog, "u_bUv"), 1);
        gl.uniform1i(gl.getUniformLocation(prog, "u_hasUvB"), B.hasUv);
        gl.uniform2f(gl.getUniformLocation(prog, "u_bConst"), B.cx, B.cy);

        gl.activeTexture(gl.TEXTURE2);
        gl.bindTexture(gl.TEXTURE_2D, C.tex);
        gl.uniform1i(gl.getUniformLocation(prog, "u_cUv"), 2);
        gl.uniform1i(gl.getUniformLocation(prog, "u_hasUvC"), C.hasUv);
        gl.uniform2f(gl.getUniformLocation(prog, "u_cConst"), C.cx, C.cy);
      });

      return { primary: output };
    }

    // Scalar path — unchanged.
    const a = readScalar(inputs.a, (params.a as number) ?? 0);
    const b = readScalar(inputs.b, (params.b as number) ?? 0);
    const c = readScalar(inputs.c, (params.c as number) ?? 0);
    let v = evalOp(op, a, b, c);
    if (clamp) v = Math.max(0, Math.min(1, v));
    return { primary: { kind: "scalar", value: v } };
  },

  dispose(ctx, nodeId) {
    disposePlaceholderTex(ctx.gl, ctx.state, `math:${nodeId}:zero`);
  },
};
