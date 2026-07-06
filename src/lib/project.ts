import type { Edge, Node } from "@xyflow/react";
import type { NodeDataPayload } from "@/state/graph";
import type {
  AudioFileParamValue,
  FontParamValue,
  ImageSequenceParamValue,
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
import { newCompositionId } from "@/state/graph";

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
//
// v5 — compositions: a project holds an ordered list of compositions
// (`compositions` + `activeCompositionId`), and every node carries a
// `compositionId`. Each composition owns its own scene (resolution / fps /
// loop). The top-level `scene` is kept as a compat mirror of the *active*
// composition's scene, for readers that render a single project (live
// viewer, export template, the .toolbox manifest) without parsing the
// registry. Loading any save without a `compositions` field (≤v4, or a
// graph-only fragment) synthesizes one "Composition 1" from `scene` and
// tags every node into it — renders identically to the pre-composition
// app. See specdocs/062926_compositions-and-project-view.md.
//
// v6 — Text matte mask: the Text node's `mask` input (a variable-font
// morph driver) was renamed to `morph_mask`, freeing the name `mask` for
// the universal matte mask that withMaskInput appends to every image
// source. Loading a ≤v5 save rewrites Text edges targeting `in:mask` to
// `in:morph_mask` so their font-morph wiring is preserved (see
// deserializeGraph). No param changes.
export const CURRENT_SCHEMA = 6;

export interface SavedNode {
  id: string;
  defType: string;
  // Group nesting (v3+): id of the enclosing node-group. Absent = root.
  parentId?: string;
  // Composition (v5+): id of the composition this node belongs to. Absent
  // on ≤v4 saves — the loader tags every node into the synthesized
  // "Composition 1". See SavedComposition / deserializeGraph.
  compositionId?: string;
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
  // Group was generated/edited by AI — drives the "Edit with AI" star button.
  aiAuthored?: boolean;
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
  // Project render resolution in pixels. Omitted on saves that
  // predate resolution persistence — leave the user's current
  // resolution alone in that case (don't snap to a default).
  width?: number;
  height?: number;
}

// One composition (v5+): an independently-renderable layer graph with its
// own scene settings. A project holds an ordered list of these. The nodes
// belonging to a composition are those whose `compositionId` matches `id`.
export interface SavedComposition {
  id: string;
  name: string;
  // Per-composition render settings (resolution / fps / loop). Optional
  // fields mirror SavedScene; absent ⇒ inherit the app defaults on load.
  scene?: SavedScene;
  // Poster for the Project view, captured from the canvas when a project is
  // saved while this composition is active (a 256px jpeg data-URL). Absent
  // until first saved in that comp.
  thumbnail?: string;
  // Last-edited time (epoch ms) — stamped when the comp is created/duplicated
  // and when the project is saved while this comp is active. Shown in the
  // Project view. Absent on older saves.
  modifiedAt?: number;
}

export interface SavedProject {
  schemaVersion: number;
  // v5+: the project's compositions and which one is active. Absent on
  // ≤v4 saves (the loader synthesizes a single "Composition 1"). An
  // explicitly empty array is honored (a zero-composition project).
  compositions?: SavedComposition[];
  activeCompositionId?: string;
  nodes: SavedNode[];
  edges: SavedEdge[];
  // Compat mirror of the active composition's scene (see the v5 note at
  // CURRENT_SCHEMA). Authoritative per-composition scenes live on
  // `compositions[].scene`.
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

// Base64 data-URL from raw bytes (used to bundle custom-font binaries). The
// `.toolbox` writer extracts any `dataUrl` envelope into a binary asset; the
// cloud row inlines it. Chunked to avoid blowing the call-stack on
// String.fromCharCode(...wholeBuffer) for large files.
function bufferToDataUrl(buffer: ArrayBuffer, mime: string): string {
  const bytes = new Uint8Array(buffer);
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return `data:${mime};base64,${btoa(bin)}`;
}

// Sibling key under a node's params that carries the bundled font bytes for a
// `control:"font"` enum (e.g. `font_family__fontbundle`). The enum value stays
// a plain family string; this envelope rides alongside so an installed local
// font can render on a recipient's machine. Never a runtime param — serialize
// emits it, deserialize consumes it (registers the font) and drops it.
const FONT_FAMILY_BUNDLE_SUFFIX = "__fontbundle";

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
      // Bundle the custom font's bytes if we still hold them (the upload path
      // retains the ArrayBuffer keyed by the synthetic family). The `.toolbox`
      // writer extracts the `dataUrl` into a binary asset; the cloud row
      // inlines it. No retained buffer (a curated family, or a font loaded
      // from a pre-bundling save) ⇒ drop, falling back to the family enum.
      const fv = val as FontParamValue | null;
      const buffer = fv?.family
        ? (await import("@/lib/fonts")).getCustomFontBuffer(fv.family)
        : undefined;
      out[key] =
        fv && buffer
          ? {
              kind: "font",
              family: fv.family,
              filename: fv.filename,
              axes: fv.axes,
              dataUrl: bufferToDataUrl(buffer, "font/ttf"),
            }
          : null;
    } else if (p.type === "enum" && p.control === "font") {
      // Font-family picker. The value stays a plain family string (back-compat
      // with the old enum). For PORTABILITY we also bundle the font's bytes
      // when we can read them — an installed local font won't render on a
      // recipient's machine, so we embed it under a sibling bundle key.
      // Curated/web families resolve by name everywhere, so they get no bundle
      // (getCustomFontBuffer/isLocalFamily both miss). Best-effort: a font whose
      // bytes are unreadable (sandboxed/commercial) falls back to name-reference.
      out[key] = val;
      const family = typeof val === "string" ? val : "";
      if (family) {
        const fontsMod = await import("@/lib/fonts");
        // Already-registered bytes (uploaded, or re-registered from a prior
        // bundle on load) take the cheap path; otherwise read the installed
        // font's bytes via the Local Font Access API.
        let buffer: ArrayBuffer | undefined = fontsMod.getCustomFontBuffer(family);
        if (!buffer && fontsMod.isLocalFamily(family)) {
          const bytes = await (
            await import("@/lib/local-fonts")
          ).getLocalFontBytes(family);
          buffer = bytes ?? undefined;
        }
        if (buffer) {
          out[`${key}${FONT_FAMILY_BUNDLE_SUFFIX}`] = {
            kind: "font",
            family,
            dataUrl: bufferToDataUrl(buffer, "font/ttf"),
          };
        }
      }
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
    } else if (p.type === "model_file") {
      // The live ObjectURL can't round-trip; persist a lightweight envelope
      // (filename/size/format) so the panel can show the name and the user
      // re-picks on load. No relink yet.
      const m = val as
        | import("@/engine/types").ModelFileParamValue
        | null;
      out[key] = m?.url
        ? { kind: "model_file", filename: m.filename, size: m.size, format: m.format }
        : null;
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
    } else if (p.type === "image_sequence") {
      // Encoded frame blobs can't round-trip through JSON and a sequence can
      // be large, so persist only a lightweight descriptor (per-frame
      // number/filename/size + dims). The frames relink on load — the
      // multi-file re-pick UI is a follow-up, so for now load resolves this
      // to null and the user re-picks in the panel. Keeping the descriptor
      // leaves a record for that future relink path.
      // See specdocs/061826_gif-export-and-image-sequence.md.
      const sv = val as ImageSequenceParamValue | null;
      out[key] = sv?.frames?.length
        ? {
            kind: "image_sequence",
            min: sv.min,
            max: sv.max,
            width: sv.width,
            height: sv.height,
            frames: sv.frames.map((f) => ({
              number: f.number,
              filename: f.filename,
              size: f.size,
            })),
          }
        : null;
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
    // Font-family byte bundle (sibling of a `control:"font"` enum). Register
    // the font under its saved family so the plain family string resolves
    // identically on this machine, then drop it — it's never a runtime param.
    if (key.endsWith(FONT_FAMILY_BUNDLE_SUFFIX)) {
      const env = val as { dataUrl?: string; family?: string } | null;
      if (env?.dataUrl && env.family) {
        try {
          const buffer = await (await fetch(env.dataUrl)).arrayBuffer();
          const { registerCustomFontFromBuffer } = await import("@/lib/fonts");
          await registerCustomFontFromBuffer(buffer, { family: env.family });
        } catch {
          // Unreadable bundle — the family falls back to name-reference.
        }
      }
      continue;
    }
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
      // Restore a bundled custom font (v5 / assets): decode the bytes and
      // re-register under the saved family so the Text param resolves
      // identically. Pre-bundling saves stored `null` ⇒ fall back to the
      // family enum (unchanged).
      const env = val as
        | { kind?: string; dataUrl?: string; family?: string; filename?: string }
        | null;
      out[key] = null;
      if (env?.kind === "font" && env.dataUrl) {
        try {
          const buffer = await (await fetch(env.dataUrl)).arrayBuffer();
          const { registerCustomFontFromBuffer } = await import("@/lib/fonts");
          out[key] = await registerCustomFontFromBuffer(buffer, {
            family: env.family,
            filename: env.filename,
          });
        } catch {
          // Corrupt/unreadable font — leave null (falls back to the enum).
        }
      }
    } else if (p.type === "image_sequence") {
      // Descriptor only — the encoded frames don't persist. Until the
      // multi-file relink re-pick UI lands, a saved sequence loads empty and
      // is re-picked from the panel (session-only across reloads).
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
  scene?: SavedScene,
  // Composition registry (v5). Callers that manage compositions pass them
  // here; graph-only / legacy callers omit it and get a single synthesized
  // "Composition 1" (see below). `scene` above is the active composition's
  // scene — kept as a top-level compat mirror.
  opts?: {
    compositions?: SavedComposition[];
    activeCompositionId?: string;
  }
): Promise<SavedProject> {
  // Resolve the composition registry up front so every node can be tagged.
  // Synthesize one only when the caller supplies no registry at all (a
  // provided array — even empty — is honored, so a zero-composition project
  // stays legal). When synthesizing, reuse an id the nodes already carry (a
  // loaded v5 project round-tripping) so node tags stay consistent across
  // save/load even before the editor tracks the registry itself.
  let compositions = opts?.compositions;
  let activeCompositionId = opts?.activeCompositionId;
  if (!compositions) {
    const existingId = nodes.find((n) => n.data.compositionId)?.data
      .compositionId;
    const id = activeCompositionId ?? existingId ?? newCompositionId();
    compositions = [{ id, name: "Composition 1", scene }];
    activeCompositionId = id;
  }
  activeCompositionId = activeCompositionId ?? compositions[0]?.id;
  // Compat mirror: the active composition's scene at the top level.
  const activeScene =
    compositions.find((c) => c.id === activeCompositionId)?.scene ?? scene;

  // Sequential (not Promise.all) so progress is monotonic and the main
  // thread isn't thrashed decoding many large paint canvases in parallel.
  const total = Math.max(1, nodes.length);
  const savedNodes: SavedNode[] = [];
  // Throttle progress to coarse buckets. The callback typically does a React
  // setState; firing it once per node on a large graph floods React's update
  // queue inside this tight async loop and trips "Maximum update depth
  // exceeded" (→ the save throws). ~5% buckets cap it at ≤21 calls.
  let lastBucket = -1;
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    savedNodes.push({
      id: n.id,
      defType: n.data.defType,
      parentId: n.data.parentId,
      compositionId: n.data.compositionId ?? activeCompositionId,
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
      aiAuthored: n.data.aiAuthored,
    });
    const bucket = Math.floor(((i + 1) / total) * 20);
    if (bucket !== lastBucket) {
      lastBucket = bucket;
      onProgress?.((i + 1) / total);
    }
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
    compositions,
    activeCompositionId,
    nodes: savedNodes,
    edges: savedEdges,
    // Top-level compat mirror of the active composition's scene. Dropped
    // when there's no scene info, keeping the shape minimal for graph-only
    // callers (the authoritative per-comp scenes live on `compositions`).
    ...(activeScene !== undefined ? { scene: activeScene } : {}),
  };
}

