// 3D lane measurements (M4 lane 5, specdocs/ae-m4/3d.md), headless through
// aerender under the shared AE lock (ae.mts runAeJob / renderQueue).
//
//   npx tsx scripts/ae-export-spike/calibrate/three-d.mts probe [--work DIR]
//     Feasibility: a GLB and an OBJ imported as 3D model layers in a comp set
//     to the Advanced 3D renderer, with a camera and a light, rendered; every
//     property of the model / camera / light layers dumped.
//
// Writes calibrate/measured/three-d-<step>.json.

import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HERE, readAeFrame, renderQueue, renderedFile, runAeJob } from "./ae.mts";
import { renderTbx, savePng, type FloatImage } from "./lib.mts";
import type { TbxRender } from "./tbx-page.ts";
import { axesModel, cube, sphere, writeGlb, writeObj } from "./model3d.mts";
import { aeLightIntensity } from "@/lib/ae-export/convert/space3d";

const args = process.argv.slice(2);
const step = args[0] ?? "probe";
const wi = args.indexOf("--work");
const WORK = wi >= 0 ? args[wi + 1] : join(tmpdir(), `toolbox-ae-3d-${step}-${Date.now()}`);
const RENDERS = join(WORK, "renders");
mkdirSync(RENDERS, { recursive: true });
const W = 400;
const H = 400;

const GREY = { baseColor: [0.6, 0.6, 0.6] as [number, number, number], metallic: 0, roughness: 1 };
const WHITE = { baseColor: [1, 1, 1] as [number, number, number], metallic: 0, roughness: 1 };
const glbAxes = join(WORK, "axes.glb");
const glbSphere = join(WORK, "sphere.glb");
const objAxes = join(WORK, "axes.obj");
writeFileSync(glbAxes, writeGlb(axesModel(), GREY, "axes"));
writeFileSync(glbSphere, writeGlb(sphere(), GREY, "sphere"));
writeFileSync(objAxes, writeObj(axesModel(), "axes"));

// Non-transparent pixel box and mean color of a frame.
function coverage(img: FloatImage) {
  let n = 0;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const sum = [0, 0, 0];
  for (let y = 0; y < img.height; y++)
    for (let x = 0; x < img.width; x++) {
      const i = (y * img.width + x) * 4;
      if (img.data[i + 3] < 0.5) continue;
      n++;
      x0 = Math.min(x0, x);
      y0 = Math.min(y0, y);
      x1 = Math.max(x1, x);
      y1 = Math.max(y1, y);
      for (let k = 0; k < 3; k++) sum[k] += img.data[i + k];
    }
  if (!n) return { pixels: 0 };
  // Sub-pixel extents: alpha summed along the centre row / column, and the
  // alpha-weighted centroid.
  let rowA = 0, colA = 0, area = 0, cx = 0, cy = 0;
  const my = Math.floor(img.height / 2);
  const mx = Math.floor(img.width / 2);
  for (let x = 0; x < img.width; x++) rowA += img.data[(my * img.width + x) * 4 + 3];
  for (let y = 0; y < img.height; y++) colA += img.data[(y * img.width + mx) * 4 + 3];
  for (let y = 0; y < img.height; y++)
    for (let x = 0; x < img.width; x++) {
      const a = img.data[(y * img.width + x) * 4 + 3];
      area += a;
      cx += a * (x + 0.5);
      cy += a * (y + 0.5);
    }
  const r = (v: number) => +v.toFixed(3);
  return { pixels: n, box: [x0, y0, x1, y1], mean: sum.map((s) => +(s / n).toFixed(4)), rowWidth: r(rowA), colHeight: r(colA), area: r(area), centroid: [r(cx / area), r(cy / area)] };
}

