// A native 3-D scene (M4 lane 5, specdocs/ae-m4/3d.md): a Scene Render the
// plan made layer-class (three-plan.ts) → a 3-D precomp on the Advanced 3D
// renderer, placed as one 2-D precomp layer where the render was. Inside,
// top first:
//
//   camera     camera-3d (or Scene Render's default camera): Position =
//              the camera position, Point of Interest = its target, Zoom from
//              the vertical FOV; orthographic → a far camera (convert/space3d)
//   lights     light-3d → Parallel / Point / Spot / Ambient (no light → the
//              fallback ambient Scene Render adds)
//   models     import-3d → the same file as model footage (a ThreeDModelLayer),
//              each Transform 3D above it a 3-D null it is parented to
//   background Scene Render's solid background, a 2-D layer at the bottom
//
// Coordinates: 512 px per world unit around the comp centre, (x, y, z) →
// (x, −y, −z); rotations X = a, Y = −b, Z = −c (convert/space3d.ts). Keyed
// params become keys through convert/ (per axis where AE separates them);
// wired ones, and the non-affine maps (FOV → zoom, intensity), are sampled
// per frame.

import {
  AE_LIGHT_RADIUS_PX,
  TOOLBOX_FALLBACK_AMBIENT,
  aeAxisMaps,
  aeLightIntensity,
  aeLightTypeOf,
  aeOrthoCamera,
  aeZoomOf,
  combinedTracksToAe,
  isKeyed,
  numericTrackToAe,
  sampledTrackToAe,
  spatialTrackToAe,
  toAePoint,
  tracksShareTiming,
  type ToolboxLightType,
  type Vec3,
} from "../convert";
import type { AeComp, AeLayer, AeLayerTransform, AeLightOptions, AePlanNode, AeProp } from "../types";
import { colorProp, driverOf, isAnimatedParam, keyCtx, markDriven, scalarProp, trackSource, valueOfSource, windowFrames } from "./context";
import { numbersOf } from "./graph";
import { newLayer, type Rendered, type Scope } from "./layers";

type Axes = [string, string, string];
const POS: Axes = ["pos_x", "pos_y", "pos_z"];
const TARGET: Axes = ["target_x", "target_y", "target_z"];
const ROT: Axes = ["rot_x", "rot_y", "rot_z"];
const SCALE: Axes = ["scale_x", "scale_y", "scale_z"];

// Scene Render's camera when nothing is wired (scene-render.ts DEFAULT_CAMERA).
const DEFAULT_CAMERA = { fov: 45, pos: [2.4, 1.8, 2.4], target: [0, 0, 0] };
const LIGHT_DEFAULTS = { pos: [3, 5, 2], target: [0, 0, 0] };
const MODEL_EXT: Record<string, string> = { glb: "glb", gltf: "gltf", obj: "obj" };

const OBJECT_SOCKET = /^in:object:(\d+)$/;

// A param's value at a tick of the layer clock (wire > keys > constant).
function valueAt(scope: Scope, node: string, param: string, fallback: number, tick: number): number {
  const d = driverOf(scope.ctx, node, param);
  if (d) return numbersOf(scope.ctx.graph.valueAt(d, tick))?.[0] ?? fallback;
  return valueOfSource(scope.ctx, { node, param, fallback }, tick);
}

function staticVec(scope: Scope, node: string, axes: Axes, def: readonly number[]): Vec3 {
  return axes.map((p, k) => valueAt(scope, node, p, def[k], 0)) as Vec3;
}

// Three scalar params → per-frame keys of `f(values)`.
function sampled(scope: Scope, owner: string, what: string, f: (tick: number) => number[]): AeProp<number[]> {
  const r = sampledTrackToAe(windowFrames(scope.clock), f, keyCtx(scope.ctx, scope.clock), what);
  if ("keys" in r.prop) scope.ctx.report.sampled(owner, `${what} → per-frame keys`);
  return r.prop;
}

