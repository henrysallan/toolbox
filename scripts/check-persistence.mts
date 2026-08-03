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
g.window ??= g;
g.self ??= g;
g.document ??= { createElement: stub, createElementNS: stub, fonts: { add() {}, forEach() {} }, body: { appendChild() {} }, addEventListener() {} };
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

if (failures === 0) console.log("\nALL GREEN ✅");
process.exit(failures ? 1 : 0);
