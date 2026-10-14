import type { Image } from "canvaskit-wasm";
import type { NodeDefinition, RenderContext, SkiaDrawValue } from "@/engine/types";
import { canvasKit, canvasKitError, canvasKitReady, ensureCanvasKit } from "@/engine/skia/canvaskit";
import { SKIA_IR_VERSION, type RGBA, type SkiaScene } from "@/engine/skia/scene-ir";
import { renderScene } from "@/engine/skia/scene-render";
import { makeSceneAssetResolver, sceneAssetGeneration } from "@/engine/skia/scene-assets";
import { renderSkiaToImage, skiaGpuError } from "@/engine/skia/sksl-render";
import { hexToRgba01 } from "@/engine/spline-fill";

// Skia Canvas — the terminal of a Skia layer (specdocs/101326_skia-target.md
// §3.1, §3.4). Its `scene` input is a SkiaNode tree built by the skia-*
// nodes upstream (pure data, like the SDF socket); this node is the one
// place it turns into pixels: CanvasKit draws the tree through
// engine/skia/scene-render.ts on the shared Skia surface, and the result is
// handed to the engine like the SkSL Shader node's (sksl-render.ts). The
// exporter reads the same tree, so what this node shows is what ships.
//
// Render problems (missing assets, SkSL that does not compile, IR the
// renderer cannot draw) never throw: the node draws everything it can,
// warns once per distinct problem set, and keeps the list for MCP
// (inspectSkiaCanvas).

interface CanvasState {
  lastWarned?: string | null;
  // Atlas sprite sheets drawn from a sub-scene (scene-render.ts
  // textureCache): rendered once, as React Native Skia's useTexture does.
  textures?: Map<string, Image>;
}

function getState(ctx: RenderContext, nodeId: string): CanvasState {
  const key = `skia-canvas:${nodeId}`;
  let s = ctx.state[key] as CanvasState | undefined;
  if (!s) {
    s = {};
    ctx.state[key] = s;
  }
  return s;
}

// Last render's problems per node, for get_graph / get_shader_errors.
const lastProblems = new Map<string, string[]>();

export function inspectSkiaCanvas(nodeId: string): { ok: boolean; problems: string[] } {
  const problems = lastProblems.get(nodeId) ?? [];
  return { ok: problems.length === 0, problems };
}

function background(params: Record<string, unknown>): RGBA | undefined {
  if (params.background_on !== true) return undefined;
  return hexToRgba01((params.background as string) ?? "#000000");
}

export const skiaCanvasNode: NodeDefinition = {
  type: "skia-canvas",
  name: "Skia Canvas",
  category: "utility",
  description:
    "Renders a Skia scene — the drawing tree built by Skia Fill, Skia Shape and Skia Group — with Skia itself (CanvasKit), so the preview is what the React Native Skia export draws. The scene is in canvas pixels, Y-down. Background is transparent unless switched on.",
  searchAliases: ["skia", "react native", "canvaskit", "render", "scene"],
  facts: {
    gotchas: [
      "Rendered by CanvasKit in its own WebGL context: until the WASM loads the output is transparent (or the background), then it re-renders.",
      "Group opacity and blend mode apply to each child draw, not to the group as a whole (React Native Skia's rule): overlapping children at 0.5 show their overlap.",
      "Render problems (missing assets, SkSL that fails to compile, unsupported IR) do not stop the frame: what can draw does, and the problem is warned once in the console.",
      "The scene is drawn at the render resolution; pixel params upstream (Skia Group translate, Skia Shape stroke_width) do not scale with output size.",
    ],
  },
  backend: "webgl2",
  skia: { class: "terminal" },
  // A Skia layer exports as one canvas; the engine's universal mask would be
  // a preview-only effect the device never applies.
  noMaskInput: true,
  inputs: [{ name: "scene", label: "Scene", type: "skia_draw", required: true }],
  params: [
    { name: "background_on", label: "Background", type: "boolean", default: false },
    {
      name: "background",
      label: "Color",
      type: "color",
      alpha: true,
      default: "#000000",
      visibleIf: (p) => p.background_on === true,
    },
  ],
  primaryOutput: "image",
  auxOutputs: [],
  // CanvasKit readiness busts the transparent placeholder rendered before
  // the WASM landed; the asset generation busts frames drawn while an image
  // or font was still loading.
  fingerprintExtras() {
    return `${canvasKitReady() ? "ck1" : "ck0"}|a:${sceneAssetGeneration()}`;
  },

  compute({ inputs, params, ctx, nodeId }) {
    const state = getState(ctx, nodeId);
    const bg = background(params);
    const plain = () => {
      const out = ctx.allocImage();
      ctx.clearTarget(out, bg ?? [0, 0, 0, 0]);
      return { primary: out };
    };
    const report = (problems: string[]) => {
      lastProblems.set(nodeId, problems);
      const msg = problems.join("\n");
      if (!problems.length) {
        state.lastWarned = null;
      } else if (state.lastWarned !== msg) {
        console.warn(`[Skia Canvas ${nodeId}] ${problems.join(" | ")}`);
        state.lastWarned = msg;
      }
    };

    const kit = canvasKit();
    if (!kit) {
      const err = canvasKitError();
      if (err) report([err]);
      else void ensureCanvasKit().catch(() => {});
      return plain();
    }

    const value = inputs.scene;
    if (!value || value.kind !== "skia_draw") {
      report([]);
      return plain();
    }
    const draw = value as SkiaDrawValue;
    const scene: SkiaScene = {
      version: SKIA_IR_VERSION,
      width: ctx.width,
      height: ctx.height,
      ...(bg ? { background: bg } : {}),
      root: draw.node,
      assets: draw.assets ?? {},
    };
    let problems: string[] = [];
    const out = renderSkiaToImage(ctx, kit, ctx.width, ctx.height, (canvas) => {
      const r = renderScene(kit, canvas, scene, { assets: makeSceneAssetResolver(kit), textureCache: (state.textures ??= new Map()) });
      problems = r.problems;
      return r.release;
    });
    if (!out) {
      report([skiaGpuError() ?? "CanvasKit render failed"]);
      return plain();
    }
    // Producer problems (an unported option upstream) ride on the value.
    report([...(draw.problems ?? []), ...problems]);
    return { primary: out };
  },

  dispose(ctx, nodeId) {
    const s = ctx.state[`skia-canvas:${nodeId}`] as CanvasState | undefined;
    for (const img of s?.textures?.values() ?? []) {
      try {
        img.delete();
      } catch {
        /* its context is gone */
      }
    }
    delete ctx.state[`skia-canvas:${nodeId}`];
    lastProblems.delete(nodeId);
  },
};
