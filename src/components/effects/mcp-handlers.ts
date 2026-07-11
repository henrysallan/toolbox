// Command handlers for the Claude MCP bridge (spec 070926_claude-mcp-bridge.md,
// milestones 2–4). buildMcpHandlers() assembles the BridgeHandlers map from a
// deps object EffectsApp rebuilds each render — so every handler reads fresh
// state, while the socket connection itself never churns.
//
// Trust boundary: mutations flow through the exact machinery the in-app AI
// panel uses — buildRecipe / applyRecipeEdit / validateGraph / vetParamValue /
// onParamChange — and every mutation pushes an undo snapshot + flashes a
// toast, so agent actions are always visible and reversible.

import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import type { Edge } from "@xyflow/react";
import type { BridgeHandlers } from "@/lib/mcp-bridge";
import { getNodeDef } from "@/engine/registry";
import { GROUP_TYPE, LAYER_TYPE } from "@/engine/groups";
import { SETTABLE_PARAM_TYPES, vetParamValue } from "@/engine/node-catalog";
import { validateGraph, type ValEdge, type ValNode } from "@/engine/graph-validation";
import { buildRecipe, type RecipeGraph } from "@/state/recipe-builder";
import {
  applyRecipeEdit,
  graphToSpec,
  type RecipeEdit,
  type RecipeEditOp,
} from "@/state/recipe-edit";
import { expandWithDescendants, type GraphNode } from "@/state/graph-ops";
import {
  DEFAULT_TICKS_PER_FRAME,
  EASING_PRESET_ORDER,
  isKeyframable,
  isStepOnly,
  type EasingPreset,
  type Keyframe,
  type KeyframeAnimationBlock,
} from "@/engine/keyframes";
import { buildCatalogDsl, HARD_BUILD_CODES } from "@/lib/ai/generate-recipe-client";
import { HARD_OP_CODES } from "@/lib/ai/edit-recipe-client";
import { pointExpressionNode } from "@/nodes/effect/point-expression";

export interface McpStatus {
  projectName: string;
  canvasWidth: number;
  canvasHeight: number;
  fps: number;
  frame: number;
  playing: boolean;
  loopFrames: number;
  selectedNodeId: string | null;
  scope: string;
}

export interface McpHandlerDeps {
  status: McpStatus;
  nodesRef: MutableRefObject<GraphNode[]>;
  edgesRef: MutableRefObject<Edge[]>;
  canvasRef: MutableRefObject<HTMLCanvasElement | null>;
  timeRef: MutableRefObject<number>;
  fpsRef: MutableRefObject<number>;
  playingRef: MutableRefObject<boolean>;
  forcedTerminalRef: MutableRefObject<string | null>;
  renderFrame: (time: number, fps: number, playingHint: boolean) => void;
  setPlaying: (p: boolean) => void;
  setTime: (t: number) => void;
  onParamChange: (nodeId: string, param: string, value: unknown) => void;
  onAnimationChange: (
    nodeId: string,
    param: string,
    next: KeyframeAnimationBlock | undefined
  ) => void;
  pushGraph: (snapshot: { nodes: GraphNode[]; edges: Edge[] }) => void;
  getGraphSnapshot: () => { nodes: GraphNode[]; edges: Edge[] };
  setNodes: Dispatch<SetStateAction<GraphNode[]>>;
  setEdges: Dispatch<SetStateAction<Edge[]>>;
  commitRecipeFragment: (
    frag: { nodes: GraphNode[]; edges: Edge[] },
    warningCount: number
  ) => { groupId: string | null; wrapped: boolean };
  flashToast: (message: string) => void;
}

// Shared validate step (identical split to the generate/edit clients): hard
// build/op issues + validator errors block, everything else is a warning.
function validateFragment(
  nodes: GraphNode[],
  edges: Edge[],
  issues: { code: string; message: string }[],
  hardCodes: ReadonlySet<string>
): { errors: string[]; warnings: string[] } {
  const valNodes: ValNode[] = nodes.map((n) => ({
    id: n.id,
    defType: n.data.defType,
    params: n.data.params,
  }));
  const valEdges: ValEdge[] = edges.map((e) => ({
    id: e.id,
    source: e.source,
    sourceHandle: (e.sourceHandle ?? "") as string,
    target: e.target,
    targetHandle: (e.targetHandle ?? "") as string,
  }));
  const val = validateGraph(valNodes, valEdges);
  return {
    errors: [
      ...issues.filter((i) => hardCodes.has(i.code)).map((i) => i.message),
      ...val.issues.filter((i) => i.severity === "error").map((i) => i.message),
    ],
    warnings: [
      ...issues.filter((i) => !hardCodes.has(i.code)).map((i) => i.message),
      ...val.issues.filter((i) => i.severity === "warning").map((i) => i.message),
    ],
  };
}

