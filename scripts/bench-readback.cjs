// bench-readback: which small-texture readback strategy is actually fast
// on this machine's hardware GL?
//
//   node_modules/.bin/electron scripts/bench-readback.cjs
//   (ELECTRON_RUN_AS_NODE must be unset — see TESTING.md)
//
// Exists because sdf-to-spline's async PBO readback measured the SAME
// ~8 ms as the sync path it replaced (Sketch_01, 254² RGBA16F): the cost
// is not bandwidth (254² ≈ 128²) and not the march, so it must be the
// readback machinery itself — either ANGLE's RGBA/FLOAT conversion path
// or the sync IPC round trip. This times, on real hardware GL:
//
//   sync-f32     readPixels RGBA/FLOAT (what the app does today)
//   sync-f16     readPixels RGBA/HALF_FLOAT (if the driver allows it)
//   sync-u8      pack pass to RGBA8 + readPixels RGBA/UNSIGNED_BYTE
//   pbo-f32      readPixels→PBO issue, fence, later getBufferSubData
//   pbo-u8       pack pass + PBO issue, fence, later getBufferSubData
//
// each under an IDLE queue and under a BUSY queue (~30 fullscreen 2048²
// draws in flight — Sketch_01 conditions). Also prints the driver's
// IMPLEMENTATION_COLOR_READ_FORMAT/TYPE for the float FBO — the native
// combination is the only one with a chance at a DMA fast path.
/* eslint-disable @typescript-eslint/no-require-imports */
const { app, BrowserWindow } = require("electron");

