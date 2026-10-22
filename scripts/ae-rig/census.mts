// AE rig census (specdocs/102126_ae-rig-export.md §3.1, §10): plan every
// project in the corpus and measure which controls would survive in After
// Effects — today (the result export), under the first draft's stock-AE
// expression rig, and under the geometry host — through freeze propagation,
// then rank the work.
//
//   npx tsx scripts/ae-rig/fetch-corpus.mts --owner-of Sketch_017   (once)
//   npx tsx scripts/ae-rig/portability.mts                           (for the host scenarios)
//   npx tsx scripts/ae-rig/census.mts [.corpus/ae-rig] [--explain <project name>]
//
// --explain prints one project's nodes: touched / visible controls, today's
// tier and whether it's live, the rig tier, gap and liveness — the way to
// check a case study by hand.
//
// Per project, the active composition only. The composition is flattened
// the way the evaluator and the planner see it (flattenAeComposition), the
// real planner classifies each node (today's tier), and tiers.mts gives the
// rig tier. A node's controls are LIVE when its tier is live and some path
// from it to the Output passes only through nodes that recompute from that
// input in AE. A frozen, sampled or baked node kills every control upstream
// of it, unless another live path reaches the Output.
//
// Controls = a node's visible settable params; "touched" = the ones the
// designer changed (non-default, keyframed or exposed). Rankings use
// touched controls.
//
// Rankings:
//   emitters   leave-one-out: in the rig scenario, the touched controls that
//              die if this node type's rig emitter is never built
//   gaps       add-one: in the rig scenario, the touched controls a plugin
//              for this node type (all inputs passing) would revive
//
// Writes <corpus>/census.json and <corpus>/census.md (gitignored: they name
// projects). Planning only — no evaluation, no After Effects.

/* eslint-disable @typescript-eslint/no-explicit-any */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadRegistry } from "../ae-export/harness.mts";
import { LIVE, rigRule, TODAY_PASS, todayTier, type RigRule, type Tier } from "./tiers.mts";

const argv = process.argv.slice(2);
const explainAt = argv.indexOf("--explain");
const explain = explainAt >= 0 ? argv.splice(explainAt, 2)[1] : undefined;
const corpus = resolve(argv[0] ?? ".corpus/ae-rig");

await loadRegistry();
const { deserializeGraph } = await import("@/lib/project");
const { flattenAeComposition, planAeExportForEditor } = await import("@/lib/ae-export/editor");
const { aeExportEntry, AE_STRUCTURAL_TYPES } = await import("@/lib/ae-export/classes");
const { getNodeDef } = await import("@/engine/registry");
const { SETTABLE_PARAM_TYPES } = await import("@/engine/node-catalog");

// ---- one project ---------------------------------------------------------------

interface Row {
  id: string;
  type: string;
  // Outputs points or a spline here (polymorphic nodes resolved from their
  // wiring) — the owner's priority slice.
  geometry: boolean;
  controls: number;
  touched: number;
  today: Tier;
  rig: RigRule;
  planned: boolean;
}

interface Wire {
  to: string;
  socket: string;
}

interface Project {
  file: string;
  name: string;
  folder: string | null;
  route?: string;
  planError?: string;
  rows: Map<string, Row>;
  outs: Map<string, Wire[]>;
  sink: string;
}

// Media the planner never reads; stripped stubs and unresolved Storage refs
// would only make the deserializer try to decode them.
function dropMedia(graph: any): any {
  const isMedia = (v: any) =>
    (typeof v === "string" && v.startsWith("data:")) ||
    (v &&
      typeof v === "object" &&
      !Array.isArray(v) &&
      ("dataUrl" in v || "cloud" in v || ("asset" in v && "kind" in v) || /_file$/.test(String(v.kind ?? ""))));
  for (const n of graph.nodes ?? []) {
    for (const [k, v] of Object.entries(n.params ?? {})) if (isMedia(v)) delete n.params[k];
  }
  for (const c of graph.compositions ?? []) delete c.thumbnail;
  delete graph.assetLibrary;
  return graph;
}

