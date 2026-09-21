// Node catalog generator — the machine-readable description of every
// built-in node, fed to the LLM as context for AI Recipe Generation
// (specdocs/archive/062526_ai-recipe-generation.md, milestone 1).
//
// Pure + engine-side (invariant #1): derives entirely from the registered
// NodeDefinitions, so it can never drift from the running app and runs both
// server-side (the generate route) and in the browser.

import type { NodeDefinition, NodeFacts, ParamDef, ParamType } from "./types";
import { ASPECT_SPACE_DOC } from "./aspect";
import { vetColorRampStops } from "./color-ramp";
import { compactFloatCurve, vetFloatCurvePoints } from "./float-curve";
import { isSwitchSlot } from "./graph-helpers";

// Param types the LLM may SET. These are the plain-JSON, generically
// rendered types (ParamPanel renders them without a bespoke editor and they
// serialize as `out[key] = val`). Everything else — media handles and
// authoring-heavy structured editors — is placeable but not settable.
// See spec §7. `color_ramp` is the structured exception: same
// [{position,color,alpha?}] shape as GLSL ramp() channels, so palette
// authoring (Color Ramp stops, Rasterize fill/stroke ramps) is writable.
// `float_curve` follows the same reasoning: [{x, y}] is the curve()
// channel shape, and Map Attribute / Scene Time / Float Curve are unusable
// remotely when their whole value is the curve.
export const SETTABLE_PARAM_TYPES: ReadonlySet<ParamType> = new Set([
  "scalar",
  "vec2",
  "vec3",
  "vec4",
  "color",
  "boolean",
  "enum",
  "string",
  "color_ramp",
  "float_curve",
  // Switch per-input names, `{ in0: "Day", in1: "Night" }` — plain JSON
  // keyed by slot socket, so a recipe can name the states of a toggle-mode
  // Switch it just wired.
  "slot_labels",
]);

// Vet an LLM-supplied VALUE against its ParamDef. The builder/edit paths
// check param names and settable types; without this, values crossed the
// trust boundary unchecked — `"abc"` into a scalar, 1e999 (JSON → Infinity),
// a non-option enum — and, worse, serialized verbatim into saved projects.
// Rejections surface as BAD_PARAM_VALUE build issues (blocking, so the
// repair loop fixes them); out-of-hard-range scalars are clamped like the
// UI's sliders rather than rejected.
const MAX_STRING_LEN = 20_000;
// A Switch input name has to fit one segment of a three-way pill.
const MAX_LABEL_LEN = 64;
const HEX_COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

function finiteVec(v: unknown, arity: number): v is number[] {
  return (
    Array.isArray(v) &&
    v.length === arity &&
    v.every((x) => typeof x === "number" && Number.isFinite(x))
  );
}

