# Layer Output export settings (snapshot 2026-07-15)

Follow-up to devlist #159. That item gave the **Layer Output** (the fixed
`group-output` inside a layer) the Output node's **Image / Video render
buttons** so you can render a layer in isolation without popping up to the
composition scope. But it stopped there: the buttons borrow the
**composition Output's** export params. There's no way to give a layer its
own export config.

This spec adds **independent, full export settings to each Layer Output**,
matching the composition Output's control set exactly.

## Motivation

Rendering a layer in isolation is almost always because you want it in a
*different* form than the comp — a transparent `qtrle`/ProRes-4444 mov of
one layer to composite in another tool, a PNG sequence of just the
background, a GIF of one animated element. Sharing the comp Output's
settings defeats that. Each Layer Output should carry its own filename,
format, codec, frame range, etc.

## Decisions (design Q&A)

1. **Independent per layer.** Each Layer Output stores its own export
   params in `node.data.params`. Editing them never touches the
   composition Output. (Not: a mirror/remote-control of the comp Output.)
2. **Full control set.** The Layer Output exposes the *same* export params
   as the composition Output — filename, image format/quality, export mode
   (video / sequence / gif), frame range, fps, video quality/container/
   codec/bitrate/CRF/ProRes profile/alpha, sequence delivery, and the GIF
   options. No subset.

## Current shape (what exists today)

- `outputNode` ([src/nodes/output/output.ts](../../src/nodes/output/output.ts))
  declares all export params inline in its `params: [...]`.
- The Layer Output is a `group-output` with `params.fixed === true`
  (`makeLayerNodes` in [graph-ops.ts](../../src/state/graph-ops.ts)). Its def
  (`group-output`) declares `params: []`; the panel renders the
  `GroupSocketsPanel` (read-only socket list) for it, never def params.
- `EffectNode` shows the Image / Video buttons for
  `isLayerOutput = group-output && params.fixed === true`
  ([EffectNode.tsx:145](../../src/components/effects/EffectNode.tsx#L145)).
  The Video button's label already reads `data.params?.exportMode`.
- `getOutputParams(nodeId)`
  ([EffectsApp.tsx:5529](../../src/components/effects/EffectsApp.tsx#L5529))
  is the single source the export functions (`exportImage`, video,
  sequence, gif) read config from. For a Layer Output it currently returns
  the **composition Output's** params.

## Design

The whole change hinges on two facts already true in the codebase:

- **The Layer Output never computes.** The flatten pass dissolves the
  boundary; params on it are inert to the engine. So storing arbitrary
  export config there is free — no fingerprint / cache / compute impact.
- **Every export path reads config through `getOutputParams` with
  `?? default` fallbacks** (e.g. `params.videoCodec ?? "avc"`). So a Layer
  Output that is missing a key still exports correctly.

### 1. Extract the export param list (pure refactor)

Move the Output node's `params` array into an exported constant
`EXPORT_PARAMS: ParamDef[]` in `output.ts`; set `outputNode.params =
EXPORT_PARAMS`. No behavior change for the composition Output. This makes
the canonical list reusable and keeps the two panels in lockstep forever
(add a param once, both get it).

### 2. Seed defaults onto new Layer Outputs

`makeLayerNodes` sets `groupOutput.data.params = { sockets, fixed: true }`.
Extend it to seed the export defaults too, read from the registered Output
def (no `src/nodes` import from `src/state` — reuse `getNodeDef("output")`,
same pattern as `makeInstanceNode`):

```ts
const exportDefaults: Record<string, unknown> = {};
for (const p of getNodeDef("output")?.params ?? []) exportDefaults[p.name] = p.default;
groupOutput.data.params = { ...exportDefaults, sockets: [...LAYER_OUTPUT_SOCKETS], fixed: true };
```

Order matters: `sockets` / `fixed` come last so they can't be shadowed by
a future export param named `sockets`/`fixed`.

### 3. Layer Output exports its own config

`getOutputParams`: the fixed-`group-output` branch returns
`node.data.params` (its own) instead of hunting down the comp Output.
Every downstream exporter now reads the layer's own settings for free —
`getOutputParams` is the only seam.

### 4. Render the settings in the param panel

In `ParamPanel`, the group-boundary arm currently renders only
`GroupSocketsPanel`. For a **fixed** `group-output`, wrap it and append an
**"export · settings"** section: the `EXPORT_PARAMS` rendered as plain
`ParamRow`s (no keyframe / expose affordances — export config isn't scene
animation), filtered by each param's own `visibleIf`, writing through the
normal `onParamChange(nodeId, name, value)` path (undo + persistence for
free — the write is `{ ...params, [name]: value }`, independent of whether
the param is in the node's def).

For robustness against pre-existing saves, the section evaluates
`visibleIf` and values against `{ ...exportDefaults, ...node.data.params }`
so a Layer Output that predates this feature still renders a complete,
correct panel; edits then materialize the real key.

Plain, non-fixed group outputs are untouched (the section is gated on
`isFixedBoundary`).

## Back-compat

- No schema bump. `group-output` def stays `params: []`; export params live
  only on the node instance.
- Existing saved layers have no export keys → exporters fall back to
  defaults (identical to today's borrowed-comp-Output behavior when the
  comp Output is also at defaults) and the panel merges defaults for
  display. First edit writes the key.
- Composition Output behavior is unchanged (same `EXPORT_PARAMS`, same
  render path).

## Touchpoints

| File | Change |
|------|--------|
| `src/nodes/output/output.ts` | Extract `EXPORT_PARAMS`; `params: EXPORT_PARAMS`. |
| `src/state/graph-ops.ts` | Seed export defaults in `makeLayerNodes`. |
| `src/components/effects/EffectsApp.tsx` | `getOutputParams`: return the Layer Output's own params. |
| `src/components/effects/ParamPanel.tsx` | Append the export-settings section for fixed `group-output`. |

## Out of scope

- Keyframing export params (nonsensical; comp Output's incidental
  keyframe diamonds on export params are not reproduced here).
- "Export App →" and Render-Queue linkage from a Layer Output.
- A per-layer resolution override (resolution is a composition/canvas
  setting; the layer renders at the comp resolution).

## Milestones

- **M1** — Extract `EXPORT_PARAMS` in `output.ts` (refactor, typecheck).
- **M2** — Seed export defaults in `makeLayerNodes`.
- **M3** — `getOutputParams` returns the Layer Output's own params.
- **M4** — ParamPanel export-settings section for fixed `group-output`.
- **M5** — Verify: create a layer, change its export format/codec, render
  the layer, confirm it uses the layer's settings and the comp Output is
  independent. Update devguide + devlist.
