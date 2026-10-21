// The value-graph expressions in After Effects itself (M4 lane 1): the
// p-expressions fixture and the whole check-expressions corpus are built by
// build.jsx in ONE headless aerender launch (calibrate/ae.mts runAeJob — the
// one-launch Startup hook, under the shared AE lock; the After Effects GUI is
// never contacted), and every compiled property is read back with
// valueAtTime(t, false) at every frame. Each AE value is compared with
//   toolbox   the per-frame keys the walk samples from graph.valueAt
//             (policy.drivers "keys" — what the expression replaces), and
//   node      the same expression text in a node:vm AE shim (as
//             check-expressions runs it): engine vs engine.
// Frame-mode Random (AE's own seedRandom) is held to its range only.
//
//   npx tsx scripts/fixtures/ae-export/graphs/expressions-roundtrip.mts          build + measure
//   npx tsx scripts/fixtures/ae-export/graphs/expressions-roundtrip.mts --no-ae  packages only
//   … --work DIR      package / job folder (default: a temp dir)
//   … --record        write calibrate/measured/expressions.json (per-case summary)
//
// Needs After Effects 26.x (AE_DIR) and "Allow Scripts to Write Files and
// Access Network" on (the job writes JSON).

/* eslint-disable @typescript-eslint/no-explicit-any */

import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";
import { loadRegistry } from "../../../ae-export/harness.mts";
import { HERE as CAL, REPO, runAeJob } from "../../../ae-export-spike/calibrate/ae.mts";
import { aeShim, buildCorpus, caseOf, expressionProps, FPS, FRAMES, get, H, P_EXPRESSION_CASES, same, sampledAt, W, type Case } from "./expressions-corpus.mts";
import { GraphBuilder, SCENE_FIXTURES, sceneOf } from "./fixtures.mts";

const args = process.argv.slice(2);
const noAe = args.includes("--no-ae");
const record = args.includes("--record");
const wi = args.indexOf("--work");
const WORK = wi >= 0 ? args[wi + 1] : join(tmpdir(), `toolbox-ae-expressions-${Date.now()}`);

await loadRegistry();
const { buildAeSceneForEditor } = await import("@/lib/ae-export/scene");
const { HEADER_MARK } = await import("@/lib/ae-export/scene/expressions");
const { makeInstanceNode, makeLayerNodes } = await import("@/state/graph-ops");
const { writeTbxfx } = await import("@/lib/ae-export/shader");

type Build = ReturnType<typeof buildAeSceneForEditor>;
interface Pkg {
  name: string;
  dir: string;
  A: Build; // compiled
  B: Build; // sampled (the oracle)
  cases: Case[];
}

// The two scenes: the fixture, and the corpus as check-expressions builds it.
const fx = SCENE_FIXTURES.find((f) => f.name === "p-expressions")!;
const corpusGraph = new GraphBuilder({ makeInstanceNode, makeLayerNodes });
const corpusCases = buildCorpus(corpusGraph);
const corpusScene = (drivers: "expression" | "keys") =>
  buildAeSceneForEditor(corpusGraph.nodes, corpusGraph.edges, {
    env: { composition: { id: "comp-expr", name: "Expressions corpus", width: W, height: H, fps: FPS, durationFrames: FRAMES }, policy: { drivers } },
    name: "Expressions corpus",
    toolboxVersion: "roundtrip",
    generatedAt: "2026-10-21T00:00:00.000Z",
  });
const pkgs: Pkg[] = [
  {
    name: "p-expressions",
    dir: join(WORK, "p-expressions.aepkg"),
    A: await sceneOf(fx),
    B: await sceneOf({ ...fx, opts: { policy: { drivers: "keys" } } }),
    cases: corpusCases.filter((k) => (P_EXPRESSION_CASES as readonly string[]).includes(k.id)),
  },
  { name: "expressions-corpus", dir: join(WORK, "expressions-corpus.aepkg"), A: corpusScene("expression"), B: corpusScene("keys"), cases: corpusCases },
];