function controlsOf(type: string, params: Record<string, unknown>, animation: any, exposed: string[] | undefined, inputTypes: Record<string, unknown>, wired: Record<string, boolean>) {
  const def = getNodeDef(type);
  let controls = 0;
  let touched = 0;
  for (const p of def?.params ?? []) {
    if (!SETTABLE_PARAM_TYPES.has(p.type) || p.hidden) continue;
    let visible = true;
    try {
      visible = p.visibleIf ? !!p.visibleIf(params, { inputTypes: inputTypes as any, wired }) : true;
    } catch {
      visible = true;
    }
    if (!visible) continue;
    controls++;
    const changed = params[p.name] !== undefined && JSON.stringify(params[p.name]) !== JSON.stringify(p.default);
    if (changed || animation?.[p.name]?.animated || exposed?.includes(p.name)) touched++;
  }
  return { controls, touched };
}

async function loadProject(file: string): Promise<Project> {
  const { meta, graph } = JSON.parse(readFileSync(join(corpus, file), "utf8"));
  const g = await deserializeGraph(dropMedia(graph), undefined, { deferRemoteMedia: true });
  const comp = g.compositions.find((c) => c.id === g.activeCompositionId);
  const sc = comp?.scene ?? {};
  const flat = flattenAeComposition(g.nodes as any, g.edges as any, g.activeCompositionId);

  const project: Project = { file, name: meta.name, folder: meta.folder ?? null, rows: new Map(), outs: new Map(), sink: "" };
  const sinkNode = flat.allNodes.find((n) => n.type === "output" && !n.parentId);
  project.sink = sinkNode?.id ?? "";

  const planned = new Map<string, { cls: string; fidelity: string; ae?: string }>();
  try {
    const plan = planAeExportForEditor(g.nodes as any, g.edges as any, {
      composition: {
        id: comp?.id ?? "comp",
        name: comp?.name ?? "comp",
        width: sc.width ?? 1920,
        height: sc.height ?? 1080,
        fps: sc.fps ?? 60,
        durationFrames: sc.loopFrames ?? 300,
      },
      compositionId: g.activeCompositionId,
    });
    project.route = plan.route;
    for (const l of plan.layers) for (const n of (l as any).nodes ?? []) planned.set(n.id, { cls: n.class, fidelity: n.fidelity, ae: n.ae });
    // Value graphs compiled into one expression are listed there, not per node.
    for (const x of plan.expressions)
      for (const id of x.nodes) if (!planned.has(id)) planned.set(id, { cls: "expression", fidelity: x.sampled ? "sampled" : "exact" });
  } catch (e) {
    project.planError = (e as Error).message.slice(0, 160);
  }

  const wiredInto = new Map<string, Record<string, boolean>>();
  for (const w of flat.wires) {
    const socket = w.targetHandle.replace(/^in:/, "");
    (project.outs.get(w.source) ?? project.outs.set(w.source, []).get(w.source)!).push({ to: w.target, socket });
    (wiredInto.get(w.target) ?? wiredInto.set(w.target, {}).get(w.target)!)[socket] = true;
  }

  for (const n of flat.allNodes) {
    if (n.type === "output" || AE_STRUCTURAL_TYPES.has(n.type) || !getNodeDef(n.type)) continue;
    const p = planned.get(n.id);
    const st = aeExportEntry(n.type);
    const staticTier = todayTier(st.class, st.fidelity, n.type, st.ae);
    const today = p ? todayTier(p.cls, p.fidelity, n.type, p.ae) : staticTier;
    const { controls, touched } = controlsOf(n.type, n.params ?? {}, n.animation, n.exposedParams, flat.connectedTypes(n.id), wiredInto.get(n.id) ?? {});
    const def = getNodeDef(n.type);
    let out: unknown = def?.primaryOutput;
    try {
      out = def?.resolvePrimaryOutput?.(n.params ?? {}, { connectedTypes: flat.connectedTypes(n.id) }) ?? out;
    } catch {
      // keep the static type
    }
    project.rows.set(n.id, {
      id: n.id,
      type: n.type,
      geometry: out === "points" || out === "spline" || out === "points3d",
      controls,
      touched,
      today,
      rig: rigRule(n.type, n.params ?? {}, today, staticTier, getNodeDef(n.type)),
      planned: !!p,
    });
  }
  return project;
}

