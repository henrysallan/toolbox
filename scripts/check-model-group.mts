// check-model-group: guards the GLB scene-group expansion's pure seam
// (081626_glb-scene-import.md §2) — the shouldExpandModel rule (a single
// bare mesh must NOT expand; lights/cameras-only must), socket-name
// sanitize/dedup (names become handle ids, so ":" cannot survive),
// per-object node params (shared model ref IDENTITY, object token, world
// TRS baked in DEGREES, shear fallback to defaults), the base-color
// texture chain wiring, and structural sanity of the emitted fragment
// (boundary sockets ↔ group interface ↔ edges all agree).
//
//   npx tsx scripts/check-model-group.mts
/* eslint-disable @typescript-eslint/no-explicit-any */

const g = globalThis as any;
const stub = () => ({ getContext: () => null, style: {}, addEventListener() {} });
g.window ??= g;
g.self ??= g;
g.document ??= { createElement: stub, createElementNS: stub, fonts: { add() {}, forEach() {} }, body: { appendChild() {} }, addEventListener() {} };
g.navigator ??= { userAgent: "node" };
g.HTMLCanvasElement ??= class {};
g.OffscreenCanvas ??= class { getContext() { return null; } };
g.WebGL2RenderingContext ??= class {};

const { registerAllNodes } = await import("@/nodes/index");
registerAllNodes(); // the builder mints nodes via the registry
const { shouldExpandModel, modelGroupFragment } = await import(
  "@/state/model-group-fragment"
);
const { GROUP_TYPE, GROUP_INPUT_TYPE, GROUP_OUTPUT_TYPE, readGroupInterface } =
  await import("@/engine/groups");

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const TRS = {
  position: [1, 2, 3] as [number, number, number],
  rotationEuler: [0, Math.PI / 2, 0] as [number, number, number],
  scale: [1, 1, 2] as [number, number, number],
};

const obj = (index: number, name: string, over: any = {}): any => ({
  index,
  name,
  label: name.trim() || `Mesh ${index + 1}`,
  meshCount: 1,
  trs: TRS,
  hasBaseColorTex: false,
  seed: null,
  ...over,
});

const light = (name: string, over: any = {}): any => ({
  kind: "spot",
  name,
  label: name.trim() || "Light 1",
  color: "#ffaa00",
  intensity: 7,
  position: [0, 4, 0],
  target: [0, 3, 0.5],
  angleDeg: 30,
  penumbra: 0.5,
  distance: 12,
  ...over,
});

const camera = (name: string, over: any = {}): any => ({
  name,
  label: name.trim() || "Camera 1",
  projection: "perspective",
  fov: 35,
  near: 0.2,
  far: 500,
  position: [4, 3, 4],
  target: [0, 1, 0],
  ...over,
});

const idx = (over: any = {}): any => ({
  format: "glb",
  objects: [],
  lights: [],
  cameras: [],
  ...over,
});

const MODEL: any = { filename: "rig.glb", size: 123, format: "glb", url: "blob:x" };

// --- shouldExpandModel ------------------------------------------------

check(
  "expand: single bare mesh stays plain",
  !shouldExpandModel(idx({ objects: [obj(0, "Body")] }))
);
check(
  "expand: two objects expand",
  shouldExpandModel(idx({ objects: [obj(0, "A"), obj(1, "B")] }))
);
check(
  "expand: single mesh + light expands",
  shouldExpandModel(idx({ objects: [obj(0, "A")], lights: [light("Key")] }))
);
check(
  "expand: camera-only expands",
  shouldExpandModel(idx({ cameras: [camera("Cam")] }))
);
check(
  "expand: obj format never expands",
  !shouldExpandModel(idx({ format: "obj", objects: [obj(0, "A"), obj(1, "B")] }))
);
check(
  "expand: stl never expands",
  !shouldExpandModel(idx({ format: "stl", objects: [obj(0, "A"), obj(1, "B")] }))
);

// --- fragment structure ----------------------------------------------

const scene = idx({
  objects: [obj(0, "Body"), obj(3, "Wheels", { trs: null })],
  lights: [light("Key")],
  cameras: [camera("Main Cam")],
});
const frag = modelGroupFragment({ index: scene, model: MODEL, name: "rig" });

const byType = (t: string) => frag.nodes.filter((n: any) => n.data.defType === t);
const group: any = byType(GROUP_TYPE)[0];
const groupOut: any = byType(GROUP_OUTPUT_TYPE)[0];
const imports: any[] = byType("import-3d");
const lights: any[] = byType("light-3d");
const cams: any[] = byType("camera-3d");

check("frag: one group shell", !!group && byType(GROUP_TYPE).length === 1);
check("frag: boundary nodes", byType(GROUP_INPUT_TYPE).length === 1 && !!groupOut);
check("frag: node counts", imports.length === 2 && lights.length === 1 && cams.length === 1);
check(
  "frag: interiors parented to shell",
  frag.nodes
    .filter((n: any) => n.id !== group.id)
    .every((n: any) => n.data.parentId === group.id)
);

const iface = readGroupInterface(group.data.params);
check("frag: no data inputs", iface.inputs.length === 0);
check(
  "frag: interface outputs",
  JSON.stringify(iface.outputs) ===
    JSON.stringify([
      { name: "Body", type: "geometry" },
      { name: "Wheels", type: "geometry" },
      { name: "Key", type: "object3d" },
      { name: "Main Cam", type: "camera" },
    ]),
  JSON.stringify(iface.outputs)
);

