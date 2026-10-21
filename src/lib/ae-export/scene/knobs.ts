// Exposed knobs → After Effects controls (spec 091926_after-effects-handoff.md
// §10 M4; results in specdocs/ae-m4/essential-properties.md).
//
// Toolbox exposes a knob in two ways (the root composition has no interface
// of its own; exposedParams only turn a param into a socket):
//   control    the export / live-link Control toggle (controlParams), listed
//              by buildExportManifest exactly as the live panel lists it
//   promoted   a group / layer input socket wired into an interior param or
//              data socket (the shell's widget: flatten copies the shell's
//              inputValues onto that consumer)
//
// The mapping:
//   * Every control holds the knob's TOOLBOX value, the number the toolbox
//     panel shows. The expression on each driven AE property converts it with
//     the walk's own affine maps (×W px, ×100 %, the pivot's offset …).
//     scalar → Slider (Angle when it is in degrees), boolean → Checkbox,
//     enum → Dropdown Menu, color → Color (0–1 RGB; AE has no alpha there),
//     vec2 → Point.
//   * Control knobs → ONE "Controls" null in the main comp. An expression in
//     a precomp reads it as comp("<main>").layer("Controls").
//   * Promoted knobs of a node-group or a toolbox layer → the group renders
//     as a precomp of its own (forced), with its own "Controls" null whose
//     controls are in that comp's Essential Graphics, so every precomp layer
//     of it shows them as Essential Properties. Measured headless in AE 26.5:
//     addToMotionGraphicsTemplateAs and AVLayer.essentialProperty work in
//     aerender's core, and an override reaches the precomp's internal
//     properties through these expressions when the saved project renders.
//     A group that never becomes a precomp (its output is a spline a style
//     outside consumes, say) puts its knobs on the main Controls null.
//   * A param wired straight from a Constant whose `value` is a knob reads
//     as that constant's value: the graph view below hides the wire, so the
//     consumer converts (keys and all) and links like a knob of its own.
//   * Only native consumers link. A knob in baked footage keeps the frames'
//     value; one feeding a value graph is sampled until the expression
//     compiler asks knobExpression() for its leaves.
//
// Expressions carry placeholders ($tbxKnob<k>l<n>$) while the walk runs;
// finish() resolves them once comps and layers have their final names and
// builds each comp's Controls null from the knobs its expressions read.

import { GROUP_INPUT_TYPE, GROUP_OUTPUT_TYPE, GROUP_TYPE, GROUP_INPUT_WIDGET_TYPES, LAYER_TYPE, readBoundarySockets, readReservedSockets } from "@/engine/groups";
import { parseTargetHandleKind } from "@/engine/graph-helpers";
import { evaluateKeyframesAt, type KeyframeAnimationBlock } from "@/engine/keyframes";
import type { SocketType } from "@/engine/types";
import { getNodeDef } from "@/engine/registry";
import { buildExportManifest } from "@/lib/export-manifest";
import { listGroupShellControls } from "@/state/graph-ops";
import type { AeEffectContext, AeParamMap } from "../calibration";
import { canvasAxisAffine, colorToRgba, colorTrackToAe, isKeyed, numericTrackToAe, type AeAffine, type AeTrackSource, type AeTransformResult } from "../convert";
import type { AeComp, AeControlKind, AeControlLine, AeEffect, AeLayer, AeProp, AeRGB, AeScene } from "../types";
import { keyCtx, valueOfSource, windowFrames, type WalkClock, type WalkCtx } from "./context";
import type { AeGraph } from "./graph";
import { collapse, originTransform, type Rendered, type Scope } from "./layers";
import type { NodeTrs } from "./trs";

// Expression Control match names (AE 26.5, probed: scripts/ae-export-spike/
// essential/probe.mts). Each has ONE value param, "<match>-0001" — except the
// Dropdown Menu Control, which turns into a "Pseudo/@@…" effect when its
// menu is set, so its value is addressed "#1".
export const AE_CONTROL: Record<AeControlKind, { match: string; prop: string }> = {
  slider: { match: "ADBE Slider Control", prop: "ADBE Slider Control-0001" },
  angle: { match: "ADBE Angle Control", prop: "ADBE Angle Control-0001" },
  point: { match: "ADBE Point Control", prop: "ADBE Point Control-0001" },
  color: { match: "ADBE Color Control", prop: "ADBE Color Control-0001" },
  checkbox: { match: "ADBE Checkbox Control", prop: "ADBE Checkbox Control-0001" },
  dropdown: { match: "ADBE Dropdown Control", prop: "#1" },
};

export const CONTROLS_LAYER = "Controls";

const TOKEN = /\$tbxKnob(\d+)l(\d+)\$/g;

interface Knob {
  k: number;
  // Where the value lives in the flat graph (a promoted knob: its first
  // consumer; "in:<name>" for a data socket).
  node: string;
  param: string;
  // Panel label: "<node> · <param label>" for a control, the socket name for
  // a promoted input.
  label: string;
  source: "control" | "promoted";
  owner?: { id: string; name: string; socket: string };
  control?: AeControlKind;
  options?: string[];
  optionLabels?: string[];
  // Through a Constant: its step quantization, applied in the expression.
  quantize?: { step: number; integer: boolean };
  // The control's value prop, built at the first link.
  prop?: AeProp;
  declined: string[];
}

interface Link {
  knob: Knob;
  what: string;
}

const fmt = (x: number) => String(Number(x.toPrecision(12)));

