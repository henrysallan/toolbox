// Proof: the SVG writer (lib/svg-write.ts, 090326_asset-library.md §2)
// round-trips through the real path parser.
//   1. Open, closed-straight, and closed-curved subpaths → SVG → each
//      <path d> parsed by parsePathData → contain-fit exactly as parseSvg
//      does for the emitted viewBox → anchors/handles match within ε,
//      `closed` flags preserved. A curved closing edge re-parses with the
//      parser's extra end anchor (cubicTo always pushes one) — asserted,
//      not papered over.
//   2. Non-square aspects preserve their viewBox ratio and still round-trip.
//   3. Degenerate input (empty, single-anchor subpaths) yields a valid doc
//      with no <path>.
//
//   npx tsx scripts/check-svg-write.mts

/* eslint-disable @typescript-eslint/no-explicit-any */
const g = globalThis as any;
g.window ??= g;
g.self ??= g;
g.document ??= { createElement: () => ({ getContext: () => null, style: {} }) };
g.navigator ??= { userAgent: "node" };

import type { SplineSubpath } from "@/engine/types";
const { svgFromSubpaths, svgViewBoxFor } = await import("@/lib/svg-write");
const { parsePathData } = await import("@/lib/svg-parse");

let failures = 0;
const check = (label: string, cond: boolean, detail = "") => {
  if (!cond) failures++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${cond ? "" : `  — ${detail}`}`);
};

const EPS = 2e-6; // 3 decimals at 1000 user units → 1e-6 normalized

// parseSvg's contain-fit for a `0 0 w h` viewBox (kept in lockstep with
// lib/svg-parse.ts parseSvg — this is the transform the writer inverts).
function fitFor(aspect: number) {
  const { w, h } = svgViewBoxFor(aspect);
  const scale = Math.min(1 / w, 1 / h);
  const tx = (1 - w * scale) / 2;
  const ty = (1 - h * scale) / 2;
  return (p: [number, number]): [number, number] => [
    p[0] * scale + tx,
    p[1] * scale + ty,
  ];
}

function extract(svg: string): { viewBox: number[]; ds: string[] } {
  const vb = /viewBox="([^"]+)"/.exec(svg);
  const viewBox = vb ? vb[1].split(/\s+/).map(Number) : [];
  const ds: string[] = [];
  const re = /<path d="([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(svg))) ds.push(m[1]);
  return { viewBox, ds };
}

// Re-parse the document DOM-free: every <path d> through the real path
// parser, then the same fit parseSvg would apply.
function roundTrip(svg: string, aspect: number): SplineSubpath[] {
  const { ds } = extract(svg);
  const fit = fitFor(aspect);
  const out: SplineSubpath[] = [];
  for (const d of ds) {
    for (const sub of parsePathData(d)) {
      out.push({
        closed: sub.closed,
        anchors: sub.anchors.map((a) => {
          const pos = fit(a.pos);
          const rel = (h?: [number, number]) => {
            if (!h) return undefined;
            const abs = fit([a.pos[0] + h[0], a.pos[1] + h[1]]);
            return [abs[0] - pos[0], abs[1] - pos[1]] as [number, number];
          };
          return {
            pos,
            ...(a.inHandle ? { inHandle: rel(a.inHandle) } : {}),
            ...(a.outHandle ? { outHandle: rel(a.outHandle) } : {}),
          };
        }),
      });
    }
  }
  return out;
}

const near = (a: number, b: number) => Math.abs(a - b) <= EPS;
const vecNear = (a?: [number, number], b?: [number, number]) => {
  // A missing handle and a zero handle are the same geometry.
  const ax = a?.[0] ?? 0, ay = a?.[1] ?? 0, bx = b?.[0] ?? 0, by = b?.[1] ?? 0;
  return near(ax, bx) && near(ay, by);
};
function anchorsMatch(
  got: SplineSubpath["anchors"],
  want: SplineSubpath["anchors"]
): string | null {
  if (got.length !== want.length) return `anchor count ${got.length} ≠ ${want.length}`;
  for (let i = 0; i < want.length; i++) {
    const a = got[i], b = want[i];
    if (!near(a.pos[0], b.pos[0]) || !near(a.pos[1], b.pos[1]))
      return `anchor ${i} pos ${a.pos} ≠ ${b.pos}`;
    if (!vecNear(a.inHandle, b.inHandle)) return `anchor ${i} inHandle`;
    if (!vecNear(a.outHandle, b.outHandle)) return `anchor ${i} outHandle`;
  }
  return null;
}

// --- 1. the three subpath shapes, square aspect ---------------------------
const open: SplineSubpath = {
  closed: false,
  anchors: [
    { pos: [0.1, 0.2], outHandle: [0.05, -0.02] },
    { pos: [0.5, 0.25], inHandle: [-0.04, 0.03] }, // no outHandle …
    { pos: [0.9, 0.8] }, // … and no inHandle: a straight segment → L
  ],
};
const closedStraight: SplineSubpath = {
  closed: true,
  anchors: [
    { pos: [0.2, 0.2] },
    { pos: [0.8, 0.2] },
    { pos: [0.8, 0.8] },
    { pos: [0.2, 0.8] },
  ],
};
const closedCurved: SplineSubpath = {
  closed: true,
  anchors: [
    { pos: [0.5, 0.1], inHandle: [-0.2, 0], outHandle: [0.2, 0] },
    { pos: [0.9, 0.5], inHandle: [0, -0.2], outHandle: [0, 0.2] },
    { pos: [0.5, 0.9], inHandle: [0.2, 0], outHandle: [-0.2, 0] },
    { pos: [0.1, 0.5], inHandle: [0, 0.2], outHandle: [0, -0.2] },
  ],
};

{
  const svg = svgFromSubpaths([open, closedStraight, closedCurved], 1, "t");
  check("doc: xmlns + viewBox present", /xmlns="http:\/\/www.w3.org\/2000\/svg"/.test(svg) && /viewBox="0 0 1000 1000"/.test(svg));
  check("doc: title escaped element", /<title>t<\/title>/.test(svg));
  const { ds } = extract(svg);
  check("doc: three <path> elements", ds.length === 3, String(ds.length));
  check("open: L for the handle-less segment", /L/.test(ds[0]) && /C/.test(ds[0]));
  check("closed-straight: only L + Z", !/C/.test(ds[1]) && /Z$/.test(ds[1]));
  check("closed-curved: explicit closing C before Z", (ds[2].match(/C/g) ?? []).length === 4 && /Z$/.test(ds[2]));

  const back = roundTrip(svg, 1);
  check("round-trip: three subpaths", back.length === 3, String(back.length));
  check("open: closed=false", back[0]?.closed === false);
  check("open: anchors match", anchorsMatch(back[0].anchors, open.anchors) === null, anchorsMatch(back[0].anchors, open.anchors) ?? "");
  check("closed-straight: closed=true", back[1]?.closed === true);
  check("closed-straight: anchors match", anchorsMatch(back[1].anchors, closedStraight.anchors) === null, anchorsMatch(back[1].anchors, closedStraight.anchors) ?? "");
  check("closed-curved: closed=true", back[2]?.closed === true);
  // The parser pushes an anchor for the closing cubic (at the start point,
  // carrying the first anchor's inHandle); the ring then closes with Z.
  const cc = back[2].anchors;
  check("closed-curved: parser adds the closing end anchor", cc.length === closedCurved.anchors.length + 1, String(cc.length));
  const cc4 = cc.slice(0, 4).map((a, i) => (i === 0 ? { pos: a.pos, outHandle: a.outHandle } : a));
  const want4 = closedCurved.anchors.map((a, i) => (i === 0 ? { pos: a.pos, outHandle: a.outHandle } : a));
  check("closed-curved: first four anchors match", anchorsMatch(cc4, want4) === null, anchorsMatch(cc4, want4) ?? "");
  const last = cc[cc.length - 1];
  check(
    "closed-curved: end anchor sits on the start with its inHandle",
    near(last.pos[0], closedCurved.anchors[0].pos[0]) &&
      near(last.pos[1], closedCurved.anchors[0].pos[1]) &&
      vecNear(last.inHandle, closedCurved.anchors[0].inHandle)
  );
}

// --- 2. non-square aspects ---------------------------------------------------
for (const aspect of [16 / 9, 9 / 16, 2.5]) {
  const svg = svgFromSubpaths([open, closedStraight], aspect);
  const { viewBox } = extract(svg);
  const ratio = viewBox[2] / viewBox[3];
  check(`aspect ${aspect.toFixed(3)}: viewBox ratio preserved`, Math.abs(ratio - aspect) < 1e-6, String(ratio));
  check(`aspect ${aspect.toFixed(3)}: longest edge = 1000`, Math.max(viewBox[2], viewBox[3]) === 1000);
  const back = roundTrip(svg, aspect);
  const err = anchorsMatch(back[0]?.anchors ?? [], open.anchors) ?? anchorsMatch(back[1]?.anchors ?? [], closedStraight.anchors);
  check(`aspect ${aspect.toFixed(3)}: anchors round-trip`, err === null, err ?? "");
}

// --- 3. degenerate input -------------------------------------------------------
{
  const empty = svgFromSubpaths([], 1);
  check("empty: valid doc, no <path>", /<svg /.test(empty) && !/<path/.test(empty));
  const single = svgFromSubpaths([{ closed: false, anchors: [{ pos: [0.5, 0.5] }] }], 1);
  check("single anchor: skipped", !/<path/.test(single));
  const bad = svgFromSubpaths([closedStraight], NaN);
  check("NaN aspect: falls back to square", /viewBox="0 0 1000 1000"/.test(bad));
}

console.log(`\n${failures === 0 ? "ALL GREEN ✅" : `${failures} FAILURE(S) ❌`}`);
if (failures) process.exit(1);
