---
title: GLSL Expression → Toolbox Shader effect
type: glsl-expression
class: shader
---

- A fused GLSL Expression becomes a Toolbox Shader effect on a comp-sized
  solid or adjustment layer, with its bundle in `shaders/<id>.tbxfx`.
- Image inputs `u_a`..`u_d` become the effect's Layer A–D params, pointing
  at the layers or precomps that render the region's inputs.
- Channels become the plug-in's sliders / colors / checkboxes; `pick()`
  enums are baked to their current option; ramp / curve channels become
  LUTs (static only).
- Run `validate_ae_shader` on the node before exporting: it translates the
  GLSL to Metal and compiles it the way the plug-in will (see `ae-host`
  for what it refuses).
- Export it through `export_ae_package({ fused: { "<region target>":
  "<this node's id>" } })`; without that entry the region bakes.
