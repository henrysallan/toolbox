import type { Edge, Node } from "@xyflow/react";
import type { NodeDataPayload } from "@/state/graph";
import type {
  AudioFileParamValue,
  FontParamValue,
  ImageSequenceParamValue,
  PaintParamValue,
  VideoFileParamValue,
} from "@/engine/types";
import { DEFAULT_BRUSH_SETTINGS } from "@/engine/types";
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
import { getImageOriginal, registerImageOriginal } from "@/lib/image-bytes";
import {
  bitmapToPngDataUrl,
  blobToDataUrl,
  bufferToDataUrl,
  primeBitmapDataUrl,
  primeBlobDataUrl,
} from "@/lib/data-url";
import { isExrImageValue } from "@/engine/exr";
import { LAYER_TYPE } from "@/engine/groups";
import { FRAME_TYPE, REROUTE_TYPE } from "@/engine/graph-helpers";
import { makeLayerNodes, newEdgeId } from "@/state/graph-ops";
import { FRAME_XY_PROPS, newCompositionId } from "@/state/graph";

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
//
// v7 — Merge per-layer masks: Merge dropped the universal mask input
// (noMaskInput) in favor of one mask socket per image input — `mask:base`
// and `mask:<layerId>`, the matte for that layer. The old universal mask
// blended mix(base, merged, m), which for source-over compositing equals
// matting every layer by m while the base stays un-matted — so loading a
// ≤v6 save fans a Merge's `in:mask` edge out into one `in:mask:<layerId>`
// edge per layer (see deserializeGraph). No param changes.
//
// v8 — EXR stills: Image Source's `file` param can hold an EXR
// (ExrImageParamValue) and serializes it as a `{ kind: "exr", dataUrl }`
// envelope of the ORIGINAL file bytes (the decoded float pixels don't fit
// the PNG envelope; the bytes are the canonical source anyway). The
// `.toolbox` writer extracts it into a binary asset like any dataUrl
// envelope. Older builds don't know the kind and load the param as empty.
// See specdocs/070926_exr-color-pipeline.md.
//
// v9 — cloud asset refs: a media envelope MAY carry `{ asset: <sha256>,
// ext }` instead of `dataUrl`, pointing at a content-addressed object in
// the `project-assets` Storage bucket. The cloud save path
// (lib/supabase/project-assets.ts) extracts inline data-URLs to Storage and
// leaves refs; load rewrites refs back to public Storage URLs BEFORE
// deserialize, so deserializeGraph is unchanged and ≤v8 inline saves load
// untouched (no `asset` field ⇒ no-op). A v9 save may still be fully inline
// (fallback when Storage is unavailable). See
// specdocs/071426_cloud-asset-storage.md.
export const CURRENT_SCHEMA = 9;

// Thrown when a project was saved by a NEWER client than this one. Without
// this guard the load silently drops fields the older client doesn't know,
// and a re-save rewrites the row at the older schema — permanent loss. Under
// v9 it's worse than lossy: the re-save's prune deletes Storage objects only
// the newer envelope shapes referenced. Callers catch this to show a "made
// with a newer version" message instead of proceeding. See
// specdocs/072226_architecture-review.md Tier-1 #1(e).
export class NewerSchemaError extends Error {
  readonly savedVersion: number;
  readonly currentVersion: number;
  constructor(savedVersion: number) {
    super(
      `This project was saved with a newer version of Toolbox ` +
        `(format v${savedVersion}; this build reads up to v${CURRENT_SCHEMA}). ` +
        `Update Toolbox to open it — opening and re-saving here would drop the ` +
        `newer data.`
    );
    this.name = "NewerSchemaError";
    this.savedVersion = savedVersion;
    this.currentVersion = CURRENT_SCHEMA;
  }
}

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
  // User-resized node box (flow px) via the bottom-right grip. Absent ⇒ the
  // node auto-sizes. Additive/optional — old saves simply lack them, so no
  // schema bump. Editor-only; the engine never reads these.
  uiWidth?: number;
  uiHeight?: number;
  // Cosmetic styling + frame membership (right-click tint/bold, Shift+F
  // frames — 073026_node-cosmetics-and-frames.md). Same additive/optional
  // convention as uiWidth; editor-only, engine-blind.
  tint?: string;
  bold?: boolean;
  frameId?: string;
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
  // Tiled editor layout (072726_window-tiling.md M4). ADDITIVE and
  // opaque here — components/effects/layout/model.ts owns the shape
  // (toSavedLayout/fromSavedLayout) and EffectsApp attaches/applies it
  // around serialize/deserialize; this module just carries it. Absent
  // on pre-M4 saves; older builds ignore it (schema stays 9) and drop
  // it on resave, losing only the layout. Live viewer / exported apps
  // never read it.
  layout?: unknown;
}

