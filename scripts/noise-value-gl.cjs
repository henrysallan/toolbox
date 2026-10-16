// noise-value-gl — the Noise node's `value` aux vs its own GL image, on real
// WebGL2 in an offscreen Electron window. The image is the reference: the
// aux exists so CPU consumers (drivers, points, scalar reads) see the noise
// the image shows. Renderer half: scripts/noise-value-page.ts.
//
//   env -u ELECTRON_RUN_AS_NODE npx electron scripts/noise-value-gl.cjs
//       [--gl swiftshader]      software GL instead of the machine's GPU
//       [--size 96x64]          canvas (non-square on purpose: the aspect divide)
//       [--grid 8x6]            sample points per case (pixel centres)
//       [--tol 0.002]           max |value − image| that counts as a match
//       [--verbose]             list every point beyond --tol
//       [--bench]               also time the GPU evaluation's readback (1920×1080)
//       [--write-golden]        record this renderer's GL values for the
//                               sin-free types (perlin / simplex / value) in
//                               scripts/fixtures/noise-value-golden.json, one
//                               entry per renderer; check-skia-noise gates the
//                               CPU port against them offline (`npm run
//                               check` has no GL)
//
// Cases: every type × seed 0 / 1 / 7 × w 0 / 0.3, plus fBm / looping /
// phasor / flow / W variants. Prints max |Δ| per case and which path the
// node took (cpu = the fp32 port, gpu = the 1×1 NOISE_FS evaluation); exits
// 1 when a case is beyond --tol, 2 on setup errors. A saturated pixel only
// bounds the value: it matches when the aux is at or beyond the clip. The
// image's own precision is the floor: RGBA16F, ~2.4e-4 on the decoded noise
// (4.9e-4 on Metal, 9.8e-4 for curl's RG encoding there).
//
// The offsets are 0.31 / −0.17, not round numbers: at 0.3 / −0.2 on 96×64
// the grid's p.x − p.y lands on integers, i.e. exactly ON super-simplex's
// lattice-diagonal seams (NOISE_FS's ssNoise jumps by ~1e-2 there), where
// the pixel's interpolated v_uv and the exact position fall on opposite sides.
//
// CommonJS: an Electron main-process entry (see TESTING.md on check-shaders).
/* eslint-disable @typescript-eslint/no-require-imports */
const { app } = require("electron");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const H = require("./skia/electron-harness.cjs");

const GOLDEN = path.join(H.REPO, "scripts", "fixtures", "noise-value-golden.json");
const TYPES = ["perlin", "simplex", "value", "opensimplex", "opensimplex2", "opensimplex2s", "super-simplex", "perlin-deriv", "flow", "curl", "phasor"];
const SEEDS = [0, 1, 7];
const WS = [0, 0.3];
const BASE = { offset_x: 0.31, offset_y: -0.17, contrast: 1, color_a: "#00ff00", color_b: "#ff0000", alpha: 1 };

function parseWxH(raw, name) {
  const m = /^(\d+)x(\d+)$/.exec(String(raw));
  if (!m) throw new Error(`--${name} "${raw}" is not WxH`);
  return [Number(m[1]), Number(m[2])];
}

let size, gridArg, tol, writeGolden, glMode, verbose, bench;
try {
  size = parseWxH(H.arg("size", "96x64"), "size");
  gridArg = parseWxH(H.arg("grid", "8x6"), "grid");
  tol = Number(H.arg("tol", "0.002"));
  writeGolden = H.flag("write-golden");
  verbose = H.flag("verbose");
  bench = H.flag("bench");
  glMode = H.arg("gl", "default");
} catch (e) {
  console.error(`noise-value-gl: ${e.message}`);
  process.exit(2);
}
if (glMode === "swiftshader") {
  app.commandLine.appendSwitch("use-gl", "angle");
  app.commandLine.appendSwitch("use-angle", "swiftshader");
  app.commandLine.appendSwitch("enable-unsafe-swiftshader");
}
app.commandLine.appendSwitch("force-device-scale-factor", "1");
app.commandLine.appendSwitch("ignore-gpu-blocklist");

const BUNDLE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "noise-value-"));

const matrixName = (type, seed, w) => `${type} s${seed} w${w}`;

