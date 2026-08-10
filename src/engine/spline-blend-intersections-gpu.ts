// GPU field evaluation for Blend Intersections — a fragment-shader port of
// evaluateFieldCpu in spline-blend-intersections.ts. ONLY the SDF sample
// loop moves to the GPU; marching squares, contour cleanup and the bezier
// fit stay on the CPU, consuming the same Float32Array grid.
// Spec: specdocs/080826_blend-intersections-gpu.md.
//
// THE CPU LOOP IS THE SPEC. The shader must produce its per-sample values —
// branch identity (which ordinal runs are near this point) is per-sample and
// cannot be precomputed or expressed as per-branch draws. The one
// unavoidable divergence is fp32 vs fp64 arithmetic; the equivalence gate
// (npm run check:blend-gpu) holds it to <1e-3 px on the bench corpus.
//
// WHY THE SHADER STREAMS CANDIDATES instead of transcribing the CPU's
// sort-then-split: the CPU stores every surviving candidate, sorts by
// (subpath, ordinal) and splits at ordinal gaps. Storing candidates needs a
// fixed-size local array, and the measured per-sample maximum is far beyond
// any sane register budget — 34 on the 100-anchor bench corpus, 276 on the
// bench:nodes 8-lobe network, 424 with blend 120 (duplicates included; the
// GPU gather has no stamp-dedup). So the shader instead keeps only the
// BRANCHES — (subpath, ordinal-interval, min distance) — and merges each
// candidate into them incrementally, bridging two branches when a candidate
// closes the gap between their intervals. This yields the IDENTICAL result:
// branch intervals of one subpath always sit > BRANCH_GAP apart (else they'd
// have merged), members of a branch always chain with gaps ≤ BRANCH_GAP, so
// "ord within [min−GAP, max+GAP]" is exactly "within GAP of some member" —
// the same transitive partition the CPU's sorted-adjacency scan builds, and
// per-branch minima are order-independent. Verified BIT-EXACT against
// evaluateFieldCpu in fp64 over ~3.3M samples (incl. seam wraps) before
// this was committed to GLSL; the live gate re-checks it at fp32 tolerance.
// Max branches ever held: 26 (8-lobe network), 59 (blend 120 stress) —
// MAX_BRANCH=64 covers that, and an overflow is DETECTED (G channel) and
// falls back to the CPU, never silently truncated.
//
// Other deliberate divergences from the CPU loop, with why they're safe:
// - No stamp-dedup on the 3×3 bucket gather: a segment spanning two buckets
//   is visited twice. Duplicates carry the same (subpath, ordinal), land in
//   the same branch, and min(d, d) = d.
// - No m==1 cheap exit: a single surviving candidate means a single branch,
//   and a one-branch fold IS its min distance — same value, no branch taken.
//
// Failure policy is bail-over-clamp: any setup/compile/overflow problem
// returns null and the caller runs the CPU reference. A wrong-but-fast
// field is never acceptable here.

import type { BlendFieldJob } from "./spline-blend-intersections";

// The narrow slice of RenderContext the GPU path needs. Deliberately not
// RenderContext itself — src/engine must stay importable without the app
// shell, and the equivalence harness constructs this from a bare context.
export interface BlendFieldGpuContext {
  gl: WebGL2RenderingContext;
  getShader(key: string, fragSrc: string): WebGLProgram;
}

// Max concurrent branches one sample can hold (see header for measurements).
export const MAX_BRANCH = 64;

// getShader cache key. Bump the suffix on ANY source change — the engine
// caches by key alone, so a refactored source under the old key would
// serve a stale program (same rule as merge/blend-v3).
export const BLEND_FIELD_SHADER_KEY = "blend-intersections/field-v1";

// 2D layout width for the segment/candidate data textures. 1024 keeps
// every realistic job inside a WebGL2 minimum-spec texture (rows grow
// with count; 1024×1024 = 1M texels ≫ the few thousand we need).
const DATA_TEX_W = 1024;

