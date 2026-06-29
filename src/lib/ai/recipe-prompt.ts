// Prompt + structured-output contract for AI Recipe Generation (spec §5).
// Pure data — NO engine/state runtime imports (only `import type`, which is
// erased), so the server route that imports this never pulls the
// browser-oriented node tree into the Node runtime.

import type Anthropic from "@anthropic-ai/sdk";
import type { RecipeGraph } from "@/state/recipe-builder";
import type { GroupSpec, RecipeEdit } from "@/state/recipe-edit";

// The forced tool Claude must call. Using a tool (rather than strict
// `output_config.format`) lets `params` be an open object — strict structured
// outputs forbid `additionalProperties` other than false, which can't express
// an arbitrary param map. The builder + validator are the real guarantee; this
// just shapes the response.
export const RECIPE_TOOL: Anthropic.Tool = {
  name: "emit_recipe",
  description:
    "Emit one node-graph recipe assembled from existing built-in nodes. Call exactly once.",
  input_schema: {
    type: "object",
    additionalProperties: false,
    required: ["name", "nodes", "outputs"],
    properties: {
      name: { type: "string", description: "Short human title for the recipe." },
      description: { type: "string" },
      nodes: {
        type: "array",
        description: "Interior nodes. Each id is local to this recipe.",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["id", "type"],
          properties: {
            id: { type: "string" },
            type: { type: "string", description: "A node `type` from the catalog." },
            params: {
              type: "object",
              description:
                "Settable params only (catalog params without ~ are settable). Names → values.",
            },
          },
        },
      },
      edges: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["from", "to"],
          properties: {
            from: { type: "string", description: '"<id>:out" or "<id>:aux:<name>"' },
            to: { type: "string", description: '"<id>:in:<socket>" or "<id>:param:<name>"' },
          },
        },
      },
      inputs: {
        type: "array",
        description: "External inputs of the recipe group.",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["name", "from", "type"],
          properties: {
            name: { type: "string" },
            from: { type: "string", description: 'Interior target, "<id>:in:<socket>".' },
            type: { type: "string" },
          },
        },
      },
      outputs: {
        type: "array",
        description: "External outputs of the recipe group (at least one).",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["name", "from", "type"],
          properties: {
            name: { type: "string" },
            from: { type: "string", description: 'Interior source, "<id>:out" or "<id>:aux:<name>".' },
            type: { type: "string" },
          },
        },
      },
      exposed: {
        type: "array",
        description: "Interior params surfaced as knobs on the group.",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["name", "node", "param"],
          properties: {
            name: { type: "string", description: "Label on the group." },
            node: { type: "string", description: "Local node id." },
            param: { type: "string" },
          },
        },
      },
    },
  },
};

export const SYSTEM_PREAMBLE = `You assemble "recipes" for a node-graph motion-design tool. A recipe is a small subgraph built ONLY from the existing built-in nodes listed in the catalog below, wrapped as a reusable group. You never write code — you choose nodes and wire them.

Rules:
- Use only node \`type\` strings that appear in the catalog. Never invent a type.
- Wire compatible socket types. Coercions allowed: mask↔image, scalar→vec2/vec3/vec4/uv, image/mask→scalar, audio→scalar, image↔element. Anything else must match exactly.
- Only set params marked settable in the catalog (scalar/vec/color/boolean/enum/string). Respect each param's range and enum options. Never set media/structured params.
- The graph must be acyclic.
- Declare the recipe's external interface: \`inputs\` (sockets the user feeds), \`outputs\` (at least one), and \`exposed\` (interior params surfaced as knobs).

Edge endpoint grammar:
- source: "<id>:out" (primary) or "<id>:aux:<name>"
- target: "<id>:in:<socket>" or "<id>:param:<name>"

Every node also has an implicit universal \`mask\` input and, where it makes sense, an \`opacity\` scalar param — these are not listed per-node. Respond by calling emit_recipe exactly once.`;

export function buildSystem(catalogDsl: string) {
  // Two system blocks; cache the catalog (the large, stable suffix).
  return [
    { type: "text" as const, text: SYSTEM_PREAMBLE },
    {
      type: "text" as const,
      text: `# Node catalog\n\n${catalogDsl}`,
      cache_control: { type: "ephemeral" as const },
    },
  ];
}

export function buildUserContent(
  request: string,
  repair?: { recipe: RecipeGraph; errors: string[] }
): string {
  if (!repair) return `Build a recipe for: ${request}`;
  return [
    `Build a recipe for: ${request}`,
    ``,
    `Your previous attempt was invalid. Fix these problems and emit a corrected recipe:`,
    ...repair.errors.map((e) => `- ${e}`),
    ``,
    `Previous attempt (for reference):`,
    JSON.stringify(repair.recipe),
  ].join("\n");
}

