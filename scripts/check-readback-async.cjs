// check-readback-async: the GPU half of the pipelined export readback
// (092126_async-pipelined-readback.md) in a real WebGL2 context.
//
// Proves, against the engine's actual createEngineBackend (bundled from
// src/engine/gl.ts by the npm script):
//
//   1. byte parity — readImagePixelsAsync returns exactly the bytes
//      readImagePixels does, for the same texture, at native size and at
//      a resized readback;
//   2. no stale frames — with one read in flight, the source texture is
//      overwritten with frame i+1 BEFORE frame i's promise is awaited, and
//      every resolved frame still equals its own expected picture;
//   3. cancel / destroy leave GL clean — a cancelled read resolves null,
//      getError() stays NO_ERROR, and a further read after the cancel works;
//      destroy() with reads outstanding resolves them null without error.
//
//   npm run check:readback-async
//
// NOTE: must run with ELECTRON_RUN_AS_NODE unset (the npm script handles it),
// or Electron boots as plain Node and there is no GL context. Uses
// SwiftShader so it runs headless; the SPEED of the async path is a
// hardware question — measure it from a desktop export log (TESTING.md).
/* eslint-disable @typescript-eslint/no-require-imports */
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

const bundlePath = process.argv[2];
if (!bundlePath || !fs.existsSync(bundlePath)) {
  console.error("usage: electron scripts/check-readback-async.cjs <gl-bundle.js>");
  process.exit(2);
}
const bundle = fs.readFileSync(path.resolve(bundlePath), "utf8");

app.commandLine.appendSwitch("use-gl", "swiftshader");
app.commandLine.appendSwitch("enable-unsafe-swiftshader");
app.disableHardwareAcceleration();