function markDrivers(scope: Scope, node: string, axes: readonly string[], what: string): boolean {
  let any = false;
  for (const p of axes) {
    const d = driverOf(scope.ctx, node, p);
    if (d) {
      markDriven(scope.ctx, node, p, d, `${what}: driven by ${d} → per-frame keys`);
      any = true;
    }
  }
  return any;
}

// A 3-D point (pos_* / target_*) in AE px around `origin`. `separable`: AE's
// Position (separated dimensions when the axes key apart); else the Point of
// Interest (one spatial track, per-frame keys when the axes key apart).
function point3(
  scope: Scope,
  node: string,
  axes: Axes,
  def: readonly number[],
  origin: Vec3,
  label: string,
  separable: boolean
): { position: AeProp<number[]> } | { separated: { x: AeProp<number>; y: AeProp<number>; z: AeProp<number> } } {
  const { ctx } = scope;
  const maps = aeAxisMaps(origin);
  const oracle = (tick: number) => axes.map((p, k) => maps[k].scale * valueAt(scope, node, p, def[k], tick) + maps[k].offset);
  if (markDrivers(scope, node, axes, label)) return { position: sampled(scope, node, `${label} (driven)`, oracle) };
  const srcs = axes.map((p, k) => trackSource(ctx, node, p, def[k]));
  if (!srcs.some(isKeyed)) return { position: { v: toAePoint(axes.map((p, k) => valueAt(scope, node, p, def[k], 0)), origin) } };
  const kc = keyCtx(ctx, scope.clock);
  const parts = srcs.map((src) => ({ src, paramType: "scalar" as const }));
  if (tracksShareTiming(srcs)) {
    const sp = spatialTrackToAe(parts, { ...kc, map: maps });
    if (sp) {
      ctx.report.track(node, label, sp.report);
      return { position: sp.prop };
    }
  }
  if (!separable) return { position: sampled(scope, node, `${label}: the axes key apart (or overshoot), which one spatial track cannot`, oracle) };
  const one = (k: number) => {
    const r = numericTrackToAe(srcs[k], "scalar", { ...kc, map: maps[k] });
    ctx.report.track(node, `${label} ${"xyz"[k]}`, r.report);
    return r.prop as AeProp<number>;
  };
  ctx.report.note(node, `${label}: the axes key apart → separated X / Y / Z position`);
  return { separated: { x: one(0), y: one(1), z: one(2) } };
}

function scale3(scope: Scope, node: string): AeProp<number[]> {
  const { ctx } = scope;
  const oracle = (tick: number) => SCALE.map((p) => 100 * valueAt(scope, node, p, 1, tick));
  if (markDrivers(scope, node, SCALE, "scale")) return sampled(scope, node, "scale (driven)", oracle);
  const parts = SCALE.map((p) => ({ src: trackSource(ctx, node, p, 1), paramType: "scalar" as const }));
  const r = combinedTracksToAe(parts, { ...keyCtx(ctx, scope.clock), map: { scale: 100, offset: 0 } });
  ctx.report.track(node, "scale", r.report);
  return r.prop as AeProp<number[]>;
}

function rotations(scope: Scope, node: string): Pick<AeLayerTransform, "rotation" | "xRotation" | "yRotation" | "orientation"> {
  const r = (k: number, sign: number) => scalarProp(scope.ctx, scope.clock, node, ROT[k], { map: { scale: sign, offset: 0 }, fallback: 0, label: `${"XYZ"[k]} rotation` });
  return { xRotation: r(0, 1), yRotation: r(1, -1), rotation: r(2, -1), orientation: { v: [0, 0, 0] } };
}

// TRS of an Import 3D / Transform 3D node as a 3-D layer transform.
function trs3(scope: Scope, node: string, origin: Vec3): AeLayerTransform {
  const pos = point3(scope, node, POS, [0, 0, 0], origin, "position", true);
  return {
    anchor: { v: [0, 0, 0] },
    ...pos,
    scale: scale3(scope, node),
    ...rotations(scope, node),
    opacity: { v: 100 },
  } as AeLayerTransform;
}

