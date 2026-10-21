// Structural validation of a scene.json against src/lib/ae-export/types.ts.
//
// build.jsx trusts the shape of what it reads (it maps one node to one
// ExtendScript call and does no math), so everything it relies on is checked
// here first: required fields, enum members, key ordering, ease/influence
// ranges, references between layers, masks, footage, comps and presets. The
// package writer runs this before writing a package; the gate runs it on the
// hand-written fixtures. Returns problems as "path: message" strings — empty
// means valid.

import {
  AE_SCENE_SCHEMA_VERSION,
  type AeBlendMode,
  type AeFootage,
  type AeLayerKind,
  type AeShapeItem,
} from "../types";

/* eslint-disable @typescript-eslint/no-explicit-any */

const LAYER_KINDS: Record<AeLayerKind, true> = {
  shape: true, solid: true, footage: true, precomp: true, null: true, text: true, adjustment: true, camera: true, light: true,
};

const BLEND_MODES: Record<AeBlendMode, true> = {
  normal: true, dissolve: true, darken: true, multiply: true, "color-burn": true, "classic-color-burn": true,
  "linear-burn": true, "darker-color": true, add: true, lighten: true, screen: true, "color-dodge": true,
  "classic-color-dodge": true, "linear-dodge": true, "lighter-color": true, overlay: true, "soft-light": true,
  "hard-light": true, "linear-light": true, "vivid-light": true, "pin-light": true, "hard-mix": true, difference: true,
  "classic-difference": true, exclusion: true, subtract: true, divide: true, hue: true, saturation: true, color: true,
  luminosity: true, "stencil-alpha": true, "stencil-luma": true, "silhouette-alpha": true, "silhouette-luma": true,
  "alpha-add": true, "luminescent-premul": true,
};

// Shape-group / fill / stroke blend modes ("ADBE Vector Blend Mode") are a
// subset: no dissolve, classic, stencil, silhouette, alpha-add or premul modes.
const SHAPE_BLEND_MODES = new Set<string>([
  "normal", "darken", "multiply", "color-burn", "linear-burn", "darker-color", "lighten", "screen", "color-dodge", "add",
  "linear-dodge", "lighter-color", "overlay", "soft-light", "hard-light", "linear-light", "vivid-light", "pin-light",
  "hard-mix", "difference", "exclusion", "subtract", "divide", "hue", "saturation", "color", "luminosity",
]);

const SHAPE_KINDS: Record<AeShapeItem["kind"], true> = {
  group: true, path: true, rect: true, ellipse: true, polystar: true, fill: true, stroke: true, "gradient-fill": true,
  "gradient-stroke": true, trim: true, offset: true, "round-corners": true, repeater: true, merge: true,
};

const FOOTAGE_KINDS: Record<AeFootage["kind"], true> = { video: true, image: true, sequence: true, svg: true, model: true };
const FOOTAGE_ALPHA: Record<AeFootage["alpha"], true> = { straight: true, premultiplied: true, ignore: true };
const INTERPS = new Set(["linear", "bezier", "hold"]);
const CAPS = new Set(["butt", "round", "square"]);
const JOINS = new Set(["miter", "round", "bevel"]);
const MASK_MODES = new Set(["none", "add", "subtract", "intersect", "lighten", "darken", "difference"]);
const MATTE_TYPES = new Set(["LUMA", "LUMA_INVERTED", "ALPHA", "ALPHA_INVERTED"]);
const JUSTIFY = new Set(["left", "center", "right", "full-left", "full-center", "full-right", "full"]);
const TEXT_BASED_ON = new Set(["characters", "characters-excluding-spaces", "words", "lines"]);
const TEXT_SHAPES = new Set(["square", "ramp-up", "ramp-down", "triangle", "round", "smooth"]);
const RENDERERS = new Set(["advanced-3d", "classic-3d"]);
const LIGHT_TYPES = new Set(["parallel", "spot", "point", "ambient"]);
const LIGHT_FALLOFFS = new Set(["none", "smooth", "inverse-square-clamped"]);

type ValueCheck = (v: unknown, path: string, out: string[]) => void;

const isObj = (v: unknown): v is Record<string, any> => typeof v === "object" && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isStr = (v: unknown): v is string => typeof v === "string";

function num(v: unknown, path: string, out: string[]) {
  if (!isNum(v)) out.push(`${path}: expected a finite number, got ${JSON.stringify(v)}`);
}

