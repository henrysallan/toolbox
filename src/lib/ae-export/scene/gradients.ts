// Gradient stops → AE (spec §13 "The gradient route"). `ADBE Vector Grad
// Colors` is not scriptable, so every gradient item takes one of two routes:
//
//   ffx  a synthesized preset per item (runtime/ffx.ts), applied by build.jsx
//        to the item's Colors property — only in the After Effects app
//   svg  the whole shape layer seeded from an SVG import (AeLayer.source):
//        only for layers whose contents are static paths in groups with flat
//        or gradient fills and plain strokes, which SVG expresses exactly.

import { synthesizeScenePresets } from "../runtime/ffx";
import type { AeFootage, AeLayer, AePath, AeProp, AeScene, AeShapeItem } from "../types";
import type { WalkCtx } from "./context";

type Grad = Extract<AeShapeItem, { kind: "gradient-fill" | "gradient-stroke" }>;

function gradients(items: AeShapeItem[], out: Grad[] = []): Grad[] {
  for (const it of items) {
    if (it.kind === "group") gradients(it.contents, out);
    else if (it.kind === "gradient-fill" || it.kind === "gradient-stroke") out.push(it);
  }
  return out;
}

const stat = <T>(p: AeProp<T> | undefined): T | undefined => (p && "v" in p && !p.expression ? p.v : undefined);
const hex = (c: readonly number[]) => `#${c.slice(0, 3).map((x) => Math.round(Math.max(0, Math.min(1, x)) * 255).toString(16).padStart(2, "0")).join("")}`;
const num = (x: number) => (Math.round(x * 1000) / 1000).toString();

function pathD(p: AePath): string {
  const n = p.vertices.length;
  if (!n) return "";
  const v = p.vertices;
  const parts = [`M${num(v[0][0])} ${num(v[0][1])}`];
  const seg = (i: number, j: number) => {
    const a = v[i];
    const b = v[j];
    const c1 = [a[0] + p.outTangents[i][0], a[1] + p.outTangents[i][1]];
    const c2 = [b[0] + p.inTangents[j][0], b[1] + p.inTangents[j][1]];
    parts.push(`C${num(c1[0])} ${num(c1[1])} ${num(c2[0])} ${num(c2[1])} ${num(b[0])} ${num(b[1])}`);
  };
  for (let i = 0; i + 1 < n; i++) seg(i, i + 1);
  if (p.closed) {
    seg(n - 1, 0);
    parts.push("Z");
  }
  return parts.join(" ");
}

const K = 0.5522847498307933;

// A static parametric shape item as its path (SVG has no AE parametrics).
function itemPath(it: AeShapeItem): AePath | null {
  if (it.kind === "path") return stat(it.path) ?? null;
  if (it.kind === "ellipse") {
    const c = stat(it.position);
    const sz = stat(it.size);
    if (!c || !sz) return null;
    const rx = sz[0] / 2;
    const ry = sz[1] / 2;
    return {
      vertices: [[c[0], c[1] - ry], [c[0] + rx, c[1]], [c[0], c[1] + ry], [c[0] - rx, c[1]]],
      inTangents: [[-rx * K, 0], [0, -ry * K], [rx * K, 0], [0, ry * K]],
      outTangents: [[rx * K, 0], [0, ry * K], [-rx * K, 0], [0, -ry * K]],
      closed: true,
    };
  }
  if (it.kind === "rect") {
    const c = stat(it.position);
    const sz = stat(it.size);
    const r = stat(it.roundness);
    if (!c || !sz || r !== 0) return null;
    const [x0, y0, x1, y1] = [c[0] - sz[0] / 2, c[1] - sz[1] / 2, c[0] + sz[0] / 2, c[1] + sz[1] / 2];
    const z: [number, number] = [0, 0];
    return { vertices: [[x0, y0], [x1, y0], [x1, y1], [x0, y1]], inTangents: [z, z, z, z], outTangents: [z, z, z, z], closed: true };
  }
  return null;
}

