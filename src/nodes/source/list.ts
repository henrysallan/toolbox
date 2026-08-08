import type { NodeDefinition, OutputSocketDef, SocketValue } from "@/engine/types";
import { listParseOptions, parseList, type ParsedList } from "@/engine/list-parse";
import { parseNumericCell } from "@/engine/csv-parse";
import { resolveListIndex } from "@/engine/list-value";

// List node — the CSV node's "paste data, get values" idea generalized to any
// list format, but emitting a real `list` wire so the collection itself can be
// transformed downstream (sort / slice / filter / join are nodes, not params).
// Spec: specdocs/archive/080526_list-socket.md.
//
// The source is a plain multiline `string` param, NOT a file param: that keeps
// it exposable, so a String node or a CSV cell can DRIVE the list at runtime
// (`paramSocketType("string") === "string"`). The `file_text` control hint adds
// the Load button on top without giving up the wire.
//
// Two faces, like CSV: the `list` primary for the transform chain, and the
// `item`/`count` aux pair for the data-driven user who just wants the value at
// an animated index. Items type as scalar/string by whole-list inference (with
// a manual override — see resolvedItemType), which is the only bridge from
// pasted text to a scalar socket.
//
// Stable — everything comes from params.

// The `item` socket's type. `auto` follows the data (all items numeric ⇒
// scalar), which is what the CSV node does per column — but auto can only read
// the STORED text, and this node's `text` param is exposable. When a wire
// drives it, resolveAuxOutputs still sees the stale stored value, so an
// incoming numeric list would advertise a `string` socket and the editor would
// refuse to drop `item` on a scalar input. The explicit override closes that
// (the Switch node's `type` param solves the same problem the same way), and
// doubles as the escape hatch when inference reads the data differently than
// intended — forcing `text` keeps "007" as "007" instead of the number 7.
function resolvedItemType(
  params: Record<string, unknown>,
  parsed: ParsedList
): "scalar" | "string" {
  const forced = params.itemType as string | undefined;
  if (forced === "number") return "scalar";
  if (forced === "text") return "string";
  return parsed.allNumeric ? "scalar" : "string";
}

// The list's items at the resolved type. `auto` hands back what the parser
// already typed; a force re-types from the RAW cells, so the whole list agrees
// with the `item` socket and a downstream sort sees the type the user asked
// for — not just the one item that happens to be indexed.
function typedItems(
  parsed: ParsedList,
  itemType: "scalar" | "string"
): SocketValue[] {
  if (itemType === "scalar") {
    if (parsed.allNumeric) return parsed.items;
    return parsed.cells.map((c) => ({
      kind: "scalar" as const,
      value: parseNumericCell(c) ?? 0,
    }));
  }
  if (!parsed.allNumeric) return parsed.items;
  return parsed.cells.map((c) => ({ kind: "string" as const, value: c }));
}

function itemOutput(params: Record<string, unknown>): OutputSocketDef {
  const parsed = parseList(params.text as string, listParseOptions(params));
  const type = resolvedItemType(params, parsed);
  return {
    name: "item",
    label: "Item",
    type,
    description:
      type === "scalar"
        ? "The item at Index, as a number"
        : "The item at Index, as text (wire into a Text node's text)",
  };
}

export const listNode: NodeDefinition = {
  type: "list",
  name: "List",
  category: "utility",
  description:
    "Parses pasted or loaded text into a list — newlines, commas, tabs, " +
    "pipes, semicolons, JSON arrays, bulleted/numbered lists, or range " +
    "shorthand (1..10, a..e, 0..20 step 2). Outputs the whole list for the " +
    "list transform nodes, plus the item at an animatable index (a scalar " +
    "for numeric lists, a string otherwise) and the item count.",
  backend: "webgl2",
  stable: true,
  // Pure CPU data node — the universal mask input is meaningless.
  noMaskInput: true,
  inputs: [],
  params: [
    {
      name: "text",
      label: "Items",
      type: "string",
      multiline: true,
      control: "file_text",
      default: "",
      placeholder: "paste a list — one per line, comma-separated, [1,2,3], 1..10…",
    },
    {
      name: "format",
      label: "Format",
      type: "enum",
      options: [
        "auto",
        "lines",
        "comma",
        "semicolon",
        "tab",
        "pipe",
        "whitespace",
        "json",
        "range",
      ],
      default: "auto",
    },
    {
      name: "trim",
      label: "Trim items",
      type: "boolean",
      default: true,
    },
    {
      name: "dropEmpty",
      label: "Drop empties",
      type: "boolean",
      default: true,
    },
    {
      name: "dedupe",
      label: "Remove duplicates",
      type: "boolean",
      default: false,
    },
    {
      name: "itemType",
      label: "Item type",
      type: "enum",
      options: ["auto", "text", "number"],
      default: "auto",
    },
    {
      name: "index",
      label: "Index",
      type: "scalar",
      min: 0,
      max: 100000,
      softMax: 50,
      step: 1,
      default: 0,
    },
    {
      name: "indexMode",
      label: "Past ends",
      type: "enum",
      options: ["clamp", "wrap"],
      default: "clamp",
    },
  ],
  primaryOutput: "list",
  auxOutputs: [
    // Placeholder shape only — resolveAuxOutputs below retypes `item` from the
    // parsed data. Declared so the socket exists before anything is pasted.
    { name: "item", label: "Item", type: "string" },
    { name: "count", label: "Count", type: "scalar" },
  ],
  resolveAuxOutputs(params) {
    return [
      itemOutput(params),
      {
        name: "count",
        label: "Count",
        type: "scalar",
        description: "How many items the list has",
      },
    ];
  },

  compute({ params }) {
    const parsed = parseList(params.text as string, listParseOptions(params));
    const itemType = resolvedItemType(params, parsed);
    const items = typedItems(parsed, itemType);

    const aux: Record<string, SocketValue> = {
      count: { kind: "scalar", value: items.length },
    };

    const i = resolveListIndex(
      (params.index as number) ?? 0,
      items.length,
      (params.indexMode as "clamp" | "wrap") ?? "clamp"
    );
    // Empty list: emit the socket's resting empty value rather than omitting
    // it, so a downstream Text node reads "" instead of falling back to its
    // own stored param (which would look like the wire had come loose). Either
    // way `item`'s kind matches the type resolveAuxOutputs advertised.
    aux.item =
      i < 0
        ? itemType === "scalar"
          ? { kind: "scalar", value: 0 }
          : { kind: "string", value: "" }
        : items[i];

    return { primary: { kind: "list", items }, aux };
  },
};