const HARNESS = String.raw`
(async () => {
  const results = [];
  const check = (name, cond, detail) => results.push({ name, ok: !!cond, detail });
  try {
    const { createEngineBackend } = ToolboxGL;
    const W = 96, H = 64;
    const backend = createEngineBackend(W, H);
    const gl = backend.gl;
    const errName = (e) => "0x" + e.toString(16);
    const noError = () => { const e = gl.getError(); return e === gl.NO_ERROR ? null : errName(e); };

    // A source texture we fill from the CPU with a frame-dependent picture,
    // so the expected bytes are known exactly (RGBA8 → RGBA8 is lossless).
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, W, H, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.bindTexture(gl.TEXTURE_2D, null);
    const image = { kind: "image", texture: tex, width: W, height: H };

    // Picture for frame f, in GL upload order (row 0 = bottom). The
    // readback is Y-flipped so row 0 of the RESULT is the visual top.
    const picture = (f) => {
      const px = new Uint8Array(W * H * 4);
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const o = (y * W + x) * 4;
        px[o] = (x * 2 + f * 7) & 0xff;
        px[o + 1] = (y * 3 + f * 13) & 0xff;
        px[o + 2] = (x ^ y ^ f) & 0xff;
        px[o + 3] = 255 - ((f * 5) & 0x7f);
      }
      return px;
    };
    const expectedTopDown = (f) => {
      const up = picture(f);
      const out = new Uint8Array(up.length);
      for (let y = 0; y < H; y++) {
        out.set(up.subarray((H - 1 - y) * W * 4, (H - y) * W * 4), y * W * 4);
      }
      return out;
    };
    const upload = (f) => {
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, picture(f));
      gl.bindTexture(gl.TEXTURE_2D, null);
    };
    const same = (a, b) => {
      if (!a || !b || a.length !== b.length) return false;
      for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
      return true;
    };
    const firstDiff = (a, b) => {
      if (!a || !b) return "null";
      if (a.length !== b.length) return "len " + a.length + " vs " + b.length;
      for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return "byte " + i + ": " + a[i] + " vs " + b[i];
      return "identical";
    };

    // 1. parity, native size
    upload(0);
    const sync0 = backend.readImagePixels(image);
    const async0 = await backend.readImagePixelsAsync(image).promise;
    check("parity: async === sync at native size", same(sync0, async0), firstDiff(sync0, async0));
    check("parity: sync matches the expected top-down picture", same(sync0, expectedTopDown(0)), firstDiff(sync0, expectedTopDown(0)));
    check("parity: result type is Uint8ClampedArray over an ArrayBuffer",
      async0 instanceof Uint8ClampedArray && async0.buffer instanceof ArrayBuffer && async0.length === W * H * 4);
    check("parity: no GL error after first async read", noError() === null, noError());

    // 1b. parity at a resized readback (export resolution != texture size)
    const RW = 40, RH = 24;
    const syncR = backend.readImagePixels(image, RW, RH);
    const asyncR = await backend.readImagePixelsAsync(image, RW, RH).promise;
    check("parity: async === sync at a resized readback", same(syncR, asyncR) && asyncR.length === RW * RH * 4, firstDiff(syncR, asyncR));

    // 2. pipelined: overwrite the source before awaiting the previous read
    const N = 24;
    let pending = null;
    let stale = 0, nulls = 0;
    for (let i = 0; i < N; i++) {
      upload(i);
      const next = backend.readImagePixelsAsync(image);
      if (pending) {
        const px = await pending.read.promise;
        if (!px) nulls++;
        else if (!same(px, expectedTopDown(pending.i))) stale++;
      }
      pending = { i, read: next };
    }
    const last = await pending.read.promise;
    if (!last) nulls++; else if (!same(last, expectedTopDown(N - 1))) stale++;
    check("pipeline: " + N + " frames, one in flight, none null", nulls === 0, nulls + " null");
    check("pipeline: every frame equals its OWN picture (source overwritten before await)", stale === 0, stale + " stale/wrong");
    check("pipeline: no GL error after the pipelined run", noError() === null, noError());

    // 2b. several reads outstanding beyond the pool size still all land
    upload(100);
    const many = [];
    for (let k = 0; k < 5; k++) many.push(backend.readImagePixelsAsync(image).promise);
    const manyPx = await Promise.all(many);
    check("pool: 5 reads outstanding (pool is 3) all resolve with the right bytes",
      manyPx.every((p) => same(p, expectedTopDown(100))), manyPx.map((p) => (p ? "ok" : "null")).join(","));
    check("pool: no GL error after over-subscribing the pool", noError() === null, noError());

    // 3. cancel
    upload(7);
    const c = backend.readImagePixelsAsync(image);
    c.cancel();
    const cPx = await c.promise;
    check("cancel: cancelled read resolves null", cPx === null);
    c.cancel();
    check("cancel: second cancel is a no-op without GL error", noError() === null, noError());
    const after = await backend.readImagePixelsAsync(image).promise;
    check("cancel: a read issued after the cancel returns the right bytes", same(after, expectedTopDown(7)), firstDiff(after, expectedTopDown(7)));

    // 3b. a stray PIXEL_PACK_BUFFER binding would break plain readPixels
    const plain = backend.readImagePixels(image);
    check("state: sync readPixels still works after async reads (PIXEL_PACK_BUFFER unbound)", same(plain, expectedTopDown(7)));
    check("state: PIXEL_PACK_BUFFER_BINDING is null between reads", gl.getParameter(gl.PIXEL_PACK_BUFFER_BINDING) === null);

    // 3c. destroy with reads outstanding
    upload(9);
    const d1 = backend.readImagePixelsAsync(image);
    const d2 = backend.readImagePixelsAsync(image);
    backend.destroy();
    const [dp1, dp2] = await Promise.all([d1.promise, d2.promise]);
    check("destroy: outstanding reads resolve null", dp1 === null && dp2 === null);
    check("destroy: no GL error", noError() === null, noError());
    // Nothing should still be polling: wait longer than the poll cadence.
    await new Promise((r) => setTimeout(r, 30));
    check("destroy: no GL error after the poll window", noError() === null, noError());
    gl.deleteTexture(tex);

    const dbg = gl.getExtension("WEBGL_debug_renderer_info");
    const renderer = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : "unknown";
    return { results, renderer: String(renderer) };
  } catch (e) {
    return { results, error: String(e && e.stack || e) };
  }
})()
`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    width: 320,
    height: 240,
    webPreferences: { nodeIntegration: false, contextIsolation: true },
  });
  await win.loadURL("data:text/html,<body></body>");
  await win.webContents.executeJavaScript(bundle);
  const out = await win.webContents.executeJavaScript(HARNESS);
  let failures = 0;
  for (const r of out.results) {
    if (!r.ok) failures++;
    console.log(`${r.ok ? "PASS " : "FAIL "} ${r.name}${!r.ok && r.detail ? ` — ${r.detail}` : ""}`);
  }
  if (out.error) {
    failures++;
    console.log(`FAIL  harness threw — ${out.error}`);
  }
  console.log(`\nGL: ${out.renderer ?? "n/a"}`);
  if (failures > 0) {
    console.log(`check-readback-async: ${failures} failure(s)`);
    app.exit(1);
    return;
  }
  console.log("all passed");
  app.exit(0);
});
