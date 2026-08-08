import type {
  CsvFileParamValue,
  NodeDefinition,
  OutputSocketDef,
  SocketValue,
} from "@/engine/types";
import { parseCsv, type CsvDelimiter } from "@/engine/csv-parse";

// CSV node — data-driven values (milestone 1 of specdocs/archive/062926_csv-node.md).
//
// Loads/pastes a CSV (stored inline in the project, like the LUT node) and
// fans out ONE output socket per column, each emitting the cell at the current
// `row`. A column whose cells are all numeric outputs `scalar`; otherwise it
// outputs `string` (which the new string socket carries straight into a Text
// node's exposed `text`). The `row` index is a normal scalar param, so it's
// exposable/keyframable — drive it with scene-time, an LFO, floor(time), etc.
//
// Self-contained by design (see spec): the node parses internally and emits
// only existing socket types — no `table` socket. The viz `points` output +
// spreadsheet preview are milestone 2.

function parseOptions(params: Record<string, unknown>) {
  return {
    hasHeader: params.hasHeader !== false,
    delimiter: (params.delimiter as CsvDelimiter) ?? "auto",
  };
}

// Positional, stable socket id (`col:<index>`) with the header as its display
// label — so editing a header renames the label without dropping wires, and
// the id stays parse-independent.
function columnOutputs(params: Record<string, unknown>): OutputSocketDef[] {
  const parsed = parseCsv(params.csv as CsvFileParamValue | null, parseOptions(params));
  return parsed.columns.map((col, i) => ({
    name: `col:${i}`,
    label: col.header,
    type: col.type === "number" ? "scalar" : "string",
    description:
      col.type === "number"
        ? `Column "${col.header}" — numeric, emits a scalar`
        : `Column "${col.header}" — text, emits a string`,
  }));
}

export const csvNode: NodeDefinition = {
  type: "csv",
  name: "CSV",
  category: "utility",
  description:
    "Loads a CSV and exposes each column as an output socket carrying the " +
    "cell at the selected row. Numeric columns emit scalars, text columns " +
    "emit strings (wire straight into a Text node's exposed text). Drive the " +
    "row to step through the data.",
  backend: "webgl2",
  stable: true,
  // Pure CPU data node — the universal mask input is meaningless.
  noMaskInput: true,
  inputs: [],
  params: [
    {
      name: "csv",
      label: "CSV",
      type: "csv_file",
      default: null,
    },
    {
      name: "hasHeader",
      label: "Header row",
      type: "boolean",
      default: true,
    },
    {
      name: "delimiter",
      label: "Delimiter",
      type: "enum",
      options: ["auto", "comma", "tab", "semicolon"],
      default: "auto",
    },
    {
      name: "row",
      label: "Row",
      type: "scalar",
      min: 0,
      max: 100000,
      softMax: 50,
      step: 1,
      default: 0,
    },
    {
      name: "rowMode",
      label: "Past ends",
      type: "enum",
      options: ["clamp", "wrap"],
      default: "clamp",
    },
  ],
  // No primary in M1 — every column is an aux socket. The viz `points` primary
  // lands in milestone 2.
  primaryOutput: null,
  auxOutputs: [],
  resolveAuxOutputs(params) {
    return columnOutputs(params);
  },

  compute({ params }) {
    const parsed = parseCsv(params.csv as CsvFileParamValue | null, parseOptions(params));
    const rc = parsed.rowCount;
    if (rc <= 0) return { aux: {} };

    const rowMode = (params.rowMode as string) ?? "clamp";
    let row = Math.floor((params.row as number) ?? 0);
    if (rowMode === "wrap") row = ((row % rc) + rc) % rc;
    else row = Math.max(0, Math.min(rc - 1, row));

    const aux: Record<string, SocketValue> = {};
    parsed.columns.forEach((col, i) => {
      const name = `col:${i}`;
      if (col.type === "number") {
        aux[name] = { kind: "scalar", value: col.numbers?.[row] ?? 0 };
      } else {
        aux[name] = { kind: "string", value: col.cells[row] ?? "" };
      }
    });
    return { aux };
  },
};