// a·ref + b, tidy.
function affine(ref: string, a: number, b: number): string {
  const head = a === 1 ? ref : a === -1 ? `-${ref}` : `${fmt(a)} * ${ref}`;
  if (b === 0) return head;
  return b < 0 ? `${head} - ${fmt(-b)}` : `${head} + ${fmt(b)}`;
}

// The value of a prop of n components as an expression: `parts[i]` where
// given, AE's own value elsewhere.
function vecExpr(n: number, parts: (string | null)[]): string {
  if (n === 1) return parts[0] ?? "value";
  return `[${Array.from({ length: n }, (_, i) => parts[i] ?? `value[${i}]`).join(", ")}]`;
}

const dimsOf = (p: AeProp): number => ("v" in p ? (Array.isArray(p.v) ? p.v.length : 1) : p.dims);

function controlKindOf(type: string, label: string, name: string): AeControlKind | undefined {
  switch (type) {
    case "scalar":
      return /°|deg/i.test(label) || /^(rotate|rotation|angle)$|Angle$|_angle$/i.test(name) ? "angle" : "slider";
    case "boolean":
      return "checkbox";
    case "enum":
      return "dropdown";
    case "color":
      return "color";
    case "vec2":
      return "point";
    default:
      return undefined;
  }
}

// A group input socket type → the param type its shell widget edits.
const SOCKET_PARAM_TYPE: Partial<Record<SocketType, string>> = { scalar: "scalar", vec4: "color", vec2: "vec2" };

export class KnobRegistry {
  readonly knobs: Knob[] = [];
  // "<node>\n<param>" → the knob whose value that flat param IS.
  private at = new Map<string, Knob>();
  // Wires hidden from the walk: "<target>\n<handle>" → the Constant knob.
  private alias = new Map<string, { node: string; knob: Knob }>();
  // Group / layer shell → its knobs; endpoint → the groups it is the output of.
  private owned = new Map<string, Knob[]>();
  private groupOut = new Map<string, { id: string; name: string }[]>();
  // Shell id → the comps that render it with its Controls (forced precomps).
  private homes = new Map<string, Set<string>>();
  private links: Link[] = [];
  private notes = new Map<Knob, string[]>();
  readonly graph: AeGraph;

  // `graph` is the walk's own (makeAeGraph): its composition's editor nodes
  // and edges are the raw graph the knobs are read from.
  constructor(graph: AeGraph) {
    const raw = graph.flat.comp;
    const byId = new Map(raw.nodes.map((n) => [n.id, n]));
    const defName = (id: string) => getNodeDef(byId.get(id)?.data.defType ?? "")?.name;

    // Promoted inputs: every edge from a group / layer's Group Input into an
    // interior param or widget socket the flat graph leaves unwired (flatten
    // patched the shell's value onto it).
    for (const e of raw.edges) {
      const gi = byId.get(e.source);
      if (gi?.data.defType !== GROUP_INPUT_TYPE || !gi.data.parentId || !e.sourceHandle?.startsWith("out:aux:")) continue;
      const shell = byId.get(gi.data.parentId);
      if (!shell || (shell.data.defType !== GROUP_TYPE && shell.data.defType !== LAYER_TYPE)) continue;
      const sock = e.sourceHandle.slice("out:aux:".length);
      if (readReservedSockets(gi.data.params).includes(sock)) continue;
      const parsed = parseTargetHandleKind(e.targetHandle ?? "");
      if (!parsed || !graph.node(e.target)) continue;
      const handle = parsed.kind === "param" ? `in:param:${parsed.name}` : `in:${parsed.name}`;
      if (graph.wireInto(e.target, handle)) continue;
      const spec = readBoundarySockets(gi.data.params).find((s) => s.name === sock);
      if (parsed.kind === "input" && !GROUP_INPUT_WIDGET_TYPES.has(spec?.type as SocketType)) continue;
      const param = parsed.kind === "param" ? parsed.name : `in:${parsed.name}`;
      let list = this.owned.get(shell.id);
      if (!list) this.owned.set(shell.id, (list = []));
      let knob = list.find((x) => x.owner!.socket === sock);
      if (!knob) {
        const ctl = listGroupShellControls(shell, raw.nodes, raw.edges).find((c) => c.socketName === sock);
        const type = ctl?.controlDef.type ?? (parsed.kind === "param" ? getNodeDef(graph.node(e.target)!.type)?.params.find((p) => p.name === parsed.name)?.type : SOCKET_PARAM_TYPE[spec!.type]) ?? "";
        const options = ctl?.controlDef.options as string[] | undefined;
        knob = this.add({
          node: e.target,
          param,
          label: sock,
          source: "promoted",
          owner: { id: shell.id, name: graph.name(shell.id), socket: sock },
          control: controlKindOf(type, ctl?.controlDef.label ?? sock, parsed.name),
          ...(options ? { options, optionLabels: options.map((o) => String(ctl?.controlDef.optionLabels?.[o] ?? o)) } : {}),
          declined: [],
        });
        if (!knob.control) knob.declined.push(`a ${type || "non-widget"} input has no After Effects Expression Control`);
        list.push(knob);
      }
      this.at.set(`${e.target}\n${param}`, knob);
    }

    // Control knobs, as the live panel lists them.
    const output = graph.flat.allNodes.find((n) => n.type === "output" && !n.parentId);
    if (output) {
      const { manifest } = buildExportManifest({ nodes: raw.nodes, edges: raw.edges, appName: "", outputNodeId: output.id, canvasRes: [1, 1] });
      for (const c of manifest.controls) {
        if (!graph.node(c.nodeId)) continue;
        const key = `${c.nodeId}\n${c.paramName}`;
        if (this.at.has(key)) {
          this.note(this.at.get(key)!, `also Control-toggled on ${c.nodeName} — the promoted input is what evaluates`);
          continue;
        }
        const editorName = graph.name(c.nodeId);
        const nodeName = editorName !== defName(c.nodeId) ? editorName : c.nodeName;
        const options = c.def.options as string[] | undefined;
        const knob = this.add({
          node: c.nodeId,
          param: c.paramName,
          label: `${nodeName} · ${c.label}`,
          source: "control",
          control: /^(ramp_|gpoint_|mlayer|anchor_)/.test(c.paramName) ? undefined : controlKindOf(c.paramType, c.label, c.paramName),
          ...(options ? { options, optionLabels: options.map((o) => String(c.def.optionLabels?.[o] ?? o)) } : {}),
          declined: [],
        });
        if (!knob.control) knob.declined.push(/^(ramp_|gpoint_)/.test(c.paramName) ? "a gradient stop: stop colors and offsets are not scriptable in After Effects" : /^mlayer/.test(c.paramName) ? "a Merge layer's blend / opacity: not mapped to a control yet" : `a ${c.paramType} param has no After Effects Expression Control`);
        this.at.set(key, knob);
      }
    }

    // Wires straight from a Constant knob: the consumer reads the constant.
    for (const e of graph.flat.wires) {
      const src = graph.node(e.source);
      if (src?.type !== "constant" || e.sourceHandle !== "out:primary") continue;
      const knob = this.at.get(`${e.source}\nvalue`);
      if (!knob) continue;
      const p = graph.params(e.source);
      const step = typeof p.step === "number" && p.step > 0 ? p.step : 0.001;
      const integer = p.mode === "integer";
      // Constant snaps its value to its step (0.001 by default) on every
      // compute: the expression does too, so AE shows what toolbox renders.
      knob.quantize = { step: integer ? Math.max(1, Math.round(step)) : step, integer };
      const param = e.targetHandle.startsWith("in:param:") ? e.targetHandle.slice("in:param:".length) : e.targetHandle;
      this.at.set(`${e.target}\n${param}`, knob);
      if (e.targetHandle.startsWith("in:param:")) this.alias.set(`${e.target}\n${e.targetHandle}`, { node: e.source, knob });
    }

    // Where each group's output is (its Group Output's image socket source),
    // so the walk can render it as a precomp of its own.
    for (const [shellId] of this.owned) {
      const shell = byId.get(shellId);
      if (shell?.data.defType !== GROUP_TYPE) continue;
      const go = raw.nodes.find((n) => n.data.parentId === shellId && n.data.defType === GROUP_OUTPUT_TYPE);
      if (!go) continue;
      for (const s of readBoundarySockets(go.data.params)) {
        if (s.type !== "image") continue;
        const w = raw.edges.find((x) => x.target === go.id && x.targetHandle === `in:${s.name}`);
        if (!w || !graph.node(w.source)) continue;
        const ep = w.sourceHandle?.startsWith("out:aux:") ? `${w.source}:aux:${w.sourceHandle.slice(8)}` : `${w.source}:out`;
        const list = this.groupOut.get(ep) ?? [];
        list.unshift({ id: shellId, name: graph.name(shellId) });
        this.groupOut.set(ep, list);
      }
    }
    this.graph = this.knobs.length ? aliasedGraph(graph, this.alias) : graph;
  }

