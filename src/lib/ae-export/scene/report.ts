// scene.report (AePlanReport): the plan's verdict per node, corrected by what
// the walk actually did. The plan says what a node SHOULD become; the walk
// knows when an effect map was a placeholder, a driver was sampled, a key
// interval went dense, a text font was guessed or a region baked after all.
// Every such fact lands on the node's line, so the README and the build
// summary name each approximation, sample, bake and dense-key range.

import type { AeColorReport, AeTrackReport } from "../convert";
import type { AeExportClass, AeExportPlan, AeFidelity, AePlanReport, AeReportLine } from "../types";

interface Line {
  id: string;
  type: string;
  name?: string;
  class: AeExportClass;
  fidelity: AeFidelity;
  notes: string[];
}

// Worse wins: a node that is sampled AND approximated reads approx.
const RANK: Record<AeFidelity, number> = { exact: 0, sampled: 1, approx: 2, bake: 3 };

const fmt = (t: number) => (Math.round(t * 1000) / 1000).toString();

export class AeReport {
  private lines = new Map<string, Line>();
  readonly warnings: string[] = [];
  readonly fonts = new Set<string>();
  shaderHost?: string;

  constructor(plan: AeExportPlan) {
    for (const L of plan.layers)
      for (const n of L.nodes)
        this.lines.set(n.id, { id: n.id, type: n.type, ...(n.name ? { name: n.name } : {}), class: n.class, fidelity: n.fidelity, notes: [] });
    for (const f of plan.fonts) this.fonts.add(f);
  }

  private line(id: string, type = "?"): Line {
    let l = this.lines.get(id);
    if (!l) {
      l = { id, type, class: "layer", fidelity: "exact", notes: [] };
      this.lines.set(id, l);
    }
    return l;
  }

  // A node the plan did not list (a toolbox layer shell, a fused node).
  ensure(id: string, type: string, cls: AeExportClass, name?: string): void {
    const l = this.line(id, type);
    l.type = type;
    l.class = cls;
    if (name) l.name = name;
  }

  note(id: string, text: string): void {
    const l = this.line(id);
    if (!l.notes.includes(text)) l.notes.push(text);
  }

  fidelity(id: string, f: AeFidelity, text?: string): void {
    const l = this.line(id);
    if (RANK[f] > RANK[l.fidelity]) l.fidelity = f;
    if (text) this.note(id, text);
  }

  approx(id: string, text: string): void {
    this.fidelity(id, "approx", text);
  }

  sampled(id: string, text: string): void {
    this.fidelity(id, "sampled", text);
  }

  // The node ended up in another class than the plan said (an effect with
  // no AE map → shader / bake, a vector segment that had to bake…).
  reclass(id: string, cls: AeExportClass, f: AeFidelity, text: string): void {
    const l = this.line(id);
    l.class = cls;
    l.fidelity = f;
    this.note(id, text);
  }

  track(id: string, what: string, r: AeTrackReport): void {
    for (const n of r.notes) this.note(id, `${what}: ${n}`);
    for (const d of r.dense) this.fidelity(id, "sampled", `${what}: per-frame keys ${fmt(d.t0)}–${fmt(d.t1)} s (${d.reason})`);
    if (r.fidelity === "approx") this.approx(id, `${what}: within ${r.maxError.toPrecision(3)} (AE units) of toolbox at every frame`);
  }

  color(id: string, what: string, r: AeColorReport): void {
    this.track(id, what, r);
    if (r.mode === "expression") this.note(id, `${what}: OKLab tween as an expression on linear RGB keys (exact, not graph-editable)`);
    if (r.mode === "dense") this.note(id, `${what}: OKLab tween as dense RGB keys within ${r.maxError255.toFixed(1)}/255`);
    if (r.mode === "rgb") this.approx(id, `${what}: RGB interpolation — worst ${r.maxError255.toFixed(1)}/255 off toolbox's OKLab`);
  }

  warn(text: string): void {
    if (!this.warnings.includes(text)) this.warnings.push(text);
  }

  build(plan: AeExportPlan, route: AePlanReport["route"]): AePlanReport {
    const out: AePlanReport = { route, native: [], approx: [], shader: [], baked: [], blocked: [], warnings: [...plan.warnings, ...this.warnings], requires: { fonts: [...this.fonts].sort() } };
    if (this.shaderHost) out.requires.shaderHost = this.shaderHost;
    for (const l of this.lines.values()) {
      const r: AeReportLine = {
        id: l.id,
        type: l.type,
        ...(l.name ? { name: l.name } : {}),
        class: l.class,
        fidelity: l.fidelity,
        ...(l.notes.length ? { note: l.notes.join(" · ") } : {}),
      };
      if (l.class === "unsupported") out.blocked.push(r);
      else if (l.class === "bake" || l.fidelity === "bake") out.baked.push(r);
      else if (l.class === "shader") out.shader.push(r);
      else if (l.fidelity === "approx") out.approx.push(r);
      else out.native.push(r);
    }
    return out;
  }
}