function vec(n?: number, min = 1, max = 4): ValueCheck {
  return (v, path, out) => {
    if (!Array.isArray(v) || !v.every(isNum)) return void out.push(`${path}: expected a number array`);
    if (n !== undefined ? v.length !== n : v.length < min || v.length > max)
      out.push(`${path}: expected ${n ?? `${min}–${max}`} numbers, got ${v.length}`);
  };
}

const rgb: ValueCheck = (v, path, out) => {
  vec(3)(v, path, out);
  if (Array.isArray(v) && v.some((c) => c < 0 || c > 1)) out.push(`${path}: color channels are 0–1`);
};

const shapePath: ValueCheck = (v, path, out) => {
  if (!isObj(v)) return void out.push(`${path}: expected a path {vertices, inTangents, outTangents, closed}`);
  const n = Array.isArray(v.vertices) ? v.vertices.length : -1;
  for (const k of ["vertices", "inTangents", "outTangents"]) {
    if (!Array.isArray(v[k]) || v[k].length !== n || !v[k].every((p: unknown) => Array.isArray(p) && p.length === 2 && p.every(isNum)))
      out.push(`${path}.${k}: expected ${n < 0 ? "" : n + " "}[x, y] pairs`);
  }
  if (typeof v.closed !== "boolean") out.push(`${path}.closed: expected a boolean`);
};

const textDocument: ValueCheck = (v, path, out) => {
  if (!isObj(v)) return void out.push(`${path}: expected a text document`);
  if (!isStr(v.text)) out.push(`${path}.text: expected a string`);
  if (!isStr(v.font) || !v.font) out.push(`${path}.font: expected a PostScript name`);
  num(v.fontSize, `${path}.fontSize`, out);
  num(v.tracking, `${path}.tracking`, out);
  if (!JUSTIFY.has(v.justification)) out.push(`${path}.justification: unknown "${v.justification}"`);
  for (const c of ["fillColor", "strokeColor"]) if (c in v) rgb(v[c], `${path}.${c}`, out);
  for (const c of ["strokeWidth", "leading"]) if (c in v) num(v[c], `${path}.${c}`, out);
  if ("box" in v) {
    if (!isObj(v.box)) out.push(`${path}.box: expected {size, position}`);
    else {
      vec(2)(v.box.size, `${path}.box.size`, out);
      vec(2)(v.box.position, `${path}.box.position`, out);
    }
  }
};

function ease(list: unknown, path: string, out: string[]) {
  if (!Array.isArray(list) || list.length < 1 || list.length > 3) return void out.push(`${path}: expected 1–3 eases`);
  list.forEach((e, i) => {
    if (!isObj(e) || !isNum(e.speed) || !isNum(e.influence)) out.push(`${path}[${i}]: expected {speed, influence}`);
    else if (e.influence < 0.1 || e.influence > 100) out.push(`${path}[${i}].influence: ${e.influence} is outside AE's 0.1–100`);
  });
}

// AeProp<T>: { v } or { keys, dims }, plus an optional expression.
function prop(p: unknown, path: string, out: string[], check: ValueCheck, opts: { required?: boolean } = {}) {
  if (p === undefined) {
    if (opts.required !== false) out.push(`${path}: missing`);
    return;
  }
  if (!isObj(p)) return void out.push(`${path}: expected {v} or {keys, dims}`);
  if ("expression" in p && !isStr(p.expression)) out.push(`${path}.expression: expected a string`);
  const hasV = "v" in p;
  const hasKeys = "keys" in p;
  if (hasV === hasKeys) return void out.push(`${path}: needs exactly one of v / keys`);
  if (hasV) return check(p.v, `${path}.v`, out);
  if (![1, 2, 3, 4].includes(p.dims)) out.push(`${path}.dims: expected 1–4`);
  if (!Array.isArray(p.keys) || !p.keys.length) return void out.push(`${path}.keys: expected at least one key`);
  let prevT = -Infinity;
  let vertexCount: number | undefined;
  p.keys.forEach((k: any, i: number) => {
    const kp = `${path}.keys[${i}]`;
    if (!isObj(k)) return void out.push(`${kp}: expected a key`);
    if (!isNum(k.t)) out.push(`${kp}.t: expected seconds`);
    else if (!(k.t > prevT)) out.push(`${kp}.t: key times must increase`);
    else prevT = k.t;
    check(k.v, `${kp}.v`, out);
    if (check === shapePath && isObj(k.v) && Array.isArray(k.v.vertices)) {
      if (vertexCount !== undefined && k.v.vertices.length !== vertexCount) out.push(`${kp}.v: path keys need a constant vertex count`);
      vertexCount = k.v.vertices.length;
    }
    if (!INTERPS.has(k.inInterp)) out.push(`${kp}.inInterp: expected linear|bezier|hold`);
    if (!INTERPS.has(k.outInterp)) out.push(`${kp}.outInterp: expected linear|bezier|hold`);
    if ("easeIn" in k) ease(k.easeIn, `${kp}.easeIn`, out);
    if ("easeOut" in k) ease(k.easeOut, `${kp}.easeOut`, out);
    for (const s of ["spatialIn", "spatialOut"]) if (s in k) vec(undefined, 2, 3)(k[s], `${kp}.${s}`, out);
  });
}

