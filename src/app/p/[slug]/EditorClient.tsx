"use client";

import EffectsApp, {
  type InitialProjectPayload,
} from "@/components/effects/EffectsApp";

// Thin client wrapper around the full editor — the route loads the
// project server-side and hands the deserialized payload here, which
// in turn seeds EffectsApp via its `initialProject` prop. Private
// slugs only reach this component when the visitor is the owner or a
// collaborator; everyone else gets PrivateProjectGate instead.

export default function EditorClient(props: InitialProjectPayload) {
  return <EffectsApp initialProject={props} />;
}