function invalid(kind: string, errors: string[]): Error {
  return new Error(`${kind} not applied — fix these and retry:\n- ${errors.join("\n- ")}`);
}

async function canvasToBase64(canvas: HTMLCanvasElement): Promise<string> {
  const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/png"));
  if (!blob) throw new Error("Could not encode the screenshot.");
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result));
    fr.onerror = () => reject(new Error("Could not read the screenshot."));
    fr.readAsDataURL(blob);
  });
  return dataUrl.slice(dataUrl.indexOf(",") + 1);
}

const EASING_SET = new Set<string>(EASING_PRESET_ORDER);
const tickOf = (frame: number) => Math.round(frame * DEFAULT_TICKS_PER_FRAME);
const frameOf = (tick: number) => tick / DEFAULT_TICKS_PER_FRAME;

export function buildMcpHandlers(deps: McpHandlerDeps): BridgeHandlers {
  const nodeOrThrow = (nodeId: unknown): GraphNode => {
    const node = deps.nodesRef.current.find((n) => n.id === nodeId);
    if (!node)
      throw new Error(`No node with id "${nodeId}" — call get_graph for current ids.`);
    return node;
  };

  return {
    // ---- context -----------------------------------------------------------
    get_status: () => deps.status,

    get_catalog: () => buildCatalogDsl(),

    get_graph: ({ scope }) => {
      const nodes = deps.nodesRef.current;
      const edges = deps.edgesRef.current;
      const scopeId = !scope || scope === "root" ? undefined : String(scope);
      if (scopeId) {
        const shell = nodeOrThrow(scopeId);
        if (shell.data.defType !== GROUP_TYPE && shell.data.defType !== LAYER_TYPE)
          throw new Error(
            `"${scopeId}" is a ${shell.data.defType}, not a group/layer — get_graph scopes are group or layer ids (or "root").`
          );
      }
      return graphToSpec(nodes, edges, scopeId);
    },

    // ---- vision ------------------------------------------------------------
    screenshot: async ({ nodeId, frame, maxSize }) => {
      const canvas = deps.canvasRef.current;
      if (!canvas) throw new Error("Preview canvas unavailable.");
      const fps = deps.fpsRef.current;
      const seek = typeof frame === "number" && Number.isFinite(frame);
      const targetTime = seek ? Math.max(0, frame as number) / fps : deps.timeRef.current;
      if (nodeId != null) {
        nodeOrThrow(nodeId);
        deps.forcedTerminalRef.current = String(nodeId);
      }
      try {
        // Always render explicitly so the capture is deterministic (not
        // whatever half-frame the last rAF left behind).
        deps.renderFrame(targetTime, fps, false);
      } finally {
        deps.forcedTerminalRef.current = null;
      }
      const max = Math.min(2048, Math.max(64, Number(maxSize) || 1024));
      const scale = Math.min(1, max / Math.max(canvas.width, canvas.height));
      const w = Math.max(1, Math.round(canvas.width * scale));
      const h = Math.max(1, Math.round(canvas.height * scale));
      const tmp = document.createElement("canvas");
      tmp.width = w;
      tmp.height = h;
      tmp.getContext("2d")!.drawImage(canvas, 0, 0, w, h);
      const base64 = await canvasToBase64(tmp);
      // A paused editor should keep showing the user's playhead, not the
      // frame Claude peeked at.
      if ((seek || nodeId != null) && !deps.playingRef.current)
        deps.renderFrame(deps.timeRef.current, deps.fpsRef.current, false);
      return {
        kind: "image",
        mimeType: "image/png",
        base64,
        width: w,
        height: h,
        frame: Math.round(targetTime * fps),
      };
    },

    // Sample several frames and tile them into ONE labelled grid image, so
    // judging motion costs a single tool call (and one image's worth of
    // context) instead of N.
    screenshot_strip: async ({ frames, start, end, every, nodeId, maxSize }) => {
      const canvas = deps.canvasRef.current;
      if (!canvas) throw new Error("Preview canvas unavailable.");
      const fps = deps.fpsRef.current;

      let list: number[];
      if (Array.isArray(frames) && frames.length > 0) {
        list = frames.map((f) => Math.max(0, Math.round(Number(f))));
        if (list.some((f) => !Number.isFinite(f)))
          throw new Error("`frames` must be an array of frame numbers.");
      } else {
        const s = Math.max(0, Math.round(Number(start ?? 0)));
        const e = Math.round(Number(end ?? deps.status.loopFrames));
        if (!(e > s)) throw new Error(`Empty range: start ${s} → end ${e}.`);
        const step = Math.max(1, Math.round(Number(every ?? Math.ceil((e - s) / 6))));
        list = [];
        for (let f = s; f <= e && list.length < 12; f += step) list.push(f);
      }
      if (list.length < 2 || list.length > 12)
        throw new Error(
          `A strip wants 2–12 frames (got ${list.length}) — tune \`every\` or pass \`frames\` explicitly.`
        );

      if (nodeId != null) nodeOrThrow(nodeId);

      // Grid geometry: near-square, sized so the WHOLE strip fits the budget.
      const budget = Math.min(2048, Math.max(256, Number(maxSize) || 1400));
      const cols = list.length <= 3 ? list.length : Math.ceil(Math.sqrt(list.length));
      const rows = Math.ceil(list.length / cols);
      const aspect = canvas.width / canvas.height;
      let cellW = Math.floor(
        Math.min(budget / cols, (budget / rows) * aspect, canvas.width)
      );
      cellW = Math.max(64, cellW);
      const cellH = Math.max(64, Math.round(cellW / aspect));
      const grid = document.createElement("canvas");
      grid.width = cellW * cols;
      grid.height = cellH * rows;
      const g = grid.getContext("2d")!;
      const label = Math.max(10, Math.round(cellH / 18));

      try {
        for (let i = 0; i < list.length; i++) {
          if (nodeId != null) deps.forcedTerminalRef.current = String(nodeId);
          try {
            deps.renderFrame(list[i] / fps, fps, false);
          } finally {
            deps.forcedTerminalRef.current = null;
          }
          const x = (i % cols) * cellW;
          const y = Math.floor(i / cols) * cellH;
          g.drawImage(canvas, x, y, cellW, cellH);
          // Frame label so the strip is self-describing.
          const text = `f${list[i]}`;
          g.font = `${label}px ui-monospace, monospace`;
          const tw = g.measureText(text).width;
          g.fillStyle = "rgba(0,0,0,0.65)";
          g.fillRect(x, y, tw + label, label * 1.6);
          g.fillStyle = "#fff";
          g.fillText(text, x + label * 0.5, y + label * 1.15);
        }
      } finally {
        // Put the preview back on the user's playhead.
        if (!deps.playingRef.current)
          deps.renderFrame(deps.timeRef.current, deps.fpsRef.current, false);
      }

      return {
        kind: "image",
        mimeType: "image/png",
        base64: await canvasToBase64(grid),
        width: grid.width,
        height: grid.height,
        frames: list,
        grid: { cols, rows },
      };
    },

    // ---- mutation ----------------------------------------------------------
    insert_recipe: ({ recipe }) => {
      if (!recipe || typeof recipe !== "object" || Array.isArray(recipe))
        throw new Error("Pass `recipe` as a RecipeGraph object (see the tool description).");
      const rg = recipe as RecipeGraph;
      const built = buildRecipe(rg);
      const { errors, warnings } = validateFragment(
        built.nodes,
        built.edges,
        built.issues,
        HARD_BUILD_CODES
      );
      if (errors.length) throw invalid("Recipe", errors);
      const { groupId } = deps.commitRecipeFragment(
        { nodes: built.nodes, edges: built.edges },
        warnings.length
      );
      deps.flashToast(`Claude: added "${rg.name ?? "recipe"}"`);
      return {
        ok: true,
        groupId,
        warnings,
        note: "Interior node ids were minted at insert — call get_graph with scope=groupId before editing.",
      };
    },

    edit_group: ({ groupId, ops, summary }) => {
      const shell = nodeOrThrow(groupId);
      if (shell.data.defType !== GROUP_TYPE && shell.data.defType !== LAYER_TYPE)
        throw new Error(
          `"${groupId}" is a ${shell.data.defType} — edit_group targets a node-group or layer (get ids from get_graph).`
        );
      if (!Array.isArray(ops) || ops.length === 0)
        throw new Error("Pass `ops` as a non-empty array of edit operations.");
      const nodes = deps.nodesRef.current;
      const edges = deps.edgesRef.current;
      const fragIds = expandWithDescendants(nodes, [String(groupId)]);
      const fragNodes = nodes.filter((n) => fragIds.has(n.id));
      const fragEdges = edges.filter((e) => fragIds.has(e.source) && fragIds.has(e.target));
      const edit: RecipeEdit = {
        summary: typeof summary === "string" ? summary : undefined,
        ops: ops as RecipeEditOp[],
      };
      const result = applyRecipeEdit(String(groupId), fragNodes, fragEdges, edit);
      const { errors, warnings } = validateFragment(
        result.nodes,
        result.edges,
        result.issues,
        HARD_OP_CODES
      );
      if (errors.length) throw invalid("Edit", errors);
      // Commit in place — same replacement the in-app edit flow does. No
      // staleness window here: everything above ran synchronously.
      deps.pushGraph(deps.getGraphSnapshot());
      // aiAuthored gives node-groups the "Edit with AI" star; layers keep
      // their normal chrome.
      const committed = result.nodes.map((n) =>
        n.id === groupId && shell.data.defType === GROUP_TYPE
          ? { ...n, data: { ...n.data, aiAuthored: true } }
          : n
      );
      deps.setNodes(
        deps.nodesRef.current.filter((n) => !fragIds.has(n.id)).concat(committed)
      );
      deps.setEdges([
        ...deps.edgesRef.current.filter(
          (e) => !(fragIds.has(e.source) && fragIds.has(e.target))
        ),
        ...result.edges,
      ]);
      deps.flashToast(`Claude edit: ${edit.summary ?? `${edit.ops.length} ops`}`);
      return { ok: true, warnings };
    },

    set_param: ({ nodeId, param, value }) => {
      const node = nodeOrThrow(nodeId);
      const def = getNodeDef(node.data.defType);
      if (!def) throw new Error(`Node "${nodeId}" has an unknown type.`);
      const pdef = def.params.find((p) => p.name === param);
      if (!pdef)
        throw new Error(
          `${node.data.defType} has no param "${param}". Params: ${def.params
            .map((p) => p.name)
            .join(", ")}.`
        );
      if (!SETTABLE_PARAM_TYPES.has(pdef.type))
        throw new Error(`"${param}" (${pdef.type}) can't be set remotely — only ${[...SETTABLE_PARAM_TYPES].join("/")} params.`);
      const vet = vetParamValue(pdef, value);
      if (!vet.ok) throw new Error(`Bad value for "${param}": ${vet.reason}.`);
      deps.onParamChange(String(nodeId), String(param), vet.value);
      deps.flashToast(`Claude: set ${param} on ${node.data.name ?? node.data.defType}`);
      const anim = node.data.animation as
        | Record<string, { animated?: boolean }>
        | undefined;
      const keyframed = !!anim?.[String(param)]?.animated;
      return {
        ok: true,
        ...(keyframed
          ? {
              warning:
                "This param is keyframed — the static value is overridden by its animation.",
            }
          : {}),
      };
    },

    get_keyframes: ({ nodeId, param }) => {
      const node = nodeOrThrow(nodeId);
      const anim = (node.data.animation ?? {}) as Record<string, KeyframeAnimationBlock>;
      const def = getNodeDef(node.data.defType);
      if (param != null) {
        const block = anim[String(param)];
        if (!block)
          return { param, animated: false, keys: [] };
        return {
          param,
          animated: block.animated,
          ...(block.colorSpace ? { colorSpace: block.colorSpace } : {}),
          keys: block.keyframes.map((k) => ({
            frame: frameOf(k.tick),
            value: k.value,
            easing: k.easingOut,
            ...(k.bezierHandles ? { customBezier: true } : {}),
          })),
        };
      }
      // No param → an overview: every keyed track + what could be keyed.
      return {
        tracks: Object.entries(anim).map(([name, block]) => ({
          param: name,
          animated: block.animated,
          keyCount: block.keyframes.length,
          frames: block.keyframes.map((k) => frameOf(k.tick)),
        })),
        keyframable: (def?.params ?? [])
          .filter((p) => isKeyframable(p.type) && SETTABLE_PARAM_TYPES.has(p.type))
          .map((p) => p.name),
      };
    },

    set_keyframes: ({ nodeId, param, keys, animated }) => {
      const node = nodeOrThrow(nodeId);
      const def = getNodeDef(node.data.defType);
      if (!def) throw new Error(`Node "${nodeId}" has an unknown type.`);
      const pdef = def.params.find((p) => p.name === param);
      if (!pdef)
        throw new Error(
          `${node.data.defType} has no param "${param}". Params: ${def.params
            .map((p) => p.name)
            .join(", ")}.`
        );
      if (!isKeyframable(pdef.type) || !SETTABLE_PARAM_TYPES.has(pdef.type))
        throw new Error(`"${param}" (${pdef.type}) can't be keyframed remotely.`);
      if (!Array.isArray(keys))
        throw new Error("Pass `keys` as an array of {frame, value, easing?} (empty clears the track).");

      const anim = (node.data.animation ?? {}) as Record<string, KeyframeAnimationBlock>;
      const existing = anim[String(param)];

      if (keys.length === 0 && animated === undefined) {
        // Clear the whole track.
        deps.onAnimationChange(String(nodeId), String(param), undefined);
        deps.flashToast(`Claude: cleared ${param} keyframes`);
        return { ok: true, cleared: true };
      }

      const stepOnly = isStepOnly(pdef.type);
      const byTick = new Map<number, Keyframe>();
      for (const raw of keys as { frame?: unknown; value?: unknown; easing?: unknown }[]) {
        const frame = Number(raw?.frame);
        if (!Number.isFinite(frame) || frame < 0)
          throw new Error(`Every key needs a frame ≥ 0 (got ${raw?.frame}).`);
        const vet = vetParamValue(pdef, raw?.value);
        if (!vet.ok)
          throw new Error(`Bad value at frame ${frame}: ${vet.reason}.`);
        let easing = (raw?.easing ?? "easeInOutQuad") as string;
        if (easing === "customBezier")
          throw new Error(
            "customBezier is hand-authored in the graph editor — pick a preset."
          );
        if (!EASING_SET.has(easing))
          throw new Error(
            `Unknown easing "${easing}". Presets: ${EASING_PRESET_ORDER.filter(
              (e) => e !== "customBezier"
            ).join(", ")}.`
          );
        if (stepOnly) easing = "hold";
        byTick.set(tickOf(frame), {
          tick: tickOf(frame),
          value: vet.value,
          easingOut: easing as EasingPreset,
        });
      }
      const sorted = [...byTick.values()].sort((a, b) => a.tick - b.tick);

      const block: KeyframeAnimationBlock = {
        animated: animated === undefined ? true : !!animated,
        trackVisible: existing?.trackVisible ?? true,
        ...(existing?.graphVisible !== undefined
          ? { graphVisible: existing.graphVisible }
          : {}),
        ...(existing?.colorSpace ? { colorSpace: existing.colorSpace } : {}),
        keyframes: sorted.length > 0 ? sorted : (existing?.keyframes ?? []),
      };
      deps.onAnimationChange(String(nodeId), String(param), block);
      deps.flashToast(
        `Claude: keyed ${param} (${block.keyframes.length} keys) on ${node.data.name ?? node.data.defType}`
      );
      return {
        ok: true,
        param,
        animated: block.animated,
        frames: block.keyframes.map((k) => frameOf(k.tick)),
      };
    },

    validate_expression: ({ source }) => {
      const problems = pointExpressionNode.validateParams!({
        expression: typeof source === "string" ? source : "",
      });
      return { valid: problems.length === 0, problems };
    },

    // ---- transport ---------------------------------------------------------
    transport: ({ action, frame }) => {
      const fps = deps.fpsRef.current;
      if (action === "play") deps.setPlaying(true);
      else if (action === "pause") deps.setPlaying(false);
      else if (action === "seek") {
        if (typeof frame !== "number" || !Number.isFinite(frame))
          throw new Error("`seek` needs a numeric `frame`.");
        deps.setTime(Math.max(0, frame) / fps);
      } else throw new Error(`Unknown action "${action}" — use play, pause, or seek.`);
      return {
        ok: true,
        action,
        playing: action === "play" ? true : action === "pause" ? false : deps.playingRef.current,
        frame:
          action === "seek"
            ? Math.round(Math.max(0, frame as number))
            : Math.round(deps.timeRef.current * fps),
      };
    },
  };
}
