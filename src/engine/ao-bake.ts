// =====================================================================
// UV-space ambient occlusion bake
// =====================================================================
//
// Rasterizes the mesh into a UV atlas, then at each covered texel shoots
// cosine-weighted hemisphere rays against the same mesh. Output is a
// grayscale image (white = open, black = occluded) whose UVs match the
// input — wire it into Material's ao_map (or any other image channel).
//
// Pure typed-array math, no three / no GL, so the check script can pin
// the concave-corner darkening without a GPU.

export type AoBakeInput = {
  // Per-vertex SoA. `normals` and `uvs` may be omitted (flat normals /
  // planar XY fallback). `index` omitted ⇒ non-indexed (triples).
  positions: Float32Array;
  normals?: Float32Array;
  uvs?: Float32Array;
  index?: ArrayLike<number> | null;
  vertexCount: number;
  resolution: number;
  samples: number;
  radius: number;
  seed: number;
  invertNormals?: boolean;
  // Output contrast: ao' = ao^gamma. 1 = linear, >1 crushes to dirt in
  // crevices. <1 lifts the floor.
  gamma?: number;
};

export type AoBakeResult = {
  width: number;
  height: number;
  // RGBA8, row 0 = v = 1 (canvas / engine image convention). RGB identical
  // (grayscale AO in R, which is what three's aoMap reads).
  pixels: Uint8ClampedArray;
};

const EPS = 1e-5;
const BIAS = 1e-4;
const DILATE = 2;

function hash01(x: number, y: number, k: number): number {
  let n = Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(k | 0, 1274126177);
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
}

function triCountOf(vertexCount: number, index: ArrayLike<number> | null | undefined): number {
  return index ? (index.length / 3) | 0 : (vertexCount / 3) | 0;
}

function triVert(index: ArrayLike<number> | null | undefined, t: number, k: number): number {
  return index ? index[t * 3 + k]! : t * 3 + k;
}

// -- AABB BVH over triangles ------------------------------------------

type BvhNode = {
  min: [number, number, number];
  max: [number, number, number];
  left?: BvhNode;
  right?: BvhNode;
  offset: number;
  count: number;
};

function buildBvh(
  positions: Float32Array,
  index: ArrayLike<number> | null | undefined,
  nTris: number
): { root: BvhNode | null; order: Uint32Array } {
  const order = new Uint32Array(nTris);
  for (let i = 0; i < nTris; i++) order[i] = i;
  if (nTris === 0) return { root: null, order };

  const centroid = (t: number, axis: number): number => {
    const a = triVert(index, t, 0);
    const b = triVert(index, t, 1);
    const c = triVert(index, t, 2);
    return (positions[a * 3 + axis]! + positions[b * 3 + axis]! + positions[c * 3 + axis]!) / 3;
  };

  const boundsOf = (start: number, count: number): BvhNode => {
    const min: [number, number, number] = [Infinity, Infinity, Infinity];
    const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < count; i++) {
      const t = order[start + i]!;
      for (let k = 0; k < 3; k++) {
        const v = triVert(index, t, k);
        for (let a = 0; a < 3; a++) {
          const p = positions[v * 3 + a]!;
          if (p < min[a]!) min[a] = p;
          if (p > max[a]!) max[a] = p;
        }
      }
    }
    return { min, max, offset: start, count };
  };

  const split = (node: BvhNode): void => {
    if (node.count <= 8) return;
    const ex = node.max[0] - node.min[0];
    const ey = node.max[1] - node.min[1];
    const ez = node.max[2] - node.min[2];
    const axis = ex >= ey && ex >= ez ? 0 : ey >= ez ? 1 : 2;
    const mid = (node.min[axis] + node.max[axis]) * 0.5;
    let lo = node.offset;
    let hi = node.offset + node.count - 1;
    while (lo <= hi) {
      if (centroid(order[lo]!, axis) <= mid) lo++;
      else {
        const tmp = order[lo]!;
        order[lo] = order[hi]!;
        order[hi] = tmp;
        hi--;
      }
    }
    const leftCount = lo - node.offset;
    if (leftCount === 0 || leftCount === node.count) return;
    node.left = boundsOf(node.offset, leftCount);
    node.right = boundsOf(lo, node.count - leftCount);
    split(node.left);
    split(node.right);
  };

  const root = boundsOf(0, nTris);
  split(root);
  return { root, order };
}

