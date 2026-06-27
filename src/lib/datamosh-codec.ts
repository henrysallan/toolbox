// Codec datamosh — the "authentic" bitstream glitch, panel-side.
//
// Real datamoshing exploits inter-frame video compression: a P-frame stores
// only the MOTION (vectors + residual) from the previous frame. Delete the
// keyframe (I-frame) at a scene cut and the incoming clip's P-frames apply
// their motion to the OUTGOING clip's last pixels — one scene melts into the
// motion of another. Duplicating P-frames repeats motion → the "bloom".
//
// We do this with MPEG-4 Part 2 (ASP) inside an AVI container — the traditional
// datamosh codec, because AVI stores each frame as a discrete RIFF chunk and
// marks keyframes in its `idx1` index, so the surgery is plain byte work:
//
//   1. ffmpeg.wasm encodes the assembled A→B frame sequence to AVI, forcing a
//      keyframe at frame 0 and at the cut, and disabling extra keyframes.
//   2. We parse the AVI, classify each frame chunk (I vs P) from idx1, drop the
//      interior I-frame(s), optionally duplicate the incoming P-frames, and
//      rebuild the movi data + idx1 + frame counts.
//   3. ffmpeg.wasm decodes the moshed AVI back to PNG frames.
//
// This lives in src/lib (NOT engine/) because it imports ffmpeg — engine/ and
// nodes/ may not (invariant #1). The Datamosh node never touches this; the panel
// runs it and writes the result into the session store's output strip, which the
// node plays back like any baked strip. Best-effort: on any failure it throws a
// clear message and the user falls back to the Flow engine.

import { getFfmpeg } from "./export-ffmpeg";

export interface CodecMoshOptions {
  // Assembled input frames on the node-local timeline (A frames, then B frames
  // from the cut on). PNG blobs, all the same dimensions.
  frames: Blob[];
  fps: number;
  // Node-local frame index where clip B takes over — the keyframe we delete.
  cutIndex: number;
  // Delete interior I-frames so motion carries across the cut (the transition).
  removeIframes: boolean;
  // Repeat each incoming P-frame this many extra times (bloom). 0 = off.
  pframeDup: number;
  onProgress?: (label: string, fraction: number) => void;
}

// ── little-endian byte helpers ───────────────────────────────────────────────
function u32(b: Uint8Array, o: number): number {
  return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
}
function fourcc(b: Uint8Array, o: number): string {
  return String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
}
function writeU32(b: Uint8Array, o: number, v: number): void {
  b[o] = v & 0xff;
  b[o + 1] = (v >>> 8) & 0xff;
  b[o + 2] = (v >>> 16) & 0xff;
  b[o + 3] = (v >>> 24) & 0xff;
}
function ccBytes(cc: string): number[] {
  return [cc.charCodeAt(0), cc.charCodeAt(1), cc.charCodeAt(2), cc.charCodeAt(3)];
}
function isVideoCC(cc: string): boolean {
  const t = cc.slice(2);
  return t === "dc" || t === "db";
}

// Find the data offset of the first occurrence of a FOURCC within [start,end).
function findChunk(b: Uint8Array, cc: string, start: number, end: number): number {
  for (let p = start; p + 8 <= end; p++) {
    if (fourcc(b, p) === cc) return p;
  }
  return -1;
}

interface FrameChunk {
  cc: string;
  data: Uint8Array;
  key: boolean;
}

// Classify an MPEG-4 ASP frame from its VOP coding type (fallback when idx1 is
// absent). VOP start code 00 00 01 B6, then the 2-bit coding type (00 = I-VOP).
function vopIsKey(data: Uint8Array): boolean {
  for (let i = 0; i + 4 < data.length; i++) {
    if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1 && data[i + 3] === 0xb6) {
      return ((data[i + 4] >> 6) & 3) === 0;
    }
  }
  return false;
}

