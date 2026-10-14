// Node entry for the Aurora fixture: reads aurora.sksl from disk and builds
// the graph (aurora-graph.ts). See aurora-graph.ts for what it animates.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { auroraGraph as build } from "./aurora-graph.ts";

export { AURORA_TIMELINE, AURORA_FRAMES } from "./aurora-graph.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const AURORA_SKSL = fs.readFileSync(path.join(HERE, "aurora.sksl"), "utf8");

export function auroraGraph() {
  return build(AURORA_SKSL);
}