  private add(k: Omit<Knob, "k">): Knob {
    const knob = { ...k, k: this.knobs.length } as Knob;
    this.knobs.push(knob);
    return knob;
  }

  private note(k: Knob, text: string) {
    const list = this.notes.get(k) ?? [];
    if (!list.includes(text)) list.push(text);
    this.notes.set(k, list);
  }

  knobAt(node: string, param: string): Knob | undefined {
    return this.at.get(`${node}\n${param}`);
  }

  // A toolbox layer whose promoted inputs need it rendered as a precomp.
  ownsKnobs(shellId: string): boolean {
    return (this.owned.get(shellId)?.length ?? 0) > 0;
  }

  // The comp `compId` renders shell `shellId` (its Controls go there).
  home(shellId: string, compId: string | undefined): void {
    if (!compId) return;
    const set = this.homes.get(shellId) ?? new Set<string>();
    set.add(compId);
    this.homes.set(shellId, set);
  }

  // Scope.render through this: a node-group's output with promoted knobs
  // renders as a precomp of its own, named after the group.
  render(scope: Scope, endpoint: string, fn: () => Rendered): Rendered {
    let r = fn();
    const groups = this.groupOut.get(endpoint);
    if (!groups || !r.layers.length) return r;
    for (const g of groups) {
      r = collapse(scope, r, g.name, true);
      this.home(g.id, r.main!.source);
      scope.ctx.report.ensure(g.id, GROUP_TYPE, "layer", g.name);
      scope.ctx.report.note(g.id, "a group with promoted inputs → a precomp of its own; its inputs are Essential Properties of each precomp layer");
    }
    return r;
  }

  // --- links ------------------------------------------------------------------------------

  private token(knob: Knob, what: string): string {
    this.links.push({ knob, what });
    return `$tbxKnob${knob.k}l${this.links.length - 1}$`;
  }

