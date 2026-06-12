import type {
  InputSocketDef,
  NodeDefinition,
  RenderQueueItem,
} from "@/engine/types";

// Render Queue — a batch-render organizer. Each input socket accepts a
// `render` wire from exactly one Output node (the only producer of that
// type). The `items` param holds one row per socket; the param panel reads
// the wire on each `item:<id>` socket to show the connected Output's
// filename / frame-count inline, and the user hits one button to render the
// whole list in sequence.
//
// This node produces nothing during normal evaluation — `render` edges are
// ignored by the evaluator's reachability pass, so wiring outputs in here
// doesn't force them to evaluate every frame. The batch render is driven
// imperatively from EffectsApp when the user presses Render.

export function newRenderQueueItemId(): string {
  return `rq-${Math.random().toString(36).slice(2, 8)}`;
}

const DEFAULT_ITEMS: RenderQueueItem[] = [
  { id: "rq-initial", kind: "video", frame: 0 },
];

export const renderQueueNode: NodeDefinition = {
  type: "render-queue",
  name: "Render Queue",
  category: "output",
  description:
    "Collects Output nodes into an ordered batch and renders them one after another. Wire each Output's `render` output into a socket here; reorder the rows in the parameters panel; hit Render to export the whole queue.",
  backend: "webgl2",
  // No universal mask socket — this node renders nothing to mask.
  noMaskInput: true,
  inputs: [{ name: "item:rq-initial", label: "item 1", type: "render", required: false }],
  resolveInputs(params): InputSocketDef[] {
    const items = (params.items as RenderQueueItem[]) ?? [];
    return items.map((it, i) => ({
      name: `item:${it.id}`,
      label: `item ${i + 1}`,
      type: "render",
      required: false,
    }));
  },
  params: [
    {
      name: "items",
      label: "Queue",
      type: "render_queue",
      default: DEFAULT_ITEMS,
    },
    {
      // How the finished batch is delivered. Surfaced via the gear popover
      // in the custom param panel rather than a plain dropdown.
      name: "delivery",
      label: "Delivery",
      type: "enum",
      options: ["sequential", "zip", "folder"],
      default: "sequential",
      hidden: true,
    },
  ],
  primaryOutput: null,
  auxOutputs: [],
  compute() {
    // No-op: the queue is driven imperatively at render time.
    return {};
  },
};
