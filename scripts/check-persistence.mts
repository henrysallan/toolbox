// check-persistence: guards the cloud-asset keep-set / prune contract and the
// forward-version schema guard — the persistence trust boundary the v9 specs
// called for but nothing exercised. Pure data (no bitmaps): the asset logic
// works on the serialized JSON graph, so a faked Storage client is enough.
//
//   npx tsx scripts/check-persistence.mts
/* eslint-disable @typescript-eslint/no-explicit-any */
import type { SavedProject } from "@/lib/project";

// Minimal DOM stubs — importing @/lib/project pulls the engine/registry in.
const g = globalThis as any;
const stub = () => ({ getContext: () => null, style: {}, addEventListener() {} });
// Media elements fire their `error` listener on the next tick: the v11
// cloud-media load path awaits loadedmetadata|error on a real element, so
// a listener-swallowing stub would hang deserialize forever. Erroring is
// also the honest offline behavior — it exercises the unreachable-stream
// fallback (park the envelope, keep the ref).
const mediaStub = () => ({
  style: {},
  addEventListener(type: string, cb: () => void) {
    if (type === "error") setTimeout(cb, 0);
  },
  removeEventListener() {},
  removeAttribute() {},
  load() {},
});
g.window ??= g;
g.self ??= g;
g.document ??= {
  createElement: (tag: string) =>
    tag === "video" || tag === "audio" ? mediaStub() : stub(),
  createElementNS: stub,
  fonts: { add() {}, forEach() {} },
  body: { appendChild() {} },
  addEventListener() {},
};
g.navigator ??= { userAgent: "node" };
g.HTMLCanvasElement ??= class {};
g.OffscreenCanvas ??= class { getContext() { return null; } };
g.WebGL2RenderingContext ??= class {};

const {
  uploadGraphAssets,
  resolveAssetRefs,
  pruneProjectAssets,
  PROJECT_ASSETS_BUCKET,
} = await import("@/lib/supabase/project-assets");
const { deserializeGraph, CURRENT_SCHEMA, NewerSchemaError } = await import("@/lib/project");

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

// 1×1 PNG — a real, hashable asset.
const TINY_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const PNG_DATA_URL = `data:image/png;base64,${TINY_PNG}`;

const LOC = { userId: "user1", projectId: "proj1" };
const PREFIX = `${LOC.userId}/${LOC.projectId}`;

// A faked Supabase Storage client backed by an in-memory object set.
function makeFakeSupabase(initial: string[] = []) {
  const store = new Set(initial.map((n) => `${PREFIX}/${n}`));
  const uploads: string[] = [];
  const removes: string[] = [];
  const api: any = {
    from() {
      return api;
    },
    list(prefix: string, opts: { limit: number; offset: number }) {
      const names = [...store]
        .filter((p) => p.startsWith(`${prefix}/`))
        .map((p) => p.slice(prefix.length + 1))
        .filter((n) => !n.includes("/"));
      const page = names.slice(opts.offset, opts.offset + opts.limit);
      return Promise.resolve({ data: page.map((name) => ({ name })), error: null });
    },
    upload(path: string) {
      store.add(path);
      uploads.push(path);
      return Promise.resolve({ error: null });
    },
    getPublicUrl(path: string) {
      return { data: { publicUrl: `https://fake.supabase/${PROJECT_ASSETS_BUCKET}/${path}` } };
    },
    remove(paths: string[]) {
      for (const p of paths) {
        store.delete(p);
        removes.push(p);
      }
      return Promise.resolve({ error: null });
    },
  };
  return { supabase: { storage: api } as any, store, uploads, removes };
}

function graphWith(param: unknown): SavedProject {
  return {
    schemaVersion: CURRENT_SCHEMA,
    nodes: [{ id: "n1", defType: "image-source", position: { x: 0, y: 0 }, params: { image: param } }],
    edges: [],
  } as unknown as SavedProject;
}
const imageParam = (g2: SavedProject) => (g2.nodes[0].params as any).image;