  // The knob's value prop on its control, built once (first link's clock).
  private ensureProp(ctx: WalkCtx, clock: WalkClock, k: Knob, shapeOrSolid = false): void {
    if (k.prop) return;
    const g = ctx.graph;
    const kc = keyCtx(ctx, clock);
    const block = k.param.startsWith("in:") ? undefined : g.block(k.node, k.param);
    const keyed = !!block && block.keyframes.length > 1;
    const raw = this.rawValue(ctx, k);
    const indexOf = (v: unknown) => Math.max(0, k.options?.indexOf(String(v)) ?? 0) + 1;
    const holds = (map: (v: unknown) => unknown): AeProp => ({
      keys: [...block!.keyframes].sort((a, b) => a.tick - b.tick).map((kf) => ({ t: (kf.tick + clock.offsetTicks) / (ctx.tpf * ctx.fps), v: map(kf.value), inInterp: "hold" as const, outInterp: "hold" as const })),
      dims: 1,
    });
    switch (k.control) {
      case "color":
        if (keyed) {
          const r = colorTrackToAe(block!, { ...kc, policy: ctx.policy.color, drivesShapeOrSolid: shapeOrSolid, tolerance255: ctx.policy.colorTolerance });
          ctx.report.color(k.node, `${k.label} (control)`, r.report);
          k.prop = r.prop;
        } else {
          const c = colorToRgba(raw ?? "#ffffff");
          k.prop = { v: [clamp01(c[0]), clamp01(c[1]), clamp01(c[2])] as AeRGB };
          if (c[3] < 1) this.note(k, `alpha ${fmt(c[3])} stays on the driven opacity — After Effects' Color Control has no alpha`);
        }
        break;
      case "checkbox":
        k.prop = keyed ? holds((v) => (v ? 1 : 0)) : { v: raw ? 1 : 0 };
        break;
      case "dropdown":
        k.prop = keyed ? holds(indexOf) : { v: indexOf(raw) };
        break;
      case "point":
        k.prop = keyed ? numericTrackToAe(block!, "vec2", kc).prop : { v: Array.isArray(raw) ? (raw as number[]).slice(0, 2) : [0, 0] };
        break;
      default:
        if (keyed) {
          const r = numericTrackToAe(block!, "scalar", kc);
          ctx.report.track(k.node, `${k.label} (control)`, r.report);
          k.prop = r.prop;
        } else k.prop = { v: typeof raw === "number" ? raw : Number(raw) || 0 };
    }
    if (keyed) this.note(k, "keyed: its keys and eases are on the control");
  }

  // The knob's static value (a data socket's: the flat node's override).
  private rawValue(ctx: WalkCtx, k: Knob): unknown {
    if (k.param.startsWith("in:")) {
      const n = ctx.graph.node(k.node) as { inputOverrides?: Record<string, unknown> } | undefined;
      return n?.inputOverrides?.[k.param.slice(3)];
    }
    const b = ctx.graph.block(k.node, k.param);
    if (b && b.keyframes.length >= 1) return b.keyframes[0].value;
    return ctx.graph.params(k.node)[k.param];
  }

  // The knob as an expression of its TOOLBOX value.
  private valueRef(k: Knob, what: string): string {
    const ref = this.token(k, what);
    if (k.control === "dropdown") return `${JSON.stringify(k.options ?? [])}[${ref} - 1]`;
    if (k.control === "checkbox") return `(${ref} != 0)`;
    if (k.quantize) {
      const q = `Math.round(${ref} / ${fmt(k.quantize.step)}) * ${fmt(k.quantize.step)}`;
      return k.quantize.integer ? `Math.round(${q})` : `(${q})`;
    }
    return ref;
  }

  // A numeric knob for (node, param), or why not (recorded on the knob).
  private numeric(ctx: WalkCtx, node: string, param: string): Knob | undefined {
    const k = this.knobAt(node, param);
    if (!k || !k.control) return undefined;
    if (!param.startsWith("in:") && ctx.graph.wireInto(node, `in:param:${param}`)) {
      this.note(k, `${ctx.graph.name(node)}.${param} is wired: the wire wins over the knob`);
      return undefined;
    }
    if (k.control !== "slider" && k.control !== "angle") {
      this.note(k, `${ctx.graph.name(node)}.${param} takes a number, not this ${k.control}`);
      return undefined;
    }
    return k;
  }

  // scalarProp: a knob → { the value now, expression a·control + b }.
  scalar(ctx: WalkCtx, clock: WalkClock, node: string, param: string, map: AeAffine, label: string): AeProp<number> | null {
    const k = this.numeric(ctx, node, param);
    if (!k) return null;
    this.ensureProp(ctx, clock, k);
    const v = this.valueNow(ctx, clock, node, param);
    return { v: map.scale * v + map.offset, expression: affine(this.valueRef(k, `${ctx.graph.name(node)} › ${label}`), map.scale, map.offset) };
  }

  private valueNow(ctx: WalkCtx, clock: WalkClock, node: string, param: string): number {
    const tick = windowFrames(clock)[0] * ctx.tpf - clock.offsetTicks;
    return valueOfSource(ctx, { node, param, fallback: 0 }, tick);
  }

  // pairProp: knob parts of a 2-D prop → an expression on those components.
  hasKnob(parts: { node: string; param: string }[]): boolean {
    return parts.some((p) => this.knobAt(p.node, p.param));
  }

  pair(ctx: WalkCtx, clock: WalkClock, parts: { node: string; param: string; map?: AeAffine }[], prop: AeProp<[number, number]>, label: string): AeProp<[number, number]> {
    const comps = parts.map((p) => {
      const k = this.numeric(ctx, p.node, p.param);
      if (!k) return null;
      this.ensureProp(ctx, clock, k);
      const m = p.map ?? { scale: 1, offset: 0 };
      return affine(this.valueRef(k, `${ctx.graph.name(p.node)} › ${label} ${p.param}`), m.scale, m.offset);
    });
    if (comps.every((x) => x === null)) return prop;
    return { ...prop, expression: vecExpr(dimsOf(prop), comps) };
  }

