import type { Edge, Node } from "@xyflow/react";
import { computeNeededSet, type GraphEdge, type GraphNode } from "@/engine/evaluator";
import { flattenGraph } from "@/engine/flatten";
import { getNodeDef } from "@/engine/registry";
import type { ParamDef, ParamType } from "@/engine/types";
import { parseRampParamKey } from "@/engine/conventions";
import type { ColorRampStop } from "@/engine/color-ramp";
import type { NodeDataPayload } from "@/state/graph";
import type {
  ExportManifest,
  ExportManifestControl,
  ExportManifestFileInput,
  FileParamType,
} from "@/lib/live-viewer/manifest-types";

// Re-export the shared types so existing call sites keep working.
export type {
  ExportManifest,
  ExportManifestControl,
  ExportManifestFileInput,
  FileParamType,
} from "@/lib/live-viewer/manifest-types";

const FILE_PARAM_TYPES = new Set<ParamType>([
  "file",
  "video_file",
  "audio_file",
  "svg_file",
  "font",
]);

// The only param types with no inline editor in the shared ParamControl —
// both are edited on-canvas (paint = brush, spline_anchors = pen tool), so
// there's no knob to render. Everything else (merge layers, curves, color
// ramps, gradients, autolayout) now renders via the shared param-controls UI
// in the live viewer and exported apps, so it flows through as a control.
const UNSUPPORTED_CONTROL_TYPES = new Set<ParamType>([
  "paint",
  "spline_anchors",
]);

export interface ExportWarning {
  kind:
    | "control-on-unsupported-type"
    | "control-on-missing-param"
    | "no-controls"
    | "duplicate-control";
  nodeId?: string;
  paramName?: string;
  message: string;
}

export interface BuildManifestInput {
  nodes: Node<NodeDataPayload>[];
  edges: Edge[];
  appName: string;
  description?: string;
  outputNodeId: string;
  canvasRes: [number, number];
}

export interface ExportManifestResult {
  manifest: ExportManifest;
  warnings: ExportWarning[];
}