export const BLEND_FIELD_FS = `#version 300 es
precision highp float;
precision highp int;

// One fragment per field sample. Semantics transcribed from
// evaluateFieldCpu — keep the two in lockstep (npm run check:blend-gpu
// compares them to <1e-3 px).
uniform sampler2D u_segs;    // RGBA32F, one texel/segment: x0,y0,x1,y1 (canvas px)
uniform sampler2D u_meta;    // RGBA32F, one texel/segment: sub, ord, subSegCount, closed
uniform sampler2D u_buckets; // RG32F, bCols×bRows: (start, count) into u_cand
uniform sampler2D u_cand;    // R32F: segment index per candidate slot

uniform vec2 u_origin;       // bx0, by0
uniform float u_cell;
uniform float u_bucket;
uniform ivec2 u_bDims;       // bCols, bRows
uniform float u_influence;
uniform float u_influenceSq;
uniform float u_r;
uniform float u_k;
uniform float u_farSlack;

out vec4 outColor;           // R = field value, G = branch-cap overflows

const int MAX_BRANCH = ${MAX_BRANCH};
const int BRANCH_GAP = 8;

float sminQ(float a, float b, float k) {
  if (k <= 0.0) return min(a, b);
  float h = max(k - abs(a - b), 0.0) / k;
  return min(a, b) - h * h * k * 0.25;
}

vec4 fetch2D(sampler2D tex, int idx) {
  int w = textureSize(tex, 0).x;
  return texelFetch(tex, ivec2(idx % w, idx / w), 0);
}

void main() {
  int gx = int(gl_FragCoord.x);
  int gy = int(gl_FragCoord.y);
  float px = u_origin.x + float(gx) * u_cell;
  float py = u_origin.y + float(gy) * u_cell;
  vec2 p = vec2(px, py);

  int cx = clamp(int(floor((px - u_origin.x) / u_bucket)), 0, u_bDims.x - 1);
  int cy = clamp(int(floor((py - u_origin.y) / u_bucket)), 0, u_bDims.y - 1);

  // Branch accumulators. brNC packs subSegCount with the closed flag in
  // its sign (count ≥ 1 always, so the sign is a free boolean channel).
  int brSub[MAX_BRANCH];
  int brMin[MAX_BRANCH];
  int brMax[MAX_BRANCH];
  int brNC[MAX_BRANCH];
  float brDist[MAX_BRANCH];
  int bn = 0;
  int overflow = 0;
  float minD = 1e30;
  bool hasCand = false;

  // Gather the 3×3 bucket neighborhood, cull at the influence radius,
  // and merge each survivor into the branch set as it streams past.
  for (int ny = cy - 1; ny <= cy + 1; ny++) {
    if (ny < 0 || ny >= u_bDims.y) continue;
    for (int nx = cx - 1; nx <= cx + 1; nx++) {
      if (nx < 0 || nx >= u_bDims.x) continue;
      vec2 sc = texelFetch(u_buckets, ivec2(nx, ny), 0).rg;
      int start = int(sc.x);
      int count = int(sc.y);
      for (int c = 0; c < count; c++) {
        int si = int(fetch2D(u_cand, start + c).r);
        vec4 seg = fetch2D(u_segs, si);
        // segDistSq, transcribed.
        vec2 dv = seg.zw - seg.xy;
        float len2 = dot(dv, dv);
        float t = 0.0;
        if (len2 > 1e-12) {
          t = clamp(dot(p - seg.xy, dv) / len2, 0.0, 1.0);
        }
        vec2 e = p - (seg.xy + dv * t);
        float d2 = dot(e, e);
        if (d2 > u_influenceSq) continue;
        float dist = sqrt(d2);
        hasCand = true;
        if (dist < minD) minD = dist;

        vec4 meta = fetch2D(u_meta, si);
        int sub = int(meta.x);
        int ord = int(meta.y);
        int found = -1;
        for (int b = 0; b < bn; b++) {
          if (brSub[b] != sub) continue;
          if (ord < brMin[b] - BRANCH_GAP || ord > brMax[b] + BRANCH_GAP) continue;
          if (found < 0) {
            brMin[b] = min(brMin[b], ord);
            brMax[b] = max(brMax[b], ord);
            brDist[b] = min(brDist[b], dist);
            found = b;
          } else {
            // This candidate bridges two branches — fold b into found and
            // compact (move the tail entry down, re-examine that slot).
            brMin[found] = min(brMin[found], brMin[b]);
            brMax[found] = max(brMax[found], brMax[b]);
            brDist[found] = min(brDist[found], brDist[b]);
            bn--;
            brSub[b] = brSub[bn];
            brMin[b] = brMin[bn];
            brMax[b] = brMax[bn];
            brNC[b] = brNC[bn];
            brDist[b] = brDist[bn];
            b--;
          }
        }
        if (found < 0) {
          if (bn >= MAX_BRANCH) {
            overflow++;
          } else {
            brSub[bn] = sub;
            brMin[bn] = ord;
            brMax[bn] = ord;
            brNC[bn] = meta.w > 0.5 ? int(meta.z) : -int(meta.z);
            brDist[bn] = dist;
            bn++;
          }
        }
      }
    }
  }

  if (!hasCand) {
    outColor = vec4(u_influence, float(overflow), 0.0, 1.0);
    return;
  }
  if (minD - u_r > u_farSlack) {
    // Beyond farSlack the smooth-min deepening can't move the iso —
    // nearest distance is the CPU's answer here too.
    outColor = vec4(minD - u_r, float(overflow), 0.0, 1.0);
    return;
  }

  // Seam-wrap merge: a closed subpath whose candidate runs touch both ends
  // of its ordinal range gets its first and last branches folded into one.
  // Tombstone the folded branch (brSub = -1) rather than compacting, so
  // the outer scan's bookkeeping stays trivial.
  for (int a = 0; a < bn; a++) {
    if (brSub[a] < 0 || brNC[a] <= 0) continue;
    bool isFirst = true;
    int last = a;
    int cnt = 1;
    for (int b = 0; b < bn; b++) {
      if (b == a || brSub[b] != brSub[a]) continue;
      cnt++;
      if (brMin[b] < brMin[a]) {
        isFirst = false;
        break;
      }
      if (brMax[b] > brMax[last]) last = b;
    }
    if (!isFirst || cnt < 2) continue;
    int wrapGap = brMin[a] + (brNC[a] - 1 - brMax[last]);
    if (wrapGap <= BRANCH_GAP) {
      brDist[a] = min(brDist[a], brDist[last]);
      brSub[last] = -1;
    }
  }

  // Ascending fold for a deterministic smooth-min (same as the CPU).
  float dists[MAX_BRANCH];
  int dn = 0;
  for (int b = 0; b < bn; b++) {
    if (brSub[b] >= 0) {
      dists[dn] = brDist[b];
      dn++;
    }
  }
  for (int i = 1; i < dn; i++) {
    float v = dists[i];
    int j = i - 1;
    while (j >= 0 && dists[j] > v) {
      dists[j + 1] = dists[j];
      j--;
    }
    dists[j + 1] = v;
  }
  float acc = dists[0];
  for (int i = 1; i < dn; i++) {
    acc = sminQ(acc, dists[i], u_k);
  }
  outColor = vec4(acc - u_r, float(overflow), 0.0, 1.0);
}
`;

