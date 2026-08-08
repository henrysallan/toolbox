# Modular Visual Effects System — v1 Spec

## 1. What this is

A browser-based tool for chaining pre-packaged visual effects into a pipeline. Think of it like a guitar pedalboard for images: each node is a self-contained effect with its own code file, and users wire them together to build a processed output.

The design philosophy is **thick nodes, rich outputs**. Nodes are packaged effects (bloom, chromatic aberration, displacement), not fine-grained building blocks (multiply, add, sample). Each node does one recognizable thing well, and exposes whatever intermediate data it computed along the way for downstream nodes to optionally consume.

This is *not* a TouchDesigner clone or a shader graph builder. It is closer to a compositor like Nuke or a VST effect chain: you pick effects, chain them, tweak parameters.

## 2. UI layout

Three panels:

- **Canvas (left)**: renders the current output of the graph at the canvas's canonical resolution.
- **Node editor (top right)**: the graph. Nodes have sockets; users drag wires between them. A search menu adds new nodes, organized by category.
- **Parameter panel (bottom right)**: sliders and controls for the currently selected node, plus any parameters that have been "exposed" globally from other nodes.

## 3. Stack

- **Next.js** (App Router) for the shell and node editor UI.
- **WebGL2** as the baseline GPU target; **WebGPU** used when available and when a node opts into it. Nodes declare their backend; the engine picks WebGPU if both the node and the browser support it, else falls back to WebGL2.
- **React** for all UI. The node graph library choice is open — React Flow is the obvious default but not mandated.
- **TypeScript** throughout.

## 4. The data contract

This is the most important part of the spec. Get this right and everything else follows.

### 4.1 Socket types

Sockets are typed. Wires can only connect matching types (with a small number of implicit coercions, listed below).

The v1 socket types are:

- `image` — a GPU texture, RGBA, the canonical resolution unless a node declares otherwise.
- `mask` — a GPU texture, single-channel (R8 or R16F), values in 0–1.
- `scalar` — a single number (float).
- `vec2`, `vec3`, `vec4` — fixed-length float vectors.

Deliberately excluded from v1: audio, SDF, particle buffers, arbitrary data buffers. These are real needs but they expand the engine surface a lot. Add them once the v1 core is stable.