async function run(cases: Record<string, unknown>[], extra: Record<string, unknown> = {}, tag = step) {
  const project = join(WORK, `three-d-${tag}.aep`);
  const job = await runAeJob(`three-d-${tag}`, "three-d.jsx", { project, renders: RENDERS, w: W, h: H, cases, ...extra }, WORK);
  console.log(`AE job: ${job.seconds.toFixed(1)} s, exit ${job.code}, errors ${JSON.stringify(job.out.errors)}`);
  const r = await renderQueue(project, WORK);
  console.log(`render: ${r.seconds.toFixed(1)} s, exit ${r.code}`);
  const frames: Record<string, unknown> = {};
  const images = new Map<string, FloatImage>();
  for (const c of cases) {
    for (const f of (c.frames as number[] | undefined) ?? [0]) {
      const file = renderedFile(RENDERS, `${c.name}_f${f}`);
      if (!file) {
        frames[`${c.name}_f${f}`] = null;
        continue;
      }
      const img = await readAeFrame(file);
      images.set(`${c.name}_f${f}`, img);
      await savePng(img, join(RENDERS, `${c.name}_f${f}.preview.png`));
      frames[`${c.name}_f${f}`] = coverage(img);
    }
  }
  return { job: job.out, frames, seconds: { job: job.seconds, render: r.seconds }, images };
}

const ADV = "ADBE Advanced 3d";
// Default AE camera for a 400² comp at 50 mm-ish: position [200, 200, -zoom].
const camera = { position: [200, 200, -1000], poi: [200, 200, 0], zoom: 1000 };
const light = { type: "PARALLEL", position: [0, 0, -500], poi: [200, 200, 0] };

// ---- lights: toolbox vs AE on one sphere -------------------------------------

// Toolbox world (three, Y-up, metres) → AE comp px, measured above: 512 px per
// unit, (x, y, z) → (x, −y, −z), the model's origin at the layer's anchor.
const PX = 512;
const aePoint = (o: number[], p: number[]) => [o[0] + PX * p[0], o[1] - PX * p[1], o[2] - PX * p[2]];
const zoomOf = (fovDeg: number, h: number) => h / 2 / Math.tan((fovDeg * Math.PI) / 360);
const srgbToLinear = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);

interface LightCase {
  name: string;
  tbx: Record<string, unknown>; // light-3d params; omitted = no light (fallback ambient)
  ae: Record<string, unknown>[]; // AE lights
  model?: string;
}