// ---- CPU-side packing --------------------------------------------------

export interface PackedFieldJob {
  segTexels: Float32Array; // segCount RGBA texels: x0,y0,x1,y1
  metaTexels: Float32Array; // segCount RGBA texels: sub, ord, n, closed
  segRows: number;
  bucketTexels: Float32Array; // bCols*bRows RG texels: start, count
  candTexels: Float32Array; // candCount R texels: segment index
  candRows: number;
  candCount: number;
  dataW: number;
}

// Flatten a BlendFieldJob into texture-ready arrays. Pure — shared by the
// live path and the check:blend-gpu harness so the packing itself is under
// the equivalence gate. This is where fp64 segment coordinates round to
// fp32 (Float32Array assignment), the GPU path's accepted divergence.
export function packFieldJob(job: BlendFieldJob): PackedFieldJob {
  const { segCount, bCols, bRows, buckets } = job;

  const segRows = Math.max(1, Math.ceil(segCount / DATA_TEX_W));
  const segTexels = new Float32Array(DATA_TEX_W * segRows * 4);
  const metaTexels = new Float32Array(DATA_TEX_W * segRows * 4);
  for (let i = 0; i < segCount; i++) {
    segTexels[i * 4] = job.segX0[i];
    segTexels[i * 4 + 1] = job.segY0[i];
    segTexels[i * 4 + 2] = job.segX1[i];
    segTexels[i * 4 + 3] = job.segY1[i];
    const sub = job.segSub[i];
    metaTexels[i * 4] = sub;
    metaTexels[i * 4 + 1] = job.segOrd[i];
    metaTexels[i * 4 + 2] = job.subSegCount[sub];
    metaTexels[i * 4 + 3] = job.subClosed[sub] ? 1 : 0;
  }

  // Flatten the bucket map into (start, count) + one concatenated
  // candidate-index list, in bucket-scan order. Within-bucket order is the
  // CPU's insertion order (ascending segment index); the branch merge is
  // order-independent, so gather order only affects nothing observable.
  let candCount = 0;
  for (const list of buckets.values()) candCount += list.length;
  const bucketTexels = new Float32Array(bCols * bRows * 2);
  const candRows = Math.max(1, Math.ceil(candCount / DATA_TEX_W));
  const candTexels = new Float32Array(DATA_TEX_W * candRows);
  let cursor = 0;
  for (let b = 0; b < bCols * bRows; b++) {
    const list = buckets.get(b);
    bucketTexels[b * 2] = cursor;
    bucketTexels[b * 2 + 1] = list ? list.length : 0;
    if (list) {
      for (let i = 0; i < list.length; i++) candTexels[cursor + i] = list[i];
      cursor += list.length;
    }
  }

  return {
    segTexels,
    metaTexels,
    segRows,
    bucketTexels,
    candTexels,
    candRows,
    candCount,
    dataW: DATA_TEX_W,
  };
}

