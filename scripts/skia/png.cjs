// Minimal PNG codec for the Skia parity tools (compare:skia, parity:skia,
// skia-device-parity). RGBA8 in, RGBA8 out, byte-exact: the goldens and the
// device frames are compared at 0/255 tolerance, so nothing in between may
// premultiply, colour-manage or resample. Electron's nativeImage does
// (it treats bitmaps as premultiplied BGRA), and plain Node has no codec.
//
// encodePng writes 8-bit RGBA, non-interlaced, with a per-row adaptive
// filter (libpng's minimum-sum-of-residuals pick), deflate level 9.
// decodePng reads 8-bit greyscale / grey+alpha / RGB / RGBA / palette PNGs,
// non-interlaced, all five filters; anything else throws (16-bit and Adam7
// images are not something these tools write or expect).
//
// CommonJS so the Electron main-process entries can require() it and the
// .mjs device driver can import it.
/* eslint-disable @typescript-eslint/no-require-imports */
const zlib = require("node:zlib");

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

/**
 * @param {Uint8Array} rgba width*height*4 bytes, row 0 = top, straight alpha
 * @param {number} width
 * @param {number} height
 * @returns {Buffer}
 */
function encodePng(rgba, width, height) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error(`encodePng: bad size ${width}×${height}`);
  }
  const stride = width * 4;
  if (rgba.length < stride * height) {
    throw new Error(`encodePng: ${rgba.length} bytes is less than ${width}×${height}×4`);
  }
  const raw = Buffer.alloc((stride + 1) * height);
  const cand = [0, 1, 2, 3, 4].map(() => Buffer.alloc(stride));
  for (let y = 0; y < height; y++) {
    const row = rgba.subarray(y * stride, y * stride + stride);
    const up = y > 0 ? rgba.subarray((y - 1) * stride, y * stride) : null;
    // All five filters; keep the one with the smallest sum of |signed
    // residual| (libpng's heuristic) — smooth fields deflate far better.
    let best = 0;
    let bestCost = Infinity;
    for (let f = 0; f < 5; f++) {
      const out = cand[f];
      let cost = 0;
      for (let x = 0; x < stride; x++) {
        const a = x >= 4 ? row[x - 4] : 0;
        const b = up ? up[x] : 0;
        const c = up && x >= 4 ? up[x - 4] : 0;
        const pred = f === 0 ? 0 : f === 1 ? a : f === 2 ? b : f === 3 ? (a + b) >> 1 : paeth(a, b, c);
        const v = (row[x] - pred) & 0xff;
        out[x] = v;
        cost += v < 128 ? v : 256 - v;
      }
      if (cost < bestCost) {
        bestCost = cost;
        best = f;
      }
    }
    const o = y * (stride + 1);
    raw[o] = best;
    cand[best].copy(raw, o + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // filter method 0
  ihdr[12] = 0; // no interlace
  return Buffer.concat([
    SIGNATURE,
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/**
 * @param {Uint8Array} buf PNG file bytes
 * @returns {{ width: number, height: number, rgba: Uint8Array }}
 */
function decodePng(buf) {
  const b = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
  if (b.length < 8 || !b.subarray(0, 8).equals(SIGNATURE)) throw new Error("decodePng: not a PNG");
  let off = 8;
  let width = 0;
  let height = 0;
  let depth = 0;
  let ctype = 0;
  let interlace = 0;
  let palette = null;
  let trns = null;
  const idat = [];
  while (off + 8 <= b.length) {
    const len = b.readUInt32BE(off);
    const type = b.toString("ascii", off + 4, off + 8);
    const data = b.subarray(off + 8, off + 8 + len);
    off += 12 + len;
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      depth = data[8];
      ctype = data[9];
      interlace = data[12];
    } else if (type === "PLTE") palette = data;
    else if (type === "tRNS") trns = data;
    else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
  }
  if (!width || !height) throw new Error("decodePng: no IHDR");
  if (depth !== 8) throw new Error(`decodePng: ${depth}-bit PNGs are not supported (8-bit only)`);
  if (interlace !== 0) throw new Error("decodePng: interlaced PNGs are not supported");
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[ctype];
  if (!channels) throw new Error(`decodePng: colour type ${ctype} is not supported`);
  const bpp = channels;
  const stride = width * bpp;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  if (raw.length < (stride + 1) * height) throw new Error("decodePng: truncated image data");
  const px = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? px[dst + x - bpp] : 0;
      const up = y > 0 ? px[dst - stride + x] : 0;
      const c = x >= bpp && y > 0 ? px[dst - stride + x - bpp] : 0;
      const v = raw[src + x];
      let out;
      if (f === 0) out = v;
      else if (f === 1) out = v + a;
      else if (f === 2) out = v + up;
      else if (f === 3) out = v + ((a + up) >> 1);
      else if (f === 4) out = v + paeth(a, up, c);
      else throw new Error(`decodePng: bad filter ${f} on row ${y}`);
      px[dst + x] = out & 0xff;
    }
  }
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const o = i * 4;
    if (ctype === 6) {
      rgba[o] = px[i * 4];
      rgba[o + 1] = px[i * 4 + 1];
      rgba[o + 2] = px[i * 4 + 2];
      rgba[o + 3] = px[i * 4 + 3];
    } else if (ctype === 2) {
      rgba[o] = px[i * 3];
      rgba[o + 1] = px[i * 3 + 1];
      rgba[o + 2] = px[i * 3 + 2];
      rgba[o + 3] = 255;
    } else if (ctype === 0) {
      rgba[o] = rgba[o + 1] = rgba[o + 2] = px[i];
      rgba[o + 3] = 255;
    } else if (ctype === 4) {
      rgba[o] = rgba[o + 1] = rgba[o + 2] = px[i * 2];
      rgba[o + 3] = px[i * 2 + 1];
    } else {
      if (!palette) throw new Error("decodePng: palette image without PLTE");
      const k = px[i];
      rgba[o] = palette[k * 3];
      rgba[o + 1] = palette[k * 3 + 1];
      rgba[o + 2] = palette[k * 3 + 2];
      rgba[o + 3] = trns && k < trns.length ? trns[k] : 255;
    }
  }
  return { width, height, rgba };
}

module.exports = { encodePng, decodePng };