export function vetParamValue(
  pdef: ParamDef,
  value: unknown
): { ok: true; value: unknown } | { ok: false; reason: string } {
  switch (pdef.type) {
    case "scalar": {
      if (typeof value !== "number" || !Number.isFinite(value))
        return { ok: false, reason: "expected a finite number" };
      let v = value;
      if (pdef.min !== undefined) v = Math.max(pdef.min, v);
      // softMax is a UI soft ceiling — values beyond it are legitimate;
      // only the hard max clamps, matching the slider behavior.
      if (pdef.max !== undefined) v = Math.min(pdef.max, v);
      return { ok: true, value: v };
    }
    case "boolean":
      return typeof value === "boolean"
        ? { ok: true, value }
        : { ok: false, reason: "expected true/false" };
    case "enum": {
      if (typeof value !== "string")
        return { ok: false, reason: "expected an option string" };
      // Font-family enums are open-world (locally installed fonts merge into
      // the option list at runtime) — membership can't be enforced there.
      if (
        pdef.options &&
        pdef.control !== "font" &&
        !pdef.options.includes(value)
      )
        return {
          ok: false,
          reason: `not an option (choose from: ${pdef.options.join(", ")})`,
        };
      return { ok: true, value };
    }
    case "string":
      if (typeof value !== "string")
        return { ok: false, reason: "expected a string" };
      if (value.length > MAX_STRING_LEN)
        return { ok: false, reason: `string too long (max ${MAX_STRING_LEN})` };
      return { ok: true, value };
    case "color":
      // Stored form is a hex string; keyframe machinery also produces RGBA
      // tuples, so accept both.
      if (typeof value === "string" && HEX_COLOR.test(value))
        return { ok: true, value };
      if (finiteVec(value, 4) || finiteVec(value, 3))
        return { ok: true, value };
      return { ok: false, reason: "expected \"#rrggbb\" (or an RGBA tuple)" };
    case "vec2":
      return finiteVec(value, 2)
        ? { ok: true, value }
        : { ok: false, reason: "expected [x, y] finite numbers" };
    case "vec3":
      return finiteVec(value, 3)
        ? { ok: true, value }
        : { ok: false, reason: "expected [x, y, z] finite numbers" };
    case "vec4":
      return finiteVec(value, 4)
        ? { ok: true, value }
        : { ok: false, reason: "expected [x, y, z, w] finite numbers" };
    case "color_ramp":
      return vetColorRampStops(value);
    case "float_curve":
      return vetFloatCurvePoints(value);
    case "slot_labels": {
      if (!value || typeof value !== "object" || Array.isArray(value))
        return {
          ok: false,
          reason: 'expected { "in0": "name", "in1": "name", … } keyed by slot',
        };
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        if (!isSwitchSlot(k))
          return { ok: false, reason: `"${k}" is not a slot socket (in0, in1, …)` };
        if (typeof v !== "string")
          return { ok: false, reason: `"${k}": expected a string name` };
        if (v.length > MAX_LABEL_LEN)
          return { ok: false, reason: `"${k}": name too long (max ${MAX_LABEL_LEN})` };
        out[k] = v;
      }
      return { ok: true, value: out };
    }
    default:
      // Not an LLM-settable type — callers gate on SETTABLE_PARAM_TYPES
      // before vetting, so this is unreachable in practice.
      return { ok: false, reason: `type "${pdef.type}" is not settable` };
  }
}

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
  // UI labels for enum options (stored value stays `options[i]`).
  optionLabels?: Record<string, string>;
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
  // Operational mini-schema (see NodeFacts). Omitted with descriptions.
  facts?: NodeFacts;
  // Derived from def flags, never authored: simulation, unstable, terminal,
  // no-mask, gates-outputs, retimeable, clock=<input>. Meanings: FLAGS_DOC.
  flags?: string[];
}

// Catalog header lines. Exported so the check scripts can assert the prompt
// still carries them.
export const SPACE_TABLE_DOC =
  "Socket spaces by type: spline/points=canvas01 ([0,1]² Y-down in WIDTH units — y is scaled about " +
  "0.5 by W/H, so every distance/radius is width-relative and on a landscape canvas only " +
  "y∈[0.5−H/2W, 0.5+H/2W] is on screen) · image/mask/uv=raster (per pixel; offsets inside are " +
  "uv01 = per-axis fractions, not aspect-corrected) · pixels=absolute at render resolution · " +
  "sdf/position/scalar_field=canvas01 (evaluated per pixel by SDF Rasterize) · " +
  "points3d/geometry/render=world3d (Y-up units) · audio/notes=time · " +
  "scalar/vecN/color/string=unitless. Per-node `space:` lines list only exceptions, position/size " +
  "params, and polymorphic follow-rules (out=in:x → out takes x's space; a|b → accepts either).";
export const Y_ORIENT_DOC =
  "canvas01 is Y-down (y=0 at the top); uv01 (Gradient, v_uv in GLSL) is Y-up (v=0 at the bottom).";
export const UNSETTABLE_PARAM_DOC =
  "Params tagged ~(not remotely settable) exist on the node but set_param / recipe params cannot write them.";
export const FLAGS_DOC =
  "Flags: simulation=state accumulates across frames (step from frame 0) · unstable=never cached " +
  "(reads external state) · terminal=graph sink · no-mask=no universal mask input · " +
  "gates-outputs=only builds consumed outputs · clock=<input> drives its own time.";

export function catalogFlags(def: NodeDefinition): string[] {
  const flags: string[] = [];
  if (def.simulation) flags.push("simulation");
  if (def.stable === false) flags.push("unstable");
  if (def.terminal) flags.push("terminal");
  if (def.noMaskInput) flags.push("no-mask");
  if (def.gatesOutputs) flags.push("gates-outputs");
  if (def.retimeable) flags.push("retimeable");
  if (def.clockInput) flags.push(`clock=${def.clockInput.input}`);
  return flags;
}