export function emitScene3d(scope: Scope, endpoint: string, pn: AePlanNode): Rendered | null {
  const { ctx } = scope;
  const sceneId = pn.id;
  void endpoint;
  const W = ctx.canvas.width;
  const H = ctx.canvas.height;
  const O: Vec3 = [W / 2, H / 2, 0];
  const name = ctx.graph.name(sceneId);
  const members: string[] = [sceneId];
  const top: AeLayer[] = [];
  const lights: AeLayer[] = [];
  const bodies: AeLayer[] = [];
  const bottom: AeLayer[] = [];

  // --- camera -----------------------------------------------------------------------------
  const camId = ctx.graph.wireInto(sceneId, "in:camera")?.source;
  let subject: Vec3 = [0, 0, 0];
  if (camId) {
    members.push(camId);
    subject = staticVec(scope, camId, TARGET, DEFAULT_CAMERA.target);
    top.push(cameraLayer(scope, camId, O));
  } else {
    const L = newLayer(scope, "camera", "Camera", [sceneId], {
      transform: { anchor: { v: toAePoint(DEFAULT_CAMERA.target, O) }, position: { v: toAePoint(DEFAULT_CAMERA.pos, O) }, scale: { v: [100, 100, 100] }, rotation: { v: 0 }, opacity: { v: 100 } },
      camera: { zoom: { v: aeZoomOf(DEFAULT_CAMERA.fov, H) } },
    });
    ctx.report.note(sceneId, "no camera wired → Scene Render's default camera (FOV 45°, from 2.4, 1.8, 2.4 at the origin)");
    top.push(L);
  }

  // --- objects ------------------------------------------------------------------------------
  const objects = ctx.graph
    .into(sceneId)
    .map((w) => ({ w, slot: Number(OBJECT_SOCKET.exec(w.targetHandle)?.[1] ?? NaN) }))
    .filter((x) => Number.isFinite(x.slot))
    .sort((a, b) => a.slot - b.slot)
    .map((x) => x.w.source);
  const footageOf = new Map<string, string | null>();
  for (const id of objects) {
    const type = ctx.graph.node(id)?.type;
    members.push(id);
    if (type === "light-3d") lights.push(lightLayer(scope, id, O, subject));
    else bodies.push(...modelChain(scope, id, O, true, footageOf, members));
  }
  if (!lights.length) {
    lights.push(
      newLayer(scope, "light", "Ambient (toolbox default)", [sceneId], {
        transform: { anchor: { v: [...O] }, position: { v: [...O] }, scale: { v: [100, 100, 100] }, rotation: { v: 0 }, opacity: { v: 100 } },
        light: { type: "ambient", color: { v: [1, 1, 1] }, intensity: { v: aeLightIntensity("ambient", TOOLBOX_FALLBACK_AMBIENT) } },
      })
    );
    ctx.report.note(sceneId, `no light wired → the ambient light (${TOOLBOX_FALLBACK_AMBIENT}) Scene Render adds`);
  }

  // --- background ---------------------------------------------------------------------------
  const p = ctx.graph.params(sceneId);
  if (String(p.background ?? "transparent") === "solid") {
    const c = colorProp(ctx, scope.clock, sceneId, "bg_color", { shapeOrSolid: true, fallback: "#0e0e12", label: "background" });
    if ("v" in c.color) {
      bottom.push(newLayer(scope, "solid", "Background", [sceneId], { solid: { color: c.color.v, width: W, height: H }, transform: { anchor: { v: [W / 2, H / 2] }, position: { v: [W / 2, H / 2] }, scale: { v: [100, 100] }, rotation: { v: 0 }, opacity: { v: 100 } } }));
    } else {
      // A solid's color cannot key: a comp-sized rectangle.
      bottom.push(
        newLayer(scope, "shape", "Background", [sceneId], {
          transform: { anchor: { v: [0, 0] }, position: { v: [0, 0] }, scale: { v: [100, 100] }, rotation: { v: 0 }, opacity: { v: 100 } },
          contents: [
            { kind: "rect", size: { v: [W, H] }, position: { v: [W / 2, H / 2] }, roundness: { v: 0 } },
            { kind: "fill", color: c.color, opacity: { v: 100 }, rule: "nonzero" },
          ],
        })
      );
    }
  }

  const comp: AeComp = {
    id: ctx.uid(`comp:${sceneId}`),
    name: `${ctx.name} · ${name}`,
    width: W,
    height: H,
    fps: ctx.fps,
    duration: Math.max(ctx.durationFrames, scope.clock.outFrame) / ctx.fps,
    layers: [...top, ...lights, ...bodies, ...bottom],
    renderer: "advanced-3d",
  };
  ctx.out.comps.push(comp);
  ctx.report.note(sceneId, `→ 3-D precomp "${comp.name}" (Advanced 3D): ${comp.layers.length} layers`);
  const P = newLayer(scope, "precomp", name, [...new Set(members)], { source: comp.id });
  P.id = ctx.uid(`pre:${sceneId}`);
  return { layers: [P], main: P };
}