// Per-node param back-compat fix-ups applied after media deserialization.
// Distinct from a schema bump: these are additive param introductions where
// the new params can be derived from the old ones, so old saves keep their
// look without a version gate. Mutates `params` in place.
function migrateLoadedParams(
  defType: string,
  params: Record<string, unknown>
): void {
  if (defType === "gradient" && params.start_x === undefined) {
    // Linear gradient gained start/end handle endpoints (replacing the
    // angle-only control). Seed them from the legacy `angle` so the gradient
    // renders identically: start/end straddle the canvas centre along the
    // angle direction (UV, Y-up), which reproduces the old
    // t = dot(uv - 0.5, dir) + 0.5 projection exactly.
    const angleDeg = typeof params.angle === "number" ? params.angle : 0;
    const rad = (angleDeg * Math.PI) / 180;
    const dx = Math.cos(rad);
    const dy = Math.sin(rad);
    params.start_x = 0.5 - 0.5 * dx;
    params.start_y = 0.5 - 0.5 * dy;
    params.end_x = 0.5 + 0.5 * dx;
    params.end_y = 0.5 + 0.5 * dy;
  }
  if (defType === "scene-time" && params.rate === undefined) {
    // Ping-pong speed switched from `period` (half-cycle, i.e. min→max time, in
    // the selected unit) to `rate` (full min→max→min cycles per unit). A full
    // cycle is 2·period, so rate = 1 / (2·period). Applies regardless of mode
    // (period was only used by ping-pong; harmless otherwise).
    const period = typeof params.period === "number" ? params.period : 2;
    params.rate = period > 0 ? 1 / (2 * period) : 0.25;
    delete params.period;
    if (params.mode === "pingpong") {
      // Ping-pong no longer applies the global scale/offset; `amplitude` (a
      // swing multiplier around the range centre) replaces the old `scale`.
      // Old output was `(lo + t·span)·scale + offset` — a linear remap of the
      // ramp — so fold scale/offset into min/max to preserve it exactly, set
      // amplitude 1, and neutralize scale/offset (so switching to a scale-using
      // mode later starts clean). Correct for any easing: the fold is a linear
      // remap of the (possibly eased) ramp, which easing doesn't disturb.
      const scale = typeof params.scale === "number" ? params.scale : 1;
      const offset = typeof params.offset === "number" ? params.offset : 0;
      const lo = typeof params.min === "number" ? params.min : 0;
      const hi = typeof params.max === "number" ? params.max : 1;
      params.min = lo * scale + offset;
      params.max = hi * scale + offset;
      params.amplitude = 1;
      params.scale = 1;
      params.offset = 0;
    }
  }
  if (
    defType === "output" &&
    params.startFrame === undefined &&
    typeof params.videoFrames === "number"
  ) {
    // The Output node replaced the single "Duration (frames)" param
    // (`videoFrames`) with an explicit start/end frame range. Old saves
    // started at frame 0 and ran for `videoFrames` frames — half-open
    // [0, videoFrames) — so seed start/end to reproduce that exactly.
    params.startFrame = 0;
    params.endFrame = params.videoFrames;
  }
}

