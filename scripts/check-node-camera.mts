// Guards the node-editor camera memory (node-camera-store.ts):
//
//   - keys separate project / comp / scope; root and unsaved get their own
//   - cloud-project cameras persist to localStorage and reload from it;
//     unsaved-project cameras stay in memory only
//   - the stored list is capped, dropping the oldest-written first
//   - bad cameras are rejected on write; corrupt / hostile storage loads
//     as empty rather than throwing
//
// The restore-or-fit decision itself (NodeEditor's applyScopeCamera, the
// visible-node guard) needs a mounted React Flow — a live-app question.
//
//   npx tsx scripts/check-node-camera.mts

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) {
    console.log(`PASS  ${name}`);
  } else {
    failures++;
    console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const storage = new Map<string, string>();
(globalThis as unknown as { window: unknown }).window = {
  localStorage: {
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => void storage.set(k, v),
  },
};
const LS_KEY = "toolbox.nodeCameras";

let fresh = 0;
const load = () =>
  import(`../src/components/effects/node-camera-store.ts?fresh=${fresh++}`) as Promise<
    typeof import("../src/components/effects/node-camera-store.ts")
  >;

{
  const { nodeCameraKey: key } = await load();
  const keys = [
    key("p1", "c1", undefined),
    key("p1", "c1", "g1"),
    key("p1", "c2", "g1"),
    key("p2", "c1", "g1"),
    key(null, "c1", "g1"),
  ];
  check("keys differ across project / comp / scope / unsaved", new Set(keys).size === keys.length);
  check("null and undefined scope both mean root", key("p1", "c1", null) === keys[0]);
}

{
  const store = await load();
  const saved = store.nodeCameraKey("p1", "c1", "g1");
  const unsaved = store.nodeCameraKey(null, "c1", "g1");
  store.setNodeCamera(saved, { x: 10, y: -20, zoom: 0.5 });
  store.setNodeCamera(unsaved, { x: 1, y: 2, zoom: 1 });
  check("round-trips in memory", store.getNodeCamera(saved)?.x === 10);
  check("unsaved round-trips in memory", store.getNodeCamera(unsaved)?.zoom === 1);
  const raw = storage.get(LS_KEY) ?? "";
  check("cloud camera persisted", raw.includes(saved), raw);
  check("unsaved camera not persisted", !raw.includes(unsaved), raw);

  store.setNodeCamera(saved, { x: NaN, y: 0, zoom: 1 });
  store.setNodeCamera(saved, { x: 0, y: 0, zoom: 0 });
  check("non-finite / zero-zoom writes rejected", store.getNodeCamera(saved)?.x === 10);

  const reloaded = await load();
  check("reload restores cloud camera", reloaded.getNodeCamera(saved)?.y === -20);
  check("reload forgets unsaved camera", reloaded.getNodeCamera(unsaved) === undefined);
}

{
  storage.clear();
  const store = await load();
  for (let i = 0; i < 350; i++) {
    store.setNodeCamera(store.nodeCameraKey("p", "c", `g${i}`), { x: i, y: 0, zoom: 1 });
  }
  // Re-writing an old key makes it the newest, so it survives the cap.
  store.setNodeCamera(store.nodeCameraKey("p", "c", "g0"), { x: -1, y: 0, zoom: 1 });
  const list = JSON.parse(storage.get(LS_KEY) ?? "[]") as [string, unknown][];
  check("stored list capped at 300", list.length === 300, String(list.length));
  const reloaded = await load();
  check("oldest-written dropped", reloaded.getNodeCamera(reloaded.nodeCameraKey("p", "c", "g1")) === undefined);
  check("newest kept", reloaded.getNodeCamera(reloaded.nodeCameraKey("p", "c", "g349"))?.x === 349);
  check("rewritten key kept", reloaded.getNodeCamera(reloaded.nodeCameraKey("p", "c", "g0"))?.x === -1);
}

{
  storage.set(LS_KEY, "{not json");
  const a = await load();
  check("corrupt JSON loads as empty", a.getNodeCamera("p:x|c|root") === undefined);
  storage.set(LS_KEY, JSON.stringify([["p:x|c|root", { x: "1", y: 0, zoom: 1 }], "junk", ["p:y|c|root", { x: 3, y: 4, zoom: 2 }]]));
  const b = await load();
  check(
    "malformed entries skipped, valid ones kept",
    b.getNodeCamera("p:x|c|root") === undefined && b.getNodeCamera("p:y|c|root")?.zoom === 2
  );
}

if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nall passed");
