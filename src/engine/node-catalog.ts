// Node catalog generator — the machine-readable description of every
// built-in node, fed to the LLM as context for AI Recipe Generation
// (specdocs/062526_ai-recipe-generation.md, milestone 1).
//
// Pure + engine-side (invariant #1): derives entirely from the registered
// NodeDefinitions, so it can never drift from the running app and runs both
// server-side (the generate route) and in the browser.

import type { NodeDefinition, ParamDef, ParamType } from "./types";

// Param types the LLM may SET. These are the plain-JSON, generically
// rendered types (ParamPanel renders them without a bespoke editor and they
// serialize as `out[key] = val`). Everything else — media handles and
// authoring-heavy structured editors — is placeable but not settable.
// See spec §7.
export const SETTABLE_PARAM_TYPES: ReadonlySet<ParamType> = new Set([
  "scalar",
  "vec2",
  "vec3",
  "vec4",
  "color",
  "boolean",
  "enum",
  "string",
]);

export interface CatalogSocket {
  name: string;
  type: string;
  required?: boolean;
}

export interface CatalogParam {
  name: string;
  type: ParamType;
  // Whether the LLM may emit a value for this param. False ⇒ leave at default.
  settable: boolean;
  default?: unknown;
  min?: number;
  max?: number;
  options?: string[];
}

export interface CatalogNode {
  type: string;
  name: string;
  category: string;
  subcategory?: string;
  description?: string;
  // True when the node retypes its sockets at runtime
  // (resolveInputs / resolvePrimaryOutput / resolveAuxOutputs). The static
  // inputs/outputs below are the unwired baseline; the validator resolves
  // real types during its topo pass.
  dynamic?: boolean;
  inputs: CatalogSocket[];
  primaryOutput: string | null;
  aux: CatalogSocket[];
  params: CatalogParam[];
}

export interface CatalogOptions {
  // Drop node/param descriptions to shrink the context. Default false.
  omitDescriptions?: boolean;
  // Drop params entirely (just sockets). For measuring the socket-only floor.
  omitParams?: boolean;
}

function paramToCatalog(p: ParamDef): CatalogParam {
  const settable = SETTABLE_PARAM_TYPES.has(p.type);
  const out: CatalogParam = { name: p.name, type: p.type, settable };
  if (settable) {
    // The LLM only needs defaults/ranges/options for params it can set.
    if (p.default !== undefined) out.default = p.default;
    if (p.min !== undefined) out.min = p.min;
    if (p.max !== undefined) out.max = p.max;
    if (p.options) out.options = p.options;
  }
  return out;
}

function defToCatalog(def: NodeDefinition, opts: CatalogOptions): CatalogNode {
  const dynamic = !!(
    def.resolveInputs ||
    def.resolvePrimaryOutput ||
    def.resolveAuxOutputs
  );

  const node: CatalogNode = {
    type: def.type,
    name: def.name,
    category: def.category,
    inputs: def.inputs.map((i) => ({
      name: i.name,
      type: i.type,
      ...(i.required ? { required: true } : {}),
    })),
    primaryOutput: def.primaryOutput,
    aux: def.auxOutputs.map((a) => ({ name: a.name, type: a.type })),
    params: opts.omitParams ? [] : def.params.map(paramToCatalog),
  };
  if (def.subcategory) node.subcategory = def.subcategory;
  if (dynamic) node.dynamic = true;
  if (!opts.omitDescriptions && def.description) node.description = def.description;
  return node;
}

export function buildNodeCatalog(
  defs: NodeDefinition[],
  opts: CatalogOptions = {}
): CatalogNode[] {
  return defs
    .filter((d) => !d.hidden) // skip back-compat aliases + structural internals
    .map((d) => defToCatalog(d, opts))
    .sort((a, b) => a.type.localeCompare(b.type));
}

// Compact one-line-per-node DSL — the cached prompt format (~3.4× denser than
// JSON; see spec §4). One line: `type (Name) [cat/sub] ~dyn: in a:scalar!,b:scalar
// -> primary aux=x:image | param:type=default(min..max)[opts]`. `~dyn` flags
// polymorphic nodes; `!` marks required inputs; only settable params are listed.
export function formatCatalogDsl(nodes: CatalogNode[]): string {
  return nodes
    .map((n) => {
      const ins = n.inputs.map((i) => `${i.name}:${i.type}${i.required ? "!" : ""}`).join(",");
      const aux = n.aux.length ? ` aux=${n.aux.map((a) => `${a.name}:${a.type}`).join(",")}` : "";
      const ps = n.params
        .filter((p) => p.settable)
        .map((p) => {
          let s = `${p.name}:${p.type}`;
          if (p.default !== undefined) s += `=${JSON.stringify(p.default)}`;
          if (p.options) s += `[${p.options.join("|")}]`;
          else if (p.min !== undefined || p.max !== undefined) s += `(${p.min ?? ""}..${p.max ?? ""})`;
          return s;
        })
        .join(" ");
      const sub = n.subcategory ? `/${n.subcategory}` : "";
      const dyn = n.dynamic ? " ~dyn" : "";
      const desc = n.description ? `\n    # ${n.description}` : "";
      return `${n.type} (${n.name}) [${n.category}${sub}]${dyn}: in ${ins} -> ${n.primaryOutput ?? "none"}${aux}${ps ? ` | ${ps}` : ""}${desc}`;
    })
    .join("\n");
}