async function lights() {
  const size = { width: W, height: H };
  const O = [W / 2, H / 2, 0];
  const cam = { pos: [0, 0, 5], target: [0, 0, 0], fov: 30 };
  const aeCam = { position: aePoint(O, cam.pos), poi: aePoint(O, cam.target), zoom: zoomOf(cam.fov, H) };
  const front = aePoint(O, [0, 0, 5]);
  const key = aePoint(O, [3, 5, 2]); // light-3d's default position
  const k = 100 / Math.PI; // first guess: AE % = 100·I/π (three's Lambert has the 1/π)
  const cases: LightCase[] = [
    { name: "dir_front_1", tbx: { type: "directional", intensity: 1, pos_x: 0, pos_y: 0, pos_z: 5 }, ae: [{ type: "PARALLEL", position: front, poi: O, intensity: k }] },
    { name: "dir_front_2", tbx: { type: "directional", intensity: 2, pos_x: 0, pos_y: 0, pos_z: 5 }, ae: [{ type: "PARALLEL", position: front, poi: O, intensity: 2 * k }] },
    { name: "dir_key_3", tbx: { type: "directional", intensity: 3 }, ae: [{ type: "PARALLEL", position: key, poi: O, intensity: 3 * k }] },
    { name: "dir_key_red", tbx: { type: "directional", intensity: 2, color: "#ff8040" }, ae: [{ type: "PARALLEL", position: key, poi: O, intensity: 2 * k, color: [1, 0.2158605, 0.0512695] }] },
    { name: "amb_1", tbx: { type: "ambient", intensity: 1 }, ae: [{ type: "AMBIENT", intensity: k }] },
    { name: "amb_2", tbx: { type: "ambient", intensity: 2 }, ae: [{ type: "AMBIENT", intensity: 2 * k }] },
    { name: "point_none", tbx: { type: "point", intensity: 2.5, pos_x: 0, pos_y: 0, pos_z: 3 }, ae: [{ type: "POINT", position: aePoint(O, [0, 0, 3]), intensity: k, falloff: 1 }] },
    { name: "point_isq", tbx: { type: "point", intensity: 10, pos_x: 0, pos_y: 0, pos_z: 3 }, ae: [{ type: "POINT", position: aePoint(O, [0, 0, 3]), intensity: 10 * k, falloff: 3, radius: PX }] },
    { name: "point_isq_side", tbx: { type: "point", intensity: 10, pos_x: 1.5, pos_y: 1, pos_z: 1.5 }, ae: [{ type: "POINT", position: aePoint(O, [1.5, 1, 1.5]), intensity: 10 * k, falloff: 3, radius: PX }] },
    { name: "spot", tbx: { type: "spot", intensity: 10, pos_x: 0, pos_y: 0, pos_z: 4, angle: 10, penumbra: 0.25 }, ae: [{ type: "SPOT", position: aePoint(O, [0, 0, 4]), poi: O, intensity: 10 * k, coneAngle: 20, coneFeather: 25, falloff: 3, radius: PX }] },
    { name: "spot_soft", tbx: { type: "spot", intensity: 10, pos_x: 0, pos_y: 0, pos_z: 4, angle: 12, penumbra: 0.8 }, ae: [{ type: "SPOT", position: aePoint(O, [0, 0, 4]), poi: O, intensity: 10 * k, coneAngle: 24, coneFeather: 80, falloff: 3, radius: PX }] },
    { name: "nolight", tbx: {}, ae: [] },
  ];
  const tbxDir = join(WORK, "lights-tbx");
  mkdirSync(tbxDir, { recursive: true });
  // White, roughness 1, metalness 0 = three's default MeshStandardMaterial:
  // toolbox drops a plain Import 3D model's own material (model-cache
  // mergeSubtree returns material: null), so only the default compares.
  writeFileSync(join(tbxDir, "sphere.glb"), writeGlb(sphere(), WHITE, "sphere"));
  writeFileSync(join(WORK, "sphere-white.glb"), writeGlb(sphere(), WHITE, "sphere"));
  const renders = cases.map((c) => {
    const nodes: Record<string, unknown>[] = [
      { id: "model", type: "import-3d", params: { model: { url: "/inputs/sphere.glb", filename: "sphere.glb", format: "glb" }, object: "" } },
      { id: "cam", type: "camera-3d", params: { projection: "perspective", fov: cam.fov, near: 0.1, far: 100, pos_x: cam.pos[0], pos_y: cam.pos[1], pos_z: cam.pos[2], target_x: 0, target_y: 0, target_z: 0 } },
      ...(Object.keys(c.tbx).length ? [{ id: "light", type: "light-3d", params: { color: "#ffffff", ...c.tbx } }] : []),
      { id: "scene", type: "scene-render", params: { background: "transparent", environment: "none", fog: "none" } },
    ];
    const edges = [
      { id: "e1", source: "model", sourceHandle: "out:primary", target: "scene", targetHandle: "in:object:1" },
      { id: "e3", source: "cam", sourceHandle: "out:primary", target: "scene", targetHandle: "in:camera" },
    ];
    if (Object.keys(c.tbx).length) edges.push({ id: "e2", source: "light", sourceHandle: "out:primary", target: "scene", targetHandle: "in:object:2" });
    return { id: c.name, nodes, edges, target: "scene" } as unknown as TbxRender;
  });
  const tbx = await renderTbx("lights", size, [], renders, WORK);
  const ae = await run(cases.map((c) => ({ name: c.name, model: join(WORK, "sphere-white.glb"), camera: aeCam, lights: c.ae, modelTransform: { position: O } })));
  const out: Record<string, unknown> = {};
  for (const c of cases) {
    const a = ae.images.get(`${c.name}_f0`);
    const t = tbx.get(`${c.name}_f0`);
    if (!a || !t) {
      out[c.name] = { missing: { ae: !a, tbx: !t } };
      continue;
    }
    await savePng(t, join(RENDERS, `${c.name}_tbx.preview.png`));
    // Silhouettes: alpha IoU and centroid / extent differences.
    const ca = coverage(a) as { area: number; centroid: number[]; rowWidth: number; colHeight: number };
    const ct = coverage(t) as { area: number; centroid: number[]; rowWidth: number; colHeight: number };
    let inter = 0, uni = 0;
    for (let i = 3; i < a.data.length; i += 4) {
      inter += Math.min(a.data[i], t.data[i]);
      uni += Math.max(a.data[i], t.data[i]);
    }
    // Shading: centre-row profile (R, sRGB-encoded and linear), and the
    // linear-light ratio AE / toolbox over fully covered pixels.
    const y = Math.floor(H / 2);
    const prof: { x: number; ae: number; tbx: number }[] = [];
    for (let x = W / 2; x < W; x += 8) {
      const i = (y * W + x) * 4;
      prof.push({ x, ae: +a.data[i].toFixed(4), tbx: +t.data[i].toFixed(4) });
    }
    let sa = 0, st = 0, n = 0, worst = 0, sum = 0;
    for (let i = 0; i < a.data.length; i += 4) {
      if (a.data[i + 3] < 0.999 || t.data[i + 3] < 0.999) continue;
      sa += srgbToLinear(a.data[i]);
      st += srgbToLinear(t.data[i]);
      n++;
    }
    const k = st > 0 ? sa / st : 0;
    for (let i = 0; i < a.data.length; i += 4) {
      if (a.data[i + 3] < 0.999 || t.data[i + 3] < 0.999) continue;
      const d = Math.abs(a.data[i] - t.data[i]);
      worst = Math.max(worst, d);
      sum += d;
    }
    out[c.name] = {
      iou: +(inter / uni).toFixed(5),
      area: { ae: ca.area, tbx: ct.area },
      centroid: { ae: ca.centroid, tbx: ct.centroid },
      width: { ae: ca.rowWidth, tbx: ct.rowWidth },
      linearRatioAeOverTbx: +k.toFixed(4),
      encodedAbs: { mean: +(sum / n).toFixed(4), max: +worst.toFixed(4) },
      profile: prof,
    };
  }
  return { cases, aeJob: ae.job, compare: out, seconds: ae.seconds };
}

