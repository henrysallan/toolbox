import type { Edge, Node } from "@xyflow/react";
import { computeNeededSet, type GraphEdge, type GraphNode } from "@/engine/evaluator";
import { flattenGraph, resolvePreviewProducer } from "@/engine/flatten";
import { getNodeDef } from "@/engine/registry";
import type { ParamDef, ParamType } from "@/engine/types";
import {
  expandMergeLayerControls,
  mergeLayerModeKey,
  mergeLayerOpacityKey,
  parseMergeLayerKey,
  parseRampParamKey,
} from "@/engine/conventions";
import type { ColorRampStop } from "@/engine/color-ramp";
import {
  BLEND_MODE_ORDER,
  blendModeLabel,
  type MergeLayer,
} from "@/nodes/effect/merge";
import type { NodeDataPayload } from "@/state/graph";
import { liveGizmoKind, liveGizmoWiringBlocker } from "@/lib/live-gizmo";
import type {
  ExportManifest,
  ExportManifestControl,
  ExportManifestFileInput,
  ExportManifestGizmo,
  FileParamType,
} from "@/lib/live-viewer/manifest-types";

// Re-export the shared types so existing call sites keep working.
export type {
  ExportManifest,
  ExportManifestControl,
  ExportManifestFileInput,
  ExportManifestGizmo,
  FileParamType,
} from "@/lib/live-viewer/manifest-types";

// Param types the manifest ships as File Inputs (a picker) rather than
// knobs, and only when Control-toggled. Exported so the param panel can
// word the toggle's tooltip for them.
export function isFileParamType(type: ParamType): boolean {
  return FILE_PARAM_TYPES.has(type);
}

const FILE_PARAM_TYPES = new Set<ParamType>([
  "file",
  "video_file",
  "audio_file",
  "svg_file",
  "font",
  // v11 cloud refs made 3D models loadable in live/export contexts, so a
  // model param is now a meaningful viewer-supplied (or cloud-prefilled)
  // input rather than a dead end.
  "model_file",
]);

// The only param types with no inline editor in the shared ParamControl —
// both are edited on-canvas (paint = brush, spline_anchors = pen tool), so
// there's no knob to render. Everything else (merge layers, curves, color
// ramps, gradients, autolayout) now renders via the shared param-controls UI
// in the live viewer and exported apps, so it flows through as a control.
const UNSUPPORTED_CONTROL_TYPES = new Set<ParamType>([
  "paint",
  "spline_anchors",
  "brush_settings",
  "track_data",
  // Switch per-input names: authoring config that already reaches the
  // viewer as the Index control's option labels — not a knob of its own.
  "slot_labels",
]);

export interface ExportWarning {
  kind:
    | "control-on-unsupported-type"
    | "control-on-missing-param"
    | "no-controls"
    | "duplicate-control"
    // The node ships its on-canvas handles, but a wire makes them lie
    // (091726_live-gizmos.md) — left out, same rule the editor applies.
    | "gizmo-hidden-by-wiring";
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

  // The live link / export renders whatever terminal is viewport-active,
  // and that can be a STRUCTURAL node — a Layer's Group Output (previewing
  // inside a layer), a group shell, a reroute. Flatten dissolves those, so
  // seeding the reachability walk with their id finds nothing: the manifest
  // came back with zero controls while the canvas rendered fine (the
  // evaluator remaps the same way before ITS flatten). Mirror that remap
  // here so the panel always matches what's on screen. `manifest.
  // outputNodeId` keeps the ORIGINAL id — the viewer hands it to
  // evaluateGraph, which does its own remap.
  const remapped = resolvePreviewProducer(graphNodes, graphEdges, outputNodeId);
  const reachFrom = remapped ? remapped.nodeId : outputNodeId;

  // Reachability must be computed on the flattened graph — group
  // shells don't carry data edges, so interior nodes of a group are
  // only reachable once boundaries are spliced through.
  const flat = flattenGraph(graphNodes, graphEdges);
  const needed = computeNeededSet(flat.nodes, flat.edges, reachFrom);

  const fileInputs: ExportManifestFileInput[] = [];
  const controls: ExportManifestControl[] = [];
  const gizmos: ExportManifestGizmo[] = [];
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

