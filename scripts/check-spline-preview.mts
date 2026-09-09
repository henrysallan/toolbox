// Guards the selected-node spline preview: a node whose primary is a spline
// (and has no image) should still resolve a spline for the viewport stroke.
// Rasterization itself needs a real canvas + GL (see rasterizeSplinePreview);
// this file checks the pick logic and that evaluateGraph doesn't throw when
// asked to preview a spline-only node on a stubbed backend.
//
// Run: npx tsx scripts/check-spline-preview.mts
/* eslint-disable @typescript-eslint/no-explicit-any */

const g = globalThis as any;
const stub = () => ({ getContext: () => null, style: {}, addEventListener() {} });
g.window ??= g;
g.self ??= g;
g.document ??= {
  createElement: stub,
  createElementNS: stub,
  fonts: { add() {}, forEach() {} },
  body: { appendChild() {} },
  addEventListener() {},
};
g.navigator ??= { userAgent: "node" };
g.HTMLCanvasElement ??= class {};
g.OffscreenCanvas ??= class { getContext() { return null; } };
g.WebGL2RenderingContext ??= class {};

const { registerNode } = await import("@/engine/registry");
const { evaluateGraph } = await import("@/engine/evaluator");
const { findSplineForPreview } = await import("@/engine/spline-preview");
import type { EvalCache } from "@/engine/evaluator";
import type { NodeOutput, SplineValue } from "@/engine/types";

let failures = 0;
function check(label: string, ok: boolean, detail = ""): void {
  if (ok) {
    console.log(`  ok  ${label}`);
  } else {
    failures++;
    console.error(`FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

const line: SplineValue = {
  kind: "spline",
  subpaths: [
    {
      anchors: [{ pos: [0.2, 0.5] }, { pos: [0.8, 0.5] }],
      closed: false,
    },
  ],
};

{
  const out: NodeOutput = { primary: line };
  check(
    "primary spline is the preview source",
    findSplineForPreview(out) === line
  );
}

{
  const img = { kind: "image" as const, texture: {} as WebGLTexture, width: 8, height: 8 };
  const out: NodeOutput = { primary: line, aux: { image: img } };
  check(
    "picker returns the primary spline regardless of other aux",
    findSplineForPreview(out) === line
  );
}

{
  const img = { kind: "image" as const, texture: {} as WebGLTexture, width: 8, height: 8 };
  const out: NodeOutput = { primary: img };
  check(
    "image-primary node is not a spline preview",
    findSplineForPreview(out) === undefined
  );
}

{
  const out: NodeOutput = {
    primary: { kind: "scalar", value: 0 },
    aux: { path: line },
  };
  check(
    "non-spline primary with spline aux is not a spline preview",
    findSplineForPreview(out) === undefined
  );
}

{
  const out: NodeOutput = {
    primary: { kind: "scalar", value: 0 },
    aux: { path: line },
  };
  check(
    "remapped spline handle is the preview source",
    findSplineForPreview(out, "out:aux:path") === line
  );
}

{
  const empty: SplineValue = { kind: "spline", subpaths: [] };
  check(
    "empty spline is still a spline (rasterizer returns null later)",
    findSplineForPreview({ primary: empty }) === empty
  );
}

registerNode({
  type: "test-spline-only",
  name: "Spline Only",
  category: "utility",
  backend: "webgl2",
  inputs: [],
  params: [],
  primaryOutput: "spline",
  auxOutputs: [],
  compute() {
    return { primary: line };
  },
} as any);

const ctx = {
  gl: {},
  width: 8,
  height: 8,
  time: 0,
  frame: 0,
  tick: 0,
  ticksPerFrame: 1000,
  fps: 30,
  playing: false,
  offline: false,
  cursor: { x: 0, y: 0, active: false },
  state: {},
  allocImage: () => ({ kind: "image", texture: {}, width: 8, height: 8 }),
  allocMask: () => ({ kind: "mask", texture: {}, width: 8, height: 8 }),
  allocUv: () => ({ kind: "uv", texture: {}, width: 8, height: 8 }),
  releaseTexture: () => {},
  drawFullscreen: () => {},
  clearTarget: () => {},
  getShader: () => ({}),
} as any;

{
  const cache: EvalCache = new Map();
  const nodes = [{ id: "s", type: "test-spline-only", params: {} }] as any;
  let threw = false;
  let result: ReturnType<typeof evaluateGraph> | undefined;
  try {
    result = evaluateGraph(nodes, [], ctx, cache, null, undefined, "s");
  } catch (e) {
    threw = true;
    console.error(e);
  }
  check("previewing a spline-only node does not throw", !threw);
  check(
    "stubbed GL leaves terminalImage unset (no fake pixels)",
    result?.terminalImage === undefined
  );
  check("the spline output itself still evaluates", result?.outputs.get("s")?.primary === line);
}

console.log(
  failures === 0
    ? "\nall spline-preview checks passed"
    : `\n${failures} spline-preview check(s) FAILED`
);
process.exit(failures === 0 ? 0 : 1);
