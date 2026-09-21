// Bounce and elastic as sparse AE keyframes (absolute (t,v) cubic beziers, x at thirds).
const TAU = Math.PI * 2;
const bounce = u => { const n1 = 7.5625, d1 = 2.75;
  if (u < 1 / d1) return n1 * u * u;
  if (u < 2 / d1) { const x = u - 1.5 / d1; return n1 * x * x + 0.75; }
  if (u < 2.5 / d1) { const x = u - 2.25 / d1; return n1 * x * x + 0.9375; }
  const x = u - 2.625 / d1; return n1 * x * x + 0.984375; };
const elastic = u => { if (u === 0) return 0; if (u === 1) return 1; const c4 = TAU / 3; return Math.pow(2, -10 * u) * Math.sin((u * 10 - 0.75) * c4) + 1; };

// cubic in absolute space with x control points at thirds => x(s)=s, so v(t)=B(y; s=(t-t0)/D)
const cubicAbs = (t0, t1, y0, y1, y2, y3) => t => { const s = (t - t0) / (t1 - t0), o = 1 - s; return o*o*o*y0 + 3*o*o*s*y1 + 3*o*s*s*y2 + s*s*s*y3; };
function maxErr(f, g, a, b, n = 2000) { let m = 0; for (let i = 0; i <= n; i++) { const t = a + (b - a) * i / n; m = Math.max(m, Math.abs(f(t) - g(t))); } return m; }
const pct = x => (x * 100).toFixed(3) + "%";

console.log("== easeOutBounce: 5 keys, each piece an exact quadratic (degree-elevated) ==");
{
  const d1 = 2.75, cuts = [0, 1 / d1, 2 / d1, 2.5 / d1, 1], mins = [null, 0.75, 0.9375, 0.984375];
  let worst = 0; const keys = [];
  for (let k = 0; k < 4; k++) {
    const t0 = cuts[k], t1 = cuts[k + 1], D = t1 - t0;
    let g, desc;
    if (k === 0) { // n1 u^2 : easeInQuad from 0 to 1 -> y1 = 0, y2 = 1/3
      g = cubicAbs(t0, t1, 0, 0, 1 / 3, 1); desc = { outSpeed: 0, inSpeed: 2 / D, influence: 33.333 };
    } else { // parabola between two contacts at v=1 with minimum c: quadratic ctrl q = 2c-1 -> cubic y1=y2 = 1 - (4/3)(1-c)
      const c = mins[k], y = 1 - (4 / 3) * (1 - c);
      g = cubicAbs(t0, t1, 1, y, y, 1); desc = { outSpeed: -4 * (1 - c) / D, inSpeed: 4 * (1 - c) / D, influence: 33.333 };
    }
    worst = Math.max(worst, maxErr(bounce, g, t0, t1));
    keys.push({ u0: +t0.toFixed(4), u1: +t1.toFixed(4), ...Object.fromEntries(Object.entries(desc).map(([a, b]) => [a, +b.toFixed(3)])) });
  }
  console.log(JSON.stringify(keys));
  console.log("maxErr", pct(worst), "(speeds are in normalized value per normalized time; scale by ΔV/D for AE)");
}

console.log("\n== easeOutElastic: keys at start, the interior extrema and the end; one fitted cubic per segment ==");
{
  // find extrema
  const N = 200000; const ext = [];
  let prev = elastic(1 / N) - elastic(0);
  for (let i = 2; i <= N; i++) { const d = elastic(i / N) - elastic((i - 1) / N); if (Math.sign(d) !== Math.sign(prev)) ext.push((i - 1) / N); prev = d; }
  const cuts = [0, ...ext, 1];
  console.log("keys at u =", cuts.map(c => c.toFixed(4)).join(", "), `(${cuts.length} keys)`);
  let worst = 0; const segs = [];
  for (let k = 0; k < cuts.length - 1; k++) {
    const t0 = cuts[k], t1 = cuts[k + 1], v0 = elastic(t0), v1 = elastic(t1);
    // handles: flat at extrema (speed 0). At u=0 the out-handle is free; at u=1 the in-handle is ~flat (derivative ~0 as 2^-10 decays) — fit both x's, and y's where free.
    const startFlat = k > 0, endFlat = true;
    // grid search over x1,x2 (and y1 if start not flat)
    let best = { err: 1e9 };
    for (let x1 = 0.05; x1 <= 1.0001; x1 += 0.025) for (let x2 = 0; x2 <= 0.9501; x2 += 0.025) {
      const y1s = startFlat ? [v0] : Array.from({ length: 41 }, (_, i) => v0 + (v1 - v0) * (i / 40) * 1.5 - 0.25 * (v1 - v0));
      for (const y1 of y1s) {
        // general x positions: evaluate bezier by solving x(s)=t
        const g = t => { const tt = (t - t0) / (t1 - t0); let lo = 0, hi = 1, s = tt; for (let it = 0; it < 40; it++) { const o = 1 - s; const x = 3*o*o*s*x1 + 3*o*s*s*x2 + s*s*s; if (x < tt) lo = s; else hi = s; s = (lo + hi) / 2; } const o = 1 - s; return o*o*o*v0 + 3*o*o*s*y1 + 3*o*s*s*(endFlat ? v1 : v1) + s*s*s*v1; };
        const e = maxErr(elastic, g, t0, t1, 300);
        if (e < best.err) best = { err: e, x1, x2, y1 };
      }
    }
    worst = Math.max(worst, best.err);
    segs.push({ u0: +t0.toFixed(4), u1: +t1.toFixed(4), v0: +v0.toFixed(4), v1: +v1.toFixed(4), x1: +best.x1.toFixed(3), x2: +best.x2.toFixed(3), y1: +best.y1.toFixed(4), err: pct(best.err) });
  }
  console.table(segs);
  console.log("maxErr over all segments", pct(worst));
}