export function buildExportManifest(
  input: BuildManifestInput
): ExportManifestResult {
  const { nodes, edges, appName, description, outputNodeId, canvasRes } = input;

  const graphNodes: GraphNode[] = nodes.map((n) => ({
    id: n.id,
    type: n.data.defType,
    parentId: n.data.parentId,
    params: n.data.params,
    exposedParams: n.data.exposedParams,
    clips: n.data.clips,
    bypassed: n.data.bypassed,
  }));
  const graphEdges: GraphEdge[] = edges.map((e) => ({
    id: e.id,
    source: e.source,
    sourceHandle: e.sourceHandle ?? "",
    target: e.target,
    targetHandle: e.targetHandle ?? "",
  }));

  // Reachability must be computed on the flattened graph — group
  // shells don't carry data edges, so interior nodes of a group are
  // only reachable once boundaries are spliced through.
  const flat = flattenGraph(graphNodes, graphEdges);
  const needed = computeNeededSet(flat.nodes, flat.edges, outputNodeId);

  const fileInputs: ExportManifestFileInput[] = [];
  const controls: ExportManifestControl[] = [];
  const warnings: ExportWarning[] = [];

  // Track def-name occurrences across reachable controlled nodes so we can
  // suffix duplicates with " (n)" starting at 2 in graph order.
  const controlNodeNameCounts = new Map<string, number>();
  const fileNodeNameCounts = new Map<string, number>();
  const seenControlKeys = new Set<string>();

  for (const node of nodes) {
    if (!needed.has(node.id)) continue;
    const def = getNodeDef(node.data.defType);
    if (!def) continue;

    for (const param of def.params) {
      if (FILE_PARAM_TYPES.has(param.type)) {
        const baseName = def.name;
        const count = (fileNodeNameCounts.get(baseName) ?? 0) + 1;
        fileNodeNameCounts.set(baseName, count);
        const nodeName = count === 1 ? baseName : `${baseName} (${count})`;
        fileInputs.push({
          nodeId: node.id,
          nodeName,
          paramName: param.name,
          paramType: param.type as FileParamType,
          label: param.label ?? param.name,
        });
      }
    }

    const controlParams = node.data.controlParams ?? [];
    if (controlParams.length === 0) continue;

    let nodeNameAssigned: string | null = null;
    const ensureNodeName = (): string => {
      if (nodeNameAssigned !== null) return nodeNameAssigned;
      const baseName = def.name;
      const count = (controlNodeNameCounts.get(baseName) ?? 0) + 1;
      controlNodeNameCounts.set(baseName, count);
      nodeNameAssigned = count === 1 ? baseName : `${baseName} (${count})`;
      return nodeNameAssigned;
    };

    for (const paramName of controlParams) {
      // Per-stop ramp controls (`ramp_c/a/p:<param>:<stopId>` — see
      // engine/conventions) synthesize a color / 0..1-scalar ParamDef
      // with the stop's current value as the default. The live viewer
      // recognizes the virtual paramName and patches the stop in place.
      const rampKey = parseRampParamKey(paramName);
      if (rampKey) {
        const rampDef = def.params.find(
          (p) => p.name === rampKey.paramName && p.type === "color_ramp"
        );
        const stopsRaw = node.data.params[rampKey.paramName];
        const stops = Array.isArray(stopsRaw)
          ? (stopsRaw as ColorRampStop[])
          : [];
        const stop = stops.find((s) => s.id === rampKey.stopId);
        if (!rampDef || !stop) {
          warnings.push({
            kind: "control-on-missing-param",
            nodeId: node.id,
            paramName,
            message: `Node "${def.name}" has a control toggle on "${paramName}" but that ramp stop no longer exists.`,
          });
          continue;
        }
        const dupKey = `${node.id}::${paramName}`;
        if (seenControlKeys.has(dupKey)) {
          warnings.push({
            kind: "duplicate-control",
            nodeId: node.id,
            paramName,
            message: `Ramp stop control "${paramName}" on "${def.name}" is marked as a control more than once.`,
          });
          continue;
        }
        seenControlKeys.add(dupKey);
        const idx = [...stops]
          .sort((a, b) => a.position - b.position)
          .findIndex((s) => s.id === rampKey.stopId);
        const label = `${rampDef.label ?? rampDef.name} · ${rampKey.field}${
          idx >= 0 ? ` ${idx + 1}` : ""
        }`;
        const synth: ParamDef =
          rampKey.field === "color"
            ? {
                name: paramName,
                label,
                type: "color",
                default:
                  typeof stop.color === "string" ? stop.color : "#ffffff",
              }
            : {
                name: paramName,
                label,
                type: "scalar",
                min: 0,
                max: 1,
                step: rampKey.field === "alpha" ? 0.01 : 0.001,
                default:
                  rampKey.field === "alpha" ? stop.alpha ?? 1 : stop.position,
              };
        controls.push({
          nodeId: node.id,
          nodeName: ensureNodeName(),
          paramName,
          paramType: synth.type,
          label,
          def: synth,
        });
        continue;
      }
      const paramDef = def.params.find((p) => p.name === paramName);
      if (!paramDef) {
        warnings.push({
          kind: "control-on-missing-param",
          nodeId: node.id,
          paramName,
          message: `Node "${def.name}" has a control toggle on "${paramName}" but the node no longer defines that parameter.`,
        });
        continue;
      }
      if (UNSUPPORTED_CONTROL_TYPES.has(paramDef.type)) {
        warnings.push({
          kind: "control-on-unsupported-type",
          nodeId: node.id,
          paramName,
          message: `Param "${paramDef.label ?? paramDef.name}" on "${def.name}" is type "${paramDef.type}", which can't be rendered in the export panel.`,
        });
        continue;
      }
      const dupKey = `${node.id}::${paramName}`;
      if (seenControlKeys.has(dupKey)) {
        warnings.push({
          kind: "duplicate-control",
          nodeId: node.id,
          paramName,
          message: `Param "${paramDef.label ?? paramDef.name}" on "${def.name}" is marked as a control more than once.`,
        });
        continue;
      }
      seenControlKeys.add(dupKey);

      // Strip visibleIf before deep-cloning — predicates aren't JSON-serializable.
      const { visibleIf: _omit, ...rest } = paramDef;
      void _omit;
      const cloned = JSON.parse(JSON.stringify(rest)) as ParamDef;

      controls.push({
        nodeId: node.id,
        nodeName: ensureNodeName(),
        paramName: paramDef.name,
        paramType: paramDef.type,
        label: paramDef.label ?? paramDef.name,
        def: cloned,
      });
    }
  }

  if (controls.length === 0) {
    warnings.push({
      kind: "no-controls",
      message:
        "No controls selected. Mark params with the 'control' toggle to expose them in the exported app.",
    });
  }

  const manifest: ExportManifest = {
    appName,
    description,
    outputNodeId,
    canvasRes,
    fileInputs,
    controls,
    generatedAt: new Date().toISOString(),
    schemaVersion: 1,
  };

  return { manifest, warnings };
}