// ---- orthographic: a far perspective camera with a long zoom ------------------

async function ortho() {
  // LIT=1: a directional key light instead of a flat ambient — shading shows
  // the depth-precision artifacts a flat ambient hides. DISTS=d,d,…: px.
  const lit = process.env.LIT === "1";
  const size = { width: W, height: H };
  const O = [W / 2, H / 2, 0];
  const pos = [2.4, 1.8, 2.4];
  const len = Math.hypot(...pos);
  const dir = pos.map((v) => v / len);
  const orthoHeight = 3;
  const tbxDir = join(WORK, "ortho-tbx");
  mkdirSync(tbxDir, { recursive: true });
  writeFileSync(join(tbxDir, "axes.glb"), writeGlb(axesModel(), WHITE, "axes"));
  writeFileSync(join(WORK, "axes-white.glb"), writeGlb(axesModel(), WHITE, "axes"));
  const render = (id: string, projection: string) =>
    ({
      id,
      nodes: [
        { id: "model", type: "import-3d", params: { model: { url: "/inputs/axes.glb", filename: "axes.glb", format: "glb" }, object: "" } },
        { id: "cam", type: "camera-3d", params: { projection, fov: 30, ortho_height: orthoHeight, near: 0.1, far: 100, pos_x: pos[0], pos_y: pos[1], pos_z: pos[2], target_x: 0, target_y: 0, target_z: 0 } },
        { id: "light", type: "light-3d", params: lit ? { type: "directional", intensity: 2, pos_x: 3, pos_y: 5, pos_z: 2 } : { type: "ambient", intensity: 2 } },
        { id: "scene", type: "scene-render", params: {} },
      ],
      edges: [
        { id: "e1", source: "model", sourceHandle: "out:primary", target: "scene", targetHandle: "in:object:1" },
        { id: "e2", source: "light", sourceHandle: "out:primary", target: "scene", targetHandle: "in:object:2" },
        { id: "e3", source: "cam", sourceHandle: "out:primary", target: "scene", targetHandle: "in:camera" },
      ],
      target: "scene",
    }) as unknown as TbxRender;
  const tbx = await renderTbx("ortho", size, [], [render("ortho", "orthographic"), render("persp", "perspective")], WORK);
  const dists = (process.env.DISTS ?? "1e4,1e5,1e6,1e7").split(",").map(Number);
  const cases = dists.map((D) => ({
    name: `ortho_${D}`,
    model: join(WORK, "axes-white.glb"),
    camera: { position: aePoint(O, dir.map((v) => (v * D) / PX)), poi: O, zoom: (D * H) / (PX * orthoHeight) },
    lights: [lit ? { type: "PARALLEL", position: aePoint(O, [3, 5, 2]), poi: O, intensity: aeLightIntensity("directional", 2) } : { type: "AMBIENT", intensity: 100 }],
    modelTransform: { position: O },
  }));
  cases.push({ name: "persp", model: join(WORK, "axes-white.glb"), camera: { position: aePoint(O, pos), poi: O, zoom: zoomOf(30, H) }, lights: [{ type: "AMBIENT", intensity: 100 }], modelTransform: { position: O } });
  const ae = await run(cases);
  const out: Record<string, unknown> = {};
  for (const c of cases) {
    const a = ae.images.get(`${c.name}_f0`);
    const t = tbx.get(c.name === "persp" ? "persp_f0" : "ortho_f0");
    if (!a || !t) {
      out[c.name] = { missing: { ae: !a, tbx: !t } };
      continue;
    }
    let inter = 0, uni = 0;
    for (let i = 3; i < a.data.length; i += 4) {
      inter += Math.min(a.data[i], t.data[i]);
      uni += Math.max(a.data[i], t.data[i]);
    }
    const ca = coverage(a) as { area: number; centroid: number[] };
    const ct = coverage(t) as { area: number; centroid: number[] };
    let n = 0, sum = 0;
    const ds: number[] = [];
    for (let i = 0; i < a.data.length; i += 4) {
      if (a.data[i + 3] < 0.999 || t.data[i + 3] < 0.999) continue;
      const d = Math.abs(a.data[i] - t.data[i]);
      sum += d;
      ds.push(d);
      n++;
    }
    ds.sort((x, y) => x - y);
    out[c.name] = { iou: +(inter / uni).toFixed(5), area: { ae: ca.area, tbx: ct.area }, centroid: { ae: ca.centroid, tbx: ct.centroid }, color: { mean: +(sum / n).toFixed(4), p95: +(ds[Math.floor(0.95 * (n - 1))] ?? 0).toFixed(4), p99: +(ds[Math.floor(0.99 * (n - 1))] ?? 0).toFixed(4) } };
    await savePng(t, join(RENDERS, `${c.name}_tbx.preview.png`));
  }
  return { compare: out, aeJob: ae.job };
}

