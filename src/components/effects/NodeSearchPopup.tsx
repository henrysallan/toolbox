"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { allNodeDefs } from "@/engine/registry";
import type { NodeCategory, NodeSubcategory } from "@/engine/types";

// Display order + labels mirror NodeBrowserDropdown so the two add-
// paths feel like one product.
const CATEGORY_ORDER: NodeCategory[] = [
  "image",
  "spline",
  "point",
  "audio",
  "utility",
  "effect",
  "output",
];
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
const TYPED_CATEGORIES: ReadonlySet<NodeCategory> = new Set([
  "image",
  "spline",
  "point",
  "audio",
]);

// Floating "add node" browser. Two modes:
//
//   1. Empty search: a tall column shows category names. Hovering a
//      category reveals a flyout to its right listing every node in
//      that category. Moving across categories updates the flyout;
//      moving between a category row and the flyout without leaving
//      the popup keeps it open.
//
//   2. Typing a query: categories disappear and the flyout column
//      shows a ranked flat list across every category. Enter picks
//      the first match, Esc dismisses.
//
// Dismisses on: click outside, Esc, or after picking a node.

interface Props {
  // Client (screen) pixel position where the popup's top-left anchors.
  // Nudged slightly so the popup isn't covered by the cursor — small
  // offset feels more natural than anchoring exactly at the tip.
  x: number;
  y: number;
  onAdd: (type: string) => void;
  onClose: () => void;
  // Pre-seeded search query. When we open after an unconnected-wire
  // drop we could use this to filter to compatible types; today we
  // always open blank but keep the hook.
  initialQuery?: string;
}

