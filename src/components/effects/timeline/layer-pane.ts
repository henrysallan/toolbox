// Layers editor label pane (specdocs/101526_layer-transforms-parenting.md
// §6): its user-resizable width, which optional columns fit at a given
// width, and the per-viewer persistence. Pure, so check-layer-pane.mts can
// drive it.

// The gutter CARD's width (the inset sits outside it). 320 fits the name
// plus both optional columns (Blend + Parent need ≥ 309).
export const LABEL_CARD_DEFAULT = 320;
export const LABEL_CARD_MIN = 140;
export const LABEL_CARD_MAX = 560;

export function clampCardWidth(w: number): number {
  if (!Number.isFinite(w)) return LABEL_CARD_DEFAULT;
  return Math.round(Math.min(LABEL_CARD_MAX, Math.max(LABEL_CARD_MIN, w)));
}

// Row anatomy inside the card, in px: left pad + chevron + gap + eye + gap
// on the left, a right pad at the end. The name flexes but keeps at least
// NAME_MIN before any optional column is allowed in.
export const ROW_FIXED = 4 + 14 + 4 + 15 + 4 + 8;
export const NAME_MIN = 72;
// Optional column slot = control width + its leading gap.
export const BLEND_SLOT = 88 + 6;
export const PARENT_SLOT = 88 + 6;

export interface PaneColumns {
  blend: boolean;
  parent: boolean;
}

// Which optional columns fit in a card `width` wide. Columns drop in
// priority order as the pane narrows: Blend first (the owner's call —
// "if it gets small enough we just hide the blend mode stuff"), then
// Parent. `hasParent` false (before parenting lands, M4) means only Blend
// competes for the space.
export function paneColumns(width: number, hasParent: boolean): PaneColumns {
  let free = width - ROW_FIXED - NAME_MIN;
  const parent = hasParent && free >= PARENT_SLOT;
  if (parent) free -= PARENT_SLOT;
  const blend = free >= BLEND_SLOT;
  return { blend, parent };
}

export const LABEL_WIDTH_STORAGE_KEY = "toolbox.layers.labelWidth";

type StorageLike = Pick<Storage, "getItem" | "setItem">;

// Saved width, or the default. Storage can be missing or throw (private
// window, blocked site data); neither may break the editor.
export function readCardWidth(storage: StorageLike | null | undefined): number {
  try {
    const raw = storage?.getItem(LABEL_WIDTH_STORAGE_KEY);
    if (raw == null) return LABEL_CARD_DEFAULT;
    const n = Number(raw);
    return Number.isFinite(n) ? clampCardWidth(n) : LABEL_CARD_DEFAULT;
  } catch {
    return LABEL_CARD_DEFAULT;
  }
}

export function writeCardWidth(
  storage: StorageLike | null | undefined,
  width: number
): void {
  try {
    storage?.setItem(LABEL_WIDTH_STORAGE_KEY, String(clampCardWidth(width)));
  } catch {
    // Per-viewer convenience only — losing it is fine.
  }
}
