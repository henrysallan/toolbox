import type { Edge, Node } from "@xyflow/react";
import type { NodeDataPayload } from "@/state/graph";
import type {
  AudioFileParamValue,
  PaintParamValue,
  VideoFileParamValue,
} from "@/engine/types";
import type { AnimationMap } from "@/engine/keyframes";
import type { ClipBlock } from "@/engine/clips";
import { getNodeDef } from "@/engine/registry";
import { withMaskInput } from "@/engine/conventions";
import {
  MISSING_MEDIA_SUFFIX,
  readStoredMediaFile,
  type MediaEnvelope,
  type MissingMedia,
} from "@/lib/media-relink";
import { LAYER_TYPE } from "@/engine/groups";
import { makeLayerNodes, newEdgeId } from "@/state/graph-ops";

// Bump when the on-wire shape changes. Load path should branch on this.
//
// v2 — added the optional `scene` block (loop length + fps). Back-
// compat: v1 saves omit `scene`; the deserializer returns
// `scene = undefined` and the caller leaves the user's current
// loop / fps untouched.
//
// v3 — node groups: nodes carry an optional `parentId` (id of the
// enclosing node-group; absent = root scope). Back-compat: v1/v2 saves
// have no parentId, so every node loads at root — exactly the pre-group
// shape. No migration needed in this direction.
//
// v4 — layers: the root scope is a strict chain of layer nodes feeding
// Output. Loading a pre-v4 project auto-wraps its whole graph into
// "Layer 1" (see autoWrapIntoLayer) — a 1-layer project renders
// pixel-identically to the original flat graph. Saving always writes
// the new shape.
export const CURRENT_SCHEMA = 4;

export interface SavedNode {
  id: string;
  defType: string;
  // Group nesting (v3+): id of the enclosing node-group. Absent = root.
  parentId?: string;
  position: { x: number; y: number };
  // Display label. Media-source nodes are auto-named after their file,
  // and users can rename nodes — both must survive save/load. Absent on
  // older saves (load falls back to the def name, or recovers a media
  // node's label from its file envelope).
  name?: string;
  params: Record<string, unknown>;
  exposedParams?: string[];
  // Names of params marked as user-controllable in an exported app. See
  // NodeDataPayload for the runtime shape. Plain JSON, no special handling.
  controlParams?: string[];
  // User-defined slider range overrides — see NodeDataPayload for
  // the runtime shape. Plain JSON, no special handling needed.
  paramOverrides?: Record<
    string,
    { min?: number; max?: number; softMax?: number }
  >;
  // Per-parameter keyframe animation. Plain JSON (numbers, booleans,
  // strings, arrays). Absent on projects saved before keyframes shipped.
  animation?: AnimationMap;
  // Timeline clip windows (in/out + local-time remap). Plain JSON; absent on
  // projects saved before clips shipped, and on non-clippable nodes.
  clips?: ClipBlock[];
  active?: boolean;
  bypassed?: boolean;
}

export interface SavedEdge {
  id: string;
  source: string;
  sourceHandle: string | null;
  target: string;
  targetHandle: string | null;
}

// Scene-level (non-graph) project state. Optional so v1 projects
// load cleanly. Each field is also optional so a project that only
// cares about (say) the loop length doesn't have to carry the rest.
export interface SavedScene {
  // Loop length in frames. `null` means "no loop set" (∞ in the UI).
  // Omitted means "no value saved" — leave the user's current loop
  // alone on load.
  loopFrames?: number | null;
  // Target FPS. Paired with loopFrames since loop time = frames / fps;
  // saving both keeps the loop's *duration* stable even if the
  // project is opened on a machine with a different default FPS.
  fps?: number;
}

export interface SavedProject {
  schemaVersion: number;
  nodes: SavedNode[];
  edges: SavedEdge[];
  scene?: SavedScene;
}

// --- image helpers -------------------------------------------------------

async function bitmapToDataUrl(bmp: ImageBitmap): Promise<string> {
  const canvas = document.createElement("canvas");
  canvas.width = bmp.width;
  canvas.height = bmp.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2d context unavailable");
  ctx.drawImage(bmp, 0, 0);
  return canvas.toDataURL("image/png");
}

