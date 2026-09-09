import { uploadCanvasToImage } from "@/engine/element";
import { buildPath2D } from "@/engine/spline-raster";
import type {
  ImageValue,
  NodeOutput,
  RenderContext,
  SocketValue,
  SplineValue,
} from "@/engine/types";

// Viewport-only stroke for a selected/Active node whose output is a spline
// with no image to blit. Same role as a spline primitive's bundled `image`
// aux, but universal: Trim Path, Offset Path, Connect Points, etc. don't
// each need their own rasterizer just so clicking the node shows a path.
//
// Not a substitute for Rasterize Spline — no dashes, caps, fills, or
// width profiles, and the texture is never attached to the node's output.
// Stroke weight is a fraction of the shorter canvas axis so a "thin line"
// stays about the same on-screen size at 512 and 4K.

const STATE_KEY = "__spline-preview";
const STROKE_FRAC = 0.003;
const STROKE_MIN_PX = 1.25;
const STROKE_STYLE = "rgba(255, 255, 255, 0.92)";

interface PreviewState {
  canvas: HTMLCanvasElement;
  lastSpline: SplineValue | null;
  lastW: number;
  lastH: number;
}

function pickSocket(
  result: NodeOutput,
  handle: string | undefined
): SocketValue | undefined {
  if (!handle) return undefined;
  if (handle === "out:primary") return result.primary;
  if (handle.startsWith("out:aux:")) {
    return result.aux?.[handle.slice("out:aux:".length)];
  }
  return undefined;
}

// The spline the viewport should stroke when there's no image. Prefers a
// remapped handle (group / reroute), then the node's primary. Does not
// rummage aux — a points-primary node with a spline aux is not "a spline
// node" for this purpose.
export function findSplineForPreview(
  result: NodeOutput,
  handle?: string
): SplineValue | undefined {
  const handled = pickSocket(result, handle);
  if (handled?.kind === "spline") return handled;
  if (result.primary?.kind === "spline") return result.primary;
  return undefined;
}

function ensureState(ctx: RenderContext): PreviewState | null {
  const existing = ctx.state[STATE_KEY] as PreviewState | undefined;
  if (existing?.canvas) return existing;
  if (typeof document === "undefined") return null;
  const state: PreviewState = {
    canvas: document.createElement("canvas"),
    lastSpline: null,
    lastW: 0,
    lastH: 0,
  };
  ctx.state[STATE_KEY] = state;
  return state;
}

function uploadPreview(
  ctx: RenderContext,
  canvas: HTMLCanvasElement
): ImageValue | null {
  try {
    return uploadCanvasToImage(ctx, canvas);
  } catch {
    // Stubbed GL in offline checks, or a backend that's already torn down.
    return null;
  }
}

export function rasterizeSplinePreview(
  ctx: RenderContext,
  spline: SplineValue
): ImageValue | null {
  if (spline.subpaths.length === 0) return null;
  const state = ensureState(ctx);
  if (!state) return null;

  const canvas = state.canvas;
  const W = Math.max(1, ctx.width);
  const H = Math.max(1, ctx.height);
  // Cached compute returns the same SplineValue object; skip the Path2D
  // rebuild and keep the last canvas pixels.
  if (
    state.lastSpline === spline &&
    state.lastW === W &&
    state.lastH === H &&
    canvas.width === W &&
    canvas.height === H
  ) {
    return uploadPreview(ctx, canvas);
  }

  if (canvas.width !== W || canvas.height !== H) {
    canvas.width = W;
    canvas.height = H;
  }
  const c2d = canvas.getContext?.("2d") ?? null;
  if (!c2d) return null;

  c2d.clearRect(0, 0, W, H);
  const path = buildPath2D(spline.subpaths, W, H, false);
  if (!path) return null;

  c2d.strokeStyle = STROKE_STYLE;
  c2d.lineWidth = Math.max(STROKE_MIN_PX, Math.min(W, H) * STROKE_FRAC);
  c2d.lineCap = "round";
  c2d.lineJoin = "round";
  c2d.stroke(path);

  state.lastSpline = spline;
  state.lastW = W;
  state.lastH = H;
  return uploadPreview(ctx, canvas);
}