// =====================================================================
// Edit mode — patch an existing group (spec 062926_edit-group-with-ai.md).
// =====================================================================

// The forced tool Claude calls to emit a patch. Non-strict (open `value` /
// `params`); apply + the validator are the real guarantee.
export const EDIT_RECIPE_TOOL: Anthropic.Tool = {
  name: "edit_recipe",
  description:
    "Emit a minimal patch (a list of edit ops) for the group shown. Call exactly once.",
  input_schema: {
    type: "object",
    additionalProperties: false,
    required: ["summary", "ops"],
    properties: {
      summary: {
        type: "string",
        description: "One short sentence describing the change you made.",
      },
      ops: {
        type: "array",
        description: "Ordered edit operations. Each op's `op` selects its kind.",
        items: {
          type: "object",
          description:
            "One op. Include only the fields for its kind: " +
            "set_param{node,param,value} · add_node{id,type,params?} · " +
            "remove_node{node} · add_edge{from,to} · remove_edge{from,to} · " +
            "expose_param{node,param,label?} · unexpose_param{node,param} · " +
            "rename_node{node,name}.",
          required: ["op"],
          properties: {
            op: {
              type: "string",
              enum: [
                "set_param",
                "add_node",
                "remove_node",
                "add_edge",
                "remove_edge",
                "expose_param",
                "unexpose_param",
                "rename_node",
              ],
            },
            node: { type: "string", description: "Existing node id." },
            param: { type: "string" },
            value: { description: "New settable value (set_param)." },
            id: { type: "string", description: "Fresh local id for add_node." },
            type: { type: "string", description: "Catalog node type (add_node)." },
            params: { type: "object", description: "Settable params for add_node." },
            from: {
              type: "string",
              description: 'Source endpoint "<id>:out" | "<id>:aux:<name>".',
            },
            to: {
              type: "string",
              description: 'Target endpoint "<id>:in:<sock>" | "<id>:param:<name>".',
            },
            label: { type: "string", description: "Knob label on the group (expose_param)." },
            name: { type: "string", description: "New display name (rename_node)." },
          },
        },
      },
    },
  },
};

export const EDIT_SYSTEM_PREAMBLE = `You edit an existing node-group in a node-graph motion-design tool. You are shown the group's current interior (nodes with their settable params, edges, and external interface) and an instruction. Emit the SMALLEST patch that satisfies it — change by exception, never rebuild.

Rules:
- Reference existing nodes by their \`id\` exactly as given. Only \`add_node\` introduces a new node (give it a fresh local id you then wire with edges).
- Use only node \`type\` strings from the catalog. Wire compatible socket types (coercions: mask↔image, scalar→vec2/3/4/uv, image/mask→scalar, audio→scalar, image↔element; otherwise exact).
- Only set params marked settable; respect ranges/enum options. A param listed under \`keyframed\` is animated — changing its static value won't take effect, so don't.
- The group's boundary (its inputs/outputs) is reachable for wiring via \`interface.inputNodeId\` / \`interface.outputNodeId\`, but you may not retune or delete boundary/structural nodes.
- To surface a param as a knob on the group, use \`expose_param\` (give a short \`label\`); \`unexpose_param\` removes it. Only params with a socket type (scalar/vec/color/boolean) can be exposed.
- Keep the change minimal and the graph acyclic. Respond by calling edit_recipe exactly once.`;

export function buildEditSystem(catalogDsl: string) {
  return [
    { type: "text" as const, text: EDIT_SYSTEM_PREAMBLE },
    {
      type: "text" as const,
      text: `# Node catalog\n\n${catalogDsl}`,
      cache_control: { type: "ephemeral" as const },
    },
  ];
}

export function buildEditUserContent(
  groupSpec: GroupSpec,
  instruction: string,
  opts?: {
    history?: { instruction: string; summary: string }[];
    repair?: { edit: RecipeEdit; errors: string[] };
  }
): string {
  const lines: string[] = [
    `# Current group: ${groupSpec.name}`,
    JSON.stringify(groupSpec),
  ];
  if (opts?.history?.length) {
    lines.push("", "# Earlier this session");
    for (const h of opts.history) lines.push(`- you asked "${h.instruction}" → ${h.summary}`);
  }
  lines.push("", `# Instruction`, instruction);
  if (opts?.repair) {
    lines.push(
      "",
      "Your previous patch was invalid. Fix these and emit a corrected patch:",
      ...opts.repair.errors.map((e) => `- ${e}`),
      "",
      "Previous patch:",
      JSON.stringify(opts.repair.edit)
    );
  }
  return lines.join("\n");
}