async function dataUrlToBitmap(url: string): Promise<ImageBitmap> {
  const resp = await fetch(url);
  const blob = await resp.blob();
  return createImageBitmap(blob);
}

// --- param serialization -------------------------------------------------

// `paint` and `file` params hold live DOM/ImageBitmap references, which JSON
// can't represent. Swap them to data-URL envelopes going out, and resurrect
// the real runtime values coming back.

async function serializeParams(
  defType: string,
  params: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const def = getNodeDef(defType);
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(params)) {
    // Runtime-only "unlinked media" markers never hit the wire directly —
    // the video/audio branches below fold them back into the main key.
    if (key.endsWith(MISSING_MEDIA_SUFFIX)) continue;
    const p = def?.params.find((x) => x.name === key);
    if (!p) {
      out[key] = val;
      continue;
    }
    if (p.type === "paint") {
      const pv = val as PaintParamValue | null;
      if (pv?.canvas instanceof HTMLCanvasElement) {
        out[key] = {
          kind: "paint",
          dataUrl: pv.canvas.toDataURL("image/png"),
        };
      } else {
        out[key] = null;
      }
    } else if (p.type === "file" && val instanceof ImageBitmap) {
      out[key] = { kind: "file", dataUrl: await bitmapToDataUrl(val) };
    } else if (p.type === "font") {
      // FontFace refs don't survive a page reload — drop custom fonts on
      // save. On load the text node falls back to the `font_family` enum.
      out[key] = null;
    } else if (p.type === "video_file") {
      // Live <video> elements + ObjectURLs can't round-trip through JSON.
      // Persist an identity envelope instead so load can auto-relink the
      // local file (stored handle) or prompt a one-click manual relink.
      // A still-unlinked param keeps its parked envelope (marker key) so
      // saving a not-yet-relinked project doesn't forget the file.
      const v = val as VideoFileParamValue | null;
      const marker = params[`${key}${MISSING_MEDIA_SUFFIX}`] as
        | MediaEnvelope
        | undefined;
      out[key] = v?.video
        ? ({
            kind: "video_file",
            filename: v.filename ?? "video",
            size: v.size,
            duration: v.duration,
            width: v.width,
            height: v.height,
          } satisfies MediaEnvelope)
        : marker ?? null;
    } else if (p.type === "audio_file") {
      // Same envelope treatment as video_file.
      const a = val as AudioFileParamValue | null;
      const marker = params[`${key}${MISSING_MEDIA_SUFFIX}`] as
        | MediaEnvelope
        | undefined;
      out[key] = a?.element
        ? ({
            kind: "audio_file",
            filename: a.filename ?? "audio",
            size: a.size,
            duration: a.duration,
          } satisfies MediaEnvelope)
        : marker ?? null;
    } else {
      out[key] = val;
    }
  }
  return out;
}