// Fixed-order fact lines for one node: space, reads, writes, flags, then one
// `! gotcha` per line. Space entries with the same value are grouped
// (`param:x,param:y=canvas01`); polymorphic lists print as `a|b`.
export function formatFactsLines(facts: NodeFacts | undefined, flags: string[] | undefined): string[] {
  const lines: string[] = [];
  if (facts?.space && Object.keys(facts.space).length) {
    const groups = new Map<string, string[]>();
    for (const [k, v] of Object.entries(facts.space)) {
      const key = Array.isArray(v) ? v.join("|") : v;
      const arr = groups.get(key) ?? [];
      arr.push(k);
      groups.set(key, arr);
    }
    lines.push(`space: ${[...groups].map(([v, ks]) => `${ks.join(",")}=${v}`).join(" ")}`);
  }
  if (facts?.reads?.length) lines.push(`reads: ${facts.reads.join(", ")}`);
  if (facts?.writes?.length) lines.push(`writes: ${facts.writes.join(", ")}`);
  if (flags?.length) lines.push(`flags: ${flags.join(", ")}`);
  for (const g of facts?.gotchas ?? []) lines.push(`! ${g}`);
  return lines;
}

export interface CatalogOptions {
  // Drop node/param descriptions to shrink the context. Default false.
  omitDescriptions?: boolean;
  // Drop params entirely (just sockets). For measuring the socket-only floor.
  omitParams?: boolean;
}

// True when a recipe / set_param write is accepted. Broader than
// SETTABLE_PARAM_TYPES: merge `layers` and Expression `inputs` have
// dedicated vetting (not generic JSON).
function paramIsSettable(p: ParamDef): boolean {
  if (SETTABLE_PARAM_TYPES.has(p.type)) return true;
  if (p.type === "merge_layers") return true;
  if (p.type === "expr_inputs" && !p.channelSync) return true;
  return false;
}

function paramToCatalog(p: ParamDef): CatalogParam {
  const settable = paramIsSettable(p);
  const out: CatalogParam = { name: p.name, type: p.type, settable };
  if (settable) {
    // The LLM only needs defaults/ranges/options for params it can set.
    // A float_curve default carries random point ids — strip them so the
    // catalog (a cached prompt prefix) is stable across boots.
    if (p.type === "float_curve") out.default = compactFloatCurve(p.default) ?? p.default;
    else if (p.default !== undefined) out.default = p.default;
    if (p.min !== undefined) out.min = p.min;
    if (p.max !== undefined) out.max = p.max;
    if (p.options) out.options = p.options;
    if (p.optionLabels) out.optionLabels = p.optionLabels;
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
    params: opts.omitParams ? [] : def.params.filter((p) => !p.hidden).map(paramToCatalog),
  };
  if (def.subcategory) node.subcategory = def.subcategory;
  if (dynamic) node.dynamic = true;
  if (!opts.omitDescriptions && def.description) node.description = def.description;
  if (!opts.omitDescriptions && def.facts) node.facts = def.facts;
  const flags = catalogFlags(def);
  if (flags.length) node.flags = flags;
  return node;
}