function cases() {
  const out = [];
  for (const type of TYPES) {
    for (const seed of SEEDS) {
      for (const w of WS) out.push({ name: matrixName(type, seed, w), params: { ...BASE, type, seed, w } });
    }
  }
  const fbm = { scale: 6.5, octaves: 6, persistence: 0.6, lacunarity: 2.3, offset_x: 1.7, offset_y: -2.2, seed: 7 };
  const loop = { seed: 1, w: 2.5, animated: true, anim_start: 10, anim_end: 130, anim_rate: 1.7 };
  for (const type of ["perlin", "simplex", "value", "phasor"]) {
    out.push({ name: `${type} fbm`, params: { ...BASE, type, ...fbm } });
    out.push({ name: `${type} loop f37.5`, params: { ...BASE, type, ...loop }, frame: 37.5 });
  }
  out.push({ name: "phasor f3.5 30° iso0.6", params: { ...BASE, type: "phasor", seed: 3, phasor_frequency: 3.5, phasor_orientation: 30, phasor_isotropy: 0.6 } });
  out.push({ name: "flow t1.3", params: { ...BASE, type: "flow", seed: 2, flow_time: 1.3 } });
  out.push({ name: "flow loop f30", params: { ...BASE, type: "flow", animated: true, anim_start: 0, anim_end: 120 }, frame: 30 });
  out.push({ name: "simplex w-1.6", params: { ...BASE, type: "simplex", seed: 1, w: -1.6 } });
  out.push({ name: "value w2", params: { ...BASE, type: "value", seed: 1, w: 2 } });
  out.push({ name: "curl contrast2", params: { ...BASE, type: "curl", seed: 1, contrast: 2 } });
  return out;
}

// Max |Δ| over a case's points; a clipped pixel matches when the aux is at
// or beyond the clip.
function pointError(p) {
  if (p.clip === 1) return Math.max(0, p.gl - p.value);
  if (p.clip === -1) return Math.max(0, p.value - p.gl);
  return Math.abs(p.value - p.gl);
}
const caseError = (c) => c.points.reduce((m, p) => Math.max(m, pointError(p)), 0);

