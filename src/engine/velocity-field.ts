// The velocity-field wire convention (spec 072526_flow-fields.md).
//
// A 2D velocity field travels on a wire as a plain IMAGE — no new socket
// type. The encoding is the one Perlin Noise's curl mode already emits and
// Displace / Advect Points' "vector" field mode already read:
//
//   R = 0.5 + vx * 0.5,  G = 0.5 + vy * 0.5      (midlevel 0.5 = at rest)
//   decode: v = 2 * (channel - 0.5)              → v ∈ [-1, 1] per axis
//
// Semantics every producer and consumer must agree on:
//   - v is Y-DOWN (positive vy = downward on screen), matching CPU
//     geometry space. GPU consumers advecting in Y-UP v_uv space step
//     `uv -= vec2(v.x, -v.y * aspect) * k` for a backward trace (content
//     flows ALONG +v) — the y sign flips at the GL boundary, exactly like
//     Displace's offset does.
//   - v is in ISOTROPIC canvas-width units: one unit of |v| covers the
//     same number of PIXELS on either axis. Steps therefore scale the
//     y component by aspect (= width/height) in normalized/uv space —
//     the Advect Points stepOnce convention. Producers must generate in
//     an aspect-corrected space (X = x, Y = y/aspect) so swirls stay
//     round on non-square canvases (invariant #4, decided explicitly).
//   - Magnitude is a normalized "full speed" [-1, 1], not physical px/s;
//     consumers apply their own distance/step dials. Encoding clamps to
//     [-1, 1] — a hard clamp technically breaks divergence-freeness where
//     it engages, so producers should scale strength to live inside it.
//   - B is unused (0) by VELOCITY producers, alpha 1. ORIENTATION fields
//     (orientation-field.ts, spec 082426) extend this convention by
//     carrying coherence/anisotropy in B — velocity consumers ignore it,
//     and a velocity field's B = 0 honestly reads as "no anisotropy" to
//     orientation consumers. The universal mask post-pass matting an
//     encoded field to transparent black decodes as v = (-1, -1) — don't
//     matte field images; matte the consumer's OUTPUT instead.
//
// Producers today: Perlin Noise (type "curl"), Spline Flow Field,
// Flow Obstacle (modifier), Image Flow Field (orientation), Vector Field
// (SDF / image → attract / repel / orbit / isoline). Consumers:
// Advect Image, Advect Points (field_mode "vector"), Displace (channels
// R/G, midlevel 0.5), Point Expression (`fieldX` / `fieldY` / `fieldAt`),
// Flow Blur (+ the painterly program as it lands).

// GLSL 300 es snippets — inline into a fragment shader's declarations.
export const VELOCITY_DECODE_GLSL = `
vec2 decodeVelocity(vec4 c) { return 2.0 * (c.rg - vec2(0.5)); }
`;

export const VELOCITY_ENCODE_GLSL = `
vec4 encodeVelocity(vec2 v) {
  return vec4(clamp(v, vec2(-1.0), vec2(1.0)) * 0.5 + 0.5, 0.0, 1.0);
}
`;

// The neutral (at rest) field color, for clearTarget on empty outputs.
export const VELOCITY_NEUTRAL: [number, number, number, number] = [
  0.5, 0.5, 0.0, 1.0,
];

// CPU bilinear sample of an encoded field. `data` is canvas ImageData
// order (row 0 = visual top = Y-DOWN), matching `readImagePixels` and
// point UVs. Writes decoded velocity (Y-DOWN, isotropic canvas-width
// units) into `out`. Used by Point Expression; Advect Points has its
// own copy in the integration loop (same math, different call shape).
export interface EncodedVelocityBuf {
  data: Uint8ClampedArray;
  w: number;
  h: number;
}

export function sampleEncodedVelocity(
  buf: EncodedVelocityBuf,
  u: number,
  v: number,
  out: [number, number],
  midlevel = 0.5
): void {
  const { data, w, h } = buf;
  let fx = u * w - 0.5;
  let fy = v * h - 0.5;
  if (fx < 0) fx = 0;
  else if (fx > w - 1) fx = w - 1;
  if (fy < 0) fy = 0;
  else if (fy > h - 1) fy = h - 1;
  const x0 = fx | 0;
  const y0 = fy | 0;
  const x1 = x0 < w - 1 ? x0 + 1 : x0;
  const y1 = y0 < h - 1 ? y0 + 1 : y0;
  const tx = fx - x0;
  const ty = fy - y0;
  const i00 = (y0 * w + x0) * 4;
  const i10 = (y0 * w + x1) * 4;
  const i01 = (y1 * w + x0) * 4;
  const i11 = (y1 * w + x1) * 4;
  const rA = data[i00] + (data[i10] - data[i00]) * tx;
  const rB = data[i01] + (data[i11] - data[i01]) * tx;
  const gA = data[i00 + 1] + (data[i10 + 1] - data[i00 + 1]) * tx;
  const gB = data[i01 + 1] + (data[i11 + 1] - data[i01 + 1]) * tx;
  out[0] = 2 * ((rA + (rB - rA) * ty) / 255 - midlevel);
  out[1] = 2 * ((gA + (gB - gA) * ty) / 255 - midlevel);
}