// Compound zones stay `hidden` on the real Input/Output defs (add menus
// synthesize one entry that mints the pair). The catalog still has to
// advertise them so Claude can place `repeat` / `foreach`. Params and
// reserved aux live on the Input; the recipe id is the Output; the Input
// is addressed as "<id>-input". See recipe-builder.
const COMPOUND_ZONE_CATALOG: {
  type: string;
  name: string;
  inputType: string;
  inputs: CatalogSocket[];
  description: string;
  facts: NodeFacts;
}[] = [
  {
    type: "repeat",
    name: "Repeat",
    inputType: "repeat-input",
    inputs: [],
    description:
      'Compound zone: placing this type mints Repeat Output (your id) + Repeat Input ("<id>-input"). Loop params apply to the Input. Wire initial state into "<id>-input:in:<name>" (passthrough mints); re-enter as "<id>-input:aux:<name>"; collect with "<id>:in:<name>" — matching names feed back each generation; last-pass result is "<id>:aux:<name>". Reserved Input aux: index, t, random. Nest For Each inside (and put body nodes in the zone) by setting parent to this id.',
    facts: {
      space: { "in:*": "in:*", out: "in:*" },
      gotchas: [
        "Passthrough: every value keeps the space it was wired in with; the zone adds no coordinate transform.",
        "Body nodes must set parent to the Output id or they run once, outside the loop.",
        "Input aux index/t/random change per generation; a body that ignores them produces identical passes.",
      ],
    },
  },
  {
    type: "foreach",
    name: "For Each Element",
    inputType: "foreach-input",
    inputs: [{ name: "geometry", type: "spline", required: true }],
    description:
      'Compound zone: placing this type mints For Each Output (your id) + For Each Input ("<id>-input"). Wire Geometry to "<id>:in:geometry" (spline or points; domain flips). Current element is "<id>-input:aux:element". Collect like Iterate: "<id>:in:<name>" → grouped "<id>:aux:<name>". Loop params apply to the Input. Nest inside Repeat via parent. Members set parent to this id. Reserved Input aux: element, index, count, t, random.',
    facts: {
      space: { "in:geometry": ["canvas01"], "aux:element": "in:geometry", out: "in:geometry" },
      gotchas: [
        "Element domain follows the wire: a spline input iterates subpaths, a points input iterates single points.",
        "Collected outputs are regrouped in element order; per-element attributes survive, cross-element ones do not.",
        "Body nodes must set parent to the Output id or they see the whole geometry instead of one element.",
      ],
    },
  },
];

function compoundZoneToCatalog(
  defs: NodeDefinition[],
  spec: (typeof COMPOUND_ZONE_CATALOG)[number],
  opts: CatalogOptions
): CatalogNode | null {
  const input = defs.find((d) => d.type === spec.inputType);
  if (!input) return null;
  const node: CatalogNode = {
    type: spec.type,
    name: spec.name,
    category: "utility",
    dynamic: true,
    inputs: spec.inputs,
    primaryOutput: null,
    aux: [],
    params: opts.omitParams ? [] : input.params.filter((p) => !p.hidden).map(paramToCatalog),
  };
  if (!opts.omitDescriptions) {
    node.description = spec.description;
    node.facts = spec.facts;
  }
  return node;
}

export function buildNodeCatalog(
  defs: NodeDefinition[],
  opts: CatalogOptions = {}
): CatalogNode[] {
  const visible = defs
    .filter((d) => !d.hidden) // skip back-compat aliases + structural internals
    .map((d) => defToCatalog(d, opts));
  for (const spec of COMPOUND_ZONE_CATALOG) {
    const extra = compoundZoneToCatalog(defs, spec, opts);
    if (extra) visible.push(extra);
  }
  return visible.sort((a, b) => a.type.localeCompare(b.type));
}

// Compact one-line-per-node DSL — the cached prompt format (~3.4× denser than
// JSON; see spec §4). One line: `type (Name) [cat/sub] ~dyn: in a:scalar!,b:scalar
// -> primary aux=x:image | param:type=default(min..max)[opts]`. `~dyn` flags
// polymorphic nodes; `!` marks required inputs; unsettable params still list
// as `name:type~(not remotely settable)` so the model can see they exist.
// Under each node: `# <description>` then the NodeFacts slots in fixed order
// (`# space:` `# reads:` `# writes:` `# flags:` `# ! gotcha`) — see formatFactsLines.
export function formatCatalogDsl(
  nodes: CatalogNode[],
  opts?: { preamble?: boolean }
): string {
  const body = nodes
    .map((n) => {
      const ins = n.inputs.map((i) => `${i.name}:${i.type}${i.required ? "!" : ""}`).join(",");
      const aux = n.aux.length ? ` aux=${n.aux.map((a) => `${a.name}:${a.type}`).join(",")}` : "";
      const ps = n.params
        .map((p) => {
          if (!p.settable) return `${p.name}:${p.type}~(not remotely settable)`;
          let s = `${p.name}:${p.type}`;
          if (p.default !== undefined) s += `=${JSON.stringify(p.default)}`;
          if (p.options) {
            const labeled = p.optionLabels
              ? p.options
                  .map((o) =>
                    p.optionLabels![o] ? `${o}=${p.optionLabels![o]}` : o
                  )
                  .join("|")
              : p.options.join("|");
            s += `[${labeled}]`;
          } else if (p.min !== undefined || p.max !== undefined) s += `(${p.min ?? ""}..${p.max ?? ""})`;
          return s;
        })
        .join(" ");
      const sub = n.subcategory ? `/${n.subcategory}` : "";
      const dyn = n.dynamic ? " ~dyn" : "";
      const desc = n.description ? `\n    # ${n.description}` : "";
      const facts = formatFactsLines(n.facts, n.flags)
        .map((l) => `\n    # ${l}`)
        .join("");
      return `${n.type} (${n.name}) [${n.category}${sub}]${dyn}: in ${ins} -> ${n.primaryOutput ?? "none"}${aux}${ps ? ` | ${ps}` : ""}${desc}${facts}`;
    })
    .join("\n");
  if (opts?.preamble === false) return body;
  const header = `# ${ASPECT_SPACE_DOC}\n# ${Y_ORIENT_DOC}\n# ${SPACE_TABLE_DOC}\n# ${UNSETTABLE_PARAM_DOC}\n# ${FLAGS_DOC}`;
  return `${header}\n${body}`;
}

