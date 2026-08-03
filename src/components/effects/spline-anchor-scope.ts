// Cross-surface link between the Spline Draw canvas overlay and the
// Tracks editor. A Spline Draw node's per-anchor keyframes live on
// virtual track keys (`anchor_p:<id>` & friends — engine/conventions.ts),
// so a lane in the Tracks editor and an anchor on the canvas can name the
// same thing; this keeps the two selections talking.
//
// TWO ONE-WAY CHANNELS, deliberately asymmetric so they can't feed each
// other into a loop:
//
//   canvas → tracks   PUBLISH. The overlay announces which anchors are
//                     selected; the Tracks editor HIGHLIGHTS the matching
//                     lanes. A highlight is not a selection, so nothing
//                     bounces back.
//   tracks → canvas   REQUEST. Selecting keyframes on anchor lanes asks
//                     the overlay to SELECT those anchors. The overlay
//                     then publishes on the first channel, which lights
//                     up the lanes you just clicked — a dead end, not a
//                     cycle.
//
// A module-level store rather than props or context: the two surfaces sit
// in different layout panels (and the dock may be a floating modal), so
// there is no useful common ancestor to thread this through. Same idiom
// as nodes-pane-scope.ts.

export interface AnchorSelection {
  /** The Spline Draw node the anchors belong to, or null when none. */
  nodeId: string | null;
  anchorIds: string[];
}

const EMPTY: AnchorSelection = { nodeId: null, anchorIds: [] };

// --- canvas → tracks (published selection) --------------------------------

let published: AnchorSelection = EMPTY;
const publishListeners = new Set<() => void>();

function sameSelection(a: AnchorSelection, b: AnchorSelection): boolean {
  return (
    a.nodeId === b.nodeId &&
    a.anchorIds.length === b.anchorIds.length &&
    a.anchorIds.every((id, i) => id === b.anchorIds[i])
  );
}

/**
 * The overlay calls this whenever its anchor selection changes. The
 * snapshot object is only replaced when the CONTENT changes, so
 * useSyncExternalStore consumers don't re-render on every publish.
 */
export function publishAnchorSelection(next: AnchorSelection): void {
  if (sameSelection(published, next)) return;
  published = next;
  for (const l of [...publishListeners]) l();
}

/** Clear the published selection — the overlay calls this on unmount. */
export function clearPublishedAnchorSelection(nodeId: string): void {
  if (published.nodeId !== nodeId) return;
  publishAnchorSelection(EMPTY);
}

export function getPublishedAnchorSelection(): AnchorSelection {
  return published;
}

export function subscribePublishedAnchorSelection(cb: () => void): () => void {
  publishListeners.add(cb);
  return () => {
    publishListeners.delete(cb);
  };
}

// --- tracks → canvas (selection request) -----------------------------------

export interface AnchorSelectionRequest extends AnchorSelection {
  nodeId: string;
  /**
   * Bumped every request so re-selecting the SAME anchors still fires —
   * clicking a lane whose anchor is already selected should still pull
   * the canvas selection back onto it.
   */
  version: number;
}

let request: AnchorSelectionRequest | null = null;
let requestVersion = 0;
const requestListeners = new Set<() => void>();

/**
 * The Tracks editor calls this when the keyframe selection lands on
 * anchor lanes. Overlays for other nodes ignore it, so callers don't
 * need to know which Spline Draw node (if any) is currently active.
 */
export function requestAnchorSelection(
  nodeId: string,
  anchorIds: string[]
): void {
  requestVersion += 1;
  request = { nodeId, anchorIds, version: requestVersion };
  for (const l of [...requestListeners]) l();
}

export function getAnchorSelectionRequest(): AnchorSelectionRequest | null {
  return request;
}

export function subscribeAnchorSelectionRequest(cb: () => void): () => void {
  requestListeners.add(cb);
  return () => {
    requestListeners.delete(cb);
  };
}
