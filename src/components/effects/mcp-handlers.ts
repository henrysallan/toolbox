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
import {
  GROUP_TYPE,
  LAYER_TYPE,
  isZoneShell,
  readInputValues,
} from "@/engine/groups";
import { SETTABLE_PARAM_TYPES, vetParamValue } from "@/engine/node-catalog";
import { validateGraph, type ValEdge, type ValNode } from "@/engine/graph-validation";
import {
  applySyncedExpression,
  buildRecipe,
  type RecipeGraph,
} from "@/state/recipe-builder";
import {
  applyRecipeEdit,
  graphToSpec,
  type RecipeEdit,
  type RecipeEditOp,
} from "@/state/recipe-edit";
import { placeNewNodes } from "@/state/node-layout";
import { applyPositions, toLayoutGraph } from "@/state/node-layout-graph";
import {
  expandWithDescendants,
  listGroupShellControls,
  resolveGroupShellControl,
  withUpdatedParams,
  type GraphNode,
} from "@/state/graph-ops";
import {
  DEFAULT_TICKS_PER_FRAME,
  EASING_PRESET_ORDER,
  isKeyframable,
  isStepOnly,
  type EasingPreset,
  type Keyframe,
  type KeyframeAnimationBlock,
} from "@/engine/keyframes";
import * as prof from "@/engine/profiler";
import { summarize } from "@/lib/perf-console";
import { buildCatalogDsl, HARD_BUILD_CODES } from "@/lib/ai/generate-recipe-client";
import { HARD_OP_CODES } from "@/lib/ai/edit-recipe-client";
import { pointExpressionNode } from "@/nodes/effect/point-expression";
import {
  attachGlslErrorsToSpec,
  inspectGlslExpression,
} from "@/nodes/effect/glsl-expression";
import {
  channelKind,
  findExprChannel,
  setExprChannelValue,
} from "@/engine/expr-channels";
import type { EngineBackend } from "@/engine/gl";
import type { EvalCache } from "@/engine/evaluator";
import type { NodeOutput } from "@/engine/types";
import {
  inspectSocketValue,
  pickInspectSocket,
} from "@/engine/socket-inspect";

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
  // "root" | "layer" | "group" — so insert_recipe can tell a drilled-in
  // node-group (nesting trap) from a layer (the usual insert target).
  scopeType: "root" | "layer" | "group";
  // Parent of the current scope ("root" when there isn't one).
  parentScope: string;
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
    warningCount: number,
    opts?: { connect?: boolean; scope?: string; replaceOutput?: boolean }
  ) => {
    groupId: string | null;
    wrapped: boolean;
    parentId: string | null;
    wired: { from: string; to: string }[];
    skippedOccupied: { socket: string }[];
    idMap: Record<string, string>;
  };
  flashToast: (message: string) => void;
  // Tidy (090626_tidy-layout.md): lay nodes out along their wires — the
  // given ids, or every node of a scope (undefined = composition root).
  // Animated by the NodeEditor when that scope is on screen, immediate
  // (estimated boxes) otherwise; one undo entry either way. Returns the
  // number of nodes moved.
  tidyNodes: (target: { ids: string[] } | { scopeId: string | undefined }) => number;
  backendRef: MutableRefObject<EngineBackend | null>;
  evalCacheRef: MutableRefObject<EvalCache>;
  lastEvalOutputsRef: MutableRefObject<Map<string, NodeOutput> | null>;
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

async function canvasToBase64(
  canvas: HTMLCanvasElement,
  mimeType = "image/png",
  quality?: number
): Promise<string> {
  const blob = await new Promise<Blob | null>((r) =>
    canvas.toBlob(r, mimeType, quality)
  );
  if (!blob) throw new Error("Could not encode the screenshot.");
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result));
    fr.onerror = () => reject(new Error("Could not read the screenshot."));
    fr.readAsDataURL(blob);
  });
  return dataUrl.slice(dataUrl.indexOf(",") + 1);
}

// JPEG is the default because soft-gradient PNGs at 1024px blow Claude's
// ~1 MB tool-result cap. PNG stays available for lossless peeks, but its
// omitted-maxSize default is lower so it still fits.
const JPEG_QUALITY = 0.82;
const JPEG_DEFAULT_MAX = 1024;
const PNG_DEFAULT_MAX = 720;
const STRIP_JPEG_DEFAULT_MAX = 1400;
const STRIP_PNG_DEFAULT_MAX = 900;