function oneOf(v: unknown, set: Set<string> | Record<string, true>, path: string, out: string[]) {
  const ok = set instanceof Set ? set.has(v as string) : typeof v === "string" && Object.prototype.hasOwnProperty.call(set, v);
  if (!ok) out.push(`${path}: unknown ${JSON.stringify(v)}`);
}

function shapeTransform(t: any, path: string, out: string[], repeater = false) {
  if (!isObj(t)) return void out.push(`${path}: expected a transform`);
  const opt = { required: false };
  prop(t.anchor, `${path}.anchor`, out, vec(2), opt);
  prop(t.position, `${path}.position`, out, vec(2), opt);
  prop(t.scale, `${path}.scale`, out, vec(2), opt);
  prop(t.rotation, `${path}.rotation`, out, num, opt);
  if (repeater) {
    prop(t.startOpacity, `${path}.startOpacity`, out, num, opt);
    prop(t.endOpacity, `${path}.endOpacity`, out, num, opt);
  } else {
    prop(t.opacity, `${path}.opacity`, out, num, opt);
    prop(t.skew, `${path}.skew`, out, num, opt);
    prop(t.skewAxis, `${path}.skewAxis`, out, num, opt);
  }
}

function stops(s: any, path: string, out: string[]) {
  if (!isObj(s) || !Array.isArray(s.colors) || !Array.isArray(s.opacities)) return void out.push(`${path}: expected {colors, opacities}`);
  if (!s.colors.length) out.push(`${path}.colors: at least one color stop`);
  s.colors.forEach((c: any, i: number) => {
    if (!isObj(c) || !isNum(c.offset) || c.offset < 0 || c.offset > 1) out.push(`${path}.colors[${i}].offset: expected 0–1`);
    else rgb(c.color, `${path}.colors[${i}].color`, out);
  });
  s.opacities.forEach((c: any, i: number) => {
    if (!isObj(c) || !isNum(c.offset) || c.offset < 0 || c.offset > 1 || !isNum(c.opacity) || c.opacity < 0 || c.opacity > 1)
      out.push(`${path}.opacities[${i}]: expected offset and opacity in 0–1`);
  });
}

function strokeShared(it: any, path: string, out: string[]) {
  oneOf(it.cap, CAPS, `${path}.cap`, out);
  oneOf(it.join, JOINS, `${path}.join`, out);
  num(it.miterLimit, `${path}.miterLimit`, out);
}

