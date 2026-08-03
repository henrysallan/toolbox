import type { NodeDefinition } from "@/engine/types";
import { FRAME_TYPE } from "@/engine/graph-helpers";

// Frame — a Blender-style visual frame zone, rendered as a shaded rect
// behind its member nodes (FrameNode.tsx). A first-class node in the model
// so it inherits selection, delete, copy/paste, undo, and parentId scoping
// for free (the reroute rationale) — but purely cosmetic: no sockets,
// nothing ever wires to it, so the evaluator's needed-set never includes it
// and this compute never runs on any real path. Membership lives on the
// members (`data.frameId`), the label is `data.name`, and the box persists
// through position + uiWidth/uiHeight. Spec:
// specdocs/073026_node-cosmetics-and-frames.md.
//
// `hidden: true` — frames are born from Shift+F, not the add-node catalog.
// `noMaskInput` — a socketless node must not grow the universal mask input.

export const frameZoneNode: NodeDefinition = {
  type: FRAME_TYPE,
  name: "Frame",
  hidden: true,
  category: "utility",
  backend: "webgl2",
  noMaskInput: true,
  description:
    "A visual frame that groups nodes on the canvas. Shift+F frames the selection; drag nodes in to add them, Cmd-drag out to remove, drag the edges to move the frame and everything inside.",
  inputs: [],
  params: [],
  primaryOutput: null,
  auxOutputs: [],
  compute: () => ({}),
};
