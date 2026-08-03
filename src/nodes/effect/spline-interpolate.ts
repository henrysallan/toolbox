import type {
  InputSocketDef,
  NodeDefinition,
  RenderContext,
  SocketType,
  SplineSubpath,
  SplineValue,
} from "@/engine/types";
import {
  buildMorphCorrespondence,
  applyMorph,
  type MorphCorrespondence,
} from "@/engine/spline-morph";
import { measureSpline, sampleSplineAt } from "@/engine/spline-math";
import { transformSpline } from "@/engine/spline-transform";

// Spline Interpolate — feed N splines into auto-growing sockets and get back a
// single spline containing the inputs PLUS `count` interpolated in-between
// shapes, spread evenly across the whole A→…→Z chain (total, not per gap).
// Each output subpath is groupIndex-tagged in chain order so Select by Index /
// Count Indices / Copy-to-Points can address the family.
//
// Reuses engine/spline-morph: for each ADJACENT pair of inputs we build a
// MorphCorrespondence once (resample to a matched anchor count + orientation /
// start-vertex alignment + subpath pairing), then sample an in-between at any t
// with a cheap per-anchor lerp (applyMorph). The correspondence depends only on
// the pair shapes + resolution — NOT on count — so sweeping count is nearly
// free; we cache the per-segment correspondences by input-object identity
// (upstream hands us new SplineValue objects exactly when geometry changed).
//
// Sibling to Spline Morph (spline-morph.ts): that node is a two-input, animated,
// rasterizing A→B tween; this one is a multi-input, static, spline-out family
// generator on the same engine. Design: specdocs/070626_spline-interpolate.md.

const EMPTY_SPLINE: SplineValue = { kind: "spline", subpaths: [] };

// Slots — the auto-grow input list, identical convention to Proximity
// Join/Merge. The normalization effect in EffectsApp keeps this equal to
// (connected sockets) + one trailing empty spare. Default ["in"] shows a single
// empty socket on a fresh node and needs no migration for any future save.
function readSlots(params: Record<string, unknown>): string[] {
  const s = params.slots;
  if (Array.isArray(s) && s.every((x) => typeof x === "string") && s.length) {
    return s as string[];
  }
  return ["in"];
}

interface InterpState {
  // Per-segment correspondences (one per adjacent input pair) plus the input
  // identities + resolution they were built from, so we rebuild only when a
  // shape or resolution changes — not when count sweeps.
  inputs: SplineValue[];
  res: number;
  corrs: MorphCorrespondence[];
}

function ensureState(ctx: RenderContext, nodeId: string): InterpState {
  const key = `spline-interpolate:${nodeId}`;
  let s = ctx.state[key] as InterpState | undefined;
  if (!s) {
    s = { inputs: [], res: 0, corrs: [] };
    ctx.state[key] = s;
  }
  return s;
}

