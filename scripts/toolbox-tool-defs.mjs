// Shared definitions for the bridged Toolbox editor verbs (spec
// 080826_claude-agent-panel.md, milestone 1).
//
// These are the tools that marshal to a connected editor over the bridge
// socket. They are pure DATA — no server, no transport, no side effects — so
// both consumers can import them:
//
//   scripts/mcp-server.mjs   stdio MCP server for Claude Desktop / Claude Code
//   scripts/agent-host.mjs   in-app assistant panel (Agent SDK, in-process)
//
// The two hosts differ only in how they marshal a result into their own
// content-block format, which is what `resultKind` selects.
//
// NOT included: the source-reading tools (get_node_source / read_source /
// search_source) and the perf tools. The source readers don't go through the
// bridge at all — they read the repo checkout directly via mcp-source.mjs —
// and the perf trio is scoped to the profiler workflow. Both stay owned by
// mcp-server.mjs until there's a reason to share them.
//
// MIGRATION NOTE: mcp-server.mjs still declares its own inline copies of
// these. It has uncommitted work in flight, so it was deliberately left alone;
// folding it onto this module is a mechanical follow-up. Until then, edits
// here must be mirrored there.

import { z } from "zod";

export const CMD_TIMEOUT_MS = 10_000;
export const SCREENSHOT_TIMEOUT_MS = 30_000;

// Shared prose appended to insert_recipe. Kept as its own export because it is
// long, load-bearing, and referenced by edit_group's description by name.
export const RECIPE_CONTRACT =
  "RecipeGraph shape: {name, description?, nodes:[{id, type, params?}], " +
  "edges?:[{from, to}], inputs?:[{name, from, type}], outputs:[{name, from, " +
  "type}] (at least one), exposed?:[{name, node, param}]}. Node ids are " +
  "local strings you choose. `type` strings MUST come from get_catalog. " +
  'Edge grammar — from: "<id>:out" | "<id>:aux:<name>"; to: ' +
  '"<id>:in:<socket>" | "<id>:param:<name>". Set only params the ' +
  "catalog lists (respect ranges/options). Allowed cross-type wires: " +
  "mask↔image, spline→mask, scalar→vec2/vec3/vec4/uv, image|mask→scalar, " +
  "audio→scalar, image↔element; anything else must match exactly. The " +
  "graph must be acyclic. Expression/Point Expression `expression` params " +
  "are JavaScript: assignments only (never `return`), declare temporaries " +
  'with let/const. Point Expression ch("name", default) channels become ' +
  'sliders automatically AND are wireable by name ("<id>:in:<channelName>"). ' +
  "Merge nodes: size the stack with params.layers = [{mode, opacity}, …] " +
  'and wire ordinally — "<id>:in:layer1", "<id>:in:layer2", … ' +
  '("<id>:in:mask1", … for per-layer mattes); wiring layerN past the end ' +
  "grows the stack.";

/**
 * The bridged editor verbs.
 *
 * name         command name sent over the bridge AND the tool name exposed
 *              to the model — they are deliberately the same string.
 * description  what the model reads. Verbatim from the MCP server.
 * inputSchema  zod raw shape (not a z.object) — both McpServer.registerTool
 *              and the Agent SDK's tool() take the shape form.
 * timeoutMs    how long to wait on the editor before failing the call.
 * resultKind   "text"   → JSON/string result, stringify into one text block
 *              "image"  → {base64, mimeType, frame, width, height}
 *              "strip"  → image + {frames[], grid:{cols,rows}, width, height}
 * mutates      true if it changes the document. Drives session-scoped
 *              authorization and the checkpoint boundary (spec §The loop).
 */
