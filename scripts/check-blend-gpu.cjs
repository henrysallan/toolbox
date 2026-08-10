// Stage 2 of check:blend-gpu — run the Blend Intersections field shader in
// a real WebGL2 context (headless Electron, swiftshader) over the packed
// corpus from check-blend-gpu-emit.mts and write every GPU grid back out
// for check-blend-gpu-verify.mts to compare against the CPU reference.
// Pattern: scripts/check-shaders.cjs (same .cjs main-process entry rules —
// see TESTING.md; ELECTRON_RUN_AS_NODE must be unset, the npm script
// handles it).
/* eslint-disable @typescript-eslint/no-require-imports */
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");

const casesPath = process.argv[2];
const outPath = process.argv[3];
const payload = JSON.parse(fs.readFileSync(casesPath, "utf8"));

// Software GL so this runs headless, on CI, and without a discrete GPU.
// Correctness only — never read timings off swiftshader.
app.commandLine.appendSwitch("use-gl", "swiftshader");
app.commandLine.appendSwitch("enable-unsafe-swiftshader");
app.disableHardwareAcceleration();

// The engine's fullscreen VS shape (gl.ts FULLSCREEN_VS).
const VS = `#version 300 es
out vec2 v_uv;
void main() {
  vec2 p = vec2((gl_VertexID == 1) ? 3.0 : -1.0, (gl_VertexID == 2) ? 3.0 : -1.0);
  v_uv = (p + 1.0) * 0.5;
  gl_Position = vec4(p, 0.0, 1.0);
}`;

