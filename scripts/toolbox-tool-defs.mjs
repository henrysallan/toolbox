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
// mcp-server.mjs.

import { z } from "zod";

export const CMD_TIMEOUT_MS = 10_000;
export const SCREENSHOT_TIMEOUT_MS = 30_000;
export const MUTATION_TIMEOUT_MS = 60_000;

// Shared prose appended to insert_recipe. Kept as its own export because it is
// long, load-bearing, and referenced by edit_group's description by name.
export const RECIPE_CONTRACT =
  "RecipeGraph shape: {name, description?, nodes:[{id, type, params?, parent?}], " +
  "edges?:[{from, to}], inputs?:[{name, from, type}], outputs:[{name, from, " +
  "type}] (at least one), exposed?:[{name, node, param}]}. `exposed` that " +
  "don't resolve (missing node/param, or a type that can't be a knob) fail " +
  "the insert — they are not dropped silently. Node ids are " +
  "local strings you choose. `type` strings MUST come from get_catalog. " +
  'Edge grammar — from: "<id>:out" | "<id>:aux:<name>"; to: ' +
  '"<id>:in:<socket>" | "<id>:param:<name>". Set only params the ' +
  "catalog lists without the ~(not remotely settable) tag (respect " +
  "ranges/options). color_ramp is settable: [{position, color, alpha?}] " +
  "— same shape as GLSL ramp() channels (Color Ramp stops, Rasterize " +
  "fill/stroke ramps). float_curve is settable: [{x, y}] with x, y in 0..1, " +
  "at least 2 points, sorted by x (Map Attribute curve, Scene Time " +
  "easing_curve, Float Curve curve) — same shape as curve() channels; the " +
  "identity ramp is [{x:0,y:0},{x:1,y:1}]. Allowed cross-type wires: " +
  "mask↔image, spline→mask, scalar→vec2/vec3/vec4/uv, image|mask→scalar, " +
  "audio→scalar, image↔element; anything else must match exactly. The " +
  "graph must be acyclic. Expression/Point Expression `expression` params " +
  "are JavaScript: assignments only (never `return`), declare temporaries " +
  "with let/const. Expression tunables are CHANNELS declared in the code " +
  "(Point Expression: JS calls; GLSL Expression: one-line // comments): " +
  'ch("k", 0.5, 0, 1) slider · toggle("on", true) on/off · pick("mode", "a", "b") ' +
  '2–3-way pill/dropdown · color("tint", "#ff8800") swatch · ramp("ink", t, "#000000", "#ffffff") ' +
  'gradient sampled at t · curve("falloff", x, 1, 0) float curve sampled at x. ' +
  "Seeds are literals after the name; Sync mints the rows automatically " +
  "(add-only). Scalar/toggle/color/ramp channels are wireable by name " +
  '("<id>:in:<channelName>": scalar/scalar/vec4/color_ramp). In GLSL they ' +
  "read as float/bool/int(+const int mode_a)/vec4 uniforms and vec4 ink(float t) / " +
  "float falloff(float x) functions; names can't start with u_. " +
  "The scalar Expression node (type \"expression\") is different: sockets " +
  "are the named variables in params.inputs (default x). Wire by variable " +
  'name ("<id>:in:x", "<id>:in:p") — never the minted ein-… id. Declare extra ' +
  "variables with params.inputs = [{name, default?}, …] (ids preserved by " +
  "index) or by add_edge to a new name (the list grows). " +
  "Merge nodes: size the stack with params.layers = [{mode, opacity}, …] " +
  'and wire ordinally — "<id>:in:layer1", "<id>:in:layer2", … ' +
  '("<id>:in:mask1", … for per-layer mattes); wiring layerN past the end ' +
  "grows the stack. Compound zones: types \"repeat\" and \"foreach\" mint " +
  "Output (your id) + Input (\"<id>-input\"). Loop params on the recipe " +
  "node apply to the Input. Repeat: initial state " +
  "\"<id>-input:in:<name>\", re-enter \"<id>-input:aux:<name>\", collect " +
  "\"<id>:in:<name>\" (matching names feed back each generation), last " +
  "pass \"<id>:aux:<name>\". For Each: geometry \"<id>:in:geometry\", " +
  "current element \"<id>-input:aux:element\", collect grouped like " +
  "Iterate. Nest or put body nodes in a zone with parent: \"<zone-id>\" " +
  "on the recipe node (add_node accepts parent too). A node-group has no " +
  "primary output — its sockets are aux:<name> (typically aux:image), never :out.";

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
 *              "compare" → image + {summary, frames[], grid, metrics[]} (091626)
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
      "and the current editing scope. `scope` is the layer or group the " +
      "user is looking at (or \"root\"); `scopeType` is root/layer/group; " +
      "`parentScope` is the enclosing id (or \"root\"). insert_recipe lands " +
      "in `scope` unless you pass `scope=` — use parentScope when replacing " +
      "a group you're currently inside.",
    inputSchema: {},
  },
  {
    name: "get_catalog",
    mutates: false,
    resultKind: "text",
    timeoutMs: CMD_TIMEOUT_MS,
    description:
      "Node vocabulary of the running Toolbox editor. Default is a compact " +
      "index: one line per type `type (Name) [category]` — small enough to " +
      "read inline. For sockets and settable params, pass `category` " +
      "(image|spline|point|audio|3d|utility|effect|output) or `types` " +
      '(["circle","repeat"]). `mode: "full"` dumps the entire DSL (large; ' +
      "avoid unless you need every node). Type strings MUST come from this " +
      "tool; never guess. Under each node the DSL prints fixed-slot facts — " +
      "`# space:` (coordinate space per socket/param; out=in:x means the output " +
      "follows that input), `# reads:` / `# writes:` (point attributes), " +
      "`# flags:`, and `# !` gotchas — read them before wiring. canvas01 is " +
      "Y-down; uv01 (Gradient, v_uv in GLSL) is Y-up. The space/" +
      "flags preamble is on the index and on unfiltered/category dumps; " +
      "`types=` returns just those nodes (no repeated tables).",
    inputSchema: {
      mode: z
        .enum(["list", "full"])
        .optional()
        .describe(
          'list = compact type index (default). full = sockets, params, and descriptions for every matching type.'
        ),
      category: z
        .union([z.string(), z.array(z.string())])
        .optional()
        .describe(
          "Restrict to these categories (image, spline, point, audio, 3d, utility, effect, output). Returns full DSL unless mode=list."
        ),
      types: z
        .union([z.string(), z.array(z.string())])
        .optional()
        .describe(
          'Full DSL for these type strings only, e.g. ["circle","repeat"].'
        ),
    },
  },
  {
    name: "get_graph",
    mutates: false,
    resultKind: "text",
    timeoutMs: CMD_TIMEOUT_MS,
    description:
      "The current node graph as JSON. Default is compact: nodes (id, type, " +
      "display name, params that differ from the catalog default, exposed + " +
      "keyframed params, and — for dynamic-socket nodes like Merge or Point " +
      "Expression — the resolved input sockets under `inputs`; for Point " +
      "Expression / GLSL Expression the tunables under `channels`: name, kind " +
      "(scalar/toggle/enum/color/ramp/curve), current value, and the " +
      "socket type when wireable — tune one with set_param using its name), " +
      "edges (\"<id>:out\"/\"<id>:aux:<name>\" → \"<id>:in:<socket>\"/" +
      "\"<id>:param:<name>\"), and the scope's boundary interface. " +
      "Channel inputs print the channel NAME as the wireable handle " +
      "(`<id>:in:<name>`) and the minted `ein-…` id as `id` metadata — paste " +
      "the name, not the ein- id. Long `expression` params come back as " +
      "`{hash, chars}` instead of the full source; pass `params: \"all\"` " +
      "to dump every default and the full expression. " +
      "Group/layer shells include their exposed knobs as `params` (keyed " +
      "by the exposed label — the same name set_param uses); scoped-into " +
      "groups also list them on `interface.values`. " +
      "`verbosity: \"ids\"` returns only {id, type, name} plus edges and " +
      "interface — use this to mint ids without dumping params. " +
      "`params: \"all\"` keeps the full shape including catalog defaults " +
      "and full expression sources. Omit `scope` for the " +
      "root composition (the layer chain); pass a group or layer id to see " +
      "its interior. Repeat / For Each / Iterate members are listed in the " +
      "enclosing scope (each has `parent` = the zone shell id); you can " +
      "also pass a zone shell id as `scope`. Every result includes `rev` " +
      "(monotone mutation counter). Pass `since: <rev>` to get a diff " +
      "against that snapshot (added/removed/changed nodes + edges) instead " +
      "of the full graph — or `{unchanged: true}` when nothing moved. If " +
      "the snapshot expired you get the full graph plus a note. After a " +
      "timed-out edit, get_recent_edits or get_graph({since}) tells you " +
      "whether it landed without re-reading a 200-node group. " +
      "GLSL Expression nodes that " +
      "fail to compile include `shaderError` (the WebGL info log) and " +
      "`shaderPreludeLines` (subtract from log line numbers to get a line " +
      "in the body you wrote) — a broken shader still renders " +
      "passthrough/transparent, so pixels will not tell you. Always call " +
      "this before edit_group or set_param unless insert_recipe just " +
      "returned `ids` — node ids are minted by the editor and can't be guessed.",
    inputSchema: {
      scope: z
        .string()
        .optional()
        .describe(
          'Group, layer, or Repeat/For Each/Iterate zone node id, or "root" (default).'
        ),
      verbosity: z
        .enum(["full", "ids"])
        .optional()
        .describe(
          'full (default) = params + sockets. ids = {id, type, name} plus edges.'
        ),
      params: z
        .enum(["all", "non_default", "changed_only"])
        .optional()
        .describe(
          'Default omits catalog defaults and hashes long expressions. "all" = every settable param and full expression sources. "non_default" / "changed_only" = same as the default. Ignored when verbosity=ids.'
        ),
      since: z
        .number()
        .optional()
        .describe(
          "Previous get_graph/edit `rev`. Returns a diff (or unchanged) instead of the full graph."
        ),
    },
  },
  {
    name: "get_recent_edits",
    mutates: false,
    resultKind: "text",
    timeoutMs: CMD_TIMEOUT_MS,
    description:
      "Recent graph mutations from this editor session (insert_recipe, " +
      "edit_group, set_param, set_keyframes) with the `rev` get_graph uses. " +
      "set_param entries are summarized as `<nodeId>.<param>`. Key by the `summary` " +
      "you sent on edit_group — after a timeout, this is how you learn " +
      "whether the edit landed (status ok + matching summary) without " +
      "re-reading the group. Newest last. `rev` is the current mutation " +
      "counter (same field on get_status / get_graph).",
    inputSchema: {
      summary: z
        .string()
        .optional()
        .describe("Match this edit_group summary (exact or substring)."),
      limit: z
        .number()
        .optional()
        .describe("Max entries to return (default 10, max 40)."),
    },
  },
  {
    name: "get_node_data",
    mutates: false,
    resultKind: "text",
    timeoutMs: SCREENSHOT_TIMEOUT_MS,
    description:
      "Read a node's evaluated output as JSON — points, spline anchors, " +
      "or a compact summary for other kinds. Use this instead of measuring " +
      "screenshot pixels. 2D geometry is authored-space normalized [0,1]² " +
      "Y-DOWN (y=0 at the top of the frame, y=1 at the bottom); 3D points " +
      "are world meters Y-up. Returns bounds plus the first `limit` points " +
      "or anchors (default 32, max 256) with attrs. `attrNames` is ALWAYS " +
      "present and gathered over the whole value, not just the rows shown: " +
      "points → the named attribute channels; splines → per-anchor attrs, " +
      "plus `subpathAttrNames` (per-subpath attrs) and `groupTaggedSubpaths` " +
      "/ `drivenSubpaths` counts. An empty list means none present anywhere " +
      "— no need to raise `limit` to find out. Optional `socket` " +
      'selects "out" (primary) or "aux:<name>"; default prefers primary, ' +
      "then a points/spline aux. Optional `frame` evaluates at that frame " +
      "then restores the playhead. Group shells dissolve at eval — pass " +
      "the interior computing node (a Circle, Points on Path, …).",
    inputSchema: {
      nodeId: z.string().describe("The computing node to inspect."),
      limit: z
        .number()
        .optional()
        .describe("Max points/anchors to include (default 32, max 256)."),
      socket: z
        .string()
        .optional()
        .describe('Output to read: "out" (default) or "aux:<name>".'),
      frame: z.number().optional().describe("Evaluate this frame (integer)."),
    },
  },
  {
    name: "screenshot",
    mutates: false,
    resultKind: "image",
    timeoutMs: SCREENSHOT_TIMEOUT_MS,
    description:
      "Capture the editor's rendered canvas — use this to SEE the result " +
      "of your changes and validate visually. Default is JPEG (fits the " +
      "1 MB tool-result cap; soft gradients make PNG huge). Pass " +
      '`format: "png"` for lossless. Optional: `frame` renders a specific ' +
      "frame (the paused editor is restored to the user's playhead " +
      "afterwards); `nodeId` previews a specific node's output instead of " +
      "the terminal; `maxSize` caps the long edge (JPEG default 1024px, " +
      "PNG default 720px). `nodeId` may be a bare id or `<id>:out` / " +
      "`<id>:aux:<name>` — a node with aux outputs is otherwise ambiguous " +
      "(Circle's fill image is not the disc; pass `:aux:image` for the " +
      "raster). Previewing a GLSL Expression that failed to " +
      "compile appends the WebGL info log to the text sidecar — the " +
      "image itself is passthrough or transparent, not the shader. For " +
      "motion, take 2–3 screenshots at representative frames rather than many.",
    inputSchema: {
      nodeId: z
        .string()
        .optional()
        .describe(
          'Preview this node. Bare id, or "<id>:out" / "<id>:aux:<name>" (e.g. circle-abc:aux:image).'
        ),
      frame: z.number().optional().describe("Render this frame (integer)."),
      maxSize: z
        .number()
        .optional()
        .describe("Long-edge pixel cap, 64–2048 (JPEG default 1024, PNG default 720)."),
      format: z
        .enum(["jpeg", "png"])
        .optional()
        .describe('Image format. jpeg (default) for a visual check; png for lossless.'),
      quality: z
        .number()
        .optional()
        .describe("JPEG quality 0.4–1 (default 0.82). Ignored for png."),
    },
  },
  {
    name: "insert_recipe",
    mutates: true,
    resultKind: "text",
    timeoutMs: MUTATION_TIMEOUT_MS,
    description:
      "Build and insert a new node-group from a RecipeGraph. Pass `recipes` " +
      "(array) to insert several sibling groups in ONE call / one undo — " +
      "prefer that over N insert_recipe round-trips when the designs share " +
      "a skeleton; or insert one group and edit_group duplicate_node with " +
      "param overrides. `scope` " +
      "chooses the parent: omit to use the current editor layer; pass a " +
      "layer/group/zone id to insert there; \"parent\" = sibling of the " +
      "current group; \"root\" = a new composition layer. If the editor is " +
      "inside a node-group, scope is REQUIRED — omitting it would nest the " +
      "new group inside the one you're looking at. By default (`connect: " +
      "true`) the group's outputs are wired into the enclosing Output " +
      "sockets that are currently empty. Pass `connect: false` to leave it " +
      "unwired, or `replace_output: true` to steal occupied Output sockets " +
      "(the previous wire is dropped). Occupied sockets without " +
      "replace_output come back as a warning, not a silent note. Group " +
      "shells have no primary — address them as aux:<name> (usually " +
      "aux:image), not :out. Validation errors come back as the tool " +
      "error. On success returns groupId, parentId, `rev`, and `ids` (recipe " +
      "local id → minted live id, including \"<zone>-input\" for compound " +
      "zones) so you do not need a follow-up get_graph just to patch. " +
      "A `recipes` batch returns `groups: [{name, groupId, ids, wired}]`; " +
      "`connect` applies to the last group only. " +
      "The user sees a toast and can undo. Pass `dry_run: true` to run the " +
      "same build + validation WITHOUT touching the graph: returns valid " +
      "true + warnings (or the same validation error a real insert would), " +
      "so wiring (:param:<name>, mask:<n> sockets, edge grammar) can be " +
      "checked before mutating; `rev` is unchanged and no ids are minted. " +
      RECIPE_CONTRACT,
    inputSchema: {
      recipe: z
        .record(z.string(), z.unknown())
        .optional()
        .describe("The RecipeGraph object."),
      dry_run: z
        .boolean()
        .optional()
        .describe(
          "Validate only — build + validator pass, nothing inserted, no undo entry, rev unchanged (default false)."
        ),
      recipes: z
        .array(z.record(z.string(), z.unknown()))
        .optional()
        .describe(
          "Insert several RecipeGraphs as sibling groups in one call. Prefer duplicate_node when they differ by a couple of params."
        ),
      connect: z
        .boolean()
        .optional()
        .describe(
          "Wire the group into empty enclosing Output sockets (default true). False leaves it unwired."
        ),
      replace_output: z
        .boolean()
        .optional()
        .describe(
          "When connect is true, replace an occupied enclosing Output wire instead of leaving the group unwired (default false)."
        ),
      scope: z
        .string()
        .optional()
        .describe(
          'Parent id, or "parent" (enclosing layer/group), or "root" (new layer). Required when the editor is inside a node-group.'
        ),
    },
  },
  {
    name: "edit_group",
    mutates: true,
    resultKind: "text",
    timeoutMs: MUTATION_TIMEOUT_MS,
    description:
      "Apply a minimal patch to an existing node-group OR layer's interior " +
      "(layers are the root-level building blocks — their content is edited " +
      "the same way; a layer shell's own params like blendMode are also " +
      "settable). Call get_graph with scope=groupId first. Local ids from " +
      "add_node / duplicate_node in this same batch resolve everywhere " +
      "(set_param, add_edge, rename_node, …). Each op is a flat JSON object " +
      "with \"op\" plus fields — example: {\"op\": \"set_param\", \"node\": \"<id>\", " +
      "\"param\": \"count\", \"value\": 12}. Nested {\"set_param\": {...}} " +
      "and unknown ops are tool errors, not silent no-ops. Default result is " +
      "compact: `applied`, `failed[]`, `duplicated[]` (counts + errors only), " +
      "and `ids` (add_node / duplicate_node local id → minted live id, " +
      'including "<zone>-input" — same map insert_recipe returns). ' +
      "Pass `verbosity: \"full\"` for the per-op echo. `rev` is the mutation " +
      "counter — after a timeout, get_recent_edits({summary}) or " +
      "get_graph({since: rev}) tells you whether this landed. " +
      "Ops (ordered): set_param (node, param, value) · add_node (id, type, " +
      "params?, parent?) (fresh local id you then wire; parent is a Repeat/" +
      "For Each zone id) · duplicate_node (node, id, params?, name?, patch?) " +
      "clones a node or nested group (interior included) as a sibling; " +
      "`params` apply to the clone shell (exposed knobs on a group); " +
      "`patch` is [{node, param, value}] using ORIGINAL interior ids, remapped " +
      "onto the clone — use this instead of 100 insert_recipe calls that " +
      "differ by two params. Returns `ids` original→clone. · " +
      "remove_node (node) (a nested node-group is " +
      "removable — interior goes with it; Group Input/Output and the " +
      "scope itself are not; exposed knobs whose only consumer was the " +
      "deleted node are dropped from the interface) · " +
      "add_edge (from, to) (both ends must be in this scope — a node inside " +
      "a nested group is a different edit_group target; missing ends are " +
      "errors, not silent no-ops) · remove_edge (from, to) · expose_param (node, param, " +
      "label?) (shell inputValues seed from the interior value so 0.3 " +
      "does not become 0) · unexpose_param (node, param) · rename_node (node, name). Edge " +
      "grammar and param rules are the same as insert_recipe. A param " +
      "listed under `keyframed` is animated — setting its static value " +
      "does nothing. To put an interior socket (including a socketed " +
      "channel: ch/toggle/color/ramp) " +
      "on the group, add_edge from interface.inputNodeId:aux:<name> to " +
      "<node>:in:<socket> — the named group input is minted. " +
      "aux:__virtual__ does the same (names after the target); a leftover " +
      "edge on __virtual__ is rejected. expose_param also accepts a channel " +
      "name (promoted as a wire-only socket — no shell value; you will get " +
      "a warning). set_param also accepts a channel NAME as " +
      "`param` to tune an existing row (ramp: [{position,color,alpha?}], " +
      "curve: [{x,y}]). Setting a param listed under `exposed` is shadowed " +
      "by the group-level value — the op succeeds with a PARAM_EXPOSED " +
      "warning; set_param the group shell with the exposed label instead. " +
      "Change by exception; never rebuild what you can patch. " +
      "Validation errors return as the tool error — fix and retry. " +
      "`dry_run: true` applies the ops to a copy and validates without " +
      "committing (no undo entry, rev unchanged) — returns applied / " +
      "failed[] / warnings exactly as the real call would.",
    inputSchema: {
      groupId: z.string().describe("The node-group or layer id."),
      dry_run: z
        .boolean()
        .optional()
        .describe(
          "Validate only — apply the ops to a copy and run the validator, commit nothing (default false)."
        ),
      ops: z
        .array(z.record(z.string(), z.unknown()))
        .describe(
          'Ordered edit operations. Each is a flat object with "op" plus fields, e.g. {"op": "set_param", "node": "<id>", "param": "count", "value": 12}. Nested {"remove_node": {"node": "…"}} is rejected.'
        ),
      summary: z
        .string()
        .optional()
        .describe("One short sentence shown to the user and stored in get_recent_edits."),
      verbosity: z
        .enum(["counts", "full"])
        .optional()
        .describe(
          'counts (default) = applied + failed[] only. full = per-op echo (expensive on large patches).'
        ),
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
      "the UI sliders use (undo + auto-keyframing included). color_ramp " +
      "params take [{position, color, alpha?}] (same as GLSL ramp() channels); " +
      "float_curve params (Map Attribute `curve`, Scene Time `easing_curve`, " +
      "Float Curve `curve`) take [{x, y}] with x, y in 0..1 and at least 2 " +
      "points (same as curve() channels; ids optional). Every successful " +
      "write bumps `rev` (returned) and is listed by get_recent_edits. " +
      "Setting " +
      "`expression` on Point Expression / GLSL Expression also Syncs new " +
      "channels (ch/toggle/pick/color/ramp/curve; add-only, ids preserved) — " +
      "patch in place; do not replace the node to grow uniforms. Sync never " +
      "changes an existing row, so to TUNE a channel pass its NAME as " +
      "`param` (get_graph lists them under `channels`): number, true/false, " +
      "an option string, \"#rrggbb\", ramp stops [{position, color, alpha?}], " +
      "or curve points [{x, y}]. The channel list itself (`inputs`) is not " +
      "settable. On a node-group or layer shell, `param` is the exposed " +
      "label (the name get_graph shows under that node's params / " +
      "interface.values) — that writes the group-level value that wins at " +
      "eval. Setting an interior param that is listed under `exposed` " +
      "returns a warning: group value wins.",
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
      "image — the cheap way to judge motion. Default is JPEG. Pass explicit " +
      "`frames` (2–12), or a `start`/`end`/`every` range (defaults: 0 → loop " +
      "end, ~6 samples). Each cell is labelled f<frame>. Pick the count that " +
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
      nodeId: z
        .string()
        .optional()
        .describe(
          'Preview this node. Bare id, or "<id>:out" / "<id>:aux:<name>" (e.g. circle-abc:aux:image).'
        ),
      maxSize: z
        .number()
        .optional()
        .describe("Long-edge cap for the WHOLE grid (JPEG default 1400, PNG default 900)."),
      format: z
        .enum(["jpeg", "png"])
        .optional()
        .describe('Image format. jpeg (default) for a visual check; png for lossless.'),
      quality: z
        .number()
        .optional()
        .describe("JPEG quality 0.4–1 (default 0.82). Ignored for png."),
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
      "before inserting/patching an expression. GLSL Expression is a " +
      "different compiler — use get_shader_errors.",
    inputSchema: {
      source: z.string().describe("The per-point JavaScript block."),
    },
  },
  {
    name: "get_shader_errors",
    mutates: false,
    resultKind: "text",
    timeoutMs: CMD_TIMEOUT_MS,
    description:
      "Compile a GLSL Expression through the editor's live WebGL and " +
      "return the info log. A compile error still renders passthrough or " +
      "transparent — the screenshot cannot tell you why; this is the " +
      "message that otherwise only hits the browser console. Pass `nodeId` " +
      "for one node, or omit to inspect every GLSL Expression in the " +
      "project. `preludeLines` is the owned template before your body; " +
      "subtract it from info-log line numbers. Text-level issues " +
      "(#version / main() / missing fragColor) come back as `problems`. " +
      "Point Expression is validate_expression, not this tool.",
    inputSchema: {
      nodeId: z
        .string()
        .optional()
        .describe("GLSL Expression node id. Omit to compile every one in the graph."),
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
  {
    name: "tidy",
    mutates: true,
    resultKind: "text",
    timeoutMs: CMD_TIMEOUT_MS,
    description:
      "Lay nodes out along their wires (left→right columns, straight " +
      "wires, fan-in in socket order, zones/frames kept together). Pass " +
      "`nodes` (ids from get_graph) to tidy just those — they are laid out " +
      "as if alone and re-centred where they were; omit to tidy a whole " +
      "scope: `scope` = a group/layer id, default the scope the editor is " +
      "showing. Idempotent — safe to call after every edit_group batch. " +
      "One undo step; the editor animates the move when the scope is " +
      "visible.",
    inputSchema: {
      nodes: z
        .array(z.string())
        .optional()
        .describe("Node ids to tidy (default: every node in `scope`)."),
      scope: z
        .string()
        .optional()
        .describe(
          'Scope to tidy when `nodes` is omitted: a group/layer id, "root" for the composition root, default the current scope.'
        ),
    },
  },
  // --- graph → GLSL (spec 091626_graph-to-glsl.md) ---------------------------
  {
    name: "plan_glsl_translation",
    mutates: false,
    resultKind: "text",
    timeoutMs: CMD_TIMEOUT_MS,
    description:
      "Plan fusing the node chain that produces an image into ONE GLSL " +
      "Expression node. Call this FIRST when asked to convert / fuse / bake " +
      "a graph or node to GLSL. Walks upstream from `target` (a node id, " +
      "`<id>:out` or `<id>:aux:<name>`; default = the selected node), " +
      "classifies every node (pure / gather / multipass / compiled fuse; " +
      "stateful / opaque do not), and returns: `region` (ids to fuse, " +
      "producers first), `nodes[]` (class, doc slug, non-default params, " +
      "`paramDefs` with CURRENT values + ranges for channel seeds, " +
      "keyframed params, per-pixel `evaluations`), `frontier[]` (wires " +
      "crossing into the region — kind image → sampler `slot` a..d, kind " +
      "channel → a channel socket, kind manual → fold a constant), " +
      "`excluded[]` with reasons (stateful, opaque, sampler cap, zone), " +
      "`time.frames` to screenshot (keyframes + even spacing, or one frame " +
      "for a static graph), `cost.warnings` (multipass approximations, " +
      "gather-of-gather blowups), `targetMask` / `targetOpacity`, `docs` " +
      "(slugs to pass to get_glsl_docs) + `sourceHints` (types with no doc " +
      "yet — get_node_source them), and `skeleton` (an edit_group batch: " +
      "add_node glsl-expression with on_error transparent, rename, and the " +
      "add_edge ops wiring the frontier into a..d and the target's mask; " +
      "`channelEdges` to add once your expression declares those channels). " +
      "The new node is NOT wired into Output — it lands beside the " +
      "originals. `refusal` is set when the target itself cannot be fused; " +
      "relay it, do not improvise.",
    inputSchema: {
      target: z
        .string()
        .optional()
        .describe(
          'Node whose output to reproduce: bare id, "<id>:out" or "<id>:aux:<name>". Default: the selected node.'
        ),
      maxInputs: z
        .number()
        .optional()
        .describe("Sampler budget 1–4 (default 4). Lower to force a smaller region."),
    },
  },
  {
    name: "get_glsl_docs",
    mutates: false,
    resultKind: "text",
    timeoutMs: CMD_TIMEOUT_MS,
    description:
      "Translation guidance for writing a fused GLSL Expression — the engine " +
      "conventions an agent that knows GLSL still gets wrong (v_uv is Y-UP " +
      "while spline/point space is Y-DOWN canvas01 with width-relative y; " +
      "straight alpha; RGBA16F range; mask/opacity are evaluator passes; " +
      "channel grammar; the 4-sampler cap), the fusion pattern (one hoisted " +
      "helper per node, gathers re-evaluate upstream at offset uvs, cost), " +
      "how to read parity diffs, and one doc per node type where authored. " +
      "With no args returns the three core docs (conventions, fusion, " +
      "parity). Pass `slugs` from plan_glsl_translation's `docs`, or " +
      "`types` (node type strings) to resolve through the class table. " +
      "Missing docs are named in the trailer, never silently skipped; over " +
      "~40k chars the result is cut and says which slugs to fetch next.",
    inputSchema: {
      slugs: z
        .union([z.string(), z.array(z.string())])
        .optional()
        .describe('Doc slugs, e.g. ["conventions", "nodes/displace"]. Omit for the core three.'),
      types: z
        .union([z.string(), z.array(z.string())])
        .optional()
        .describe("Node type strings whose docs to include (resolved through the class table)."),
    },
  },
  {
    name: "compare_renders",
    mutates: false,
    resultKind: "compare",
    timeoutMs: SCREENSHOT_TIMEOUT_MS,
    description:
      "Render two nodes at the same frames and return ONE image — a row per " +
      "frame, columns A | B | |A−B| heat — plus numeric parity metrics per " +
      "frame from a small RGBA8 readback: meanAbs (RGB where both alphas " +
      "are above a floor), p95Abs, alphaMeanAbs, overThreshold, the uv " +
      "bounding box of the worst region, and a verdict match / close / off " +
      "(bands are provisional). This is the parity oracle for the graph → " +
      "GLSL loop: read the numbers first, the heat second, the renders " +
      "last, and fix the cause the parity doc ranks for that diff shape. " +
      "`a` is the original, `b` the fused node (nodeRef grammar as " +
      "screenshot: bare id, <id>:out, <id>:aux:<name>); `frames` 1–8 " +
      "(use the plan's time.frames and keep them fixed across iterations; " +
      "default = the current frame). If B is a GLSL Expression that " +
      "failed to compile the text says so — a broken shader is transparent, " +
      "not wrong.",
    inputSchema: {
      a: z.string().describe("Reference node (the original)."),
      b: z.string().describe("Candidate node (the fused GLSL Expression)."),
      frames: z.array(z.number()).optional().describe("Frames to compare (1–8). Default: current frame."),
      maxSize: z
        .number()
        .optional()
        .describe("Long-edge cap for the WHOLE grid (default 1400)."),
      threshold: z
        .number()
        .optional()
        .describe("Per-pixel max-channel error (0–1) counted as 'over' (default 0.02 ≈ 5/255)."),
    },
  },
];

/** Tool names that mutate the document — the session-scoped grant set. */
export const MUTATING_TOOLS = BRIDGED_TOOLS.filter((t) => t.mutates).map(
  (t) => t.name
);

export function screenshotCaption(result) {
  let text = `frame ${result.frame}, ${result.width}×${result.height}`;
  if (result.shaderError) {
    const prelude = result.shaderPreludeLines;
    text +=
      `\nGLSL compile failed — the pixels are passthrough/transparent, not the shader.` +
      (prelude != null
        ? ` Info-log line numbers include a ${prelude}-line template prelude before the body you wrote.`
        : "") +
      `\n${result.shaderError}`;
  }
  if (Array.isArray(result.shaderProblems) && result.shaderProblems.length) {
    text += `\n${result.shaderProblems.map((p) => `- ${p}`).join("\n")}`;
  }
  return text;
}

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
          text: screenshotCaption(result),
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
  if (def.resultKind === "compare") {
    // The metrics ARE the result; the image is for the model's eyes.
    return {
      content: [
        { type: "image", data: result.base64, mimeType: result.mimeType },
        {
          type: "text",
          text:
            `${result.summary}\n` +
            `frames [${result.frames.join(", ")}] in a ${result.grid.cols}×${result.grid.rows} grid, ` +
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