// --- camera -------------------------------------------------------------------------------------

function cameraLayer(scope: Scope, id: string, O: Vec3): AeLayer {
  const { ctx } = scope;
  const H = ctx.canvas.height;
  const p = ctx.graph.params(id);
  const ortho = String(p.projection ?? "perspective") === "orthographic";
  const base = { scale: { v: [100, 100, 100] }, rotation: { v: 0 }, opacity: { v: 100 } };
  if (ortho) {
    const at = (tick: number) =>
      aeOrthoCamera(
        POS.map((q, k) => valueAt(scope, id, q, DEFAULT_CAMERA.pos[k], tick)),
        TARGET.map((q) => valueAt(scope, id, q, 0, tick)),
        valueAt(scope, id, "ortho_height", 3, tick),
        H,
        O
      );
    const animated = [...POS, ...TARGET, "ortho_height"].some((q) => isAnimatedParam(ctx, id, q));
    markDrivers(scope, id, [...POS, ...TARGET, "ortho_height"], "orthographic camera");
    ctx.report.approx(id, "orthographic → an AE camera 2·10⁵ px from its target with zoom D·H/(512·ortho_height); AE has no orthographic camera");
    if (!animated) {
      const c = at(0);
      return newLayer(scope, "camera", ctx.graph.name(id), [id], { transform: { anchor: { v: c.poi }, position: { v: c.position }, ...base }, camera: { zoom: { v: c.zoom } } });
    }
    return newLayer(scope, "camera", ctx.graph.name(id), [id], {
      transform: {
        anchor: sampled(scope, id, "orthographic camera target", (t) => at(t).poi),
        position: sampled(scope, id, "orthographic camera position", (t) => at(t).position),
        ...base,
      },
      camera: { zoom: one(sampled(scope, id, "orthographic camera zoom", (t) => [at(t).zoom])) },
    });
  }
  const pos = point3(scope, id, POS, DEFAULT_CAMERA.pos, O, "position", true);
  const poi = point3(scope, id, TARGET, DEFAULT_CAMERA.target, O, "target", false) as { position: AeProp<number[]> };
  let zoom: AeProp<number>;
  if (isAnimatedParam(ctx, id, "fov")) {
    markDrivers(scope, id, ["fov"], "fov");
    zoom = one(sampled(scope, id, "zoom = (H/2)/tan(fov/2) is not affine in the FOV", (t) => [aeZoomOf(valueAt(scope, id, "fov", 45, t), H)]));
  } else zoom = { v: aeZoomOf(valueAt(scope, id, "fov", 45, 0), H) };
  const near = valueAt(scope, id, "near", 0.1, 0);
  const far = valueAt(scope, id, "far", 100, 0);
  if (near > 0.5 || far < 50) ctx.report.note(id, `near ${near} / far ${far}: AE's camera does not clip — geometry toolbox clips shows in AE`);
  return newLayer(scope, "camera", ctx.graph.name(id), [id], { transform: { anchor: poi.position, ...pos, ...base } as AeLayerTransform, camera: { zoom } });
}