export async function deserializeGraph(
  saved: SavedProject,
  onProgress?: ProgressCallback
): Promise<{
  nodes: Node<NodeDataPayload>[];
  edges: Edge[];
  scene?: SavedScene;
  // Composition registry (v5). Always populated: ≤v4 / fieldless saves get
  // a synthesized single "Composition 1". `scene` above mirrors the active
  // composition's scene for callers that don't manage the registry.
  compositions: SavedComposition[];
  activeCompositionId: string;
  // Media params that couldn't be silently relinked (no stored handle /
  // permission not persisted). The editor surfaces these in a relink
  // banner; viewers can ignore the field.
  missingMedia: MissingMedia[];
}> {
  // Resolve the composition registry up front so every node can be tagged
  // into the right composition. A present `compositions` array (even empty)
  // is authoritative; its absence means a ≤v4 / graph-only save, which
  // collapses into one "Composition 1" built from the project-level scene.
  let compositions: SavedComposition[];
  let activeCompositionId: string;
  if (Array.isArray(saved.compositions)) {
    compositions = saved.compositions;
    activeCompositionId =
      saved.activeCompositionId ?? compositions[0]?.id ?? "";
  } else {
    const id = newCompositionId();
    compositions = [{ id, name: "Composition 1", scene: saved.scene }];
    activeCompositionId = id;
  }
  const activeScene =
    compositions.find((c) => c.id === activeCompositionId)?.scene ??
    saved.scene;

  const total = Math.max(1, saved.nodes.length);
  const nodes: Node<NodeDataPayload>[] = [];
  const missingMedia: MissingMedia[] = [];
  let lastProgressBucket = -1;
  for (let i = 0; i < saved.nodes.length; i++) {
    const sn = saved.nodes[i];
    const def = getNodeDef(sn.defType);
    const params = await deserializeParams(sn.defType, sn.params);
    migrateLoadedParams(sn.defType, params);
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
        compositionId: sn.compositionId ?? activeCompositionId,
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
          label: a.label,
          type: a.type,
          disabled: a.disabled,
        })),
        primaryOutput:
          def?.resolvePrimaryOutput?.(params) ?? def?.primaryOutput ?? null,
        terminal: def?.terminal,
        active: sn.active ?? !!def?.terminal,
        bypassed: sn.bypassed ?? false,
        aiAuthored: sn.aiAuthored,
      },
    } satisfies Node<NodeDataPayload>);
    // Throttle to ~5% buckets — same React update-depth guard as serialize.
    const bucket = Math.floor(((i + 1) / total) * 20);
    if (bucket !== lastProgressBucket) {
      lastProgressBucket = bucket;
      onProgress?.((i + 1) / total);
    }
  }
  const edges: Edge[] = saved.edges.map((se) => ({
    id: se.id,
    source: se.source,
    sourceHandle: se.sourceHandle ?? undefined,
    target: se.target,
    targetHandle: se.targetHandle ?? undefined,
  }));
  // v6 migration: Text's `mask` input (font-morph driver) became
  // `morph_mask` so the name `mask` is now the universal matte. A ≤v5 save's
  // `in:mask` edges into a Text node were morph wiring — rewrite them to
  // `in:morph_mask` so they keep driving the font morph and don't silently
  // become matte masks. Gated on the schema version so a fresh v6 save's real
  // matte edges (`in:mask`) are left untouched.
  if ((saved.schemaVersion ?? 1) < 6) {
    const textNodeIds = new Set(
      saved.nodes.filter((n) => n.defType === "text").map((n) => n.id)
    );
    for (const e of edges) {
      if (e.targetHandle === "in:mask" && textNodeIds.has(e.target)) {
        e.targetHandle = "in:morph_mask";
      }
    }
  }
  // Pre-layers projects wrap into "Layer 1" on load (v4 migration) —
  // done here in the loader so every consumer (editor, live viewer,
  // export) sees the same canonical shape. Saving writes the current shape.
  let finalNodes = nodes;
  let finalEdges = edges;
  if ((saved.schemaVersion ?? 1) < 4) {
    const wrapped = autoWrapIntoLayer(nodes, edges);
    finalNodes = wrapped.nodes;
    finalEdges = wrapped.edges;
  }
  // Tag any node the loop didn't cover — the layer/boundary nodes minted by
  // autoWrap — into the active composition (the only one for ≤v4 saves).
  for (const n of finalNodes) {
    if (!n.data.compositionId) n.data.compositionId = activeCompositionId;
  }
  return {
    nodes: finalNodes,
    edges: finalEdges,
    scene: activeScene,
    compositions,
    activeCompositionId,
    missingMedia,
  };
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