// ---- GL plumbing -------------------------------------------------------

interface GpuState {
  failed: boolean; // sticky: probe/compile/framebuffer failure — stop trying
  warned: boolean;
  vao: WebGLVertexArrayObject;
  fbo: WebGLFramebuffer;
  texSegs: WebGLTexture;
  texMeta: WebGLTexture;
  texBuckets: WebGLTexture;
  texCand: WebGLTexture;
  outTex: WebGLTexture;
  outW: number;
  outH: number;
  readBuf: Float32Array | null;
  maxTexSize: number;
}

const stateByGl = new WeakMap<WebGL2RenderingContext, GpuState>();

// Manual A/B override for live comparison (flipped from the console via
// window.__perf — see lib/perf-console.ts). While true, evaluateFieldGpu
// returns null and every call runs the CPU reference.
let forceCpu = false;
export function setBlendFieldForceCpu(v: boolean): void {
  forceCpu = v;
}
export function getBlendFieldForceCpu(): boolean {
  return forceCpu;
}

function dataTexture(gl: WebGL2RenderingContext): WebGLTexture {
  const tex = gl.createTexture();
  if (!tex) throw new Error("createTexture failed");
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return tex;
}

function ensureState(gl: WebGL2RenderingContext): GpuState | null {
  const existing = stateByGl.get(gl);
  if (existing) return existing.failed ? null : existing;

  try {
    // RGBA32F rendering + FLOAT readback both hang off this extension. The
    // engine probes it too, but for RGBA16F — the field needs full fp32
    // (an 8-bit fallback is NOT a usable signed distance field; do not add
    // one).
    if (!gl.getExtension("EXT_color_buffer_float")) {
      console.warn(
        "blend-intersections: EXT_color_buffer_float unavailable — GPU field disabled, using CPU"
      );
      stateByGl.set(gl, { failed: true } as GpuState);
      return null;
    }
    const vao = gl.createVertexArray();
    const fbo = gl.createFramebuffer();
    if (!vao || !fbo) throw new Error("vao/fbo alloc failed");
    const state: GpuState = {
      failed: false,
      warned: false,
      vao,
      fbo,
      texSegs: dataTexture(gl),
      texMeta: dataTexture(gl),
      texBuckets: dataTexture(gl),
      texCand: dataTexture(gl),
      outTex: dataTexture(gl),
      outW: 0,
      outH: 0,
      readBuf: null,
      maxTexSize: gl.getParameter(gl.MAX_TEXTURE_SIZE) as number,
    };
    stateByGl.set(gl, state);
    return state;
  } catch (err) {
    console.warn("blend-intersections: GPU field setup failed, using CPU:", err);
    stateByGl.set(gl, { failed: true } as GpuState);
    return null;
  }
}

