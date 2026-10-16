// check-paint-canvas: the Paint editor's selection compositing
// (101526_paint-selection-transform.md M1), floating selections (M2),
// transformed floats (M3) and the lasso / wand / modify ops (M4) against
// Chromium's REAL Canvas2D.
//
// Why Electron: the combine modes, clip, delete and fill are all
// globalCompositeOperation tricks (destination-in must clear OUTSIDE the
// shape too; "lighter" must cross-fade soft mask edges in premultiplied
// space). The DOM-stubbed check-*.mts scripts can't see any of that — only
// real pixels can. Pure geometry lives in check-paint-selection.mts.
//
//   npm run check:paint-canvas
//
// Must run with ELECTRON_RUN_AS_NODE unset (the npm script handles it).
// CommonJS: an Electron MAIN-process entry (see check-shaders.cjs).
/* eslint-disable @typescript-eslint/no-require-imports */
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");

const bundlePath = process.argv[2];
const bundle = fs.readFileSync(bundlePath, "utf8");

app.commandLine.appendSwitch("use-gl", "swiftshader");
app.commandLine.appendSwitch("enable-unsafe-swiftshader");
app.disableHardwareAcceleration();

let failures = 0;
function report(r) {
  console.log(`${r.ok ? "ok  " : "FAIL"} ${r.name}${r.log && !r.ok ? " — " + r.log : ""}`);
  if (!r.ok) failures++;
}
function finish(code) {
  try {
    fs.unlinkSync(bundlePath);
  } catch {
    /* already gone */
  }
  app.exit(code);
}

