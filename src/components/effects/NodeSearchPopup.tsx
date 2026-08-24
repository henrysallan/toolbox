"use client";

import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { allNodeDefs } from "@/engine/registry";
import { PRESETS } from "@/state/presets";
import {
  removeUserNodePreset,
  useUserNodePresets,
} from "@/state/node-presets";
import { fuzzyScoreFields } from "@/lib/fuzzy-search";
import { isAgentAvailable } from "@/lib/agent-bridge";
import type { NodeCategory, NodeSubcategory } from "@/engine/types";

// Display order + labels mirror NodeBrowserDropdown so the two add-
// paths feel like one product.
const CATEGORY_ORDER: NodeCategory[] = [
  "image",
  "spline",
  "point",
  "audio",
  "3d",
  "utility",
  "effect",
  "output",
];
const CATEGORY_LABEL: Record<NodeCategory, string> = {
  image: "Image",
  spline: "Spline",
  point: "Point",
  audio: "Audio",
  "3d": "3D",
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

// Preset entries surface under a pseudo-category "presets" — they're canned
// subgraphs, not node defs, and onAdd routes "preset:<id>" specially.
function presetDefs(): {
  type: string;
  name: string;
  category: string;
  description: string;
}[] {
  return PRESETS.map((p) => ({
    type: `preset:${p.id}`,
    name: p.name,
    category: "presets",
    description: p.description,
  }));
}

const labelFor = (c: string): string =>
  c === "presets" ? "Presets" : CATEGORY_LABEL[c as NodeCategory] ?? c;

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
  // Root scope is a strict layer chain — when the editor is at root the
  // popup offers only the Layer compound entry.
  atRoot?: boolean;
}

