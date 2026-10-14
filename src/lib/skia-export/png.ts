// A byte-exact PNG codec for exported Skia assets (Skia Bake's frames and
// sprite sheets, lib/skia-export/bake.ts). RGBA8 straight alpha in and out,
// row 0 = top: nothing on the way may premultiply, colour-manage or
// resample, so the device decodes exactly the bytes the engine rendered.
// (A 2D canvas's toBlob would premultiply in 8 bits — lossy on translucent
// pixels.) Deflate is the platform's CompressionStream("deflate"), which is
// zlib-framed, as PNG's IDAT wants: Chromium (editor, Electron) and Node ≥ 18
// both have it, so the editor, the CLI and the gates share this file.
//
// encodePng: 8-bit RGBA, non-interlaced, per-row adaptive filter (the
// minimum-sum-of-residuals pick libpng uses). decodePng reads what
// encodePng writes plus any 8-bit RGB / RGBA non-interlaced PNG (the gate
// decodes committed slots with it).

const SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(parts: Uint8Array[]): number {
  let c = 0xffffffff;
  for (const buf of parts) for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function u32(n: number): Uint8Array {
  return new Uint8Array([(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]);
}

function chunk(type: string, data: Uint8Array): Uint8Array[] {
  const t = new Uint8Array([...type].map((c) => c.charCodeAt(0)));
  return [u32(data.length), t, data, u32(crc32([t, data]))];
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

async function pipe(bytes: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  const writer = stream.writable.getWriter();
  const done = (async () => {
    const reader = stream.readable.getReader();
    for (;;) {
      const r = await reader.read();
      if (r.done) break;
      chunks.push(r.value as Uint8Array);
    }
  })();
  await writer.write(bytes as Uint8Array<ArrayBuffer>);
  await writer.close();
  await done;
  return concat(chunks);
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

// RGBA8 (width × height × 4 bytes, straight alpha, row 0 = top) → PNG bytes.
export async function encodePng(rgba: Uint8Array | Uint8ClampedArray, width: number, height: number): Promise<Uint8Array> {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error(`encodePng: bad size ${width}×${height}`);
  }
  const stride = width * 4;
  if (rgba.length < stride * height) throw new Error(`encodePng: ${rgba.length} bytes is less than ${width}×${height}×4`);
  const raw = new Uint8Array((stride + 1) * height);
  const cand = [0, 1, 2, 3, 4].map(() => new Uint8Array(stride));
  for (let y = 0; y < height; y++) {
    const row = y * stride;
    const prev = y > 0 ? row - stride : -1;
    let best = 0;
    let bestSum = Infinity;
    for (let f = 0; f < 5; f++) {
      const out = cand[f];
      let sum = 0;
      for (let i = 0; i < stride; i++) {
        const x = rgba[row + i];
        const a = i >= 4 ? rgba[row + i - 4] : 0;
        const b = prev >= 0 ? rgba[prev + i] : 0;
        const c = prev >= 0 && i >= 4 ? rgba[prev + i - 4] : 0;
        const v = f === 0 ? x : f === 1 ? x - a : f === 2 ? x - b : f === 3 ? x - ((a + b) >> 1) : x - paeth(a, b, c);
        const byte = v & 0xff;
        out[i] = byte;
        sum += byte < 128 ? byte : 256 - byte;
      }
      if (sum < bestSum) {
        bestSum = sum;
        best = f;
      }
    }
    raw[y * (stride + 1)] = best;
    raw.set(cand[best], y * (stride + 1) + 1);
  }
  const idat = await pipe(raw, new CompressionStream("deflate"));
  const ihdr = concat([u32(width), u32(height), new Uint8Array([8, 6, 0, 0, 0])]);
  return concat([SIGNATURE, ...chunk("IHDR", ihdr), ...chunk("IDAT", idat), ...chunk("IEND", new Uint8Array(0))]);
}

// PNG bytes → { width, height, rgba } (8-bit RGB / RGBA, non-interlaced).
export async function decodePng(png: Uint8Array): Promise<{ width: number; height: number; rgba: Uint8Array }> {
  for (let i = 0; i < 8; i++) if (png[i] !== SIGNATURE[i]) throw new Error("decodePng: not a PNG");
  const dv = new DataView(png.buffer, png.byteOffset, png.byteLength);
  let o = 8;
  let width = 0;
  let height = 0;
  let channels = 0;
  const idat: Uint8Array[] = [];
  while (o < png.length) {
    const len = dv.getUint32(o);
    const type = String.fromCharCode(png[o + 4], png[o + 5], png[o + 6], png[o + 7]);
    const data = png.subarray(o + 8, o + 8 + len);
    if (type === "IHDR") {
      width = dv.getUint32(o + 8);
      height = dv.getUint32(o + 12);
      const depth = data[8];
      const color = data[9];
      if (depth !== 8 || (color !== 2 && color !== 6) || data[12] !== 0) {
        throw new Error(`decodePng: only 8-bit RGB / RGBA non-interlaced PNGs (depth ${depth}, color type ${color}, interlace ${data[12]})`);
      }
      channels = color === 6 ? 4 : 3;
    } else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    o += 12 + len;
  }
  const raw = await pipe(concat(idat), new DecompressionStream("deflate"));
  const bpp = channels;
  const stride = width * bpp;
  const px = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const row = y * stride;
    for (let i = 0; i < stride; i++) {
      const x = raw[src + i];
      const a = i >= bpp ? px[row + i - bpp] : 0;
      const b = y > 0 ? px[row - stride + i] : 0;
      const c = y > 0 && i >= bpp ? px[row - stride + i - bpp] : 0;
      px[row + i] = (f === 0 ? x : f === 1 ? x + a : f === 2 ? x + b : f === 3 ? x + ((a + b) >> 1) : x + paeth(a, b, c)) & 0xff;
    }
  }
  if (channels === 4) return { width, height, rgba: px };
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0, j = 0; i < px.length; i += 3, j += 4) {
    rgba[j] = px[i];
    rgba[j + 1] = px[i + 1];
    rgba[j + 2] = px[i + 2];
    rgba[j + 3] = 255;
  }
  return { width, height, rgba };
}
