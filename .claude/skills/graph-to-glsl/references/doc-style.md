# Node doc style — `src/lib/glsl-translation/docs/nodes/<type>.md`

One doc per `pure` / `gather` / `multipass` node type in
`src/lib/glsl-translation/classes.ts`. Gold examples: `displace.md`
(gather), `blur.md` (multipass), `noise.md` (pure with a ported branch).
Read all three before writing one.

## Frontmatter

```
---
title: <Node name> — <the one-line translation idea>
type: <type string from get_catalog>
class: <pure | gather | multipass, matching classes.ts>
---
```

The gate fails when `type` is not in the table, when `class` disagrees
with it, or when `classes.ts` does not point `doc:` at this file.

## Sections, in this order

1. **What the node does** — the math as the SHADER does it (read the
   exported `*_FS` and `compute()`, not the description), in 5–12 lines.
   Name the units (pixels / uv01 / canvas01 / degrees), the sampling
   structure (taps, wrap), and where alpha is premultiplied if it is.
2. **Cost** (gather / multipass only) — taps per pixel, what multiplies
   through, and the rule for when NOT to fuse.
3. **Param → channel** — a table: every settable param, the channel kind
   with the seed range, and the conversion (`radians()`, `/ u_res`, …).
   Params that select code rather than tune it say "none".
4. **Fused form** — ONE fenced ```` ```glsl-body ```` snippet that
   compiles inside the GLSL Expression template (`npm run check:shaders`
   compiles it). Rules:
   - channel comments first, then hoisted helpers, then `fragColor = …;`
   - one helper named `<type>_node(vec2 uv)`; upstream inputs as
     `source(uv)` helpers the agent replaces (`texture(u_a, uv)` default)
   - seed channels with the node's DEFAULT param values
   - no `#version`, no `main()`, no `uniform` lines, no `u_`/`gl_`/`__`
     identifiers of your own, no GLSL reserved words as names (`half`,
     `input`, `output`, `filter`, …)
   - keep it under ~80 lines; a multipass approximation caps its own cost
     and says so in a comment
5. **Gotchas in translation** — 3–5 bullets of what the parity diff will
   show when a step is wrong, in the parity doc's vocabulary (Y flip,
   aspect, premultiplied fringe, wrap strip, seed speckle).

## Voice

Terse, imperative, no marketing. Every number comes from the source with
the file named once. If the shader has several branches, say which one the
snippet ports and how to find the others. Never write "port" for an
approximation.

## Bulk pass

Fan out one agent per batch of node files (~4k source lines) carrying
this guide; agents write each `.md` as soon as it is done (a stalled agent
that batched its writes lost everything in the node-facts pass). Then:
`npm run gen:glsl-docs`, `npm run check:glsl-translation`,
`npm run check:shaders`; SKIP/FAIL lines go back to the agent that wrote
the doc. Set `doc:` in `classes.ts` per landed file.
