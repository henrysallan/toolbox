// Timeline markers and named segments (specdocs/101326_skia-target.md §3.5a,
// M3 lane B) — the pure half. No DOM, no React: the ruler UI
// (components/effects/timeline/MarkerRuler.tsx), the MCP tools, the React
// Native Skia exporter (lib/skia-export/segments.ts) and the gate
// (scripts/check-skia-segments.mts) all ride these helpers.
//
// A marker is a named composition frame. Markers belong to a composition
// (SavedComposition.markers): each comp has its own timeline.
//
// Segments — the named spans an exported app plays (`playSegment("intro")`):
//
//   - A POINT marker (no `duration`) opens a segment that runs to the next
//     point marker, or to the scene end: markers at 0 "intro", 72 "idle"
//     on a 300-frame scene give intro [0, 72) and idle [72, 300). This is
//     the common case — a designer drops one marker where each state
//     starts, the way After Effects comp markers and Lottie markers read —
//     and it can't leave gaps or overlaps by accident.
//   - A RANGED marker (`duration` frames) is its own span
//     [frame, frame + duration) and does NOT cut the point chain: a "blink"
//     range inside "idle" leaves idle whole. Ranges cover what chaining
//     can't express — overlapping or gapped spans — and match Lottie's
//     marker `dr` field.
//
// End frames are exclusive: a looping segment wraps from its end back to its
// start, so the end instant (= the next segment's first frame) is never
// shown twice. A play-once segment holds ON its end instant — the pose the
// next segment starts from.
//
// Problems never throw; deriveSegments reports them as issues (the editor
// flags the chip, the exporter turns them into warnings):
//   duplicate-name  a later marker reuses a name — only the first segment
//                   with that name ships (the later marker still cuts the
//                   point chain, as the ruler shows)
//   out-of-range    the marker starts at/after the scene end (or its span
//                   ends at/before frame 0 on a shifted clock)
//   clamped         the span was cut to [0, scene end]
//   empty           two point markers share a frame: the first one's span
//                   is zero frames long

export interface TimelineMarker {
  id: string;
  name: string;
  // Composition frame, a whole number ≥ 0.
  frame: number;
  // Explicit span length in frames (a whole number ≥ 1). Absent = a point
  // marker, whose segment runs to the next point marker.
  duration?: number;
}

export interface TimelineSegment {
  markerId: string;
  name: string;
  startFrame: number;
  // Exclusive.
  endFrame: number;
  // "range": the marker's own duration; "next": runs to the next point
  // marker (or the scene end).
  kind: "range" | "next";
}

export type SegmentIssueCode = "duplicate-name" | "out-of-range" | "clamped" | "empty";

export interface SegmentIssue {
  code: SegmentIssueCode;
  markerId: string;
  name: string;
  frame: number;
  message: string;
}

export interface DerivedSegments {
  // In start order (ties: marker order).
  segments: TimelineSegment[];
  issues: SegmentIssue[];
  // The markers that resolve to a time on this timeline: in range and the
  // first of their name. Frame order.
  markers: TimelineMarker[];
}

export const NO_MARKERS: readonly TimelineMarker[] = Object.freeze([]);
export const MAX_MARKERS = 256;
export const MARKER_NAME_MAX = 64;

export function newMarkerId(): string {
  return `mk-${Math.random().toString(36).slice(2, 10)}`;
}

// Trim, collapse whitespace, drop control characters, cap the length. May
// return "" — callers decide whether that is an error or a default.
export function cleanMarkerName(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MARKER_NAME_MAX)
    .trim();
}

// Stable sort by frame: ties keep their list order.
export function sortMarkers(markers: readonly TimelineMarker[]): TimelineMarker[] {
  return markers
    .map((m, i) => ({ m, i }))
    .sort((a, b) => a.m.frame - b.m.frame || a.i - b.i)
    .map((x) => x.m);
}

// Persistence gate for SavedComposition.markers — the blob is untrusted (a
// hand-edited .toolbox, another build, a truncated row). Non-objects and
// markers without a finite frame are dropped; frames round to whole frames
// ≥ 0; a missing name becomes "Marker"; a duration that is not ≥ 1 frame is
// dropped (the marker becomes a point marker); missing or repeated ids are
// re-minted. Names may repeat (deriveSegments flags them). The result is in
// frame order and capped at MAX_MARKERS.
export function sanitizeMarkers(raw: unknown): TimelineMarker[] {
  if (!Array.isArray(raw)) return [];
  const out: TimelineMarker[] = [];
  const ids = new Set<string>();
  for (const v of raw) {
    if (out.length >= MAX_MARKERS) break;
    if (v == null || typeof v !== "object") continue;
    const r = v as Record<string, unknown>;
    if (typeof r.frame !== "number" || !Number.isFinite(r.frame)) continue;
    let id = typeof r.id === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(r.id) ? r.id : "";
    while (!id || ids.has(id)) id = newMarkerId();
    ids.add(id);
    const m: TimelineMarker = {
      id,
      name: cleanMarkerName(r.name) || "Marker",
      frame: Math.max(0, Math.round(r.frame)),
    };
    if (typeof r.duration === "number" && Number.isFinite(r.duration) && Math.round(r.duration) >= 1) {
      m.duration = Math.round(r.duration);
    }
    out.push(m);
  }
  return sortMarkers(out);
}