  // colorProp: a color knob → the property reads the Color Control.
  color(ctx: WalkCtx, clock: WalkClock, node: string, param: string, shapeOrSolid: boolean, label: string): AeProp<AeRGB> | null {
    const k = this.knobAt(node, param);
    if (!k || !k.control) return null;
    if (ctx.graph.wireInto(node, `in:param:${param}`)) {
      this.note(k, `${ctx.graph.name(node)}.${param} is wired: the wire wins over the knob`);
      return null;
    }
    if (k.control !== "color") {
      this.note(k, `${ctx.graph.name(node)}.${param} takes a color, not this ${k.control}`);
      return null;
    }
    this.ensureProp(ctx, clock, k, shapeOrSolid);
    const c = colorToRgba(this.colorNow(ctx, clock, node, param));
    return { v: [clamp01(c[0]), clamp01(c[1]), clamp01(c[2])], expression: this.valueRef(k, `${ctx.graph.name(node)} › ${label}`) };
  }

  private colorNow(ctx: WalkCtx, clock: WalkClock, node: string, param: string): unknown {
    const b = ctx.graph.block(node, param);
    if (b && b.keyframes.length > 1) return evaluateKeyframesAt(b, "color", windowFrames(clock)[0] * ctx.tpf - clock.offsetTicks) ?? b.keyframes[0].value;
    return b?.keyframes[0]?.value ?? ctx.graph.params(node)[param] ?? "#ffffff";
  }

  // nodeTransform: TRS knobs → expressions on rotation, scale, anchor and
  // position, from opToAeStatic's formulas: anchor = pivot px, position =
  // pivot px + W·translate, scale = 100·max(0.0001, s), rotation = degrees.
  trs(ctx: WalkCtx, clock: WalkClock, id: string, t: NodeTrs, r: Pick<AeTransformResult, "transform" | "aabbAnimates">, box: { minX: number; minY: number; maxX: number; maxY: number } | null | undefined, space: "local" | "global"): void {
    const P = ["translateX", "translateY", "scaleX", "scaleY", "rotate", "pivotX", "pivotY"] as const;
    const knobs = new Map<string, Knob>();
    for (const p of P) {
      const k = this.knobAt(id, p);
      if (!k) continue;
      if (t.driven) {
        this.note(k, `${ctx.graph.name(id)}: another transform param is wired, so the transform is sampled per frame — not linked`);
        continue;
      }
      const n = this.numeric(ctx, id, p);
      if (n) knobs.set(p, n);
    }
    if (!knobs.size) return;
    const T = r.transform;
    const name = ctx.graph.name(id);
    const W = ctx.canvas.width;
    const keyed = (p: string) => isKeyed(t.tracks[p as keyof typeof t.tracks] as AeTrackSource);
    const now = (p: string, fb: number) => {
      const s = t.tracks[p as keyof typeof t.tracks];
      return typeof s === "number" ? s : Array.isArray(s) ? (s[0] ?? fb) : this.valueNow(ctx, clock, id, p);
    };
    const ref = (p: string, what: string) => {
      const k = knobs.get(p)!;
      this.ensureProp(ctx, clock, k);
      return this.valueRef(k, `${name} › ${what}`);
    };
    // Rotation: degrees both sides.
    if (knobs.has("rotate")) T.rotation = { v: now("rotate", 0), expression: ref("rotate", "Rotation") };
    // Scale: percent, clamped like opFromParams.
    if (knobs.has("scaleX") || knobs.has("scaleY")) {
      const parts = (["scaleX", "scaleY"] as const).map((p) => (knobs.has(p) ? `Math.max(0.0001, ${ref(p, "Scale")}) * 100` : null));
      T.scale = { ...T.scale, expression: vecExpr(dimsOf(T.scale), parts) };
    }
    // Pivot → px: canvas, or the input's (static) bounding box for space=local.
    const ax = canvasAxisAffine("x", ctx.canvas);
    const ay = canvasAxisAffine("y", ctx.canvas);
    let pm: [AeAffine, AeAffine] | null = [ax, ay];
    if (space === "local") {
      const degenerate = !box || box.maxX <= box.minX || box.maxY <= box.minY;
      pm = r.aabbAnimates || degenerate ? null : [
        { scale: ax.scale * (box!.maxX - box!.minX), offset: ax.scale * box!.minX + ax.offset },
        { scale: ay.scale * (box!.maxY - box!.minY), offset: ay.scale * box!.minY + ay.offset },
      ];
    }
    const pivots = ["pivotX", "pivotY"] as const;
    const translates = ["translateX", "translateY"] as const;
    if (!pm) for (const p of pivots) if (knobs.has(p)) {
      this.note(knobs.get(p)!, `${name}: space=local over a moving bounding box — the anchor is keyed every frame, not linked`);
      knobs.delete(p);
    }
    if (pm && (knobs.has("pivotX") || knobs.has("pivotY"))) {
      const parts = pivots.map((p, d) => (knobs.has(p) ? affine(ref(p, "Anchor Point"), pm![d].scale, pm![d].offset) : null));
      T.anchor = { ...T.anchor, expression: vecExpr(dimsOf(T.anchor), parts) };
    }
    // Position component d = pivot_px(d) + W·translate(d).
    const posPart = (d: 0 | 1): string | null => {
      const pv = pivots[d];
      const tr = translates[d];
      const kp = pm && knobs.has(pv);
      const kt = knobs.has(tr);
      if (!kp && !kt) return null;
      const terms: string[] = [];
      let base = 0;
      let rest = false; // a non-knob contributor that moves
      if (kp) {
        terms.push(affine(ref(pv, "Position"), pm![d].scale, 0));
        base += pm![d].offset;
      } else if (keyed(pv) || r.aabbAnimates || !pm) rest = true;
      else base += pm[d].scale * now(pv, 0.5) + pm[d].offset;
      if (kt) terms.push(affine(ref(tr, "Position"), W, 0));
      else if (keyed(tr)) rest = true;
      else base += W * now(tr, 0);
      if (!rest) return `${terms.join(" + ")}${base === 0 ? "" : base < 0 ? ` - ${fmt(-base)}` : ` + ${fmt(base)}`}`;
      // Something else moves: offset AE's own value by the knob's change —
      // exact while the knob itself is static.
      const own = [kp ? pv : null, kt ? tr : null].filter((x): x is "pivotX" | "pivotY" | "translateX" | "translateY" => !!x);
      if (own.some((p) => keyed(p))) {
        for (const p of own) this.note(knobs.get(p)!, `${name}: keyed together with another moving position term — Position not linked`);
        return null;
      }
      const deltas = own.map((p) => {
        const a = p.startsWith("pivot") ? pm![d].scale : W;
        return `${fmt(a)} * (${ref(p, "Position")} - ${fmt(now(p, p.startsWith("pivot") ? 0.5 : 0))})`;
      });
      return `VALUE + ${deltas.join(" + ")}`;
    };
    const px = posPart(0);
    const py = posPart(1);
    if (px === null && py === null) return;
    if (T.separated) {
      if (px) T.separated.x = { ...T.separated.x, expression: px.replace("VALUE", "value") };
      if (py) T.separated.y = { ...T.separated.y, expression: py.replace("VALUE", "value") };
    } else if (T.position) {
      T.position = { ...T.position, expression: vecExpr(dimsOf(T.position), [px?.replace("VALUE", "value[0]") ?? null, py?.replace("VALUE", "value[1]") ?? null]) };
    }
  }

