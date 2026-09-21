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
  diffGroupSpec,
  graphToSpec,
  type GraphSpecDiff,
  type GroupSpec,
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
import type { ImageValue, NodeOutput } from "@/engine/types";
import {
  inspectSocketValue,
  pickInspectSocket,
} from "@/engine/socket-inspect";
import { withMaskInput } from "@/engine/conventions";
import {
  COMPARE_DEFAULTS,
  compareRgba,
  describeMetrics,
  diffHeatRgba,
  getGlslDocs,
  planTranslation,
  type PlanNodeInfo,
} from "@/lib/glsl-translation";

// Mutation log + graph snapshots so a timed-out tool call isn't a black
// box: get_recent_edits (keyed by the summary the agent already sent) and
// get_graph({ since }) answer "did that 234-op edit land?" without a
// 700-line re-read.
const EDIT_LOG_MAX = 40;
const SPEC_SNAP_MAX = 6;
type EditLogEntry = {
  rev: number;
  at: number;
  cmd: string;
  summary?: string;
  status: "ok" | "error";
  error?: string;
  groupId?: string;
  applied?: number;
  failed?: number;
};
const editLog: EditLogEntry[] = [];
const specSnaps = new Map<string, { rev: number; spec: GroupSpec }[]>();
let graphRev = 0;

function scopeKey(scopeId?: string | null): string {
  return scopeId && scopeId !== "root" ? scopeId : "root";
}

function rememberSpec(scopeId: string | undefined, spec: GroupSpec) {
  const k = scopeKey(scopeId);
  const arr = specSnaps.get(k) ?? [];
  arr.push({ rev: graphRev, spec });
  specSnaps.set(k, arr.slice(-SPEC_SNAP_MAX));
}

function bumpGraphRev() {
  graphRev += 1;
}

function logMutation(entry: Omit<EditLogEntry, "rev" | "at">) {
  editLog.push({ ...entry, rev: graphRev, at: Date.now() });
  if (editLog.length > EDIT_LOG_MAX) editLog.shift();
}

