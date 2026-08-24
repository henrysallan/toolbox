// Tabular projection over socket values — the intelligibility layer behind
// the Spreadsheet panel (specdocs/081326_spreadsheet-panel.md). Pure (no GL,
// no DOM) and engine-side so future consumers that live under src/nodes/
// (the #135 Debug node, a CSV table preview) can import it without breaking
// invariant #1.
//
// Like point-labels.ts, this leans on the fact that every projectable value
// has a FIXED, knowable schema: columns are enumerated per kind, never
// scraped per connection. Cells are LAZY — each column closes over the
// value's typed arrays and answers `get(row)` on demand, so projecting a
// 100k-point value allocates a handful of column objects and nothing else.
// Never materialize the legacy `Point[]` view here (`ensurePointArray`
// allocates N objects and dev-warns on 3D values).
//
// The model returns RAW values (radians, normalized coords); display
// formatting — decimals, degrees, the normalized→pixel units toggle — is the
// consuming UI's job. `space` tags mark which columns are authored-space
// normalized [0,1]² (Y-DOWN) so the UI knows what a pixel toggle may scale
// (x × canvas width, y × canvas height — deliberately anisotropic, the
// point-labels convention). 3D points are world-space meters and carry no
// tag. `get` returns null for a cell that truly has no value (an absent
// spline handle) — distinct from 0.
//
// An ABSENT optional array yields an absent column, not a defaults column:
// the table shows the truth of the value, not the render-time fallback.
// Future named point attributes slot in as extra columns with no consumer
// changes.

import type { ListValue, PointsValue, SocketValue, SplineValue } from "./types";
import { describeListItem, listItemType } from "./list-value";
import { is3DPoints } from "./points";

export interface TableColumn {
  // Stable id ("x", "scale.x", …) — safe to key React rows/cells on.
  key: string;
  // Header text.
  label: string;
  // Display hint: "index" = the row-identity column (left-aligned integer),
  // "number" = numeric (right-aligned), "angle" = radians (UI shows
  // degrees), "text" = string, "color" = a CSS color string the UI
  // renders as a swatch (color-tagged point attributes).
  kind: "index" | "number" | "angle" | "text" | "color";
  // Present ⇔ the column is authored-space normalized [0,1]² and a pixel
  // units toggle may scale it by canvas width ("norm-x") / height ("norm-y").
  space?: "norm-x" | "norm-y";
  get(row: number): number | string | null;
}

export interface TableModel {
  // The projected value's socket kind, for the panel header.
  kind: string;
  rowCount: number;
  columns: TableColumn[];
}

// null ⇒ the value has no tabular projection (the UI falls back to a
// one-line summary). Extend the switch to add a kind — keep the projection
// lazy and allocation-free per the header comment.
export function tableForValue(
  value: SocketValue | null | undefined
): TableModel | null {
  if (!value) return null;
  switch (value.kind) {
    case "points":
      return pointsTable(value);
    case "spline":
      return splineTable(value);
    case "list":
      return listTable(value);
    default:
      return null;
  }
}

function num(
  key: string,
  label: string,
  get: (row: number) => number | null,
  space?: TableColumn["space"]
): TableColumn {
  return { key, label, kind: "number", space, get };
}

const INDEX_COL: TableColumn = {
  key: "index",
  label: "index",
  kind: "index",
  get: (row) => row,
};

function pointsTable(v: PointsValue): TableModel {
  const three = is3DPoints(v);
  const { positions, scales, rotations, groupIndices, z, normals } = v;
  const cols: TableColumn[] = [INDEX_COL];
  // 2D positions are authored space; 3D (z present) are world meters.
  cols.push(
    num("x", "x", (i) => positions[i * 2], three ? undefined : "norm-x"),
    num("y", "y", (i) => positions[i * 2 + 1], three ? undefined : "norm-y")
  );
  if (z) cols.push(num("z", "z", (i) => z[i]));
  if (scales) {
    cols.push(
      num("scale.x", "scale x", (i) => scales[i * 2]),
      num("scale.y", "scale y", (i) => scales[i * 2 + 1])
    );
  }
  if (rotations) {
    cols.push({
      key: "rotation",
      label: "rotation",
      kind: "angle",
      get: (i) => rotations[i],
    });
  }
  if (groupIndices) cols.push(num("group", "group", (i) => groupIndices[i]));
  if (normals) {
    cols.push(
      num("nx", "nx", (i) => normals[i * 3]),
      num("ny", "ny", (i) => normals[i * 3 + 1]),
      num("nz", "nz", (i) => normals[i * 3 + 2])
    );
  }
  // Named channels append after the fixed schema. Color-tagged channels
  // become one swatch column; other multi-component channels expand into
  // per-component columns.
  if (v.attributes) {
    const AXES = ["x", "y", "z", "w"];
    for (const name of Object.keys(v.attributes)) {
      const a = v.attributes[name];
      if (a.color && a.arity >= 3) {
        const { data, arity } = a;
        cols.push({
          key: `attr:${name}`,
          label: name,
          kind: "color",
          get: (i) => {
            const c = (ch: number) =>
              Math.round(Math.min(1, Math.max(0, data[i * arity + ch])) * 255);
            const alpha =
              arity === 4
                ? Math.min(1, Math.max(0, data[i * arity + 3]))
                : 1;
            return `rgba(${c(0)}, ${c(1)}, ${c(2)}, ${alpha})`;
          },
        });
      } else if (a.arity === 1) {
        cols.push(num(`attr:${name}`, name, (i) => a.data[i]));
      } else {
        for (let c = 0; c < a.arity; c++) {
          cols.push(
            num(
              `attr:${name}.${AXES[c]}`,
              `${name}.${AXES[c]}`,
              (i) => a.data[i * a.arity + c]
            )
          );
        }
      }
    }
  }
  return { kind: three ? "points3d" : "points", rowCount: v.count, columns: cols };
}