export default function NodeSearchPopup({
  x,
  y,
  onAdd,
  onClose,
  initialQuery = "",
}: Props) {
  const [query, setQuery] = useState(initialQuery);
  const [hoveredCategory, setHoveredCategory] = useState<string | null>(null);
  const [activeMatchIdx, setActiveMatchIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const defs = useMemo(() => {
    // Pull every registered node definition AND append compound entries —
    // pseudo-types that the parent's onAdd handler special-cases. Today
    // there's just "simulation-zone" which creates a Start/End pair with
    // a shared zone_id. We hide the individual Simulation Start / End
    // node defs from the menu so users can't create orphans.
    const real = allNodeDefs().filter(
      (d) => d.type !== "simulation-start" && d.type !== "simulation-end"
    );
    return [
      ...real,
      {
        type: "simulation-zone",
        name: "Simulation Zone",
        category: "effect",
        description: "Feedback loop — pairs a Start and End node.",
        // Casts to satisfy the rest of NodeDefinition's required fields
        // when iterated; nothing else touches them.
      } as unknown as (typeof real)[number],
    ];
  }, []);
  const byCategory = useMemo(() => {
    const m: Record<string, typeof defs> = {};
    for (const d of defs) (m[d.category] ??= []).push(d);
    for (const list of Object.values(m)) {
      list.sort((a, b) => a.name.localeCompare(b.name));
    }
    return m;
  }, [defs]);
  const categories = useMemo(
    () =>
      CATEGORY_ORDER.filter(
        (c) => (byCategory[c as NodeCategory]?.length ?? 0) > 0
      ),
    [byCategory]
  );

  const normalized = query.trim().toLowerCase();
  const flatMatches = useMemo(() => {
    if (!normalized) return [];
    return defs
      .filter(
        (d) =>
          d.name.toLowerCase().includes(normalized) ||
          d.type.toLowerCase().includes(normalized) ||
          d.category.toLowerCase().includes(normalized)
      )
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [defs, normalized]);

  // On mount: autofocus the input. Ensures Shift+A users can type
  // immediately without clicking.
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  // Default the hovered category to the first one when the popup opens
  // with no query — gives the flyout something to show without needing
  // a mouse hover on startup.
  useEffect(() => {
    if (!normalized && categories.length > 0 && !hoveredCategory) {
      setHoveredCategory(categories[0]);
    }
  }, [normalized, categories, hoveredCategory]);

  // Reset the keyboard cursor when search results change — keeps the
  // highlighted row on the first match.
  useEffect(() => {
    setActiveMatchIdx(0);
  }, [normalized]);

  // Dismiss on Escape or click outside. Capture phase so we beat any
  // React Flow handlers that might fire on the same event.
  useEffect(() => {
    const onKey = (e: KeyboardEvent | globalThis.KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    const onDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      if (!t?.closest?.("[data-node-search-popup]")) onClose();
    };
    window.addEventListener("keydown", onKey as EventListener, true);
    window.addEventListener("mousedown", onDown, true);
    return () => {
      window.removeEventListener("keydown", onKey as EventListener, true);
      window.removeEventListener("mousedown", onDown, true);
    };
  }, [onClose]);

  const handleAdd = (type: string) => {
    onAdd(type);
    onClose();
  };

  const onInputKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && flatMatches.length > 0) {
      handleAdd(
        flatMatches[Math.min(activeMatchIdx, flatMatches.length - 1)].type
      );
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveMatchIdx((i) => Math.min(i + 1, flatMatches.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveMatchIdx((i) => Math.max(i - 1, 0));
    }
  };

  const rightColumnNodes =
    normalized ? flatMatches : hoveredCategory ? byCategory[hoveredCategory] : [];

  return (
    <div
      data-node-search-popup
      // mousedown inside the popup must not propagate out, or the
      // global dismiss-on-click-outside handler would also fire.
      onMouseDown={(e) => e.stopPropagation()}
      style={{
        position: "fixed",
        left: x,
        top: y,
        display: "flex",
        gap: 0,
        background: "#0a0a0a",
        border: "1px solid #27272a",
        borderRadius: 6,
        boxShadow: "0 8px 24px rgba(0, 0, 0, 0.5)",
        padding: 6,
        zIndex: 3000,
        fontFamily: "ui-monospace, monospace",
        fontSize: 11,
        color: "#e5e7eb",
        userSelect: "none",
      }}
    >
      {/* Left column: search input + categories (or just search when
          a query is active, since the flat match list replaces the
          category browser). */}
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          minWidth: 150,
        }}
      >
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onInputKeyDown}
          placeholder="search nodes…"
          style={{
            background: "#18181b",
            border: "1px solid #27272a",
            borderRadius: 4,
            color: "#e5e7eb",
            fontFamily: "inherit",
            fontSize: 11,
            padding: "4px 6px",
            outline: "none",
            width: "100%",
            boxSizing: "border-box",
          }}
        />
        {!normalized && (
          <div style={{ marginTop: 4 }}>
            {categories.map((cat) => {
              const active = hoveredCategory === cat;
              return (
                <div
                  key={cat}
                  onMouseEnter={() => setHoveredCategory(cat)}
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    padding: "4px 6px",
                    background: active ? "#1e3a8a" : "transparent",
                    color: active ? "#f0f9ff" : "#e5e7eb",
                    borderRadius: 3,
                    cursor: "default",
                  }}
                >
                  <span>{CATEGORY_LABEL[cat as NodeCategory] ?? cat}</span>
                  <span style={{ color: active ? "#bfdbfe" : "#52525b" }}>
                    ▶
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Right column: nodes in the hovered category (or flat search
          matches when there's a query). Persistent — the popup sizes
          itself to fit both columns so switching categories doesn't
          reflow. Empty space when no hover + empty search, which only
          happens momentarily before `hoveredCategory` initializes. */}
      <div
        className="thin-scrollbar"
        style={{
          marginLeft: 6,
          minWidth: 200,
          maxHeight: 360,
          overflowY: "auto",
          paddingLeft: 6,
          borderLeft: "1px solid #27272a",
          display: "flex",
          flexDirection: "column",
        }}
      >
        {(() => {
          if (rightColumnNodes.length === 0) {
            return (
              <div style={{ color: "#52525b", padding: "4px 2px" }}>
                {normalized ? "no matches" : ""}
              </div>
            );
          }
          // Renders a single node row. `flatIdx` is the position in
          // the flat search list, used for keyboard cursor highlight
          // when a query is active. Null when we're in browse mode.
          const renderRow = (
            def: (typeof defs)[number],
            flatIdx: number | null,
            isFirst: boolean
          ) => {
            const highlight =
              !!normalized && flatIdx !== null && flatIdx === activeMatchIdx;
            return (
              <button
                key={def.type}
                onMouseEnter={() => {
                  if (normalized && flatIdx !== null) setActiveMatchIdx(flatIdx);
                }}
                onClick={() => handleAdd(def.type)}
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  padding: "4px 6px",
                  marginTop: isFirst ? 0 : 2,
                  background: highlight ? "#1e3a8a" : "transparent",
                  color: highlight ? "#f0f9ff" : "#e5e7eb",
                  border: "none",
                  borderRadius: 3,
                  fontFamily: "inherit",
                  fontSize: 11,
                  cursor: "pointer",
                  textAlign: "left",
                }}
                onMouseOver={(e) => {
                  if (!highlight) {
                    (e.currentTarget as HTMLButtonElement).style.background =
                      "#18181b";
                  }
                }}
                onMouseOut={(e) => {
                  if (!highlight) {
                    (e.currentTarget as HTMLButtonElement).style.background =
                      "transparent";
                  }
                }}
              >
                <span>{def.name}</span>
                {normalized && (
                  <span style={{ color: "#52525b", fontSize: 10 }}>
                    {CATEGORY_LABEL[def.category as NodeCategory] ??
                      def.category}
                  </span>
                )}
              </button>
            );
          };
          // Browse mode, typed category: interleave subcategory
          // headers above their node groups so users can distinguish
          // e.g. Image Generator from Image Modifier.
          if (
            !normalized &&
            hoveredCategory &&
            TYPED_CATEGORIES.has(hoveredCategory as NodeCategory)
          ) {
            const bySub: Partial<Record<NodeSubcategory, typeof defs>> = {};
            for (const d of rightColumnNodes) {
              const sub =
                (d as unknown as { subcategory?: NodeSubcategory })
                  .subcategory ?? "utility";
              (bySub[sub] ??= []).push(d);
            }
            const subs = SUB_ORDER.filter((s) => bySub[s]?.length);
            return subs.map((sub, groupIdx) => (
              <div key={sub} style={{ marginTop: groupIdx === 0 ? 0 : 6 }}>
                <div
                  style={{
                    padding: "2px 6px",
                    color: "#71717a",
                    fontSize: 9,
                    textTransform: "uppercase",
                    letterSpacing: 0.4,
                  }}
                >
                  {SUB_LABEL[sub]}
                </div>
                {bySub[sub]!.map((def, i) => renderRow(def, null, i === 0))}
              </div>
            ));
          }
          // Search mode or flat-category browse: plain list.
          return rightColumnNodes.map((def, i) =>
            renderRow(def, normalized ? i : null, i === 0)
          );
        })()}
      </div>
    </div>
  );
}