async function deserializeParams(
  defType: string,
  params: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const def = getNodeDef(defType);
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(params)) {
    const p = def?.params.find((x) => x.name === key);
    if (!p) {
      out[key] = val;
      continue;
    }
    if (p.type === "paint") {
      const envelope = val as { kind?: string; dataUrl?: string } | null;
      if (envelope?.kind === "paint" && envelope.dataUrl) {
        const canvas = document.createElement("canvas");
        const bmp = await dataUrlToBitmap(envelope.dataUrl);
        canvas.width = bmp.width;
        canvas.height = bmp.height;
        canvas.getContext("2d")?.drawImage(bmp, 0, 0);
        const snapshot = await createImageBitmap(canvas);
        out[key] = { canvas, snapshot } satisfies PaintParamValue;
      } else {
        out[key] = null;
      }
    } else if (p.type === "file") {
      const envelope = val as { kind?: string; dataUrl?: string } | null;
      if (envelope?.kind === "file" && envelope.dataUrl) {
        out[key] = await dataUrlToBitmap(envelope.dataUrl);
      } else {
        out[key] = null;
      }
    } else if (p.type === "font") {
      // Always null on load — user re-uploads the custom font if they need it.
      out[key] = null;
    } else if (p.type === "video_file" || p.type === "audio_file") {
      // Saved value is an identity envelope (or null from older saves /
      // empty params). Try the silent relink path first: a stored file
      // handle whose permission grant persisted reads the file with zero
      // clicks. Otherwise park the envelope under a marker key — the
      // relink banner picks it up, and re-saving keeps the reference.
      out[key] = null;
      const env = val as MediaEnvelope | null;
      if (env?.kind === p.type && env.filename) {
        const file = await readStoredMediaFile(env, { allowPrompt: false });
        if (file) {
          try {
            out[key] =
              p.type === "video_file"
                ? await (await import("@/lib/video")).registerVideoFile(file)
                : await (await import("@/lib/audio")).registerAudioFile(file);
          } catch {
            // Corrupt / unreadable file — fall through to the marker.
          }
        }
        if (!out[key]) out[`${key}${MISSING_MEDIA_SUFFIX}`] = env;
      }
    } else {
      out[key] = val;
    }
  }
  return out;
}

// Node label from a file name — extension dropped, mirroring the naming
// EffectsApp applies when a clip is first loaded ("sunset", not
// "sunset.mp4").
function mediaLabel(filename: string): string {
  return filename.replace(/\.[^/.]+$/, "") || filename;
}

// Back-compat label recovery for saves that predate persisted node names:
// video-source nodes were named after their file at load time, so pull the
// label back out of the restored `file` param — or, when the clip is still
// unlinked, its parked missing-media envelope.
function deriveVideoSourceName(
  params: Record<string, unknown>
): string | null {
  const live = params.file as { filename?: string } | null | undefined;
  if (live?.filename) return mediaLabel(live.filename);
  const env = params[`file${MISSING_MEDIA_SUFFIX}`] as
    | MediaEnvelope
    | undefined;
  if (env?.filename) return mediaLabel(env.filename);
  return null;
}

// --- v4 auto-wrap ----------------------------------------------------------

// Wrap a pre-layers graph into "Layer 1": every root node except Output
// and Render Queue moves inside the new layer; the primary Output's
// image (and audio) feeds reroute through the layer's Group Output so
// the layer composites them. Additional Outputs keep their original
// edges — they cross the layer boundary, which the evaluator handles
// fine (edges between real nodes ignore scope); they're just not
// visible in any single editor scope. Renders pixel-identically to the
// unwrapped graph: one normal-mode, full-opacity layer over an empty
// stack.
function autoWrapIntoLayer(
  nodes: Node<NodeDataPayload>[],
  edges: Edge[]
): { nodes: Node<NodeDataPayload>[]; edges: Edge[] } {
  if (nodes.length === 0) return { nodes, edges };
  // Already layered (a v4 file re-passed through, or a hand-built one).
  if (
    nodes.some((n) => n.data.defType === LAYER_TYPE && !n.data.parentId)
  ) {
    return { nodes, edges };
  }
  const staysAtRoot = (n: Node<NodeDataPayload>) =>
    n.data.defType === "output" || n.data.defType === "render-queue";
  const wrapped = nodes.filter((n) => !staysAtRoot(n) && !n.data.parentId);

  const output = nodes.find(
    (n) => n.data.defType === "output" && !n.data.parentId
  );
  const xs = wrapped.map((n) => n.position.x);
  const ys = wrapped.map((n) => n.position.y);
  const minX = xs.length ? Math.min(...xs) : 0;
  const maxX = xs.length ? Math.max(...xs) : 0;
  const avgY = ys.length ? ys.reduce((a, b) => a + b, 0) / ys.length : 0;

  const { layer, groupInput, groupOutput } = makeLayerNodes("Layer 1", {
    x: output ? output.position.x - 380 : maxX + 380,
    y: output ? output.position.y : avgY,
  });
  groupInput.position = { x: minX - 420, y: avgY };
  groupOutput.position = { x: maxX + 420, y: avgY };

  const wrappedIds = new Set(wrapped.map((n) => n.id));
  let nextEdges = edges;
  const added: Edge[] = [];
  if (output) {
    // Reroute the primary Output's image/audio feeds through the layer.
    const intoImage = edges.find(
      (e) => e.target === output.id && e.targetHandle === "in:image"
    );
    const intoAudio = edges.find(
      (e) => e.target === output.id && e.targetHandle === "in:audio"
    );
    nextEdges = edges.map((e) => {
      if (e === intoImage && wrappedIds.has(e.source)) {
        return { ...e, target: groupOutput.id, targetHandle: "in:image" };
      }
      if (e === intoAudio && wrappedIds.has(e.source)) {
        return { ...e, target: groupOutput.id, targetHandle: "in:audio" };
      }
      return e;
    });
    if (intoImage && wrappedIds.has(intoImage.source)) {
      added.push({
        id: newEdgeId(),
        source: layer.id,
        sourceHandle: "out:primary",
        target: output.id,
        targetHandle: "in:image",
      });
    }
    if (intoAudio && wrappedIds.has(intoAudio.source)) {
      added.push({
        id: newEdgeId(),
        source: layer.id,
        sourceHandle: "out:aux:audio",
        target: output.id,
        targetHandle: "in:audio",
      });
    }
  }

  return {
    nodes: [
      ...nodes.map((n) =>
        wrappedIds.has(n.id)
          ? { ...n, data: { ...n.data, parentId: layer.id } }
          : n
      ),
      layer,
      groupInput,
      groupOutput,
    ],
    edges: [...nextEdges, ...added],
  };
}

