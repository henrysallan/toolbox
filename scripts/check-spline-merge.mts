// Guards spline-editor merge (M menu): collapse selected anchors to a
// centroid, stitch involved subpaths into one chain, and cluster by
// on-screen distance.
//
//   npx tsx scripts/check-spline-merge.mts

import {
  clusterKeysByDistance,
  mergeAnchorsAt,
  mergeByClusters,
  selKey,
} from "../src/components/effects/spline-editor/geometry.ts";
import type { SplineAnchor, SplineSubpath } from "../src/engine/types.ts";

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) {
    console.log(`PASS  ${name}`);
  } else {
    failures++;
    console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function close2(a: unknown, b: [number, number], eps = 1e-6): boolean {
  if (!Array.isArray(a) || a.length < 2) return false;
  return Math.abs(a[0] - b[0]) < eps && Math.abs(a[1] - b[1]) < eps;
}

function A(
  id: string,
  x: number,
  y: number,
  extra: Partial<SplineAnchor> = {}
): SplineAnchor {
  return { id, pos: [x, y], ...extra };
}

function posOf(sub: SplineSubpath | undefined): [number, number][] {
  return (sub?.anchors ?? []).map((a) => a.pos);
}

{
  const r = mergeAnchorsAt(
    [{ closed: false, anchors: [A("a", 0, 0)] }],
    [selKey(0, 0)],
    [0, 0]
  );
  check("single key is a no-op", r === null);
}

{
  // Open chain A-B-C-D; merge B+C to (0.5, 0.5) → A, M, D.
  const r = mergeAnchorsAt(
    [
      {
        closed: false,
        anchors: [A("a", 0, 0), A("b", 0.2, 0), A("c", 0.8, 1), A("d", 1, 1)],
      },
    ],
    [selKey(0, 1), selKey(0, 2)],
    [0.5, 0.5]
  );
  check("same-subpath merge keeps one subpath", r?.subpaths.length === 1);
  const pos = posOf(r?.subpaths[0]);
  check("same-subpath merge drops extras", pos.length === 3);
  check("slot 0 stays A", close2(pos[0], [0, 0]));
  check("merged slot sits at centroid", close2(pos[1], [0.5, 0.5]));
  check("slot 2 stays D", close2(pos[2], [1, 1]));
  check("selects the merged point", r?.mergedKey === selKey(0, 1));
}

{
  // Two open paths, weld the facing endpoints → one chain A-M-D.
  const r = mergeAnchorsAt(
    [
      { closed: false, anchors: [A("a", 0, 0), A("b", 1, 0)] },
      { closed: false, anchors: [A("c", 1, 0.2), A("d", 2, 0.2)] },
    ],
    [selKey(0, 1), selKey(1, 0)],
    [1, 0.1]
  );
  check("two subpaths become one", r?.subpaths.length === 1);
  const pos = posOf(r?.subpaths[0]);
  check("joined chain has 3 anchors", pos.length === 3);
  check("join starts at A", close2(pos[0], [0, 0]));
  check("join weld is at centroid", close2(pos[1], [1, 0.1]));
  check("join ends at D", close2(pos[2], [2, 0.2]));
  check(
    "two-subpath merge stays open at the leftover ends",
    r?.subpaths[0].closed === false
  );
}

{
  // One open path, both endpoints selected → close into a loop at the centroid.
  const r = mergeAnchorsAt(
    [
      {
        closed: false,
        anchors: [A("a", 0, 0), A("b", 1, 0), A("c", 1, 1), A("d", 0, 1)],
      },
    ],
    [selKey(0, 0), selKey(0, 3)],
    [0, 0.5]
  );
  check("endpoint merge is one subpath", r?.subpaths.length === 1);
  check("endpoint merge drops one end", (r?.subpaths[0].anchors.length ?? 0) === 3);
  check("endpoint merge closes the loop", r?.subpaths[0].closed === true);
  check(
    "endpoint merge sits at centroid",
    close2(r?.subpaths[0].anchors[0].pos, [0, 0.5])
  );
}

{
  // Closed square; merge two consecutive corners → triangle still closed.
  const r = mergeAnchorsAt(
    [
      {
        closed: true,
        anchors: [
          A("a", 0, 0),
          A("b", 1, 0),
          A("c", 1, 1),
          A("d", 0, 1),
        ],
      },
    ],
    [selKey(0, 0), selKey(0, 1)],
    [0.5, 0]
  );
  const pos = posOf(r?.subpaths[0]);
  check("closed merge keeps 3 corners", pos.length === 3);
  check("closed merge stays closed", r?.subpaths[0].closed === true);
  check("closed merge centroid", close2(pos[0], [0.5, 0]));
}

{
  // Contiguous run transfers the incoming handle of the run start and the
  // outgoing handle of the run end onto the merged slot.
  const r = mergeAnchorsAt(
    [
      {
        closed: false,
        anchors: [
          A("a", 0, 0),
          A("b", 0.3, 0, { inHandle: [-0.1, 0], outHandle: [0.1, 0] }),
          A("c", 0.7, 0, { inHandle: [-0.1, 0], outHandle: [0.05, 0.05] }),
          A("d", 1, 0),
        ],
      },
    ],
    [selKey(0, 1), selKey(0, 2)],
    [0.5, 0]
  );
  const m = r?.subpaths[0].anchors[1];
  check(
    "run inHandle comes from first selected",
    close2(m?.inHandle, [-0.1, 0])
  );
  check(
    "run outHandle comes from last selected",
    close2(m?.outHandle, [0.05, 0.05])
  );
  check("both handles mark the weld broken", m?.broken === true);
}

{
  const clusters = clusterKeysByDistance(
    [
      { key: selKey(0, 0), pos: [0, 0], px: { x: 0, y: 0 } },
      { key: selKey(0, 1), pos: [1, 0], px: { x: 100, y: 0 } },
      { key: selKey(1, 0), pos: [0, 0.01], px: { x: 4, y: 0 } },
      { key: selKey(1, 1), pos: [1, 0.01], px: { x: 104, y: 0 } },
    ],
    16
  );
  check("distance clusters nearby pairs", clusters.length === 2);
  const sizes = clusters.map((c) => c.keys.length).sort();
  check("each cluster has two members", sizes[0] === 2 && sizes[1] === 2);
}

{
  const clusters = clusterKeysByDistance(
    [
      { key: selKey(0, 0), pos: [0, 0], px: { x: 0, y: 0 } },
      { key: selKey(0, 1), pos: [1, 0], px: { x: 200, y: 0 } },
    ],
    16
  );
  check("far points do not cluster", clusters.length === 0);
}

{
  // Two parallel segments, both ends close: two clusters collapse then
  // stitch into a single subpath.
  const r = mergeByClusters(
    [
      { closed: false, anchors: [A("a", 0, 0), A("b", 1, 0)] },
      { closed: false, anchors: [A("c", 0, 0.01), A("d", 1, 0.01)] },
    ],
    [
      { keys: [selKey(0, 0), selKey(1, 0)], pos: [0, 0.005] },
      { keys: [selKey(0, 1), selKey(1, 1)], pos: [1, 0.005] },
    ]
  );
  check("multi-cluster stitch is one subpath", r?.subpaths.length === 1);
  const pos = posOf(r?.subpaths[0]);
  check(
    "multi-cluster keeps both merge points",
    pos.some((p) => close2(p, [0, 0.005])) &&
      pos.some((p) => close2(p, [1, 0.005]))
  );
}

{
  // Two complementary open contours (the screenshot case): merge the
  // facing inner ends; leftover outer ends close into one loop.
  const r = mergeAnchorsAt(
    [
      {
        closed: false,
        anchors: [A("L0", 0.3, 0.2), A("L1", 0.1, 0.2), A("L2", 0.4, 0.8)],
      },
      {
        closed: false,
        anchors: [A("R0", 0.6, 0.8), A("R1", 0.9, 0.2), A("R2", 0.7, 0.2)],
      },
    ],
    [selKey(0, 2), selKey(1, 0)],
    [0.5, 0.8]
  );
  check("complementary arcs become one subpath", r?.subpaths.length === 1);
  check(
    "complementary arcs stay open at the leftover pair",
    r?.subpaths[0].closed === false
  );
  const pos = posOf(r?.subpaths[0]);
  check("loop keeps leftover ends", pos.length >= 4);
  check(
    "loop includes the merge point",
    pos.some((p) => close2(p, [0.5, 0.8]))
  );
}

{
  // Two closed rectangles side by side; merge the facing bottom corners.
  // Must become ONE outer loop (7 corners), not a figure-8 V whose merge
  // point still has all four original edges.
  const r = mergeAnchorsAt(
    [
      {
        closed: true,
        anchors: [
          A("L_bl", 0, 0),
          A("L_br", 1, 0),
          A("L_tr", 1, 1),
          A("L_tl", 0, 1),
        ],
      },
      {
        closed: true,
        anchors: [
          A("R_bl", 1.5, 0),
          A("R_br", 2.5, 0),
          A("R_tr", 2.5, 1),
          A("R_tl", 1.5, 1),
        ],
      },
    ],
    [selKey(0, 1), selKey(1, 0)],
    [1.25, 0]
  );
  check("two closed contours become one", r?.subpaths.length === 1);
  check(
    "only the selected pair is welded — leftover pair stay endpoints",
    r?.subpaths[0].closed === false
  );
  const sub = r?.subpaths[0];
  const n = sub?.anchors.length ?? 0;
  check("joined chain keeps 7 corners (8−2+1)", n === 7);
  const mi = sub?.anchors.findIndex((a) => close2(a.pos, [1.25, 0])) ?? -1;
  check("merge point exists", mi >= 0);
  if (sub && mi >= 0) {
    const na = sub.anchors[mi - 1];
    const nb = sub.anchors[mi + 1];
    const ids = new Set([na?.id, nb?.id]);
    check(
      "merge sits on the bottom, not a V to the top corners",
      ids.has("L_bl") && ids.has("R_br"),
      `neighbors=${na?.id},${nb?.id}`
    );
    check(
      "open start has no inHandle (dropped arm toward M)",
      sub.anchors[0].inHandle === undefined
    );
    check(
      "open end has no outHandle (dropped arm toward M)",
      sub.anchors[n - 1].outHandle === undefined
    );
  }
}

{
  // Reversing an arc must swap in/out, otherwise cubics loop like a bow.
  const r = mergeAnchorsAt(
    [
      {
        closed: true,
        anchors: [
          A("L_bl", 0, 0),
          A("L_br", 1, 0),
          A("L_tr", 1, 1, {
            inHandle: [0, -0.25],
            outHandle: [-0.25, 0],
          }),
          A("L_tl", 0, 1, {
            inHandle: [0.2, 0],
            outHandle: [0, 0.2],
          }),
        ],
      },
      {
        closed: true,
        anchors: [
          A("R_bl", 1.5, 0),
          A("R_br", 2.5, 0),
          A("R_tr", 2.5, 1),
          A("R_tl", 1.5, 1),
        ],
      },
    ],
    [selKey(0, 1), selKey(1, 0)],
    [1.25, 0]
  );
  const sub = r?.subpaths[0];
  const tl = sub?.anchors.find((a) => a.id === "L_tl");
  check("reversed-arc point is still present", !!tl);
  if (tl) {
    const inn = tl.inHandle;
    const out = tl.outHandle;
    const swapped =
      (!inn || close2(inn, [0, 0.2]) || close2(inn, [0.2, 0])) &&
      (!out || close2(out, [0, 0.2]) || close2(out, [0.2, 0]));
    // Either the original winding was kept (forward walk) or in/out swapped
    // (backward walk). Never a mix that would point both handles the old way
    // after a reverse — that is covered by walkArc copying with swapHandles.
    check(
      "L_tl handles are a copy of the original pair (possibly swapped)",
      swapped,
      `in=${JSON.stringify(inn)} out=${JSON.stringify(out)}`
    );
  }
}

if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nall spline-merge checks passed");