export type CatalogMode = "list" | "full";

export interface CatalogQuery {
  mode?: CatalogMode;
  category?: string | string[];
  types?: string | string[];
}

function normalizeList(v: string | string[] | undefined | null): string[] {
  if (v == null || v === "") return [];
  const parts = Array.isArray(v) ? v : String(v).split(",");
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of parts) {
    const s = String(raw).trim();
    if (!s) continue;
    const key = s.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}

// Compact index: type, display name, category. No sockets, params, or
// descriptions — cheap enough to return inline instead of spilling.
export function formatCatalogIndex(nodes: CatalogNode[]): string {
  const counts = new Map<string, number>();
  for (const n of nodes) counts.set(n.category, (counts.get(n.category) ?? 0) + 1);
  const catSummary = [...counts.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([c, n]) => `${c} ${n}`)
    .join(", ");
  const lines = [
    `# ${nodes.length} types (${catSummary}).`,
    `# ${ASPECT_SPACE_DOC}`,
    `# ${Y_ORIENT_DOC}`,
    `# Sockets + params: get_catalog category="<name>" or types=["type"]. mode="full" for everything.`,
  ];
  for (const n of nodes) {
    const sub = n.subcategory ? `/${n.subcategory}` : "";
    lines.push(`${n.type} (${n.name}) [${n.category}${sub}]`);
  }
  return lines.join("\n");
}

export function queryCatalog(
  nodes: CatalogNode[],
  query: CatalogQuery = {}
): string {
  const catFilters = normalizeList(query.category).map((c) => c.toLowerCase());
  const typeFilters = normalizeList(query.types);
  const knownCats = [...new Set(nodes.map((n) => n.category))].sort();

  if (catFilters.length) {
    const bad = catFilters.filter((c) => !knownCats.includes(c));
    if (bad.length) {
      throw new Error(
        `Unknown categor${bad.length === 1 ? "y" : "ies"} "${bad.join('", "')}". Valid: ${knownCats.join(", ")}.`
      );
    }
  }

  let filtered = nodes;
  if (catFilters.length) {
    filtered = filtered.filter((n) => catFilters.includes(n.category));
  }

  const missing: string[] = [];
  if (typeFilters.length) {
    const byType = new Map(filtered.map((n) => [n.type.toLowerCase(), n]));
    const matched: CatalogNode[] = [];
    for (const t of typeFilters) {
      const hit = byType.get(t.toLowerCase());
      if (hit) matched.push(hit);
      else missing.push(t);
    }
    filtered = matched;
  }

  const mode: CatalogMode =
    query.mode === "list"
      ? "list"
      : query.mode === "full" || typeFilters.length > 0 || catFilters.length > 0
        ? "full"
        : "list";

  if (filtered.length === 0) {
    if (missing.length) {
      return `# unknown types: ${missing.join(", ")}\n# No catalog entries matched.`;
    }
    throw new Error("No catalog entries matched.");
  }

  const body =
    mode === "list"
      ? formatCatalogIndex(filtered)
      : formatCatalogDsl(filtered, {
          // types= is a follow-up after the index — don't re-dump the space
          // table / flags preamble on every node fetch.
          preamble: typeFilters.length === 0,
        });
  return missing.length ? `# unknown types: ${missing.join(", ")}\n${body}` : body;
}
