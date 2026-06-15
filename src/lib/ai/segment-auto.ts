// Point-free "auto" segmentation for the Segment Anything node — three
// methods, all producing an INDEX MASK (per-pixel segment slot id, 0 =
// background) that the node colorizes in its shader:
//
//   semantic — SegFormer (ADE20K, 150 classes). Per-pixel CLASS labels;
//              identities are semantic so colors are inherently stable
//              across video. Small + fast.
//   panoptic — DETR-ResNet50 (COCO panoptic). Instance-aware segments
//              (two people = two slots); instance identity flickers frame
//              to frame, so slots are matched across frames by overlap.
//   grid     — SlimSAM prompted with a point grid per frame; overlapping
//              candidates deduped, top-K by score kept. Class-agnostic
//              SAM look; slowest (K decoder passes per frame). Same
//              overlap-based slot matching as panoptic.
//
// Slot identity across frames is the whole ballgame for a multicolor mask
// that doesn't strobe: SegmentSlotMatcher assigns each segment a stable
// slot id — by label for semantic, by best overlap with the previous
// frame's index map for panoptic/grid. One matcher instance spans one
// bake (or one live preview).

import type { SegmentProgress } from "./segment";

export type AutoMethod = "semantic" | "panoptic" | "grid";

export interface IndexedMask {
  // Slot id per pixel. 0 = background, 1..255 = segments.
  data: Uint8Array;
  width: number;
  height: number;
}

const SEMANTIC_MODEL = "Xenova/segformer-b0-finetuned-ade-512-512";
const PANOPTIC_MODEL = "Xenova/detr-resnet-50-panoptic";

// A segment as normalized from either pipeline output or SAM decode.
interface RawSegment {
  data: Uint8Array; // binary, same dims as the frame
  width: number;
  height: number;
  area: number;
  label: string | null;
  score: number;
}

// ---------------------------------------------------------------------
// Model loading
// ---------------------------------------------------------------------

type SegPipe = (
  image: unknown,
  options?: Record<string, unknown>
) => Promise<
  Array<{ label: string | null; score: number | null; mask: { data: Uint8Array; width: number; height: number } }>
>;

const pipeCache = new Map<string, SegPipe>();
const pipeInFlight = new Map<string, Promise<SegPipe>>();

async function getPipe(
  model: string,
  onProgress?: (p: SegmentProgress) => void
): Promise<SegPipe> {
  const cached = pipeCache.get(model);
  if (cached) return cached;
  const pending = pipeInFlight.get(model);
  if (pending) return pending;

  const promise = (async () => {
    onProgress?.({ phase: "loading-runtime" });
    const tx = (await import(
      "@huggingface/transformers"
    )) as typeof import("@huggingface/transformers");
    tx.env.allowLocalModels = false;
    onProgress?.({ phase: "loading-model" });
    const progressCb = (p: unknown) => {
      const prog = (p as { progress?: unknown }).progress;
      if (typeof prog === "number") {
        onProgress?.({
          phase: "loading-model",
          progress: Math.min(1, Math.max(0, prog / 100)),
        });
      }
    };
    const pipe = await tx.pipeline("image-segmentation", model, {
      progress_callback: progressCb,
    });
    const wrapped = pipe as unknown as SegPipe;
    pipeCache.set(model, wrapped);
    return wrapped;
  })();
  pipeInFlight.set(model, promise);
  try {
    return await promise;
  } finally {
    pipeInFlight.delete(model);
  }
}

// ---------------------------------------------------------------------
// Cross-frame slot identity
// ---------------------------------------------------------------------

export class SegmentSlotMatcher {
  private labelSlots = new Map<string, number>();
  private prevIndex: Uint8Array | null = null;
  private prevW = 0;
  private prevH = 0;
  private nextSlot = 1;