function shapeItems(items: unknown, path: string, out: string[], presets: Set<string>) {
  if (!Array.isArray(items)) return void out.push(`${path}: expected an array of shape items`);
  items.forEach((it: any, i: number) => {
    const p = `${path}[${i}]`;
    if (!isObj(it)) return void out.push(`${p}: expected a shape item`);
    oneOf(it.kind, SHAPE_KINDS, `${p}.kind`, out);
    if ("blendMode" in it && !SHAPE_BLEND_MODES.has(it.blendMode)) out.push(`${p}.blendMode: "${it.blendMode}" has no shape-content form`);
    switch (it.kind as AeShapeItem["kind"]) {
      case "group":
        shapeItems(it.contents, `${p}.contents`, out, presets);
        if ("transform" in it) shapeTransform(it.transform, `${p}.transform`, out);
        break;
      case "path":
        prop(it.path, `${p}.path`, out, shapePath);
        break;
      case "rect":
        prop(it.size, `${p}.size`, out, vec(2));
        prop(it.position, `${p}.position`, out, vec(2));
        prop(it.roundness, `${p}.roundness`, out, num);
        break;
      case "ellipse":
        prop(it.size, `${p}.size`, out, vec(2));
        prop(it.position, `${p}.position`, out, vec(2));
        break;
      case "polystar":
        oneOf(it.type, new Set(["star", "polygon"]), `${p}.type`, out);
        for (const k of ["points", "rotation", "outerRadius", "outerRoundness"]) prop(it[k], `${p}.${k}`, out, num);
        prop(it.position, `${p}.position`, out, vec(2));
        if (it.type === "star") {
          prop(it.innerRadius, `${p}.innerRadius`, out, num);
          prop(it.innerRoundness, `${p}.innerRoundness`, out, num, { required: false });
        }
        break;
      case "fill":
        prop(it.color, `${p}.color`, out, rgb);
        prop(it.opacity, `${p}.opacity`, out, num);
        oneOf(it.rule, new Set(["nonzero", "evenodd"]), `${p}.rule`, out);
        break;
      case "stroke":
        prop(it.color, `${p}.color`, out, rgb);
        prop(it.opacity, `${p}.opacity`, out, num);
        prop(it.width, `${p}.width`, out, num);
        strokeShared(it, p, out);
        if ("dashes" in it) {
          if (!Array.isArray(it.dashes) || it.dashes.length > 3) out.push(`${p}.dashes: at most 3 dash/gap pairs`);
          else it.dashes.forEach((d: any, j: number) => {
            prop(d?.dash, `${p}.dashes[${j}].dash`, out, num);
            prop(d?.gap, `${p}.dashes[${j}].gap`, out, num);
          });
        }
        prop(it.dashOffset, `${p}.dashOffset`, out, num, { required: false });
        if ("taper" in it) {
          for (const k of ["startLength", "endLength", "startWidth", "endWidth", "startEase", "endEase"]) prop(it.taper?.[k], `${p}.taper.${k}`, out, num);
        }
        break;
      case "gradient-fill":
      case "gradient-stroke":
        oneOf(it.type, new Set(["linear", "radial"]), `${p}.type`, out);
        prop(it.start, `${p}.start`, out, vec(2));
        prop(it.end, `${p}.end`, out, vec(2));
        stops(it.stops, `${p}.stops`, out);
        prop(it.opacity, `${p}.opacity`, out, num);
        prop(it.highlightLength, `${p}.highlightLength`, out, num, { required: false });
        prop(it.highlightAngle, `${p}.highlightAngle`, out, num, { required: false });
        if ("preset" in it && !presets.has(it.preset)) out.push(`${p}.preset: "${it.preset}" is not in scene.presets`);
        if (it.kind === "gradient-stroke") {
          prop(it.width, `${p}.width`, out, num);
          strokeShared(it, p, out);
        } else if ("rule" in it) oneOf(it.rule, new Set(["nonzero", "evenodd"]), `${p}.rule`, out);
        break;
      case "trim":
        for (const k of ["start", "end", "offset"]) prop(it[k], `${p}.${k}`, out, num);
        oneOf(it.mode, new Set(["simultaneous", "individual"]), `${p}.mode`, out);
        break;
      case "offset":
        prop(it.amount, `${p}.amount`, out, num);
        oneOf(it.join, JOINS, `${p}.join`, out);
        num(it.miterLimit, `${p}.miterLimit`, out);
        prop(it.copies, `${p}.copies`, out, num, { required: false });
        prop(it.copyOffset, `${p}.copyOffset`, out, num, { required: false });
        break;
      case "round-corners":
        prop(it.radius, `${p}.radius`, out, num);
        break;
      case "repeater":
        prop(it.copies, `${p}.copies`, out, num);
        prop(it.offset, `${p}.offset`, out, num);
        oneOf(it.composite, new Set(["above", "below"]), `${p}.composite`, out);
        shapeTransform(it.transform, `${p}.transform`, out, true);
        break;
      case "merge":
        oneOf(it.mode, new Set(["merge", "add", "subtract", "intersect", "exclude"]), `${p}.mode`, out);
        break;
    }
  });
}