Implicit coercions allowed by the engine (so node authors don't have to handle every case):

- `mask` → `image`: single-channel gets promoted to RGBA by replicating into RGB and setting alpha to 1.
- `scalar` → `vec2/3/4`: broadcast to all components.

No other coercions. If a node wants to treat an image as a mask (e.g., use its luminance), it does that explicitly inside the node.

### 4.2 The output shape

Every node output is a structured bundle, not a bare value:

```
NodeOutput {
  primary: <typed value>          // required, typed per the node's declaration
  aux: { [name: string]: <typed value> }   // optional extras
}
```

**Primary** is the "main" output of the node. For an effect node (the common case), primary is always an `image` — it's the image after the effect has been applied. This is the socket users drag from by default when they wire node-to-node.

**Aux** is a named grab-bag of extra outputs the node chose to expose. A bloom node might put its luminance-threshold `mask` in aux. A displacement node might expose the `vec2` offset field it used. Aux entries appear in the UI as smaller secondary output sockets on the node, each labeled with its name and type.

Downstream nodes declare which aux names they'd *like* to consume. If the upstream doesn't provide that aux entry, the downstream node receives `undefined` and must handle it gracefully (usually by falling back to computing or inferring the value itself).

### 4.3 The "main wire" convention

When a user drags from one node onto another without specifying sockets, the engine auto-connects **primary output → the first image input**. This is the most common case and should be frictionless. Aux wires are always opt-in and must be dragged explicitly.

## 5. Node file structure

Every node is a single file in `/nodes/<category>/<node-name>.ts` (or `.tsx` if it ships custom parameter UI). Shape is structural, not enforced by a strict schema — each file exports a node definition object that the engine can introspect.

A node file declares:

- **Identity**: id (unique, kebab-case), display name, category, description, icon/thumbnail (optional).
- **Backend**: `"webgl2"` or `"webgpu"`. A node can ship both and let the engine pick.
- **Inputs**: an ordered list of input sockets, each with `{ name, type, required, defaultValue? }`.
- **Parameters**: the sliders/controls shown in the parameter panel. Each has `{ name, type, range, default, ui hints }`. Parameters are not sockets by default but can be *exposed* (see §8).
- **Outputs**: the primary output type, plus a declared list of aux outputs `{ name, type, description }`. Declaring aux in advance lets the UI draw the sockets without having to run the node first.
- **Optional aux consumption**: a list of aux names this node knows how to use from its upstream inputs. The engine uses this to offer smart-wiring suggestions and to warn when useful aux is being ignored.
- **Compute function**: the actual work. Takes `{ inputs, params, ctx }` and returns a `NodeOutput`. `ctx` gives the node access to the GPU device, render targets, the canonical resolution, the current time, and any persistent state it previously stored (for temporal nodes).
- **Optional lifecycle hooks**: `init` (called once when the node is added to the graph, for loading shaders or allocating buffers) and `dispose` (called when the node is removed, for cleanup).

Leaving the syntax flexible means the compute function can be a shader string, a WGSL module, a JS function that orchestrates multiple passes, or whatever the effect needs. The engine doesn't care — it just calls the function with the right inputs.

## 6. Execution model

### 6.1 Graph evaluation

The graph is a DAG in v1 (cycles forbidden — revisit for v2 if feedback effects become important). Evaluation is:

1. Topologically sort the graph from sources to the canvas output.
2. For each node, gather its connected inputs, resolve any aux requests, and call its compute function.
3. Cache each node's `NodeOutput` until something upstream changes (dirty-flag propagation).
4. Render the final output to the canvas.

### 6.2 Dirty propagation

A node is dirty if:
- Any of its parameters changed.
- Any connected input is dirty.
- Any connected wire changed (added/removed/rerouted).
- The canvas resolution changed (for nodes that care).

Only dirty nodes re-run. For a still-image pipeline, this means parameter tweaks only recompute from the changed node forward.

### 6.3 Eager vs lazy aux

V1 is **eager**: nodes compute all declared aux outputs every time they run, whether or not anything consumes them. This keeps node author logic simple. The cost is real but acceptable for the graph sizes v1 targets (< 30 nodes). Revisit if profiling shows aux compute dominating frame time.

### 6.4 Time and animation

The engine maintains a single `time` scalar (seconds since graph started playing) and a `frame` integer. These are available on `ctx` to any node. A global play/pause/scrub control sits above the canvas.

Nodes that need per-frame persistent state (feedback buffers, trails) can store it on `ctx.state[nodeId]` between invocations. The engine guarantees this is cleared when the node is removed or the graph is reset.

Temporal effects (trails, datamosh-style feedback) are supported via explicit persistent state, *not* via graph cycles. This is a deliberate v1 limitation — if it becomes painful, v2 introduces a `FeedbackNode` primitive that reads last frame's output.

### 6.5 Resolution

The canvas has a **canonical resolution** (user-configurable, default 1024×1024). All `image` and `mask` textures flowing between nodes are at canonical resolution unless a node explicitly declares otherwise (e.g., a downsample node). Nodes that want to work at lower internal resolution (blur pyramids, etc.) can do so privately but must emit canonical-resolution outputs.

Format: all images are RGBA16F by default to support HDR. Masks are R16F. Nodes can declare RGBA8 for the output if they want to clamp (e.g., final output stages).

## 7. Source and output nodes

The graph needs entry and exit points:

- **Source nodes** have no inputs and produce images/data. Examples: image upload, solid color, gradient, noise, webcam, canvas clear.
- **Output node** is a special terminal node. There is exactly one per graph. It takes an `image` input and renders to the canvas. If no output node is connected, the canvas shows a placeholder.

## 8. Parameters and exposure

Each node's parameters show in the parameter panel when that node is selected. Additionally, any parameter can be **exposed globally** by right-clicking it → "Expose to control panel." Exposed parameters appear in a separate "Exposed Controls" section that is always visible regardless of which node is selected.

Exposed parameters are the foundation for a future "performance mode" where the graph is hidden and only the exposed sliders remain. Not in v1 UI, but the data model supports it from day one.

Parameter types for v1: `scalar` (range + step), `vec2/3/4` (range per component), `color` (hex or rgba), `boolean` (toggle), `enum` (dropdown of string options), `curve` (optional, for easing — defer if time-tight).

## 9. Serialization

Graph state saves as JSON:

```
{
  version: 1,
  canvasResolution: [w, h],
  nodes: [{ id, type, position, params: {...} }, ...],
  wires: [{ from: { nodeId, socket }, to: { nodeId, socket } }, ...],
  exposedParams: [{ nodeId, paramName, displayName }, ...]
}
```

Always include a `version` field. When the schema changes, write a migration function rather than breaking old saves.

## 10. LLM-authored nodes

Since nodes will be generated with LLM assistance, the node file format should be easy for an LLM to produce correctly in one shot. Guidelines:

- **Minimal required surface**: identity + inputs + parameters + primary output + compute function. Aux is optional; temporal state is optional; lifecycle hooks are optional. An LLM can produce a perfectly valid node without touching any of the optional surface.
- **Self-contained files**: a node file should not import from other node files. It can import from `/engine` (shared types, GPU helpers) and standard libraries, nothing else. This keeps each node independently shippable and LLM-generatable.
- **Declarative first**: the node declares what it does (inputs, params, aux); the engine handles wiring the declarations to the UI. The LLM shouldn't need to write any UI code for a standard node.
- **Template file**: `/nodes/_template.ts` is a fully-working identity pass-through node with comments explaining every field. New nodes should be generated by copying and modifying the template.

## 11. v1 starter nodes

Three nodes to validate the system end-to-end. The goal here is coverage, not breadth — each one exercises a different part of the contract.

### 11.1 `image-source` (category: source)

- Inputs: none
- Parameters: file upload, fit mode (cover/contain/stretch)
- Primary output: `image`
- Aux: none
- Why: validates that source nodes work, images load to GPU textures at canonical resolution, and the pipeline has something to chew on.

### 11.2 `bloom` (category: effect)

- Inputs: `image`
- Parameters: threshold (0–1), intensity (0–3), radius (scalar, pixels)
- Primary output: `image` (the bloomed result)
- Aux: `threshold_mask` (mask — the luminance threshold texture it computed), `bloom_only` (image — just the glow without the original underneath)
- Why: exercises aux outputs richly. Downstream nodes can grab the threshold mask for other purposes, or composite the bloom-only output differently. Also non-trivial internally (multi-pass blur pyramid) — proves the engine handles nodes that do real work.

### 11.3 `output` (category: output)

- Inputs: `image`
- Parameters: none (v1) — could later add tonemap, exposure, format
- Primary output: none (terminal node)
- Aux: none
- Why: closes the loop and puts something on the canvas.

With these three, the minimum viable pipeline is `image-source → bloom → output`, which proves the full contract: typed sockets, aux outputs, parameters, dirty propagation, and canvas rendering.

## 12. Out of scope for v1

Listed explicitly so the LLM doesn't try to build them:

- Feedback loops / graph cycles
- Audio input or audio-reactive nodes
- Node groups / subgraphs / macros
- Multi-output (more than one primary) — aux covers this case for now
- Undo/redo — defer to v1.1
- Collaborative editing
- MIDI / OSC / external control input
- Export to video or image sequence — the canvas is a live preview only in v1
- Custom parameter UI per node (`.tsx` files) — v1 uses only the built-in parameter types from §8
- Performance mode (hidden graph, exposed-sliders-only view)
- WebGPU compute shaders (v1 WebGPU nodes can use render pipelines only)

## 13. Open questions (flag, don't resolve in v1)

- Do wires show data type via color? (Probably yes — Blender does this and it's legible.)
- Should the canonical resolution be per-graph or per-save? (Per-save, probably.)
- How do we handle a node throwing an error mid-compute? (Suggest: show error badge on the node, pass the last valid cached output downstream, don't crash the pipeline.)
- When loading a saved graph with a node type that no longer exists, what happens? (Suggest: show a "missing node" placeholder that preserves wires and params so the graph can be fixed manually.)

---

**End of spec.** Build v1 against this. When something feels awkward in practice, update this doc rather than patching around it.