// One row per anchor across all subpaths. Row → (subpath, anchor) resolves
// through prefix sums + binary search, memoized on the last row asked —
// the grid reads row-major, so sibling cells hit the memo.
function splineTable(v: SplineValue): TableModel {
  const subs = v.subpaths;
  const starts = new Array<number>(subs.length);
  let total = 0;
  for (let s = 0; s < subs.length; s++) {
    starts[s] = total;
    total += subs[s].anchors.length;
  }
  let lastRow = -1;
  let lastSub = 0;
  const locate = (row: number) => {
    if (row !== lastRow) {
      let lo = 0;
      let hi = subs.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (starts[mid] <= row) lo = mid;
        else hi = mid - 1;
      }
      lastRow = row;
      lastSub = lo;
    }
    return { sub: lastSub, anchor: subs[lastSub].anchors[row - starts[lastSub]] };
  };
  const hasGroup = subs.some((s) => s.groupIndex !== undefined);
  const cols: TableColumn[] = [
    INDEX_COL,
    num("subpath", "subpath", (row) => locate(row).sub),
    num("x", "x", (row) => locate(row).anchor.pos[0], "norm-x"),
    num("y", "y", (row) => locate(row).anchor.pos[1], "norm-y"),
    num("in.x", "in x", (row) => locate(row).anchor.inHandle?.[0] ?? null, "norm-x"),
    num("in.y", "in y", (row) => locate(row).anchor.inHandle?.[1] ?? null, "norm-y"),
    num("out.x", "out x", (row) => locate(row).anchor.outHandle?.[0] ?? null, "norm-x"),
    num("out.y", "out y", (row) => locate(row).anchor.outHandle?.[1] ?? null, "norm-y"),
  ];
  if (hasGroup) {
    cols.push(num("group", "group", (row) => subs[locate(row).sub].groupIndex ?? null));
  }
  // Named channels (M3): anchor-domain first, then subpath-domain (its
  // value repeats across the subpath's anchors, like `group`). Scalar
  // values are numeric cells; arrays print as text — spline attrs carry
  // no color tag, so no swatches here.
  const fmtAttr = (v: number | number[] | undefined): number | string | null =>
    v === undefined ? null : typeof v === "number" ? v : `[${v.join(", ")}]`;
  const anchorNames = new Set<string>();
  const subNames = new Set<string>();
  for (const s of subs) {
    if (s.attrs) for (const k of Object.keys(s.attrs)) subNames.add(k);
    for (const a of s.anchors) {
      if (a.attrs) for (const k of Object.keys(a.attrs)) anchorNames.add(k);
    }
  }
  for (const name of anchorNames) {
    cols.push({
      key: `attr:${name}`,
      label: name,
      kind: "number",
      get: (row) => fmtAttr(locate(row).anchor.attrs?.[name]),
    });
  }
  for (const name of subNames) {
    cols.push({
      key: `subattr:${name}`,
      label: `${name} (subpath)`,
      kind: "number",
      get: (row) => fmtAttr(subs[locate(row).sub].attrs?.[name]),
    });
  }
  return { kind: "spline", rowCount: total, columns: cols };
}

// Homogeneous scalar / vec / string lists get real value columns; anything
// else (mixed or non-numeric kinds) reads as type + one-line summary.
// Items are BORROWED (list-value.ts contract) — display only, no releases.
function listTable(v: ListValue): TableModel {
  const items = v.items;
  const itemType = listItemType(v);
  const cols: TableColumn[] = [INDEX_COL];
  if (itemType === "scalar") {
    cols.push(
      num("value", "value", (i) => (items[i] as { value: number }).value)
    );
  } else if (itemType === "vec2" || itemType === "vec3" || itemType === "vec4") {
    const axes = ["x", "y", "z", "w"].slice(
      0,
      itemType === "vec2" ? 2 : itemType === "vec3" ? 3 : 4
    );
    for (let a = 0; a < axes.length; a++) {
      cols.push(
        num(axes[a], axes[a], (i) => (items[i] as { value: number[] }).value[a])
      );
    }
  } else if (itemType === "string") {
    cols.push({
      key: "value",
      label: "value",
      kind: "text",
      get: (i) => (items[i] as { value: string }).value,
    });
  } else {
    cols.push(
      { key: "type", label: "type", kind: "text", get: (i) => items[i].kind },
      { key: "value", label: "value", kind: "text", get: (i) => describeListItem(items[i]) }
    );
  }
  return { kind: "list", rowCount: items.length, columns: cols };
}