export const BRIDGED_TOOLS = [
  {
    name: "get_status",
    mutates: false,
    resultKind: "text",
    timeoutMs: CMD_TIMEOUT_MS,
    description:
      "Current state of the connected Toolbox editor: project name, canvas " +
      "size, fps, playhead frame, playing/paused, loop length, selected node, " +
      "and the current editing scope (root or a group id).",
    inputSchema: {},
  },
  {
    name: "get_catalog",
    mutates: false,
    resultKind: "text",
    timeoutMs: CMD_TIMEOUT_MS,
    description:
      "The full node catalog of the running Toolbox editor — one line per " +
      "node type in a compact DSL: `type (Name) [category] ~dyn: in " +
      "sockets -> output aux=… | settable params`, with a # description " +
      "line. Fetch once per session; it's stable while the app runs.",
    inputSchema: {},
  },
  {
    name: "get_graph",
    mutates: false,
    resultKind: "text",
    timeoutMs: CMD_TIMEOUT_MS,
    description:
      "The current node graph as JSON: nodes (id, type, display name, " +
      "settable param values, exposed + keyframed params, and — for " +
      "dynamic-socket nodes like Merge or Point Expression — the REAL " +
      "resolved input sockets under `inputs`), edges " +
      '("<id>:out"/"<id>:aux:<name>" → "<id>:in:<socket>"/' +
      '"<id>:param:<name>"), and the scope\'s boundary interface. Omit ' +
      "`scope` for the root composition (the layer chain); pass a group or " +
      "layer id to see its interior. Always call this before edit_group or " +
      "set_param — node ids are minted by the editor and can't be guessed.",
    inputSchema: {
      scope: z
        .string()
        .optional()
        .describe('Group or layer node id, or "root" (default).'),
    },
  },
  {
    name: "screenshot",
    mutates: false,
    resultKind: "image",
    timeoutMs: SCREENSHOT_TIMEOUT_MS,
    description:
      "Capture the editor's rendered canvas as a PNG image — use this to " +
      "SEE the result of your changes and validate visually. Optional: " +
      "`frame` renders a specific frame (the paused editor is restored to " +
      "the user's playhead afterwards); `nodeId` previews a specific node's " +
      "output instead of the terminal; `maxSize` caps the long edge " +
      "(default 1024px). For motion, take 2–3 screenshots at " +
      "representative frames rather than many.",
    inputSchema: {
      nodeId: z.string().optional().describe("Preview this node's output."),
      frame: z.number().optional().describe("Render this frame (integer)."),
      maxSize: z.number().optional().describe("Long-edge pixel cap, 64–2048."),
    },
  },
  {
    name: "insert_recipe",
    mutates: true,
    resultKind: "text",
    timeoutMs: CMD_TIMEOUT_MS,
    description:
      "Build and insert a new node-group into the Toolbox editor from a " +
      "RecipeGraph. Validation errors come back as the tool error — fix " +
      "them and call again. On success returns the new group's id (interior " +
      "node ids are minted at insert; call get_graph with scope=groupId " +
      "before editing further). The user sees a toast and can undo. " +
      RECIPE_CONTRACT,
    inputSchema: {
      recipe: z
        .record(z.string(), z.unknown())
        .describe("The RecipeGraph object."),
    },
  },
  {
    name: "edit_group",
    mutates: true,
    resultKind: "text",
    timeoutMs: CMD_TIMEOUT_MS,
    description:
      "Apply a minimal patch to an existing node-group OR layer's interior " +
      "(layers are the root-level building blocks — their content is edited " +
      "the same way; a layer shell's own params like blendMode are also " +
      "settable). Call get_graph with scope=groupId first and reference " +
      "nodes by their REAL ids. " +
      "Ops (ordered): set_param{node,param,value} · add_node{id,type," +
      "params?} (fresh local id you then wire) · remove_node{node} · " +
      "add_edge{from,to} · remove_edge{from,to} · expose_param{node,param," +
      "label?} · unexpose_param{node,param} · rename_node{node,name}. Edge " +
      "grammar and param rules are the same as insert_recipe. A param " +
      "listed under `keyframed` is animated — setting its static value " +
      "does nothing. Change by exception; never rebuild what you can patch. " +
      "Validation errors return as the tool error — fix and retry.",
    inputSchema: {
      groupId: z.string().describe("The node-group or layer id."),
      ops: z
        .array(z.record(z.string(), z.unknown()))
        .describe("Ordered edit operations."),
      summary: z
        .string()
        .optional()
        .describe("One short sentence shown to the user."),
    },
  },
  {
    name: "set_param",
    mutates: true,
    resultKind: "text",
    timeoutMs: CMD_TIMEOUT_MS,
    description:
      "Set one settable param on any node in the project (get ids from " +
      "get_graph). Values are vetted against the param's type/range/options. " +
      "Prefer this over edit_group for single tweaks — it's the same path " +
      "the UI sliders use (undo + auto-keyframing included).",
    inputSchema: {
      nodeId: z.string(),
      param: z.string(),
      value: z.unknown().describe("New value matching the param type."),
    },
  },
  {
    name: "screenshot_strip",
    mutates: false,
    resultKind: "strip",
    timeoutMs: SCREENSHOT_TIMEOUT_MS,
    description:
      "Sample several frames and return them tiled into ONE labelled grid " +
      "image — the cheap way to judge motion. Pass explicit `frames` " +
      "(2–12), or a `start`/`end`/`every` range (defaults: 0 → loop end, " +
      "~6 samples). Each cell is labelled f<frame>. Pick the count that " +
      "represents the motion: a slow drift needs 3, a stagger burst needs " +
      "8 — don't default to many.",
    inputSchema: {
      frames: z
        .array(z.number())
        .optional()
        .describe("Explicit frame numbers (2–12)."),
      start: z.number().optional().describe("Range start frame (default 0)."),
      end: z.number().optional().describe("Range end frame (default loop end)."),
      every: z.number().optional().describe("Sample every N frames."),
      nodeId: z.string().optional().describe("Preview this node's output."),
      maxSize: z
        .number()
        .optional()
        .describe("Long-edge cap for the WHOLE grid (default 1400)."),
    },
  },
  {
    name: "get_keyframes",
    mutates: false,
    resultKind: "text",
    timeoutMs: CMD_TIMEOUT_MS,
    description:
      "Read a node's keyframe animation. With `param`: that track's keys " +
      "as {frame, value, easing}. Without: an overview — every keyed track " +
      "(param, animated, key frames) plus which params are keyframable. " +
      "Frames are fps-relative (see get_status).",
    inputSchema: {
      nodeId: z.string(),
      param: z.string().optional().describe("Omit for the whole-node overview."),
    },
  },
  {
    name: "set_keyframes",
    mutates: true,
    resultKind: "text",
    timeoutMs: CMD_TIMEOUT_MS,
    description:
      "REPLACE a param's keyframe track. `keys` = [{frame, value, " +
      "easing?}]; values match the param's type (vetted like set_param); " +
      "easing presets: linear, easeIn/Out/InOut + Sine/Quad/Cubic, " +
      "easeInExpo, easeOutExpo, easeInBack, easeOutBack (overshoot), " +
      "easeOutBounce, easeOutElastic, hold (default easeInOutQuad; " +
      "boolean/enum params force hold). `easing` shapes the segment AFTER " +
      "its key. Empty `keys` clears the track entirely; `animated: false` " +
      "keeps keys but disables them. While a track is animated, its static " +
      "param value is ignored (wire > keyframes > static). Undo-able; the " +
      "user sees a toast.",
    inputSchema: {
      nodeId: z.string(),
      param: z.string(),
      keys: z
        .array(
          z.object({
            frame: z.number(),
            value: z.unknown(),
            easing: z.string().optional(),
          })
        )
        .describe("The full track, replacing whatever exists."),
      animated: z.boolean().optional().describe("Track enabled (default true)."),
    },
  },
  {
    name: "validate_expression",
    mutates: false,
    resultKind: "text",
    timeoutMs: CMD_TIMEOUT_MS,
    description:
      "Compile + smoke-run a Point Expression source without touching the " +
      "graph. Catches syntax errors, strict-mode ReferenceErrors " +
      "(undeclared temps — use let/const), and `return`-style blocks. Use " +
      "before inserting/patching an expression.",
    inputSchema: {
      source: z.string().describe("The per-point JavaScript block."),
    },
  },
  {
    name: "transport",
    // Moves the playhead; not a document edit, but the user sees it move.
    mutates: false,
    resultKind: "text",
    timeoutMs: CMD_TIMEOUT_MS,
    description:
      "Control playback: play, pause, or seek to a frame. Seek while " +
      "paused re-renders immediately — pair with screenshot to inspect " +
      "specific moments.",
    inputSchema: {
      action: z.enum(["play", "pause", "seek"]),
      frame: z.number().optional().describe("Target frame (seek only)."),
    },
  },
];