function mask(m: any, path: string, out: string[]) {
  if (!isObj(m)) return void out.push(`${path}: expected a mask`);
  prop(m.path, `${path}.path`, out, shapePath);
  oneOf(m.mode, MASK_MODES, `${path}.mode`, out);
  if (typeof m.inverted !== "boolean") out.push(`${path}.inverted: expected a boolean`);
  prop(m.feather, `${path}.feather`, out, vec(2));
  prop(m.expansion, `${path}.expansion`, out, num);
  prop(m.opacity, `${path}.opacity`, out, num);
}

function layerTransform(t: any, path: string, out: string[], kind: string) {
  if (!isObj(t)) return void out.push(`${path}: expected a transform`);
  prop(t.anchor, `${path}.anchor`, out, vec(undefined, 2, 3));
  if (("position" in t) === ("separated" in t)) out.push(`${path}: needs exactly one of position / separated`);
  if ("position" in t) prop(t.position, `${path}.position`, out, vec(undefined, 2, 3));
  if ("separated" in t) {
    if (!isObj(t.separated)) out.push(`${path}.separated: expected {x, y, z?}`);
    else {
      prop(t.separated.x, `${path}.separated.x`, out, num);
      prop(t.separated.y, `${path}.separated.y`, out, num);
      prop(t.separated.z, `${path}.separated.z`, out, num, { required: false });
    }
  }
  prop(t.scale, `${path}.scale`, out, vec(undefined, 2, 3));
  prop(t.rotation, `${path}.rotation`, out, num);
  prop(t.opacity, `${path}.opacity`, out, num);
  prop(t.orientation, `${path}.orientation`, out, vec(3), { required: false });
  prop(t.xRotation, `${path}.xRotation`, out, num, { required: false });
  prop(t.yRotation, `${path}.yRotation`, out, num, { required: false });
  void kind;
}

// Camera / light options (M4 lane 5): only on their own layer kinds; spot-only
// and falloff-only props where AE shows them (it refuses values on hidden ones).
function cameraLight(L: any, p: string, out: string[]) {
  if ("camera" in L) {
    if (L.kind !== "camera") out.push(`${p}.camera: only camera layers`);
    if (!isObj(L.camera)) out.push(`${p}.camera: expected {zoom}`);
    else prop(L.camera.zoom, `${p}.camera.zoom`, out, num);
  }
  if (!("light" in L)) return;
  if (L.kind !== "light") out.push(`${p}.light: only light layers`);
  const g = L.light;
  if (!isObj(g)) return void out.push(`${p}.light: expected {type, color, intensity}`);
  oneOf(g.type, LIGHT_TYPES, `${p}.light.type`, out);
  prop(g.color, `${p}.light.color`, out, rgb);
  prop(g.intensity, `${p}.light.intensity`, out, num);
  for (const k of ["coneAngle", "coneFeather"]) {
    if (!(k in g)) continue;
    if (g.type !== "spot") out.push(`${p}.light.${k}: only spot lights have a cone`);
    prop(g[k], `${p}.light.${k}`, out, num);
  }
  if ("falloff" in g) {
    oneOf(g.falloff, LIGHT_FALLOFFS, `${p}.light.falloff`, out);
    if (g.type !== "point" && g.type !== "spot") out.push(`${p}.light.falloff: only point and spot lights fall off`);
  }
  if ("radius" in g) {
    if (g.falloff !== "smooth" && g.falloff !== "inverse-square-clamped") out.push(`${p}.light.radius: AE hides Radius without a falloff`);
    prop(g.radius, `${p}.light.radius`, out, num);
  }
  if ("falloffDistance" in g) {
    if (g.falloff !== "smooth") out.push(`${p}.light.falloffDistance: only the smooth falloff has a Falloff Distance`);
    prop(g.falloffDistance, `${p}.light.falloffDistance`, out, num);
  }
  if ("castsShadows" in g && typeof g.castsShadows !== "boolean") out.push(`${p}.light.castsShadows: expected a boolean`);
  if ("castsShadows" in g && g.type === "ambient") out.push(`${p}.light.castsShadows: an ambient light has no shadows (AE hides the option)`);
}