function issue(code: SegmentIssueCode, m: TimelineMarker, message: string): SegmentIssue {
  return { code, markerId: m.id, name: m.name, frame: m.frame, message };
}

// The named segments of a timeline `durationFrames` long (the scene / loop
// length). Markers need not be sorted, and may carry fractional or negative
// frames here (the exporter shifts them onto a layer's own clock).
export function deriveSegments(
  markers: readonly TimelineMarker[],
  durationFrames: number
): DerivedSegments {
  const sorted = sortMarkers(markers);
  const D = Math.max(0, durationFrames);
  const issues: SegmentIssue[] = [];
  const spans: TimelineSegment[] = [];
  const points = sorted.filter((m) => m.duration === undefined);
  const pointIndex = new Map(points.map((m, i) => [m, i]));
  for (const m of sorted) {
    const at = `"${m.name}" (frame ${fmt(m.frame)})`;
    let start = m.frame;
    let end: number;
    let kind: TimelineSegment["kind"];
    if (m.duration !== undefined) {
      kind = "range";
      end = m.frame + m.duration;
    } else {
      kind = "next";
      const next = points[pointIndex.get(m)! + 1];
      end = next ? Math.min(next.frame, D) : D;
    }
    if (start >= D || end <= 0) {
      issues.push(
        issue(
          "out-of-range",
          m,
          start >= D
            ? `Marker ${at} starts at or after the scene end (frame ${fmt(D)}) — it has no segment.`
            : `Marker ${at} ends before frame 0 on this clock — it has no segment.`
        )
      );
      continue;
    }
    if (end <= start) {
      issues.push(
        issue("empty", m, `Marker ${at} shares its frame with the next marker — its segment is empty.`)
      );
      continue;
    }
    if (start < 0 || end > D) {
      const s = Math.max(0, start);
      const e = Math.min(D, end);
      // A point marker running to the scene end is not "clamped" — that is
      // its definition. Only an explicit range past the end, or a span
      // starting before 0, is cut.
      if (start < 0 || kind === "range") {
        issues.push(
          issue("clamped", m, `Marker ${at} spans frames ${fmt(start)}–${fmt(end)}; the segment is cut to ${fmt(s)}–${fmt(e)}.`)
        );
      }
      start = s;
      end = e;
    }
    spans.push({ markerId: m.id, name: m.name, startFrame: start, endFrame: end, kind });
  }
  // One segment per name: the earliest start wins (ties: marker order).
  const segments: TimelineSegment[] = [];
  const firstOf = new Map<string, TimelineSegment>();
  for (const s of spans) {
    const prev = firstOf.get(s.name);
    if (prev) {
      const m = sorted.find((x) => x.id === s.markerId)!;
      issues.push(
        issue(
          "duplicate-name",
          m,
          `Marker "${s.name}" (frame ${fmt(m.frame)}) has the same name as the marker at frame ${fmt(prev.startFrame)} — only the first is a named segment.`
        )
      );
      continue;
    }
    firstOf.set(s.name, s);
    segments.push(s);
  }
  // Marker times: in range and the first of their name (an empty-span marker
  // still has a time).
  const seen = new Set<string>();
  const resolved: TimelineMarker[] = [];
  for (const m of sorted) {
    if (m.frame < 0 || m.frame >= D || seen.has(m.name)) continue;
    seen.add(m.name);
    resolved.push(m);
  }
  return { segments, issues, markers: resolved };
}

function fmt(f: number): string {
  return Number.isInteger(f) ? String(f) : String(Math.round(f * 100) / 100);
}

// ---- edits (the ruler UI) ------------------------------------------------------

// "Marker 1", "Marker 2", … — the first `${base} N` no marker uses.
export function uniqueMarkerName(markers: readonly TimelineMarker[], base = "Marker"): string {
  const used = new Set(markers.map((m) => m.name));
  for (let i = 1; ; i++) {
    const name = `${base} ${i}`;
    if (!used.has(name)) return name;
  }
}

export function addMarker(
  markers: readonly TimelineMarker[],
  frame: number,
  name?: string
): { markers: TimelineMarker[]; id: string } {
  const id = newMarkerId();
  const m: TimelineMarker = {
    id,
    name: cleanMarkerName(name) || uniqueMarkerName(markers),
    frame: Math.max(0, Math.round(frame)),
  };
  return { markers: sortMarkers([...markers, m]).slice(0, MAX_MARKERS), id };
}

