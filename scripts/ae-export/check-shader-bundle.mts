// bundleFromGlslExpression / writeTbxfx / validateAeShader
// (src/lib/ae-export/shader): slot assignment in channel order, enum baking,
// LUT sizes and data (the node's own bakers), pool budgets, the derivative
// refusal, the id (stable across runs, content-addressed, < 2^24), the
// .tbxfx text round trip, and the validator's structural checks. Pure — runs
// the same on Linux CI.

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeChecker } from "./harness.mts";
import { buildCurveLut, buildRampLut, CHANNEL_LUT_SIZE, readChannelValue, syncChannelInputs } from "@/engine/expr-channels";
import type { ColorRampStop } from "@/engine/color-ramp";
import type { CurvePoint } from "@/engine/float-curve";
import type { ExprInput } from "@/engine/types";
import { bundleFromGlslExpression, type BundleOptions } from "@/lib/ae-export/shader/bundle";
import { bundleId, canonicalJson, writeTbxfx } from "@/lib/ae-export/shader/tbxfx";
import { validateAeShader, type ShaderCompiler } from "@/lib/ae-export/shader/validate";
import type { AeShaderBundle } from "@/lib/ae-export/types";

const THIS = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(THIS), "..", "..");
const OPTS: BundleOptions = { name: "fixture", fps: 30, loopFrames: 120, canvas: { width: 1920, height: 1080 } };

const MIXED = `// ch("a", 0.25, 0.0, 1.0)
// toggle("t1", true)
// color("c1", "#ff8000")
// ch("b", 3.0)
// pick("mode", "soft", "hard", "x y")
// ramp("ink", "#000000", "#ff0000", "#ffffff")
// curve("fall", 1.0, 0.25, 0.0)
// color("c2", "#00ff0080")
// toggle("t2", false)
// ch("c", -2.0)
vec4 col = ink(fall(v_uv.x)) * c1 + c2 * (t1 ? a : b) + vec4(c);
if (t2 && mode == mode_hard) col = 1.0 - col;
fragColor = col + texture(u_c, v_uv) * float(mode_x_y);`;

function params(body: string, set: Record<string, unknown> = {}) {
  const inputs = syncChannelInputs([], body).map((e) => (e.name in set ? { ...e, default: set[e.name] as ExprInput["default"] } : e));
  return { inputs, expression: body };
}

function build(body: string, set?: Record<string, unknown>, opts = OPTS) {
  return bundleFromGlslExpression(params(body, set), opts);
}

const ids = () => {
  const r = build(MIXED, { mode: "hard", a: 0.75 });
  return r.ok ? r.bundle.id : -1;
};

// `node --import tsx check-shader-bundle.mts` with this set prints the id:
// the cross-process stability check below.
if (process.env.TBX_PRINT_BUNDLE_ID) console.log(`BUNDLE_ID=${ids()}`);

