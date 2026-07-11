// Parser for IRIDAS/Adobe `.cube` LUT files (1D and 3D).
//
// Format (whitespace/comment tolerant):
//   # comment
//   TITLE "name"
//   LUT_3D_SIZE 33            (or LUT_1D_SIZE 256)
//   DOMAIN_MIN 0 0 0          (optional, defaults to 0 0 0)
//   DOMAIN_MAX 1 1 1          (optional, defaults to 1 1 1)
//   <r> <g> <b>              ×  size³ (3D, RED fastest) or size (1D)
//
// 3D table ordering is RED-fastest then GREEN then BLUE, which matches the
// x→y→z layout WebGL2 `texImage3D` expects — so the parsed array can be
// uploaded directly.

export interface ParsedCubeLut {
  dim: 1 | 3;
  size: number;
  // Flat RGB triplets, length = size³·3 (3D) or size·3 (1D).
  data: Float32Array;
  domainMin: [number, number, number];
  domainMax: [number, number, number];
  title?: string;
}

export function parseCubeLut(text: string): ParsedCubeLut | null {
  let size = 0;
  let dim: 1 | 3 | 0 = 0;
  let title: string | undefined;
  const domainMin: [number, number, number] = [0, 0, 0];
  const domainMax: [number, number, number] = [1, 1, 1];
  // Collect data rows first; we can't size the typed array until we've seen
  // the LUT_xD_SIZE line (which may appear after some headers but always
  // before the data in valid files).
  const rows: number[] = [];

  const lines = text.split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;

    const upper = line.toUpperCase();
    if (upper.startsWith("TITLE")) {
      const m = line.match(/"([^"]*)"/);
      title = m ? m[1] : undefined;
      continue;
    }
    if (upper.startsWith("LUT_3D_SIZE")) {
      size = parseInt(line.split(/\s+/)[1] ?? "", 10);
      dim = 3;
      continue;
    }
    if (upper.startsWith("LUT_1D_SIZE")) {
      size = parseInt(line.split(/\s+/)[1] ?? "", 10);
      dim = 1;
      continue;
    }
    if (upper.startsWith("DOMAIN_MIN")) {
      const p = line.split(/\s+/).slice(1).map(Number);
      if (p.length >= 3) domainMin.splice(0, 3, p[0], p[1], p[2]);
      continue;
    }
    if (upper.startsWith("DOMAIN_MAX")) {
      const p = line.split(/\s+/).slice(1).map(Number);
      if (p.length >= 3) domainMax.splice(0, 3, p[0], p[1], p[2]);
      continue;
    }

    // Data row: three floats. Anything else is ignored.
    const parts = line.split(/\s+/);
    if (parts.length < 3) continue;
    const r = Number(parts[0]);
    const g = Number(parts[1]);
    const b = Number(parts[2]);
    if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) continue;
    rows.push(r, g, b);
  }

  if (!dim || !Number.isFinite(size) || size < 2) return null;
  const expected = (dim === 3 ? size * size * size : size) * 3;
  if (rows.length < expected) return null;

  return {
    dim,
    size,
    data: Float32Array.from(rows.slice(0, expected)),
    domainMin,
    domainMax,
    title,
  };
}

// Bake any parsed LUT into a flat size³ RGBA float array ready for
// `texImage3D` as RGBA16F (x=R fastest, y=G, z=B). Float (not 8-bit) so
// subtle grades don't band and LUT outputs > 1 survive. 1D LUTs are expanded
// into a 3D grid by applying each channel's curve independently — so the
// node only ever deals with a single 3D-texture sampling path.
export function lutToFloatVolume(
  lut: ParsedCubeLut,
  out3dSize = 33
): { size: number; data: Float32Array } {
  if (lut.dim === 3) {
    const n = lut.size;
    const data = new Float32Array(n * n * n * 4);
    for (let i = 0; i < n * n * n; i++) {
      data[i * 4 + 0] = lut.data[i * 3 + 0];
      data[i * 4 + 1] = lut.data[i * 3 + 1];
      data[i * 4 + 2] = lut.data[i * 3 + 2];
      data[i * 4 + 3] = 1;
    }
    return { size: n, data };
  }

  // 1D → 3D: sample the per-channel curves with linear interpolation.
  const n = out3dSize;
  const src = lut.size;
  const data = new Float32Array(n * n * n * 4);
  const sample = (channel: number, t: number): number => {
    const f = t * (src - 1);
    const i0 = Math.floor(f);
    const i1 = Math.min(src - 1, i0 + 1);
    const frac = f - i0;
    const a = lut.data[i0 * 3 + channel];
    const b = lut.data[i1 * 3 + channel];
    return a + (b - a) * frac;
  };
  let p = 0;
  for (let z = 0; z < n; z++) {
    const bv = sample(2, z / (n - 1));
    for (let y = 0; y < n; y++) {
      const gv = sample(1, y / (n - 1));
      for (let x = 0; x < n; x++) {
        const rv = sample(0, x / (n - 1));
        data[p++] = rv;
        data[p++] = gv;
        data[p++] = bv;
        data[p++] = 1;
      }
    }
  }
  return { size: n, data };
}