// --- image helpers -------------------------------------------------------
//
// All bytes→data-URL encoding goes through lib/data-url.ts: native encoders
// cached per source object (Blob/ArrayBuffer/ImageBitmap), so an unchanged
// asset costs ~0ms on every save after the first. See
// specdocs/071426_save-optimization.md.

async function dataUrlToBitmap(url: string): Promise<ImageBitmap> {
  const resp = await fetch(url);
  const blob = await resp.blob();
  return createImageBitmap(blob);
}

// Only genuine data: URLs may seed the Tier-1 encode caches — a v9 asset-ref
// load resolves envelopes to https: Storage URLs, and caching one of those
// as an asset's "data-URL" would make the next save emit a non-`data:`
// string that isInlineAsset rejects, silently dropping the asset from the
// row. On the storage path priming is skipped; the first re-save re-encodes
// to a real data: URL (Tier-1 cache miss) → same content hash → no
// re-upload. See specdocs/071426_cloud-asset-storage.md.
function isDataUrl(url: string): boolean {
  return url.startsWith("data:");
}

// Decode a `{kind:"file"}` image envelope's dataUrl (a `data:` URL from an
// inline/`.toolbox` save, or an `https:` Storage URL from a v9 cloud save)
// to an ImageBitmap. Registers the loaded bytes as the bitmap's originals so
// a re-save round-trips them, and seeds the encode cache for `data:` URLs
// only (a storage URL must not poison the cache — see isDataUrl). Shared by
// the inline load path below and the streamed-media loader in EffectsApp.
export async function decodeImageFileEnvelope(
  dataUrl: string
): Promise<ImageBitmap> {
  const blob = await (await fetch(dataUrl)).blob();
  const bmp = await createImageBitmap(blob);
  registerImageOriginal(bmp, blob);
  if (isDataUrl(dataUrl)) primeBlobDataUrl(blob, dataUrl);
  return bmp;
}

