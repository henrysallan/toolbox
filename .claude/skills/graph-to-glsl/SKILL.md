---
name: graph-to-glsl
description: Fuse the image-node chain feeding a toolbox node into one GLSL Expression node, then iterate against the original until the renders match. Use when the user asks to convert, translate, fuse, bake, or port a graph, node chain, or effect to GLSL / a shader, or asks what a node chain would look like as a single shader.
---

# Graph → GLSL

Reproduce a node's image output as ONE `glsl-expression` node, inserted
beside the originals (never wired into Output — the user swaps it), and
driven to parity by comparing renders.

The guidance lives in the editor, not here: `get_glsl_docs` serves the
engine conventions, the fusion pattern, the parity playbook, and per-node
docs. This file is only the choreography. Do not skip the docs on the
grounds of knowing GLSL — every failure this tool exists for came from an
agent that knew GLSL.

## Prerequisites

The toolbox MCP must be paired (`get_status` answers). If it does not,
say so and stop.

## Steps

1. **Orient.** `get_status`, then `get_graph` for the scope the user is
   looking at. Resolve the target: the selected node, else the node wired
   into that scope's Output, else ask.
2. **Plan.** `plan_glsl_translation({ target })`. If `refusal` is set,
   relay it and stop. Otherwise restate the plan in three lines before
   writing code: what fuses (`region`), what stays wired as `a..d`
   (`frontier`), what is approximated (`cost.warnings`, multipass nodes).
   Mention every `excluded` node and its reason.
3. **Read.** `get_glsl_docs({ slugs: plan.docs })`. For each entry in
   `plan.sourceHints`, `get_node_source(type)` and read the branch of its
   shader that the node's current params select.
4. **Look at the original.** `screenshot_strip({ nodeId: target, frames:
   plan.time.frames })`. These frames are the reference for the whole
   loop; never change them between iterations.
5. **Write and insert.** One hoisted helper per region node, named after
   its id; frontier samplers via `u_<slot>`; every tunable param becomes a
   channel seeded with `paramDefs[].value` (and min/max); time through
   `u_time` / `u_frame`. Put the finished expression into the
   `add_node` op of `plan.skeleton.ops`, apply the batch with `edit_group`
   on `skeleton.groupId`, add `skeleton.channelEdges` as `add_edge` ops in
   the same batch, then `tidy({ nodes: [glslId] })`.
6. **Compile first.** `get_shader_errors({ nodeId: glslId })`. A broken
   shader renders transparent (the plan set `on_error: "transparent"`);
   fix every error before any visual step.
7. **Parity loop.** `compare_renders({ a: target, b: glslId, frames })`
   when available, else `screenshot_strip` on both at the same frames.
   Numbers first, diff shape second, renders last. Fix the highest-ranked
   cause from the parity doc; tune with `set_param(glslId, <channelName>,
   value)`; recompile-check; re-compare. Stop when every frame matches,
   after 6 comparisons, or when two consecutive comparisons fail to move
   any frame — then say so.
8. **Report.** What fused, what stayed wired and why, what was
   approximated and how (with the metric it settled at), which keyframes
   were not carried over, and that the node is unwired downstream. Offer
   the swap as a separate, confirmed step.

## Honesty rules

- Never call an approximation a port. Name the approximation.
- Never drop a node silently. If the plan excluded it, the report says so.
- If the target's core mechanism is stateful (feedback, simulation,
  video), say that before building anything partial.
- A shader you have not compiled and compared is a guess.