mkdirSync(WORK, { recursive: true });
for (const p of pkgs) {
  if (p.A.problems.length) throw new Error(`${p.name}: ${p.A.problems.join("; ")}`);
  if (p.A.bakes.length || p.A.assets.length) throw new Error(`${p.name}: bakes / assets — the corpus should have none`);
  mkdirSync(join(p.dir, "footage"), { recursive: true });
  writeFileSync(join(p.dir, "scene.json"), JSON.stringify(p.A.scene, null, 1));
  copyFileSync(join(REPO, "src/lib/ae-export/runtime/build.jsx"), join(p.dir, "build.jsx"));
  for (const t of p.A.files) writeFileSync(join(p.dir, t.path), t.text);
  for (const pr of p.A.presets) {
    mkdirSync(join(p.dir, "presets"), { recursive: true });
    writeFileSync(join(p.dir, pr.path), pr.bytes);
  }
  for (const b of p.A.bundles) {
    mkdirSync(join(p.dir, "shaders"), { recursive: true });
    writeFileSync(join(p.dir, "shaders", `${b.id}.tbxfx`), writeTbxfx(b));
  }
}
const exprCount = pkgs.map((p) => expressionProps(p.A.scene, HEADER_MARK).length);
console.log(`packages in ${WORK}: ${pkgs.map((p, i) => `${p.name} (${exprCount[i]} expressions)`).join(", ")}`);
if (noAe) process.exit(0);

const times = Array.from({ length: FRAMES }, (_, f) => f / FPS);
const t0 = Date.now();
const job = await runAeJob(
  "expressions",
  "expressions.jsx",
  { packages: pkgs.map((p) => ({ name: p.name, dir: p.dir, comps: p.A.scene.comps.map((c) => c.name), times, mark: HEADER_MARK })) },
  WORK,
  900_000
);
console.log(`aerender: exit ${job.code}, ${((Date.now() - t0) / 1000).toFixed(1)} s (log ${job.log}); AE ${job.out.ae}`);
if (job.out.errors?.length) console.log("job errors:", job.out.errors);

