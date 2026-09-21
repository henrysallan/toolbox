// check-modulate-points: the attribute sources on Modulate Points
// (2026-09-20) — scale_attr multiplies the per-point scale by a point
// column (arity-1 channel or built-in broadcasts to x/y; an arity-2 channel
// scales x/y separately), rotate_attr adds value × rotate_attr_amount
// radians (default 2π = a turn per unit), both compound with the uniform
// inputs and the existing per-point values, a missing / blank column is
// ignored, and the no-op fast path still returns the input object itself.
// The image-field path needs GL and is a live-app question.
//
//   npx tsx scripts/check-modulate-points.mts

import type { NodeOutput, PointsValue, RenderContext, SocketValue } from "../src/engine/types.ts";
import { coerceValue } from "../src/engine/coerce.ts";
import { copyPointsWith, makePoints } from "../src/engine/points.ts";
import { modulatePointsNode } from "../src/nodes/effect/modulate-points.ts";

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  console.log(`${cond ? "ok  " : "FAIL"} ${name}${detail && !cond ? ` — ${detail}` : ""}`);
  if (!cond) failures++;
}
const close = (a: number, b: number, eps = 1e-5) => Math.abs(a - b) <= eps;
function fmt(arr: ArrayLike<number> | undefined): string {
  return arr ? Array.from(arr).map((v) => Math.round(v * 1000) / 1000).join(",") : "undefined";
}

function makeCtx(): RenderContext {
  return {
    time: 0,
    frame: 0,
    tick: 0,
    ticksPerFrame: 1000,
    fps: 60,
    playing: true,
    state: {},
    width: 1920,
    height: 1080,
  } as unknown as RenderContext;
}

function fresh(over: Record<string, unknown>): Record<string, unknown> {
  const p: Record<string, unknown> = {};
  for (const d of modulatePointsNode.params) p[d.name] = d.default;
  return { ...p, ...over };
}

// Three points stacked at one position (a field could not tell them
// apart), scale 2 and rotation 0.5 already on every point, with a 0 / 0.5
// / 1 `phase` channel and an arity-2 `sz` channel.
function stacked(): PointsValue {
  const pts = makePoints(3, { withScales: true, withRotations: true });
  pts.positions.set([0.5, 0.5, 0.5, 0.5, 0.5, 0.5]);
  pts.scales!.fill(2);
  pts.rotations!.fill(0.5);
  return copyPointsWith(pts, {
    attributes: {
      phase: { arity: 1, data: new Float32Array([0, 0.5, 1]) },
      sz: { arity: 2, data: new Float32Array([1, 2, 3, 4, 5, 6]) },
    },
  });
}

function run(
  input: PointsValue,
  params: Record<string, unknown>,
  wired: { scale_mul?: number; rotate_add?: number } = {}
): PointsValue | undefined {
  const ctx = makeCtx();
  const inputs: Record<string, SocketValue | undefined> = {
    points: coerceValue(input, "points", ctx),
  };
  if (wired.scale_mul !== undefined) inputs.scale_mul = coerceValue({ kind: "scalar", value: wired.scale_mul }, "scalar", ctx);
  if (wired.rotate_add !== undefined) inputs.rotate_add = coerceValue({ kind: "scalar", value: wired.rotate_add }, "scalar", ctx);
  const out = modulatePointsNode.compute({
    inputs,
    auxIn: {},
    params,
    ctx,
    nodeId: "mp",
    consumedOutputs: new Set(["primary"]),
  } as Parameters<typeof modulatePointsNode.compute>[0]) as NodeOutput;
  return out.primary?.kind === "points" ? out.primary : undefined;
}

const src = stacked();

// --- def --------------------------------------------------------------------
{
  const names = new Set(modulatePointsNode.params.map((p) => p.name));
  check("def: scale_attr / rotate_attr / rotate_attr_amount declared", names.has("scale_attr") && names.has("rotate_attr") && names.has("rotate_attr_amount"));
  const sa = modulatePointsNode.params.find((p) => p.name === "scale_attr")!;
  check(
    "def: attribute names suggest from the points input, require existence, and offer built-ins",
    sa.suggestAttrsFrom === "points" && sa.suggestAttrsRequire === true && sa.suggestAttrsIncludeBuiltins === true
  );
  const amt = modulatePointsNode.params.find((p) => p.name === "rotate_attr_amount")!;
  check("def: rotate_attr_amount defaults to one turn per unit", close(amt.default as number, 2 * Math.PI));
  check(
    "def: rotate_attr_amount shows only once a rotate attribute is named",
    !(amt.visibleIf?.({ rotate_attr: "" }) ?? true) && (amt.visibleIf?.({ rotate_attr: "phase" }) ?? true)
  );
  check(
    "def: facts read/write scale and rotation",
    (modulatePointsNode.facts?.writes ?? []).includes("attr:scale") && (modulatePointsNode.facts?.writes ?? []).includes("attr:rotation")
  );
}