// --- 1. inline data: asset → uploaded, kept, row holds a clean { asset, ext } ref ---
{
  const fake = makeFakeSupabase();
  const res = await uploadGraphAssets(fake.supabase, graphWith({ kind: "file", dataUrl: PNG_DATA_URL }), LOC);
  const ref = imageParam(res.graph);
  check("inline asset uploads + is kept", res.usedStorage && fake.uploads.length === 1 && res.keepFilenames.size === 1);
  check(
    "inline asset row ref is clean (asset+ext, no dataUrl)",
    !!ref.asset && ref.ext === "png" && !("dataUrl" in ref),
    JSON.stringify(ref)
  );
  check("kept filename matches the ref", res.keepFilenames.has(`${ref.asset}.png`));
}

// --- 1b. save/load progress: uploadGraphAssets reports stage starts + per-asset
//         completion, and the pill budget in lib/save-load-progress is monotonic ---
{
  const { saveSerializeReading, saveStageReading, loadStageReading, loadDeserializeReading, LOAD_START } =
    await import("@/lib/save-load-progress");
  // Two media nodes, one asset already in Storage → hash 2 nodes, upload 1.
  const fake = makeFakeSupabase();
  const twoNodes = graphWith({ kind: "file", dataUrl: PNG_DATA_URL });
  twoNodes.nodes.push({
    id: "n2",
    defType: "image-source",
    position: { x: 0, y: 0 },
    // A different data URL (a JPEG) so it hashes to a second asset.
    params: { image: { kind: "file", dataUrl: "data:image/jpeg;base64,/9j/4AAQSkZJRg==" } },
  } as any);
  twoNodes.nodes.push({ id: "n3", defType: "noise", position: { x: 0, y: 0 }, params: { scale: 1 } } as any);
  const first = await uploadGraphAssets(fake.supabase, twoNodes, LOC);
  const [preExisting] = first.keepFilenames;
  fake.uploads.length = 0;
  const fake2 = makeFakeSupabase([preExisting]);
  const events: any[] = [];
  const res = await uploadGraphAssets(fake2.supabase, twoNodes, LOC, (e) => events.push(e));
  const stages = events.map((e) => e.stage);
  check(
    "progress stages run hash → list → upload",
    stages.indexOf("hash") === 0 &&
      stages.indexOf("list") === stages.lastIndexOf("hash") + 1 &&
      stages.indexOf("upload") === stages.indexOf("list") + 1,
    stages.join(",")
  );
  const hash = events.filter((e) => e.stage === "hash");
  check(
    "hash counts only media-bearing nodes",
    hash.every((e) => e.total === 2) && hash.at(-1)?.done === 2 && hash[0].done === 0,
    JSON.stringify(hash)
  );
  const up = events.filter((e) => e.stage === "upload");
  check(
    "upload reports start + one completion for the ONE new asset",
    up.length === 2 && up[0].done === 0 && up[0].total === 1 && up[1].done === 1 && fake2.uploads.length === 1,
    JSON.stringify(up)
  );
  check("progress callback leaves the result intact", res.usedStorage && res.keepFilenames.size === 2);

  // Budget: replay a full save and a full load; readings must never decrease.
  const saveSeq = [
    saveSerializeReading(0),
    saveSerializeReading(0.5),
    saveSerializeReading(1),
    saveStageReading({ stage: "auth" }),
    ...events.map((e) => saveStageReading(e)),
    saveStageReading({ stage: "thumbnail" }),
    saveStageReading({ stage: "row" }),
  ];
  const monotonic = (seq: { progress: number }[]) =>
    seq.every((r, i) => i === 0 || r.progress >= seq[i - 1].progress);
  check("save budget is monotonic", monotonic(saveSeq), saveSeq.map((r) => r.progress.toFixed(2)).join(" "));
  check("save budget ends below 1 before the row write resolves", saveSeq.at(-1)!.progress < 1);
  check(
    "media-free save collapses hash/upload to their end points",
    saveStageReading({ stage: "hash", done: 0, total: 0 }).progress <= saveStageReading({ stage: "list" }).progress &&
      saveStageReading({ stage: "upload", done: 0, total: 0 }).progress <=
        saveStageReading({ stage: "thumbnail" }).progress
  );
  check("save labels name the stage", saveSeq.some((r) => r.label.startsWith("uploading media 1/1")) && saveSeq.at(-1)!.label === "writing project");
  const loadSeq = [
    { progress: LOAD_START },
    loadStageReading({ stage: "row" }),
    loadStageReading({ stage: "meta" }),
    loadDeserializeReading(0),
    loadDeserializeReading(0.5),
    loadDeserializeReading(1),
  ];
  check("load budget is monotonic and ends at 1", monotonic(loadSeq) && loadSeq.at(-1)!.progress === 1);
}

