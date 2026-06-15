import { OPACITY_PARAM } from "@/engine/conventions";
import {
  alphaBoundingBox,
  compositeOverAt,
  emptyElement,
  wrapImageAsElement,
} from "@/engine/element";
import {
  LAYOUT_ALIGN_OPTIONS,
  solveLayout,
  splitAlign,
  unitToPx,
  type LayoutAlign,
  type LayoutChildSpec,
  type LayoutDirection,
  type LayoutResult,
  type LayoutSpacing,
} from "@/engine/layout";
import type {
  AutoLayoutItem,
  ElementValue,
  ImageValue,
  InputSocketDef,
  NodeDefinition,
  RenderContext,
} from "@/engine/types";

// Figma-style auto layout as a node: pipe N elements in, choose direction,
// alignment, padding, gap; children size as fixed / hug-contents / fill-
// container. The container is itself an element (aux output), so layouts
// nest — hug propagates up, fill propagates down.
//
// All dimensions (padding, gap, fixed sizes, corner radius) are in layout
// units: 1 unit = 1/1000 of the canvas's smaller dimension, so values read
// like pixels at 1080p and the layout scales with project resolution.

export function newAutoLayoutItemId(): string {
  return `ali-${Math.random().toString(36).slice(2, 8)}`;
}

export function defaultAutoLayoutItem(id?: string): AutoLayoutItem {
  return {
    id: id ?? newAutoLayoutItemId(),
    widthMode: "hug",
    heightMode: "hug",
    width: 200,
    height: 200,
    fit: "cover",
    trim: false,
  };
}

// Rounded-rect background: fill + optional inner stroke. Standard SDF
// rounded box with a ~1.5px AA band, in container-local pixels. The stroke
// is an INNER band (sits just inside the edge) so it's never clipped by the
// container's own px texture. `u_color.a` / `u_stroke.a` of 0 disable that
// layer, so fill-only, stroke-only, and both all work from one pass.
const ROUNDED_BG_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform vec2 u_size;     // container px
uniform float u_radius;  // px
uniform vec4 u_color;    // fill rgba (a = 0 → no fill)
uniform vec4 u_stroke;   // stroke rgba (a = 0 → no stroke)
uniform float u_strokeW; // inner stroke width, px
out vec4 outColor;
void main() {
  vec2 p = (v_uv - 0.5) * u_size;
  vec2 b = max(0.5 * u_size - vec2(u_radius), vec2(0.0));
  vec2 q = abs(p) - b;
  float d = length(max(q, vec2(0.0))) + min(max(q.x, q.y), 0.0) - u_radius;
  // Fill: inside the shape (d < 0), AA across the edge.
  float aFill = 1.0 - smoothstep(-0.75, 0.75, d);
  vec4 fill = vec4(u_color.rgb, u_color.a * aFill);
  // Inner stroke: the band d ∈ [-u_strokeW, 0], AA on both edges.
  float aStroke = smoothstep(-0.75, 0.75, d + u_strokeW)
                - smoothstep(-0.75, 0.75, d);
  aStroke = clamp(aStroke, 0.0, 1.0) * u_stroke.a;
  vec4 strk = vec4(u_stroke.rgb, aStroke);
  // Stroke over fill — straight-alpha source-over.
  float outA = strk.a + fill.a * (1.0 - strk.a);
  vec3 outRgb = outA < 1e-4
    ? vec3(0.0)
    : (strk.rgb * strk.a + fill.rgb * fill.a * (1.0 - strk.a)) / outA;
  outColor = vec4(outRgb, outA);
}`;

// Place the container raster centered on the canvas, then apply the
// standard transform block (same math as the Text node's built-in
// transform — but without its Y flip, since the container texture is
// already in engine Y-up orientation).
const PLACE_TRANSFORM_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_src;
uniform vec4 u_rect;      // centered container rect in canvas UV (Y-up)
uniform vec2 u_translate; // screen convention (Y down)
uniform vec2 u_scale;
uniform float u_angle;
uniform vec2 u_pivot;     // screen convention (Y down)
out vec4 outColor;
void main() {
  vec2 pivot = vec2(u_pivot.x, 1.0 - u_pivot.y);
  vec2 translate = vec2(u_translate.x, -u_translate.y);
  vec2 uv = v_uv - translate;
  vec2 p = uv - pivot;
  float c = cos(-u_angle);
  float s = sin(-u_angle);
  p = vec2(c * p.x - s * p.y, s * p.x + c * p.y);
  p /= max(u_scale, vec2(0.0001));
  uv = p + pivot;
  vec2 local = (uv - u_rect.xy) / max(u_rect.zw, vec2(1e-6));
  if (local.x < 0.0 || local.x > 1.0 || local.y < 0.0 || local.y > 1.0) {
    outColor = vec4(0.0);
    return;
  }
  outColor = texture(u_src, local);
}`;

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  const s = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  const n = parseInt(s, 16);
  return [
    ((n >> 16) & 0xff) / 255,
    ((n >> 8) & 0xff) / 255,
    (n & 0xff) / 255,
  ];
}

