// check-paint-input: the Paint node's image input + knockout foundation
// (101526_paint-selection-transform.md M0), pure half.
//
// - The def: an optional `image` input, a hidden paint-typed `knockout`
//   param, and both surfaces listed in PAINT_SURFACE_PARAMS.
// - Parity: unwired, compute takes exactly the old path (same shader key and
//   source, empty canvas clears transparent), so an unwired Paint renders as
//   before the input existed.
// - Wired, compute switches to the composite shader and binds the input.
// - The input registry: a request bumps the node's fingerprint epoch, the
//   next compute serves it through ctx.readImagePixels at the REQUESTED size
//   (null when nothing is wired), takes waiters exactly once, and a request
//   no eval reaches times out to null.
//
// The GLSL compiles under check:shaders; the editor gestures (eraser cutting
// the input, Flatten) are live-app questions.
//
//   npx tsx scripts/check-paint-input.mts

import type { ImageValue, RenderContext } from "../src/engine/types.ts";
import { PAINT_SURFACE_PARAMS } from "../src/engine/types.ts";
import {
  paintInputEpoch,
  requestPaintInput,
  takePaintInputWaiters,
} from "../src/engine/paint-input-registry.ts";
import { paintNode } from "../src/nodes/source/paint.ts";

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  console.log(`${cond ? "ok  " : "FAIL"} ${name}${detail && !cond ? ` — ${detail}` : ""}`);
  if (!cond) failures++;
}

// ── Stub render context: records shader keys, clears, readbacks, binds ──
interface Log {
  shaders: { key: string; src: string }[];
  clears: number[][];
  reads: { image: unknown; w?: number; h?: number }[];
  regions: { x: number; y: number; w: number; h: number }[];
  bound: unknown[];
}
function makeCtx(): { ctx: RenderContext; log: Log } {
  const log: Log = { shaders: [], clears: [], reads: [], regions: [], bound: [] };
  let texId = 0;
  const gl = new Proxy(
    {
      createTexture: () => ({ tex: ++texId }),
      bindTexture: (_t: number, tex: unknown) => {
        if (tex) log.bound.push(tex);
      },
      getUniformLocation: () => ({}),
    } as Record<string, unknown>,
    {
      get(target, prop: string) {
        if (prop in target) return target[prop];
        // GL enums → numbers, every other method → no-op.
        return /^[A-Z_0-9]+$/.test(prop) ? 0 : () => {};
      },
    }
  );
  const ctx = {
    gl,
    state: {},
    allocImage: () => ({ kind: "image", texture: { out: true }, width: 64, height: 32 }),
    clearTarget: (_img: unknown, color: number[]) => log.clears.push(color),
    getShader: (key: string, src: string) => {
      log.shaders.push({ key, src });
      return {};
    },
    drawFullscreen: (_p: unknown, _o: unknown, setup: (g: unknown) => void) =>
      setup(gl),
    // Full readback: pixel (x, y) carries R = x, G = y so crops are
    // checkable.
    readImagePixels: (image: unknown, w?: number, h?: number) => {
      log.reads.push({ image, w, h });
      const W = w ?? 1, H = h ?? 1;
      const d = new Uint8ClampedArray(W * H * 4);
      for (let y = 0; y < H; y++)
        for (let x = 0; x < W; x++) {
          d[(y * W + x) * 4] = x;
          d[(y * W + x) * 4 + 1] = y;
          d[(y * W + x) * 4 + 3] = 255;
        }
      return d;
    },
    // GPU crop: same encoding, as 0..1 floats.
    readImageRegion: (_image: unknown, x: number, y: number, w: number, h: number) => {
      log.regions.push({ x, y, w, h });
      const f = new Float32Array(w * h * 4);
      for (let j = 0; j < h; j++)
        for (let i = 0; i < w; i++) {
          f[(j * w + i) * 4] = (x + i) / 255;
          f[(j * w + i) * 4 + 1] = (y + j) / 255;
          f[(j * w + i) * 4 + 3] = 1;
        }
      return f;
    },
  } as unknown as RenderContext;
  return { ctx, log };
}

function params(over: Record<string, unknown> = {}): Record<string, unknown> {
  const p: Record<string, unknown> = {};
  for (const d of paintNode.params) p[d.name] = d.default;
  return { ...p, ...over };
}

const fakeBitmap = () => ({ bitmap: Math.random() }) as unknown as ImageBitmap;
const fakeCanvas = {} as HTMLCanvasElement;
const inputImage: ImageValue = {
  kind: "image",
  texture: { input: true } as unknown as WebGLTexture,
  width: 64,
  height: 32,
};

function run(
  nodeId: string,
  p: Record<string, unknown>,
  image?: ImageValue
): Log {
  const { ctx, log } = makeCtx();
  paintNode.compute({
    inputs: image ? { image } : {},
    auxIn: {},
    params: p,
    ctx,
    nodeId,
  });
  return log;
}

// ── 1. The def ───────────────────────────────────────────────────────
const imageIn = paintNode.inputs.find((i) => i.name === "image");
check("image input exists", !!imageIn);
check("image input is optional", imageIn?.required === false);
check("image input is image-typed", imageIn?.type === "image");
const ko = paintNode.params.find((d) => d.name === "knockout");
check("knockout param is paint-typed", ko?.type === "paint");
check("knockout param is hidden", ko?.hidden === true);
check("knockout defaults to null", ko?.default === null);
check(
  "PAINT_SURFACE_PARAMS lists paint + knockout",
  PAINT_SURFACE_PARAMS.includes("paint") && PAINT_SURFACE_PARAMS.includes("knockout")
);

