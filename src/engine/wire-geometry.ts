// Geometry helpers for wire-crossing gestures in the node editor.
//
// All coordinates in this file are in SCREEN pixels — gestures fire in
// client space (window MouseEvents) and we hit-test against React Flow's
// actual rendered edge paths, not the underlying flow-space data.

export type Pt = [number, number];

// Cubic bezier sampled uniformly in `t`. Not uniform in arc length, but
// close enough for the ~12 segments we hit-test against.
export function sampleCubic(
  p0: Pt,
  c1: Pt,
  c2: Pt,
  p3: Pt,
  steps = 12
): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const mt = 1 - t;
    const b0 = mt * mt * mt;
    const b1 = 3 * mt * mt * t;
    const b2 = 3 * mt * t * t;
    const b3 = t * t * t;
    out.push([
      b0 * p0[0] + b1 * c1[0] + b2 * c2[0] + b3 * p3[0],
      b0 * p0[1] + b1 * c1[1] + b2 * c2[1] + b3 * p3[1],
    ]);
  }
  return out;
}

// React Flow's default bezier geometry for a source on the right flowing
// into a target on the left. Curvature = 0.25 matches the library.
export function defaultBezierCps(src: Pt, tgt: Pt): { c1: Pt; c2: Pt } {
  const curvature = 0.25;
  const dx = Math.abs(tgt[0] - src[0]) * curvature;
  return {
    c1: [src[0] + dx, src[1]],
    c2: [tgt[0] - dx, tgt[1]],
  };
}

// Standard segment-segment intersection. Returns true if [a1,a2] and
// [b1,b2] have any interior or endpoint crossing. Collinear overlaps are
// treated as non-crossing — fine for our use since the user's drawn line
// vs. edge beziers won't realistically be collinear.
export function segmentsCross(a1: Pt, a2: Pt, b1: Pt, b2: Pt): boolean {
  const d = (p: Pt, q: Pt, r: Pt) =>
    (r[0] - p[0]) * (q[1] - p[1]) - (q[0] - p[0]) * (r[1] - p[1]);
  const d1 = d(b1, b2, a1);
  const d2 = d(b1, b2, a2);
  const d3 = d(a1, a2, b1);
  const d4 = d(a1, a2, b2);
  return (
    ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) &&
    ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))
  );
}

// Does any segment of `polyline` cross [a,b]? Used to check whether the
// user's drawn line crosses a sampled edge path.
export function polylineCrossesSegment(
  polyline: Pt[],
  a: Pt,
  b: Pt
): boolean {
  for (let i = 0; i < polyline.length - 1; i++) {
    if (segmentsCross(polyline[i], polyline[i + 1], a, b)) return true;
  }
  return false;
}

// Find the screen-space center of a React Flow handle DOM element.
// Returns null if the handle isn't rendered (node collapsed, not in
// viewport, etc.) so callers can skip those edges gracefully.
export function handleCenter(
  nodeId: string,
  handleId: string
): Pt | null {
  const el = document.querySelector(
    `.react-flow__handle[data-nodeid="${nodeId}"][data-handleid="${CSS.escape(
      handleId
    )}"]`
  ) as HTMLElement | null;
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return [r.left + r.width / 2, r.top + r.height / 2];
}