export default async function run(): Promise<number> {
  const c = makeChecker("shader-bundle");
  const r = build(MIXED, { mode: "hard", a: 0.75, b: 9.5 });
  if (!r.ok) {
    c.check("mixed-channel fixture bundles", false, r.errors);
    return c.failures;
  }
  const b = r.bundle;
  const msl = b.source.msl!;

  // --- slots, in channel order, per pool ---
  const slots = b.params.map((p) => `${p.name}:${p.kind}${p.slot}`).join(" ");
  c.check("params keep channel order; each kind fills its own pool from 1", slots === "a:slider1 t1:checkbox1 c1:color1 b:slider2 c2:color2 t2:checkbox2 c:slider3", slots);
  for (const [line, what] of [
    ["this->a = U.sliders[0];", "slider 1 → sliders[0]"],
    ["this->b = U.sliders[1];", "slider 2 → sliders[1]"],
    ["this->c = U.sliders[2];", "slider 3 → sliders[2]"],
    ["this->t1 = U.checkboxes[0] != 0;", "checkbox 1 → checkboxes[0] != 0"],
    ["this->t2 = U.checkboxes[1] != 0;", "checkbox 2 → checkboxes[1]"],
    ["this->c1 = U.colors[0];", "color 1 → colors[0]"],
    ["this->c2 = U.colors[1];", "color 2 → colors[1]"],
  ])
    c.check(`MSL binds ${what}`, msl.includes(line), line);

  // --- defaults = the channel's current value ---
  const p = Object.fromEntries(b.params.map((x) => [x.name, x]));
  c.check("slider default is the current value, range from ch(…, min, max)", p.a.default === 0.75 && p.a.min === 0 && p.a.max === 1, p.a);
  c.check("a slider tuned past its inferred range widens the range (AE would clamp)", p.b.default === 9.5 && (p.b.max as number) >= 9.5 && (p.b.min as number) <= 9.5, p.b);
  c.check("negative slider: the inferred range contains it", (p.c.min as number) <= -2 && (p.c.max as number) >= -2 && p.c.default === -2, p.c);
  c.check("checkbox defaults are booleans", p.t1.default === true && p.t2.default === false);
  const c2 = p.c2.default as number[];
  c.check("color default is straight RGBA 0–1 (alpha from #rrggbbaa)", c2.length === 4 && c2[0] === 0 && c2[1] === 1 && Math.abs(c2[3] - 128 / 255) < 1e-7, c2);

  const wired = build(MIXED, { mode: "hard" }, { ...OPTS, values: { a: 0.125, mode: "soft", c1: [0.5, 0.25, 0, 1] } });
  c.check(
    "opts.values wins over the rows (a wired channel's value), for params and baked picks",
    wired.ok && wired.bundle.params.find((x) => x.name === "a")?.default === 0.125 && wired.bundle.source.msl!.includes("constant int mode = 0;") && (wired.bundle.params.find((x) => x.name === "c1")?.default as number[])[1] === 0.25
  );

  // --- picks bake ---
  c.check("pick bakes its current option index", msl.includes("constant int mode = 1;"));
  c.check("pick option constants keep the node's names", ["constant int mode_soft = 0;", "constant int mode_hard = 1;", "constant int mode_x_y = 2;"].every((l) => msl.includes(l)));
  c.check("a pick is not a param", !b.params.some((x) => x.name === "mode"));
  const bad = build(MIXED, { mode: "nope" });
  c.check("an unknown pick value bakes option 0, with a warning (the node's fallback)", bad.ok && bad.bundle.source.msl!.includes("constant int mode = 0;") && bad.warnings.some((w) => w.includes('pick "mode"')));

  // --- LUTs ---
  const luts = b.luts ?? [];
  c.check("ramp / curve → u_ramp_<name> / u_curve_<name>, in channel order", luts.map((l) => l.name).join() === "u_ramp_ink,u_curve_fall", luts.map((l) => l.name));
  c.check(`LUTs are CHANNEL_LUT_SIZE (${CHANNEL_LUT_SIZE}) wide × RGBA`, luts.every((l) => l.width === CHANNEL_LUT_SIZE && l.data.length === CHANNEL_LUT_SIZE * 4));
  const rows = params(MIXED).inputs;
  const ink = buildRampLut(readChannelValue(rows.find((e) => e.name === "ink")!, undefined) as ColorRampStop[]);
  const fall = buildCurveLut(readChannelValue(rows.find((e) => e.name === "fall")!, undefined) as CurvePoint[]);
  const same = (data: number[], ref: Float32Array) => data.length === ref.length && data.every((v, i) => Math.fround(v) === ref[i]);
  c.check("ramp LUT data is the node's buildRampLut, float32-exact", same(luts[0].data, ink));
  c.check("curve LUT data is the node's buildCurveLut, float32-exact", same(luts[1].data, fall));
  c.check("LUT members bind l0, l1 in bundle.luts order", msl.includes("u_ramp_ink(l0), u_curve_fall(l1)"));

  // --- inputs / clock ---
  c.check("inputs = the samplers main() reaches", b.inputs.join() === "c", b.inputs);
  c.check("readsTime false for a static shader", b.readsTime === false);
  const timed = build("fragColor = vec4(fract(u_time), u_frame, 0.0, 1.0);");
  c.check("readsTime true when u_time / u_frame is reached", timed.ok && timed.bundle.readsTime === true);
  c.check("bundle carries name / fps / loopFrames / canvas / hostMin / glsl", b.name === "fixture" && b.fps === 30 && b.loopFrames === 120 && b.canvas.width === 1920 && b.hostMin === "1.0.0" && !!b.source.glsl?.includes("void main() {"));

  // --- budgets ---
  const many = (n: number, f: (i: number) => string, use: (i: number) => string) =>
    `${Array.from({ length: n }, (_, i) => f(i)).join("\n")}\nfragColor = vec4(0.0)${Array.from({ length: n }, (_, i) => ` + ${use(i)}`).join("")};`;
  const budget = [
    { what: "33 scalars", body: many(33, (i) => `// ch("s${i}", 1.0)`, (i) => `vec4(s${i})`), re: /33 scalar \(ch\) channels → sliders exceed the Toolbox Shader pool of 32 \(over budget: s32\)/ },
    { what: "9 colors", body: many(9, (i) => `// color("k${i}", "#ffffff")`, (i) => `k${i}`), re: /9 color channels exceed the Toolbox Shader pool of 8/ },
    { what: "9 toggles", body: many(9, (i) => `// toggle("g${i}", true)`, (i) => `vec4(g${i} ? 1.0 : 0.0)`), re: /9 toggle channels → checkboxes exceed the Toolbox Shader pool of 8/ },
    { what: "9 LUTs", body: many(9, (i) => `// ramp("r${i}", "#000000", "#ffffff")`, (i) => `r${i}(v_uv.x)`), re: /9 ramp\/curve channels → LUTs exceed the Toolbox Shader pool of 8 \(over budget: r8\)/ },
  ];
  for (const t of budget) {
    const res = build(t.body);
    c.check(`over budget refused clearly: ${t.what}`, !res.ok && res.errors.some((e) => t.re.test(e.message)), res.ok ? "bundled" : res.errors.map((e) => e.message));
  }
  const fits = build(many(32, (i) => `// ch("s${i}", 1.0)`, (i) => `vec4(s${i})`));
  c.check("exactly 32 scalars fit", fits.ok && fits.bundle.params.length === 32 && fits.bundle.params[31].slot === 32);

  // --- refusal with lines ---
  const d = build("float k = 1.0;\nfragColor = vec4(dFdx(v_uv.x) * k);");
  c.check(
    "dFdx refused with the GLSL line (body line = line − preludeLines)",
    !d.ok && d.errors.some((e) => /dFdx is not available/.test(e.message) && e.line - d.preludeLines === 2),
    d.ok ? "bundled" : d.errors
  );

  // --- id ---
  c.check("id is an integer in 1…2^24−1", Number.isInteger(b.id) && b.id > 0 && b.id < 2 ** 24, b.id);
  c.check("id = bundleId(content)", bundleId(b) === b.id);
  c.check("same params → same id (in process)", ids() === ids());
  const child = spawnSync(process.execPath, ["--import", "tsx", THIS], { cwd: ROOT, encoding: "utf8", env: { ...process.env, TBX_PRINT_BUNDLE_ID: "1" }, timeout: 120_000 });
  const childId = Number(/BUNDLE_ID=(\d+)/.exec(child.stdout ?? "")?.[1]);
  c.check("same params → same id in a fresh process", childId === ids(), { child: childId, here: ids(), stderr: (child.stderr ?? "").slice(0, 300) });
  const tweaked = build(MIXED, { mode: "hard", a: 0.7501 });
  c.check("a changed channel value changes the id", tweaked.ok && tweaked.bundle.id !== ids());
  const shuffled = Object.fromEntries(Object.entries(b).reverse()) as unknown as AeShaderBundle;
  c.check("id ignores key order", bundleId(shuffled) === b.id && canonicalJson({ x: 1, y: [2, { b: 1, a: 2 }] }) === canonicalJson({ y: [2, { a: 2, b: 1 }], x: 1 }));

  // --- .tbxfx text ---
  const text = writeTbxfx(b);
  const back = JSON.parse(text) as AeShaderBundle;
  c.check(".tbxfx parses back to the same bundle", canonicalJson(back) === canonicalJson(b));
  c.check(".tbxfx keys in AeShaderBundle order", Object.keys(back).join() === "format,version,id,hostMin,name,source,inputs,params,luts,readsTime,fps,loopFrames,canvas", Object.keys(back));
  c.check(".tbxfx keeps number arrays on one line", /"data": \[0, 0, 0, 1, /.test(text) && !/\[\n\s+0,\n/.test(text));
  c.check(".tbxfx ends with a newline, no NUL", text.endsWith("}\n") && !text.includes("\0"));

  // --- validateAeShader (structure, no compiler) ---
  const ok = validateAeShader(back);
  c.check("validateAeShader passes the round-tripped bundle", ok.ok, ok.errors);
  c.check("without a compiler it says so (skipped, not failed)", "skipped" in ok.compile);
  const mutate = (f: (x: AeShaderBundle) => void, rehash = true): AeShaderBundle => {
    const x = JSON.parse(text) as AeShaderBundle;
    f(x);
    if (rehash) x.id = bundleId(x);
    return x;
  };
  const negatives: { what: string; bundle: AeShaderBundle; re: RegExp }[] = [
    { what: "hand-edited MSL", bundle: mutate((x) => (x.source.msl = x.source.msl!.replace("return fragColor;", "return fragColor * 2.0f;"))), re: /not the translation of source\.glsl/ },
    { what: "stale id", bundle: mutate((x) => (x.name = "renamed"), false), re: /does not match the content hash/ },
    { what: "slot past the pool", bundle: mutate((x) => (x.params[0].slot = 33)), re: /slider slot must be 1–32/ },
    { what: "two params in one slot", bundle: mutate((x) => (x.params[3].slot = 1)), re: /slider slot 1 is used twice/ },
    { what: "a lut removed", bundle: mutate((x) => x.luts!.pop()), re: /sampler "u_curve_fall" has no lut/ },
    { what: "a short lut", bundle: mutate((x) => x.luts![0].data.pop()), re: /data must hold width × 4/ },
    { what: "inputs that disagree with the shader", bundle: mutate((x) => (x.inputs = ["a", "c"])), re: /differ from what the shader samples/ },
    { what: "readsTime that disagrees", bundle: mutate((x) => (x.readsTime = true)), re: /readsTime is true but the shader never reads/ },
    { what: "a point param", bundle: mutate((x) => x.params.push({ name: "pt", label: "pt", kind: "point", slot: 1, default: [0, 0] })), re: /point params are reserved/ },
    { what: "a kernel in source.msl", bundle: mutate((x) => (x.source.msl += "kernel void evil() {}\n")), re: /contains a kernel/ },
    { what: "a slider default outside its range", bundle: mutate((x) => (x.params[0].default = 7)), re: /default 7 is outside/ },
    { what: "wrong version", bundle: mutate((x) => ((x as { version: number }).version = 2)), re: /version must be 1/ },
  ];
  for (const n of negatives) {
    const v = validateAeShader(n.bundle);
    c.check(`validateAeShader refuses ${n.what}`, !v.ok && v.errors.some((e) => n.re.test(e.message)), v.errors.map((e) => e.message));
  }

  // --- compiler diagnostics map back to GLSL lines ---
  const lines = msl.split("\n");
  const mslLine = lines.findIndex((l) => l.includes("u_c.sample(v_uv)")) + 1;
  const glslLine = b.source.glsl!.split("\n").findIndex((l) => l.includes("texture(u_c, v_uv)")) + 1;
  const fake: ShaderCompiler = () => ({ validator: "tbxshader-check", ok: false, log: "x", diagnostics: [{ mslLine, message: "use of undeclared identifier" }] });
  const mapped = validateAeShader(b, { compiler: fake });
  c.check("a host diagnostic on a source.msl line maps to its GLSL line", !mapped.ok && mapped.errors.some((e) => e.line === glslLine && e.message.includes(`source.msl line ${mslLine}`)), { mslLine, glslLine, errors: mapped.errors });
  const fakeLog: ShaderCompiler = ({ firstBundleLine }) => ({ validator: "msl-compile", ok: false, log: `program_source:${firstBundleLine + mslLine - 1}:5: error: boom` });
  const mapped2 = validateAeShader(b, { compiler: fakeLog });
  c.check("a Metal log line (prelude + msl + epilogue) maps to its GLSL line", !mapped2.ok && mapped2.errors.some((e) => e.line === glslLine && /boom/.test(e.message)), mapped2.errors);
  return c.failures;
}