// --- no-op fast path ---------------------------------------------------------
{
  check("defaults with no attribute names → the input object itself", run(src, fresh({})) === src);
  check("a blank / whitespace attribute name is still the no-op", run(src, fresh({ scale_attr: "  ", rotate_attr: "" })) === src);
  check("a MISSING column is ignored, not an error → the input object itself", run(src, fresh({ scale_attr: "nope", rotate_attr: "nada" })) === src);
}

// --- scale_attr ---------------------------------------------------------------
{
  const out = run(src, fresh({ scale_attr: "phase" }));
  check(
    "arity-1 channel multiplies BOTH axes of the existing scale (2 × phase)",
    !!out && close(out.scales![0], 0) && close(out.scales![1], 0) && close(out.scales![2], 1) && close(out.scales![3], 1) && close(out.scales![4], 2) && close(out.scales![5], 2),
    fmt(out?.scales)
  );
  check("scale_attr leaves rotation alone", !!out && close(out.rotations![0], 0.5) && close(out.rotations![2], 0.5));
  check("positions are shared, not copied", !!out && out.positions === src.positions);

  const xy = run(src, fresh({ scale_attr: "sz" }));
  check(
    "arity-2 channel scales x and y separately (2 × [1,2],[3,4],[5,6])",
    !!xy && close(xy.scales![0], 2) && close(xy.scales![1], 4) && close(xy.scales![2], 6) && close(xy.scales![3], 8) && close(xy.scales![4], 10) && close(xy.scales![5], 12),
    fmt(xy?.scales)
  );

  const comp = run(src, fresh({ scale_attr: "sz.y" }));
  check(
    "a dotted component broadcasts that component (2 × sz.y)",
    !!comp && close(comp.scales![0], 4) && close(comp.scales![1], 4) && close(comp.scales![4], 12),
    fmt(comp?.scales)
  );

  const idx = run(src, fresh({ scale_attr: "index" }));
  check(
    "a built-in column (index) is readable — stacked points get distinct scales",
    !!idx && close(idx.scales![0], 0) && close(idx.scales![2], 2) && close(idx.scales![4], 4),
    fmt(idx?.scales)
  );

  const both = run(src, fresh({ scale_attr: "phase" }), { scale_mul: 3 });
  check(
    "compounds with the uniform input (2 × 3 × phase)",
    !!both && close(both.scales![2], 3) && close(both.scales![4], 6),
    fmt(both?.scales)
  );
}

// --- rotate_attr ------------------------------------------------------------
{
  const out = run(src, fresh({ rotate_attr: "phase" }));
  check(
    "default amount: 0.5 phase → +π on the existing 0.5 rad",
    !!out && close(out.rotations![0], 0.5) && close(out.rotations![1], 0.5 + Math.PI) && close(out.rotations![2], 0.5 + 2 * Math.PI),
    fmt(out?.rotations)
  );
  check("rotate_attr leaves scale alone", !!out && close(out.scales![0], 2) && close(out.scales![5], 2));

  const amt = run(src, fresh({ rotate_attr: "phase", rotate_attr_amount: 1 }));
  check("rotate_attr_amount=1 adds the raw value in radians", !!amt && close(amt.rotations![1], 1) && close(amt.rotations![2], 1.5), fmt(amt?.rotations));

  const both = run(src, fresh({ rotate_attr: "phase", rotate_attr_amount: 1 }), { rotate_add: 0.25 });
  check("compounds with the uniform rotate input", !!both && close(both.rotations![1], 1.25), fmt(both?.rotations));

  // Points with no scale / rotation arrays at all materialize them.
  const bare = copyPointsWith(makePoints(2), {
    attributes: { phase: { arity: 1, data: new Float32Array([0.25, 0.5]) } },
  });
  const b = run(bare, fresh({ scale_attr: "phase", rotate_attr: "phase", rotate_attr_amount: 2 }));
  check(
    "bare points: scale starts at 1, rotation at 0",
    !!b && close(b.scales![0], 0.25) && close(b.scales![1], 0.25) && close(b.scales![2], 0.5) && close(b.rotations![0], 0.5) && close(b.rotations![1], 1),
    `${fmt(b?.scales)} / ${fmt(b?.rotations)}`
  );
}

console.log(`\ncheck-modulate-points: ${failures === 0 ? "all passed" : `${failures} failure(s)`}`);
process.exit(failures ? 1 : 0);
