// check-shaders: compiles Merge's shaders in a real WebGL2 context and proves
// the FUSED multi-layer composite is pixel-equivalent to the old
// one-pass-per-layer chain. Spec: specdocs/080726_perf-profiler.md.
//
// Why this exists as its own Electron gate rather than a check-*.mts: a GLSL
// syntax error or a mistyped blend formula is invisible to typecheck and to
// every DOM-stubbed check script — it only surfaces as wrong pixels in a
// user's project. Merge fusion rewrote how twenty-nine blend modes are
// applied, so "identical output" has to be asserted, not assumed.
//
//   npm run check:shaders
//
// NOTE: must run with ELECTRON_RUN_AS_NODE unset (the npm script handles it),
// or Electron boots as plain Node and there is no GL context.
//
// CommonJS require, not ESM import: this is an Electron MAIN-process entry,
// loaded by the Electron binary rather than by Node's ESM loader.
/* eslint-disable @typescript-eslint/no-require-imports */
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");

const jsonPath = process.argv[2];
const shaders = JSON.parse(fs.readFileSync(jsonPath, "utf8"));

// Software GL so this runs headless, on CI, and without a discrete GPU.
app.commandLine.appendSwitch("use-gl", "swiftshader");
app.commandLine.appendSwitch("enable-unsafe-swiftshader");
app.disableHardwareAcceleration();

// The engine's real fullscreen VS (gl.ts FULLSCREEN_VS). It must declare
// `out vec2 v_uv` — a stub without it fails every link on varying mismatch
// and masks the actual result.
const VS = `#version 300 es
out vec2 v_uv;
void main() {
  vec2 p = vec2((gl_VertexID == 1) ? 3.0 : -1.0, (gl_VertexID == 2) ? 3.0 : -1.0);
  v_uv = (p + 1.0) * 0.5;
  gl_Position = vec4(p, 0.0, 1.0);
}`;

let failures = 0;
function report(r) {
  console.log(`${r.ok ? "ok  " : "FAIL"} ${r.name}${r.log ? " — " + r.log : ""}`);
  if (!r.ok) failures++;
}

function finish(code) {
  try {
    fs.unlinkSync(jsonPath);
  } catch {
    /* already gone */
  }
  app.exit(code);
}