// ---- freeze propagation --------------------------------------------------------

interface Scenario {
  tier(r: Row): Tier;
  // undefined → the default: pass when the node's tier is live.
  pass(r: Row, socket: string): boolean | undefined;
}

const TODAY: Scenario = {
  tier: (r) => r.today,
  pass: (r, s) => TODAY_PASS[r.type]?.[s],
};
const RIG: Scenario = {
  tier: (r) => r.rig.tier,
  pass: (r, s) => r.rig.pass?.[s],
};
const ALL_PASS: Scenario = { tier: () => "native", pass: () => true };

// The geometry host (spec §4): a points / spline node runs inside it when
// portability.mts saw its type compute with no GL and never throw; the
// spline → image terminals are drawn by the host. HOST_PORTED adds the
// types that threw (their GPU steps ported). Without portability.json the
// host scenarios are skipped.
const portability = (() => {
  try {
    const rows = JSON.parse(readFileSync(join(corpus, "portability.json"), "utf8")) as { type: string; ok: number; errors: Record<string, number> }[];
    return new Map(rows.map((r) => [r.type, { ok: r.ok, threw: Object.values(r.errors).reduce((a, b) => a + b, 0) }]));
  } catch {
    return null;
  }
})();
const HOST_DRAW = new Set(["rasterize-spline", "spline-stroke", "spline-fill"]);
function hostScenario(ported: boolean): Scenario {
  const inHost = (r: Row) => {
    if (HOST_DRAW.has(r.type)) return true;
    const p = portability?.get(r.type);
    if (!r.geometry || !p) return false;
    return p.threw === 0 ? p.ok > 0 : ported;
  };
  return {
    tier: (r) => (inHost(r) ? "plugin" : RIG.tier(r)),
    pass: (r, s) => (inHost(r) ? true : RIG.pass(r, s)),
  };
}
const HOST = hostScenario(false);
const HOST_PORTED = hostScenario(true);

function withType(base: Scenario, type: string, as: Scenario): Scenario {
  return {
    tier: (r) => (r.type === type ? as.tier(r) : base.tier(r)),
    pass: (r, s) => (r.type === type ? as.pass(r, s) : base.pass(r, s)),
  };
}
function withNode(base: Scenario, id: string, as: Scenario): Scenario {
  return {
    tier: (r) => (r.id === id ? as.tier(r) : base.tier(r)),
    pass: (r, s) => (r.id === id ? as.pass(r, s) : base.pass(r, s)),
  };
}
const PLUGIN: Scenario = { tier: () => "plugin", pass: () => true };

// Ids whose controls are live under `sc`.
function liveSet(p: Project, sc: Scenario): Set<string> {
  const memo = new Map<string, boolean>();
  const passes = (consumer: string, socket: string): boolean => {
    const r = p.rows.get(consumer);
    if (!r) return true; // structural: groups, layers, reroutes, zone inputs
    const live = LIVE.has(sc.tier(r));
    if (!live) return false;
    return sc.pass(r, socket) ?? true;
  };
  const reached = (id: string): boolean => {
    if (id === p.sink) return true;
    const m = memo.get(id);
    if (m !== undefined) return m;
    memo.set(id, false); // cycle guard
    let ok = false;
    for (const w of p.outs.get(id) ?? []) {
      if (passes(w.to, w.socket) && reached(w.to)) {
        ok = true;
        break;
      }
    }
    memo.set(id, ok);
    return ok;
  };
  const out = new Set<string>();
  for (const r of p.rows.values()) if (LIVE.has(sc.tier(r)) && reached(r.id)) out.add(r.id);
  return out;
}