const one = (p: AeProp<number[]>): AeProp<number> => ("v" in p ? { v: p.v[0] } : { keys: p.keys.map((k) => ({ ...k, v: k.v[0] })), dims: 1 });

// --- lights -------------------------------------------------------------------------------------

function lightLayer(scope: Scope, id: string, O: Vec3, subject: Vec3): AeLayer {
  const { ctx } = scope;
  const p = ctx.graph.params(id);
  const ttype = String(p.type ?? "directional") as ToolboxLightType;
  const type = aeLightTypeOf(ttype);
  if (ctx.graph.block(id, "type")) ctx.report.note(id, "light type is keyed — AE's light type cannot animate; its frame-0 type is used");
  const color = colorProp(ctx, scope.clock, id, "color", { shapeOrSolid: false, fallback: "#ffffff", label: "light color" }).color;
  // Point / spot: matched at the distance to the camera's target (frame 0).
  const at0 = POS.map((q, k) => valueAt(scope, id, q, LIGHT_DEFAULTS.pos[k], 0));
  const dist = Math.hypot(at0[0] - subject[0], at0[1] - subject[1], at0[2] - subject[2]);
  const intensityAt = (tick: number) => aeLightIntensity(ttype, valueAt(scope, id, "intensity", 3, tick), dist);
  let intensity: AeProp<number>;
  if (isAnimatedParam(ctx, id, "intensity")) {
    markDrivers(scope, id, ["intensity"], "intensity");
    intensity = one(sampled(scope, id, "intensity → AE % is not affine", (t) => [intensityAt(t)]));
  } else intensity = { v: intensityAt(0) };
  // three renders no shadow maps here; AE lights default to none too, and an
  // ambient light has no shadow option at all.
  const light: AeLightOptions = { type, color, intensity, ...(type === "ambient" ? {} : { castsShadows: false }) };
  if (type === "point" || type === "spot") {
    light.falloff = "inverse-square-clamped";
    light.radius = { v: AE_LIGHT_RADIUS_PX };
    ctx.report.note(id, `Inverse Square Clamped falloff, Radius 512 px (1 unit); intensity matched ${dist.toFixed(2)} units away (the camera's target at frame 0)`);
  }
  if (type === "spot") {
    light.coneAngle = scalarProp(ctx, scope.clock, id, "angle", { map: { scale: 2, offset: 0 }, fallback: 40, label: "cone angle" });
    light.coneFeather = scalarProp(ctx, scope.clock, id, "penumbra", { map: { scale: 100, offset: 0 }, fallback: 0.25, label: "cone feather" });
    const cutoff = valueAt(scope, id, "distance", 0, 0);
    if (cutoff > 0) ctx.report.approx(id, `distance ${cutoff} (three's cutoff) has no AE form — the light reaches past it in AE`);
  }
  const base = { scale: { v: [100, 100, 100] }, rotation: { v: 0 }, opacity: { v: 100 } };
  let transform: AeLayerTransform;
  if (type === "ambient") transform = { anchor: { v: [...O] }, position: { v: [...O] }, ...base };
  else {
    const pos = point3(scope, id, POS, LIGHT_DEFAULTS.pos, O, "position", true);
    // Point lights have no Point of Interest (AE hides it): its anchor is unused.
    const poi = type === "point" ? { position: { v: [...O] } } : (point3(scope, id, TARGET, LIGHT_DEFAULTS.target, O, "target", false) as { position: AeProp<number[]> });
    transform = { anchor: poi.position, ...pos, ...base } as AeLayerTransform;
  }
  return newLayer(scope, "light", ctx.graph.name(id), [id], { transform, light });
}

// --- models -------------------------------------------------------------------------------------

