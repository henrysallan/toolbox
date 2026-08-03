import React, { useCallback, useMemo, useRef, useState } from "react";
import type {
  LayoutTree,
  LayoutRect,
  PanelKind,
  DividerDesc,
} from "./model";
import { computeRects, joinRemovedLeaves, MIN_PANEL_PX } from "./model";
import { useCoarsePointer } from "@/lib/pointer-drag";

// Blender-style panel chrome (moved here from EffectsApp with the
// tiling work — the tiled region owns the seams now). Each editor area
// is a thin bordered, slightly rounded rect; areas are separated by a
// tiny gutter that doubles (invisibly) as the resize handle.
export const PANEL_GAP = 3;
// Resize grab zone width. Wider than the visible gap so it's easy to
// grab; it overlaps the neighbouring panel edges (they render under
// it), so the *visible* gap stays PANEL_GAP.
export const GUTTER_HIT = 11;
// Same zone sized for a fingertip. iPad is the reason: 11px of seam is a
// fine mouse target and an impossible touch one. Both are invisible
// overlays, so widening costs no layout — it only means a bit more of the
// panel edge reads as "grab the seam" on a touch primary.
export const GUTTER_HIT_COARSE = 24;
export const PANEL_FRAME: React.CSSProperties = {
  border: "1px solid var(--tb-n-6)",
  borderRadius: 5,
  overflow: "hidden",
};

// Fraction-space edge test tolerance.
const EDGE = 1e-4;

// ---- corner split gesture (M2 — spec §4a) --------------------------------

type Corner = "nw" | "ne" | "sw" | "se";
const CORNERS: Corner[] = ["nw", "ne", "sw", "se"];
// Side length of the invisible corner hotspots (crosshair cursor).
const CORNER_HIT = 12;
const CORNER_HIT_COARSE = 26;
// Drag distance before the gesture locks its axis / intent.
const AXIS_LOCK_PX = 12;

interface GestureTarget {
  id: string;
  panel: PanelKind;
  left: number;
  top: number;
  width: number;
  height: number;
}

interface CornerGesture {
  leafId: string;
  corner: Corner;
  startX: number;
  startY: number;
  // Container origin in client px, measured once at gesture start.
  contLeft: number;
  contTop: number;
  // The grabbed leaf's rect in CONTAINER-relative px.
  leafPx: { left: number; top: number; width: number; height: number };
  // Every leaf's container-relative px rect + kind, frozen at gesture
  // start (the tree can't change mid-gesture) — join hit-testing.
  targets: GestureTarget[];
  // Locked split direction; null until the drag passes AXIS_LOCK_PX.
  dir: "row" | "col" | null;
  // Locked the other way: the drag crossed OUT of the leaf — join/swap
  // mode (M3 — spec §4b). Center of the hovered leaf = swap; sides =
  // merge (the source's side of the lowest separating split swallows
  // the other side).
  outward: boolean;
  join: {
    targetId: string | null;
    mode: "swap" | "merge" | null;
  };
  // True while the split preview shows a committable seam; cleared when
  // the cursor parks back in the origin gutter (SPLIT_CANCEL_PX).
  splitArmed: boolean;
  ratio: number;
}

// Inner fraction of a target leaf that reads as its "center" (swap
// zone); outside it is the merge zone. 0.45 → 27.5% margins.
const SWAP_CENTER_FRAC = 0.45;

// Returning the cursor to within this band of the origin edge during a
// split disarms it (preview hides, release no-ops) — mirroring how the
// join drag clears when the cursor comes back over the source leaf.
// Dragging inward again re-arms.
const SPLIT_CANCEL_PX = 16;

/**
 * The tiled editor region. Renders the layout tree as FLAT
 * absolutely-positioned siblings — leaves never nest in the DOM, so
 * structural tree changes never reparent (and never remount) panel
 * content; only styles move. Rects are percentages derived from the
 * tree (deterministic under SSR); pixels are only measured inside
 * drag handlers. Spec: specdocs/072726_window-tiling.md §3.
 */