  // Assign a slot per segment for this frame. Semantic identities come
  // from the label; instance identities (panoptic/grid) from best overlap
  // against the previous frame's committed index map. Greedy by overlap,
  // one segment per slot per frame.
  assignSlots(segments: RawSegment[], byLabel: boolean): number[] {
    if (byLabel) {
      return segments.map((s) => {
        const key = s.label ?? "?";
        let slot = this.labelSlots.get(key);
        if (slot == null) {
          slot = this.allocSlot();
          this.labelSlots.set(key, slot);
        }
        return slot;
      });
    }

    const used = new Set<number>();
    // Larger segments match first — they have the most evidence.
    const order = segments
      .map((s, i) => ({ s, i }))
      .sort((a, b) => b.s.area - a.s.area);
    const slots = new Array<number>(segments.length).fill(0);
    for (const { s, i } of order) {
      slots[i] = this.matchOne(s, used);
      used.add(slots[i]);
    }
    return slots;
  }

  private matchOne(seg: RawSegment, used: Set<number>): number {
    const prev = this.prevIndex;
    if (prev && this.prevW === seg.width && this.prevH === seg.height) {
      // Overlap histogram of this mask against previous slots.
      const counts = new Map<number, number>();
      const d = seg.data;
      for (let i = 0; i < d.length; i++) {
        if (!d[i]) continue;
        const slot = prev[i];
        if (slot === 0) continue;
        counts.set(slot, (counts.get(slot) ?? 0) + 1);
      }
      let best = 0;
      let bestCount = 0;
      for (const [slot, count] of counts) {
        if (!used.has(slot) && count > bestCount) {
          best = slot;
          bestCount = count;
        }
      }
      // Reuse the previous identity when it covers a meaningful share of
      // the new mask; otherwise this is a new object.
      if (best !== 0 && bestCount / Math.max(1, seg.area) > 0.3) {
        return best;
      }
    }
    return this.allocSlot();
  }

  private allocSlot(): number {
    // 255 is the ceiling of the 8-bit index encoding; recycle the last
    // slot rather than wrapping to background.
    return Math.min(255, this.nextSlot++);
  }

  commit(index: IndexedMask): void {
    this.prevIndex = index.data;
    this.prevW = index.width;
    this.prevH = index.height;
  }
}

// ---------------------------------------------------------------------
// Frame segmentation
// ---------------------------------------------------------------------

function countArea(data: Uint8Array): number {
  let n = 0;
  for (let i = 0; i < data.length; i++) if (data[i]) n++;
  return n;
}

// Paint segments into a slot-id map, largest first so smaller (often
// nested) segments overwrite and stay visible.
function buildIndexMap(
  segments: RawSegment[],
  slots: number[],
  width: number,
  height: number
): IndexedMask {
  const out = new Uint8Array(width * height);
  const order = segments
    .map((s, i) => ({ s, slot: slots[i] }))
    .sort((a, b) => b.s.area - a.s.area);
  for (const { s, slot } of order) {
    if (s.width !== width || s.height !== height) continue;
    const d = s.data;
    for (let i = 0; i < d.length; i++) {
      if (d[i]) out[i] = slot;
    }
  }
  return { data: out, width, height };
}

// Stride-sampled thumbnail for cheap IoU between candidate masks (grid
// NMS) — full-res pairwise IoU would dominate the bake.
const NMS_SIZE = 96;
function downsample(seg: { data: Uint8Array; width: number; height: number }): Uint8Array {
  const out = new Uint8Array(NMS_SIZE * NMS_SIZE);
  for (let y = 0; y < NMS_SIZE; y++) {
    const sy = Math.min(seg.height - 1, Math.floor((y + 0.5) * (seg.height / NMS_SIZE)));
    for (let x = 0; x < NMS_SIZE; x++) {
      const sx = Math.min(seg.width - 1, Math.floor((x + 0.5) * (seg.width / NMS_SIZE)));
      out[y * NMS_SIZE + x] = seg.data[sy * seg.width + sx] ? 1 : 0;
    }
  }
  return out;
}

function iouDs(a: Uint8Array, b: Uint8Array): number {
  let inter = 0;
  let union = 0;
  for (let i = 0; i < a.length; i++) {
    const av = a[i];
    const bv = b[i];
    if (av && bv) inter++;
    if (av || bv) union++;
  }
  return union === 0 ? 0 : inter / union;
}