function rayAabb(
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  min: [number, number, number],
  max: [number, number, number],
  maxT: number
): boolean {
  let tmin = 0;
  let tmax = maxT;
  for (let a = 0; a < 3; a++) {
    const o = a === 0 ? ox : a === 1 ? oy : oz;
    const d = a === 0 ? dx : a === 1 ? dy : dz;
    const mn = min[a]!;
    const mx = max[a]!;
    if (Math.abs(d) < 1e-12) {
      if (o < mn || o > mx) return false;
      continue;
    }
    const inv = 1 / d;
    let t0 = (mn - o) * inv;
    let t1 = (mx - o) * inv;
    if (t0 > t1) {
      const tmp = t0;
      t0 = t1;
      t1 = tmp;
    }
    if (t0 > tmin) tmin = t0;
    if (t1 < tmax) tmax = t1;
    if (tmin > tmax) return false;
  }
  return true;
}

// Möller–Trumbore. Returns t in (EPS, maxT) or -1.
function rayTri(
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
  cx: number,
  cy: number,
  cz: number,
  maxT: number
): number {
  const e1x = bx - ax,
    e1y = by - ay,
    e1z = bz - az;
  const e2x = cx - ax,
    e2y = cy - ay,
    e2z = cz - az;
  const px = dy * e2z - dz * e2y;
  const py = dz * e2x - dx * e2z;
  const pz = dx * e2y - dy * e2x;
  const det = e1x * px + e1y * py + e1z * pz;
  if (det > -EPS && det < EPS) return -1;
  const inv = 1 / det;
  const tx = ox - ax,
    ty = oy - ay,
    tz = oz - az;
  const u = (tx * px + ty * py + tz * pz) * inv;
  if (u < 0 || u > 1) return -1;
  const qx = ty * e1z - tz * e1y;
  const qy = tz * e1x - tx * e1z;
  const qz = tx * e1y - ty * e1x;
  const v = (dx * qx + dy * qy + dz * qz) * inv;
  if (v < 0 || u + v > 1) return -1;
  const t = (e2x * qx + e2y * qy + e2z * qz) * inv;
  if (t <= EPS || t >= maxT) return -1;
  return t;
}

function occluded(
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  maxT: number,
  positions: Float32Array,
  index: ArrayLike<number> | null | undefined,
  root: BvhNode | null,
  order: Uint32Array,
  skipTri: number
): boolean {
  if (!root) return false;
  const stack: BvhNode[] = [root];
  while (stack.length) {
    const n = stack.pop()!;
    if (!rayAabb(ox, oy, oz, dx, dy, dz, n.min, n.max, maxT)) continue;
    if (n.left && n.right) {
      stack.push(n.left, n.right);
      continue;
    }
    for (let i = 0; i < n.count; i++) {
      const t = order[n.offset + i]!;
      if (t === skipTri) continue;
      const ia = triVert(index, t, 0);
      const ib = triVert(index, t, 1);
      const ic = triVert(index, t, 2);
      const hit = rayTri(
        ox,
        oy,
        oz,
        dx,
        dy,
        dz,
        positions[ia * 3]!,
        positions[ia * 3 + 1]!,
        positions[ia * 3 + 2]!,
        positions[ib * 3]!,
        positions[ib * 3 + 1]!,
        positions[ib * 3 + 2]!,
        positions[ic * 3]!,
        positions[ic * 3 + 1]!,
        positions[ic * 3 + 2]!,
        maxT
      );
      if (hit >= 0) return true;
    }
  }
  return false;
}

function cosineDir(
  nx: number,
  ny: number,
  nz: number,
  u1: number,
  u2: number
): [number, number, number] {
  // Tangent frame.
  let tx: number, ty: number, tz: number;
  if (Math.abs(nx) < 0.9) {
    tx = 0;
    ty = nz;
    tz = -ny;
  } else {
    tx = -nz;
    ty = 0;
    tz = nx;
  }
  const tlen = Math.hypot(tx, ty, tz) || 1;
  tx /= tlen;
  ty /= tlen;
  tz /= tlen;
  const bx = ny * tz - nz * ty;
  const by = nz * tx - nx * tz;
  const bz = nx * ty - ny * tx;
  const r = Math.sqrt(Math.max(0, u1));
  const phi = 2 * Math.PI * u2;
  const x = r * Math.cos(phi);
  const y = r * Math.sin(phi);
  const z = Math.sqrt(Math.max(0, 1 - u1));
  const dx = tx * x + bx * y + nx * z;
  const dy = ty * x + by * y + ny * z;
  const dz = tz * x + bz * y + nz * z;
  const len = Math.hypot(dx, dy, dz) || 1;
  return [dx / len, dy / len, dz / len];
}

