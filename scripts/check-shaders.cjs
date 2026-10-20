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
      T.mkTex = mkTex;

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

  // Failed compile → fix source → first successful compile must draw.
  const stale = await run(`
    (() => {
      const gl = window.T.gl;
      const VS = ${JSON.stringify(VS)};
      function compile(type, src) {
        const s = gl.createShader(type);
        gl.shaderSource(s, src);
        gl.compileShader(s);
        if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
          const log = gl.getShaderInfoLog(s);
          gl.deleteShader(s);
          throw new Error(log);
        }
        return s;
      }
      function link(fs) {
        const p = gl.createProgram();
        gl.attachShader(p, vs);
        gl.attachShader(p, fs);
        gl.linkProgram(p);
        if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
          const log = gl.getProgramInfoLog(p);
          gl.deleteProgram(p);
          throw new Error(log);
        }
        return p;
      }
      const vs = compile(gl.VERTEX_SHADER, VS);
      const cache = { src: null, program: null };
      function tryShader(src) {
        if (cache.src === src) return cache.program;
        if (cache.program) { gl.useProgram(null); gl.deleteProgram(cache.program); }
        while (gl.getError() !== gl.NO_ERROR) {}
        try {
          const fs = compile(gl.FRAGMENT_SHADER, src);
          const prog = link(fs);
          gl.deleteShader(fs);
          cache.src = src;
          cache.program = prog;
          return prog;
        } catch (e) {
          while (gl.getError() !== gl.NO_ERROR) {}
          cache.src = src;
          cache.program = null;
          return null;
        }
      }
      const BAD = "#version 300 es\\nprecision highp float;\\nout vec4 fragColor;\\nin vec2 v_uv;\\nvoid main() { fragColor = undeclared; }";
      const GOOD = "#version 300 es\\nprecision highp float;\\nout vec4 fragColor;\\nin vec2 v_uv;\\nvoid main() { fragColor = vec4(1.0, 0.0, 0.0, 1.0); }";
      const fail = tryShader(BAD);
      const ok = tryShader(GOOD);
      if (!ok || fail) return { ok: false, log: "compile sequence" };
      const fbo = gl.createFramebuffer();
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 4, 4, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      gl.viewport(0, 0, 4, 4);
      gl.useProgram(ok);
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      const pix = new Uint8Array(4);
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pix);
      return { ok: pix[0] > 200 && pix[1] < 20, log: Array.from(pix).join(",") };
    })()
  `);
  report({
    name: "tryShader fail→fix draws on the first successful compile",
    ok: stale.ok,
    log: stale.log,
  });

  // --- stage 4: Paint's input composite (101526_paint-selection-transform.md M0) ---
  // Uniform-colour layers, so the canvas-vs-pipeline Y flip can't mask a
  // wrong formula. u_src / u_ko are PREMULTIPLIED (paint.ts bitmapTexture
  // uploads the canvas's native storage); the input and the output are
  // straight.
  const paint = await run(`
    (() => {
      const T = window.T, gl = T.gl;
      const clearTex = T.mkTex(() => [0, 0, 0, 0]);
      const fullKo = T.mkTex(() => [255, 255, 255, 255]);
      const halfKo = T.mkTex(() => [255, 255, 255, 128]);
      // Straight (40, 200, 90, 150), premultiplied: rgb × 150/255.
      const stroke = T.mkTex(() => [24, 118, 53, 150]);
      const strokeStraight = [];
      for (let i = 0; i < T.W * T.H; i++) strokeStraight.push(40 / 255, 200 / 255, 90 / 255, 150 / 255);
      const composite = (src, input, ko, transparent) => {
        T.draw(T.progs.paintComposite, T.tmp, (p) => {
          T.bindTex(p, "u_src", 0, src ?? input);
          T.bindTex(p, "u_in", 1, input);
          T.bindTex(p, "u_ko", 2, ko ?? input);
          gl.uniform1f(gl.getUniformLocation(p, "u_hasSrc"), src ? 1 : 0);
          gl.uniform1f(gl.getUniformLocation(p, "u_hasKo"), ko ? 1 : 0);
          gl.uniform4f(gl.getUniformLocation(p, "u_bg"), 0.2, 0.3, 0.4, 1);
          gl.uniform1f(gl.getUniformLocation(p, "u_transparent"), transparent ? 1 : 0);
        });
        return Array.from(T.readback(T.tmp));
      };
      const blit = (src, transparent) => {
        T.draw(T.progs.paintBlit, T.tmp, (p) => {
          T.bindTex(p, "u_src", 0, src);
          gl.uniform4f(gl.getUniformLocation(p, "u_bg"), 0.2, 0.3, 0.4, 1);
          gl.uniform1f(gl.getUniformLocation(p, "u_transparent"), transparent ? 1 : 0);
        });
        return Array.from(T.readback(T.tmp));
      };
      const maxDiff = (a, b) => a.reduce((m, v, i) => Math.max(m, Math.abs(v - b[i])), 0);
      const baseIn = (() => {
        // The input as the pipeline holds it, normalised.
        const p = composite(null, T.layerA, null, true);
        return p;
      })();
      const layerA = (() => {
        // Ground truth for layerA: alpha 180/255, rgb straight.
        const out = [];
        for (let y = 0; y < T.H; y++) for (let x = 0; x < T.W; x++)
          out.push((255 - x * 16 % 256) / 255, (y * 11 % 256) / 255, 128 / 255, 180 / 255);
        return out;
      })();
      const full = composite(null, T.layerA, fullKo, true);
      const half = composite(null, T.layerA, halfKo, true);
      const halfAlphaOk = half.every((v, i) =>
        i % 4 !== 3 || Math.abs(v - (180 / 255) * (1 - 128 / 255)) < 2 / 255);
      return {
        passthrough: maxDiff(baseIn, layerA),
        fullKoAlpha: Math.max(...full.filter((_, i) => i % 4 === 3)),
        halfAlphaOk,
        unpremul: maxDiff(blit(stroke, true), strokeStraight),
        parityTransparent: maxDiff(composite(stroke, clearTex, null, true), blit(stroke, true)),
        parityColor: maxDiff(composite(stroke, clearTex, null, false), blit(stroke, false)),
        parityKo: maxDiff(composite(stroke, clearTex, fullKo, false), blit(stroke, false)),
      };
    })()
  `);
  const tol = 2 / 255;
  report({
    name: "paint composite: no strokes, no knockout passes the input through",
    ok: paint.passthrough <= tol,
    log: `max |Δ| = ${paint.passthrough.toFixed(4)}`,
  });
  report({
    name: "paint composite: full knockout hides the input",
    ok: paint.fullKoAlpha <= tol,
    log: `max alpha = ${paint.fullKoAlpha.toFixed(4)}`,
  });
  report({
    name: "paint composite: half knockout scales the input alpha by (1 − k)",
    ok: paint.halfAlphaOk,
  });
  report({
    name: "paint blit: a premultiplied stroke texture renders as its straight colour",
    ok: paint.unpremul <= tol,
    log: `max |Δ| = ${paint.unpremul.toFixed(4)}`,
  });
  report({
    name: "paint composite over a transparent input ≡ the unwired blit (transparent)",
    ok: paint.parityTransparent <= tol,
    log: `max |Δ| = ${paint.parityTransparent.toFixed(4)}`,
  });
  report({
    name: "paint composite over a transparent input ≡ the unwired blit (bg color)",
    ok: paint.parityColor <= tol && paint.parityKo <= tol,
    log: `max |Δ| = ${Math.max(paint.parityColor, paint.parityKo).toFixed(4)}`,
  });

  // --- stage 5: layer transformed-content blend (101526_layer-transforms-parenting.md M1) ---
  // Identity must equal Merge's pairwise blend exactly in every mode (the
  // layer only switches shaders when its transform isn't identity, but the
  // two must agree at the seam). Integer-pixel shifts must equal pairwise
  // over a pre-shifted layer: proves the y-down canvas01 mapping and that
  // the edge antialias is exactly 0 / 1 at pixel centers.
  const layerX = await run(`
    (() => {
      const T = window.T, gl = T.gl;
      const f = (x, y) => [255 - x * 16 % 256, y * 11 % 256, 128, 180];
      const clear = [0, 0, 0, 0];
      const shiftedX = T.mkTex((x, y) => (x < 2 ? clear : f(x - 2, y)));
      const shiftedDown = T.mkTex((x, y) => (y + 3 >= T.H ? clear : f(x, y + 3)));
      const maxDiff = (a, b) => a.reduce((m, v, i) => Math.max(m, Math.abs(v - b[i])), 0);
      const pairwise = (layer, opacity, mode) => {
        T.draw(T.progs.pairwise, T.tmp, (p) => {
          T.bindTex(p, "u_base", 0, T.base);
          T.bindTex(p, "u_layer", 1, layer);
          T.bindTex(p, "u_matte", 2, T.base);
          gl.uniform1f(gl.getUniformLocation(p, "u_opacity"), opacity);
          gl.uniform1i(gl.getUniformLocation(p, "u_mode"), mode);
          gl.uniform1i(gl.getUniformLocation(p, "u_hasMatte"), 0);
        });
        return Array.from(T.readback(T.tmp));
      };
      const xform = (opacity, mode, tx, ty) => {
        T.draw(T.progs.layerBlendXform, T.tmp, (p) => {
          T.bindTex(p, "u_base", 0, T.base);
          T.bindTex(p, "u_layer", 1, T.layerA);
          gl.uniform1f(gl.getUniformLocation(p, "u_opacity"), opacity);
          gl.uniform1i(gl.getUniformLocation(p, "u_mode"), mode);
          gl.uniform4f(gl.getUniformLocation(p, "u_invA"), 1, 0, 0, 1);
          gl.uniform2f(gl.getUniformLocation(p, "u_invT"), -tx, -ty);
          gl.uniform2f(gl.getUniformLocation(p, "u_res"), T.W, T.H);
        });
        return Array.from(T.readback(T.tmp));
      };
      let identity = 0;
      for (let mode = 0; mode < 29; mode++) {
        identity = Math.max(identity, maxDiff(xform(0.75, mode, 0, 0), pairwise(T.layerA, 0.75, mode)));
      }
      let shift = 0;
      for (const mode of [0, 1, 7]) {
        shift = Math.max(shift, maxDiff(xform(0.75, mode, 2 / T.W, 0), pairwise(shiftedX, 0.75, mode)));
        shift = Math.max(shift, maxDiff(xform(0.75, mode, 0, 3 / T.H), pairwise(shiftedDown, 0.75, mode)));
      }
      return { identity, shift };
    })()
  `);
  report({
    name: "layer xform blend at identity ≡ pairwise blend (all 29 modes)",
    ok: layerX.identity <= 1e-6,
    log: `max |Δ| = ${layerX.identity}`,
  });
  report({
    name: "layer xform blend: integer shifts (+2 px right, +3 px down) ≡ pairwise over a shifted layer",
    ok: layerX.shift <= 1e-6,
    log: `max |Δ| = ${layerX.shift}`,
  });

  // --- stage 6: aspect-rigid rotation (101526_aspect-rigid-rotation.md) ---
  // A pixel-square rotated 45° about the centre of a 128×72 (16:9) target
  // through TRANSFORM_FS: with u_aspect = W / H the diamond is as wide as it
  // is tall (rigid in pixels); with u_aspect = 1 (legacySkew) it must NOT be
  // — proves both that the conjugation runs on the GPU and that the legacy
  // path keeps its old per-axis shear. No JS transcription involved.
  const rigid = await run(`
    (() => {
      const T = window.T, gl = T.gl;
      const RW = 128, RH = 72, HALF = 16;
      const mk = (data, fmt) => {
        const t = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, t);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, RW, RH, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        return t;
      };
      const px = new Uint8Array(RW * RH * 4);
      for (let y = 0; y < RH; y++) for (let x = 0; x < RW; x++) {
        const inside = Math.abs(x + 0.5 - RW / 2) < HALF && Math.abs(y + 0.5 - RH / 2) < HALF;
        if (inside) px.set([255, 255, 255, 255], (y * RW + x) * 4);
      }
      const src = mk(px);
      const dst = mk(null);
      const extent = (aspect) => {
        gl.bindFramebuffer(gl.FRAMEBUFFER, T.fbo);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, dst, 0);
        gl.viewport(0, 0, RW, RH);
        const p = T.progs.transform;
        gl.useProgram(p); gl.bindVertexArray(T.vao);
        gl.disable(gl.BLEND);
        T.bindTex(p, "u_src", 0, src);
        gl.uniform2f(gl.getUniformLocation(p, "u_translate"), 0, 0);
        gl.uniform2f(gl.getUniformLocation(p, "u_scale"), 1, 1);
        gl.uniform1f(gl.getUniformLocation(p, "u_angle"), Math.PI / 4);
        gl.uniform2f(gl.getUniformLocation(p, "u_pivot"), 0.5, 0.5);
        gl.uniform1f(gl.getUniformLocation(p, "u_aspect"), aspect);
        gl.uniform4f(gl.getUniformLocation(p, "u_tileExpand"), 0, 0, 0, 0);
        gl.uniform1i(gl.getUniformLocation(p, "u_tileMode"), 0);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        gl.bindVertexArray(null);
        const out = new Uint8Array(RW * RH * 4);
        gl.readPixels(0, 0, RW, RH, gl.RGBA, gl.UNSIGNED_BYTE, out);
        let x0 = RW, x1 = -1, y0 = RH, y1 = -1;
        for (let y = 0; y < RH; y++) for (let x = 0; x < RW; x++) {
          if (out[(y * RW + x) * 4 + 3] < 128) continue;
          x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
        }
        return { w: x1 - x0 + 1, h: y1 - y0 + 1 };
      };
      return { rigid: extent(RW / RH), legacy: extent(1), want: Math.round(2 * HALF * Math.SQRT2) };
    })()
  `);
  report({
    name: "TRANSFORM_FS 45° on 16:9 with u_aspect = W/H: the rotated pixel-square is as wide as tall (rigid)",
    ok: Math.abs(rigid.rigid.w - rigid.rigid.h) <= 2 && Math.abs(rigid.rigid.w - rigid.want) <= 2,
    log: `${rigid.rigid.w}×${rigid.rigid.h} px, rigid ≈ ${rigid.want}×${rigid.want}`,
  });
  report({
    name: "TRANSFORM_FS 45° on 16:9 with u_aspect = 1 (legacySkew): keeps the old per-axis shear",
    ok: Math.abs(rigid.legacy.w - rigid.legacy.h) > 8,
    log: `${rigid.legacy.w}×${rigid.legacy.h} px`,
  });

  console.log(
    failures === 0 ? "\nall shader checks passed" : `\n${failures} shader check(s) FAILED`
  );
  finish(failures === 0 ? 0 : 1);
});