export function LayoutRegion({
  tree,
  soloLeafId,
  onSetRatio,
  onSplitLeaf,
  onSwapLeaves,
  onJoinLeaves,
  renderPanel,
}: {
  tree: LayoutTree;
  /**
   * Full-canvas mode: this leaf fills the region edge-to-edge, all
   * other leaves stay MOUNTED but hidden (display:none) so exiting
   * solo never remounts anything.
   */
  soloLeafId?: string | null;
  onSetRatio: (splitId: string, ratio: number) => void;
  /**
   * Commit a corner-drag split (M2). `ratio` is the first child's
   * share; `firstIsNew` says the new clone lands on the left/top (the
   * gesture grew it out of a west/north corner). Omit to disable the
   * gesture entirely.
   */
  onSplitLeaf?: (
    leafId: string,
    dir: "row" | "col",
    ratio: number,
    firstIsNew: boolean
  ) => void;
  /** Commit a center-zone join drag: the two leaves trade panel kinds. */
  onSwapLeaves?: (leafIdA: string, leafIdB: string) => void;
  /**
   * Commit a side-zone join drag: `keepLeafId`'s side of the lowest
   * separating split swallows the side containing `removeLeafId`
   * (everything the doomed-region preview covered closes).
   */
  onJoinLeaves?: (keepLeafId: string, removeLeafId: string) => void;
  renderPanel: (leafId: string, panel: PanelKind) => React.ReactNode;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const computed = useMemo(() => computeRects(tree), [tree]);

  const startDividerDrag = useCallback(
    (d: DividerDesc, e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const cont = containerRef.current;
    if (!cont) return;
    const cr = cont.getBoundingClientRect();
    const isRow = d.dir === "row";
    const originPx =
      (isRow ? cr.left + d.rect.x * cr.width : cr.top + d.rect.y * cr.height);
    const extentPx = Math.max(
      1,
      isRow ? d.rect.w * cr.width : d.rect.h * cr.height
    );
    // Both children keep at least MIN_PANEL_PX (§9 min sizes — clamped
    // in the op input, never encoded in CSS). Tiny parents fall back to
    // a symmetric clamp so the divider stays draggable.
    const minR = Math.min(0.45, MIN_PANEL_PX / extentPx);
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    document.body.style.cursor = isRow ? "col-resize" : "row-resize";
    document.body.style.userSelect = "none";
    const onMove = (ev: PointerEvent) => {
      const pos = isRow ? ev.clientX : ev.clientY;
      const ratio = Math.max(
        minR,
        Math.min(1 - minR, (pos - originPx) / extentPx)
      );
      onSetRatio(d.splitId, ratio);
      // Overlays cache canvas rects and subscribe to window resize
      // (EffectsApp convention) — keep them tracking during the drag.
      window.dispatchEvent(new Event("resize"));
    };
    const onUp = () => {
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("lostpointercapture", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      window.dispatchEvent(new Event("resize"));
    };
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("lostpointercapture", onUp);
    },
    [onSetRatio]
  );

  // Corner split gesture. Preview (seam + tint over the emerging half)
  // is painted IMPERATIVELY into refs — pointermove never re-renders
  // the panel tree (the useTileDrag ghost rule); React only mounts and
  // unmounts the preview layer (gestureLeafId). The tree is untouched
  // until commit, so Esc-cancel can't leave a half-applied layout.
  const gestureRef = useRef<CornerGesture | null>(null);
  const [gestureLeafId, setGestureLeafId] = useState<string | null>(null);
  const tintRef = useRef<HTMLDivElement | null>(null);
  // Join/swap preview elements: a tint over the source leaf (swap), a
  // tint over the target region (light for swap, dark for the doomed
  // merge region) with a centered glyph (⇄ / directional arrow).
  const srcTintRef = useRef<HTMLDivElement | null>(null);
  const joinTintRef = useRef<HTMLDivElement | null>(null);
  const joinGlyphRef = useRef<HTMLSpanElement | null>(null);

  const hideJoinPreview = useCallback(() => {
    if (srcTintRef.current) srcTintRef.current.style.opacity = "0";
    if (joinTintRef.current) joinTintRef.current.style.opacity = "0";
  }, []);

  const hideSplitPreview = useCallback(() => {
    if (tintRef.current) tintRef.current.style.opacity = "0";
  }, []);

  const placeRect = useCallback(
    (
      el: HTMLDivElement,
      r: { left: number; top: number; width: number; height: number }
    ) => {
      el.style.left = `${r.left}px`;
      el.style.top = `${r.top}px`;
      el.style.width = `${r.width}px`;
      el.style.height = `${r.height}px`;
    },
    []
  );

  // Resolve the join target + zone under the cursor and paint the
  // preview. Called per pointermove while the gesture is outward.
  const updateJoinTarget = useCallback(
    (cur: CornerGesture, clientX: number, clientY: number) => {
      const srcTint = srcTintRef.current;
      const joinTint = joinTintRef.current;
      const glyph = joinGlyphRef.current;
      if (!srcTint || !joinTint || !glyph) return;
      const relX = clientX - cur.contLeft;
      const relY = clientY - cur.contTop;
      const hit = cur.targets.find(
        (t) =>
          t.id !== cur.leafId &&
          relX >= t.left &&
          relX < t.left + t.width &&
          relY >= t.top &&
          relY < t.top + t.height
      );
      if (!hit) {
        // Back over the source (or off the region) — release = no-op.
        cur.join = { targetId: null, mode: null };
        hideJoinPreview();
        return;
      }
      const margin = (1 - SWAP_CENTER_FRAC) / 2;
      const inX = (relX - hit.left) / hit.width;
      const inY = (relY - hit.top) / hit.height;
      const inCenter =
        inX > margin && inX < 1 - margin && inY > margin && inY < 1 - margin;
      if (inCenter) {
        // Swap: both panels tint lightly, ⇄ centered in the target.
        cur.join = { targetId: hit.id, mode: "swap" };
        placeRect(srcTint, cur.leafPx);
        srcTint.style.opacity = "1";
        placeRect(joinTint, hit);
        joinTint.style.background = "rgba(190, 197, 255, 0.07)";
        joinTint.style.border = "1px solid rgba(190, 197, 255, 0.22)";
        glyph.textContent = "⇄";
        joinTint.style.opacity = "1";
        return;
      }
      // Merge: everything on the target's side of the lowest separating
      // split closes. The preview darkens EXACTLY that region (spec
      // §4b — destructive scope always visible), with an arrow from the
      // source. Blocked when it would swallow every viewport leaf (the
      // engine blit target + overlays must keep a home — same rule as
      // the kind menu's last-viewport guard).
      const doomed = joinRemovedLeaves(tree, cur.leafId, hit.id);
      if (doomed.length === 0) {
        cur.join = { targetId: null, mode: null };
        hideJoinPreview();
        return;
      }
      const doomedSet = new Set(doomed);
      const survivorHasViewport = cur.targets.some(
        (t) => !doomedSet.has(t.id) && t.panel === "viewport"
      );
      if (!survivorHasViewport) {
        cur.join = { targetId: null, mode: null };
        hideJoinPreview();
        return;
      }
      let left = Infinity;
      let top = Infinity;
      let right = -Infinity;
      let bottom = -Infinity;
      for (const t of cur.targets) {
        if (!doomedSet.has(t.id)) continue;
        left = Math.min(left, t.left);
        top = Math.min(top, t.top);
        right = Math.max(right, t.left + t.width);
        bottom = Math.max(bottom, t.top + t.height);
      }
      cur.join = { targetId: hit.id, mode: "merge" };
      srcTint.style.opacity = "0";
      placeRect(joinTint, {
        left,
        top,
        width: right - left,
        height: bottom - top,
      });
      joinTint.style.background = "rgba(6, 6, 10, 0.55)";
      joinTint.style.border = "1px solid color-mix(in srgb, var(--tb-lift) 14%, transparent)";
      // Arrow points from the source into the doomed region.
      const srcCx = cur.leafPx.left + cur.leafPx.width / 2;
      const srcCy = cur.leafPx.top + cur.leafPx.height / 2;
      const dx = (left + right) / 2 - srcCx;
      const dy = (top + bottom) / 2 - srcCy;
      glyph.textContent =
        Math.abs(dx) >= Math.abs(dy) ? (dx > 0 ? "→" : "←") : dy > 0 ? "↓" : "↑";
      joinTint.style.opacity = "1";
    },
    [tree, hideJoinPreview, placeRect]
  );

  const paintSplitPreview = useCallback((g: CornerGesture) => {
    const tint = tintRef.current;
    if (!tint || !g.dir) return;
    const { left, top, width, height } = g.leafPx;
    if (g.dir === "row") {
      const x = left + g.ratio * width;
      const newWest = g.corner === "nw" || g.corner === "sw";
      tint.style.left = `${newWest ? left : x}px`;
      tint.style.top = `${top}px`;
      tint.style.width = `${newWest ? x - left : left + width - x}px`;
      tint.style.height = `${height}px`;
    } else {
      const y = top + g.ratio * height;
      const newNorth = g.corner === "nw" || g.corner === "ne";
      tint.style.left = `${left}px`;
      tint.style.top = `${newNorth ? top : y}px`;
      tint.style.width = `${width}px`;
      tint.style.height = `${newNorth ? y - top : top + height - y}px`;
    }
    tint.style.opacity = "1";
  }, []);

  const startCornerDrag = useCallback(
    (
      leafId: string,
      rect: LayoutRect,
      corner: Corner,
      e: React.PointerEvent<HTMLDivElement>
    ) => {
      e.preventDefault();
      e.stopPropagation();
      const cont = containerRef.current;
      if (!cont) return;
      const cr = cont.getBoundingClientRect();
      gestureRef.current = {
        leafId,
        corner,
        startX: e.clientX,
        startY: e.clientY,
        contLeft: cr.left,
        contTop: cr.top,
        leafPx: {
          left: rect.x * cr.width,
          top: rect.y * cr.height,
          width: rect.w * cr.width,
          height: rect.h * cr.height,
        },
        targets: [...computed.leaves.entries()].map(([tid, entry]) => ({
          id: tid,
          panel: entry.panel,
          left: entry.rect.x * cr.width,
          top: entry.rect.y * cr.height,
          width: entry.rect.w * cr.width,
          height: entry.rect.h * cr.height,
        })),
        dir: null,
        outward: false,
        join: { targetId: null, mode: null },
        splitArmed: false,
        ratio: 0.5,
      };
      setGestureLeafId(leafId);
      const el = e.currentTarget;
      el.setPointerCapture(e.pointerId);
      document.body.style.cursor = "crosshair";
      document.body.style.userSelect = "none";
      const cleanup = () => {
        el.removeEventListener("pointermove", onMove);
        el.removeEventListener("pointerup", onUp);
        el.removeEventListener("lostpointercapture", onLost);
        window.removeEventListener("keydown", onKey, true);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        gestureRef.current = null;
        setGestureLeafId(null);
      };
      const onKey = (ev: KeyboardEvent) => {
        if (ev.key !== "Escape") return;
        // Cancel — the tree was never touched. Swallow the Esc so it
        // doesn't also exit full-canvas / close overlays.
        ev.preventDefault();
        ev.stopPropagation();
        cleanup();
      };
      const onMove = (ev: PointerEvent) => {
        const cur = gestureRef.current;
        if (!cur) return;
        const dx = ev.clientX - cur.startX;
        const dy = ev.clientY - cur.startY;
        if (!cur.dir && !cur.outward && Math.hypot(dx, dy) >= AXIS_LOCK_PX) {
          const horizontal = Math.abs(dx) >= Math.abs(dy);
          const into = horizontal
            ? cur.corner === "nw" || cur.corner === "sw"
              ? dx > 0
              : dx < 0
            : cur.corner === "nw" || cur.corner === "ne"
              ? dy > 0
              : dy < 0;
          if (into) cur.dir = horizontal ? "row" : "col";
          else cur.outward = true;
        }
        if (cur.dir) {
          const isRow = cur.dir === "row";
          const extent = Math.max(
            1,
            isRow ? cur.leafPx.width : cur.leafPx.height
          );
          const posPx = isRow
            ? ev.clientX - cur.contLeft - cur.leafPx.left
            : ev.clientY - cur.contTop - cur.leafPx.top;
          // Parked back in the origin gutter → disarm (preview hides,
          // release no-ops); dragging inward again re-arms.
          const fromOrigin = isRow
            ? cur.corner === "nw" || cur.corner === "sw"
              ? posPx
              : extent - posPx
            : cur.corner === "nw" || cur.corner === "ne"
              ? posPx
              : extent - posPx;
          if (fromOrigin <= SPLIT_CANCEL_PX) {
            cur.splitArmed = false;
            hideSplitPreview();
            return;
          }
          const minR = Math.min(0.45, MIN_PANEL_PX / extent);
          cur.ratio = Math.max(minR, Math.min(1 - minR, posPx / extent));
          cur.splitArmed = true;
          paintSplitPreview(cur);
        } else if (cur.outward) {
          updateJoinTarget(cur, ev.clientX, ev.clientY);
        }
      };
      const onUp = () => {
        const cur = gestureRef.current;
        cleanup();
        if (!cur) return;
        if (cur.dir && cur.splitArmed && onSplitLeaf) {
          // The new clone lands on the side the gesture grew it from:
          // west/north corners put it first (left/top child).
          const firstIsNew =
            cur.dir === "row"
              ? cur.corner === "nw" || cur.corner === "sw"
              : cur.corner === "nw" || cur.corner === "ne";
          onSplitLeaf(cur.leafId, cur.dir, cur.ratio, firstIsNew);
        } else if (cur.outward && cur.join.targetId) {
          if (cur.join.mode === "swap" && onSwapLeaves) {
            onSwapLeaves(cur.leafId, cur.join.targetId);
          } else if (cur.join.mode === "merge" && onJoinLeaves) {
            onJoinLeaves(cur.leafId, cur.join.targetId);
          }
        }
      };
      const onLost = () => cleanup();
      el.addEventListener("pointermove", onMove);
      el.addEventListener("pointerup", onUp);
      el.addEventListener("lostpointercapture", onLost);
      window.addEventListener("keydown", onKey, true);
    },
    [
      computed,
      onSplitLeaf,
      onSwapLeaves,
      onJoinLeaves,
      paintSplitPreview,
      hideSplitPreview,
      updateJoinTarget,
    ]
  );

  const coarsePointer = useCoarsePointer();
  const gutterHit = coarsePointer ? GUTTER_HIT_COARSE : GUTTER_HIT;
  const cornerHit = coarsePointer ? CORNER_HIT_COARSE : CORNER_HIT;

  const leaves = [...computed.leaves.entries()];

  return (
    <div
      ref={containerRef}
      style={{
        position: "relative",
        flex: 1,
        minHeight: 0,
        width: "100%",
        background: "var(--tb-frame)",
        overflow: "hidden",
      }}
    >
      {leaves.map(([id, { rect, panel }]) => {
        const solo = soloLeafId != null;
        const isSolo = soloLeafId === id;
        // Outer edges get the full PANEL_GAP (bottom gets none — the
        // strips below own their top spacing, matching the old body
        // padding); interior seams split PANEL_GAP between neighbours.
        const gapL = rect.x <= EDGE ? PANEL_GAP : PANEL_GAP / 2;
        const gapR = rect.x + rect.w >= 1 - EDGE ? PANEL_GAP : PANEL_GAP / 2;
        const gapT = rect.y <= EDGE ? PANEL_GAP : PANEL_GAP / 2;
        const gapB = rect.y + rect.h >= 1 - EDGE ? 0 : PANEL_GAP / 2;
        const style: React.CSSProperties = isSolo
          ? {
              position: "absolute",
              left: 0,
              top: 0,
              width: "100%",
              height: "100%",
            }
          : {
              position: "absolute",
              left: `calc(${rect.x * 100}% + ${gapL}px)`,
              top: `calc(${rect.y * 100}% + ${gapT}px)`,
              width: `calc(${rect.w * 100}% - ${gapL + gapR}px)`,
              height: `calc(${rect.h * 100}% - ${gapT + gapB}px)`,
              ...PANEL_FRAME,
            };
        return (
          <section
            key={id}
            style={{
              display: solo && !isSolo ? "none" : "flex",
              flexDirection: "column",
              minHeight: 0,
              minWidth: 0,
              background: "var(--tb-n-0)",
              ...style,
            }}
          >
            {renderPanel(id, panel)}
            {/* Corner hotspots — crosshair zones starting the split
                gesture. Above the gutter dividers (z 20 > 10); the
                panel-kind chips sit at z 30 so they win their overlap. */}
            {onSplitLeaf &&
              !solo &&
              CORNERS.map((c) => (
                <div
                  key={c}
                  onPointerDown={(e) => startCornerDrag(id, rect, c, e)}
                  style={{
                    position: "absolute",
                    width: cornerHit,
                    height: cornerHit,
                    zIndex: 20,
                    cursor: "crosshair",
                    touchAction: "none",
                    ...(c === "nw" || c === "ne" ? { top: 0 } : { bottom: 0 }),
                    ...(c === "nw" || c === "sw" ? { left: 0 } : { right: 0 }),
                  }}
                />
              ))}
          </section>
        );
      })}
      {soloLeafId == null &&
        computed.dividers.map((d) => {
          const isRow = d.dir === "row";
          const style: React.CSSProperties = isRow
            ? {
                left: `calc(${d.at * 100}% - ${gutterHit / 2}px)`,
                top: `${d.rect.y * 100}%`,
                width: gutterHit,
                height: `${d.rect.h * 100}%`,
                cursor: "col-resize",
              }
            : {
                left: `${d.rect.x * 100}%`,
                top: `calc(${d.at * 100}% - ${gutterHit / 2}px)`,
                width: `${d.rect.w * 100}%`,
                height: gutterHit,
                cursor: "row-resize",
              };
          return (
            <div
              key={d.splitId}
              onPointerDown={(e) => startDividerDrag(d, e)}
              onDoubleClick={() => {
                // Reset the split to 50/50 (M4 polish).
                onSetRatio(d.splitId, 0.5);
                window.dispatchEvent(new Event("resize"));
              }}
              style={{
                position: "absolute",
                zIndex: 10,
                background: "transparent",
                touchAction: "none",
                ...style,
              }}
            />
          );
        })}
      {/* Split-gesture preview layer: a rounded-rect tint over the half
          being created, fading in 120ms. Styles are written
          imperatively by paintSplitPreview — mounting them at opacity 0
          here is what makes the first write transition. */}
      {gestureLeafId != null && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            zIndex: 40,
            pointerEvents: "none",
          }}
        >
          <div
            ref={tintRef}
            style={{
              position: "absolute",
              background: "rgba(190, 197, 255, 0.07)",
              border: "1px solid rgba(190, 197, 255, 0.22)",
              borderRadius: 5,
              opacity: 0,
              transition: "opacity 120ms ease",
            }}
          />
          {/* Join/swap previews. Geometry transitions give the tint a
              short glide when the drag retargets between panels. */}
          <div
            ref={srcTintRef}
            style={{
              position: "absolute",
              background: "rgba(190, 197, 255, 0.07)",
              border: "1px solid rgba(190, 197, 255, 0.22)",
              borderRadius: 5,
              opacity: 0,
              transition:
                "opacity 120ms ease, left 90ms ease, top 90ms ease, width 90ms ease, height 90ms ease",
            }}
          />
          <div
            ref={joinTintRef}
            style={{
              position: "absolute",
              borderRadius: 5,
              opacity: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              transition:
                "opacity 120ms ease, left 90ms ease, top 90ms ease, width 90ms ease, height 90ms ease",
            }}
          >
            <span
              ref={joinGlyphRef}
              style={{
                fontSize: 26,
                fontFamily: "var(--ui-font)",
                color: "var(--tb-t-violet-l-0)",
                opacity: 0.9,
                userSelect: "none",
              }}
            />
          </div>
        </div>
      )}
    </div>
  );
}