function specAt(scopeId: string | undefined, rev: number): GroupSpec | undefined {
  const arr = specSnaps.get(scopeKey(scopeId)) ?? [];
  return [...arr].reverse().find((s) => s.rev === rev)?.spec;
}

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
  forcedTerminalHandleRef: MutableRefObject<string | null>;
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
    frag: { nodes: GraphNode[]; edges: Edge[] } | { nodes: GraphNode[]; edges: Edge[] }[],
    warningCount: number,
    opts?: { connect?: boolean; scope?: string; replaceOutput?: boolean }
  ) => {
    groupId: string | null;
    wrapped: boolean;
    parentId: string | null;
    wired: { from: string; to: string }[];
    skippedOccupied: { socket: string }[];
    idMap: Record<string, string>;
    groups: {
      groupId: string | null;
      idMap: Record<string, string>;
      wired: { from: string; to: string }[];
    }[];
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

// screenshot / screenshot_strip nodeId: exact id, or "<id>:out" /
// "<id>:aux:<name>" to pick which output to blit (Circle's fill image is
// not the disc — pass :aux:image for the raster).
function parseNodePeek(
  raw: unknown,
  nodes: GraphNode[]
): { node: GraphNode; handle?: string } {
  const s = String(raw ?? "").trim();
  if (!s) throw new Error("Pass a node id from get_graph.");
  const exact = nodes.find((n) => n.id === s);
  if (exact) return { node: exact };
  const aux = s.match(/^(.*):aux:([A-Za-z0-9_-]+)$/);
  if (aux) {
    const node = nodes.find((n) => n.id === aux[1]);
    if (node) return { node, handle: `out:aux:${aux[2]}` };
  }
  if (s.endsWith(":out")) {
    const id = s.slice(0, -":out".length);
    const node = nodes.find((n) => n.id === id);
    if (node) return { node, handle: "out:primary" };
  }
  throw new Error(
    `No node with id "${s}" — call get_graph for current ids. On a node with aux outputs pass nodeId:aux:<name> (e.g. ${s.split(":")[0]}:aux:image).`
  );
}

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
    get_status: () => ({ ...deps.status, rev: graphRev }),

    get_catalog: (args) =>
      buildCatalogDsl({
        mode: args.mode === "full" ? "full" : args.mode === "list" ? "list" : undefined,
        category: args.category as string | string[] | undefined,
        types: args.types as string | string[] | undefined,
      }),

    get_graph: ({ scope, verbosity, params, since }) => {
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
      const full =
        !backend || verbosity === "ids"
          ? spec
          : {
              ...spec,
              nodes: attachGlslErrorsToSpec(
                spec.nodes,
                (id) => nodes.find((n) => n.id === id)?.data.params,
                backend.tryShader
              ),
            };
      rememberSpec(scopeId, full);
      const sinceRev =
        typeof since === "number" && Number.isFinite(since) ? since : undefined;
      if (sinceRev === graphRev) {
        return { rev: graphRev, unchanged: true, name: full.name };
      }
      if (sinceRev != null) {
        const prev = specAt(scopeId, sinceRev);
        if (prev) {
          const diff: GraphSpecDiff = diffGroupSpec(prev, full);
          return {
            rev: graphRev,
            since: sinceRev,
            name: full.name,
            added: diff.added,
            removed: diff.removed,
            changed: diff.changed,
            edgesAdded: diff.edgesAdded,
            edgesRemoved: diff.edgesRemoved,
            ...(diff.interface ? { interface: diff.interface } : {}),
          };
        }
        return {
          rev: graphRev,
          since: sinceRev,
          note: "no snapshot at that rev — full graph",
          ...full,
        };
      }
      return { rev: graphRev, ...full };
    },

    get_recent_edits: ({ summary, limit }) => {
      const cap = Math.min(40, Math.max(1, Number(limit) || 10));
      const needle =
        typeof summary === "string" && summary.trim() ? summary.trim() : "";
      const rows = needle
        ? editLog.filter(
            (e) => e.summary === needle || (e.summary ?? "").includes(needle)
          )
        : editLog;
      return { rev: graphRev, edits: rows.slice(-cap) };
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
      const peek = nodeId != null ? parseNodePeek(nodeId, deps.nodesRef.current) : null;
      if (peek) {
        deps.forcedTerminalRef.current = peek.node.id;
        deps.forcedTerminalHandleRef.current = peek.handle ?? null;
      }
      try {
        // Always render explicitly so the capture is deterministic (not
        // whatever half-frame the last rAF left behind).
        deps.renderFrame(targetTime, fps, false);
      } finally {
        deps.forcedTerminalRef.current = null;
        deps.forcedTerminalHandleRef.current = null;
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
      const shader = glslInspectFor(peek?.node ?? null, deps.backendRef.current);
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

      const peek = nodeId != null ? parseNodePeek(nodeId, deps.nodesRef.current) : null;

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
          if (peek) {
            deps.forcedTerminalRef.current = peek.node.id;
            deps.forcedTerminalHandleRef.current = peek.handle ?? null;
          }
          try {
            deps.renderFrame(list[i] / fps, fps, false);
          } finally {
            deps.forcedTerminalRef.current = null;
            deps.forcedTerminalHandleRef.current = null;
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
    insert_recipe: ({ recipe, recipes, connect, scope, replace_output, dry_run }) => {
      const dryRun = dry_run === true;
      const list: RecipeGraph[] = [];
      if (Array.isArray(recipes)) {
        for (const r of recipes) {
          if (!r || typeof r !== "object" || Array.isArray(r))
            throw new Error("Each `recipes[]` entry must be a RecipeGraph object.");
          list.push(r as RecipeGraph);
        }
      }
      if (recipe && typeof recipe === "object" && !Array.isArray(recipe)) {
        list.unshift(recipe as RecipeGraph);
      }
      if (list.length === 0)
        throw new Error(
          "Pass `recipe` as a RecipeGraph, or `recipes` as an array of them."
        );
      const builtList: { rg: RecipeGraph; built: ReturnType<typeof buildRecipe> }[] = [];
      const allWarnings: string[] = [];
      for (const rg of list) {
        const built = buildRecipe(rg);
        const { errors, warnings } = validateFragment(
          built.nodes,
          built.edges,
          built.issues,
          HARD_BUILD_CODES
        );
        if (errors.length) {
          if (!dryRun)
            logMutation({
              cmd: "insert_recipe",
              summary: rg.name,
              status: "error",
              error: errors[0],
            });
          throw invalid("Recipe", errors);
        }
        allWarnings.push(...warnings);
        builtList.push({ rg, built });
      }
      const scopeArg =
        typeof scope === "string" && scope.trim() ? scope.trim() : undefined;
      const nestingNote = `Editor is inside group "${deps.status.scope}". insert_recipe without scope would nest the new group inside it. Pass scope=${deps.status.parentScope} to insert beside it, scope=parent for the same, or scope=${deps.status.scope} to nest intentionally.`;
      if (dryRun) {
        // Validate only: same build + validator pass as a real insert,
        // nothing committed, no undo entry, no toast, `rev` untouched.
        const nextWarnings = [...allWarnings];
        if (scopeArg == null && deps.status.scopeType === "group") nextWarnings.push(nestingNote);
        return {
          ok: true,
          dry_run: true,
          rev: graphRev,
          valid: true,
          recipes: builtList.map((b) => ({
            name: b.rg.name,
            nodes: b.built.nodes.length,
            edges: b.built.edges.length,
            // Local id → the type it resolved to; live ids are only minted
            // on a real insert.
            types: Object.fromEntries(
              Object.entries(b.built.ids).map(([lid, builtId]) => [
                lid,
                b.built.nodes.find((n) => n.id === builtId)?.data.defType ?? "?",
              ])
            ),
          })),
          warnings: nextWarnings,
          note: "Dry run — the recipe builds and validates; nothing was inserted. Call again without dry_run to commit.",
        };
      }
      if (scopeArg == null && deps.status.scopeType === "group") {
        throw new Error(nestingNote);
      }
      const hooked = connect !== false;
      const replaceOutput = replace_output === true;
      rememberSpec(
        scopeArg === "parent" ? deps.status.parentScope : scopeArg,
        graphToSpec(
          deps.nodesRef.current,
          deps.edgesRef.current,
          scopeArg && scopeArg !== "root" && scopeArg !== "parent"
            ? scopeArg
            : undefined
        )
      );
      const committed = deps.commitRecipeFragment(
        builtList.map((b) => ({ nodes: b.built.nodes, edges: b.built.edges })),
        allWarnings.length,
        { connect: hooked, scope: scopeArg, replaceOutput }
      );
      bumpGraphRev();
      const names = list.map((r) => r.name ?? "recipe");
      deps.flashToast(
        list.length === 1
          ? `Claude: added "${names[0]}"`
          : `Claude: added ${list.length} recipes`
      );
      logMutation({
        cmd: "insert_recipe",
        summary: names.join(", "),
        status: "ok",
        groupId: committed.groupId ?? undefined,
      });
      const remapIds = (
        builtIds: Record<string, string>,
        idMap: Record<string, string>
      ) => {
        const ids: Record<string, string> = {};
        for (const [lid, builtId] of Object.entries(builtIds)) {
          ids[lid] = idMap[builtId] ?? builtId;
        }
        return ids;
      };
      const where = committed.wrapped
        ? "a new layer"
        : committed.parentId
          ? `scope ${committed.parentId}`
          : "the current scope";
      const nextWarnings = [...allWarnings];
      if (
        hooked &&
        committed.wired.length === 0 &&
        committed.skippedOccupied.length > 0
      ) {
        nextWarnings.push(
          `Enclosing output already had a wire (${committed.skippedOccupied
            .map((s) => s.socket)
            .join(", ")}) — last group was left unwired. Pass replace_output: true to take the socket.`
        );
      }
      const wireNote =
        committed.wired.length > 0
          ? ` Wired to the enclosing output: ${committed.wired.map((w) => `${w.from} → ${w.to}`).join(", ")}.`
          : hooked && committed.skippedOccupied.length === 0
            ? " No matching enclosing output socket — group was left unwired."
            : "";
      if (list.length === 1) {
        return {
          ok: true,
          rev: graphRev,
          groupId: committed.groupId,
          parentId: committed.parentId,
          wrapped: committed.wrapped,
          wired: committed.wired,
          ids: remapIds(builtList[0].built.ids, committed.idMap),
          warnings: nextWarnings,
          note:
            `Inserted into ${where}. Use \`ids\` for interior minted ids (recipe local id → live id).` +
            wireNote,
        };
      }
      return {
        ok: true,
        rev: graphRev,
        parentId: committed.parentId,
        wrapped: committed.wrapped,
        groups: builtList.map((b, i) => ({
          name: b.rg.name,
          groupId: committed.groups[i]?.groupId ?? null,
          ids: remapIds(b.built.ids, committed.groups[i]?.idMap ?? {}),
          wired: committed.groups[i]?.wired ?? [],
        })),
        warnings: nextWarnings,
        note:
          `Inserted ${list.length} groups into ${where}. connect applies to the last group only.` +
          wireNote,
      };
    },

    edit_group: ({ groupId, ops, summary, verbosity, dry_run }) => {
      const dryRun = dry_run === true;
      const shell = nodeOrThrow(groupId);
      if (shell.data.defType !== GROUP_TYPE && shell.data.defType !== LAYER_TYPE)
        throw new Error(
          `"${groupId}" is a ${shell.data.defType} — edit_group targets a node-group or layer (get ids from get_graph).`
        );
      if (!Array.isArray(ops) || ops.length === 0)
        throw new Error("Pass `ops` as a non-empty array of edit operations.");
      const nodes = deps.nodesRef.current;
      const edges = deps.edgesRef.current;
      if (!dryRun)
        rememberSpec(
          String(groupId),
          graphToSpec(nodes, edges, String(groupId))
        );
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
      if (errors.length) {
        if (!dryRun)
          logMutation({
            cmd: "edit_group",
            summary: edit.summary,
            status: "error",
            error: errors[0],
            groupId: String(groupId),
            applied: result.applied,
            failed: result.ops.filter((o) => !o.ok).length,
          });
        throw invalid("Edit", errors);
      }
      if (dryRun) {
        // applyRecipeEdit is pure — the patched fragment above was never
        // committed. Report what WOULD happen, `rev` untouched.
        const failed = result.ops.filter((o) => !o.ok);
        return {
          ok: true,
          dry_run: true,
          rev: graphRev,
          valid: true,
          applied: result.applied,
          failed: failed.map((o) => ({
            i: o.i,
            op: o.op,
            error: o.error,
            ...(o.node ? { node: o.node } : {}),
            ...(o.id ? { id: o.id } : {}),
          })),
          // Local ids that add_node / duplicate_node WOULD mint — not live
          // ids; a real call mints fresh ones.
          ...(Object.keys(result.ids).length ? { wouldAdd: Object.keys(result.ids) } : {}),
          warnings,
          note: "Dry run — the patch applies and validates; nothing was committed. Call again without dry_run to commit.",
        };
      }
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
      bumpGraphRev();
      rememberSpec(
        String(groupId),
        graphToSpec(
          deps.nodesRef.current.filter((n) => !fragIds.has(n.id)).concat(committed),
          [
            ...deps.edgesRef.current.filter(
              (e) => !(fragIds.has(e.source) && fragIds.has(e.target))
            ),
            ...result.edges,
          ],
          String(groupId)
        )
      );
      const failed = result.ops.filter((o) => !o.ok);
      logMutation({
        cmd: "edit_group",
        summary: edit.summary,
        status: "ok",
        groupId: String(groupId),
        applied: result.applied,
        failed: failed.length,
      });
      const wantFull = verbosity === "full";
      const addedIds = result.ids;
      if (wantFull) {
        return {
          ok: true,
          rev: graphRev,
          applied: result.applied,
          ops: result.ops,
          ...(Object.keys(addedIds).length ? { ids: addedIds } : {}),
          warnings,
        };
      }
      const duplicated = result.ops
        .filter((o) => o.ok && o.op === "duplicate_node")
        .map((o) => ({
          id: o.id,
          node: o.node,
          ...(o.ids ? { ids: o.ids } : {}),
        }));
      return {
        ok: true,
        rev: graphRev,
        applied: result.applied,
        failed: failed.map((o) => ({
          i: o.i,
          op: o.op,
          error: o.error,
          ...(o.node ? { node: o.node } : {}),
          ...(o.id ? { id: o.id } : {}),
        })),
        ...(duplicated.length ? { duplicated } : {}),
        ...(Object.keys(addedIds).length ? { ids: addedIds } : {}),
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
      // Every successful write is a graph mutation like any other: bump
      // `rev` so get_graph({since}) reports the change instead of
      // "unchanged", and log it so get_recent_edits can confirm it landed.
      const done = <T extends Record<string, unknown>>(result: T, summary: string) => {
        bumpGraphRev();
        logMutation({ cmd: "set_param", summary, status: "ok" });
        return { ...result, rev: graphRev };
      };
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
          return done(
            { ok: true, channel: param, kind, value: r.value },
            `${node.id}.${param} (channel)`
          );
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
            return done(
              { ok: true, param: ctrl.socketName, value: vet.value, group: true },
              `${node.id}.${ctrl.socketName} (group knob)`
            );
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
        } else if (
          (pdef.type === "color_ramp" || pdef.type === "float_curve") &&
          value.trim().startsWith("[")
        ) {
          try {
            coerced = JSON.parse(value);
          } catch {
            /* vetting reports the shape */
          }
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
        return done(
          {
            ok: true,
            ...(minted.length ? { mintedChannels: minted } : {}),
            ...note,
          },
          `${node.id}.${param}`
        );
      }
      deps.onParamChange(String(nodeId), String(param), vet.value);
      deps.flashToast(`Claude: set ${param} on ${node.data.name ?? node.data.defType}`);
      return done({ ok: true, ...note }, `${node.id}.${param}`);
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
            // The easing overlay's normalized shape (CSS cubic-bezier
            // control points), only meaningful on a cubicBezier key.
            ...(k.easingOut === "cubicBezier" && k.bezier
              ? { bezier: [k.bezier.x1, k.bezier.y1, k.bezier.x2, k.bezier.y2] }
              : {}),
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
        bumpGraphRev();
        logMutation({ cmd: "set_keyframes", summary: `${node.id}.${param} cleared`, status: "ok" });
        return { ok: true, cleared: true, rev: graphRev };
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
        if (easing === "cubicBezier")
          throw new Error(
            "cubicBezier is shaped in the tracks editor's easing overlay — pick a preset."
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
      bumpGraphRev();
      logMutation({
        cmd: "set_keyframes",
        summary: `${node.id}.${param} (${block.keyframes.length} keys)`,
        status: "ok",
      });
      return {
        ok: true,
        rev: graphRev,
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

    // ---- graph → GLSL (spec 091626_graph-to-glsl.md) ------------------------
    plan_glsl_translation: ({ target, maxInputs }) => {
      const nodes = deps.nodesRef.current;
      const edges = deps.edgesRef.current;
      const raw = target != null && String(target).trim() ? target : deps.status.selectedNodeId;
      if (!raw)
        throw new Error(
          "Pass `target` (a node id from get_graph) — nothing is selected in the editor."
        );
      const peek = parseNodePeek(raw, nodes);
      const byId = new Map(nodes.map((n) => [n.id, n]));
      // The enclosing group / layer is edit_group's target; zone shells
      // (Repeat / For Each / Iterate) are skipped — their members are
      // listed in the enclosing scope with `parent` set.
      let scopeId: string | undefined = peek.node.data.parentId;
      while (scopeId && isZoneShell(byId.get(scopeId)?.data.defType))
        scopeId = byId.get(scopeId)?.data.parentId;
      const spec = graphToSpec(nodes, edges, scopeId, {
        params: "non_default",
        expressions: "full",
      });
      const fps = deps.fpsRef.current;
      const infoOf = (id: string): PlanNodeInfo | undefined => {
        const n = byId.get(id);
        const def = n ? getNodeDef(n.data.defType) : undefined;
        if (!n || !def) return undefined;
        let ins = def.inputs;
        try {
          ins = def.resolveInputs?.(n.data.params) ?? def.inputs;
        } catch {
          ins = def.inputs;
        }
        ins = withMaskInput(ins, def);
        return {
          inputs: ins.map((i) => ({ name: i.name, type: i.type })),
          primaryOutput: def.primaryOutput ?? undefined,
          auxOutputs: (def.auxOutputs ?? []).map((a) => ({ name: a.name, type: a.type })),
          readsTime: !!def.facts?.reads?.includes("time"),
          simulation: !!def.simulation,
          params: def.params
            .filter((p) => SETTABLE_PARAM_TYPES.has(p.type))
            .map((p) => ({
              name: p.name,
              type: p.type,
              ...(p.min !== undefined ? { min: p.min } : {}),
              ...(p.max !== undefined ? { max: p.max } : {}),
              ...(p.options ? { options: p.options as string[] } : {}),
              default: p.default,
            })),
        };
      };
      const handle = peek.handle === "out:primary" || !peek.handle ? "out" : peek.handle.replace(/^out:/, "");
      return planTranslation({
        nodes: spec.nodes,
        edges: spec.edges,
        target: handle === "out" ? peek.node.id : `${peek.node.id}:${handle}`,
        scopeId: scopeId ?? "root",
        infoOf,
        valuesOf: (id) => byId.get(id)?.data.params ?? {},
        keyframeFramesOf: (id) => {
          const anim = (byId.get(id)?.data.animation ?? {}) as Record<string, KeyframeAnimationBlock>;
          const out: number[] = [];
          for (const block of Object.values(anim)) {
            if (!block?.animated) continue;
            for (const k of block.keyframes) out.push(frameOf(k.tick));
          }
          return out;
        },
        maxInputs: typeof maxInputs === "number" ? maxInputs : undefined,
        frame: Math.round(deps.timeRef.current * fps),
        fps,
        loopFrames: deps.status.loopFrames,
        canvas: { width: deps.status.canvasWidth, height: deps.status.canvasHeight },
      });
    },

    get_glsl_docs: ({ slugs, types }) =>
      getGlslDocs({
        slugs: slugs as string[] | string | undefined,
        types: types as string[] | string | undefined,
      }),

    // Render two nodes at the same frames, tile A | B | |A−B| per frame,
    // and attach numeric parity metrics from a small RGBA8 readback — the
    // oracle the graph → GLSL loop converges on instead of eyeballing two
    // screenshots that live in different tool results.
    compare_renders: async ({ a, b, frames, maxSize, threshold }) => {
      const canvas = deps.canvasRef.current;
      if (!canvas) throw new Error("Preview canvas unavailable.");
      const backend = deps.backendRef.current;
      if (!backend)
        throw new Error("GL backend unavailable — wait for the editor to finish starting.");
      const nodes = deps.nodesRef.current;
      const fps = deps.fpsRef.current;
      const peekA = parseNodePeek(a, nodes);
      const peekB = parseNodePeek(b, nodes);

      let list: number[];
      if (Array.isArray(frames) && frames.length > 0) {
        list = frames.map((f) => Math.max(0, Math.round(Number(f))));
        if (list.some((f) => !Number.isFinite(f)))
          throw new Error("`frames` must be an array of frame numbers.");
      } else {
        list = [Math.round(deps.timeRef.current * fps)];
      }
      if (list.length > 8)
        throw new Error(`compare_renders takes 1–8 frames (got ${list.length}) — use the plan's time.frames.`);
      const thr =
        typeof threshold === "number" && Number.isFinite(threshold) && threshold > 0
          ? Math.min(1, threshold)
          : COMPARE_DEFAULTS.threshold;

      // Analysis readback: small, aspect-preserving. Metrics are for
      // convergence, not pixel-exactness at canvas resolution.
      const ANALYSIS_LONG_EDGE = 256;
      const an = ANALYSIS_LONG_EDGE / Math.max(canvas.width, canvas.height);
      const aw = Math.max(1, Math.round(canvas.width * an));
      const ah = Math.max(1, Math.round(canvas.height * an));

      // Grid: one row per frame, three columns (A, B, heat).
      const cols = 3;
      const rows = list.length;
      const enc = screenshotEncode({ maxSize, format: "jpeg", strip: true });
      const aspect = canvas.width / canvas.height;
      let cellW = Math.floor(Math.min(enc.max / cols, (enc.max / rows) * aspect, canvas.width));
      cellW = Math.max(64, cellW);
      const cellH = Math.max(64, Math.round(cellW / aspect));
      const grid = document.createElement("canvas");
      grid.width = cellW * cols;
      grid.height = cellH * rows;
      const g = grid.getContext("2d")!;
      g.fillStyle = "#000";
      g.fillRect(0, 0, grid.width, grid.height);
      const label = Math.max(10, Math.round(cellH / 18));
      const stamp = (x: number, y: number, text: string) => {
        g.font = `${label}px ui-monospace, monospace`;
        const tw = g.measureText(text).width;
        g.fillStyle = "rgba(0,0,0,0.65)";
        g.fillRect(x, y, tw + label, label * 1.6);
        g.fillStyle = "#fff";
        g.fillText(text, x + label * 0.5, y + label * 1.15);
      };
      const heatCanvas = document.createElement("canvas");
      heatCanvas.width = aw;
      heatCanvas.height = ah;
      const heatCtx = heatCanvas.getContext("2d")!;

      const socketOf = (peek: ReturnType<typeof parseNodePeek>) =>
        !peek.handle || peek.handle === "out:primary" ? "out" : peek.handle.replace(/^out:/, "");
      // Render `peek` at `frame` with it forced as the terminal, blit the
      // canvas into the grid cell, and read its pixels back at analysis
      // size — immediately, before the pool recycles the texture.
      const renderCell = (
        peek: ReturnType<typeof parseNodePeek>,
        frame: number,
        cx: number,
        cy: number,
        tag: string
      ): Uint8ClampedArray => {
        deps.forcedTerminalRef.current = peek.node.id;
        deps.forcedTerminalHandleRef.current = peek.handle ?? null;
        try {
          deps.renderFrame(frame / fps, fps, false);
        } finally {
          deps.forcedTerminalRef.current = null;
          deps.forcedTerminalHandleRef.current = null;
        }
        g.drawImage(canvas, cx, cy, cellW, cellH);
        stamp(cx, cy, `f${frame} ${tag}`);
        const output =
          deps.evalCacheRef.current.get(peek.node.id)?.output ??
          deps.lastEvalOutputsRef.current?.get(peek.node.id);
        const picked = pickInspectSocket(output, socketOf(peek));
        const v = picked.value;
        if (!v || (v.kind !== "image" && v.kind !== "mask"))
          throw new Error(
            `"${peek.node.id}" (${picked.socket}) did not produce an image at frame ${frame} — ${
              v ? `it carries ${v.kind}` : "no evaluated output (disconnected, gated, or a group shell)"
            }.`
          );
        const px = backend.readImagePixels(v as ImageValue, aw, ah);
        if (!px) throw new Error("Could not read pixels back from the GPU.");
        return px;
      };

      const metrics: ({ frame: number } & ReturnType<typeof compareRgba>)[] = [];
      const lines: string[] = [];
      try {
        for (let i = 0; i < list.length; i++) {
          const y = i * cellH;
          const pxA = renderCell(peekA, list[i], 0, y, "A");
          const pxB = renderCell(peekB, list[i], cellW, y, "B");
          const m = compareRgba(pxA, pxB, aw, ah, { threshold: thr });
          metrics.push({ frame: list[i], ...m });
          lines.push(describeMetrics(list[i], m));
          heatCtx.putImageData(new ImageData(diffHeatRgba(pxA, pxB, aw, ah), aw, ah), 0, 0);
          g.imageSmoothingEnabled = false;
          g.drawImage(heatCanvas, cellW * 2, y, cellW, cellH);
          g.imageSmoothingEnabled = true;
          stamp(cellW * 2, y, `f${list[i]} |A−B| ${m.verdict}`);
        }
      } finally {
        if (!deps.playingRef.current)
          deps.renderFrame(deps.timeRef.current, deps.fpsRef.current, false);
      }
      const shader = glslInspectFor(peekB.node, backend) ?? glslInspectFor(peekA.node, backend);
      const verdicts = metrics.map((m) => m.verdict);
      const overall = verdicts.every((v) => v === "match")
        ? "match"
        : verdicts.some((v) => v === "off")
          ? "off"
          : "close";
      const summary = [
        `A = ${peekA.node.id}${peekA.handle ? ` (${socketOf(peekA)})` : ""} · B = ${peekB.node.id}${peekB.handle ? ` (${socketOf(peekB)})` : ""} · analysis ${aw}×${ah} · threshold ${thr}`,
        ...lines,
        `Overall: ${overall.toUpperCase()}. Columns: A | B | |A−B| heat (×4 gain; blue = alpha mismatch). Bands (provisional): match meanAbs≤${COMPARE_DEFAULTS.match.meanAbs} p95≤${COMPARE_DEFAULTS.match.p95Abs}; close meanAbs≤${COMPARE_DEFAULTS.close.meanAbs} p95≤${COMPARE_DEFAULTS.close.p95Abs}.`,
        ...(shader?.error
          ? [
              `GLSL compile failed on ${peekB.node.id} — B is transparent/passthrough, not the shader: ${shader.error}`,
            ]
          : []),
      ].join("\n");
      return {
        kind: "compare",
        mimeType: enc.mimeType,
        base64: await canvasToBase64(grid, enc.mimeType, enc.quality),
        width: grid.width,
        height: grid.height,
        frames: list,
        grid: { cols, rows },
        a: peekA.node.id,
        b: peekB.node.id,
        analysis: { width: aw, height: ah },
        overall,
        metrics,
        summary,
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