// Runs in the page. Each case returns {name, ok, log}.
const CASES = String.raw`
(() => {
  const { selection: S, floating: F, transform: T, StrokeSession, floodFill, DEFAULT_BRUSH_SETTINGS } = window.PaintCanvas;
  const W = 32, H = 24;
  const out = [];
  const add = (name, ok, log) => out.push({ name, ok: !!ok, log: log ?? "" });
  const mk = (fill) => {
    const c = document.createElement("canvas");
    c.width = W; c.height = H;
    if (fill) { const x = c.getContext("2d"); x.fillStyle = fill; x.fillRect(0, 0, W, H); }
    return c;
  };
  const px = (c, x, y) => Array.from(c.getContext("2d").getImageData(x, y, 1, 1).data);
  const a = (c, x, y) => px(c, x, y)[3];
  const near = (v, t, tol = 3) => Math.abs(v - t) <= tol;
  const rect = (x, y, w, h) => (ctx) => ctx.fillRect(x, y, w, h);

  // ── combine modes ──
  {
    const m = mk();
    S.combineIntoMask(m, rect(4, 4, 10, 8), "new");
    add("new: inside selected, outside not", a(m, 5, 5) === 255 && a(m, 20, 5) === 0);
    S.combineIntoMask(m, rect(18, 4, 6, 6), "add");
    add("add: both regions selected", a(m, 5, 5) === 255 && a(m, 20, 5) === 255 && a(m, 16, 5) === 0);
    S.combineIntoMask(m, rect(6, 6, 2, 2), "subtract");
    add("subtract: punches a hole, keeps the rest", a(m, 6, 6) === 0 && a(m, 5, 5) === 255 && a(m, 20, 5) === 255);
    S.combineIntoMask(m, rect(0, 0, 12, 24), "intersect");
    add(
      "intersect: keeps only the overlap and clears OUTSIDE the shape",
      a(m, 5, 5) === 255 && a(m, 13, 5) === 0 && a(m, 20, 5) === 0,
      "alphas " + [a(m, 5, 5), a(m, 13, 5), a(m, 20, 5)].join(",")
    );
    S.combineIntoMask(m, rect(1, 1, 3, 3), "new");
    add("new replaces the previous selection", a(m, 2, 2) === 255 && a(m, 5, 5) === 0);
  }
  // ── whole-mask ops ──
  {
    const m = mk();
    S.combineIntoMask(m, rect(4, 4, 8, 8), "new");
    S.invertMask(m);
    add("invert: inside ↔ outside", a(m, 5, 5) === 0 && a(m, 20, 20) === 255);
    S.fillMask(m);
    add("select all fills the mask", a(m, 5, 5) === 255 && a(m, 0, 0) === 255);
    S.clearMask(m);
    add("deselect empties it (bbox null)", S.maskBBox(m) === null);
  }
  // ── bbox + ants on a real ellipse ──
  {
    const m = mk();
    S.combineIntoMask(m, (ctx) => { ctx.beginPath(); ctx.ellipse(16, 12, 8, 6, 0, 0, Math.PI * 2); ctx.fill(); }, "new");
    const b = S.maskBBox(m);
    add(
      "ellipse bbox ≈ its extents",
      b && near(b.x, 8, 1) && near(b.y, 6, 1) && near(b.w, 16, 1) && near(b.h, 12, 1),
      JSON.stringify(b)
    );
    const e = S.maskEdges(m, b);
    let minX = 1e9, maxX = -1e9;
    for (let i = 0; i < e.length; i += 4) { minX = Math.min(minX, e[i], e[i + 2]); maxX = Math.max(maxX, e[i], e[i + 2]); }
    add("ants are in canvas px around the ellipse", e.length > 0 && near(minX, 8, 1) && near(maxX, 24, 1), minX + ".." + maxX);
  }
  // ── restoreOutsideSelection (clipped fill) ──
  {
    const before = mk("#ff0000");
    const target = mk("#0000ff");
    const m = mk();
    S.combineIntoMask(m, rect(0, 0, 16, 24), "new");
    // One soft column: 50% selected.
    const mctx = m.getContext("2d");
    mctx.fillStyle = "rgba(255,255,255,0.5)";
    mctx.clearRect(16, 0, 1, 24);
    mctx.fillRect(16, 0, 1, 24);
    S.restoreOutsideSelection(target, before, m);
    const inside = px(target, 4, 4), outside = px(target, 24, 4), soft = px(target, 16, 4);
    add("clip: edit kept inside", inside[2] === 255 && inside[0] === 0 && inside[3] === 255, inside.join(","));
    add("clip: original restored outside", outside[0] === 255 && outside[2] === 0 && outside[3] === 255, outside.join(","));
    add(
      "clip: soft edge cross-fades (opaque, ~half each)",
      near(soft[0], 128, 4) && near(soft[2], 128, 4) && soft[3] === 255,
      soft.join(",")
    );
  }
  // ── delete + fill in selection ──
  {
    const edit = mk("#00ff00");
    const ko = mk();
    const m = mk();
    S.combineIntoMask(m, rect(4, 4, 8, 8), "new");
    S.eraseSelection(edit, ko, m);
    add("delete clears the edit layer inside", a(edit, 5, 5) === 0 && a(edit, 20, 20) === 255);
    add("delete knocks the input out inside only", a(ko, 5, 5) === 255 && a(ko, 20, 20) === 0);
    const e2 = mk();
    S.fillSelection(e2, m, "#336699");
    const f = px(e2, 5, 5);
    add("fill paints the color inside", f[0] === 0x33 && f[1] === 0x66 && f[2] === 0x99 && f[3] === 255, f.join(","));
    add("fill leaves outside untouched", a(e2, 20, 20) === 0);
    const e3 = mk();
    S.fillSelection(e3, null, "#336699");
    add("fill with no selection covers the canvas", a(e3, 0, 0) === 255 && a(e3, W - 1, H - 1) === 255);
  }
  // ── selectionMask store rescale ──
  {
    const m = S.selectionMask("n-rescale", W, H);
    S.combineIntoMask(m, rect(0, 0, 16, 24), "new");
    const m2 = S.selectionMask("n-rescale", W * 2, H * 2);
    add("store returns the same mask", m2 === m && S.peekSelectionMask("n-rescale") === m);
    add("rescale keeps the selected area", m2.width === W * 2 && a(m2, 10, 10) === 255 && a(m2, 50, 10) === 0);
    add("peek never allocates", S.peekSelectionMask("n-never") === null);
  }
  // ── strokes clip to the selection ──
  const brush = { ...DEFAULT_BRUSH_SETTINGS, hardness: 1, flow: 1, opacity: 1, smoothing: 0, spacing: 0.1 };
  {
    const target = mk();
    const m = mk();
    S.combineIntoMask(m, rect(0, 0, 16, 24), "new");
    const s = new StrokeSession(target, { mode: "paint", color: "#ffffff", size: 6, brush, pressureCapable: false, clip: m });
    s.down(2, 12, 0.5); s.move(30, 12, 0.5); s.lineTo(30, 12, 0.5); s.end();
    add("paint stroke lands inside the selection", a(target, 8, 12) > 200);
    add("paint stroke is clipped outside it", a(target, 24, 12) === 0, "alpha " + a(target, 24, 12));
  }
  {
    const edit = mk("#ff00ff");
    const ko = mk();
    const m = mk();
    S.combineIntoMask(m, rect(0, 0, 16, 24), "new");
    const s = new StrokeSession(edit, { mode: "erase", color: "#000", size: 6, brush, pressureCapable: false, knockout: ko, clip: m });
    s.down(2, 12, 0.5); s.lineTo(30, 12, 0.5); s.end();
    add("erase removes strokes inside the selection only", a(edit, 8, 12) < 50 && a(edit, 24, 12) === 255);
    add("erase mirrors into the knockout, clipped", a(ko, 8, 12) > 200 && a(ko, 24, 12) === 0);
    // Undo regions restore the pre-stroke pixels of both surfaces.
    const undo = s.undoSurfaces();
    for (const u of undo) u.canvas.getContext("2d").putImageData(u.imageData, u.x, u.y);
    add(
      "undo regions cover the stroke on both surfaces",
      undo.length === 2 && a(edit, 8, 12) === 255 && a(ko, 8, 12) === 0,
      undo.length + " surfaces"
    );
  }
  {
    // No selection: the stroke is unclipped (regression guard).
    const target = mk();
    const s = new StrokeSession(target, { mode: "paint", color: "#ffffff", size: 6, brush, pressureCapable: false });
    s.down(2, 12, 0.5); s.lineTo(30, 12, 0.5); s.end();
    add("no selection: stroke spans the canvas", a(target, 8, 12) > 200 && a(target, 24, 12) > 200);
  }
  // ── floating selections (M2) ──
  {
    // Composite under a selection: input (blue) minus knockout, edit (red)
    // on top, masked by the selection.
    const edit = mk();
    edit.getContext("2d").fillStyle = "#ff0000";
    edit.getContext("2d").fillRect(4, 4, 4, 4);
    const ko = mk();
    ko.getContext("2d").fillStyle = "#fff";
    ko.getContext("2d").fillRect(10, 4, 2, 2);
    const sel = mk();
    S.combineIntoMask(sel, rect(2, 2, 12, 8), "new");
    const bbox = { x: 2, y: 2, w: 12, h: 8 };
    const input = new Uint8ClampedArray(bbox.w * bbox.h * 4);
    for (let i = 0; i < bbox.w * bbox.h; i++) { input[i * 4 + 2] = 255; input[i * 4 + 3] = 255; }
    const { source, mask } = F.compositeUnderSelection(edit, ko, input, sel, bbox);
    const at = (c, x, y) => Array.from(c.getContext("2d").getImageData(x, y, 1, 1).data);
    add("composite: bbox-sized pieces", source.width === 12 && source.height === 8 && mask.width === 12);
    const e = at(source, 4 - 2, 4 - 2), i = at(source, 3 - 2, 3 - 2), k = at(source, 10 - 2, 4 - 2);
    add("composite: edit pixels over the input", e[0] === 255 && e[2] === 0 && e[3] === 255, e.join(","));
    add("composite: input shows where nothing is painted", i[2] === 255 && i[3] === 255, i.join(","));
    add("composite: knocked-out input is not picked up", k[3] === 0, k.join(","));
    const unmasked = F.compositeUnderSelection(edit, null, null, sel, bbox).source;
    add("composite without an input is the edit layer alone", at(unmasked, 1, 1)[3] === 0 && at(unmasked, 2, 2)[0] === 255);
  }
  {
    // Lift → move → commit, the way the overlay sequences it.
    const edit = mk();
    edit.getContext("2d").fillStyle = "#00ff00";
    edit.getContext("2d").fillRect(4, 4, 4, 4);
    const sel = mk();
    S.combineIntoMask(sel, rect(4, 4, 4, 4), "new");
    const bbox = { x: 4, y: 4, w: 4, h: 4 };
    const pieces = F.compositeUnderSelection(edit, null, null, sel, bbox);
    S.eraseSelection(edit, null, sel);
    const f = {
      source: pieces.source, mask: pieces.mask,
      matrix: F.compose(F.translation(10, 6), F.translation(bbox.x, bbox.y)),
      base: F.copyCanvas(edit), before: { edit: null, knockout: null, selection: null },
      touched: null, edges: new Int32Array(0),
    };
    F.renderFloating(edit, f);
    add("lift leaves a hole where the pixels were", a(edit, 5, 5) === 0);
    add("the float renders at its new place", a(edit, 15, 11) === 255 && px(edit, 15, 11)[1] === 255);
    F.placeMask(sel, f);
    add("the selection follows the pixels on commit", a(sel, 15, 11) === 255 && a(sel, 5, 5) === 0);
    // Alt-drag duplicate: stamp, move on, render — both copies present.
    F.stampIntoBase(f);
    f.matrix = F.compose(F.translation(-12, 0), f.matrix);
    F.renderFloating(edit, f);
    add("Alt-drag leaves a copy behind", a(edit, 15, 11) === 255 && a(edit, 3, 11) === 255);
    // Cancel restores the pre-float copy.
    const pre = mk("#123456");
    F.restoreFrom(edit, pre);
    add("cancel restores the pre-float pixels", px(edit, 15, 11).join(",") === "18,52,86,255");
  }
  {
    // Fit-scaled paste renders scaled through the matrix.
    const src = document.createElement("canvas");
    src.width = 64; src.height = 48;
    src.getContext("2d").fillStyle = "#ffffff";
    src.getContext("2d").fillRect(0, 0, 64, 48);
    const m = F.fitCentered(64, 48, W, H);
    const target = mk();
    F.drawThrough(target.getContext("2d"), src, m);
    add("fit-scaled paste covers the canvas, not more", a(target, 0, 0) === 255 && a(target, W - 1, H - 1) === 255);
  }
  // ── transformed floats (M3) ──
  {
    // A 4×4 green float at (4, 4); scale it 2× from its top-left corner by
    // dragging the bottom-right handle, then render.
    const src = document.createElement("canvas");
    src.width = 4; src.height = 4;
    src.getContext("2d").fillStyle = "#00ff00";
    src.getContext("2d").fillRect(0, 0, 4, 4);
    const content = { x: 0, y: 0, w: 4, h: 4 };
    const m0 = F.translation(4, 4);
    const m = T.dragTransform("scale", 4, m0, content, [8, 8], [12, 12], { shift: false, alt: false });
    const edit = mk();
    const f = { source: src, mask: src, matrix: m, content, base: mk(), before: {}, touched: null, edges: new Int32Array(0) };
    F.renderFloating(edit, f);
    add("scaled float covers its new 8×8 box", a(edit, 5, 5) === 255 && a(edit, 11, 11) === 255);
    add("scaled float stops at the box edge", a(edit, 13, 13) === 0 && a(edit, 3, 3) === 0);
    // Rotate 90° about the content center: a 4×8 strip becomes 8×4.
    const strip = document.createElement("canvas");
    strip.width = 4; strip.height = 8;
    strip.getContext("2d").fillStyle = "#fff";
    strip.getContext("2d").fillRect(0, 0, 4, 8);
    const sc = { x: 0, y: 0, w: 4, h: 8 };
    const sm0 = F.translation(14, 6);
    const r = T.dragTransform("rotate", -1, sm0, sc, [20, 10], [16, 14], { shift: false, alt: false });
    const e2 = mk();
    F.renderFloating(e2, { source: strip, mask: strip, matrix: r, content: sc, base: mk(), before: {}, touched: null, edges: new Int32Array(0) });
    add("rotated float lies across", a(e2, 13, 10) === 255 && a(e2, 18, 10) === 255 && a(e2, 16, 6) === 0,
      [a(e2, 13, 10), a(e2, 18, 10), a(e2, 16, 6)].join(","));
    // Flip H: a left-half-red source reads right-half-red after the flip.
    const half = document.createElement("canvas");
    half.width = 8; half.height = 4;
    half.getContext("2d").fillStyle = "#ff0000";
    half.getContext("2d").fillRect(0, 0, 4, 4);
    const hc = { x: 0, y: 0, w: 8, h: 4 };
    const e3 = mk();
    F.renderFloating(e3, { source: half, mask: half, matrix: T.flipTransform(F.translation(2, 2), hc, "h"), content: hc, base: mk(), before: {}, touched: null, edges: new Int32Array(0) });
    add("flip H mirrors the pixels", a(e3, 3, 3) === 0 && a(e3, 8, 3) === 255);
  }
  // ── lasso / wand / modify (M4) ──
  {
    const m = mk();
    S.combinePolygon(m, [[2, 2], [20, 2], [2, 20]], "new");
    add("lasso polygon: inside selected, outside not", a(m, 4, 4) === 255 && a(m, 18, 18) === 0);
    S.combinePolygon(m, [[2, 2], [8, 2], [8, 8], [2, 8]], "subtract");
    add("lasso subtract cuts the polygon out", a(m, 4, 4) === 0 && a(m, 4, 14) === 255);
  }
  {
    const region = new Uint8Array(W * H);
    for (let y = 4; y < 12; y++) for (let x = 4; x < 12; x++) region[y * W + x] = 1;
    const hard = mk();
    S.combineRegion(hard, region, false, "new");
    add("wand region (no AA) is exact", a(hard, 4, 4) === 255 && a(hard, 3, 4) === 0 && a(hard, 12, 8) === 0);
    const soft = mk();
    S.combineRegion(soft, region, true, "new");
    add("wand anti-alias softens the edge", a(soft, 8, 8) > 240 && a(soft, 3, 8) > 0 && a(soft, 3, 8) < 200,
      "edge " + a(soft, 3, 8));
  }
  {
    const m = mk();
    S.combineIntoMask(m, rect(8, 4, 16, 16), "new");
    S.featherMask(m, 6);
    add("feather: core stays selected", a(m, 16, 12) > 230, "" + a(m, 16, 12));
    add("feather: the edge goes soft", a(m, 8, 12) > 60 && a(m, 8, 12) < 200, "" + a(m, 8, 12));
    add("feather: falloff reaches outside", a(m, 6, 12) > 0, "" + a(m, 6, 12));
  }
  {
    const m = mk();
    S.combineIntoMask(m, rect(12, 8, 6, 6), "new");
    S.growMask(m, 3, { x: 12, y: 8, w: 6, h: 6 });
    add("expand grows by r", a(m, 10, 10) === 255 && a(m, 20, 10) === 255 && a(m, 22, 10) === 0,
      [a(m, 10, 10), a(m, 20, 10), a(m, 22, 10)].join(","));
    S.growMask(m, -4, S.maskBBox(m));
    add("contract shrinks by r", a(m, 10, 10) === 0 && a(m, 14, 10) === 255,
      [a(m, 10, 10), a(m, 14, 10)].join(","));
  }
  {
    const edit = mk();
    edit.getContext("2d").fillStyle = "rgba(255,0,0,0.6)";
    edit.getContext("2d").fillRect(5, 5, 4, 4);
    const m = mk();
    S.selectPainted(m, edit);
    add("select painted = the layer's alpha", near(a(m, 6, 6), 153, 3) && a(m, 12, 12) === 0, "" + a(m, 6, 6));
  }
  {
    // Fill matching a SAMPLE (the composite) but writing the edit layer:
    // the sample has a wall the edit layer doesn't.
    const edit = mk();
    const sample = new Uint8ClampedArray(W * H * 4);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      sample[i + 3] = 255;
      sample[i] = x === 10 ? 255 : 0;
    }
    floodFill(edit, 2, 2, "#00ff00", 0.05, sample);
    add("fill follows the composite's wall", a(edit, 5, 5) === 255 && a(edit, 10, 5) === 0 && a(edit, 15, 5) === 0);
    add("fill paints opaque color", px(edit, 5, 5).join(",") === "0,255,0,255");
  }
  return out;
})()
`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    width: 64,
    height: 64,
    webPreferences: { nodeIntegration: false },
  });
  await win.loadURL("data:text/html,<body></body>");
  try {
    await win.webContents.executeJavaScript(bundle);
    const results = await win.webContents.executeJavaScript(CASES);
    results.forEach(report);
  } catch (e) {
    console.error("FATAL:", e && e.message ? e.message : e);
    finish(1);
    return;
  }
  console.log(
    failures === 0 ? "\nall paint-canvas checks passed" : `\n${failures} paint-canvas check(s) FAILED`
  );
  finish(failures === 0 ? 0 : 1);
});