// --- 2. resolveAssetRefs preserves asset/ext (the 1b root cause) ---
{
  const fake = makeFakeSupabase(["HASHY.png"]);
  const resolved = resolveAssetRefs(fake.supabase, graphWith({ kind: "file", asset: "HASHY", ext: "png" }), LOC);
  const p = imageParam(resolved);
  check(
    "resolveAssetRefs keeps asset+ext AND adds the URL",
    p.asset === "HASHY" && p.ext === "png" && typeof p.dataUrl === "string" && p.dataUrl.includes("HASHY.png"),
    JSON.stringify(p)
  );
}

// --- 3. THE 1b REGRESSION: a failed-stream envelope (Storage URL, carrying
//        asset/ext) must be KEPT and re-cleaned, and prune must NOT delete it ---
{
  const fake = makeFakeSupabase(["HASHZ.png"]); // the object is already in Storage
  const failedEnvelope = {
    kind: "file",
    asset: "HASHZ",
    ext: "png",
    dataUrl: `https://fake.supabase/${PROJECT_ASSETS_BUCKET}/${PREFIX}/HASHZ.png`,
  };
  const res = await uploadGraphAssets(fake.supabase, graphWith(failedEnvelope), LOC);
  const ref = imageParam(res.graph);
  check("failed-stream envelope is kept", res.keepFilenames.has("HASHZ.png"));
  check("failed-stream envelope is NOT re-uploaded (no bytes)", fake.uploads.length === 0);
  check(
    "failed-stream envelope re-cleaned to a bare ref",
    ref.asset === "HASHZ" && ref.ext === "png" && !("dataUrl" in ref),
    JSON.stringify(ref)
  );
  // The load-bearing assertion: the prune must spare the still-referenced object.
  await pruneProjectAssets(fake.supabase, LOC, res.keepFilenames, res.existingBefore);
  check("prune spares the still-referenced object", fake.store.has(`${PREFIX}/HASHZ.png`) && fake.removes.length === 0);
}

// --- 4. prune DOES delete a genuinely orphaned object (in the snapshot, not kept) ---
{
  const fake = makeFakeSupabase(["KEEP.png", "ORPHAN.png"]);
  await pruneProjectAssets(
    fake.supabase,
    LOC,
    new Set(["KEEP.png"]),
    new Set(["KEEP.png", "ORPHAN.png"])
  );
  check(
    "prune removes only the orphan",
    fake.store.has(`${PREFIX}/KEEP.png`) && !fake.store.has(`${PREFIX}/ORPHAN.png`) && fake.removes.length === 1
  );
}

// --- 4b. #1c: an asset uploaded by a CONCURRENT save (absent from our
//         pre-upload snapshot) must survive our prune, even though it isn't in
//         our keep-set. The old re-listing prune would have deleted it. ---
{
  // Save 1's world: only A existed at snapshot time; save 1 dropped A (keep
  // empty). Between snapshot and prune, a concurrent save uploaded Z.
  const fake = makeFakeSupabase(["A.png", "Z.png"]); // store as it is at prune time
  const snapshotBefore = new Set(["A.png"]); // what save 1 saw before its uploads
  const keep1 = new Set<string>(); // save 1 references no assets
  await pruneProjectAssets(fake.supabase, LOC, keep1, snapshotBefore);
  check(
    "prune deletes the snapshot orphan (A)",
    !fake.store.has(`${PREFIX}/A.png`)
  );
  check(
    "prune SPARES the concurrently-uploaded asset (Z) absent from the snapshot",
    fake.store.has(`${PREFIX}/Z.png`) && !fake.removes.includes(`${PREFIX}/Z.png`)
  );
}