interface ResolvedChild {
  item: AutoLayoutItem;
  element: ElementValue;
}

export const autoLayoutNode: NodeDefinition = {
  type: "autolayout",
  name: "Auto Layout",
  category: "image",
  subcategory: "modifier",
  description:
    "Figma-style auto layout: stacks element children horizontally or vertically with alignment, padding, and gap. Children size as fixed (layout units), hug-contents, or fill-container; the aux element output makes layouts nestable. Plain image wires coerce to full-canvas elements — use per-slot trim or a Frame node to size them.",
  backend: "webgl2",
  // On-canvas manipulation is the bounds gizmo (PRIMITIVE_GIZMO_ADAPTERS
  // "autolayout" entry): dragging moves translateX/Y, resizing an edge
  // writes that axis's fixed size in units (switching it off hug) with
  // the opposite side anchored. The symmetric scale gizmo is off — scale
  // params remain for panel/keyframe-driven squash effects.
  inputs: [],
  resolveInputs(params): InputSocketDef[] {
    const items = (params.items as AutoLayoutItem[]) ?? [];
    return items.map((item, i) => ({
      name: `item:${item.id}`,
      label: `item ${i + 1}`,
      type: "element",
      required: false,
    }));
  },
  params: [
    OPACITY_PARAM,
    {
      name: "items",
      label: "Items",
      type: "autolayout_items",
      default: [
        {
          id: "ali-initial",
          widthMode: "hug",
          heightMode: "hug",
          width: 200,
          height: 200,
          fit: "cover",
          trim: false,
        },
      ],
    },
    {
      name: "direction",
      label: "Direction",
      type: "enum",
      options: ["horizontal", "vertical"],
      default: "horizontal",
    },
    {
      name: "align",
      label: "Align",
      type: "enum",
      options: [...LAYOUT_ALIGN_OPTIONS],
      default: "center",
    },
    {
      name: "spacing",
      label: "Spacing",
      type: "enum",
      options: ["packed", "space-between"],
      default: "packed",
    },
    {
      name: "gap",
      label: "Gap (units)",
      type: "scalar",
      min: 0,
      max: 2000,
      softMax: 200,
      step: 1,
      default: 20,
    },
    {
      name: "paddingX",
      label: "Padding X (units)",
      type: "scalar",
      min: 0,
      max: 2000,
      softMax: 200,
      step: 1,
      default: 20,
    },
    {
      name: "paddingY",
      label: "Padding Y (units)",
      type: "scalar",
      min: 0,
      max: 2000,
      softMax: 200,
      step: 1,
      default: 20,
    },
    {
      name: "widthMode",
      label: "Width mode",
      type: "enum",
      options: ["hug", "fixed"],
      default: "hug",
    },
    {
      name: "width",
      label: "Width (units)",
      type: "scalar",
      min: 1,
      max: 4000,
      softMax: 1000,
      step: 1,
      default: 600,
      visibleIf: (p) => p.widthMode === "fixed",
    },
    {
      name: "heightMode",
      label: "Height mode",
      type: "enum",
      options: ["hug", "fixed"],
      default: "hug",
    },
    {
      name: "height",
      label: "Height (units)",
      type: "scalar",
      min: 1,
      max: 4000,
      softMax: 1000,
      step: 1,
      default: 600,
      visibleIf: (p) => p.heightMode === "fixed",
    },
    {
      name: "bgEnabled",
      label: "Background",
      type: "boolean",
      default: false,
    },
    {
      name: "bgColor",
      label: "BG color",
      type: "color",
      default: "#18181b",
      visibleIf: (p) => p.bgEnabled === true,
    },
    {
      name: "strokeEnabled",
      label: "Stroke",
      type: "boolean",
      default: false,
    },
    {
      name: "strokeColor",
      label: "Stroke color",
      type: "color",
      default: "#ffffff",
      visibleIf: (p) => p.strokeEnabled === true,
    },
    {
      name: "strokeWidth",
      label: "Stroke width (units)",
      type: "scalar",
      min: 0,
      max: 500,
      softMax: 50,
      step: 0.5,
      default: 4,
      visibleIf: (p) => p.strokeEnabled === true,
    },
    {
      name: "cornerRadius",
      label: "Corner radius (units)",
      type: "scalar",
      min: 0,
      max: 1000,
      softMax: 200,
      step: 1,
      default: 0,
      visibleIf: (p) => p.bgEnabled === true || p.strokeEnabled === true,
    },
    // Canvas placement — standard transform block (gizmo contract).
    {
      name: "translateX",
      label: "Translate X",
      type: "scalar",
      min: -1,
      max: 1,
      step: 0.001,
      default: 0,
    },
    {
      name: "translateY",
      label: "Translate Y",
      type: "scalar",
      min: -1,
      max: 1,
      step: 0.001,
      default: 0,
    },
    {
      name: "scaleX",
      label: "Scale X",
      type: "scalar",
      min: 0.01,
      max: 10,
      softMax: 4,
      step: 0.01,
      default: 1,
    },
    {
      name: "scaleY",
      label: "Scale Y",
      type: "scalar",
      min: 0.01,
      max: 10,
      softMax: 4,
      step: 0.01,
      default: 1,
    },
    {
      name: "rotate",
      label: "Rotate (°)",
      type: "scalar",
      min: -360,
      max: 360,
      step: 0.5,
      default: 0,
    },
    {
      name: "pivotX",
      label: "Pivot X",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.001,
      default: 0.5,
    },
    {
      name: "pivotY",
      label: "Pivot Y",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.001,
      default: 0.5,
    },
  ],
  primaryOutput: "image",
  auxOutputs: [
    {
      name: "element",
      type: "element",
      description:
        "The container as an element — wire into another Auto Layout to nest. Hug sizes propagate up; a fill slot in the parent re-solves this layout at the granted size. The canvas-placement transform params apply only to the primary image, not here (the parent layout owns placement).",
    },
  ],

  compute({ inputs, params, ctx }) {
    const items = (params.items as AutoLayoutItem[]) ?? [];

    // Resolve wired children in slot order. Trim swaps the element for a
    // re-wrap of its source texture cropped to the alpha bounding box
    // (identity-cached readback inside alphaBoundingBox).
    const children: ResolvedChild[] = [];
    for (const item of items) {
      const v = inputs[`item:${item.id}`];
      if (!v || v.kind !== "element") continue;
      let element = v;
      if (item.trim && v.sourceImage) {
        const region = alphaBoundingBox(ctx, v.sourceImage);
        element = region
          ? wrapImageAsElement(v.sourceImage, region)
          : emptyElement();
      }
      children.push({ item, element });
    }

    const u = (v: unknown, fallback: number) =>
      unitToPx(typeof v === "number" ? v : fallback, ctx);

    const containerBase = {
      direction: ((params.direction as string) ?? "horizontal") as LayoutDirection,
      align: ((params.align as string) ?? "center") as LayoutAlign,
      spacing: ((params.spacing as string) ?? "packed") as LayoutSpacing,
      gap: u(params.gap, 20),
      paddingX: u(params.paddingX, 20),
      paddingY: u(params.paddingY, 20),
      widthMode: (params.widthMode === "fixed" ? "fixed" : "hug") as
        | "fixed"
        | "hug",
      heightMode: (params.heightMode === "fixed" ? "fixed" : "hug") as
        | "fixed"
        | "hug",
      width: u(params.width, 600),
      height: u(params.height, 600),
    };

    const childSpecs: LayoutChildSpec[] = children.map(({ item, element }) => ({
      widthMode: item.widthMode,
      heightMode: item.heightMode,
      width: u(item.width, 200),
      height: u(item.height, 200),
      measure: (c) => element.measure(c),
    }));

    // One solver entry point for every path: the primary composite runs
    // it unforced; the aux element's measure/render force the container
    // size — which is exactly how fill-down works through nesting.
    const solve = (forcedW?: number, forcedH?: number): LayoutResult =>
      solveLayout(
        {
          ...containerBase,
          widthMode: forcedW != null ? "fixed" : containerBase.widthMode,
          width: forcedW ?? containerBase.width,
          heightMode: forcedH != null ? "fixed" : containerBase.heightMode,
          height: forcedH ?? containerBase.height,
        },
        childSpecs
      );

    const bgEnabled = params.bgEnabled === true;
    const strokeEnabled = params.strokeEnabled === true;
    const drawBg = bgEnabled || strokeEnabled;
    const [fr, fg, fb] = hexToRgb((params.bgColor as string) ?? "#18181b");
    const [sr, sg, sb] = hexToRgb((params.strokeColor as string) ?? "#ffffff");
    const radiusPx = u(params.cornerRadius, 0);
    const strokePx = strokeEnabled ? Math.max(0, u(params.strokeWidth, 0)) : 0;
    // Container alignment also governs where a child's fitted content sits
    // within its slot (contain letterbox / cover crop): "center-left"
    // leans the contained shape/image left, not just the slot.
    const contentAlign = splitAlign(containerBase.align);

    // Composite a solved layout into an exact container-px texture:
    // background (or transparent clear), then each child rendered at its
    // rect and source-over blitted in slot order — later slots draw over
    // earlier ones, matching Merge. Child textures release immediately.
    const compose = (rctx: RenderContext, layout: LayoutResult): ImageValue => {
      let current = rctx.allocImage({
        width: layout.width,
        height: layout.height,
      });
      if (drawBg) {
        const prog = rctx.getShader("autolayout/bg-stroke", ROUNDED_BG_FS);
        rctx.drawFullscreen(prog, current, (gl) => {
          gl.uniform2f(
            gl.getUniformLocation(prog, "u_size"),
            layout.width,
            layout.height
          );
          gl.uniform1f(gl.getUniformLocation(prog, "u_radius"), radiusPx);
          gl.uniform4f(
            gl.getUniformLocation(prog, "u_color"),
            fr,
            fg,
            fb,
            bgEnabled ? 1 : 0
          );
          gl.uniform4f(
            gl.getUniformLocation(prog, "u_stroke"),
            sr,
            sg,
            sb,
            strokeEnabled ? 1 : 0
          );
          gl.uniform1f(gl.getUniformLocation(prog, "u_strokeW"), strokePx);
        });
      } else {
        rctx.clearTarget(current, [0, 0, 0, 0]);
      }
      for (let i = 0; i < children.length; i++) {
        const rect = layout.rects[i];
        if (rect.width < 1 || rect.height < 1) continue;
        const childTex = children[i].element.render(
          rctx,
          rect.width,
          rect.height,
          {
            fit: children[i].item.fit,
            alignX: contentAlign.x,
            alignY: contentAlign.y,
          }
        );
        const next = compositeOverAt(rctx, current, childTex, rect);
        rctx.releaseTexture(childTex.texture);
        rctx.releaseTexture(current.texture);
        current = next;
      }
      return current;
    };

    // Primary: composite at natural size, center on the canvas, apply the
    // transform block.
    const layout = solve();
    const containerTex = compose(ctx, layout);
    const output = ctx.allocImage();
    const rectUv: [number, number, number, number] = [
      (ctx.width - layout.width) / 2 / ctx.width,
      (ctx.height - layout.height) / 2 / ctx.height,
      layout.width / ctx.width,
      layout.height / ctx.height,
    ];
    const angle = (((params.rotate as number) ?? 0) * Math.PI) / 180;
    const prog = ctx.getShader("autolayout/place", PLACE_TRANSFORM_FS);
    ctx.drawFullscreen(prog, output, (gl) => {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, containerTex.texture);
      gl.uniform1i(gl.getUniformLocation(prog, "u_src"), 0);
      gl.uniform4f(gl.getUniformLocation(prog, "u_rect"), ...rectUv);
      gl.uniform2f(
        gl.getUniformLocation(prog, "u_translate"),
        (params.translateX as number) ?? 0,
        (params.translateY as number) ?? 0
      );
      gl.uniform2f(
        gl.getUniformLocation(prog, "u_scale"),
        Math.max(0.0001, (params.scaleX as number) ?? 1),
        Math.max(0.0001, (params.scaleY as number) ?? 1)
      );
      gl.uniform1f(gl.getUniformLocation(prog, "u_angle"), angle);
      gl.uniform2f(
        gl.getUniformLocation(prog, "u_pivot"),
        (params.pivotX as number) ?? 0.5,
        (params.pivotY as number) ?? 0.5
      );
    });
    ctx.releaseTexture(containerTex.texture);

    // Aux: the container as an element. Same code path as the primary,
    // just with an externally-supplied size — this is nesting. Closures
    // capture this eval's children; valid while fingerprints hold (cache
    // entries pin upstream outputs — same contract as SDF textures).
    const element: ElementValue = {
      kind: "element",
      measure(constraints) {
        let l = solve();
        if (
          constraints.maxWidth != null &&
          containerBase.widthMode === "hug" &&
          l.width > constraints.maxWidth
        ) {
          // Re-solve under the narrower width so hug heights reflect
          // wrapped children (the nested-text-reflow moment).
          l = solve(Math.max(1, Math.round(constraints.maxWidth)));
        }
        let h = l.height;
        if (
          constraints.maxHeight != null &&
          containerBase.heightMode === "hug"
        ) {
          h = Math.min(h, constraints.maxHeight);
        }
        return { width: l.width, height: h };
      },
      render: (rctx, width, height) =>
        compose(
          rctx,
          solve(
            Math.max(1, Math.round(width)),
            Math.max(1, Math.round(height))
          )
        ),
      preferredSizing: { width: "hug", height: "hug" },
    };

    return { primary: output, aux: { element } };
  },
};