// Transform 3D* → Import 3D: a null per Transform 3D, the model layer
// parented to the innermost. Only the outermost sits around `O`; the rest are
// in their parent's space.
function modelChain(scope: Scope, id: string, O: Vec3, outer: boolean, footageOf: Map<string, string | null>, members: string[]): AeLayer[] {
  const { ctx } = scope;
  const type = ctx.graph.node(id)?.type;
  const origin: Vec3 = outer ? O : [0, 0, 0];
  if (type === "transform-3d") {
    const N = newLayer(scope, "null", ctx.graph.name(id), [id], { threeD: true, transform: trs3(scope, id, origin) });
    const src = ctx.graph.wireInto(id, "in:source")?.source;
    if (!src) {
      ctx.report.note(id, "nothing wired into source — an empty 3-D null");
      return [N];
    }
    members.push(src);
    const inner = modelChain(scope, src, O, false, footageOf, members);
    for (const L of inner) if (!L.parent) L.parent = N.id;
    const shear = shearNote(scope, id, src);
    if (shear) ctx.report.approx(id, shear);
    return [N, ...inner];
  }
  if (type !== "import-3d") {
    ctx.out.problems.push(`${type} (${id}) reached a native 3-D scene — the plan should have baked it`);
    return [];
  }
  const fid = modelFootage(scope, id, footageOf);
  if (!fid) return [];
  const L = newLayer(scope, "footage", ctx.graph.name(id), [id], { source: fid, threeD: true, transform: trs3(scope, id, origin) });
  ctx.report.approx(id, "materials: AE renders the file's own PBR materials; toolbox's Import 3D shows three's default material (model-cache drops a plain import's material)");
  return [L];
}

function modelFootage(scope: Scope, id: string, footageOf: Map<string, string | null>): string | null {
  const { ctx } = scope;
  if (footageOf.has(id)) return footageOf.get(id)!;
  const model = ctx.graph.params(id).model as { url?: unknown; filename?: unknown; format?: unknown } | null | undefined;
  if (!model || typeof model.url !== "string" || !model.url) {
    ctx.out.warnings.push(`Import 3D "${ctx.graph.name(id)}" has no file loaded (re-pick it) — it exports empty, as toolbox renders it.`);
    ctx.report.note(id, "no file loaded — nothing to import");
    footageOf.set(id, null);
    return null;
  }
  const ext = MODEL_EXT[String(model.format ?? "glb")] ?? "glb";
  const fid = ctx.uid(`model:${id}`);
  const path = `footage/${fid.replace(/[^A-Za-z0-9_.-]+/g, "_")}.${ext}`;
  ctx.out.footage.push({ id: fid, path, kind: "model", alpha: "ignore", name: typeof model.filename === "string" && model.filename ? model.filename : ctx.graph.name(id) });
  ctx.out.assets.push({ id: fid, path, source: { kind: "model", ref: id } });
  if (ext === "gltf") ctx.report.note(id, ".gltf copies one file: its buffers and textures must be embedded (data: URIs), or use .glb");
  footageOf.set(id, fid);
  return fid;
}

// Transform 3D composes onto the carried transform and DECOMPOSES back to
// TRS (three drops shear); AE parenting keeps the full product. They differ
// only for a rotation over a non-uniform scale.
function shearNote(scope: Scope, parent: string, child: string): string | null {
  const nonUniform = (id: string) => {
    const s = SCALE.map((q) => valueAt(scope, id, q, 1, 0));
    return Math.abs(s[0] - s[1]) > 1e-9 || Math.abs(s[1] - s[2]) > 1e-9 || SCALE.some((q) => isAnimatedParam(scope.ctx, id, q));
  };
  const rotated = ROT.some((q) => isAnimatedParam(scope.ctx, parent, q) || Math.abs(valueAt(scope, parent, q, 0, 0)) > 1e-9);
  if (rotated && nonUniform(child)) return "rotation over a non-uniformly scaled child: AE parenting keeps the shear three's TRS decompose drops";
  return null;
}