// Parse the encoded AVI → ordered video frame chunks + the byte range before
// `movi` (the headers we keep, with frame counts to be patched).
function parseAvi(b: Uint8Array): { prefix: Uint8Array; chunks: FrameChunk[] } {
  if (fourcc(b, 0) !== "RIFF" || fourcc(b, 8) !== "AVI ") {
    throw new Error("Encoder did not produce an AVI.");
  }
  let pos = 12;
  let moviStart = -1;
  let moviDataStart = -1;
  let moviEnd = -1;
  let idx1Start = -1;
  let idx1Size = 0;
  while (pos + 8 <= b.length) {
    const cc = fourcc(b, pos);
    const size = u32(b, pos + 4);
    if (cc === "LIST" && fourcc(b, pos + 8) === "movi") {
      moviStart = pos;
      moviDataStart = pos + 12;
      moviEnd = pos + 8 + size;
    } else if (cc === "idx1") {
      idx1Start = pos;
      idx1Size = size;
    }
    pos = pos + 8 + size + (size & 1);
  }
  if (moviStart < 0 || moviEnd < 0) throw new Error("AVI has no movi list.");

  // Collect video chunks in order.
  const raw: { cc: string; data: Uint8Array }[] = [];
  let p = moviDataStart;
  while (p + 8 <= moviEnd) {
    const cc = fourcc(b, p);
    const sz = u32(b, p + 4);
    if (cc !== "LIST" && isVideoCC(cc)) {
      raw.push({ cc, data: b.slice(p + 8, p + 8 + sz) });
    }
    p = p + 8 + sz + (sz & 1);
  }
  if (raw.length === 0) throw new Error("AVI movi list has no video frames.");

  // Keyframe flags from idx1 (matched to video chunks by order).
  const flags: number[] = [];
  if (idx1Start >= 0) {
    let q = idx1Start + 8;
    const end = idx1Start + 8 + idx1Size;
    while (q + 16 <= end) {
      if (isVideoCC(fourcc(b, q))) flags.push(u32(b, q + 4));
      q += 16;
    }
  }
  const chunks: FrameChunk[] = raw.map((c, i) => ({
    cc: c.cc,
    data: c.data,
    key: flags.length === raw.length ? (flags[i] & 0x10) !== 0 : vopIsKey(c.data),
  }));

  return { prefix: b.slice(0, moviStart), chunks };
}

// Patch dwTotalFrames (avih) and dwLength (vids strh) in the header prefix.
function patchFrameCounts(prefix: Uint8Array, frameCount: number): void {
  const avih = findChunk(prefix, "avih", 12, prefix.length);
  if (avih >= 0) writeU32(prefix, avih + 8 + 16, frameCount); // dwTotalFrames
  // The video stream header: a strh whose data begins with 'vids'.
  let s = 12;
  while (s >= 0 && s + 8 < prefix.length) {
    s = findChunk(prefix, "strh", s, prefix.length);
    if (s < 0) break;
    if (fourcc(prefix, s + 8) === "vids") {
      writeU32(prefix, s + 8 + 32, frameCount); // dwLength
      break;
    }
    s += 8;
  }
}

// Apply the mosh edit to the ordered frames.
function moshFrames(
  chunks: FrameChunk[],
  cutIndex: number,
  removeIframes: boolean,
  pframeDup: number
): FrameChunk[] {
  const out: FrameChunk[] = [];
  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i];
    // Drop interior I-frames so the previous content keeps moving across the cut.
    if (i > 0 && removeIframes && c.key) continue;
    // After dropping interior keyframes, only the very first frame stays a key.
    const key = i === 0 || (c.key && !removeIframes);
    out.push({ cc: c.cc, data: c.data, key });
    // Bloom: repeat incoming (post-cut) delta frames.
    if (pframeDup > 0 && i >= cutIndex && !key) {
      for (let d = 0; d < pframeDup; d++) {
        out.push({ cc: c.cc, data: c.data, key: false });
      }
    }
  }
  if (out.length === 0) throw new Error("Mosh removed every frame.");
  return out;
}

// Rebuild a valid AVI from the patched header prefix + edited frames.
function rebuildAvi(prefix: Uint8Array, frames: FrameChunk[]): Uint8Array {
  patchFrameCounts(prefix, frames.length);

  // movi chunk bytes + idx1 entries (offset base 4 = ffmpeg convention).
  const parts: Uint8Array[] = [];
  const idx = new Uint8Array(frames.length * 16);
  let offset = 4;
  let moviDataLen = 0;
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i];
    const sz = f.data.length;
    const head = new Uint8Array(8);
    head.set(ccBytes(f.cc), 0);
    writeU32(head, 4, sz);
    parts.push(head, f.data);
    const padded = sz + (sz & 1);
    if (sz & 1) parts.push(new Uint8Array(1));
    // idx1 entry
    const e = i * 16;
    idx.set(ccBytes(f.cc), e);
    writeU32(idx, e + 4, f.key ? 0x10 : 0);
    writeU32(idx, e + 8, offset);
    writeU32(idx, e + 12, sz);
    offset += 8 + padded;
    moviDataLen += 8 + padded;
  }

  // 'LIST' size + 'movi' + chunkbytes
  const moviHead = new Uint8Array(12);
  moviHead.set(ccBytes("LIST"), 0);
  writeU32(moviHead, 4, 4 + moviDataLen);
  moviHead.set(ccBytes("movi"), 8);

  const idx1Head = new Uint8Array(8);
  idx1Head.set(ccBytes("idx1"), 0);
  writeU32(idx1Head, 4, idx.length);

  // Concatenate prefix + movi + idx1.
  const total =
    prefix.length + moviHead.length + moviDataLen + idx1Head.length + idx.length;
  const outBuf = new Uint8Array(total);
  let w = 0;
  outBuf.set(prefix, w);
  w += prefix.length;
  outBuf.set(moviHead, w);
  w += moviHead.length;
  for (const part of parts) {
    outBuf.set(part, w);
    w += part.length;
  }
  outBuf.set(idx1Head, w);
  w += idx1Head.length;
  outBuf.set(idx, w);
  w += idx.length;

  // Fix the RIFF size (whole file minus the 8-byte RIFF header).
  writeU32(outBuf, 4, total - 8);
  return outBuf;
}