function screenshotEncode(args: {
  maxSize?: unknown;
  format?: unknown;
  quality?: unknown;
  strip?: boolean;
}): { mimeType: string; max: number; quality: number | undefined } {
  const png = args.format === "png";
  const fallback = png
    ? args.strip
      ? STRIP_PNG_DEFAULT_MAX
      : PNG_DEFAULT_MAX
    : args.strip
      ? STRIP_JPEG_DEFAULT_MAX
      : JPEG_DEFAULT_MAX;
  const min = args.strip ? 256 : 64;
  const max = Math.min(2048, Math.max(min, Number(args.maxSize) || fallback));
  if (png) return { mimeType: "image/png", max, quality: undefined };
  const q = Number(args.quality);
  return {
    mimeType: "image/jpeg",
    max,
    quality: Number.isFinite(q) ? Math.min(1, Math.max(0.4, q)) : JPEG_QUALITY,
  };
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

  const glslInspectFor = (
    node: GraphNode | null,
    backend: EngineBackend | null
  ) => {
    if (!node || !backend || node.data.defType !== "glsl-expression") return null;
    const info = inspectGlslExpression(node.id, node.data.params, backend.tryShader);
    return info.ok ? null : info;
  };

  return {
    // ---- context -----------------------------------------------------------
    get_status: () => deps.status,

    get_catalog: (args) =>
      buildCatalogDsl({
        mode: args.mode === "full" ? "full" : args.mode === "list" ? "list" : undefined,
        category: args.category as string | string[] | undefined,
        types: args.types as string | string[] | undefined,
      }),

    get_graph: ({ scope, verbosity, params }) => {
      const nodes = deps.nodesRef.current;
      const edges = deps.edgesRef.current;
      const scopeId = !scope || scope === "root" ? undefined : String(scope);
      if (scopeId) {
        const shell = nodeOrThrow(scopeId);
        if (
          shell.data.defType !== GROUP_TYPE &&
          shell.data.defType !== LAYER_TYPE &&
          !isZoneShell(shell.data.defType)
        )
          throw new Error(
            `"${scopeId}" is a ${shell.data.defType} — get_graph scopes are group, layer, or Repeat/For Each/Iterate zone ids (or "root").`
          );
      }
      const spec = graphToSpec(nodes, edges, scopeId, {
        verbosity: verbosity === "ids" ? "ids" : "full",
        params: params === "all" ? "all" : "non_default",
        expressions: params === "all" ? "full" : "hash",
      });
      const backend = deps.backendRef.current;
      if (!backend || verbosity === "ids") return spec;
      const byId = new Map(nodes.map((n) => [n.id, n]));
      return {
        ...spec,
        nodes: attachGlslErrorsToSpec(
          spec.nodes,
          (id) => byId.get(id)?.data.params,
          backend.tryShader
        ),
      };
    },

    get_node_data: ({ nodeId, limit, socket, frame }) => {
      const node = nodeOrThrow(nodeId);
      const fps = deps.fpsRef.current;
      const seek = typeof frame === "number" && Number.isFinite(frame);
      const targetTime = seek
        ? Math.max(0, frame as number) / fps
        : deps.timeRef.current;
      deps.forcedTerminalRef.current = node.id;
      try {
        deps.renderFrame(targetTime, fps, false);
      } finally {
        deps.forcedTerminalRef.current = null;
      }
      const output =
        deps.evalCacheRef.current.get(node.id)?.output ??
        deps.lastEvalOutputsRef.current?.get(node.id);
      if (!deps.playingRef.current) {
        deps.renderFrame(deps.timeRef.current, deps.fpsRef.current, false);
      }
      const picked = pickInspectSocket(output, socket);
      if (!picked.value) {
        throw new Error(
          `No evaluated output on "${node.id}" (${node.data.defType}${
            picked.socket !== "out" ? ` ${picked.socket}` : ""
          }). The node may be disconnected, gated, or a group shell (flatten dissolves those — pass an interior computing node).`
        );
      }
      return {
        nodeId: node.id,
        type: node.data.defType,
        socket: picked.socket,
        frame: Math.round(targetTime * fps),
        ...inspectSocketValue(picked.value, limit),
      };
    },

    // ---- vision ------------------------------------------------------------
    screenshot: async ({ nodeId, frame, maxSize, format, quality }) => {
      const canvas = deps.canvasRef.current;
      if (!canvas) throw new Error("Preview canvas unavailable.");
      const fps = deps.fpsRef.current;
      const seek = typeof frame === "number" && Number.isFinite(frame);
      const targetTime = seek ? Math.max(0, frame as number) / fps : deps.timeRef.current;
      const peek = nodeId != null ? nodeOrThrow(nodeId) : null;
      if (peek) deps.forcedTerminalRef.current = peek.id;
      try {
        // Always render explicitly so the capture is deterministic (not
        // whatever half-frame the last rAF left behind).
        deps.renderFrame(targetTime, fps, false);
      } finally {
        deps.forcedTerminalRef.current = null;
      }
      const enc = screenshotEncode({ maxSize, format, quality });
      const scale = Math.min(1, enc.max / Math.max(canvas.width, canvas.height));
      const w = Math.max(1, Math.round(canvas.width * scale));
      const h = Math.max(1, Math.round(canvas.height * scale));
      const tmp = document.createElement("canvas");
      tmp.width = w;
      tmp.height = h;
      const ctx2d = tmp.getContext("2d")!;
      if (enc.mimeType === "image/jpeg") {
        ctx2d.fillStyle = "#000";
        ctx2d.fillRect(0, 0, w, h);
      }
      ctx2d.drawImage(canvas, 0, 0, w, h);
      const base64 = await canvasToBase64(tmp, enc.mimeType, enc.quality);
      // A paused editor should keep showing the user's playhead, not the
      // frame Claude peeked at.
      if ((seek || peek) && !deps.playingRef.current)
        deps.renderFrame(deps.timeRef.current, deps.fpsRef.current, false);
      const shader = glslInspectFor(peek, deps.backendRef.current);
      return {
        kind: "image",
        mimeType: enc.mimeType,
        base64,
        width: w,
        height: h,
        frame: Math.round(targetTime * fps),
        ...(shader?.error
          ? { shaderError: shader.error, shaderPreludeLines: shader.preludeLines }
          : {}),
        ...(shader?.problems ? { shaderProblems: shader.problems } : {}),
      };
    },

    // Sample several frames and tile them into ONE labelled grid image, so
    // judging motion costs a single tool call (and one image's worth of
    // context) instead of N.
    screenshot_strip: async ({ frames, start, end, every, nodeId, maxSize, format, quality }) => {
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
      const enc = screenshotEncode({ maxSize, format, quality, strip: true });
      const budget = enc.max;
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
      if (enc.mimeType === "image/jpeg") {
        g.fillStyle = "#000";
        g.fillRect(0, 0, grid.width, grid.height);
      }
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
        mimeType: enc.mimeType,
        base64: await canvasToBase64(grid, enc.mimeType, enc.quality),
        width: grid.width,
        height: grid.height,
        frames: list,
        grid: { cols, rows },
      };
    },

    // ---- mutation ----------------------------------------------------------
    insert_recipe: ({ recipe, connect, scope, replace_output }) => {
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
      const scopeArg =
        typeof scope === "string" && scope.trim() ? scope.trim() : undefined;
      // Drilled into a node-group: omitting scope nests the replacement
      // inside the thing it was meant to replace. Demand an explicit
      // target — "parent" / the enclosing layer, or the group id to nest.
      if (scopeArg == null && deps.status.scopeType === "group") {
        throw new Error(
          `Editor is inside group "${deps.status.scope}". insert_recipe without scope would nest the new group inside it. Pass scope=${deps.status.parentScope} to insert beside it, scope=parent for the same, or scope=${deps.status.scope} to nest intentionally.`
        );
      }
      const hooked = connect !== false;
      const replaceOutput = replace_output === true;
      const { groupId, wired, parentId, wrapped, skippedOccupied, idMap } =
        deps.commitRecipeFragment(
          { nodes: built.nodes, edges: built.edges },
          warnings.length,
          { connect: hooked, scope: scopeArg, replaceOutput }
        );
      deps.flashToast(`Claude: added "${rg.name ?? "recipe"}"`);
      const where = wrapped
        ? "a new layer"
        : parentId
          ? `scope ${parentId}`
          : "the current scope";
      const ids: Record<string, string> = {};
      for (const [lid, builtId] of Object.entries(built.ids)) {
        ids[lid] = idMap[builtId] ?? builtId;
      }
      const nextWarnings = [...warnings];
      if (hooked && wired.length === 0 && skippedOccupied.length > 0) {
        nextWarnings.push(
          `Enclosing output already had a wire (${skippedOccupied
            .map((s) => s.socket)
            .join(", ")}) — group was left unwired. Pass replace_output: true to take the socket.`
        );
      }
      const wireNote =
        wired.length > 0
          ? ` Wired to the enclosing output: ${wired.map((w) => `${w.from} → ${w.to}`).join(", ")}.`
          : hooked && skippedOccupied.length === 0
            ? " No matching enclosing output socket — group was left unwired."
            : "";
      return {
        ok: true,
        groupId,
        parentId,
        wrapped,
        wired,
        ids,
        warnings: nextWarnings,
        note:
          `Inserted into ${where}. Use \`ids\` for interior minted ids (recipe local id → live id).` +
          wireNote,
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
      // add_node mints at (0,0) — place each new node beside its first
      // consumer on the row it feeds, sliding down past occupied slots
      // (090626_tidy-layout.md). Existing nodes never move. Only the
      // scope's own level (direct interior + inline zone members) counts
      // as obstacles: the shell and any nested group's interior live in
      // other coordinate spaces.
      const freshIds = result.nodes.filter((n) => !fragIds.has(n.id)).map((n) => n.id);
      let placedNodes = result.nodes;
      if (freshIds.length) {
        const levelIds = new Set<string>();
        let grew = true;
        while (grew) {
          grew = false;
          for (const n of result.nodes) {
            if (levelIds.has(n.id)) continue;
            const p = n.data.parentId;
            if (p === groupId || (p && levelIds.has(p) && isZoneShell(result.nodes.find((x) => x.id === p)?.data.defType))) {
              levelIds.add(n.id);
              grew = true;
            }
          }
        }
        const level = result.nodes.filter((n) => levelIds.has(n.id));
        const lg = toLayoutGraph(level, result.edges);
        const moves = placeNewNodes(
          lg.nodes,
          lg.edges,
          freshIds.filter((id) => levelIds.has(id))
        );
        placedNodes = applyPositions(result.nodes, moves);
      }
      // Commit in place — same replacement the in-app edit flow does. No
      // staleness window here: everything above ran synchronously.
      deps.pushGraph(deps.getGraphSnapshot());
      // aiAuthored gives node-groups the "Edit with AI" star; layers keep
      // their normal chrome.
      const committed = placedNodes.map((n) =>
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
      return {
        ok: true,
        applied: result.applied,
        ops: result.ops,
        warnings,
      };
    },

    tidy: ({ nodes: nodeIds, scope }) => {
      if (Array.isArray(nodeIds) && nodeIds.length) {
        const ids = nodeIds.map((id) => nodeOrThrow(id).id);
        const moved = deps.tidyNodes({ ids });
        deps.flashToast(`Claude: tidied ${moved} node${moved === 1 ? "" : "s"}`);
        return { ok: true, moved };
      }
      const scopeArg =
        typeof scope === "string" && scope.trim() ? scope.trim() : undefined;
      let scopeId: string | undefined;
      if (scopeArg === "root") scopeId = undefined;
      else if (scopeArg) {
        const shell = nodeOrThrow(scopeArg);
        if (shell.data.defType !== GROUP_TYPE && shell.data.defType !== LAYER_TYPE)
          throw new Error(
            `"${scopeArg}" is a ${shell.data.defType} — tidy's scope is a node-group or layer id, or "root".`
          );
        scopeId = shell.id;
      } else scopeId = deps.status.scope === "root" ? undefined : deps.status.scope;
      const moved = deps.tidyNodes({ scopeId });
      deps.flashToast(`Claude: tidied ${moved} node${moved === 1 ? "" : "s"}`);
      return { ok: true, moved, scope: scopeId ?? "root" };
    },

    set_param: ({ nodeId, param, value }) => {
      const node = nodeOrThrow(nodeId);
      const def = getNodeDef(node.data.defType);
      if (!def) throw new Error(`Node "${nodeId}" has an unknown type.`);
      const pdef = def.params.find((p) => p.name === param);
      if (!pdef) {
        // A channel NAME — tune the row in place (Sync is add-only, so
        // re-authoring the expression never changes an existing value).
        const chan = findExprChannel(def, node.data.params, String(param));
        if (chan) {
          // Transport coercion, as for params below: some clients send
          // "0.5" / "true" / a JSON-encoded stops or points list.
          let cv = value;
          const kind = channelKind(chan);
          if (typeof value === "string") {
            const s = value.trim();
            if (kind === "scalar" && s !== "" && Number.isFinite(Number(s))) cv = Number(s);
            else if (kind === "toggle" && (s === "true" || s === "false")) cv = s === "true";
            else if ((kind === "ramp" || kind === "curve") && s.startsWith("[")) {
              try {
                cv = JSON.parse(s);
              } catch {
                /* vetting reports the shape */
              }
            }
          }
          const r = setExprChannelValue(def, node.data.params, String(param), cv);
          if (!r.ok) throw new Error(`Bad value for channel "${param}": ${r.reason}.`);
          deps.onParamChange(String(nodeId), r.listParam, r.params[r.listParam]);
          deps.flashToast(
            `Claude: set ${param} on ${node.data.name ?? node.data.defType}`
          );
          return { ok: true, channel: param, kind, value: r.value };
        }
        if (node.data.defType === GROUP_TYPE || node.data.defType === LAYER_TYPE) {
          const nodes = deps.nodesRef.current;
          const edges = deps.edgesRef.current;
          const ctrl = resolveGroupShellControl(node, String(param), nodes, edges);
          if (ctrl) {
            let coerced = value;
            if (typeof value === "string") {
              if (
                ctrl.controlDef.type === "scalar" &&
                value.trim() !== "" &&
                Number.isFinite(Number(value))
              ) {
                coerced = Number(value);
              } else if (
                ctrl.controlDef.type === "boolean" &&
                (value === "true" || value === "false")
              ) {
                coerced = value === "true";
              }
            }
            const vet = vetParamValue(ctrl.controlDef, coerced);
            if (!vet.ok) throw new Error(`Bad value for "${param}": ${vet.reason}.`);
            const stored = readInputValues(node.data.params);
            deps.onParamChange(String(nodeId), "inputValues", {
              ...stored,
              [ctrl.socketName]: vet.value,
            });
            deps.flashToast(
              `Claude: set ${ctrl.socketName} on ${node.data.name ?? node.data.defType}`
            );
            return { ok: true, param: ctrl.socketName, value: vet.value, group: true };
          }
          const names = listGroupShellControls(node, nodes, edges)
            .map((c) => c.socketName)
            .join(", ");
          throw new Error(
            `${node.data.defType} has no param "${param}". Exposed: ${names || "none"}. Params: ${def.params
              .map((p) => p.name)
              .join(", ") || "(none)"}.`
          );
        }
        const channelNames = ((node.data.params.inputs as { name: string }[] | undefined) ?? [])
          .map((c) => c.name)
          .join(", ");
        throw new Error(
          `${node.data.defType} has no param "${param}". Params: ${def.params
            .map((p) => p.name)
            .join(", ")}.${
            def.params.some((p) => p.type === "expr_inputs" && p.channelSync)
              ? ` Channels (set by name): ${channelNames || "none"}.`
              : ""
          }`
        );
      }
      if (!SETTABLE_PARAM_TYPES.has(pdef.type)) {
        if (pdef.type === "expr_inputs") {
          throw new Error(
            `"${param}" is the channel list and can't be set wholesale. Declare channels in the expression — ch("k", 0.5) / toggle("on", true) / pick("mode", "a", "b") / color("tint", "#hex") / ramp("ink", …) / curve("f", …) — and set_param expression (Sync mints new rows, add-only). To change an existing channel's value, set_param with the channel NAME as param.`
          );
        }
        throw new Error(
          `"${param}" (${pdef.type}) can't be set remotely — only ${[...SETTABLE_PARAM_TYPES].join("/")} params.`
        );
      }
      // MCP transport coercion: some clients serialize the untyped `value`
      // argument as a string ("1", "true"), which vetParamValue rightly
      // rejects for scalar/boolean params. Coerce the unambiguous string
      // forms here, at the transport boundary — vetParamValue still runs
      // on the result, so range clamping and validation are unchanged.
      // (Recipe JSON does NOT get this leniency; there a mistyped value is
      // an authoring error the repair loop should see.)
      let coerced = value;
      if (typeof value === "string") {
        if (pdef.type === "scalar" && value.trim() !== "" && Number.isFinite(Number(value))) {
          coerced = Number(value);
        } else if (pdef.type === "boolean" && (value === "true" || value === "false")) {
          coerced = value === "true";
        }
      }
      const vet = vetParamValue(pdef, coerced);
      if (!vet.ok) throw new Error(`Bad value for "${param}": ${vet.reason}.`);
      const anim = node.data.animation as
        | Record<string, { animated?: boolean }>
        | undefined;
      const keyframed = !!anim?.[String(param)]?.animated;
      const exposed = (node.data.exposedParams ?? []).includes(String(param));
      // Prefer the exposed warning when both apply — flatten patches
      // inputValues, so the interior constant is shadowed at eval.
      const note = exposed
        ? {
            warning:
              "param is exposed; group value wins — set_param the group shell with the exposed label.",
          }
        : keyframed
          ? {
              warning:
                "This param is keyframed — the static value is overridden by its animation.",
            }
          : {};
      // A committed expression write runs the panel Sync scan (add-only) so
      // new ch()/pick() refs mint uniforms in the same undo as the source.
      // Live typing still goes through onParamChange without this — partial
      // names would otherwise become leftover channels.
      if (param === "expression" && typeof vet.value === "string") {
        const { params: nextParams, minted } = applySyncedExpression(
          def,
          node.data.params,
          vet.value
        );
        deps.pushGraph(deps.getGraphSnapshot());
        const id = String(nodeId);
        deps.setNodes((prev) =>
          prev.map((n) => (n.id === id ? withUpdatedParams(n, nextParams) : n))
        );
        deps.flashToast(
          `Claude: set ${param} on ${node.data.name ?? node.data.defType}`
        );
        return {
          ok: true,
          ...(minted.length ? { mintedChannels: minted } : {}),
          ...note,
        };
      }
      deps.onParamChange(String(nodeId), String(param), vet.value);
      deps.flashToast(`Claude: set ${param} on ${node.data.name ?? node.data.defType}`);
      return { ok: true, ...note };
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

    // ---- performance (specdocs/080726_perf-profiler.md M2) -----------------
    // The agent arms and reads its own traces rather than asking the user to
    // paste console output. Capture is OFF until armed here (or from the
    // Window menu), so an unarmed session pays nothing.
    set_perf_capture: ({ level, frames }) => {
      // No playingOnly here, deliberately: the agent's workflow traces paused
      // interactions on purpose (set_param then get_perf). The Performance
      // PANEL arms with playingOnly:true so its stats describe playback only
      // — arming from either side replaces the other's mode, and always
      // clears, so the trace is never a mix.
      const l = level === undefined ? 2 : Number(level);
      if (![0, 1, 2, 3].includes(l)) {
        throw new Error(
          "`level` must be 0 (off), 1 (timings + reasons), 2 (+ volume, " +
            "texture churn, fingerprint bytes), or 3 (+ per-node GPU time)."
        );
      }
      const f = frames === undefined ? 600 : Number(frames);
      if (!Number.isFinite(f) || f < 1 || f > 10000) {
        throw new Error("`frames` must be between 1 and 10000.");
      }
      prof.setCaptureLevel(l as 0 | 1 | 2 | 3, { frames: f });
      deps.flashToast(
        l === 0 ? "Claude: perf capture off" : `Claude: perf capture on (level ${l})`
      );
      return {
        ok: true,
        level: l,
        frames: l === 0 ? 0 : f,
        note:
          l === 0
            ? "Capture off; the trace ring was released."
            : l === 3
              ? "Trace cleared. GPU timings resolve 1-3 frames late, so drive " +
                "the workload for a few seconds before reading, and check " +
                "gpu.coverage in the result."
              : "Trace cleared. Drive the workload, then call get_perf.",
      };
    },

    get_perf: ({ frames, top, groupBy }) => {
      if (prof.getCaptureLevel() === 0) {
        throw new Error(
          "Perf capture is off — call set_perf_capture first, then drive the " +
            "workload (play, scrub, or edit a param) before reading."
        );
      }
      const summary = summarize({
        frames: frames === undefined ? undefined : Number(frames),
        top: top === undefined ? 20 : Number(top),
        edges: deps.edgesRef.current.map((e) => ({
          source: e.source,
          target: e.target,
        })),
      });
      if (summary.frames === 0) {
        return {
          ...summary,
          note:
            "No frames captured yet. The editor only evaluates on playback, " +
            "a param edit, or a graph change — drive one of those first.",
        };
      }
      if (groupBy !== "type") return summary;
      // Collapse instances so "which KIND of node is expensive" is answerable
      // without the agent having to correlate ids itself.
      const byType = new Map<
        string,
        { type: string; count: number; msPerFrame: number; totalMs: number; recomputes: number; samples: number }
      >();
      for (const n of summary.nodes) {
        const e = byType.get(n.type) ?? {
          type: n.type,
          count: 0,
          msPerFrame: 0,
          totalMs: 0,
          recomputes: 0,
          samples: 0,
        };
        e.count++;
        e.msPerFrame += n.msPerFrame;
        e.totalMs += n.totalMs;
        e.recomputes += n.recomputes;
        e.samples += n.samples;
        byType.set(n.type, e);
      }
      const types = [...byType.values()]
        .map((e) => ({
          ...e,
          msPerFrame: Math.round(e.msPerFrame * 1000) / 1000,
          totalMs: Math.round(e.totalMs * 100) / 100,
          recomputeRate:
            e.samples > 0 ? Math.round((e.recomputes / e.samples) * 1000) / 1000 : 0,
        }))
        .sort((a, b) => b.totalMs - a.totalMs);
      return { ...summary, nodes: undefined, types };
    },

    get_perf_frame: ({ seq }) => {
      if (prof.getCaptureLevel() === 0) {
        throw new Error("Perf capture is off — call set_perf_capture first.");
      }
      if (seq === undefined || !Number.isFinite(Number(seq))) {
        throw new Error(
          "`seq` is required — take it from a frame in get_perf, or read " +
            "the newest with get_perf({frames:1})."
        );
      }
      const frame = prof.readFrame(Number(seq));
      if (!frame) {
        throw new Error(
          `Frame ${seq} is not in the ring — it either aged out or was never ` +
            "captured. Reduce the gap between the workload and the read, or " +
            "arm a larger ring via set_perf_capture({frames}).",
        );
      }
      return frame;
    },

    validate_expression: ({ source }) => {
      const problems = pointExpressionNode.validateParams!({
        expression: typeof source === "string" ? source : "",
      });
      return { valid: problems.length === 0, problems };
    },

    get_shader_errors: ({ nodeId }) => {
      const backend = deps.backendRef.current;
      if (!backend)
        throw new Error(
          "GL backend unavailable — wait for the editor to finish starting."
        );
      const all = deps.nodesRef.current;
      let targets: GraphNode[];
      if (nodeId != null && String(nodeId).length > 0) {
        const n = nodeOrThrow(nodeId);
        if (n.data.defType !== "glsl-expression")
          throw new Error(
            `"${n.id}" is a ${n.data.defType} — get_shader_errors compiles GLSL Expression. Point Expression uses validate_expression.`
          );
        targets = [n];
      } else {
        targets = all.filter((n) => n.data.defType === "glsl-expression");
      }
      const nodes = targets.map((n) =>
        inspectGlslExpression(n.id, n.data.params, backend.tryShader)
      );
      return {
        compiled: nodes.length,
        failed: nodes.filter((n) => !n.ok).length,
        nodes,
      };
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