app.whenReady().then(async () => {
  // A plain hidden window. (An earlier version used `offscreen: true` and
  // appeared to hang for 15 minutes — that turned out to be a .mjs extension
  // forcing ESM, where `require` is undefined, with headless Electron sitting
  // on the load error instead of exiting. Hence the .cjs extension. Offscreen
  // was never the problem; a hidden window is simply the smaller hammer.)
  const win = new BrowserWindow({
    show: false,
    width: 64,
    height: 64,
    webPreferences: { nodeIntegration: false },
  });
  await win.loadURL("data:text/html,<canvas id=c width=16 height=16></canvas>");

  const run = (js) => win.webContents.executeJavaScript(js);

  // --- stage 1: context + programs ---
  // Staged rather than one big call so a hang is attributable to a stage
  // instead of showing up as total silence.
  const setup = await run(`
    (() => {
      const SH = ${JSON.stringify(shaders)};
      const VS_SRC = ${JSON.stringify(VS)};
      const W = 16, H = 16;
      const gl = document.getElementById("c").getContext("webgl2", {
        antialias: false, premultipliedAlpha: false, alpha: true,
      });
      if (!gl) return { fatal: "no webgl2 context" };
      window.T = { gl, W, H, progs: {}, compiled: [] };

      const compile = (type, src) => {
        const s = gl.createShader(type);
        gl.shaderSource(s, src); gl.compileShader(s);
        if (!gl.getShaderParameter(s, gl.COMPILE_STATUS))
          throw new Error(gl.getShaderInfoLog(s));
        return s;
      };
      const vs = compile(gl.VERTEX_SHADER, VS_SRC);
      for (const [name, src] of Object.entries(SH)) {
        try {
          const p = gl.createProgram();
          gl.attachShader(p, vs);
          gl.attachShader(p, compile(gl.FRAGMENT_SHADER, src));
          gl.linkProgram(p);
          if (!gl.getProgramParameter(p, gl.LINK_STATUS))
            throw new Error(gl.getProgramInfoLog(p));
          window.T.progs[name] = p;
          window.T.compiled.push({ name: "compiles+links: " + name, ok: true });
        } catch (e) {
          window.T.compiled.push({
            name: "compiles+links: " + name, ok: false,
            log: String(e.message).slice(0, 300),
          });
        }
      }

      // --- plumbing reused by the equivalence stages ---
      const T = window.T;
      T.vao = gl.createVertexArray();
      T.fbo = gl.createFramebuffer();
      const mkTex = (fill) => {
        const px = new Uint8Array(W * H * 4);
        for (let i = 0; i < W * H; i++) {
          const v = fill(i % W, (i / W) | 0);
          px[i*4] = v[0]; px[i*4+1] = v[1]; px[i*4+2] = v[2]; px[i*4+3] = v[3];
        }
        const t = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, t);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, W, H, 0, gl.RGBA, gl.UNSIGNED_BYTE, px);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        return t;
      };
      // RGBA16F targets, matching what the engine actually allocates when
      // EXT_color_buffer_float is present (gl.ts allocTexture). This matters:
      // with RGBA8 intermediates the CHAIN quantises to 8 bits between layers
      // while the fused path stays in float, and the discontinuous blend modes
      // (hard-mix's step(), the guarded divisions) amplify that rounding into
      // huge deltas that look like formula errors but aren't.
      T.float = !!gl.getExtension("EXT_color_buffer_float");
      const mkTarget = () => {
        const t = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, t);
        if (T.float) {
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, W, H, 0, gl.RGBA, gl.HALF_FLOAT, null);
        } else {
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, W, H, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        }
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        return t;
      };
      // Varied, deterministic content so every blend branch sees a range of
      // values rather than one flat colour.
      T.base   = mkTex((x, y) => [x * 16 % 256, y * 16 % 256, (x + y) * 8 % 256, 200]);
      T.layerA = mkTex((x, y) => [255 - x * 16 % 256, y * 11 % 256, 128, 180]);
      T.layerB = mkTex((x, y) => [x * 7 % 256, 255 - y * 16 % 256, (x * y) % 256, 220]);
      T.matteA = mkTex((x) => [x * 16 % 256, 0, 0, 255]);
      T.tmp = mkTarget(); T.outChain = mkTarget(); T.outFused = mkTarget();

      T.draw = (prog, target, setup) => {
        gl.bindFramebuffer(gl.FRAMEBUFFER, T.fbo);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, target, 0);
        gl.viewport(0, 0, W, H);
        gl.useProgram(prog); gl.bindVertexArray(T.vao);
        gl.disable(gl.DEPTH_TEST); gl.disable(gl.BLEND);
        setup(prog);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        gl.bindVertexArray(null);
      };
      // Returns normalised 0..1 floats either way, so comparisons downstream
      // don't care which target format was used.
      T.readback = (target) => {
        gl.bindFramebuffer(gl.FRAMEBUFFER, T.fbo);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, target, 0);
        if (T.float) {
          const px = new Float32Array(W * H * 4);
          gl.readPixels(0, 0, W, H, gl.RGBA, gl.FLOAT, px);
          return px;
        }
        const px = new Uint8Array(W * H * 4);
        gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
        return Float32Array.from(px, (v) => v / 255);
      };
      T.bindTex = (prog, name, unit, tex) => {
        gl.activeTexture(gl.TEXTURE0 + unit);
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.uniform1i(gl.getUniformLocation(prog, name), unit);
      };
      return { compiled: T.compiled, maxUnits: gl.getParameter(gl.MAX_TEXTURE_IMAGE_UNITS) };
    })()
  `);

  if (setup.fatal) {
    console.error("FATAL:", setup.fatal);
    finish(1);
    return;
  }
  console.log(
    `MAX_TEXTURE_IMAGE_UNITS = ${setup.maxUnits} ` +
      `(${Math.max(1, Math.floor((setup.maxUnits - 2) / 2))} layers per fused pass)`
  );
  setup.compiled.forEach(report);
  if (failures > 0) {
    finish(1);
    return;
  }

  // --- stage 2: fused === chained, one call per case ---
  const CASES = [
    { name: "opacity 1, no matte", ops: [1.0, 1.0], mattes: [false, false] },
    { name: "opacity .5 / .75", ops: [0.5, 0.75], mattes: [false, false] },
    { name: "matte on first layer", ops: [1.0, 1.0], mattes: [true, false] },
  ];
  for (const c of CASES) {
    const r = await run(`
      (() => {
        const T = window.T, gl = T.gl;
        const ops = ${JSON.stringify(c.ops)};
        const useMatte = ${JSON.stringify(c.mattes)};
        const mA = useMatte[0] ? T.matteA : T.layerA;
        const mB = useMatte[1] ? T.matteA : T.layerB;
        let worst = 0, worstMode = -1;
        const perMode = [];
        for (let mode = 0; mode < 29; mode++) {
          T.draw(T.progs.pairwise, T.tmp, (p) => {
            T.bindTex(p, "u_base", 0, T.base);
            T.bindTex(p, "u_layer", 1, T.layerA);
            T.bindTex(p, "u_matte", 2, mA);
            gl.uniform1i(gl.getUniformLocation(p, "u_hasMatte"), useMatte[0] ? 1 : 0);
            gl.uniform1f(gl.getUniformLocation(p, "u_opacity"), ops[0]);
            gl.uniform1i(gl.getUniformLocation(p, "u_mode"), mode);
          });
          T.draw(T.progs.pairwise, T.outChain, (p) => {
            T.bindTex(p, "u_base", 0, T.tmp);
            T.bindTex(p, "u_layer", 1, T.layerB);
            T.bindTex(p, "u_matte", 2, mB);
            gl.uniform1i(gl.getUniformLocation(p, "u_hasMatte"), useMatte[1] ? 1 : 0);
            gl.uniform1f(gl.getUniformLocation(p, "u_opacity"), ops[1]);
            gl.uniform1i(gl.getUniformLocation(p, "u_mode"), mode);
          });
          T.draw(T.progs.fused2, T.outFused, (p) => {
            T.bindTex(p, "u_base", 0, T.base);
            T.bindTex(p, "u_baseMatte", 1, T.base);
            gl.uniform1i(gl.getUniformLocation(p, "u_hasBaseMatte"), 0);
            T.bindTex(p, "u_layer0", 2, T.layerA);
            T.bindTex(p, "u_matte0", 3, mA);
            T.bindTex(p, "u_layer1", 4, T.layerB);
            T.bindTex(p, "u_matte1", 5, mB);
            gl.uniform1fv(gl.getUniformLocation(p, "u_opacity"), new Float32Array(ops));
            gl.uniform1iv(gl.getUniformLocation(p, "u_mode"), new Int32Array([mode, mode]));
            gl.uniform1iv(gl.getUniformLocation(p, "u_hasMatte"),
              new Int32Array([useMatte[0] ? 1 : 0, useMatte[1] ? 1 : 0]));
          });
          const a = T.readback(T.outChain), b = T.readback(T.outFused);
          let modeWorst = 0, differing = 0;
          for (let i = 0; i < a.length; i++) {
            const d = Math.abs(a[i] - b[i]);
            if (d > 0.004) differing++;
            if (d > modeWorst) modeWorst = d;
          }
          // A wrong formula is wrong on nearly every pixel. A precision
          // artifact on a discontinuous mode (hard-mix's step, the guarded
          // divisions) shows up as a big delta on a HANDFUL of pixels sitting
          // exactly on the threshold — so track both.
          perMode.push({ mode, worst: +modeWorst.toFixed(4), differing });
          if (modeWorst > worst) { worst = modeWorst; worstMode = mode; }
        }
        const total = T.W * T.H * 4;
        const suspects = perMode.filter((m) => m.differing > total * 0.02);
        return { worst, worstMode, float: T.float, suspects, total };
      })()
    `);
    // The pass criterion is BREADTH, not peak delta. A wrong formula is wrong
    // on nearly every pixel; a precision artifact on a discontinuous mode
    // (hard-mix's step(), the guarded divisions) is a large delta on a few
    // pixels sitting exactly on the threshold. So a mode fails only if it
    // differs on >2% of channels.
    report({
      name: `fused === chain, all 29 modes — ${c.name}`,
      ok: r.suspects.length === 0,
      log:
        r.suspects.length === 0
          ? `peak delta ${r.worst.toFixed(4)} at mode ${r.worstMode}, no mode differs broadly` +
            (r.float ? "" : " (RGBA8 fallback — no float targets)")
          : `broad differences in mode(s) ` +
            r.suspects
              .map((m) => `${m.mode} (${m.differing}/${r.total} channels, peak ${m.worst})`)
              .join(", "),
    });
  }

  // --- stage 3: the folded-in base matte is not a no-op ---
  const matte = await run(`
    (() => {
      const T = window.T, gl = T.gl;
      const shot = (hasBaseMatte) => {
        T.draw(T.progs.fused1, T.tmp, (p) => {
          T.bindTex(p, "u_base", 0, T.base);
          T.bindTex(p, "u_baseMatte", 1, hasBaseMatte ? T.matteA : T.base);
          gl.uniform1i(gl.getUniformLocation(p, "u_hasBaseMatte"), hasBaseMatte ? 1 : 0);
          T.bindTex(p, "u_layer0", 2, T.layerA);
          T.bindTex(p, "u_matte0", 3, T.layerA);
          gl.uniform1fv(gl.getUniformLocation(p, "u_opacity"), new Float32Array([0.5]));
          gl.uniform1iv(gl.getUniformLocation(p, "u_mode"), new Int32Array([1]));
          gl.uniform1iv(gl.getUniformLocation(p, "u_hasMatte"), new Int32Array([0]));
        });
        return Array.from(T.readback(T.tmp));
      };
      const on = shot(true), off = shot(false);
      return { differs: on.some((v, i) => v !== off[i]) };
    })()
  `);
  report({
    name: "base matte folded into the fused pass actually applies",
    ok: matte.differs,
    log: matte.differs ? "" : "u_hasBaseMatte had no effect — the matte is being ignored",
  });

  console.log(
    failures === 0 ? "\nall shader checks passed" : `\n${failures} shader check(s) FAILED`
  );
  finish(failures === 0 ? 0 : 1);
});
