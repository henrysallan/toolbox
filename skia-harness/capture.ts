// Frame capture for the parity tools (specdocs/101326_skia-target.md §3.6).
//
// One snapshot routine for every platform: makeImageSnapshot() on the
// canvas, readPixels() as RGBA8 unpremultiplied (row 0 = top) — Skia's
// pixels, not the compositor's. It retries until two consecutive snapshots
// are byte-identical, so a frozen clock that hasn't reached the UI runtime
// yet (or a canvas still laying out after a size change) is never returned.
//
// What a snapshot is on device (react-native-skia 3.4.0, RNSkView.h /
// RNSkOffscreenSurface.h): a declarative canvas is REPLAYED into an
// offscreen sRGB surface, so the pixels are an sRGB render of the picture
// whatever color space the on-screen view uses (Display P3 on iOS wide-gamut
// screens). It measures the GPU's math, not the screen's colors.
//
// Native capture contract (scripts/skia-device-parity.mjs drives it):
//   toolboxharness://hello?run=<id>&host=<url>
//       → POST <host>/hello  { run, device… }
//   toolboxharness://capture?t=<sec>&run=<id>&host=<url>[&frame=<n>][&size=<px>]
//       → freezes the clock at t, sizes the canvas to <px> device pixels,
//         waits for Skia, POST <host>/frame { run, frame, t, width, height,
//         pixelRatio, attempts, rgba: base64 }
//   any failure → POST <host>/error { run, frame, message }
// The host must be loopback (the iOS simulator reaches the Mac at
// 127.0.0.1 / localhost; the Android emulator at 10.0.2.2), so a stray
// link can't make the harness upload its canvas anywhere else.
import type { RefObject } from "react";
import { Dimensions, PixelRatio, Platform } from "react-native";
import { AlphaType, ColorType, type CanvasRef } from "react-native-skia";

export interface Snapshot {
  width: number;
  height: number;
  rgba: Uint8Array;
  attempts: number;
}

export function nextFrames(n: number): Promise<void> {
  return new Promise((resolve) => {
    const step = (left: number) => (left <= 0 ? resolve() : requestAnimationFrame(() => step(left - 1)));
    step(n);
  });
}

function same(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// expectWidth: the pixel width the caller asked for. A different width is
// a layout still in flight; after half the attempts a stable snapshot is
// returned anyway so the caller can report the size it got.
export async function snapshot(
  ref: RefObject<CanvasRef | null>,
  opts: { expectWidth?: number; firstWait?: number; maxAttempts?: number } = {}
): Promise<Snapshot> {
  const { expectWidth, firstWait = 4, maxAttempts = 10 } = opts;
  let prev: Uint8Array | null = null;
  let lastError = "the canvas is not mounted";
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    await nextFrames(attempt === 1 ? firstWait : 2);
    const img = ref.current?.makeImageSnapshot();
    if (!img) {
      prev = null;
      continue;
    }
    const width = img.width();
    const height = img.height();
    const px = img.readPixels(0, 0, {
      width,
      height,
      colorType: ColorType.RGBA_8888,
      alphaType: AlphaType.Unpremul,
    });
    img.dispose?.();
    if (!(px instanceof Uint8Array)) {
      lastError = "readPixels returned no 8-bit data";
      prev = null;
      continue;
    }
    const sized = !expectWidth || width === expectWidth || attempt > maxAttempts / 2;
    if (prev && sized && same(prev, px)) return { width, height, rgba: px, attempts: attempt };
    prev = px;
    lastError = sized ? "the picture kept changing" : `the canvas is ${width} px wide, waiting for ${expectWidth}`;
  }
  throw new Error(`no stable snapshot after ${maxAttempts} attempts: ${lastError}`);
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

export function toBase64(bytes: Uint8Array): string {
  if (typeof btoa === "function") {
    let s = "";
    for (let i = 0; i < bytes.length; i += 0x8000) {
      s += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + 0x8000)));
    }
    return btoa(s);
  }
  const out: string[] = [];
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out.push(B64[n >> 18] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + B64[n & 63]);
  }
  if (i < bytes.length) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8);
    out.push(B64[n >> 18] + B64[(n >> 12) & 63] + (i + 1 < bytes.length ? B64[(n >> 6) & 63] : "=") + "=");
  }
  return out.join("");
}

export interface HarnessLink {
  action: string;
  params: Record<string, string>;
}

// toolboxharness://<action>?k=v&… — parsed by hand: React Native's URL
// polyfill doesn't implement searchParams on every version.
export function parseLink(url: string): HarnessLink | null {
  const m = /^toolboxharness:\/\/([a-z-]+)\/?(?:\?(.*))?$/i.exec(url.trim());
  if (!m) return null;
  const params: Record<string, string> = {};
  for (const kv of (m[2] ?? "").split("&")) {
    if (!kv) continue;
    const eq = kv.indexOf("=");
    const k = decodeURIComponent(eq < 0 ? kv : kv.slice(0, eq));
    params[k] = eq < 0 ? "" : decodeURIComponent(kv.slice(eq + 1).replace(/\+/g, " "));
  }
  return { action: m[1].toLowerCase(), params };
}

export function loopbackHost(host: string | undefined): string | null {
  if (!host) return null;
  const m = /^(https?:\/\/(?:localhost|127\.0\.0\.1|10\.0\.2\.2|\[::1\])(?::\d{1,5})?)\/?$/.exec(host);
  return m ? m[1] : null;
}

export async function postJson(url: string, body: unknown): Promise<void> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`POST ${url} → HTTP ${res.status}`);
}

// What the driver records about the device next to its numbers.
export function deviceInfo() {
  const constants: Record<string, unknown> = {};
  for (const [k, v] of Object.entries((Platform as { constants?: Record<string, unknown> }).constants ?? {})) {
    if (v === null || ["string", "number", "boolean"].includes(typeof v)) constants[k] = v;
    else if (k === "reactNativeVersion" && typeof v === "object") constants[k] = v;
  }
  return {
    platform: Platform.OS,
    version: Platform.Version,
    constants,
    pixelRatio: PixelRatio.get(),
    fontScale: PixelRatio.getFontScale(),
    window: Dimensions.get("window"),
    screen: Dimensions.get("screen"),
  };
}