function planarUv(
  positions: Float32Array,
  vertexCount: number
): Float32Array {
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (let i = 0; i < vertexCount; i++) {
    const x = positions[i * 3]!;
    const y = positions[i * 3 + 1]!;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  const sx = maxX - minX || 1;
  const sy = maxY - minY || 1;
  const uvs = new Float32Array(vertexCount * 2);
  for (let i = 0; i < vertexCount; i++) {
    uvs[i * 2] = (positions[i * 3]! - minX) / sx;
    uvs[i * 2 + 1] = (positions[i * 3 + 1]! - minY) / sy;
  }
  return uvs;
}

function faceNormal(
  positions: Float32Array,
  ia: number,
  ib: number,
  ic: number
): [number, number, number] {
  const ax = positions[ib * 3]! - positions[ia * 3]!;
  const ay = positions[ib * 3 + 1]! - positions[ia * 3 + 1]!;
  const az = positions[ib * 3 + 2]! - positions[ia * 3 + 2]!;
  const bx = positions[ic * 3]! - positions[ia * 3]!;
  const by = positions[ic * 3 + 1]! - positions[ia * 3 + 1]!;
  const bz = positions[ic * 3 + 2]! - positions[ia * 3 + 2]!;
  const nx = ay * bz - az * by;
  const ny = az * bx - ax * bz;
  const nz = ax * by - ay * bx;
  const len = Math.hypot(nx, ny, nz) || 1;
  return [nx / len, ny / len, nz / len];
}

export function bakeAmbientOcclusion(input: AoBakeInput): AoBakeResult {
  const res = Math.max(8, Math.min(1024, Math.round(input.resolution) || 256));
  const samples = Math.max(1, Math.min(64, Math.round(input.samples) || 16));
  const radius = Math.max(1e-4, input.radius);
  const gamma = input.gamma ?? 1;
  const invert = !!input.invertNormals;
  const positions = input.positions;
  const index = input.index ?? null;
  const nTris = triCountOf(input.vertexCount, index);
  const uvs = input.uvs && input.uvs.length >= input.vertexCount * 2
    ? input.uvs
    : planarUv(positions, input.vertexCount);
  const hasNrm = !!(input.normals && input.normals.length >= input.vertexCount * 3);

  const { root, order } = buildBvh(positions, index, nTris);

  // Per-texel world pos / normal / coverage. Row 0 = v = 1.
  const px = new Float32Array(res * res * 3);
  const pn = new Float32Array(res * res * 3);
  const cov = new Uint8Array(res * res);
  const triAt = new Int32Array(res * res);
  triAt.fill(-1);

  const writeTexel = (
    x: number,
    y: number,
    wx: number,
    wy: number,
    wz: number,
    nx: number,
    ny: number,
    nz: number,
    tri: number
  ) => {
    if (x < 0 || y < 0 || x >= res || y >= res) return;
    const i = y * res + x;
    cov[i] = 1;
    const o = i * 3;
    px[o] = wx;
    px[o + 1] = wy;
    px[o + 2] = wz;
    pn[o] = nx;
    pn[o + 1] = ny;
    pn[o + 2] = nz;
    triAt[i] = tri;
  };

  for (let t = 0; t < nTris; t++) {
    const ia = triVert(index, t, 0);
    const ib = triVert(index, t, 1);
    const ic = triVert(index, t, 2);
    const ua = uvs[ia * 2]!,
      va = uvs[ia * 2 + 1]!;
    const ub = uvs[ib * 2]!,
      vb = uvs[ib * 2 + 1]!;
    const uc = uvs[ic * 2]!,
      vc = uvs[ic * 2 + 1]!;
    // Canvas row 0 = v = 1.
    const ax = ua * (res - 1),
      ay = (1 - va) * (res - 1);
    const bx = ub * (res - 1),
      by = (1 - vb) * (res - 1);
    const cx = uc * (res - 1),
      cy = (1 - vc) * (res - 1);
    const minX = Math.max(0, Math.floor(Math.min(ax, bx, cx)));
    const maxX = Math.min(res - 1, Math.ceil(Math.max(ax, bx, cx)));
    const minY = Math.max(0, Math.floor(Math.min(ay, by, cy)));
    const maxY = Math.min(res - 1, Math.ceil(Math.max(ay, by, cy)));
    const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    if (Math.abs(area) < 1e-8) continue;
    const inv = 1 / area;
    const fn = faceNormal(positions, ia, ib, ic);
    let fnx = fn[0],
      fny = fn[1],
      fnz = fn[2];
    if (invert) {
      fnx = -fnx;
      fny = -fny;
      fnz = -fnz;
    }
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const px0 = x + 0.5;
        const py0 = y + 0.5;
        // Weight at A = area(PBC) / area(ABC), etc.
        const alpha = ((bx - px0) * (cy - py0) - (by - py0) * (cx - px0)) * inv;
        const beta = ((cx - px0) * (ay - py0) - (cy - py0) * (ax - px0)) * inv;
        const gamma = 1 - alpha - beta;
        if (alpha < -1e-4 || beta < -1e-4 || gamma < -1e-4) continue;
        const wx =
          positions[ia * 3]! * alpha +
          positions[ib * 3]! * beta +
          positions[ic * 3]! * gamma;
        const wy =
          positions[ia * 3 + 1]! * alpha +
          positions[ib * 3 + 1]! * beta +
          positions[ic * 3 + 1]! * gamma;
        const wz =
          positions[ia * 3 + 2]! * alpha +
          positions[ib * 3 + 2]! * beta +
          positions[ic * 3 + 2]! * gamma;
        let nx: number, ny: number, nz: number;
        if (hasNrm) {
          nx =
            input.normals![ia * 3]! * alpha +
            input.normals![ib * 3]! * beta +
            input.normals![ic * 3]! * gamma;
          ny =
            input.normals![ia * 3 + 1]! * alpha +
            input.normals![ib * 3 + 1]! * beta +
            input.normals![ic * 3 + 1]! * gamma;
          nz =
            input.normals![ia * 3 + 2]! * alpha +
            input.normals![ib * 3 + 2]! * beta +
            input.normals![ic * 3 + 2]! * gamma;
          const len = Math.hypot(nx, ny, nz) || 1;
          nx /= len;
          ny /= len;
          nz /= len;
          if (invert) {
            nx = -nx;
            ny = -ny;
            nz = -nz;
          }
        } else {
          nx = fnx;
          ny = fny;
          nz = fnz;
        }
        writeTexel(x, y, wx, wy, wz, nx, ny, nz, t);
      }
    }
  }

  // Dilate coverage so UV-island seams don't sample empty black.
  for (let pass = 0; pass < DILATE; pass++) {
    const next = new Uint8Array(cov);
    for (let y = 0; y < res; y++) {
      for (let x = 0; x < res; x++) {
        const i = y * res + x;
        if (cov[i]) continue;
        let found = -1;
        outer: for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue;
            const xx = x + dx,
              yy = y + dy;
            if (xx < 0 || yy < 0 || xx >= res || yy >= res) continue;
            const j = yy * res + xx;
            if (cov[j]) {
              found = j;
              break outer;
            }
          }
        }
        if (found >= 0) {
          next[i] = 1;
          px.copyWithin(i * 3, found * 3, found * 3 + 3);
          pn.copyWithin(i * 3, found * 3, found * 3 + 3);
          triAt[i] = triAt[found]!;
        }
      }
    }
    cov.set(next);
  }

  const pixels = new Uint8ClampedArray(res * res * 4);
  const seed = input.seed | 0;
  for (let y = 0; y < res; y++) {
    for (let x = 0; x < res; x++) {
      const i = y * res + x;
      const o = i * 4;
      if (!cov[i]) {
        pixels[o] = 255;
        pixels[o + 1] = 255;
        pixels[o + 2] = 255;
        pixels[o + 3] = 0;
        continue;
      }
      const ox = px[i * 3]!;
      const oy = px[i * 3 + 1]!;
      const oz = px[i * 3 + 2]!;
      const nx = pn[i * 3]!;
      const ny = pn[i * 3 + 1]!;
      const nz = pn[i * 3 + 2]!;
      const originX = ox + nx * BIAS;
      const originY = oy + ny * BIAS;
      const originZ = oz + nz * BIAS;
      let hits = 0;
      for (let s = 0; s < samples; s++) {
        const u1 = hash01(x, y, seed + s * 2);
        const u2 = hash01(x, y, seed + s * 2 + 1);
        const [dx, dy, dz] = cosineDir(nx, ny, nz, u1, u2);
        if (
          occluded(
            originX,
            originY,
            originZ,
            dx,
            dy,
            dz,
            radius,
            positions,
            index,
            root,
            order,
            triAt[i]!
          )
        ) {
          hits++;
        }
      }
      let ao = 1 - hits / samples;
      if (gamma !== 1) ao = Math.pow(Math.max(0, ao), gamma);
      const v = Math.round(Math.min(1, Math.max(0, ao)) * 255);
      pixels[o] = v;
      pixels[o + 1] = v;
      pixels[o + 2] = v;
      pixels[o + 3] = 255;
    }
  }

  return { width: res, height: res, pixels };
}