export function validateAeScene(scene: unknown): string[] {
  const out: string[] = [];
  if (!isObj(scene)) return ["scene: expected an object"];
  if (scene.schemaVersion !== AE_SCENE_SCHEMA_VERSION) out.push(`schemaVersion: expected ${AE_SCENE_SCHEMA_VERSION}`);
  if (!isStr(scene.generatedAt)) out.push("generatedAt: expected an ISO date string");
  if (!isStr(scene.toolboxVersion)) out.push("toolboxVersion: expected a string");

  const pj = scene.project;
  if (!isObj(pj)) out.push("project: expected project settings");
  else {
    if (![8, 16, 32].includes(pj.bitsPerChannel)) out.push("project.bitsPerChannel: expected 8, 16 or 32");
    if (typeof pj.linearBlending !== "boolean") out.push("project.linearBlending: expected a boolean");
    if ("workingSpace" in pj && !isStr(pj.workingSpace)) out.push("project.workingSpace: expected an ICC profile description");
    if ("linearizeWorkingSpace" in pj && typeof pj.linearizeWorkingSpace !== "boolean") out.push("project.linearizeWorkingSpace: expected a boolean");
    if (pj.expressionEngine !== "javascript-1.0") out.push('project.expressionEngine: expected "javascript-1.0"');
  }

  const ids = new Set<string>();
  const footage = new Map<string, any>();
  if (!Array.isArray(scene.footage)) out.push("footage: expected an array");
  else scene.footage.forEach((f: any, i: number) => {
    const p = `footage[${i}]`;
    if (!isObj(f) || !isStr(f.id) || !f.id) return void out.push(`${p}: expected {id, path, kind, alpha}`);
    if (ids.has(f.id)) out.push(`${p}.id: duplicate "${f.id}"`);
    ids.add(f.id);
    footage.set(f.id, f);
    if (!isStr(f.path) || !relativePath(f.path)) out.push(`${p}.path: expected a relative package path without ".."`);
    oneOf(f.kind, FOOTAGE_KINDS, `${p}.kind`, out);
    oneOf(f.alpha, FOOTAGE_ALPHA, `${p}.alpha`, out);
    if ("fps" in f && (!isNum(f.fps) || f.fps <= 0)) out.push(`${p}.fps: expected a positive number`);
  });

  const presets = new Set<string>();
  if (!Array.isArray(scene.presets)) out.push("presets: expected an array");
  else scene.presets.forEach((pr: any, i: number) => {
    if (!isObj(pr) || !isStr(pr.id) || !isStr(pr.path) || !relativePath(pr.path)) return void out.push(`presets[${i}]: expected {id, relative path}`);
    if (presets.has(pr.id)) out.push(`presets[${i}].id: duplicate "${pr.id}"`);
    presets.add(pr.id);
  });

  const comps = new Map<string, any>();
  if (!Array.isArray(scene.comps) || !scene.comps.length) out.push("comps: expected at least one comp");
  else scene.comps.forEach((c: any, i: number) => {
    if (!isObj(c) || !isStr(c.id) || !c.id) return void out.push(`comps[${i}]: expected a comp with an id`);
    if (ids.has(c.id)) out.push(`comps[${i}].id: duplicate "${c.id}" (comp and footage ids share one namespace)`);
    ids.add(c.id);
    comps.set(c.id, c);
  });

  for (const [ci, c] of [...comps.values()].entries()) {
    const cp = `comps[${ci}] "${c.name}"`;
    if (!isStr(c.name) || !c.name) out.push(`${cp}.name: expected a name`);
    for (const k of ["width", "height"]) if (!Number.isInteger(c[k]) || c[k] < 1 || c[k] > 30000) out.push(`${cp}.${k}: expected 1–30000 px`);
    if (!isNum(c.fps) || c.fps <= 0 || c.fps > 999) out.push(`${cp}.fps: expected 0–999`);
    if (!isNum(c.duration) || c.duration <= 0) out.push(`${cp}.duration: expected seconds > 0`);
    if ("bgColor" in c) rgb(c.bgColor, `${cp}.bgColor`, out);
    if ("renderer" in c) oneOf(c.renderer, RENDERERS, `${cp}.renderer`, out);
    if (!Array.isArray(c.layers)) {
      out.push(`${cp}.layers: expected an array`);
      continue;
    }
    const layerIds = new Map<string, any>();
    c.layers.forEach((L: any, li: number) => {
      if (!isObj(L) || !isStr(L.id)) return;
      if (layerIds.has(L.id)) out.push(`${cp}.layers[${li}].id: duplicate "${L.id}"`);
      layerIds.set(L.id, L);
    });
    c.layers.forEach((L: any, li: number) => {
      const p = `${cp}.layers[${li}] "${L?.name}"`;
      if (!isObj(L) || !isStr(L.id) || !L.id) return void out.push(`${p}: expected a layer with an id`);
      if (!isStr(L.name)) out.push(`${p}.name: expected a string`);
      oneOf(L.kind, LAYER_KINDS, `${p}.kind`, out);
      for (const k of ["inPoint", "outPoint", "startTime"]) num(L[k], `${p}.${k}`, out);
      if (isNum(L.inPoint) && isNum(L.outPoint) && !(L.outPoint > L.inPoint)) out.push(`${p}: outPoint must be after inPoint`);
      oneOf(L.blendingMode, BLEND_MODES, `${p}.blendingMode`, out);
      if ("parent" in L) {
        if (!layerIds.has(L.parent)) out.push(`${p}.parent: no layer "${L.parent}" in this comp`);
        else if (L.parent === L.id) out.push(`${p}.parent: a layer cannot parent itself`);
      }
      if ("matte" in L) {
        if (!isObj(L.matte) || !layerIds.has(L.matte.layer)) out.push(`${p}.matte.layer: no layer "${L.matte?.layer}" in this comp`);
        else if (L.matte.layer === L.id) out.push(`${p}.matte: a layer cannot matte itself`);
        if (isObj(L.matte)) oneOf(L.matte.type, MATTE_TYPES, `${p}.matte.type`, out);
      }
      layerTransform(L.transform, `${p}.transform`, out, L.kind);
      const nMasks = Array.isArray(L.masks) ? L.masks.length : 0;
      if ("masks" in L) {
        if (!Array.isArray(L.masks)) out.push(`${p}.masks: expected an array`);
        else L.masks.forEach((m: any, mi: number) => mask(m, `${p}.masks[${mi}]`, out));
      }
      if ("contents" in L) {
        if (L.kind !== "shape") out.push(`${p}.contents: only shape layers have contents`);
        shapeItems(L.contents, `${p}.contents`, out, presets);
      }
      if ("effects" in L) {
        if (!Array.isArray(L.effects)) out.push(`${p}.effects: expected an array`);
        else L.effects.forEach((fx: any, fi: number) => {
          const fp = `${p}.effects[${fi}]`;
          if (!isObj(fx) || !isStr(fx.match) || !fx.match) return void out.push(`${fp}: expected {match, props}`);
          if (!isObj(fx.props)) out.push(`${fp}.props: expected an object`);
          else for (const [k, v] of Object.entries(fx.props)) {
            const kp = `${fp}.props["${k}"]`;
            if (k.startsWith("#") && !/^#[1-9]\d*$/.test(k)) out.push(`${kp}: "#<1-based index>"`);
            else if (!k.startsWith("#") && !k.startsWith(`${fx.match}-`) && !k.startsWith("ADBE "))
              out.push(`${kp}: params are keyed by match name ("${fx.match}-0001") or "#<index>", not display name`);
            const ref = layerRefOf(v);
            if (ref !== undefined) {
              if (!layerIds.has(ref)) out.push(`${kp}: no layer "${ref}" in this comp`);
            } else if (isObj(v) && Array.isArray(v.keys) && v.keys.some((key: any) => isObj(key?.v) && "layerRef" in key.v)) {
              out.push(`${kp}: layer refs are static (no keys)`);
            } else prop(v, kp, out, () => {});
          }
          if ("compositingMask" in fx) {
            const m = fx.compositingMask?.mask;
            if (!Number.isInteger(m) || m < 1 || m > nMasks) out.push(`${fp}.compositingMask.mask: expected a mask index 1–${nMasks}`);
            else if (L.masks[m - 1].mode === "none") out.push(`${fp}.compositingMask: AE ignores a mask whose mode is "none" here (use add, or subtract for the inverse)`);
            prop(fx.compositingMask?.opacity, `${fp}.compositingMask.opacity`, out, num, { required: false });
          }
          if ("preset" in fx && !presets.has(fx.preset)) out.push(`${fp}.preset: "${fx.preset}" is not in scene.presets`);
        });
      }
      if ("text" in L) {
        if (L.kind !== "text") out.push(`${p}.text: only text layers have text`);
        if (!isObj(L.text)) out.push(`${p}.text: expected {document}`);
        else {
          prop(L.text.document, `${p}.text.document`, out, textDocument);
          if ("pathMask" in L.text && (!Number.isInteger(L.text.pathMask) || L.text.pathMask < 1 || L.text.pathMask > nMasks))
            out.push(`${p}.text.pathMask: expected a mask index 1–${nMasks}`);
          if ("animators" in L.text) {
            if (!Array.isArray(L.text.animators)) out.push(`${p}.text.animators: expected an array`);
            else L.text.animators.forEach((a: any, ai: number) => {
              const ap = `${p}.text.animators[${ai}]`;
              if (!isObj(a) || !isStr(a.name) || !isObj(a.properties)) return void out.push(`${ap}: expected {name, properties, selector}`);
              for (const [k, v] of Object.entries(a.properties)) prop(v, `${ap}.properties["${k}"]`, out, () => {});
              const s = a.selector;
              if (!isObj(s)) return void out.push(`${ap}.selector: expected a range selector`);
              oneOf(s.basedOn, TEXT_BASED_ON, `${ap}.selector.basedOn`, out);
              oneOf(s.units, new Set(["percentage", "index"]), `${ap}.selector.units`, out);
              oneOf(s.shape, TEXT_SHAPES, `${ap}.selector.shape`, out);
              for (const k of ["start", "end", "offset", "easeHigh", "easeLow"]) prop(s[k], `${ap}.selector.${k}`, out, num);
            });
          }
        }
      } else if (L.kind === "text") out.push(`${p}.text: a text layer needs a document`);
      if (L.kind === "precomp" || L.kind === "footage") {
        if (!ids.has(L.source)) out.push(`${p}.source: no footage or comp "${L.source}"`);
        else if (L.kind === "precomp" && !comps.has(L.source) && footage.get(L.source)?.kind !== "svg")
          out.push(`${p}.source: a precomp layer takes a comp id (or an SVG imported as a comp)`);
        if (L.source === c.id) out.push(`${p}.source: a comp cannot contain itself`);
        if (footage.get(L.source)?.kind === "model") {
          if (L.kind !== "footage" || L.threeD !== true) out.push(`${p}: a model is a 3-D footage layer (threeD true)`);
          if (c.renderer !== "advanced-3d") out.push(`${p}: a model layer needs its comp's renderer "advanced-3d"`);
        }
      } else if ("source" in L) {
        if (L.kind !== "shape") out.push(`${p}.source: only precomp, footage and shape layers have a source`);
        else if (footage.get(L.source)?.kind !== "svg") out.push(`${p}.source: a shape layer's source must be SVG footage`);
      }
      if ("solid" in L) {
        if (L.kind !== "solid" && L.kind !== "adjustment") out.push(`${p}.solid: only solid and adjustment layers`);
        rgb(L.solid?.color, `${p}.solid.color`, out);
        for (const k of ["width", "height"]) if (!Number.isInteger(L.solid?.[k]) || L.solid[k] < 1) out.push(`${p}.solid.${k}: expected px`);
      }
      if ("timeRemap" in L) {
        if (L.kind !== "precomp" && L.kind !== "footage") out.push(`${p}.timeRemap: only precomp and footage layers`);
        prop(L.timeRemap, `${p}.timeRemap`, out, num);
      }
      if ("origin" in L && (!Array.isArray(L.origin) || !L.origin.every(isStr))) out.push(`${p}.origin: expected node ids`);
      cameraLight(L, p, out);
    });
  }
  if (!comps.has(scene.main)) out.push(`main: no comp "${scene.main}"`);

  const r = scene.report;
  if (!isObj(r)) out.push("report: expected the plan report");
  else {
    oneOf(r.route, new Set(["direct", "direct+bake", "direct+shader", "blocked"]), "report.route", out);
    for (const k of ["native", "approx", "shader", "baked", "blocked", "warnings"]) if (!Array.isArray(r[k])) out.push(`report.${k}: expected an array`);
    if (!isObj(r.requires) || !Array.isArray(r.requires.fonts)) out.push("report.requires.fonts: expected an array");
  }
  return out;
}

// AeLayerRef as an effect prop: bare { layerRef } or { v: { layerRef } }.
function layerRefOf(v: unknown): string | undefined {
  if (isObj(v) && isStr(v.layerRef)) return v.layerRef;
  if (isObj(v) && isObj(v.v) && isStr(v.v.layerRef)) return v.v.layerRef;
  return undefined;
}

function relativePath(p: string): boolean {
  return !!p && !p.startsWith("/") && !/^[A-Za-z]:/.test(p) && !p.includes("\\") && !p.split("/").includes("..");
}
