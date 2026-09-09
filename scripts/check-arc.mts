// Guards Arc's optional center/start/end vec2 sockets: unwired polar
// path is unchanged; a wired socket places that anchor exactly; both
// endpoints wired refit a circle through them.
//
//   npx tsx scripts/check-arc.mts

import type {
  NodeOutput,
  RenderContext,
  SocketValue,
  SplineValue,
} from "../src/engine/types.ts";
import { coerceValue } from "../src/engine/coerce.ts";
import { arcNode } from "../src/nodes/source/arc.ts";

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) {
    console.log(`PASS  ${name}`);
  } else {
    failures++;
    console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function close(a: number, b: number, eps = 1e-6): boolean {
  return Math.abs(a - b) < eps;
}

function posClose(
  a: [number, number] | undefined,
  b: [number, number],
  eps = 1e-6
): boolean {
  return !!a && close(a[0], b[0], eps) && close(a[1], b[1], eps);
}

function makeCtx(): RenderContext {
  return {
    time: 0,
    playing: true,
    state: {},
    width: 1920,
    height: 1080,
  } as unknown as RenderContext;
}

const OFF = { stroke_enabled: false, fill_enabled: false };

function vec2(x: number, y: number): SocketValue {
  const ctx = makeCtx();
  const coerced = coerceValue(
    { kind: "vec2", value: [x, y] },
    "vec2",
    ctx
  );
  if (coerced?.kind !== "vec2") {
    throw new Error(`coerceValue dropped vec2 (${x}, ${y})`);
  }
  return coerced;
}

function evalArc(
  inputs: Record<string, SocketValue | undefined>,
  params: Record<string, unknown> = {}
): SplineValue {
  const ctx = makeCtx();
  const coerced: Record<string, SocketValue | undefined> = {};
  for (const [name, value] of Object.entries(inputs)) {
    const sock = arcNode.inputs.find((s) => s.name === name);
    coerced[name] = coerceValue(value, sock?.type ?? "vec2", ctx);
  }
  const out = arcNode.compute({
    inputs: coerced,
    auxIn: {},
    params: { ...OFF, ...params },
    ctx,
    nodeId: "arc",
  }) as NodeOutput;
  if (out.primary?.kind !== "spline") {
    throw new Error("Arc did not emit a spline");
  }
  return out.primary;
}

function endpoints(s: SplineValue, pie = false) {
  const a = s.subpaths[0]?.anchors ?? [];
  if (pie) {
    return {
      center: a[0]?.pos,
      start: a[1]?.pos,
      end: a[a.length - 1]?.pos,
    };
  }
  return { start: a[0]?.pos, end: a[a.length - 1]?.pos };
}

check(
  "declares center/start/end vec2 sockets",
  ["center", "start", "end"].every((name) =>
    arcNode.inputs.some((s) => s.name === name && s.type === "vec2" && !s.required)
  )
);

{
  const s = evalArc({});
  const e = endpoints(s);
  check(
    "unwired open arc keeps polar start (0.8, 0.5)",
    posClose(e.start, [0.8, 0.5]),
    e.start ? `got (${e.start[0]}, ${e.start[1]})` : "missing"
  );
  check(
    "unwired open arc keeps polar end (0.5, 0.2)",
    posClose(e.end, [0.5, 0.2]),
    e.end ? `got (${e.end[0]}, ${e.end[1]})` : "missing"
  );
}

{
  const s = evalArc({ center: vec2(0.2, 0.3) });
  const e = endpoints(s);
  check(
    "center socket shifts the polar arc",
    posClose(e.start, [0.5, 0.3]) && posClose(e.end, [0.2, 0.0]),
    e.start && e.end
      ? `start (${e.start[0]}, ${e.start[1]}) end (${e.end[0]}, ${e.end[1]})`
      : "missing"
  );
}

{
  const s = evalArc({ start: vec2(0.9, 0.6) });
  const e = endpoints(s);
  check(
    "start socket places the first anchor exactly",
    posClose(e.start, [0.9, 0.6]),
    e.start ? `got (${e.start[0]}, ${e.start[1]})` : "missing"
  );
}

{
  const s = evalArc({ end: vec2(0.4, 0.8) });
  const e = endpoints(s);
  check(
    "end socket places the last anchor exactly",
    posClose(e.end, [0.4, 0.8]),
    e.end ? `got (${e.end[0]}, ${e.end[1]})` : "missing"
  );
}

{
  const start: [number, number] = [0.7, 0.45];
  const end: [number, number] = [0.35, 0.75];
  const s = evalArc({ start: vec2(...start), end: vec2(...end) });
  const e = endpoints(s);
  check(
    "start+end sockets place both anchors exactly",
    posClose(e.start, start) && posClose(e.end, end),
    e.start && e.end
      ? `start (${e.start[0]}, ${e.start[1]}) end (${e.end[0]}, ${e.end[1]})`
      : "missing"
  );
  const anchors = s.subpaths[0]?.anchors ?? [];
  const mid = anchors[Math.floor(anchors.length / 2)]?.pos;
  check(
    "fitted arc stays circular (midpoint equidistant)",
    !!e.start &&
      !!e.end &&
      !!mid &&
      (() => {
        // Reconstruct center as circumcenter-equivalent: intersection of
        // perp bisector already happened; check |mid-start| radii via
        // any interior anchor sharing the start/end radius from a
        // recovered center. Use the fact that start, mid, end should
        // have equal distance to the unique circle through start+end
        // nearest the param center (0.5, 0.5).
        const mx = (start[0] + end[0]) / 2;
        const my = (start[1] + end[1]) / 2;
        const dx = end[0] - start[0];
        const dy = end[1] - start[1];
        const chord = Math.hypot(dx, dy);
        const nx = -dy / chord;
        const ny = dx / chord;
        const t = (0.5 - mx) * nx + (0.5 - my) * ny;
        const cx = mx + t * nx;
        const cy = my + t * ny;
        const r0 = Math.hypot(start[0] - cx, start[1] - cy);
        const rm = Math.hypot(mid[0] - cx, mid[1] - cy);
        return close(r0, rm, 1e-5);
      })(),
    mid ? `mid (${mid[0]}, ${mid[1]})` : "missing mid"
  );
}

{
  const s = evalArc(
    { center: vec2(0.4, 0.4) },
    { mode: "pie" }
  );
  const e = endpoints(s, true);
  check(
    "pie mode uses the wired center as the first anchor",
    posClose(e.center, [0.4, 0.4]),
    e.center ? `got (${e.center[0]}, ${e.center[1]})` : "missing"
  );
}

{
  const start: [number, number] = [0.8, 0.5];
  const end: [number, number] = [0.5, 0.2];
  const s = evalArc(
    { start: vec2(...start), end: vec2(...end) },
    { startAngle: 0, endAngle: 270 }
  );
  const e = endpoints(s);
  // Default 270° clockwise from 3 o'clock to 12 o'clock goes through
  // 6 o'clock then 9 o'clock (bottom/left). The minor alternative would
  // cut through the top-right.
  const anchors = s.subpaths[0]?.anchors ?? [];
  const mid = anchors[Math.floor(anchors.length / 2)]?.pos;
  check(
    "start+end keep the major clockwise sweep from the angle params",
    !!mid && mid[0] < 0.45,
    mid ? `mid (${mid[0]}, ${mid[1]})` : "missing mid"
  );
  check(
    "default-position sockets still land on the polar endpoints",
    posClose(e.start, start) && posClose(e.end, end)
  );
}

if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nall passed");