const body = imports.find((n) => n.data.params.object === "top:0");
const wheels = imports.find((n) => n.data.params.object === "top:3");
check("frag: object tokens use scene indices", !!body && !!wheels);
check(
  "frag: model ref shared by IDENTITY",
  imports.every((n) => n.data.params.model === MODEL)
);
check(
  "frag: TRS baked, rotation in degrees",
  body.data.params.pos_y === 2 &&
    Math.abs(body.data.params.rot_y - 90) < 1e-9 &&
    body.data.params.scale_z === 2
);
check(
  "frag: shear fallback keeps default pose",
  wheels.data.params.pos_x === 0 &&
    wheels.data.params.rot_y === 0 &&
    wheels.data.params.scale_z === 1
);

const lt = lights[0];
check(
  "frag: light baked",
  lt.data.params.type === "spot" &&
    lt.data.params.intensity === 7 &&
    lt.data.params.target_z === 0.5 &&
    lt.data.params.angle === 30
);
const cam = cams[0];
check(
  "frag: camera baked",
  cam.data.params.projection === "perspective" &&
    cam.data.params.fov === 35 &&
    cam.data.params.target_y === 1 &&
    cam.data.params.far === 500
);

const outEdges = frag.edges.filter((e: any) => e.target === groupOut.id);
check(
  "frag: every interface output wired into Group Output",
  iface.outputs.every((o: any) =>
    outEdges.some((e: any) => e.targetHandle === `in:${o.name}`)
  )
);
check(
  "frag: output edges source existing interiors",
  outEdges.every((e: any) => frag.nodes.some((n: any) => n.id === e.source))
);

// --- naming ----------------------------------------------------------

const dupFrag = modelGroupFragment({
  index: idx({ objects: [obj(0, "Body"), obj(1, "Body"), obj(2, "A:B")] }),
  model: MODEL,
  name: "dup",
});
const dupIface = readGroupInterface(
  (dupFrag.nodes.find((n: any) => n.data.defType === GROUP_TYPE) as any).data
    .params
);
check(
  "names: dedup + sanitize",
  JSON.stringify(dupIface.outputs.map((o: any) => o.name)) ===
    JSON.stringify(["Body", "Body 2", "A B"]),
  JSON.stringify(dupIface.outputs.map((o: any) => o.name))
);

const anonFrag = modelGroupFragment({
  index: idx({ objects: [obj(0, ""), obj(1, "  ")] }),
  model: MODEL,
  name: "anon",
});
const anonIface = readGroupInterface(
  (anonFrag.nodes.find((n: any) => n.data.defType === GROUP_TYPE) as any).data
    .params
);
check(
  "names: empty names fall back to labels",
  JSON.stringify(anonIface.outputs.map((o: any) => o.name)) ===
    JSON.stringify(["Mesh 1", "Mesh 2"]),
  JSON.stringify(anonIface.outputs.map((o: any) => o.name))
);

// --- base-color texture chain ----------------------------------------

const bmp: any = {};
const texScene = idx({
  objects: [
    obj(0, "Skin", {
      hasBaseColorTex: true,
      seed: { baseColor: "#804020", roughness: 0.7, metalness: 0.1 },
    }),
    obj(1, "Plain"),
  ],
});
const texFrag = modelGroupFragment({
  index: texScene,
  model: MODEL,
  name: "tex",
  baseColorMaps: new Map([[0, bmp]]),
});
const texImports: any[] = texFrag.nodes.filter(
  (n: any) => n.data.defType === "import-3d"
);
const texImgs: any[] = texFrag.nodes.filter(
  (n: any) => n.data.defType === "image-source"
);
const texMats: any[] = texFrag.nodes.filter(
  (n: any) => n.data.defType === "material-3d"
);
check(
  "tex: one chain for the textured object only",
  texImports.length === 2 && texImgs.length === 1 && texMats.length === 1
);
check("tex: bitmap landed on Image Source", texImgs[0]?.data.params.file === bmp);
check(
  "tex: material re-seeded from the file",
  texMats[0]?.data.params.base_color === "#804020" &&
    texMats[0]?.data.params.roughness === 0.7
);
const skin = texImports.find((n) => n.data.params.object === "top:0");
check(
  "tex: mesh routed through Material",
  texFrag.edges.some(
    (e: any) =>
      e.source === skin.id &&
      e.target === texMats[0].id &&
      e.targetHandle === "in:geometry"
  ) &&
    texFrag.edges.some(
      (e: any) =>
        e.source === texImgs[0].id &&
        e.target === texMats[0].id &&
        e.targetHandle === "in:base_color_map"
    )
);
const texIface = readGroupInterface(
  (texFrag.nodes.find((n: any) => n.data.defType === GROUP_TYPE) as any).data
    .params
);
const texOutEdge = texFrag.edges.find(
  (e: any) => e.targetHandle === "in:Skin"
);
check(
  "tex: Skin socket fed by the Material node",
  texIface.outputs[0]?.name === "Skin" && texOutEdge?.source === texMats[0].id
);

console.log(
  failures === 0
    ? "\ncheck-model-group: all passed"
    : `\ncheck-model-group: ${failures} FAILED`
);
process.exit(failures === 0 ? 0 : 1);