let result: unknown;
if (step === "probe") {
  result = await run([
    { name: "glb_adv", model: glbAxes, renderer: ADV, camera, lights: [light], dump: true, modelTransform: { position: [200, 200, 0] } },
    { name: "glb_classic", model: glbAxes, camera, lights: [light] },
    { name: "obj_adv", model: objAxes, renderer: ADV, camera, lights: [light], modelTransform: { position: [200, 200, 0] } },
    { name: "sphere_adv", model: glbSphere, renderer: ADV, camera, lights: [light], modelTransform: { position: [200, 200, 0] } },
  ]);
} else if (step === "units") {
  // AE's model units: the same model at known layer scales, viewed by a
  // camera whose zoom = distance (1 px = 1 px at z = 0).
  const at = (scale: number) => ({ position: [200, 200, 0], scale: [scale, scale, scale] });
  result = await run([
    { name: "axes_s1", model: glbAxes, camera, lights: [light], modelTransform: at(1) },
    { name: "axes_s10", model: glbAxes, camera, lights: [light], modelTransform: at(10) },
    { name: "sphere_s1", model: glbSphere, camera, lights: [light], modelTransform: at(1) },
    { name: "sphere_s10", model: glbSphere, camera, lights: [light], modelTransform: at(10) },
    { name: "sphere_s100_far", model: glbSphere, camera: { position: [200, 200, -20000], poi: [200, 200, 0], zoom: 1000 }, lights: [light], modelTransform: at(100) },
    { name: "obj_s1", model: objAxes, camera, lights: [light], modelTransform: at(1) },
  ]);
} else if (step === "units2") {
  // 1000² comps, camera 10000 px away with zoom 10000 (1 px = 1 px at z = 0,
  // near-orthographic): cubes of side 0.1 / 1 / 10 units scaled to the same
  // nominal size, and the axes model from the side (+X) for the Z sign.
  const far = { position: [500, 500, -10000], poi: [500, 500, 0], zoom: 10000 };
  const at = (scale: number) => ({ position: [500, 500, 0], scale: [scale, scale, scale] });
  writeFileSync(join(WORK, "cube01.glb"), writeGlb(cube(0.1), GREY, "cube01"));
  writeFileSync(join(WORK, "cube1.glb"), writeGlb(cube(1), GREY, "cube1"));
  writeFileSync(join(WORK, "cube10.glb"), writeGlb(cube(10), GREY, "cube10"));
  const big = { w: 1000, h: 1000, camera: far, lights: [{ ...light, poi: [500, 500, 0] }] };
  result = await run([
    { name: "cube01_s1000", model: join(WORK, "cube01.glb"), ...big, modelTransform: at(1000) },
    { name: "cube1_s100", model: join(WORK, "cube1.glb"), ...big, modelTransform: at(100) },
    { name: "cube10_s10", model: join(WORK, "cube10.glb"), ...big, modelTransform: at(10) },
    { name: "axes_side", model: glbAxes, ...big, camera: { position: [10500, 500, 0], poi: [500, 500, 0], zoom: 10000 }, modelTransform: at(60) },
    { name: "axes_top", model: glbAxes, ...big, camera: { position: [500, -9500, 0], poi: [500, 500, 0], zoom: 10000 }, modelTransform: at(60) },
  ]);
} else if (step === "math") {
  // AE's rotation order, Orientation vs X/Y/Z Rotation, the camera's look-at
  // basis and parenting, read back exactly via toWorld() expressions.
  const cases = [
    { name: "rx", kind: "null", xRotation: 30 },
    { name: "ry", kind: "null", yRotation: 30 },
    { name: "rz", kind: "null", zRotation: 30 },
    { name: "rxyz", kind: "null", xRotation: 30, yRotation: 40, zRotation: 50 },
    { name: "ori", kind: "null", orientation: [30, 40, 50] },
    { name: "ori_rot", kind: "null", orientation: [30, 40, 50], xRotation: 10, yRotation: 20, zRotation: 30 },
    { name: "scaled", kind: "null", scale: [200, 50, 300], xRotation: 30, yRotation: 40, zRotation: 50 },
    { name: "cam", kind: "camera", position: [800, 300, -800], poi: [500, 500, 0] },
    { name: "cam_down", kind: "camera", position: [500, -500, -10], poi: [500, 500, 0] },
    { name: "cam_rot", kind: "camera", position: [800, 300, -800], poi: [500, 500, 0], zRotation: 20 },
    { name: "parent", kind: "null", xRotation: 30, position: [10, 20, 30], parent: { position: [100, 0, 0], yRotation: 45, scale: [200, 100, 100] } },
  ];
  const job = await runAeJob("three-d-math", "three-d-math.jsx", { cases }, WORK);
  console.log(`AE job: ${job.seconds.toFixed(1)} s, errors ${JSON.stringify(job.out.errors)}`);
  result = { job: job.out };
} else if (step === "lights") {
  result = await lights();
} else if (step === "ortho") {
  result = await ortho();
} else if (step === "near") {
  // Which perspective cameras render: distance and direction variants.
  const O = [W / 2, H / 2, 0];
  writeFileSync(join(WORK, "axes-white.glb"), writeGlb(axesModel(), WHITE, "axes"));
  const pos = [2.4, 1.8, 2.4];
  const at = (k: number, p: number[]) => aePoint(O, p.map((v) => v * k));
  const mk = (name: string, position: number[], zoom = zoomOf(30, H)) => ({ name, model: join(WORK, "axes-white.glb"), camera: { position, poi: O, zoom }, lights: [{ type: "AMBIENT", intensity: 100 }], modelTransform: { position: O } });
  const r = await run([
    mk("obl_1", at(1, pos)),
    mk("obl_2", at(2, pos)),
    mk("obl_5", at(5, pos)),
    mk("front_385", at(1, [0, 0, 3.85])),
    mk("side_385", at(1, [3.85, 0, 0])),
    mk("xz_1", at(1, [2.4, 0, 2.4])),
    mk("xy_1", at(1, [2.4, 1.8, 0.01])),
    mk("obl_1_zoom2", at(1, pos), 2 * zoomOf(30, H)),
    mk("obl_1_again", at(1, pos)),
    mk("obl_1_zoom2_again", at(1, pos), 2 * zoomOf(30, H)),
    mk("obl_2_last", at(2, pos)),
  ]);
  result = { frames: r.frames, errors: r.job.errors };
} else if (step === "last") {
  // The save race: comps with model layers, the project saved with and
  // without a settle (SETTLE=ms,ms,… — one build + render per entry).
  const O = [W / 2, H / 2, 0];
  writeFileSync(join(WORK, "axes-white.glb"), writeGlb(axesModel(), WHITE, "axes"));
  const mk = (name: string, frames: number[], model = true) => ({ name, ...(model ? { model: join(WORK, "axes-white.glb") } : {}), camera: { position: aePoint(O, [2.4, 1.8, 2.4]), poi: O, zoom: zoomOf(30, H) }, lights: [{ type: "AMBIENT", intensity: 100 }], modelTransform: { position: O }, frames });
  const runs: unknown[] = [];
  for (const settleMs of (process.env.SETTLE ?? "0,0,0,1500,1500,1500").split(",").map(Number)) {
    const tag = `last-${runs.length}`;
    const r = await run([mk(`${tag}_a`, [0]), mk(`${tag}_b`, [0]), mk(`${tag}_c`, [0])], { settleMs }, tag);
    const px = Object.fromEntries(Object.entries(r.frames).map(([k, v]) => [k, (v as { pixels?: number } | null)?.pixels ?? null]));
    console.log(settleMs, JSON.stringify(px), r.seconds);
    runs.push({ settleMs, px, seconds: r.seconds, snapBefore: r.job.snapBefore, snapAfter: r.job.snapAfter });
  }
  result = { runs };
} else {
  throw new Error(`unknown step ${step}`);
}
const outFile = join(HERE, "measured", `three-d-${step}.json`);
writeFileSync(outFile, JSON.stringify(result, (k, v) => (k === "images" ? undefined : v), 1) + "\n");
console.log(`wrote ${outFile}; renders in ${RENDERS}`);

