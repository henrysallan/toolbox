"use client";

import EffectsApp, {
  type InitialProjectPayload,
} from "@/components/effects/EffectsApp";

// Thin client wrapper around the full editor — the route loads the
// project server-side and hands the deserialized payload here, which
// in turn seeds EffectsApp via its `initialProject` prop. EffectsApp
// shows the project's graph, the file-name pill, the share buttons,
// and all the normal editor chrome. Non-owners can read; signed-in
// non-owners get a copy-on-save flow (already in EffectsApp).

export default function EditorClient(props: InitialProjectPayload) {
  return <EffectsApp initialProject={props} />;
}