function sameInputs(a: SplineValue[], b: SplineValue[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// Flatten a chain-ordered list of subpath groups into one SplineValue, tagging
// each group with its position so downstream per-index ops walk the family in
// order. Anchor arrays are shared by reference (read-only downstream — same as
// the Combine node).
function tagGroups(groups: SplineSubpath[][]): SplineValue {
  const subpaths: SplineSubpath[] = [];
  groups.forEach((subs, idx) => {
    for (const s of subs) {
      subpaths.push({ anchors: s.anchors, closed: s.closed, groupIndex: idx });
    }
  });
  return { kind: "spline", subpaths };
}

export const splineInterpolateNode: NodeDefinition = {
  type: "spline-interpolate",
  name: "Spline Interpolate",
  category: "spline",
  subcategory: "modifier",
  description:
    "Interpolate between 2 or more splines. Feed shapes into the auto-growing sockets (there's always one spare) and get a single spline containing the inputs plus a set number of interpolated in-betweens, spread evenly across the whole sequence. Shapes are auto-aligned by orientation and start vertex; each output subpath is groupIndex-tagged in order for Select by Index / Copy-to-Points. Wire a spline into the Spine socket to distribute the whole family along it (the Illustrator Blend-along-a-path move), optionally rotated to the spine's tangent.",
  backend: "webgl2",
  noMaskInput: true,
  inputs: [
    { name: "in", type: "spline", required: false, label: "Spline" },
    { name: "spine", type: "spline", required: false, label: "Spine" },
  ],
  resolveInputs(params): InputSocketDef[] {
    const slots = readSlots(params);
    return [
      ...slots.map((name, i) => ({
        name,
        type: "spline" as SocketType,
        required: false,
        label: slots.length > 1 ? `Spline ${i + 1}` : "Spline",
      })),
      // Blend spine (spec 072726 M4): when wired, the whole family
      // distributes along it. A FIXED socket — the auto-grow slots effect
      // in EffectsApp excludes it by name.
      {
        name: "spine",
        type: "spline" as SocketType,
        required: false,
        label: "Spine",
      },
    ];
  },
  params: [
    {
      name: "count",
      label: "In-betweens",
      type: "scalar",
      min: 0,
      max: 200,
      softMax: 24,
      step: 1,
      default: 5,
    },
    {
      // Anchors each shape is resampled to before interpolating. Higher tracks
      // the source curves more closely; heavier per correspondence rebuild.
      name: "resolution",
      label: "Resolution",
      type: "scalar",
      min: 3,
      max: 256,
      softMax: 128,
      step: 1,
      default: 64,
    },
    {
      // With a spine wired: rotate each family member to the spine's tangent
      // at its station (the Illustrator Blend "align to path" behavior).
      name: "spine_align",
      label: "Align to spine",
      type: "boolean",
      default: true,
    },
  ],
  primaryOutput: "spline",
  auxOutputs: [],

  compute({ inputs, params, ctx, nodeId }) {
    const slots = readSlots(params);
    // The chain is the shapes actually present, in socket order — an unconnected
    // or non-spline socket is skipped (matches the "size = connected count"
    // convention of Combine / Proximity Merge).
    const shapes: SplineValue[] = [];
    for (const name of slots) {
      const v = inputs[name];
      if (v && v.kind === "spline" && v.subpaths.length > 0) shapes.push(v);
    }

    if (shapes.length === 0) return { primary: EMPTY_SPLINE };
    // One shape → nothing to interpolate; pass it through as group 0.
    if (shapes.length === 1) return { primary: tagGroups([shapes[0].subpaths]) };

    const count = Math.max(0, Math.round((params.count as number) ?? 5));
    const resolution = Math.max(
      3,
      Math.round((params.resolution as number) ?? 64)
    );

    // Rebuild per-segment correspondences only when the shape set or resolution
    // changes (identity compare, like Spline Morph). Count does not affect them.
    const state = ensureState(ctx, nodeId);
    if (state.res !== resolution || !sameInputs(state.inputs, shapes)) {
      const corrs: MorphCorrespondence[] = [];
      for (let k = 0; k < shapes.length - 1; k++) {
        corrs.push(
          buildMorphCorrespondence(shapes[k], shapes[k + 1], resolution)
        );
      }
      state.corrs = corrs;
      state.inputs = shapes.slice();
      state.res = resolution;
    }

    // Distribute `count` in-betweens across the segCount gaps as evenly as
    // possible: base per gap, remainder to the first `extra` gaps. Placing each
    // at localT = m/(inSeg+1) keeps every in-between strictly between its knots,
    // so none ever coincides with an input shape (no near-duplicates).
    const segCount = shapes.length - 1;
    const base = Math.floor(count / segCount);
    const extra = count % segCount;

    let groups: SplineSubpath[][] = [];
    for (let k = 0; k < segCount; k++) {
      groups.push(shapes[k].subpaths); // faithful input at the knot
      const inSeg = base + (k < extra ? 1 : 0);
      for (let m = 1; m <= inSeg; m++) {
        const localT = m / (inSeg + 1);
        groups.push(applyMorph(state.corrs[k], localT).subpaths);
      }
    }
    groups.push(shapes[shapes.length - 1].subpaths); // final input closes it

    // Blend spine (spec 072726 M4): with a spine wired, each family member
    // moves to an even arc-length station along it (centroid → station),
    // optionally rotated to the tangent. A single closed-subpath spine
    // spaces stations i/n so the first and last members don't stack at the
    // seam; open (or multi-subpath) spines include both endpoints. Unwired
    // spine = the layout above, untouched.
    const spine =
      inputs.spine?.kind === "spline" && inputs.spine.subpaths.length > 0
        ? inputs.spine
        : null;
    if (spine) {
      const lengths = measureSpline(spine);
      if (lengths.total > 0) {
        const align = params.spine_align !== false;
        const loop =
          spine.subpaths.length === 1 && spine.subpaths[0].closed;
        const n = groups.length;
        groups = groups.map((subs, i) => {
          const t = n === 1 ? 0.5 : loop ? i / n : i / (n - 1);
          const s = sampleSplineAt(spine, lengths, t);
          // Member centroid = mean of its anchor positions (the morph
          // family is densely resampled, so this is stable).
          let cx = 0;
          let cy = 0;
          let cn = 0;
          for (const sub of subs) {
            for (const a of sub.anchors) {
              cx += a.pos[0];
              cy += a.pos[1];
              cn++;
            }
          }
          if (cn === 0) return subs;
          cx /= cn;
          cy /= cn;
          const rot = align
            ? (Math.atan2(s.tangent[1], s.tangent[0]) * 180) / Math.PI
            : 0;
          return transformSpline(
            { kind: "spline", subpaths: subs },
            {
              translateX: s.pos[0] - cx,
              translateY: s.pos[1] - cy,
              scaleX: 1,
              scaleY: 1,
              rotateDeg: rot,
              pivotX: cx,
              pivotY: cy,
            }
          ).subpaths;
        });
      }
    }

    return { primary: tagGroups(groups) };
  },

  dispose(ctx, nodeId) {
    delete ctx.state[`spline-interpolate:${nodeId}`];
  },
};