// --- graph round-trip ----------------------------------------------------

export interface ProgressCallback {
  // Fraction is in [0, 1]. Reported after each node finishes processing, so
  // the caller can drive a progress bar without knowing about the internals.
  (fraction: number): void;
}

export async function serializeGraph(
  nodes: Node<NodeDataPayload>[],
  edges: Edge[],
  onProgress?: ProgressCallback,
  scene?: SavedScene
): Promise<SavedProject> {
  // Sequential (not Promise.all) so progress is monotonic and the main
  // thread isn't thrashed decoding many large paint canvases in parallel.
  const total = Math.max(1, nodes.length);
  const savedNodes: SavedNode[] = [];
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    savedNodes.push({
      id: n.id,
      defType: n.data.defType,
      parentId: n.data.parentId,
      position: { x: n.position.x, y: n.position.y },
      name: n.data.name,
      params: await serializeParams(n.data.defType, n.data.params),
      exposedParams: n.data.exposedParams,
      controlParams: n.data.controlParams,
      paramOverrides: n.data.paramOverrides,
      animation: n.data.animation,
      clips: n.data.clips,
      active: n.data.active,
      bypassed: n.data.bypassed,
    });
    onProgress?.((i + 1) / total);
  }
  const savedEdges: SavedEdge[] = edges.map((e) => ({
    id: e.id,
    source: e.source,
    sourceHandle: e.sourceHandle ?? null,
    target: e.target,
    targetHandle: e.targetHandle ?? null,
  }));
  return {
    schemaVersion: CURRENT_SCHEMA,
    nodes: savedNodes,
    edges: savedEdges,
    // Drop the field entirely if no scene info was provided — keeps
    // the on-disk shape minimal for graph-only callers.
    ...(scene !== undefined ? { scene } : {}),
  };
}