/** Tool names that mutate the document — the session-scoped grant set. */
export const MUTATING_TOOLS = BRIDGED_TOOLS.filter((t) => t.mutates).map(
  (t) => t.name
);

/**
 * Turn an editor result into MCP content blocks. Shared so the two hosts
 * present identical content to the model — in particular, images must stay
 * images (the visual loop is the whole point) rather than degrading to JSON.
 */
export function marshalResult(def, result) {
  if (def.resultKind === "image") {
    return {
      content: [
        { type: "image", data: result.base64, mimeType: result.mimeType },
        {
          type: "text",
          text: `frame ${result.frame}, ${result.width}×${result.height}`,
        },
      ],
    };
  }
  if (def.resultKind === "strip") {
    return {
      content: [
        { type: "image", data: result.base64, mimeType: result.mimeType },
        {
          type: "text",
          text:
            `frames [${result.frames.join(", ")}] in a ` +
            `${result.grid.cols}×${result.grid.rows} grid, ` +
            `${result.width}×${result.height}`,
        },
      ],
    };
  }
  const text =
    typeof result === "string" ? result : JSON.stringify(result, null, 1);
  return { content: [{ type: "text", text }] };
}

/** Errors come back as readable tool errors so the model can repair. */
export function marshalError(e) {
  return {
    content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }],
    isError: true,
  };
}