async function blobToBytes(b: Blob): Promise<Uint8Array> {
  return new Uint8Array(await b.arrayBuffer());
}

// Run the full encode → surgery → decode pipeline. Returns the moshed frames as
// PNG blobs (length may differ from the input — I-frame removal drops a frame,
// P-frame dup adds some).
export async function buildCodecMosh(opts: CodecMoshOptions): Promise<Blob[]> {
  const { frames, fps, cutIndex, removeIframes, pframeDup, onProgress } = opts;
  if (frames.length < 2) throw new Error("Need at least two frames to mosh.");
  const ffmpeg = await getFfmpeg((l, f) => onProgress?.(l, f * 0.1));

  const inNames: string[] = [];
  try {
    onProgress?.("Writing frames…", 0.12);
    for (let i = 0; i < frames.length; i++) {
      const name = `dmin_${String(i).padStart(6, "0")}.png`;
      await ffmpeg.writeFile(name, await blobToBytes(frames[i]));
      inNames.push(name);
    }

    // Encode → AVI. Keyframes only at frame 0 and the cut; no B-frames, no
    // scene-cut keyframes, huge GOP so nothing else inserts a keyframe.
    onProgress?.("Encoding…", 0.2);
    const cut = Math.max(1, Math.min(frames.length - 1, Math.round(cutIndex)));
    await ffmpeg.exec([
      "-framerate", String(fps),
      "-i", "dmin_%06d.png",
      "-c:v", "mpeg4",
      "-q:v", "2",
      "-g", "1000000",
      "-bf", "0",
      "-sc_threshold", "0",
      "-force_key_frames", `expr:eq(n,0)+eq(n,${cut})`,
      // MPEG-4 / yuv420p needs even dimensions.
      "-vf", "crop=trunc(iw/2)*2:trunc(ih/2)*2",
      "-pix_fmt", "yuv420p",
      "dm_src.avi",
    ]);

    const srcData = await ffmpeg.readFile("dm_src.avi");
    const srcBytes =
      srcData instanceof Uint8Array ? srcData : new TextEncoder().encode(srcData as string);

    onProgress?.("Moshing bitstream…", 0.55);
    const { prefix, chunks } = parseAvi(srcBytes);
    const edited = moshFrames(chunks, cut, removeIframes, Math.max(0, Math.round(pframeDup)));
    const moshed = rebuildAvi(prefix, edited);

    await ffmpeg.writeFile("dm_mosh.avi", moshed);

    // Decode the moshed AVI back to PNG frames.
    onProgress?.("Decoding…", 0.7);
    await ffmpeg.exec([
      "-i", "dm_mosh.avi",
      "-start_number", "0",
      "dmout_%06d.png",
    ]);

    // Read the decoded frames. We don't know the exact count up front (a flaky
    // decode could truncate), so probe until a read fails.
    const out: Blob[] = [];
    for (let i = 0; i < edited.length + 4; i++) {
      const name = `dmout_${String(i).padStart(6, "0")}.png`;
      let data: Uint8Array | string;
      try {
        data = await ffmpeg.readFile(name);
      } catch {
        break;
      }
      const bytes = data instanceof Uint8Array ? data : new TextEncoder().encode(data as string);
      if (bytes.byteLength === 0) break;
      const copy = new Uint8Array(bytes.byteLength);
      copy.set(bytes);
      out.push(new Blob([copy.buffer], { type: "image/png" }));
      void ffmpeg.deleteFile(name).catch(() => {});
    }
    if (out.length === 0) throw new Error("Moshed stream produced no frames.");
    onProgress?.("Done", 1);
    return out;
  } finally {
    // Best-effort FS cleanup so the next run starts clean.
    for (const n of inNames) void ffmpeg.deleteFile(n).catch(() => {});
    void ffmpeg.deleteFile("dm_src.avi").catch(() => {});
    void ffmpeg.deleteFile("dm_mosh.avi").catch(() => {});
  }
}