// --- 6. v11 cloud media refs: survive an unreachable stream, survive a
//        re-save, seed the session registry, and attach on serialize ---
{
  const { registerNode } = await import("@/engine/registry");
  const { serializeGraph } = await import("@/lib/project");
  const { getCloudMediaRef, seedCloudMediaRef } = await import(
    "@/lib/cloud-media-upload"
  );
  const { MEDIA_PUBLIC_BASE } = await import("@/lib/cloud-media");
  registerNode({
    type: "fake-media",
    name: "Fake Media",
    category: "source",
    inputs: [],
    auxOutputs: [],
    primaryOutput: "image",
    params: [
      { name: "file", type: "video_file" },
      { name: "model", type: "model_file" },
    ],
    compute: () => ({}),
  } as any);

  const CLOUD = { hash: "H".repeat(64), ext: "mp4", owner: "owner-1" };
  const MODEL_CLOUD = { hash: "M".repeat(64), ext: "glb", owner: "owner-1" };
  const saved = {
    schemaVersion: CURRENT_SCHEMA,
    nodes: [
      {
        id: "n1",
        defType: "fake-media",
        position: { x: 0, y: 0 },
        params: {
          file: {
            kind: "video_file",
            filename: "clip.mp4",
            size: 123,
            duration: 4,
            cloud: CLOUD,
          },
          model: {
            kind: "model_file",
            filename: "mesh.glb",
            size: 456,
            format: "glb",
            cloud: MODEL_CLOUD,
          },
        },
      },
    ],
    edges: [],
  } as unknown as SavedProject;

  const res = await deserializeGraph(saved);
  const params = res.nodes[0].data.params as any;
  check(
    "cloud video envelope parks with its ref on a failed stream",
    params.file === null &&
      params.file__missingMedia?.cloud?.hash === CLOUD.hash,
    JSON.stringify(params.file__missingMedia ?? null)
  );
  check(
    "cloud ref seeds the session registry on load",
    getCloudMediaRef("clip.mp4", 123)?.hash === CLOUD.hash
  );
  check(
    "cloud model rebuilds a loadable value (URL from the media base)",
    params.model?.url === `${MEDIA_PUBLIC_BASE}/owner-1/${MODEL_CLOUD.hash}.glb` &&
      params.model?.format === "glb",
    JSON.stringify(params.model ?? null)
  );

  // Re-save without ever relinking: the parked video envelope and the
  // rebuilt model value must both keep their refs — losing them here is
  // the silent back-to-relink regression the schema bump guards against.
  const reser = await serializeGraph(res.nodes, res.edges);
  const rp = reser.nodes[0].params as any;
  check(
    "re-save keeps the parked video cloud ref",
    rp.file?.cloud?.hash === CLOUD.hash,
    JSON.stringify(rp.file ?? null)
  );
  check(
    "re-save keeps the model cloud ref",
    rp.model?.cloud?.hash === MODEL_CLOUD.hash,
    JSON.stringify(rp.model ?? null)
  );

  // Save-side attach: a LIVE video value whose file is in the registry
  // serializes with the ref (the upload-completed-then-saved path).
  seedCloudMediaRef("live.mp4", 99, { hash: "L".repeat(64), ext: "mp4", owner: "owner-1" });
  const liveNodes = [
    {
      id: "n2",
      type: "effect",
      position: { x: 0, y: 0 },
      data: {
        defType: "fake-media",
        params: { file: { video: {}, filename: "live.mp4", size: 99 }, model: null },
      },
    },
  ] as any;
  const ser2 = await serializeGraph(liveNodes, []);
  const lp = ser2.nodes[0].params as any;
  check(
    "live video value serializes with its registry ref",
    lp.file?.kind === "video_file" && lp.file?.cloud?.hash === "L".repeat(64),
    JSON.stringify(lp.file ?? null)
  );
}

// --- image/video source offset/zoom → TRS (transform gizmo contract) ---
{
  const zoomBlock = { animated: true, keyframes: [{ tick: 0, value: 2 }] };
  const saved = {
    schemaVersion: CURRENT_SCHEMA,
    nodes: [
      {
        id: "img",
        defType: "image-source",
        position: { x: 0, y: 0 },
        params: { offsetX: 0.25, offsetY: -0.1, zoom: 2 },
        animation: { offsetX: { animated: true }, zoom: zoomBlock },
        exposedParams: ["zoom", "fit"],
      },
      {
        id: "vid",
        defType: "video-source",
        position: { x: 0, y: 0 },
        params: { offsetX: 0.1, zoom: 0.5 },
      },
    ],
    edges: [],
  } as unknown as SavedProject;
  const res = await deserializeGraph(saved);
  const img = res.nodes.find((n) => n.id === "img")!.data;
  const vid = res.nodes.find((n) => n.id === "vid")!.data;
  check(
    "image-source offset/zoom migrates to translate/scale",
    img.params.translateX === 0.25 &&
      img.params.translateY === -0.1 &&
      img.params.scaleX === 2 &&
      img.params.scaleY === 2 &&
      img.params.offsetX === undefined &&
      img.params.zoom === undefined,
    JSON.stringify(img.params)
  );
  check(
    "image-source zoom animation remaps onto scaleX and scaleY",
    (img.animation as any)?.scaleX === zoomBlock &&
      (img.animation as any)?.scaleY === zoomBlock &&
      (img.animation as any)?.offsetX === undefined &&
      (img.animation as any)?.zoom === undefined,
    JSON.stringify(img.animation)
  );
  check(
    "image-source exposed zoom remaps to scaleX/Y",
    JSON.stringify(img.exposedParams) === JSON.stringify(["scaleX", "scaleY", "fit"])
  );
  check(
    "video-source offset/zoom migrates to translate/scale",
    vid.params.translateX === 0.1 &&
      vid.params.scaleX === 0.5 &&
      vid.params.scaleY === 0.5 &&
      vid.params.offsetX === undefined
  );
}