export default function NodeSearchPopup({
  x,
  y,
  onAdd,
  onClose,
  initialQuery = "",
  atRoot,
}: Props) {
  const [query, setQuery] = useState(initialQuery);
  const userPresets = useUserNodePresets();
  const [hoveredCategory, setHoveredCategory] = useState<string | null>(null);
  const [activeMatchIdx, setActiveMatchIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  // Screen placement. (x, y) is only the anchor — the popup may open
  // up/left from it instead of down/right when the cursor sits near a
  // viewport edge, and is always clamped fully on-screen. Measured
  // against the popup's own window so popped-out panels clamp to their
  // own bounds, and re-run via ResizeObserver because the popup changes
  // size as the query / hovered category changes.
  //
  // The flip decision is locked on the first measurement: once open the
  // popup grows/shrinks in place (the clamp still slides it as needed)
  // instead of jumping between above/below the cursor while typing.
  const [pos, setPos] = useState<{ left: number; top: number }>({
    left: x,
    top: y,
  });
  const flipRef = useRef<{ left: boolean; up: boolean } | null>(null);
  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    flipRef.current = null;
    const place = () => {
      const win = el.ownerDocument.defaultView ?? window;
      const vw = win.innerWidth;
      const vh = win.innerHeight;
      const w = el.offsetWidth;
      const h = el.offsetHeight;
      const MARGIN = 8;
      const flip = (flipRef.current ??= {
        left: x + w + MARGIN > vw,
        up: y + h + MARGIN > vh,
      });
      // Flipped, the popup's far edge lands just shy of the anchor so
      // the cursor stays outside it — mirroring the parent's +4 nudge.
      let left = flip.left ? x - w - 8 : x;
      let top = flip.up ? y - h - 8 : y;
      left = Math.max(MARGIN, Math.min(left, vw - w - MARGIN));
      top = Math.max(MARGIN, Math.min(top, vh - h - MARGIN));
      setPos({ left, top });
    };
    place();
    const ro = new ResizeObserver(place);
    ro.observe(el);
    return () => ro.disconnect();
  }, [x, y]);

  // Saved user presets join the same "presets" pseudo-category; onAdd
  // routes "user-preset:<id>" specially (081226_user-node-presets.md).
  const userPresetRows = useMemo(
    () =>
      userPresets.map((p) => ({
        type: `user-preset:${p.id}`,
        name: p.name,
        category: "presets",
        description: "Saved node preset — inserts the node exactly as saved.",
      })),
    [userPresets]
  );

  const defs = useMemo(() => {
    // Pull every registered node definition AND append compound entries —
    // pseudo-types that the parent's onAdd handler special-cases. Today
    // there's just "simulation-zone" which creates a Start/End pair with
    // a shared zone_id. We hide the individual Simulation Start / End
    // node defs from the menu so users can't create orphans.
    const real = allNodeDefs().filter(
      (d) =>
        !d.hidden &&
        d.type !== "simulation-start" &&
        d.type !== "simulation-end"
    );
    // AI Recipe: a pseudo-entry. onAdd routes "ai-recipe" to a prompt modal
    // that generates a node-group from a text description. Lives with presets.
    const aiRecipe = {
      type: "ai-recipe",
      name: "AI Recipe…",
      category: "presets",
      description: "Describe a node group in words and generate it with AI.",
    } as unknown as (typeof real)[number];
    // Assistant: the same pseudo-entry trick. onAdd routes "agent" to the
    // in-app agent session, which builds and iterates on graphs by looking
    // at what it made (spec 080826_claude-agent-panel.md).
    //
    // Omitted where it can't run (hosted web): it needs an agent host on the
    // user's own machine. AI Recipe above is unaffected — different feature,
    // different billing, works everywhere.
    const assistant = isAgentAvailable()
      ? ({
          type: "agent",
          name: "Assistant…",
          category: "presets",
          description:
            "Describe what you want and have Claude build it, look at the result, and refine.",
        } as unknown as (typeof real)[number])
      : null;
    // Strict root: layers (the compositing chain) and Render Queue live
    // at root scope.
    if (atRoot) {
      return [
        {
          type: "layer",
          name: "Layer",
          category: "utility",
          description:
            "A new layer on top of the compositing stack. Dive in (Tab / double-click) to build its contents.",
        } as unknown as (typeof real)[number],
        {
          type: "render-queue",
          name: "Render Queue",
          category: "output",
          description:
            "Collects Output nodes into an ordered batch render.",
        } as unknown as (typeof real)[number],
        aiRecipe,
        ...(assistant ? [assistant] : []),
        ...(presetDefs() as unknown as (typeof real)[number][]),
        ...(userPresetRows as unknown as (typeof real)[number][]),
      ];
    }
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
      {
        type: "iterate",
        name: "Iterate",
        category: "utility",
        description:
          "A zone that evaluates the nodes inside it K times, collecting the results as variants (an image group or grouped spline/points). Wire its index / t / random into exposed params to vary each iteration.",
      } as unknown as (typeof real)[number],
      aiRecipe,
      ...(assistant ? [assistant] : []),
      ...(presetDefs() as unknown as (typeof real)[number][]),
      ...(userPresetRows as unknown as (typeof real)[number][]),
    ];
  }, [atRoot, userPresetRows]);
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
      [...CATEGORY_ORDER, "presets"].filter(
        (c) => (byCategory[c]?.length ?? 0) > 0
      ),
    [byCategory]
  );

  const normalized = query.trim().toLowerCase();
  const flatMatches = useMemo(() => {
    if (!normalized) return [];
    // Fuzzy match against name/type/aliases/category, best score first —
    // typos ("guassian"), abbreviations ("rastspline"), and split tokens
    // ("part sim") all land. Category hits weigh least so typing a
    // category name lists its nodes after any name/type matches.
    const scored: { def: (typeof defs)[number]; score: number }[] = [];
    for (const d of defs) {
      const score = fuzzyScoreFields(normalized, [
        { text: d.name, weight: 1 },
        { text: d.type, weight: 0.9 },
        ...(d.searchAliases ?? []).map((text) => ({ text, weight: 0.9 })),
        { text: d.category, weight: 0.5 },
      ]);
      if (score !== null) scored.push({ def: d, score });
    }
    scored.sort(
      (a, b) => b.score - a.score || a.def.name.localeCompare(b.def.name)
    );
    return scored.map((e) => e.def);
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
      ref={rootRef}
      data-node-search-popup
      // mousedown inside the popup must not propagate out, or the
      // global dismiss-on-click-outside handler would also fire.
      onMouseDown={(e) => e.stopPropagation()}
      style={{
        position: "fixed",
        left: pos.left,
        top: pos.top,
        display: "flex",
        gap: 0,
        background: "var(--tb-n-0)",
        border: "1px solid var(--tb-n-7)",
        borderRadius: 6,
        boxShadow: "0 8px 24px rgba(0, 0, 0, 0.5)",
        padding: 6,
        zIndex: 3000,
        fontFamily: "var(--ui-font)",
        fontSize: 11,
        color: "var(--tb-n-16)",
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
            background: "var(--tb-n-3)",
            border: "1px solid var(--tb-n-7)",
            borderRadius: 4,
            color: "var(--tb-n-16)",
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
                    background: active ? "var(--tb-a-blue-900)" : "transparent",
                    color: active ? "var(--tb-t-sky-l-1)" : "var(--tb-n-16)",
                    borderRadius: 3,
                    cursor: "default",
                  }}
                >
                  <span>{labelFor(cat)}</span>
                  <span style={{ color: active ? "var(--tb-a-blue-200)" : "var(--tb-n-10)" }}>
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
          borderLeft: "1px solid var(--tb-n-7)",
          display: "flex",
          flexDirection: "column",
        }}
      >
        {(() => {
          if (rightColumnNodes.length === 0) {
            return (
              <div style={{ color: "var(--tb-n-10)", padding: "4px 2px" }}>
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
            const userPresetId = def.type.startsWith("user-preset:")
              ? def.type.slice("user-preset:".length)
              : null;
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
                  background: highlight ? "var(--tb-a-blue-900)" : "transparent",
                  color: highlight ? "var(--tb-t-sky-l-1)" : "var(--tb-n-16)",
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
                      "var(--tb-n-3)";
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
                <span
                  style={{ display: "flex", alignItems: "center", gap: 6 }}
                >
                  {normalized && (
                    <span style={{ color: "var(--tb-n-10)", fontSize: 10 }}>
                      {labelFor(def.category)}
                    </span>
                  )}
                  {userPresetId && (
                    <span
                      title="Delete preset"
                      onClick={(e) => {
                        // Row button's onClick would insert the preset.
                        e.stopPropagation();
                        removeUserNodePreset(userPresetId);
                      }}
                      onMouseEnter={(e) => {
                        (e.currentTarget as HTMLSpanElement).style.color =
                          "var(--tb-a-red-500)";
                      }}
                      onMouseLeave={(e) => {
                        (e.currentTarget as HTMLSpanElement).style.color =
                          "var(--tb-n-10)";
                      }}
                      style={{
                        color: "var(--tb-n-10)",
                        fontSize: 11,
                        lineHeight: 1,
                        padding: "0 2px",
                      }}
                    >
                      ×
                    </span>
                  )}
                </span>
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
                    color: "var(--tb-n-11)",
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
