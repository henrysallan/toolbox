// Audible-audio-set store — which node ids sat on an audible audio path
// in the last top-level eval (`EvalResult.audibleAudioNodeIds`, the
// evaluator's transitive audioRoutedToOutput pre-pass: Output `audio`
// socket, layer-boundary auditions, the Active node). Held OUTSIDE React
// state, playback-clock.ts pattern: EffectsApp publishes after each eval
// — only when membership actually changed, so a steady 60fps loop never
// notifies — and EffectNode reads per-node membership through
// useSyncExternalStore to drive the not-audible speaker glyph
// (080926_audio-v2-integration.md M-D). A store rather than a
// broadcastAppEvent because the glyph is persistent chrome: a node
// mounted AFTER the last publish (freshly added, popped-out pane) must
// still see the current set, and events can't replay to late listeners.

import { useSyncExternalStore } from "react";

// null = no eval has published yet — consumers must render NO glyph
// (absence of data is not "inaudible").
let state: ReadonlySet<string> | null = null;
const listeners = new Set<() => void>();

export const audibleAudioSet = {
  get(): ReadonlySet<string> | null {
    return state;
  },
  set(next: ReadonlySet<string>): void {
    state = next;
    for (const l of [...listeners]) l();
  },
  subscribe(cb: () => void): () => void {
    listeners.add(cb);
    return () => {
      listeners.delete(cb);
    };
  },
};

// Whether `nodeId` is on an audible path per the last published eval;
// null while nothing has been published. Snapshot is a PRIMITIVE
// (boolean | null), so a publish re-renders only the nodes whose own
// audibility flipped.
export function useAudioAudible(nodeId: string): boolean | null {
  return useSyncExternalStore(
    audibleAudioSet.subscribe,
    () => (state === null ? null : state.has(nodeId)),
    // SSR snapshot: nothing published — no glyph on first paint.
    () => null
  );
}
