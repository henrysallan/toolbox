// Bakes (spec §3 rung 6): an endpoint rendered by toolbox's own offline
// renderer into footage/<id>.mov (codec from policy), placed as a footage
// layer at the same stack position with the same in/out points. The package
// writer renders the AeBakeRequest; the scene only references the file.
//
// An animated endpoint bakes every frame of the AE layer's window; a static
// one bakes one frame, which AE imports as a still (held for the layer's
// whole duration) — what the planner's size estimate assumes.

import type { AeLayer } from "../types";
import { parseOut } from "./graph";
import { newLayer, rendered, type Rendered, type Scope } from "./layers";
import { animatedUpstream } from "./shape";

export function emitBake(scope: Scope, endpoint: string, reason: string, nodes?: string[]): Rendered {
  const { ctx, clock } = scope;
  const { id } = parseOut(endpoint);
  const members = nodes ?? [id];
  const pinned = members.filter((x) => ctx.overrides[x] === "procedural");
  if (pinned.length) {
    ctx.out.problems.push(`${endpoint} would bake (${reason}), but ${pinned.join(", ")} ${pinned.length === 1 ? "is" : "are"} marked "keep procedural" — fuse it into a shader (Convert with Claude) or allow the bake.`);
    return { layers: [] };
  }
  for (const m of members) if (m !== id && ctx.report) ctx.report.reclass(m, "bake", "bake", `baked with ${endpoint}`);
  ctx.report.reclass(id, "bake", "bake", `baked: ${reason}`);
  const fid = ctx.uid(`bake:${id}`);
  const path = `footage/${fid.replace(/[^A-Za-z0-9_.-]+/g, "_")}.mov`;
  const animated = animatedUpstream(ctx, id);
  // Composition frames: the container's frames shifted by its own offset
  // (inside a multi-window layer's precomp the container is that layer's
  // local clock — clock.compOffsetFrames maps it back).
  const shift = clock.compOffsetFrames ?? 0;
  const first = clock.inFrame + shift;
  const last = Math.max(clock.inFrame, clock.outFrame - 1) + shift;
  const frames: [number, number] = animated ? [first, last] : [first, first];
  // A one-frame movie imports as a still in AE (no frame rate to conform,
  // no time remap needed: a still spans any duration).
  ctx.out.footage.push({ id: fid, path, kind: "video", alpha: "straight", name: `${ctx.graph.name(id)} (baked)`, ...(animated ? { fps: ctx.fps } : {}) });
  ctx.out.bakes.push({
    id: fid,
    output: endpoint,
    frames,
    size: [ctx.canvas.width, ctx.canvas.height],
    codec: ctx.policy.bakeCodec,
    path,
    ...(clock.offsetTicks + shift * ctx.tpf ? { offsetTicks: clock.offsetTicks + shift * ctx.tpf } : {}),
    reason,
  });
  const L: AeLayer = newLayer(scope, "footage", `${ctx.graph.name(id)} (baked)`, members, { source: fid, startTime: clock.inFrame / ctx.fps });
  if (!animated) ctx.report.note(id, "static — one frame (AE holds a one-frame movie as a still)");
  return rendered(L);
}