// --- 5. forward-version guard: a newer-schema project is refused, not silently downgraded ---
{
  let threw: unknown = null;
  try {
    await deserializeGraph({ schemaVersion: CURRENT_SCHEMA + 1, nodes: [], edges: [] } as unknown as SavedProject);
  } catch (e) {
    threw = e;
  }
  check("newer schema throws NewerSchemaError", threw instanceof NewerSchemaError, threw ? String((threw as Error).name) : "no throw");
}

// --- 6. wire labels (091526): SavedEdge.label / labelT round-trip; unlabeled
//        wires stay free of the keys (additive field, older builds just drop it) ---
{
  const { serializeGraph } = await import("@/lib/project");
  const node = (id: string) => ({
    id,
    defType: "image-source",
    position: { x: 0, y: 0 },
    params: {},
  });
  const wire = (id: string, extra: Record<string, unknown> = {}) => ({
    id,
    source: "a",
    sourceHandle: "out:primary",
    target: "b",
    targetHandle: "in:image",
    ...extra,
  });
  const saved = {
    schemaVersion: CURRENT_SCHEMA,
    nodes: [node("a"), node("b")],
    edges: [
      wire("e-plain"),
      wire("e-mid", { label: "mask feed" }),
      wire("e-t", { label: "alpha", labelT: 0.25 }),
      wire("e-clamp", { label: "far", labelT: 7 }),
    ],
  } as unknown as SavedProject;
  const res = await deserializeGraph(saved);
  const byId = new Map(res.edges.map((e) => [e.id, e]));
  check("unlabeled wire loads without data", byId.get("e-plain")?.data === undefined);
  check(
    "label without labelT loads at the midpoint",
    byId.get("e-mid")?.data?.label === "mask feed" && byId.get("e-mid")?.data?.labelT === 0.5,
    JSON.stringify(byId.get("e-mid")?.data ?? null)
  );
  check(
    "label keeps its labelT",
    byId.get("e-t")?.data?.label === "alpha" && byId.get("e-t")?.data?.labelT === 0.25
  );
  check("out-of-range labelT clamps on load", byId.get("e-clamp")?.data?.labelT === 1);

  const reser = await serializeGraph(res.nodes, res.edges);
  const sby = new Map(reser.edges.map((e) => [e.id, e]));
  check(
    "re-save keeps label + labelT",
    sby.get("e-t")?.label === "alpha" && sby.get("e-t")?.labelT === 0.25,
    JSON.stringify(sby.get("e-t") ?? null)
  );
  check(
    "re-save omits the default labelT",
    sby.get("e-mid")?.label === "mask feed" && !("labelT" in (sby.get("e-mid") ?? {}))
  );
  check(
    "re-save writes no label keys on an unlabeled wire",
    !("label" in (sby.get("e-plain") ?? {})) && !("labelT" in (sby.get("e-plain") ?? {}))
  );
  // An emptied label (data.label === "") must not be written as a label.
  const emptied = res.edges.map((e) =>
    e.id === "e-t" ? { ...e, data: { label: "", labelT: 0.25 } } : e
  );
  const reser2 = await serializeGraph(res.nodes, emptied);
  check(
    "empty label text serializes as no label",
    !("label" in (reser2.edges.find((e) => e.id === "e-t") ?? {}))
  );
}

if (failures === 0) console.log("\nALL GREEN ✅");
process.exit(failures ? 1 : 0);