// The layer as one SVG, or null when SVG cannot express its contents.
function layerSvg(L: AeLayer, W: number, H: number): string | null {
  const defs: string[] = [];
  const body: string[] = [];
  let gi = 0;
  for (const g of L.contents ?? []) {
    if (g.kind !== "group" || g.transform || g.blendMode) return null;
    const paths: string[] = [];
    let fill: string | null = null;
    let fillRule = "nonzero";
    let stroke: string | null = null;
    for (const it of g.contents) {
      if (it.kind === "path" || it.kind === "ellipse" || it.kind === "rect") {
        const p = itemPath(it);
        if (!p) return null;
        paths.push(pathD(p));
      } else if (it.kind === "fill") {
        const c = stat(it.color);
        const o = stat(it.opacity);
        if (!c || o === undefined) return null;
        fill = `fill="${hex(c)}" fill-opacity="${num(o / 100)}"`;
        fillRule = it.rule;
      } else if (it.kind === "gradient-fill") {
        const s = stat(it.start);
        const e = stat(it.end);
        const o = stat(it.opacity);
        if (!s || !e || o === undefined) return null;
        const id = `g${gi++}`;
        const stops = it.stops.colors.map((c, k) => `<stop offset="${num(c.offset)}" stop-color="${hex(c.color)}" stop-opacity="${num(it.stops.opacities[k]?.opacity ?? 1)}"/>`).join("");
        defs.push(
          it.type === "radial"
            ? `<radialGradient id="${id}" gradientUnits="userSpaceOnUse" cx="${num(s[0])}" cy="${num(s[1])}" r="${num(Math.hypot(e[0] - s[0], e[1] - s[1]))}">${stops}</radialGradient>`
            : `<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="${num(s[0])}" y1="${num(s[1])}" x2="${num(e[0])}" y2="${num(e[1])}">${stops}</linearGradient>`
        );
        fill = `fill="url(#${id})" fill-opacity="${num(o / 100)}"`;
        fillRule = it.rule ?? "nonzero";
      } else if (it.kind === "stroke") {
        const c = stat(it.color);
        const o = stat(it.opacity);
        const w = stat(it.width);
        if (!c || o === undefined || w === undefined || it.dashes || it.taper) return null;
        stroke = `stroke="${hex(c)}" stroke-opacity="${num(o / 100)}" stroke-width="${num(w)}" stroke-linecap="${it.cap}" stroke-linejoin="${it.join}" stroke-miterlimit="${num(it.miterLimit)}"`;
      } else return null;
    }
    if (!paths.length) return null;
    body.push(`<path d="${paths.join(" ")}" ${fill ?? 'fill="none"'} fill-rule="${fillRule === "evenodd" ? "evenodd" : "nonzero"}" ${stroke ?? ""}/>`);
  }
  if (!defs.length) return null;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><defs>${defs.join("")}</defs>${body.join("")}</svg>\n`;
}

export function routeGradients(ctx: WalkCtx, scene: AeScene, route: "ffx" | "svg"): void {
  let ffx = 0;
  for (const comp of scene.comps) {
    for (const L of comp.layers) {
      if (L.kind !== "shape" || !L.contents) continue;
      const gs = gradients(L.contents);
      if (!gs.length) continue;
      if (route === "svg" && !L.source) {
        const svg = layerSvg(L, comp.width, comp.height);
        if (svg) {
          const id = ctx.uid(`svg:${L.id}`);
          const path = `footage/${id.replace(/[^A-Za-z0-9_.-]+/g, "_")}.svg`;
          const f: AeFootage = { id, path, kind: "svg", alpha: "straight", name: `${L.name} (SVG)` };
          scene.footage.push(f);
          ctx.out.files.push({ path, text: svg });
          L.source = id;
          L.contents = [];
          for (const o of L.origin ?? []) ctx.report.note(o, "gradient → an SVG-seeded shape layer (native, editable Gradient Fill)");
          continue;
        }
      }
      for (const g of gs) {
        const id = ctx.uid(`grad-${L.id}`).replace(/[^A-Za-z0-9_-]+/g, "_");
        g.preset = id;
        scene.presets.push({ id, path: `presets/${id}.ffx` });
        ffx++;
      }
      for (const o of L.origin ?? []) ctx.report.note(o, "gradient stops via a synthesized .ffx preset (applied when build.jsx runs in the After Effects app)");
    }
  }
  if (ffx) {
    const w = `${ffx} gradient${ffx === 1 ? "" : "s"} carry their stops in synthesized .ffx presets: run build.jsx in the After Effects app (File → Scripts, or Build in After Effects) — a headless aerender build keeps AE's default gradient.`;
    ctx.report.warn(w);
    ctx.out.warnings.push(w);
    for (const p of synthesizeScenePresets(scene)) {
      const pr = scene.presets.find((x) => x.path === p.path)!;
      ctx.out.presets.push({ id: pr.id, path: p.path, bytes: p.bytes });
    }
  }
}