export async function deserializeGraph(
  saved: SavedProject,
  onProgress?: ProgressCallback
): Promise<{
  nodes: Node<NodeDataPayload>[];
  edges: Edge[];
  scene?: SavedScene;
  // Media params that couldn't be silently relinked (no stored handle /
  // permission not persisted). The editor surfaces these in a relink
  // banner; viewers can ignore the field.
  missingMedia: MissingMedia[];
}> {
  const total = Math.max(1, saved.nodes.length);
  const nodes: Node<NodeDataPayload>[] = [];
  const missingMedia: MissingMedia[] = [];
  for (let i = 0; i < saved.nodes.length; i++) {
    const sn = saved.nodes[i];
    const def = getNodeDef(sn.defType);
    const params = await deserializeParams(sn.defType, sn.params);
    for (const [k, v] of Object.entries(params)) {
      if (k.endsWith(MISSING_MEDIA_SUFFIX) && v) {
        missingMedia.push({
          nodeId: sn.id,
          paramName: k.slice(0, -MISSING_MEDIA_SUFFIX.length),
          envelope: v as MediaEnvelope,
        });
      }
    }
    const inputs = def
      ? withMaskInput(def.resolveInputs?.(params) ?? def.inputs, def).map((inp) => ({
          name: inp.name,
          label: inp.label,
          type: inp.type,
          hidden: inp.hidden,
        }))
      : [];
    const auxDefs = def
      ? def.resolveAuxOutputs?.(params) ?? def.auxOutputs
      : [];
    nodes.push({
      id: sn.id,
      type: "effect",
      position: sn.position,
      data: {
        defType: sn.defType,
        parentId: sn.parentId,
        params,
        exposedParams: sn.exposedParams ?? [],
        controlParams: sn.controlParams ?? [],
        paramOverrides: sn.paramOverrides,
        animation: sn.animation,
        clips: sn.clips,
        name:
          sn.name ??
          (sn.defType === "video-source"
            ? deriveVideoSourceName(params)
            : null) ??
          def?.name ??
          sn.defType,
        inputs,
        auxOutputs: auxDefs.map((a) => ({
          name: a.name,
          type: a.type,
          disabled: a.disabled,
        })),
        primaryOutput:
          def?.resolvePrimaryOutput?.(params) ?? def?.primaryOutput ?? null,
        terminal: def?.terminal,
        active: sn.active ?? !!def?.terminal,
        bypassed: sn.bypassed ?? false,
      },
    } satisfies Node<NodeDataPayload>);
    onProgress?.((i + 1) / total);
  }
  const edges: Edge[] = saved.edges.map((se) => ({
    id: se.id,
    source: se.source,
    sourceHandle: se.sourceHandle ?? undefined,
    target: se.target,
    targetHandle: se.targetHandle ?? undefined,
  }));
  // Pre-layers projects wrap into "Layer 1" on load (v4 migration) —
  // done here in the loader so every consumer (editor, live viewer,
  // export) sees the same canonical shape. Saving writes v4.
  if ((saved.schemaVersion ?? 1) < 4) {
    const wrapped = autoWrapIntoLayer(nodes, edges);
    return {
      nodes: wrapped.nodes,
      edges: wrapped.edges,
      scene: saved.scene,
      missingMedia,
    };
  }
  return { nodes, edges, scene: saved.scene, missingMedia };
}

// --- thumbnail -----------------------------------------------------------

// Increment the trailing number on a filename-style string. Preserves the
// digit width of the existing number (so "foo_01" → "foo_02", "foo_99" →
// "foo_100"). No trailing number means we append `_01`.
export function incrementName(name: string): string {
  const trimmed = name.trimEnd();
  const match = trimmed.match(/(\d+)$/);
  if (!match) return `${trimmed}_01`;
  const digits = match[1];
  const next = String(parseInt(digits, 10) + 1).padStart(digits.length, "0");
  return trimmed.slice(0, match.index) + next;
}

export function generateThumbnail(
  canvas: HTMLCanvasElement,
  size = 256
): string | null {
  if (canvas.width === 0 || canvas.height === 0) return null;
  const tmp = document.createElement("canvas");
  const aspect = canvas.width / canvas.height;
  if (aspect >= 1) {
    tmp.width = size;
    tmp.height = Math.max(1, Math.round(size / aspect));
  } else {
    tmp.height = size;
    tmp.width = Math.max(1, Math.round(size * aspect));
  }
  const ctx = tmp.getContext("2d");
  if (!ctx) return null;
  ctx.drawImage(canvas, 0, 0, tmp.width, tmp.height);
  return tmp.toDataURL("image/jpeg", 0.8);
}
