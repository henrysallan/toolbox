---
name: graph-to-after-effects
description: Export a toolbox composition to After Effects as an editable project — native shape layers, masks, effects and keyframes, Toolbox Shader effects for regions with no AE equivalent, and baked footage for the rest — then verify it against toolbox's own renders. Use when the user asks to export, hand off, send, convert or port a graph, composition or animation to After Effects / AE / an .aep, or asks how much of a graph AE can reproduce.
---

# Graph → After Effects

Turn the composition into an After Effects package (`scene.json` +
`build.jsx` + presets, shader bundles and footage), build it, and prove it
matches. The facts live in the editor: `get_ae_docs` serves the units /
time / alpha / color conventions, the Toolbox Shader plug-in contract, the
parity playbook and per-node notes. This file is only the choreography.

## Prerequisites

The toolbox MCP must be paired (`get_status` answers). If it doesn't, say
so and stop. Building and comparing (`run_ae_script`, `compare_ae_renders`)
need the desktop app on a Mac with After Effects; without them the export
is "package written, not verified" — say that plainly.

## Steps

1. **Orient.** `get_status`, `get_graph`. Confirm which composition (and
   Output) the user means.
2. **Plan.** `plan_ae_export`. Relay it in five lines: native, approximate
   (named), shader regions (named), baked (named), blocked. If the route is
   `blocked`, name the live inputs and stop. Ask before exploding more than
   the layer budget or baking more than a few seconds of footage.
3. **Read.** `get_ae_docs()` for the core docs, plus
   `get_ae_docs({ types: [...] })` for every approximate or shader node the
   plan names.
4. **Shader regions.** For each region in the plan, run the graph-to-glsl
   loop on its target: `plan_glsl_translation` → `get_glsl_docs` → write the
   glsl-expression node, unwired downstream → `get_shader_errors` →
   `compare_renders` until it matches. Then `validate_ae_shader` on the new
   node and fix anything it refuses (`ae-host` lists the refusals). Keep a
   map of region target → new node id.
5. **Export.** `export_ae_package({ policy, fused: { "<target>": "<node id>" } })`.
   Read the report back: what's native, approximate (by how much), sampled,
   baked.
6. **Build and verify** (desktop with AE). `run_ae_script` on the package,
   then `compare_ae_renders` at the plan's frames. Fix the highest-ranked
   cause from `ae-parity` — a unit mismatch is a param or policy change; a
   premultiplication fringe or a Y flip is a plug-in bug to report, not a
   shader edit. Re-export and compare again. Stop on a match, after 4
   rounds, or when a round improves nothing — and say which.
7. **Report.** What is native, what is approximate and the metric it
   settled at, what is baked, which fonts the AE machine needs, and which
   Toolbox Shader plug-in version it needs.

## Honesty rules

- Never call a bake a port. Baked footage keeps the look and loses
  editability.
- Never drop a node silently: a `skip` override or an unsupported node is
  named in the report.
- A package you haven't built and compared is unverified — say so.
- Don't script the user's open After Effects. The tools build headless and
  open the result; nothing else touches the running app.