    // Pre-per-layer-toggle saves control the whole `merge_layers` param by
    // its literal name; expand that to one `mlayer:` entry per layer so the
    // live panel shows the same per-layer rows either way.
    const controlParams = expandMergeLayerControls(
      def.params,
      node.data.params,
      node.data.controlParams ?? []
    );
    const controlSet = new Set(controlParams);

    // File params (image / video / audio / SVG / font / model) ship as
    // File Inputs — a picker the visitor loads their own asset into — ONLY
    // when the author marks them with the same per-param Control toggle
    // every knob uses. Unmarked file params stay bundled: the viewer
    // renders the asset saved with the project and shows no picker for
    // it. Until 2026-09-21 every reachable file param was listed
    // unconditionally, so an image source meant as a fixed part of the
    // effect surfaced as a "replace this image" input on every live link.
    for (const param of def.params) {
      if (!FILE_PARAM_TYPES.has(param.type)) continue;
      if (!controlSet.has(param.name)) continue;
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

    let nodeNameAssigned: string | null = null;
    const ensureNodeName = (): string => {
      if (nodeNameAssigned !== null) return nodeNameAssigned;
      const baseName = def.name;
      const count = (controlNodeNameCounts.get(baseName) ?? 0) + 1;
      controlNodeNameCounts.set(baseName, count);
      nodeNameAssigned = count === 1 ? baseName : `${baseName} (${count})`;
      return nodeNameAssigned;
    };

    // On-canvas GUI (091726_live-gizmos.md): the node-level Control toggle
    // ships the node's handles as one visibility row + overlay. Eligibility
    // and the wired-away rules are the editor's own (lib/live-gizmo.ts), so
    // the live link never shows handles the editor would hide. Named
    // through the same counter as the node's param controls so
    // "Transform (2) — Handles" and "Transform (2) — Rotate" agree.
    if (node.data.controlGizmo) {
      const kind = liveGizmoKind(node.data.defType);
      if (kind) {
        const blocker = liveGizmoWiringBlocker(
          node.id,
          node.data.defType,
          kind,
          edges
        );
        if (blocker) {
          warnings.push({
            kind: "gizmo-hidden-by-wiring",
            nodeId: node.id,
            message: `Node "${def.name}" ships its on-canvas handles, but ${blocker}, so they are left out.`,
          });
        } else {
          gizmos.push({
            nodeId: node.id,
            nodeName: ensureNodeName(),
            defType: node.data.defType,
            kind,
          });
        }
      }
    }

    if (controlParams.length === 0) continue;

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
      // Per-layer Merge controls (`mlayer:<param>:<layerId>` — see
      // engine/conventions). One toggled layer becomes TWO knobs — its
      // blend mode (enum over the shared blend list) and its opacity
      // (0..1 scalar) — each under a virtual paramName the live viewer
      // parses back to patch the layer inside the array param.
      const layerKey = parseMergeLayerKey(paramName);
      if (layerKey) {
        if (layerKey.field !== "layer") {
          // Only the membership key belongs in controlParams; a stray
          // synthesized name would double-render the knob.
          warnings.push({
            kind: "control-on-missing-param",
            nodeId: node.id,
            paramName,
            message: `Node "${def.name}" has a control toggle on "${paramName}", which isn't a layer toggle key.`,
          });
          continue;
        }
        const layersDef = def.params.find(
          (p) => p.name === layerKey.paramName && p.type === "merge_layers"
        );
        const layersRaw = node.data.params[layerKey.paramName];
        const layers = Array.isArray(layersRaw)
          ? (layersRaw as MergeLayer[])
          : [];
        const idx = layers.findIndex((l) => l.id === layerKey.layerId);
        const layer = idx >= 0 ? layers[idx] : undefined;
        if (!layersDef || !layer) {
          warnings.push({
            kind: "control-on-missing-param",
            nodeId: node.id,
            paramName,
            message: `Node "${def.name}" has a control toggle on "${paramName}" but that layer no longer exists.`,
          });
          continue;
        }
        const dupKey = `${node.id}::${paramName}`;
        if (seenControlKeys.has(dupKey)) {
          warnings.push({
            kind: "duplicate-control",
            nodeId: node.id,
            paramName,
            message: `Layer control "${paramName}" on "${def.name}" is marked as a control more than once.`,
          });
          continue;
        }
        seenControlKeys.add(dupKey);
        // A renamed layer's knobs carry its name; unnamed keep "Layer N".
        const layerLabel = layer.name?.trim() || `Layer ${idx + 1}`;
        const modeName = mergeLayerModeKey(layerKey.paramName, layer.id);
        const modeLabel = `${layerLabel} · blend`;
        const modeDef: ParamDef = {
          name: modeName,
          label: modeLabel,
          type: "enum",
          options: [...BLEND_MODE_ORDER],
          optionLabels: Object.fromEntries(
            BLEND_MODE_ORDER.map((m) => [m, blendModeLabel(m)])
          ),
          default: layer.mode,
        };
        controls.push({
          nodeId: node.id,
          nodeName: ensureNodeName(),
          paramName: modeName,
          paramType: "enum",
          label: modeLabel,
          def: modeDef,
        });
        const opacityName = mergeLayerOpacityKey(layerKey.paramName, layer.id);
        const opacityLabel = `${layerLabel} · opacity`;
        const opacityDef: ParamDef = {
          name: opacityName,
          label: opacityLabel,
          type: "scalar",
          min: 0,
          max: 1,
          step: 0.01,
          default: layer.opacity,
        };
        controls.push({
          nodeId: node.id,
          nodeName: ensureNodeName(),
          paramName: opacityName,
          paramType: "scalar",
          label: opacityLabel,
          def: opacityDef,
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
      // A controlled file param already became a File Inputs row above —
      // it is a picker, not a knob, so it never doubles as a control.
      if (FILE_PARAM_TYPES.has(paramDef.type)) continue;
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

      // Param-driven scalar hints (maxFrom / controlFrom / optionLabelsFrom)
      // are functions, so the JSON clone above drops them — and the live
      // panel renders `control.def` with no sibling params to feed them
      // anyway. Evaluate them against the node's params NOW and bake the
      // results into the clone, so the viewer shows the widget and range
      // the editor showed when the project was saved: a Switch index in
      // toggle mode is a pill over its wired, named inputs, and in slider
      // mode spans the live slot list instead of the 0…255 static fallback.
      // Frozen per save by construction — the /live manifest rebuilds from
      // the saved graph, not from viewer edits.
      if (paramDef.type === "scalar") {
        const params = node.data.params;
        const dynMin = paramDef.minFrom?.(params);
        if (dynMin !== undefined) cloned.min = dynMin;
        const dynMax = paramDef.maxFrom?.(params);
        if (dynMax !== undefined) cloned.max = dynMax;
        const dynSoftMax = paramDef.softMaxFrom?.(params);
        if (dynSoftMax !== undefined) cloned.softMax = dynSoftMax;
        // stepFrom is documented as not surviving serialization, but a
        // units-dependent step (Text's 0.1 under %) is exactly the one
        // hint the live slider needs baked — same frozen-per-save contract.
        const dynStep = paramDef.stepFrom?.(params);
        if (dynStep !== undefined) cloned.step = dynStep;
        const dynControl = paramDef.controlFrom?.(params);
        if (dynControl !== undefined) cloned.control = dynControl;
        const dynLabels = paramDef.optionLabelsFrom?.(params);
        if (dynLabels !== undefined) cloned.optionLabels = dynLabels;
      }

      // Per-node slider range overrides (right-click a scalar slider →
      // "Slider range" min / max / soft max, stored as
      // `node.data.paramOverrides`). In the editor ParamControl reads them
      // through a `rangeOverride` prop; the live viewer's ControlPanel
      // renders the same ParamControl from `control.def` ALONE, so bake
      // them into the cloned def here or the live link / exported app
      // silently falls back to the node def's stock range. Scalar-only,
      // matching the one ParamControl branch that honors `rangeOverride`.
      const rangeOverride =
        paramDef.type === "scalar"
          ? node.data.paramOverrides?.[paramName]
          : undefined;
      if (rangeOverride) {
        if (rangeOverride.min !== undefined) cloned.min = rangeOverride.min;
        if (rangeOverride.max !== undefined) cloned.max = rangeOverride.max;
        if (rangeOverride.softMax !== undefined)
          cloned.softMax = rangeOverride.softMax;
      }

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

  // A link with only file pickers is still a link with something to touch.
  if (controls.length === 0 && gizmos.length === 0 && fileInputs.length === 0) {
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
    gizmos,
    generatedAt: new Date().toISOString(),
    schemaVersion: 1,
  };

  return { manifest, warnings };
}