app.whenReady().then(async () => {
  let code = 2;
  let server = null;
  let win = null;
  try {
    H.bundlePage({
      entry: path.join(H.REPO, "scripts", "noise-value-page.ts"),
      outfile: path.join(BUNDLE_DIR, "bundle.js"),
      globalName: "__noise",
    });
    server = await H.startServer({
      routes: {
        "/page.html": { type: "text/html", body: `<!doctype html><meta charset="utf-8"><body><script src="/b/bundle.js"></script></body>` },
      },
      mounts: { "/b/": BUNDLE_DIR },
    });
    win = H.makeWindow(320, 240);
    await win.loadURL(`${server.base}/page.html`);
    await H.waitFor(win, "window.__noise", 30000);
    const info = await H.call(win, `window.__noise.init(${size[0]}, ${size[1]})`);
    console.log(`renderer: ${info.renderer} (EXT_color_buffer_float ${info.colorBufferFloat ? "yes" : "NO — 8-bit targets, the GPU path falls back to the CPU port"})`);
    console.log(`canvas ${size[0]}x${size[1]}, ${gridArg[0] * gridArg[1]} points per case, tol ${tol}`);
    const results = await H.call(win, `window.__noise.run(${JSON.stringify(cases())}, ${gridArg[0]}, ${gridArg[1]})`, 600000, "run");
    const byName = new Map(results.map((r) => [r.name, r]));

    let bad = 0;
    const cell = (c) => {
      const e = caseError(c);
      if (e > tol) bad++;
      return `${e.toExponential(1)}${c.path === "gpu" ? "g" : c.path === "cpu" ? "c" : "m"}${e > tol ? "*" : " "}`;
    };
    const cols = [];
    for (const seed of SEEDS) for (const w of WS) cols.push({ seed, w });
    console.log(["type".padEnd(14), ...cols.map((c) => `s${c.seed} w${c.w}`.padStart(11))].join(""));
    for (const type of TYPES) {
      console.log([type.padEnd(14), ...cols.map((col) => cell(byName.get(matrixName(type, col.seed, col.w))).padStart(11))].join(""));
    }
    for (const r of results) {
      if (/ s\d+ w/.test(r.name)) continue;
      console.log(`${r.name.padEnd(25)}${cell(r).padStart(11)}`);
    }
    console.log(`(c = the fp32 CPU port, g = the 1×1 GPU evaluation, m = both, by position)`);
    console.log(bad ? `${bad} case(s) beyond tol ${tol} (*)` : `every case within ${tol}`);
    if (verbose) {
      for (const c of results) {
        const pts = c.points.filter((p) => pointError(p) > tol);
        if (!pts.length) continue;
        console.log(
          `${c.name}: ${pts.length}/${c.points.length} points beyond tol; ` +
            pts
              .slice(0, 6)
              .map((p) => `(${p.u.toFixed(4)},${p.v.toFixed(4)}) gl ${p.gl.toFixed(5)} value ${p.value.toFixed(5)}`)
              .join("; ")
        );
      }
    }

    if (bench) {
      const N = 200;
      for (const c of [
        { name: "simplex (cpu path)", params: { ...BASE, type: "simplex", seed: 0 } },
        { name: "simplex s7 (gpu path)", params: { ...BASE, type: "simplex", seed: 7 } },
        { name: "simplex w0.3 (gpu path)", params: { ...BASE, type: "simplex", seed: 1, w: 0.3 } },
        { name: "phasor (gpu path)", params: { ...BASE, type: "phasor", seed: 1 } },
      ]) {
        const r = await H.call(win, `window.__noise.bench(${JSON.stringify(c)}, ${N}, 1920, 1080)`, 600000, "bench");
        console.log(
          `bench 1920x1080 ${c.name.padEnd(24)} image only ${r.imageOnlyMs.toFixed(3)} ms, with value ${r.withValueMs.toFixed(3)} ms ` +
            `(+${(r.withValueMs - r.imageOnlyMs).toFixed(3)} ms per compute, mean of ${N})`
        );
      }
    }

    if (writeGolden) {
      // One entry per renderer (re-running on another GPU adds or replaces
      // only its own). The sin-free types only: the rest never take the CPU
      // path, and their images are GPU-specific anyway.
      if (size[0] !== 96 || size[1] !== 64 || gridArg[0] !== 8 || gridArg[1] !== 6) {
        throw new Error("--write-golden needs the default --size 96x64 and --grid 8x6");
      }
      const kept = results.filter((r) => ["perlin", "simplex", "value"].includes(r.params.type));
      let golden = { renderers: {} };
      if (fs.existsSync(GOLDEN)) golden = JSON.parse(fs.readFileSync(GOLDEN, "utf8"));
      golden = {
        generatedBy: "env -u ELECTRON_RUN_AS_NODE npx electron scripts/noise-value-gl.cjs [--gl swiftshader] --write-golden",
        note:
          "The Noise node's GL image decoded back to the signed noise (`gl`) at the pixel centres of a grid × grid " +
          "sample over a width × height canvas, row-major from the bottom-left (uv01, v up); `clip` lists " +
          "[index, ±1] for saturated pixels, whose value is only a bound. Gated offline by check-skia-noise.",
        width: size[0],
        height: size[1],
        grid: gridArg,
        renderers: {
          ...golden.renderers,
          [info.renderer]: kept.map((r) => {
            const clip = r.points.flatMap((p, i) => (p.clip ? [[i, p.clip]] : []));
            return {
              name: r.name,
              params: r.params,
              ...(r.frame !== undefined ? { frame: r.frame } : {}),
              gl: r.points.map((p) => Number(p.gl.toFixed(6))),
              ...(clip.length ? { clip } : {}),
            };
          }),
        },
      };
      fs.mkdirSync(path.dirname(GOLDEN), { recursive: true });
      fs.writeFileSync(GOLDEN, JSON.stringify(golden, null, 1).replace(/\[\s+(-?[\d.e-]+(?:,\s+-?[\d.e-]+)*)\s+\]/g, (m, inner) => `[${inner.split(/,\s+/).join(", ")}]`) + "\n");
      console.log(`wrote ${path.relative(H.REPO, GOLDEN)} (${kept.length} cases for ${info.renderer})`);
    }
    code = bad ? 1 : 0;
  } catch (e) {
    console.error(`noise-value-gl: ${e.message}`);
    if (e.pageStack) console.error(e.pageStack);
    code = 2;
  } finally {
    try {
      win?.destroy();
    } catch {
      /* already gone */
    }
    server?.close();
    fs.rmSync(BUNDLE_DIR, { recursive: true, force: true });
    app.exit(code);
  }
});
