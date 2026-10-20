// Baked footage on the web (zipSink): frames as PNGs into ffmpeg.wasm's
// file system, one encode at finish() with the shared encoder args
// (export-ffmpeg-args.js — the same flags the desktop's native ffmpeg gets).
// The core is ffmpeg 5.1 with a 2 GiB heap (export-ffmpeg.ts): long or large
// bakes belong in the desktop app's folder export.

import type { AeBakeRequest } from "../scene";
import { bakeEncodeSpec } from "./runner";
import type { ZipBakeEncoder } from "./sinks";

export async function wasmBakeEncoder(bake: AeBakeRequest, fps: number, codec: AeBakeRequest["codec"]): Promise<ZipBakeEncoder> {
  const [{ getFfmpeg, runFfmpeg }, { encodePng }, { buildEncoderArgs }] = await Promise.all([
    import("@/lib/export-ffmpeg"),
    import("@/lib/skia-export/png"),
    import("@/lib/export-ffmpeg-args"),
  ]);
  const ff = await getFfmpeg();
  const [w, h] = bake.size;
  const prefix = `aebake_${bake.id.replace(/[^A-Za-z0-9_-]/g, "_")}_`;
  const out = `${prefix}out.mov`;
  const written: string[] = [];
  let result: Uint8Array | null = null;
  const cleanup = async () => {
    for (const f of written.splice(0)) await ff.deleteFile(f).catch(() => {});
  };
  return {
    async writeFrame(rgba) {
      const png = await encodePng(rgba, w, h);
      const name = `${prefix}${String(written.length).padStart(6, "0")}.png`;
      await ff.writeFile(name, png);
      written.push(name);
    },
    async finish() {
      const spec = bakeEncodeSpec(codec);
      try {
        await runFfmpeg(
          ff,
          ["-framerate", String(fps), "-i", `${prefix}%06d.png`, ...buildEncoderArgs(spec.codec, 18, spec.proresProfile, spec.alpha), "-r", String(fps), out],
          { label: `encode ${bake.path}` }
        );
        written.push(out);
        const data = await ff.readFile(out);
        result = data instanceof Uint8Array ? new Uint8Array(data) : new TextEncoder().encode(String(data));
        return { bytes: result.byteLength };
      } finally {
        await cleanup();
      }
    },
    abort: cleanup,
    bytes: () => result,
  };
}