  // A toolbox layer's own opacity knob, over its content's static opacity.
  layerOpacity(ctx: WalkCtx, layerId: string, content: AeProp<number>, current: AeProp<number>): AeProp<number> {
    const k = this.numeric(ctx, layerId, "opacity");
    if (!k) return current;
    if (!("v" in content)) {
      this.note(k, `${ctx.graph.name(layerId)}: its content's opacity is keyed — the layer opacity is not linked`);
      return current;
    }
    const clock: WalkClock = { offsetTicks: 0, inFrame: 0, outFrame: ctx.durationFrames };
    this.ensureProp(ctx, clock, k);
    const v = "v" in current ? current.v : this.valueNow(ctx, clock, layerId, "opacity") * content.v;
    return { v, expression: affine(this.valueRef(k, `${ctx.graph.name(layerId)} › Opacity`), content.v, 0) };
  }

  // A calibrated effect param (calibration.ts AeParamMap): affine scalar
  // maps, enum and boolean maps by table. Color maps go through colorProp.
  mapped(ctx: WalkCtx, clock: WalkClock, node: string, param: string, m: AeParamMap, ectx: AeEffectContext, effect: string): AeProp | null {
    const k = this.knobAt(node, param);
    if (!k || !k.control || m.kind === "color") return null;
    if (ctx.graph.wireInto(node, `in:param:${param}`)) return null;
    const what = `${ctx.graph.name(node)} › ${effect} ${m.prop}`;
    if (m.kind === "scalar") {
      if (!m.linear) {
        this.note(k, `${ctx.graph.name(node)}.${param} → ${m.prop} is not an affine map — not linked`);
        return null;
      }
      if (!this.numeric(ctx, node, param)) return null;
      const lin = m.linear(ectx);
      this.ensureProp(ctx, clock, k);
      return { v: lin.scale * this.valueNow(ctx, clock, node, param) + lin.offset, expression: affine(this.valueRef(k, what), lin.scale, lin.offset) };
    }
    if ((m.kind === "enum" && k.control === "dropdown") || (m.kind === "bool" && k.control === "checkbox")) {
      const values = m.kind === "enum" ? (k.options ?? []).map((o) => m.map(o, ectx)) : [m.map(false, ectx), m.map(true, ectx)];
      if (!values.every((x) => typeof x === "number" || typeof x === "boolean")) {
        this.note(k, `${m.prop}'s values are not numbers — not linked`);
        return null;
      }
      const nums = values.map(Number);
      this.ensureProp(ctx, clock, k);
      const ref = this.token(k, what);
      const expr = m.kind === "enum" ? `${JSON.stringify(nums)}[${ref} - 1]` : `${ref} != 0 ? ${fmt(nums[1])} : ${fmt(nums[0])}`;
      return { v: Number(m.map(this.rawValue(ctx, k), ectx)), expression: expr };
    }
    this.note(k, `${ctx.graph.name(node)}.${param} (${m.kind}) has no ${k.control} form — not linked`);
    return null;
  }