function touchedLive(p: Project, live: Set<string>, used: Set<string>, geometryOnly = false): number {
  let t = 0;
  for (const id of live) {
    const r = p.rows.get(id)!;
    if (used.has(id) && (!geometryOnly || r.geometry)) t += r.touched;
  }
  return t;
}

// ---- run -----------------------------------------------------------------------

const files = readdirSync(join(corpus, "projects")).filter((f) => f.endsWith(".json")).map((f) => `projects/${f}`);
const projects: Project[] = [];
const loadErrors: { file: string; error: string }[] = [];
// Some loads wait on browser-only work (image or font decode) that never
// settles headless; the timer also keeps the event loop alive meanwhile.
const LOAD_TIMEOUT_MS = 20_000;
for (const f of files) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_, rej) => {
      timer = setTimeout(() => rej(new Error(`load timed out after ${LOAD_TIMEOUT_MS / 1000}s`)), LOAD_TIMEOUT_MS);
    });
    projects.push(await Promise.race([loadProject(f), timeout]));
    process.stdout.write(".");
  } catch (e) {
    process.stdout.write("x");
    loadErrors.push({ file: f, error: (e as Error).message.slice(0, 160) });
  } finally {
    clearTimeout(timer);
  }
}
process.stdout.write("\n");

interface TypeStat {
  type: string;
  projects: Set<string>;
  nodes: number;
  touched: number;
  todayTiers: Set<Tier>;
  rigTiers: Set<Tier>;
  gaps: Set<string>;
  costs: Set<string>;
  notes: Set<string>;
  loss: number; // emitters: leave-one-out in the rig scenario
  gain: number; // gaps: add-one plugin in the rig scenario
  unplanned: number;
  unplannedProjects: Set<string>;
}
const types = new Map<string, TypeStat>();
const perProject: any[] = [];
let totTouched = 0;
let totToday = 0;
let totRig = 0;
let totCeiling = 0;
let totEmitterOnly = 0;
let totKernelOnly = 0;
const geo = { touched: 0, today: 0, rig: 0, host: 0, hostPorted: 0, ceiling: 0 };
let totHost = 0;
let totHostPorted = 0;