// ── 2. Unwired parity ────────────────────────────────────────────────
{
  const log = run("n-empty", params());
  check("unwired empty canvas clears transparent", log.clears.length === 1 &&
    log.clears[0].every((v) => v === 0));
  check("unwired empty canvas draws no shader", log.shaders.length === 0);
}
{
  const log = run("n-blit", params({ paint: { canvas: fakeCanvas, snapshot: fakeBitmap() } }));
  check("unwired strokes use the original blit key", log.shaders.length === 1 &&
    log.shaders[0].key === "paint/blit-v2");
  check(
    "blit shader still flips the canvas and composites per bg_mode",
    !!log.shaders[0]?.src.includes("1.0 - v_uv.y") &&
      !!log.shaders[0]?.src.includes("mix(overBg, s, u_transparent)")
  );
  check("unwired compute does no readback", log.reads.length === 0);
}
{
  // A stray knockout on an unwired node is ignored (it only masks the input).
  const log = run("n-stray-ko", params({
    paint: { canvas: fakeCanvas, snapshot: fakeBitmap() },
    knockout: { canvas: fakeCanvas, snapshot: fakeBitmap() },
  }));
  check("unwired knockout is ignored", log.shaders[0]?.key === "paint/blit-v2");
}

// ── 3. Wired composite ───────────────────────────────────────────────
{
  const log = run("n-wired-empty", params(), inputImage);
  check("wired empty canvas composites (input passes through)",
    log.shaders[0]?.key === "paint/composite" && log.clears.length === 0);
  check("wired compute binds the input texture",
    log.bound.includes(inputImage.texture));
}
{
  const log = run("n-wired", params({
    paint: { canvas: fakeCanvas, snapshot: fakeBitmap() },
    knockout: { canvas: fakeCanvas, snapshot: fakeBitmap() },
  }), inputImage);
  check("wired strokes + knockout use the composite", log.shaders[0]?.key === "paint/composite");
  check("composite applies knockout to the input alpha",
    !!log.shaders[0]?.src.includes("b.a *= 1.0 - texture(u_ko, cuv).a"));
}

// ── 4. Input registry ────────────────────────────────────────────────
{
  const id = "n-req";
  const e0 = paintInputEpoch(id);
  const fp0 = paintNode.fingerprintExtras?.(params(), {} as RenderContext, id);
  const pending = requestPaintInput(id, 20, 10);
  check("request bumps the epoch", paintInputEpoch(id) === e0 + 1);
  check(
    "request changes the fingerprint",
    paintNode.fingerprintExtras?.(params(), {} as RenderContext, id) !== fp0
  );
  const log = run(id, params(), inputImage);
  const px = await pending;
  check("compute reads the input back once", log.reads.length === 1 &&
    log.reads[0].image === inputImage);
  check("readback is at the requested size", log.reads[0]?.w === 20 && log.reads[0]?.h === 10);
  check("request resolves with the pixels",
    !!px && px.width === 20 && px.height === 10 && px.data.length === 20 * 10 * 4);
  check("waiters are taken exactly once", takePaintInputWaiters(id).length === 0);
  const again = run(id, params(), inputImage);
  check("no readback without a pending request", again.reads.length === 0);
}
{
  const id = "n-req-unwired";
  const pending = requestPaintInput(id, 8, 8);
  const log = run(id, params());
  check("unwired request resolves null", (await pending) === null);
  check("unwired request does no readback", log.reads.length === 0);
}
{
  const id = "n-req-timeout";
  const px = await requestPaintInput(id, 8, 8, null, 20);
  check("unserved request times out to null", px === null);
  check("timed-out waiter is removed", takePaintInputWaiters(id).length === 0);
}

{
  // Region request, input at canvas size → one GPU crop, no full readback.
  const id = "n-region-gpu";
  const pending = requestPaintInput(id, 64, 32, { x: 10, y: 5, w: 4, h: 3 });
  const log = run(id, params(), inputImage);
  const px = await pending;
  check("same-size region uses the GPU crop", log.regions.length === 1 && log.reads.length === 0);
  check(
    "GPU crop result carries its rect and pixels",
    !!px && px.x === 10 && px.y === 5 && px.width === 4 && px.height === 3 &&
      px.data[0] === 10 && px.data[1] === 5 &&
      px.data[((2 * 4) + 3) * 4] === 13 && px.data[((2 * 4) + 3) * 4 + 1] === 7
  );
}
{
  // Region request, input at another size → full resample, CPU crop.
  const id = "n-region-cpu";
  const small: ImageValue = { ...inputImage, width: 32, height: 16 };
  const pending = requestPaintInput(id, 64, 32, { x: 10, y: 5, w: 4, h: 3 });
  const log = run(id, params(), small);
  const px = await pending;
  check("resized input falls back to a full readback", log.regions.length === 0 &&
    log.reads.length === 1 && log.reads[0].w === 64 && log.reads[0].h === 32);
  check(
    "CPU crop matches the requested rect",
    !!px && px.x === 10 && px.width === 4 && px.data.length === 4 * 3 * 4 &&
      px.data[0] === 10 && px.data[1] === 5 &&
      px.data[((2 * 4) + 3) * 4] === 13 && px.data[((2 * 4) + 3) * 4 + 1] === 7
  );
}
{
  const id = "n-full";
  const pending = requestPaintInput(id, 20, 10);
  run(id, params(), inputImage);
  const px = await pending;
  check("full request reports origin 0,0", !!px && px.x === 0 && px.y === 0);
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nall paint-input checks passed");