function finish(code) {
  try {
    fs.unlinkSync(casesPath);
  } catch {
    /* already gone */
  }
  app.exit(code);
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    width: 64,
    height: 64,
    webPreferences: { nodeIntegration: false },
  });
  await win.loadURL("data:text/html,<canvas id=c width=16 height=16></canvas>");

  const run = (js) => win.webContents.executeJavaScript(js);

  // --- stage A: context + program + static plumbing ---
  const setup = await run(`
    (() => {
      const gl = document.getElementById("c").getContext("webgl2", {
        antialias: false, premultipliedAlpha: false, alpha: true,
      });
      if (!gl) return { fatal: "no webgl2 context" };
      if (!gl.getExtension("EXT_color_buffer_float"))
        return { fatal: "EXT_color_buffer_float unavailable" };
      const compile = (type, src) => {
        const s = gl.createShader(type);
        gl.shaderSource(s, src); gl.compileShader(s);
        if (!gl.getShaderParameter(s, gl.COMPILE_STATUS))
          throw new Error(gl.getShaderInfoLog(s));
        return s;
      };
      try {
        const p = gl.createProgram();
        gl.attachShader(p, compile(gl.VERTEX_SHADER, ${JSON.stringify(VS)}));
        gl.attachShader(p, compile(gl.FRAGMENT_SHADER, ${JSON.stringify(payload.fs)}));
        gl.linkProgram(p);
        if (!gl.getProgramParameter(p, gl.LINK_STATUS))
          throw new Error(gl.getProgramInfoLog(p));
        window.T = { gl, prog: p, vao: gl.createVertexArray(), fbo: gl.createFramebuffer() };
      } catch (e) {
        return { fatal: "field shader failed: " + String(e.message).slice(0, 500) };
      }
      const T = window.T;
      const mk = () => {
        const t = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, t);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        return t;
      };
      T.texSegs = mk(); T.texMeta = mk(); T.texBuckets = mk(); T.texCand = mk();
      T.outTex = mk();
      return { ok: true };
    })()
  `);
  if (setup.fatal) {
    console.error("FATAL:", setup.fatal);
    finish(1);
    return;
  }
  console.log("field shader compiles + links");

  // --- stage B: one draw + readback per case ---
  const grids = {};
  for (const c of payload.cases) {
    // Ship the case into the page, draw, return the RGBA float readback.
    const r = await run(`
      (() => {
        const T = window.T, gl = T.gl;
        const C = ${JSON.stringify({
          gw: c.gw, gh: c.gh, dataW: c.dataW, segRows: c.segRows,
          candRows: c.candRows, bCols: c.bCols, bRows: c.bRows,
          uniforms: c.uniforms,
        })};
        const segTexels = Float32Array.from(${JSON.stringify(c.segTexels)});
        const metaTexels = Float32Array.from(${JSON.stringify(c.metaTexels)});
        const bucketTexels = Float32Array.from(${JSON.stringify(c.bucketTexels)});
        const candTexels = Float32Array.from(${JSON.stringify(c.candTexels)});

        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
        gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
        gl.bindTexture(gl.TEXTURE_2D, T.texSegs);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, C.dataW, C.segRows, 0, gl.RGBA, gl.FLOAT, segTexels);
        gl.bindTexture(gl.TEXTURE_2D, T.texMeta);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, C.dataW, C.segRows, 0, gl.RGBA, gl.FLOAT, metaTexels);
        gl.bindTexture(gl.TEXTURE_2D, T.texBuckets);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG32F, C.bCols, C.bRows, 0, gl.RG, gl.FLOAT, bucketTexels);
        gl.bindTexture(gl.TEXTURE_2D, T.texCand);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, C.dataW, C.candRows, 0, gl.RED, gl.FLOAT, candTexels);
        gl.bindTexture(gl.TEXTURE_2D, T.outTex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, C.gw, C.gh, 0, gl.RGBA, gl.FLOAT, null);
        gl.bindTexture(gl.TEXTURE_2D, null);

        gl.bindFramebuffer(gl.FRAMEBUFFER, T.fbo);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, T.outTex, 0);
        if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE)
          return { fatal: "RGBA32F framebuffer incomplete" };

        gl.viewport(0, 0, C.gw, C.gh);
        gl.disable(gl.DEPTH_TEST); gl.disable(gl.BLEND);
        gl.useProgram(T.prog);
        gl.bindVertexArray(T.vao);
        const u1f = (n, v) => gl.uniform1f(gl.getUniformLocation(T.prog, n), v);
        gl.uniform2f(gl.getUniformLocation(T.prog, "u_origin"), C.uniforms.bx0, C.uniforms.by0);
        u1f("u_cell", C.uniforms.cell);
        u1f("u_bucket", C.uniforms.bucket);
        gl.uniform2i(gl.getUniformLocation(T.prog, "u_bDims"), C.bCols, C.bRows);
        u1f("u_influence", C.uniforms.influence);
        u1f("u_influenceSq", C.uniforms.influenceSq);
        u1f("u_r", C.uniforms.r);
        u1f("u_k", C.uniforms.k);
        u1f("u_farSlack", C.uniforms.farSlack);
        const bind = (n, unit, tex) => {
          gl.activeTexture(gl.TEXTURE0 + unit);
          gl.bindTexture(gl.TEXTURE_2D, tex);
          gl.uniform1i(gl.getUniformLocation(T.prog, n), unit);
        };
        bind("u_segs", 0, T.texSegs);
        bind("u_meta", 1, T.texMeta);
        bind("u_buckets", 2, T.texBuckets);
        bind("u_cand", 3, T.texCand);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        gl.bindVertexArray(null);

        const px = new Float32Array(C.gw * C.gh * 4);
        gl.readPixels(0, 0, C.gw, C.gh, gl.RGBA, gl.FLOAT, px);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        const grid = new Array(C.gw * C.gh);
        let overflow = 0;
        for (let i = 0; i < grid.length; i++) {
          grid[i] = px[i * 4];
          overflow += px[i * 4 + 1];
        }
        return { grid, overflow };
      })()
    `);
    if (r.fatal) {
      console.error(`FATAL (${c.name}):`, r.fatal);
      finish(1);
      return;
    }
    console.log(
      `gpu grid: ${c.name} (${c.gw}x${c.gh})` +
        (r.overflow > 0 ? ` — ${r.overflow} BRANCH OVERFLOWS` : "")
    );
    grids[c.name] = { grid: r.grid, overflow: r.overflow };
  }

  fs.writeFileSync(outPath, JSON.stringify(grids));
  console.log(`wrote ${Object.keys(grids).length} gpu grids -> ${outPath}`);
  finish(0);
});