for (const p of projects) {
  const used = liveSet(p, ALL_PASS);
  const usedRows = [...p.rows.values()].filter((r) => used.has(r.id));
  const touched = usedRows.reduce((s, r) => s + r.touched, 0);
  const today = touchedLive(p, liveSet(p, TODAY), used);
  const rigLive = liveSet(p, RIG);
  const rig = touchedLive(p, rigLive, used);
  const deadRigRows = usedRows.filter((r) => !LIVE.has(r.rig.tier));
  const ceilingSc: Scenario = {
    tier: (r) => (LIVE.has(r.rig.tier) ? r.rig.tier : "plugin"),
    pass: (r, s) => (LIVE.has(r.rig.tier) ? r.rig.pass?.[s] : true),
  };
  const ceiling = touchedLive(p, liveSet(p, ceilingSc), used);
  // The rig built in halves: only the planner routes, or only the kernels.
  const only = (gap: string): Scenario => ({
    tier: (r) => (r.rig.gap === gap ? r.rig.tier : r.today),
    pass: (r, s) => (r.rig.gap === gap ? r.rig.pass?.[s] : TODAY_PASS[r.type]?.[s]),
  });
  totEmitterOnly += touchedLive(p, liveSet(p, only("emitter")), used);
  totKernelOnly += touchedLive(p, liveSet(p, only("kernel")), used);
  geo.touched += usedRows.filter((r) => r.geometry).reduce((s, r) => s + r.touched, 0);
  geo.today += touchedLive(p, liveSet(p, TODAY), used, true);
  geo.rig += touchedLive(p, rigLive, used, true);
  geo.ceiling += touchedLive(p, liveSet(p, ceilingSc), used, true);
  if (portability) {
    const h = liveSet(p, HOST);
    const hp = liveSet(p, HOST_PORTED);
    totHost += touchedLive(p, h, used);
    totHostPorted += touchedLive(p, hp, used);
    geo.host += touchedLive(p, h, used, true);
    geo.hostPorted += touchedLive(p, hp, used, true);
  }
  totTouched += touched;
  totToday += today;
  totRig += rig;
  totCeiling += ceiling;

  // Keystone: the dead-in-rig node whose plugin revives the most.
  let keystone: { type: string; id: string; gain: number } | null = null;
  for (const r of deadRigRows) {
    const gain = touchedLive(p, liveSet(p, withNode(RIG, r.id, PLUGIN)), used) - rig;
    if (!keystone || gain > keystone.gain) keystone = { type: r.type, id: r.id, gain };
  }

  for (const t of new Set(usedRows.map((r) => r.type))) {
    const rows = usedRows.filter((r) => r.type === t);
    const st =
      types.get(t) ??
      types
        .set(t, {
          type: t,
          projects: new Set(),
          nodes: 0,
          touched: 0,
          todayTiers: new Set(),
          rigTiers: new Set(),
          gaps: new Set(),
          costs: new Set(),
          notes: new Set(),
          loss: 0,
          gain: 0,
          unplanned: 0,
          unplannedProjects: new Set(),
        })
        .get(t)!;
    st.projects.add(p.name);
    st.nodes += rows.length;
    st.touched += rows.reduce((s, r) => s + r.touched, 0);
    for (const r of rows) {
      st.todayTiers.add(r.today);
      st.rigTiers.add(r.rig.tier);
      if (r.rig.gap) st.gaps.add(r.rig.gap);
      if (r.rig.cost) st.costs.add(r.rig.cost);
      if (r.rig.note) st.notes.add(r.rig.note);
    }
    const missing = p.planError ? 0 : rows.filter((r) => !r.planned).length;
    st.unplanned += missing;
    if (missing) st.unplannedProjects.add(p.name);
    const needsWork = rows.some((r) => LIVE.has(r.rig.tier) && !LIVE.has(r.today));
    if (needsWork) st.loss += rig - touchedLive(p, liveSet(p, withType(RIG, t, TODAY)), used);
    if (rows.some((r) => !LIVE.has(r.rig.tier))) st.gain += touchedLive(p, liveSet(p, withType(RIG, t, PLUGIN)), used) - rig;
  }

  if (explain && p.name === explain) {
    const liveToday = liveSet(p, TODAY);
    const host = portability ? liveSet(p, HOST) : null;
    const hostPorted = portability ? liveSet(p, HOST_PORTED) : null;
    console.log(`\n${p.name}: route ${p.route ?? p.planError}`);
    console.log("  node                              touched/ctl  today         rig                  host / ported  gap");
    for (const r of usedRows) {
      const mark = (live: boolean) => (live ? "live" : "dead");
      const h = host && hostPorted ? `${mark(host.has(r.id))} / ${mark(hostPorted.has(r.id))}` : "–";
      console.log(
        `  ${`${r.type} ${r.id.slice(-6)}`.padEnd(34)} ${`${r.touched}/${r.controls}`.padEnd(12)} ${`${r.today} ${mark(liveToday.has(r.id))}`.padEnd(13)} ${`${r.rig.tier} ${mark(rigLive.has(r.id))}`.padEnd(20)} ${h.padEnd(14)} ${r.rig.gap ?? ""}${r.planned ? "" : " (not in plan)"}`
      );
    }
  }

  perProject.push({
    name: p.name,
    folder: p.folder,
    file: p.file,
    route: p.route ?? null,
    planError: p.planError ?? null,
    nodes: usedRows.length,
    touched,
    liveToday: today,
    liveRig: rig,
    ceiling,
    keystone: keystone && keystone.gain > 0 ? keystone : null,
    unplanned: p.planError ? [] : usedRows.filter((r) => !r.planned).map((r) => r.type),
  });
}

