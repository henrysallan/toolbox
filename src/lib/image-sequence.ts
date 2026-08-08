// Image-sequence loader for the Video Source node. Turns a multi-pick of
// numbered image files into an ImageSequenceParamValue: parse the trailing
// integer in each filename, sort by it, and keep the encoded bytes (the node
// decodes lazily). Gaps in the numbering are honored at playback (held
// frames) — see the node compute + specdocs/archive/061826_gif-export-and-image-sequence.md.

import type {
  ImageSequenceFrame,
  ImageSequenceParamValue,
} from "@/engine/types";
import {
  groupExrLayers,
  isExrBytes,
  isExrFilename,
  parseExrHeader,
} from "@/engine/exr";

// Last run of digits before the extension (or end of name).
// "shot_v2_0042.png" → 42; "frame007" → 7; "plate.0100.exr" → 100.
export function parseTrailingNumber(filename: string): number | null {
  const stem = filename.replace(/\.[^.]+$/, "");
  const m = stem.match(/(\d+)(?!.*\d)/);
  return m ? parseInt(m[1], 10) : null;
}

// Build a sequence value from picked files. Files without a trailing number
// are dropped (returned in `skipped` so the UI can warn). Throws if nothing
// usable remains.
export async function registerImageSequence(
  files: File[]
): Promise<{ value: ImageSequenceParamValue; skipped: string[] }> {
  const skipped: string[] = [];
  const frames: ImageSequenceFrame[] = [];
  for (const file of files) {
    const number = parseTrailingNumber(file.name);
    if (number == null) {
      skipped.push(file.name);
      continue;
    }
    frames.push({
      number,
      blob: file,
      filename: file.name,
      size: file.size,
    });
  }
  if (frames.length === 0) {
    throw new Error("No files with a trailing frame number were found.");
  }
  frames.sort((a, b) => a.number - b.number);

  const min = frames[0].number;
  const max = frames[frames.length - 1].number;

  // EXR sequences: header-parse the first frame (cheap, no pixel decode) for
  // dims + the grouped layer list that drives the node's layer dropdown.
  // Sniff by magic bytes with a filename fallback for empty reads.
  let exr: ImageSequenceParamValue["exr"];
  let width = 0;
  let height = 0;
  const firstBytes = await frames[0].blob
    .slice(0, 4)
    .arrayBuffer()
    .catch(() => null);
  if (
    (firstBytes && isExrBytes(firstBytes)) ||
    (!firstBytes && isExrFilename(frames[0].filename))
  ) {
    try {
      const header = parseExrHeader(await frames[0].blob.arrayBuffer());
      exr = { layers: groupExrLayers(header) };
      width = header.parts[0]?.width ?? 0;
      height = header.parts[0]?.height ?? 0;
    } catch (e) {
      console.warn("EXR sequence: first-frame header parse failed:", e);
    }
  } else {
    // Decode only the first frame to learn the sequence's dimensions.
    try {
      const bmp = await createImageBitmap(frames[0].blob);
      width = bmp.width;
      height = bmp.height;
      bmp.close();
    } catch {
      // Undecodable first frame — dims fall back to 0; the node will retry
      // decoding per-frame and clear to black until one lands.
    }
  }

  return {
    value: { frames, min, max, length: max - min + 1, width, height, exr },
    skipped,
  };
}