// Evaluate the field on the GPU. Returns the gw×gh grid, or null when the
// GPU path can't run faithfully (caller falls back to evaluateFieldCpu).
export function evaluateFieldGpu(
  ctx: BlendFieldGpuContext,
  job: BlendFieldJob
): Float32Array | null {
  if (forceCpu) return null;
  const { gl } = ctx;
  const state = ensureState(gl);
  if (!state) return null;

  try {
    let program: WebGLProgram;
    try {
      program = ctx.getShader(BLEND_FIELD_SHADER_KEY, BLEND_FIELD_FS);
    } catch (err) {
      state.failed = true;
      console.warn(
        "blend-intersections: field shader failed to compile — using CPU:",
        err
      );
      return null;
    }

    const packed = packFieldJob(job);
    const { gw, gh } = job;
    if (
      packed.segRows > state.maxTexSize ||
      packed.candRows > state.maxTexSize ||
      job.bCols > state.maxTexSize ||
      job.bRows > state.maxTexSize ||
      gw > state.maxTexSize ||
      gh > state.maxTexSize
    ) {
      // Not sticky — a pathological frame shouldn't disable the path forever.
      return null;
    }

    // ---- Upload. Data changes every call (the node only recomputes when
    // geometry moved), so plain respecifying texImage2D is the simplest
    // correct thing; these are a few thousand texels.
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.bindTexture(gl.TEXTURE_2D, state.texSegs);
    gl.texImage2D(
      gl.TEXTURE_2D, 0, gl.RGBA32F, packed.dataW, packed.segRows, 0,
      gl.RGBA, gl.FLOAT, packed.segTexels
    );
    gl.bindTexture(gl.TEXTURE_2D, state.texMeta);
    gl.texImage2D(
      gl.TEXTURE_2D, 0, gl.RGBA32F, packed.dataW, packed.segRows, 0,
      gl.RGBA, gl.FLOAT, packed.metaTexels
    );
    gl.bindTexture(gl.TEXTURE_2D, state.texBuckets);
    gl.texImage2D(
      gl.TEXTURE_2D, 0, gl.RG32F, job.bCols, job.bRows, 0,
      gl.RG, gl.FLOAT, packed.bucketTexels
    );
    gl.bindTexture(gl.TEXTURE_2D, state.texCand);
    gl.texImage2D(
      gl.TEXTURE_2D, 0, gl.R32F, packed.dataW, packed.candRows, 0,
      gl.RED, gl.FLOAT, packed.candTexels
    );

    // ---- Output target (RGBA32F so readPixels(FLOAT) is portable —
    // plain R32F readback is not universally supported).
    if (state.outW !== gw || state.outH !== gh) {
      gl.bindTexture(gl.TEXTURE_2D, state.outTex);
      gl.texImage2D(
        gl.TEXTURE_2D, 0, gl.RGBA32F, gw, gh, 0, gl.RGBA, gl.FLOAT, null
      );
      state.outW = gw;
      state.outH = gh;
    }
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, state.fbo);
    gl.framebufferTexture2D(
      gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, state.outTex, 0
    );
    if (
      gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE
    ) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      state.failed = true;
      console.warn(
        "blend-intersections: RGBA32F framebuffer incomplete — GPU field disabled, using CPU"
      );
      return null;
    }

    // ---- Draw one fullscreen triangle over the gw×gh grid.
    gl.viewport(0, 0, gw, gh);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    gl.disable(gl.SCISSOR_TEST);
    gl.useProgram(program);
    gl.bindVertexArray(state.vao);
    const u1f = (name: string, v: number) =>
      gl.uniform1f(gl.getUniformLocation(program, name), v);
    gl.uniform2f(gl.getUniformLocation(program, "u_origin"), job.bx0, job.by0);
    u1f("u_cell", job.cell);
    u1f("u_bucket", job.bucket);
    gl.uniform2i(
      gl.getUniformLocation(program, "u_bDims"), job.bCols, job.bRows
    );
    u1f("u_influence", job.influence);
    u1f("u_influenceSq", job.influenceSq);
    u1f("u_r", job.r);
    u1f("u_k", job.k);
    u1f("u_farSlack", job.farSlack);
    const bindTex = (name: string, unit: number, tex: WebGLTexture) => {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.uniform1i(gl.getUniformLocation(program, name), unit);
    };
    bindTex("u_segs", 0, state.texSegs);
    bindTex("u_meta", 1, state.texMeta);
    bindTex("u_buckets", 2, state.texBuckets);
    bindTex("u_cand", 3, state.texCand);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);

    // ---- Synchronous readback. ~320² RGBA32F ≈ 1.6 MB — well under a ms,
    // cheap against the ~11 ms of CPU field loop it replaces.
    if (!state.readBuf || state.readBuf.length !== gw * gh * 4) {
      state.readBuf = new Float32Array(gw * gh * 4);
    }
    gl.readPixels(0, 0, gw, gh, gl.RGBA, gl.FLOAT, state.readBuf);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    const px = state.readBuf;
    const grid = new Float32Array(gw * gh);
    let overflow = 0;
    for (let i = 0; i < grid.length; i++) {
      grid[i] = px[i * 4];
      overflow += px[i * 4 + 1];
    }
    if (overflow > 0) {
      // A truncated branch set is a WRONG field, not a coarse one.
      if (!state.warned) {
        state.warned = true;
        console.warn(
          `blend-intersections: ${overflow} branch-cap overflows ` +
            `(MAX_BRANCH=${MAX_BRANCH}) — falling back to CPU for this geometry`
        );
      }
      return null;
    }
    return grid;
  } catch (err) {
    // Anything unexpected (a stubbed context in an offline check, a lost
    // context) disables the path for this gl rather than failing the node.
    state.failed = true;
    console.warn("blend-intersections: GPU field error — using CPU:", err);
    return null;
  }
}