// ---- report ----------------------------------------------------------------------

const pct = (a: number, b: number) => (b ? `${Math.round((100 * a) / b)}%` : "–");
const typeList = [...types.values()];
const emitters = typeList.filter((t) => t.loss > 0).sort((a, b) => b.loss - a.loss);
const gaps = typeList
  .filter((t) => [...t.rigTiers].some((x) => !LIVE.has(x)))
  .sort((a, b) => b.gain - a.gain || b.projects.size - a.projects.size);
const unplanned = typeList.filter((t) => t.unplanned > 0).sort((a, b) => b.unplanned - a.unplanned);
const unlisted = typeList.filter((t) => [...t.notes].some((n) => n.startsWith("unlisted") || n.startsWith("def.simulation")));
const join_ = (s: Set<string>) => [...s].join("/");
const notes = (t: TypeStat) => [...t.notes].join("; ");

const json = {
  generatedAt: new Date().toISOString(),
  corpus: { projects: projects.length, loadErrors },
  totals: {
    touched: totTouched,
    liveToday: totToday,
    liveEmittersOnly: totEmitterOnly,
    liveKernelsOnly: totKernelOnly,
    liveRig: totRig,
    liveHost: portability ? totHost : null,
    liveHostPorted: portability ? totHostPorted : null,
    ceiling: totCeiling,
    geometry: geo,
  },
  types: typeList.map((t) => ({
    ...t,
    projects: t.projects.size,
    todayTiers: [...t.todayTiers],
    rigTiers: [...t.rigTiers],
    gaps: [...t.gaps],
    costs: [...t.costs],
    notes: [...t.notes],
    unplannedProjects: t.unplannedProjects.size,
  })),
  projects: perProject,
};
writeFileSync(join(corpus, "census.json"), JSON.stringify(json, null, 1));