  // A Toolbox Shader slider whose channel is a knob (a promoted channel, or
  // a Constant knob wired into it): an AE effect param, linked directly.
  tbx(ctx: WalkCtx, clock: WalkClock, fused: string, channel: string, label: string): AeProp | null {
    // A channel's socket is "in:<channel id>" (glsl-expression
    // resolveInputs), so its handle is "in:in:<id>"; the bundle names it.
    const rows = (ctx.graph.params(fused).inputs as { id?: string; name?: string }[] | undefined) ?? [];
    const id = rows.find((r) => r.name === channel)?.id ?? channel;
    const k = this.knobAt(fused, `in:in:${id}`);
    if (!k || (k.control !== "slider" && k.control !== "angle")) return null;
    this.ensureProp(ctx, clock, k);
    const raw = k.param.startsWith("in:") ? this.rawValue(ctx, k) : this.valueNow(ctx, clock, k.node, k.param);
    return { v: Number(raw) || 0, expression: this.valueRef(k, `${label} › slider ${channel}`) };
  }

  // knobExpression for the expression compiler.
  expression(ctx: WalkCtx, node: string, param: string): string | null {
    const k = this.knobAt(node, param);
    if (!k || !k.control) return null;
    this.ensureProp(ctx, { offsetTicks: 0, inFrame: 0, outFrame: ctx.durationFrames }, k);
    return this.valueRef(k, `${ctx.graph.name(node)} › ${param} (value graph)`);
  }

  // --- the final pass ---------------------------------------------------------------------

  // Resolves every placeholder, adds each comp's Controls null, and returns
  // the report lines. Call once, after comps and layers have final names.
  finish(ctx: WalkCtx, scene: AeScene): AeControlLine[] {
    if (!this.knobs.length) return [];
    const comps = new Map(scene.comps.map((c) => [c.id, c]));
    const main = comps.get(scene.main)!;
    // Who contains whom (precomp layers), for a home comp's nested precomps.
    const parents = new Map<string, Set<string>>();
    for (const c of scene.comps) for (const L of c.layers) if (L.kind === "precomp" && L.source && comps.has(L.source)) (parents.get(L.source) ?? parents.set(L.source, new Set()).get(L.source)!).add(c.id);
    const ancestorHome = (cid: string, homes: Set<string>): string | undefined => {
      const seen = new Set<string>();
      const queue = [...(parents.get(cid) ?? [])];
      while (queue.length) {
        const x = queue.shift()!;
        if (seen.has(x)) continue;
        seen.add(x);
        if (homes.has(x)) return x;
        queue.push(...(parents.get(x) ?? []));
      }
      return undefined;
    };
    // Every expression with placeholders, by comp.
    const uses: { comp: AeComp; holder: { expression?: string } }[] = [];
    const seen = new Map<object, string>();
    const walk = (o: unknown, comp: AeComp) => {
      if (!o || typeof o !== "object") return;
      if (seen.has(o)) return;
      seen.set(o, comp.id);
      if (Array.isArray(o)) {
        for (const x of o) walk(x, comp);
        return;
      }
      const rec = o as Record<string, unknown>;
      if (typeof rec.expression === "string" && rec.expression.includes("$tbxKnob")) uses.push({ comp, holder: rec as { expression?: string } });
      for (const v of Object.values(rec)) walk(v, comp);
    };
    for (const c of scene.comps) for (const L of c.layers) walk(L, c);

    // Which comp hosts each knob's control for an expression in `comp`.
    const hostOf = (k: Knob, comp: AeComp): { host: AeComp; essential: boolean } => {
      const homes = k.owner ? this.homes.get(k.owner.id) : undefined;
      if (homes?.size) {
        if (homes.has(comp.id)) return { host: comp, essential: true };
        const up = ancestorHome(comp.id, homes);
        if (up) {
          this.note(k, `read inside a nested precomp of "${comps.get(up)!.name}": it follows that comp's own value, not a precomp layer's Essential Property override`);
          return { host: comps.get(up)!, essential: true };
        }
        this.note(k, `${k.owner!.name} is not a precomp where this is read — the control is on the main comp's Controls null`);
      }
      return { host: main, essential: false };
    };
    interface Host { comp: AeComp; layerName: string; knobs: Knob[]; essential: Set<Knob>; labels: Map<Knob, string> }
    const hosts = new Map<string, Host>();
    const hostFor = (comp: AeComp): Host => {
      let h = hosts.get(comp.id);
      if (!h) {
        const names = new Set(comp.layers.map((l) => l.name));
        let layerName = CONTROLS_LAYER;
        for (let n = 2; names.has(layerName); n++) layerName = `${CONTROLS_LAYER} ${n}`;
        h = { comp, layerName, knobs: [], essential: new Set(), labels: new Map() };
        hosts.set(comp.id, h);
      }
      return h;
    };
    const drives = new Map<Knob, Set<string>>();
    const at = new Map<Knob, Set<string>>();
    for (const u of uses) {
      u.holder.expression = u.holder.expression!.replace(TOKEN, (_, kk: string, ll: string) => {
        const k = this.knobs[Number(kk)];
        const { host, essential } = hostOf(k, u.comp);
        const h = hostFor(host);
        if (!h.knobs.includes(k)) h.knobs.push(k);
        if (essential) h.essential.add(k);
        const link = this.links[Number(ll)];
        (drives.get(k) ?? drives.set(k, new Set()).get(k)!).add(link?.what ?? "?");
        const layerRef = host === u.comp ? `thisComp.layer(${JSON.stringify(h.layerName)})` : `comp(${JSON.stringify(host.name)}).layer(${JSON.stringify(h.layerName)})`;
        return `${layerRef}.effect(${JSON.stringify(this.labelIn(h, k))})(1)`;
      });
    }
    // The Controls nulls (knob order; Essential Graphics in the same order).
    for (const h of hosts.values()) {
      h.knobs.sort((a, b) => a.k - b.k);
      const effects: AeEffect[] = h.knobs.map((k) => {
        const spec = AE_CONTROL[k.control!];
        const label = this.labelIn(h, k);
        (at.get(k) ?? at.set(k, new Set()).get(k)!).add(`${h.comp.name} › ${h.layerName} › ${label}`);
        return {
          match: spec.match,
          name: label,
          ...(k.control === "dropdown" ? { menuItems: k.optionLabels ?? k.options ?? [] } : {}),
          props: { [spec.prop]: k.prop ?? { v: 0 } },
          ...(h.essential.has(k) ? { essential: label } : {}),
        };
      });
      const L: AeLayer = {
        id: ctx.uid(`controls:${h.comp.id}`),
        name: h.layerName,
        kind: "null",
        inPoint: 0,
        outPoint: h.comp.duration,
        startTime: 0,
        blendingMode: "normal",
        transform: originTransform(),
        effects,
        origin: [...new Set(h.knobs.map((k) => k.node))],
      };
      h.comp.layers.unshift(L);
    }

    // Report.
    const r = scene.report;
    const idsOf = (list: { id: string }[]) => new Set(list.map((l) => l.id));
    const baked = idsOf(r.baked);
    const shader = idsOf(r.shader);
    const sampled = new Set([...r.native, ...r.approx].filter((l) => l.fidelity === "sampled").map((l) => l.id));
    const consumers = (k: Knob) => [...this.at.entries()].filter(([, x]) => x === k).map(([key]) => key.split("\n")[0]);
    return this.knobs.map((k): AeControlLine => {
      const where = [...(at.get(k) ?? [])];
      const notes = [...k.declined, ...(this.notes.get(k) ?? [])];
      const line: AeControlLine = {
        node: k.node,
        param: k.param,
        label: k.label,
        source: k.source,
        ...(k.owner ? { owner: k.owner } : {}),
        ...(k.control ? { control: k.control } : {}),
        landed: "unlinked",
        at: where,
        drives: [...(drives.get(k) ?? [])],
      };
      if (where.length) {
        line.landed = [...hosts.values()].some((h) => h.essential.has(k)) ? "essential" : "controls";
      } else {
        const ids = [k.node, ...consumers(k)];
        if (ids.some((id) => baked.has(id))) {
          line.landed = "baked";
          notes.unshift("it feeds baked footage — its current value is in the frames");
        } else if (ids.some((id) => shader.has(id))) {
          line.landed = "baked";
          notes.unshift("inside a Toolbox Shader region — the fused shader holds its current value");
        } else if (ids.some((id) => sampled.has(id)) && !notes.length) {
          notes.push("it drives a value graph, sampled to per-frame keys (the expression compiler links it through knobExpression)");
        } else if (!notes.length) notes.push("nothing it reaches maps to an After Effects property natively");
      }
      if (notes.length) line.note = notes.join("; ");
      return line;
    });
  }