const HARNESS = String.raw`
(async () => {
  const SIZE = 254;
  const cv = document.createElement("canvas");
  const gl = cv.getContext("webgl2");
  if (!gl) return { error: "no webgl2" };
  const extF = gl.getExtension("EXT_color_buffer_float");
  if (!extF) return { error: "no EXT_color_buffer_float" };
  const dbg = gl.getExtension("WEBGL_debug_renderer_info");
  const glName = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : "unknown";

  const now = () => performance.now();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // --- shaders -----------------------------------------------------------
  const VS = "#version 300 es\nvoid main(){vec2 p=vec2((gl_VertexID<<1&2)-1,(gl_VertexID&2)-1);gl_Position=vec4(p,0.,1.);}";
  function prog(fs) {
    const c = (t, s) => { const sh = gl.createShader(t); gl.shaderSource(sh, s); gl.compileShader(sh); return sh; };
    const p = gl.createProgram();
    gl.attachShader(p, c(gl.VERTEX_SHADER, VS));
    gl.attachShader(p, c(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    return p;
  }
  // distance-ish field
  const fieldProg = prog("#version 300 es\nprecision highp float;out vec4 o;uniform float u_t;void main(){vec2 p=gl_FragCoord.xy/254.0;float d=length(p-0.5)-0.3+0.02*sin(u_t+p.x*20.0);o=vec4(d,0.,0.,1.);}");
  // pack signed distance (range +-2) into RG 16-bit fixed
  const packProg = prog("#version 300 es\nprecision highp float;uniform sampler2D u_s;out vec4 o;void main(){float d=texelFetch(u_s,ivec2(gl_FragCoord.xy),0).r;float v=clamp(d*0.25+0.5,0.,1.);float hi=floor(v*255.0)/255.0;float lo=fract(v*65535.0/257.0);o=vec4(hi,lo,0.,1.);}");
  // busy-queue filler at 2048^2
  const busyProg = prog("#version 300 es\nprecision highp float;out vec4 o;uniform float u_i;void main(){vec2 p=gl_FragCoord.xy/2048.0;float a=0.0;for(int i=0;i<64;i++){a+=sin(p.x*float(i)+u_i)*cos(p.y*float(i));}o=vec4(a);}");

  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);

  function makeTex(w, h, ifmt, fmt, type) {
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, ifmt, w, h, 0, fmt, type, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    return t;
  }
  const fieldTex = makeTex(SIZE, SIZE, gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT);
  const packTex = makeTex(SIZE, SIZE, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE);
  const busyTex = makeTex(2048, 2048, gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT);

  const fbo = gl.createFramebuffer();
  function bind(tex, w, h) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.viewport(0, 0, w, h);
  }
  function drawField(t) {
    bind(fieldTex, SIZE, SIZE);
    gl.useProgram(fieldProg);
    gl.uniform1f(gl.getUniformLocation(fieldProg, "u_t"), t);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
  function drawPack() {
    bind(packTex, SIZE, SIZE);
    gl.useProgram(packProg);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, fieldTex);
    gl.uniform1i(gl.getUniformLocation(packProg, "u_s"), 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
  function queueBusy(n) {
    bind(busyTex, 2048, 2048);
    gl.useProgram(busyProg);
    const loc = gl.getUniformLocation(busyProg, "u_i");
    for (let i = 0; i < n; i++) {
      gl.uniform1f(loc, i);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
  }

  // Native read combination for the float FBO.
  bind(fieldTex, SIZE, SIZE);
  const nativeFmt = gl.getParameter(gl.IMPLEMENTATION_COLOR_READ_FORMAT);
  const nativeType = gl.getParameter(gl.IMPLEMENTATION_COLOR_READ_TYPE);

  const f32 = new Float32Array(SIZE * SIZE * 4);
  const u16 = new Uint16Array(SIZE * SIZE * 4);
  const u8 = new Uint8Array(SIZE * SIZE * 4);

  async function fenceDone(sync) {
    // Poll without blocking, like the node does.
    for (let i = 0; i < 2000; i++) {
      const s = gl.clientWaitSync(sync, 0, 0);
      if (s === gl.ALREADY_SIGNALED || s === gl.CONDITION_SATISFIED) return true;
      await sleep(0);
    }
    return false;
  }

  const REPS = 9;
  const results = [];
  async function run(name, busy, fn) {
    const times = [];
    for (let r = 0; r < REPS; r++) {
      gl.finish(); // drain
      drawField(r * 0.1);
      if (busy) queueBusy(30);
      const t = await fn(r);
      times.push(t);
    }
    times.sort((a, b) => a - b);
    results.push({ name: name + (busy ? " BUSY" : " idle"), ms: times[Math.floor(times.length / 2)], min: times[0] });
  }

  for (const busy of [false, true]) {
    await run("sync-f32", busy, async () => {
      bind(fieldTex, SIZE, SIZE);
      const t0 = now();
      gl.readPixels(0, 0, SIZE, SIZE, gl.RGBA, gl.FLOAT, f32);
      return now() - t0;
    });
    await run("sync-f16", busy, async () => {
      bind(fieldTex, SIZE, SIZE);
      const t0 = now();
      try {
        gl.readPixels(0, 0, SIZE, SIZE, gl.RGBA, gl.HALF_FLOAT, u16);
      } catch { return NaN; }
      return gl.getError() === 0 ? now() - t0 : NaN;
    });
    await run("sync-u8pack", busy, async () => {
      const t0 = now();
      drawPack();
      bind(packTex, SIZE, SIZE);
      gl.readPixels(0, 0, SIZE, SIZE, gl.RGBA, gl.UNSIGNED_BYTE, u8);
      return now() - t0;
    });
    await run("pbo-f32", busy, async () => {
      bind(fieldTex, SIZE, SIZE);
      const buf = gl.createBuffer();
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, buf);
      gl.bufferData(gl.PIXEL_PACK_BUFFER, f32.byteLength, gl.DYNAMIC_READ);
      const t0 = now();
      gl.readPixels(0, 0, SIZE, SIZE, gl.RGBA, gl.FLOAT, 0);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
      const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
      gl.flush();
      const issue = now() - t0;
      await fenceDone(sync);
      gl.deleteSync(sync);
      const t1 = now();
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, buf);
      gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, f32);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
      const collect = now() - t1;
      gl.deleteBuffer(buf);
      return issue + collect;
    });
    await run("pbo-u8pack", busy, async () => {
      const buf = gl.createBuffer();
      const t0 = now();
      drawPack();
      bind(packTex, SIZE, SIZE);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, buf);
      gl.bufferData(gl.PIXEL_PACK_BUFFER, u8.byteLength, gl.DYNAMIC_READ);
      gl.readPixels(0, 0, SIZE, SIZE, gl.RGBA, gl.UNSIGNED_BYTE, 0);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
      const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
      gl.flush();
      const issue = now() - t0;
      await fenceDone(sync);
      gl.deleteSync(sync);
      const t1 = now();
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, buf);
      gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, u8);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
      const collect = now() - t1;
      gl.deleteBuffer(buf);
      return issue + collect;
    });
    // Split timing for the PBO paths under busy: how much is issue vs collect?
    await run("pbo-u8 issue-only", busy, async () => {
      const buf = gl.createBuffer();
      const t0 = now();
      drawPack();
      bind(packTex, SIZE, SIZE);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, buf);
      gl.bufferData(gl.PIXEL_PACK_BUFFER, u8.byteLength, gl.DYNAMIC_READ);
      gl.readPixels(0, 0, SIZE, SIZE, gl.RGBA, gl.UNSIGNED_BYTE, 0);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
      gl.flush();
      const issue = now() - t0;
      gl.finish();
      gl.deleteBuffer(buf);
      return issue;
    });
  }

  return {
    gl: String(glName),
    native: { format: "0x" + nativeFmt.toString(16), type: "0x" + nativeType.toString(16) },
    results,
  };
})()
`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    width: 320,
    height: 240,
    webPreferences: { nodeIntegration: false },
  });
  await win.loadURL("data:text/html,<body></body>");
  const out = await win.webContents.executeJavaScript(HARNESS);
  if (out.error) {
    console.error("bench-readback:", out.error);
    app.exit(1);
    return;
  }
  console.log(`GL: ${out.gl}`);
  console.log(
    `native read for RGBA16F fbo: format ${out.native.format} type ${out.native.type}` +
      `  (RGBA=0x1908, FLOAT=0x1406, HALF_FLOAT=0x140b, UNSIGNED_BYTE=0x1401)`
  );
  console.log(`\n${"case".padEnd(24)} p50 ms   min ms`);
  for (const r of out.results) {
    const f = (v) => (Number.isFinite(v) ? v.toFixed(3).padStart(7) : "    n/a");
    console.log(`${r.name.padEnd(24)}${f(r.ms)}  ${f(r.min)}`);
  }
  app.exit(0);
});