let failures = 0;
const summary: Record<string, unknown>[] = [];
const norm = (s: string) => s.replace(/\r\n?/g, "\n");
// "d:<sign>:<exponent>:<hi26>:<lo26>" → the double (exact); other text as Number.
const decode = (v: unknown): number => {
  const m = typeof v === "string" ? /^d:(-?1):(-?\d+):(\d+):(\d+)$/.exec(v) : null;
  if (!m) return Number(v);
  const mant = Number(m[3]) * 67108864 + Number(m[4]);
  return Number(m[1]) * (mant === 0 ? 0 : mant * 2 ** (Number(m[2]) - 52));
};
for (const p of pkgs) {
  const rec = (job.out.packages as any[]).find((x) => x.name === p.name);
  console.log(`\n${p.name}: build ${rec?.build?.ok ? "ok" : "FAILED"} in ${rec?.build?.seconds ?? "?"} s, ${rec?.props?.length ?? 0} expression props read in ${rec?.readSeconds ?? "?"} s${rec?.build?.problems?.length ? `; problems ${JSON.stringify(rec.build.problems)}` : ""}`);
  if (!rec?.build?.ok) {
    failures++;
    continue;
  }
  const unused = new Set<any>(rec.props);
  const found = expressionProps(p.A.scene, HEADER_MARK);
  const perCase = new Map<string, { props: number; frames: number; vsToolbox: number; vsNode: number; exact: number; errors: string[]; notes: string[] }>();
  for (const f of found) {
    const id = caseOf(f.prop.expression);
    const k = p.cases.find((x) => x.id === id);
    const row = perCase.get(id) ?? { props: 0, frames: 0, vsToolbox: 0, vsNode: 0, exact: 0, errors: [], notes: [] };
    perCase.set(id, row);
    row.props++;
    const comp = p.A.scene.comps[f.path[1] as number];
    const layer = comp.layers[f.path[3] as number];
    const ae = [...unused].find((x) => x.comp === comp.name && x.layer === layer.name && norm(x.expression) === f.prop.expression);
    if (!ae) {
      row.errors.push(`${f.path.slice(4).join(".")}: not found in the AE project`);
      continue;
    }
    unused.delete(ae);
    if (ae.expressionError) row.errors.push(`${ae.name}: expressionError ${JSON.stringify(ae.expressionError)}`);
    if (!ae.expressionEnabled) row.errors.push(`${ae.name}: expression disabled`);
    const script = new vm.Script(f.prop.expression);
    const want = get(p.B.scene, f.path);
    for (let fr = f.frames[0]; fr <= f.frames[1]; fr++) {
      // Numbers arrive as their exact bits (expressions.jsx num); "!…" is a
      // valueAtTime error.
      const raw = ae.values[fr];
      if (typeof raw === "string" && raw.startsWith("!")) {
        row.errors.push(`frame ${fr}: ${raw}`);
        break;
      }
      const got = (Array.isArray(raw) ? raw : [raw]).map(decode);
      const nodeV = script.runInNewContext(aeShim(fr / f.fps, f.fps));
      const node = (Array.isArray(nodeV) ? nodeV : [nodeV]) as number[];
      if (k?.expect === "random") {
        if (!got.every((x) => x >= k.range![0] && x <= k.range![1])) row.errors.push(`frame ${fr}: ${JSON.stringify(got)} outside ${JSON.stringify(k.range)}`);
        row.frames++;
        continue;
      }
      const w = sampledAt(want, fr, f.fps);
      if (!w) {
        row.errors.push(`frame ${fr}: no sampled value`);
        break;
      }
      for (let i = 0; i < w.length; i++) {
        if (!Number.isFinite(got[i])) {
          if (!same(got[i], w[i])) row.errors.push(`frame ${fr}[${i}]: AE ${got[i]}, toolbox ${w[i]}`);
          continue;
        }
        row.vsToolbox = Math.max(row.vsToolbox, Math.abs(got[i] - w[i]) / Math.max(1, Math.abs(w[i])));
        row.vsNode = Math.max(row.vsNode, Math.abs(got[i] - node[i]) / Math.max(1, Math.abs(node[i])));
      }
      if (w.length === 3 && got.length === 4 && got[3] !== 1) row.errors.push(`frame ${fr}: color alpha ${got[3]}`);
      if (w.every((x, i) => Object.is(x, got[i]) || x === got[i])) row.exact++;
      row.frames++;
    }
  }
  if (unused.size) console.log(`  ${unused.size} AE expression props matched nothing in the scene`);
  // Relative to max(1, |v|). AE computes the same doubles but for the last
  // bit of an occasional sin / cos / log / pow (measured 2026-10-21: 7312 of
  // 7330 frames bit-identical, the rest ≤ 3.4e-16); the bar is 1e-6.
  const TOL = 1e-6;
  for (const [id, r] of [...perCase].sort()) {
    const k = p.cases.find((x) => x.id === id);
    const bad = r.errors.length > 0 || (k?.expect !== "random" && r.vsToolbox > TOL);
    if (bad) failures++;
    const what = k?.expect === "random" ? "in range (AE's seedRandom)" : `${r.exact}/${r.frames} bit-identical; max rel |AE − toolbox| ${r.vsToolbox.toExponential(1)}, |AE − node| ${r.vsNode.toExponential(1)}`;
    console.log(`  ${bad ? "FAIL" : "ok  "} ${id.padEnd(30)} ${r.props} prop${r.props > 1 ? "s" : " "} × ${String(r.frames).padStart(4)} frames  ${what}${r.errors.length ? `  ${r.errors.slice(0, 3).join("; ")}` : ""}`);
    summary.push({ package: p.name, case: id, props: r.props, frames: r.frames, bitIdentical: r.exact, vsToolbox: Number(r.vsToolbox.toPrecision(3)), vsNode: Number(r.vsNode.toPrecision(3)), errors: r.errors.slice(0, 5) });
  }
}
if (record) {
  const out = join(CAL, "measured", "expressions.json");
  writeFileSync(out, `{"ae":${JSON.stringify(job.out.ae)},"measured":${JSON.stringify(new Date().toISOString().slice(0, 10))},"cases":[\n${summary.map((s) => JSON.stringify(s)).join(",\n")}\n]}\n`);
  console.log(`\nwrote ${out}`);
}
console.log(failures ? `\nexpressions round trip: ${failures} FAILED (work ${WORK})` : `\nexpressions round trip: all passed (work ${WORK})`);
process.exit(failures ? 1 : 0);