  // A knob's effect name on a host's Controls null: its label (a promoted
  // knob on the main comp says whose input it is), unique on that layer.
  private labelIn(h: { labels: Map<Knob, string>; comp: AeComp }, k: Knob): string {
    const have = h.labels.get(k);
    if (have) return have;
    const base = k.owner && !this.homes.get(k.owner.id)?.has(h.comp.id) ? `${k.owner.name} · ${k.label}` : k.label;
    const used = new Set(h.labels.values());
    let name = base;
    for (let n = 2; used.has(name); n++) name = `${base} ${n}`;
    h.labels.set(k, name);
    return name;
  }
}

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);

// The walk's graph with Constant-knob wires hidden: the consumer's param
// reads as the constant's value (its keys included).
function aliasedGraph(g: AeGraph, alias: Map<string, { node: string; knob: Knob }>): AeGraph {
  if (!alias.size) return g;
  const hidden = (e: { target: string; targetHandle: string }) => alias.has(`${e.target}\n${e.targetHandle}`);
  const constValue = (node: string): unknown => {
    const v = g.valueAt(`${node}:out`, 0) as { value?: unknown } | undefined;
    return typeof v?.value === "number" ? v.value : g.params(node).value;
  };
  return {
    ...g,
    into: (id) => g.into(id).filter((e) => !hidden(e)),
    outOf: (id) => g.outOf(id).filter((e) => !hidden(e)),
    wireInto: (id, handle) => (alias.has(`${id}\n${handle}`) ? undefined : g.wireInto(id, handle)),
    block(id, param): KeyframeAnimationBlock | undefined {
      const a = alias.get(`${id}\nin:param:${param}`);
      return a ? g.block(a.node, "value") : g.block(id, param);
    },
    params(id) {
      const p = g.params(id);
      let out: Record<string, unknown> | undefined;
      for (const [key, a] of alias) {
        const [target, handle] = key.split("\n");
        if (target !== id) continue;
        out ??= { ...p };
        out[handle.slice("in:param:".length)] = constValue(a.node);
      }
      return out ?? p;
    },
  };
}

// The expression compiler's leaf lookup: an AE expression for the value of
// (node, param) when that param is an exposed knob (a Control-toggled param,
// a promoted group input, a Constant knob's value), else null. The result is
// in TOOLBOX units — a number (Slider / Angle), 0/1 compare (Checkbox), the
// option string (Dropdown), [r, g, b, a] 0–1 (Color), [x, y] (Point) — and
// carries a placeholder the walk resolves to the right Controls layer for
// whichever comp the expression lands in.
export function knobExpression(ctx: WalkCtx, nodeId: string, param: string): string | null {
  return ctx.knobs.expression(ctx, nodeId, param);
}