async function pipelineSegments(
  method: "semantic" | "panoptic",
  blob: Blob,
  onProgress?: (p: SegmentProgress) => void
): Promise<RawSegment[]> {
  const model = method === "semantic" ? SEMANTIC_MODEL : PANOPTIC_MODEL;
  const pipe = await getPipe(model, onProgress);
  const tx = (await import(
    "@huggingface/transformers"
  )) as typeof import("@huggingface/transformers");
  onProgress?.({ phase: "segmenting" });
  const raw = await tx.RawImage.fromBlob(blob);
  // NO explicit `subtask` option: transformers.js v4 has a bug where an
  // explicit subtask assigns the SUBTASKS_MAPPING *string* to the
  // post-process fn ("fn is not a function"). The auto-detect path probes
  // the processor for post_process_{panoptic,instance,semantic}_
  // segmentation in that order and binds correctly — DETR resolves to
  // panoptic, SegFormer to semantic, which is exactly what we want.
  const results = await pipe(raw);
  const segments: RawSegment[] = [];
  for (const r of results) {
    const m = r.mask;
    if (!m?.data) continue;
    const data = m.data instanceof Uint8Array ? m.data : new Uint8Array(m.data);
    segments.push({
      data,
      width: m.width,
      height: m.height,
      area: countArea(data),
      label: r.label ?? null,
      score: r.score ?? 0,
    });
  }
  return segments;
}

async function gridSegments(
  blob: Blob,
  levels: number,
  onProgress?: (p: SegmentProgress) => void
): Promise<RawSegment[]> {
  const seg = await import("./segment");
  const emb = await seg.embedImage(blob, onProgress);
  onProgress?.({ phase: "segmenting" });

  // Oversampled prompt grid — more probes than requested levels so NMS
  // has duplicates to merge. Capped: each probe is a decoder pass.
  const g = Math.max(2, Math.min(6, Math.ceil(Math.sqrt(levels)) + 1));
  const total = emb.width * emb.height;
  const candidates: Array<RawSegment & { ds: Uint8Array }> = [];
  for (let gy = 0; gy < g; gy++) {
    for (let gx = 0; gx < g; gx++) {
      const { mask, score } = await seg.decodeSingle(emb, {
        x: (gx + 0.5) / g,
        y: (gy + 0.5) / g,
      });
      const area = countArea(mask.data);
      // Drop degenerate probes: specks and near-full-frame masks.
      if (area < total * 0.002 || area > total * 0.92) continue;
      candidates.push({
        data: mask.data,
        width: mask.width,
        height: mask.height,
        area,
        label: null,
        score,
        ds: downsample(mask),
      });
    }
  }

  // NMS on downsampled masks: keep best-scoring representative of each
  // overlapping cluster, then the top `levels` by score.
  candidates.sort((a, b) => b.score - a.score);
  const kept: Array<RawSegment & { ds: Uint8Array }> = [];
  for (const c of candidates) {
    if (kept.length >= levels) break;
    if (kept.some((k) => iouDs(k.ds, c.ds) > 0.7)) continue;
    kept.push(c);
  }
  return kept;
}

// Segment one frame into an index mask. `matcher` carries slot identity
// across calls — pass the same instance for every frame of a bake.
export async function autoSegmentFrame(
  method: AutoMethod,
  blob: Blob,
  levels: number,
  matcher: SegmentSlotMatcher,
  onProgress?: (p: SegmentProgress) => void
): Promise<IndexedMask> {
  let segments: RawSegment[];
  if (method === "grid") {
    segments = await gridSegments(blob, levels, onProgress);
  } else {
    segments = await pipelineSegments(method, blob, onProgress);
  }
  if (segments.length === 0) {
    // Whole frame is background — still a valid (empty) index mask. Use
    // any consistent dims; fall back to 1×1 if the model returned nothing
    // to measure.
    const w = segments[0]?.width ?? 1;
    const h = segments[0]?.height ?? 1;
    return { data: new Uint8Array(w * h), width: w, height: h };
  }

  // Keep the top `levels` segments by area; the rest fold into background.
  segments.sort((a, b) => b.area - a.area);
  segments = segments.slice(0, Math.max(1, levels));

  const slots = matcher.assignSlots(segments, method === "semantic");
  const index = buildIndexMap(
    segments,
    slots,
    segments[0].width,
    segments[0].height
  );
  matcher.commit(index);
  onProgress?.({ phase: "done", progress: 1 });
  return index;
}