// Patch one marker; the list comes back sanitized-shape and in frame order.
// `duration: undefined` (present in the patch) clears a range; a duration
// < 1 frame clears it too.
export function updateMarker(
  markers: readonly TimelineMarker[],
  id: string,
  patch: { name?: string; frame?: number; duration?: number | undefined }
): TimelineMarker[] {
  const next = markers.map((m) => {
    if (m.id !== id) return m;
    const out: TimelineMarker = { ...m };
    if (patch.name !== undefined) out.name = cleanMarkerName(patch.name) || m.name;
    if (patch.frame !== undefined && Number.isFinite(patch.frame)) out.frame = Math.max(0, Math.round(patch.frame));
    if ("duration" in patch) {
      const d = patch.duration;
      if (d !== undefined && Number.isFinite(d) && Math.round(d) >= 1) out.duration = Math.round(d);
      else delete out.duration;
    }
    return out;
  });
  return sortMarkers(next);
}

export function removeMarker(markers: readonly TimelineMarker[], id: string): TimelineMarker[] {
  return markers.filter((m) => m.id !== id);
}

// ---- MCP (set_markers / get_status) --------------------------------------------

export interface MarkerInput {
  id?: unknown;
  name?: unknown;
  frame?: unknown;
  duration?: unknown;
}

// The strict boundary for set_markers: the whole list, replacing the
// composition's. Unlike sanitizeMarkers (which repairs saves), it rejects
// anything ambiguous with a message the agent can act on — fractional
// frames, empty or repeated names (names are the exported API), unknown
// fields' types. An `id` that names an existing marker keeps it (the UI's
// selection and undo stay attached); a missing or unknown id is minted.
export function vetMarkersInput(
  raw: unknown,
  existing: readonly TimelineMarker[]
): { ok: true; markers: TimelineMarker[] } | { ok: false; errors: string[] } {
  if (!Array.isArray(raw))
    return { ok: false, errors: ["Pass `markers` as an array of {name, frame, duration?, id?} (empty clears them)."] };
  if (raw.length > MAX_MARKERS) return { ok: false, errors: [`At most ${MAX_MARKERS} markers (got ${raw.length}).`] };
  const errors: string[] = [];
  const known = new Set(existing.map((m) => m.id));
  const ids = new Set<string>();
  const names = new Map<string, number>();
  const out: TimelineMarker[] = [];
  raw.forEach((v, i) => {
    const at = `markers[${i}]`;
    if (v == null || typeof v !== "object" || Array.isArray(v)) {
      errors.push(`${at} must be an object {name, frame, duration?, id?}.`);
      return;
    }
    const r = v as MarkerInput;
    const name = cleanMarkerName(r.name);
    if (typeof r.name !== "string" || !name) errors.push(`${at}.name must be a non-empty string.`);
    else if (names.has(name)) errors.push(`${at}.name "${name}" repeats markers[${names.get(name)}] — segment names must be unique.`);
    else names.set(name, i);
    const frame = r.frame;
    if (typeof frame !== "number" || !Number.isFinite(frame) || frame < 0 || !Number.isInteger(frame))
      errors.push(`${at}.frame must be a whole frame ≥ 0 (got ${JSON.stringify(frame)}).`);
    const d = r.duration;
    if (d !== undefined && d !== null && (typeof d !== "number" || !Number.isInteger(d) || d < 1))
      errors.push(`${at}.duration must be a whole number of frames ≥ 1, or omitted for a point marker (got ${JSON.stringify(d)}).`);
    let id = typeof r.id === "string" && known.has(r.id) && !ids.has(r.id) ? r.id : "";
    while (!id || ids.has(id)) id = newMarkerId();
    ids.add(id);
    const m: TimelineMarker = { id, name, frame: frame as number };
    if (typeof d === "number") m.duration = d;
    out.push(m);
  });
  return errors.length ? { ok: false, errors } : { ok: true, markers: sortMarkers(out) };
}

export interface McpMarkerReport {
  markers: { id: string; name: string; frame: number; duration?: number; seconds: number }[];
  segments: { name: string; startFrame: number; endFrame: number; start: number; end: number; kind: "range" | "next" }[];
  issues: string[];
}

// What get_status / set_markers report: the markers, the segments they make
// on this timeline (frames and seconds — the exported SEGMENTS), and issues.
export function describeMarkers(
  markers: readonly TimelineMarker[],
  fps: number,
  durationFrames: number
): McpMarkerReport {
  const d = deriveSegments(markers, durationFrames);
  const sec = (f: number) => (fps > 0 ? f / fps : 0);
  return {
    markers: sortMarkers(markers).map((m) => ({
      id: m.id,
      name: m.name,
      frame: m.frame,
      ...(m.duration !== undefined ? { duration: m.duration } : {}),
      seconds: sec(m.frame),
    })),
    segments: d.segments.map((s) => ({
      name: s.name,
      startFrame: s.startFrame,
      endFrame: s.endFrame,
      start: sec(s.startFrame),
      end: sec(s.endFrame),
      kind: s.kind,
    })),
    issues: d.issues.map((i) => i.message),
  };
}
