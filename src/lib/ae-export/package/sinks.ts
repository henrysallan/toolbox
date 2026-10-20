// Where the runner writes a package (runner.ts AePackageSink):
//
//   folderSink  a package folder main created (platform.runAfterEffects
//               .createPackage): nested writes main checks, and baked
//               footage encoded by the native ffmpeg straight into
//               footage/ — no Save dialog, the path is main-validated.
//   zipSink     the web build (or desktop by choice): files collected into
//               "<base>.aepkg/…" inside a zip that downloads at the end,
//               footage encoded with ffmpeg.wasm (wasm.ts).

import type { AePackageFolder, Platform } from "@/lib/platform/types";
import type { AeBakeRequest } from "../scene";
import { bakeEncodeSpec, type AeBakeEncoder, type AePackageSink } from "./runner";

const utf8 = (s: string) => new TextEncoder().encode(s);
const baseOf = (p: string) => p.split("/").pop() ?? p;

export function folderSink(pkg: AePackageFolder, platform: Pick<Platform, "encodeVideo" | "canEncodeNative">): AePackageSink {
  const warnings: string[] = [];
  if (!pkg.aerenderSafe && pkg.aerenderReason)
    warnings.push(`After Effects' command-line renderer can't open this folder (compare_ae_renders won't work from it): ${pkg.aerenderReason}`);
  return {
    kind: "folder",
    location: pkg.path,
    warnings,
    writeFile: (path, data) => pkg.writeFileAt(path, typeof data === "string" ? utf8(data) : data),
    async encodeBake(bake: AeBakeRequest, fps: number): Promise<AeBakeEncoder> {
      if (!platform.encodeVideo || !platform.canEncodeNative)
        throw new Error("this desktop app has no native ffmpeg to encode baked footage — export a zip instead");
      const spec = bakeEncodeSpec(bake.codec);
      const session = await platform.encodeVideo({
        width: bake.size[0],
        height: bake.size[1],
        fps,
        durationFrames: bake.frames[1] - bake.frames[0] + 1,
        container: "mov",
        codec: spec.codec,
        crf: 18,
        proresProfile: spec.proresProfile,
        alpha: spec.alpha,
        suggestedName: baseOf(bake.path),
        into: { folder: pkg, path: bake.path },
      });
      if (!session) throw new Error(`the encoder for ${bake.path} did not start`);
      return {
        writeFrame: (rgba) => session.writeFrame(rgba),
        finish: async () => ({ bytes: (await session.finish()).bytes }),
        abort: () => session.abort(),
      };
    },
    finish: async () => {},
  };
}

export interface ZipBakeEncoder extends AeBakeEncoder {
  // The encoded .mov once finish() resolved.
  bytes(): Uint8Array | null;
}

export interface ZipSinkOptions {
  // Encodes one bake (ffmpeg.wasm on the web — wasm.ts wasmBakeEncoder).
  encode(bake: AeBakeRequest, fps: number, codec: AeBakeRequest["codec"]): Promise<ZipBakeEncoder>;
  // Delivers the finished zip (downloadBlob).
  save(zip: Blob, fileName: string): void | Promise<void>;
  // Build the zip (default: JSZip, lazy).
  zip?(entries: { path: string; data: Uint8Array | string }[]): Promise<Blob>;
}

export async function buildZipBlob(entries: { path: string; data: Uint8Array | string }[]): Promise<Blob> {
  const JSZip = (await import("jszip")).default;
  const zip = new JSZip();
  for (const e of entries) zip.file(e.path, e.data);
  return zip.generateAsync({ type: "blob", mimeType: "application/zip" });
}

export function zipSink(root: string, opts: ZipSinkOptions): AePackageSink & { entries(): { path: string; data: Uint8Array | string }[] } {
  const files = new Map<string, Uint8Array | string>();
  const warnings: string[] = [];
  const fileName = `${root}.zip`;
  const entries = () => [...files].map(([path, data]) => ({ path: `${root}/${path}`, data }));
  return {
    kind: "zip",
    location: fileName,
    warnings,
    entries,
    async writeFile(path, data) {
      files.set(path, data);
    },
    async encodeBake(bake, fps) {
      // ffmpeg.wasm is ffmpeg 5.1, whose ProRes 4444 alpha Apple's decoder
      // (and so After Effects on macOS) reads as opaque —
      // specdocs/091526_prores-alpha.md. QuickTime Animation keeps it.
      let codec = bake.codec;
      if (codec === "prores4444") {
        codec = "qtrle";
        const note = "Baked footage in a zip is QuickTime Animation (qtrle): the browser's ffmpeg writes ProRes 4444 alpha that After Effects reads as opaque. Export to a folder from the desktop app for ProRes 4444.";
        if (!warnings.includes(note)) warnings.push(note);
      }
      const enc = await opts.encode(bake, fps, codec);
      return {
        writeFrame: (rgba) => enc.writeFrame(rgba),
        async finish() {
          const r = await enc.finish();
          const bytes = enc.bytes();
          if (!bytes) throw new Error(`no ${bake.path} came out of the encoder`);
          files.set(bake.path, bytes);
          return { bytes: r.bytes ?? bytes.byteLength };
        },
        abort: () => enc.abort(),
      };
    },
    async finish() {
      const blob = await (opts.zip ?? buildZipBlob)(entries());
      await opts.save(blob, fileName);
    },
  };
}
