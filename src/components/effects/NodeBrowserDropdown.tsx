"use client";

import { useMemo } from "react";
import { allNodeDefs } from "@/engine/registry";
import type { NodeCategory, NodeSubcategory } from "@/engine/types";

// Menu-bar dropdown that enumerates every registered node. Typed
// categories (image/spline/point/audio) render as a column with a
// Generator / Modifier / Utility tri-fold beneath the header; flat
// categories (utility/effect/output) render as a single list under
// the header. Column order is deliberately pipeline-shaped:
// generators first, modifiers in the middle, sinks on the right.

interface Props {
  onAdd: (type: string) => void;
  onClose: () => void;
}

interface NodeEntry {
  type: string;
  name: string;
  category: NodeCategory;
  subcategory?: NodeSubcategory;
}

// Display order for the top-level category columns.
const CATEGORY_ORDER: NodeCategory[] = [
  "image",
  "spline",
  "point",
  "audio",
  "utility",
  "effect",
  "output",
];

// Display labels (so we can capitalize / rename without touching
// the underlying category strings).
const CATEGORY_LABEL: Record<NodeCategory, string> = {
  image: "Image",
  spline: "Spline",
  point: "Point",
  audio: "Audio",
  utility: "Utility",
  effect: "Effect",
  output: "Output",
};

const SUB_ORDER: NodeSubcategory[] = ["generator", "modifier", "utility"];
const SUB_LABEL: Record<NodeSubcategory, string> = {
  generator: "Generator",
  modifier: "Modifier",
  utility: "Utility",
};

// Categories that render with the subcategory tri-fold. Everything
// else renders flat.
const TYPED_CATEGORIES: ReadonlySet<NodeCategory> = new Set([
  "image",
  "spline",
  "point",
  "audio",
]);

export default function NodeBrowserDropdown({ onAdd, onClose }: Props) {
  const entries = useMemo<NodeEntry[]>(() => {
    // Same filter as NodeSearchPopup: hide the standalone Simulation
    // Start / End defs, surface the compound "simulation-zone" entry
    // instead. That compound lands in top-level Effect.
    const real = allNodeDefs().filter(
      (d) => d.type !== "simulation-start" && d.type !== "simulation-end"
    );
    const list: NodeEntry[] = real.map((d) => ({
      type: d.type,
      name: d.name,
      category: d.category,
      subcategory: d.subcategory,
    }));
    list.push({
      type: "simulation-zone",
      name: "Simulation Zone",
      category: "effect",
    });
    return list;
  }, []);

  const byCategory = useMemo(() => {
    const m: Partial<Record<NodeCategory, NodeEntry[]>> = {};
    for (const e of entries) (m[e.category] ??= []).push(e);
    for (const list of Object.values(m))
      list?.sort((a, b) => a.name.localeCompare(b.name));
    return m;
  }, [entries]);

  const columns = CATEGORY_ORDER.filter((c) => byCategory[c]?.length);

  return (
    <div
      style={{
        position: "absolute",
        top: "100%",
        left: 0,
        background: "#18181b",
        border: "1px solid #27272a",
        borderRadius: 4,
        boxShadow: "0 6px 20px rgba(0,0,0,0.5)",
        padding: 6,
        marginTop: 2,
        display: "flex",
        gap: 2,
        maxHeight: 560,
      }}
    >
      {columns.map((cat) => {
        const list = byCategory[cat] ?? [];
        const typed = TYPED_CATEGORIES.has(cat);
        return (
          <div
            key={cat}
            style={{
              minWidth: 150,
              display: "flex",
              flexDirection: "column",
            }}
          >
            <ColumnHeader>{CATEGORY_LABEL[cat]}</ColumnHeader>
            <div
              style={{
                flex: 1,
                overflowY: "auto",
                paddingRight: 2,
              }}
              className="thin-scrollbar"
            >
              {typed ? (
                <TypedColumnBody
                  list={list}
                  onAdd={onAdd}
                  onClose={onClose}
                />
              ) : (
                list.map((d) => (
                  <NodeRow
                    key={d.type}
                    label={d.name}
                    onClick={() => {
                      onAdd(d.type);
                      onClose();
                    }}
                  />
                ))
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function TypedColumnBody({
  list,
  onAdd,
  onClose,
}: {
  list: NodeEntry[];
  onAdd: (type: string) => void;
  onClose: () => void;
}) {
  const bySub: Partial<Record<NodeSubcategory, NodeEntry[]>> = {};
  for (const e of list) {
    // Everything in a typed column should carry a subcategory; fall
    // back to "utility" for any outlier so the node doesn't vanish.
    const sub: NodeSubcategory = e.subcategory ?? "utility";
    (bySub[sub] ??= []).push(e);
  }
  const subs = SUB_ORDER.filter((s) => bySub[s]?.length);
  return (
    <>
      {subs.map((sub, i) => (
        <div key={sub} style={{ marginTop: i === 0 ? 0 : 6 }}>
          <SubHeader>{SUB_LABEL[sub]}</SubHeader>
          {bySub[sub]!.map((d) => (
            <NodeRow
              key={d.type}
              label={d.name}
              onClick={() => {
                onAdd(d.type);
                onClose();
              }}
            />
          ))}
        </div>
      ))}
    </>
  );
}

function ColumnHeader({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        padding: "4px 10px",
        color: "#e5e7eb",
        fontSize: 10,
        textTransform: "uppercase",
        letterSpacing: 0.5,
        borderBottom: "1px solid #27272a",
        marginBottom: 2,
        fontWeight: 600,
      }}
    >
      {children}
    </div>
  );
}

function SubHeader({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        padding: "4px 10px 2px 10px",
        color: "#71717a",
        fontSize: 9,
        textTransform: "uppercase",
        letterSpacing: 0.4,
      }}
    >
      {children}
    </div>
  );
}

function NodeRow({
  label,
  onClick,
}: {
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      onMouseEnter={(e) => (e.currentTarget.style.background = "#1e3a8a")}
      onMouseLeave={(e) =>
        (e.currentTarget.style.background = "transparent")
      }
      style={{
        display: "block",
        width: "100%",
        padding: "3px 10px",
        background: "transparent",
        border: "none",
        color: "#e5e7eb",
        textAlign: "left",
        fontFamily: "inherit",
        fontSize: 11,
        cursor: "default",
        borderRadius: 3,
        whiteSpace: "nowrap",
        overflow: "hidden",
        textOverflow: "ellipsis",
      }}
    >
      {label}
    </button>
  );
}