// A media param whose fetch was deferred at load (a v9 Storage-hosted image
// on a `deferRemoteMedia` load). The caller streams these in after the graph
// is interactive and shows a per-node spinner meanwhile. The envelope's
// `dataUrl` is the (https) Storage URL to fetch. `asset`/`ext` ride along
// (resolveAssetRefs preserves them) so that if the stream FAILS and the caller
// puts this envelope back into the param, the next save still recognizes it as
// an asset ref and keeps its Storage object alive. See 072226 audit #1b.
export interface PendingMedia {
  nodeId: string;
  paramName: string;
  envelope: {
    kind?: string;
    dataUrl?: string;
    filename?: string;
    asset?: string;
    ext?: string;
  };
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
  params: Record<string, unknown>,
  // Families already bundled in THIS save (shared across nodes by
  // serializeGraph). Registration is global on load — one bundle per family
  // makes every same-family param resolve — so re-inlining the full TTF per
  // Text node only multiplied row size. Absent (fragment callers): no dedup.
  bundledFamilies?: Set<string>
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
      // Encode from the committed SNAPSHOT bitmap, not the live canvas: the
      // canvas mutates in place, but every mutation path (stroke ticks,
      // fills, resize, undo/redo) mints a fresh snapshot via
      // createImageBitmap — so snapshot identity keys the encode cache and
      // the cached bytes can never go stale. `snapshot: null` only occurs on
      // a freshly-bootstrapped empty canvas — encode it directly (cheap).
      const pv = val as PaintParamValue | null;
      if (pv?.snapshot) {
        out[key] = { kind: "paint", dataUrl: bitmapToPngDataUrl(pv.snapshot) };
      } else if (pv?.canvas instanceof HTMLCanvasElement) {
        out[key] = {
          kind: "paint",
          dataUrl: pv.canvas.toDataURL("image/png"),
        };
      } else {
        out[key] = null;
      }
    } else if (p.type === "file" && val instanceof ImageBitmap) {
      // Prefer the ORIGINAL encoded bytes (registered at import/load) over a
      // PNG re-encode of the decoded bitmap — a camera JPEG re-encoded to
      // PNG inflates ~10×, which is what used to blow cloud rows past the
      // statement timeout. Fallback keeps unregistered bitmaps saving.
      const original = getImageOriginal(val);
      out[key] = {
        kind: "file",
        dataUrl: original
          ? await blobToDataUrl(original, "image/png")
          : bitmapToPngDataUrl(val),
      };
    } else if (p.type === "file" && isExrImageValue(val)) {
      // EXR still (v8): the original bytes ARE the canonical source — float
      // pixels don't fit the PNG envelope, and layers re-derive from the
      // header on load. The `.toolbox` writer extracts the dataUrl into a
      // binary asset; cloud rows inline it.
      out[key] = {
        kind: "exr",
        filename: val.filename,
        dataUrl: await blobToDataUrl(val.blob, "image/x-exr"),
      };
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
              dataUrl: await bufferToDataUrl(buffer, "font/ttf"),
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
      if (family && !bundledFamilies?.has(family)) {
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
            dataUrl: await bufferToDataUrl(buffer, "font/ttf"),
          };
          bundledFamilies?.add(family);
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
  params: Record<string, unknown>,
  // When provided, Storage-hosted (`https:`) image files are NOT fetched
  // here — `onDefer` is called with the envelope and the param is left null,
  // so the caller can stream the image in after the graph is interactive
  // (see PendingMedia). Inline `data:` images always decode synchronously.
  defer?: { onDefer: (paramName: string, envelope: PendingMedia["envelope"]) => void }
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
      out[key] = null;
      if (envelope?.kind === "paint" && envelope.dataUrl) {
        try {
          const canvas = document.createElement("canvas");
          const bmp = await dataUrlToBitmap(envelope.dataUrl);
          canvas.width = bmp.width;
          canvas.height = bmp.height;
          canvas.getContext("2d")?.drawImage(bmp, 0, 0);
          // premultiplyAlpha "none": paint snapshots must be straight-alpha
          // (WebGL ignores the UNPACK premultiply flag for ImageBitmaps; a
          // premultiplied upload double-applies alpha downstream). Matches
          // the editor's snapshot path in paint-editor/PaintOverlay.
          const snapshot = await createImageBitmap(canvas, {
            premultiplyAlpha: "none",
          });
          // Seed the encode cache: an untouched paint layer re-saves the
          // exact bytes it loaded, with no re-encode. (Skipped for storage
          // URLs — see isDataUrl.)
          if (isDataUrl(envelope.dataUrl))
            primeBitmapDataUrl(snapshot, envelope.dataUrl);
          out[key] = { canvas, snapshot } satisfies PaintParamValue;
        } catch (e) {
          // Corrupt/truncated data-URL (e.g. a save cut short by a row-size
          // failure) — degrade to an empty paint layer instead of failing
          // the whole project load.
          console.warn(`[load] unreadable paint data for ${defType}.${key}`, e);
        }
      }
    } else if (p.type === "file") {
      const envelope = val as
        | { kind?: string; dataUrl?: string; filename?: string }
        | null;
      out[key] = null;
      if (envelope?.kind === "file" && envelope.dataUrl) {
        if (defer && !isDataUrl(envelope.dataUrl)) {
          // Storage-hosted image on a streaming load — don't block on the
          // network fetch. The caller streams it in and shows a spinner; the
          // param stays null (renders empty) until it lands.
          defer.onDefer(key, envelope);
        } else {
          try {
            out[key] = await decodeImageFileEnvelope(envelope.dataUrl);
          } catch (e) {
            // Corrupt/truncated image data — load the node without its image
            // (user re-picks) rather than failing the whole project.
            console.warn(`[load] unreadable image data for ${defType}.${key}`, e);
          }
        }
      } else if (envelope?.kind === "exr" && envelope.dataUrl) {
        // EXR still (v8): the envelope carries the original file bytes —
        // rebuild the runtime value by re-parsing the header (dims + layer
        // list re-derive; the layer *selection* lives in its own param).
        try {
          const buf = await (await fetch(envelope.dataUrl)).arrayBuffer();
          const { parseExrHeader, groupExrLayers } = await import(
            "@/engine/exr"
          );
          const header = parseExrHeader(buf);
          const blob = new Blob([buf], { type: "image/x-exr" });
          // Seed the encode cache — EXR originals are often tens of MB, the
          // most expensive thing to re-base64 on every save. (Skipped for
          // storage URLs — see isDataUrl.)
          if (isDataUrl(envelope.dataUrl))
            primeBlobDataUrl(blob, envelope.dataUrl);
          out[key] = {
            kind: "exr",
            blob,
            filename: envelope.filename,
            layers: groupExrLayers(header),
            width: header.parts[0]?.width ?? 0,
            height: header.parts[0]?.height ?? 0,
          } satisfies import("@/engine/types").ExrImageParamValue;
        } catch (e) {
          console.warn(`[load] unreadable EXR data for ${defType}.${key}`, e);
        }
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
  const bundledFamilies = new Set<string>();
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    savedNodes.push({
      id: n.id,
      defType: n.data.defType,
      parentId: n.data.parentId,
      compositionId: n.data.compositionId ?? activeCompositionId,
      position: { x: n.position.x, y: n.position.y },
      name: n.data.name,
      params: await serializeParams(n.data.defType, n.data.params, bundledFamilies),
      exposedParams: n.data.exposedParams,
      controlParams: n.data.controlParams,
      paramOverrides: n.data.paramOverrides,
      animation: n.data.animation,
      clips: n.data.clips,
      active: n.data.active,
      bypassed: n.data.bypassed,
      aiAuthored: n.data.aiAuthored,
      uiWidth: n.data.uiWidth,
      uiHeight: n.data.uiHeight,
      tint: n.data.tint,
      bold: n.data.bold,
      frameId: n.data.frameId,
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
  if (defType === "gaussian-blur" && params.linearize === undefined) {
    // Gaussian Blur merged into the unified Blur node (spec
    // 080226_blur-convolution.md), which filters in linear light by
    // default. That default is correct for new work but would silently
    // restyle every existing project, so legacy nodes pin it off and keep
    // their original look. The premultiplied-alpha fix that shipped in the
    // same node is deliberately NOT migrated — that one is a correctness
    // bug (straight-alpha convolution darkens soft edges), not a taste
    // default, so old projects get the corrected edges.
    params.linearize = false;
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
  if (defType === "fracture") {
    // Fracture merged into Voronoi as its "scatter" source
    // (073026_voronoi-unified.md). Old saves predate the `source` param —
    // compute's fallback default is "lattice", so pin scatter explicitly.
    // The mode enum unified on Voronoi's names: "edges" is "f2-f1".
    if (params.source === undefined) params.source = "scatter";
    if (params.mode === "edges") params.mode = "f2-f1";
  }
  if (defType === "paint") {
    // The paint toolkit (071926_paint-toolkit.md) added bg_mode; new nodes
    // default to "transparent", but old saves composited over the background
    // color — pin them to "color" so they render identically.
    if (params.bg_mode === undefined) params.bg_mode = "color";
    // Atrament's stroke smoothing (`softness`) became the brush blob's
    // `smoothing` field; `erase` became the dock's eraser tool (dropped).
    if (params.brush === undefined && typeof params.softness === "number") {
      params.brush = {
        ...DEFAULT_BRUSH_SETTINGS,
        smoothing: Math.max(0, Math.min(1, params.softness)),
      };
    }
    delete params.softness;
    delete params.erase;
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
  onProgress?: ProgressCallback,
  // `deferRemoteMedia`: don't block the load on Storage-hosted (v9) image
  // fetches — return them in `pendingMedia` for the caller to stream in
  // after the graph is interactive. Off by default, so viewers / `.toolbox`
  // / fragment loads keep their synchronous behavior.
  opts?: { deferRemoteMedia?: boolean }
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
  // Storage-hosted images whose fetch was deferred (only when
  // `deferRemoteMedia` is set). Empty otherwise. The caller streams these in.
  pendingMedia: PendingMedia[];
}> {
  // Forward-version guard: refuse a project from a newer client rather than
  // silently dropping its unknown fields (and, on re-save, pruning the Storage
  // objects only the newer envelope shapes reference). A missing/≤0 version is
  // a legacy save, not a future one — those load through the migrations below.
  const savedVersion = saved.schemaVersion ?? 1;
  if (savedVersion > CURRENT_SCHEMA) throw new NewerSchemaError(savedVersion);

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
  const pendingMedia: PendingMedia[] = [];
  let lastProgressBucket = -1;
  for (let i = 0; i < saved.nodes.length; i++) {
    const sn = saved.nodes[i];
    const def = getNodeDef(sn.defType);
    const params = await deserializeParams(
      sn.defType,
      sn.params,
      opts?.deferRemoteMedia
        ? {
            onDefer: (paramName, envelope) =>
              pendingMedia.push({ nodeId: sn.id, paramName, envelope }),
          }
        : undefined
    );
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
      // Reroutes render as a dot (RerouteNode), frame zones as a shaded
      // rect (FrameNode, with the click-through/drag-handle xyflow props);
      // everything else uses the standard EffectNode chrome. Keyed off the
      // saved defType.
      type:
        sn.defType === REROUTE_TYPE
          ? "reroute"
          : sn.defType === FRAME_TYPE
            ? "frame"
            : "effect",
      ...(sn.defType === FRAME_TYPE ? FRAME_XY_PROPS : {}),
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
        uiWidth: sn.uiWidth,
        uiHeight: sn.uiHeight,
        tint: sn.tint,
        bold: sn.bold,
        frameId: sn.frameId,
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
  // v7 migration: Merge lost its universal mask input in favor of per-layer
  // mask sockets. The old semantics — mix(base, merged, m) — equal matting
  // every layer by m under source-over, so the one old edge fans out into a
  // `in:mask:<layerId>` edge per layer (base stays un-matted: it was visible
  // where m=0 before). A zero-layer Merge's mask edge just drops — it had no
  // visual effect (the merged output WAS the base).
  if ((saved.schemaVersion ?? 1) < 7) {
    const mergeLayersById = new Map(
      saved.nodes
        .filter((n) => n.defType === "merge")
        .map((n) => [
          n.id,
          (n.params?.layers as Array<{ id: string }> | undefined) ?? [],
        ])
    );
    for (let i = edges.length - 1; i >= 0; i--) {
      const e = edges[i];
      if (e.targetHandle !== "in:mask") continue;
      const layers = mergeLayersById.get(e.target);
      if (!layers) continue;
      const fanned = layers.map((l, j) => ({
        ...e,
        id: `${e.id}::mask${j}`,
        targetHandle: `in:mask:${l.id}`,
      }));
      edges.splice(i, 1, ...fanned);
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
    pendingMedia,
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