const md: string[] = [
  "# AE rig census",
  "",
  `Generated ${json.generatedAt} by scripts/ae-rig/census.mts over ${projects.length} projects` +
    (loadErrors.length ? ` (${loadErrors.length} failed to load)` : "") +
    ". Active composition only; counts are **touched** controls (non-default, keyframed or exposed) on nodes that reach the Output.",
  "",
  "| scenario | live touched controls |",
  "|---|---|",
  `| today (result export) | ${totToday} / ${totTouched} (${pct(totToday, totTouched)}) |`,
  `| only the planner routes (emitter gaps) | ${totEmitterOnly} (${pct(totEmitterOnly, totTouched)}) |`,
  `| only the kernels | ${totKernelOnly} (${pct(totKernelOnly, totTouched)}) |`,
  `| rig export, every kernel built | ${totRig} / ${totTouched} (${pct(totRig, totTouched)}) |`,
  ...(portability
    ? [
        `| geometry host, portable types as they run today | ${totHost} (${pct(totHost, totTouched)}) |`,
        `| geometry host, GPU-bound types ported | ${totHostPorted} (${pct(totHostPorted, totTouched)}) |`,
      ]
    : []),
  `| … and a plugin for every hard gap | ${totCeiling} / ${totTouched} (${pct(totCeiling, totTouched)}) |`,
  "",
  `Points / spline nodes only (the priority slice): today ${geo.today} / ${geo.touched} (${pct(geo.today, geo.touched)}), rig ${geo.rig} (${pct(geo.rig, geo.touched)})` +
    (portability ? `, host ${geo.host} (${pct(geo.host, geo.touched)}), host + ports ${geo.hostPorted} (${pct(geo.hostPorted, geo.touched)})` : "") +
    `, ceiling ${geo.ceiling} (${pct(geo.ceiling, geo.touched)}).`,
  "",
  "## Rig emitters, by controls lost if never built",
  "",
  "Leave-one-out in the rig scenario. `work`: emitter = a native AE mapping the planner doesn't take yet; kernel = an expression kernel. `cost` is the kernel class (heavy: M1 decides kernel vs plugin).",
  "",
  "| type | lost | work | projects | nodes | today | cost | note |",
  "|---|---|---|---|---|---|---|---|",
  ...emitters.map(
    (t) =>
      `| ${t.type} | ${t.loss} | ${join_(new Set([...t.gaps].filter((g) => g === "emitter" || g === "kernel")))} | ${t.projects.size} | ${t.nodes} | ${join_(t.todayTiers)} | ${join_(t.costs)} | ${notes(t)} |`
  ),
  "",
  "## Hard gaps, by controls a plugin would revive",
  "",
  "Add-one in the rig scenario: this type as a plugin effect whose inputs all pass.",
  "",
  "| type | revives | gap | projects | nodes | rig tier | note |",
  "|---|---|---|---|---|---|---|",
  ...gaps.map(
    (t) =>
      `| ${t.type} | ${t.gain} | ${join_(new Set([...t.gaps].filter((g) => g !== "emitter" && g !== "kernel")))} | ${t.projects.size} | ${t.nodes} | ${join_(t.rigTiers)} | ${notes(t)} |`
  ),
  "",
  "## Projects",
  "",
  "| project | folder | route | nodes | touched | today | rig | ceiling | rig keystone (revives) | unplanned |",
  "|---|---|---|---|---|---|---|---|---|---|",
  ...[...perProject]
    .sort((a, b) => b.touched - a.touched)
    .map(
      (p) =>
        `| ${p.name.replace(/\|/g, "/")} | ${p.folder ?? ""} | ${p.planError ? `error: ${p.planError.replace(/\|/g, "/")}` : p.route} | ${p.nodes} | ${p.touched} | ${pct(p.liveToday, p.touched)} | ${pct(p.liveRig, p.touched)} | ${pct(p.ceiling, p.touched)} | ${p.keystone ? `${p.keystone.type} (${p.keystone.gain})` : ""} | ${[...new Set(p.unplanned)].join(", ")} |`
    ),
  "",
  "## For the exporter: nodes that reach the Output but are missing from the plan",
  "",
  ...(unplanned.length ? unplanned.map((t) => `- ${t.type}: ${t.unplanned} nodes in ${t.unplannedProjects.size} projects`) : ["none"]),
  "",
  "## Rig rules to review (types tiers.mts doesn't list)",
  "",
  ...(unlisted.length ? unlisted.map((t) => `- ${t.type} (${t.projects.size} projects): ${notes(t)}`) : ["none"]),
  ...(loadErrors.length ? ["", "## Load errors", "", ...loadErrors.map((e) => `- ${e.file}: ${e.error}`)] : []),
];
writeFileSync(join(corpus, "census.md"), md.join("\n") + "\n");

console.log(`census: ${projects.length} projects${loadErrors.length ? `, ${loadErrors.length} load errors` : ""}`);
console.log(`  live touched controls: today ${totToday}/${totTouched} (${pct(totToday, totTouched)}) · rig ${totRig} (${pct(totRig, totTouched)}) · ceiling ${totCeiling} (${pct(totCeiling, totTouched)})`);
console.log(`  top emitters: ${emitters.slice(0, 8).map((t) => `${t.type} ${t.loss}`).join(", ")}`);
console.log(`  top gaps: ${gaps.slice(0, 8).map((t) => `${t.type} ${t.gain}`).join(", ")}`);
console.log(`  wrote ${join(corpus, "census.md")}`);
