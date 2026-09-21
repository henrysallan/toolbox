// Fidelity of exporting toolbox easing presets to After Effects temporal ease.
// AE's value graph between two keys is a cubic bezier in (time,value) with
// handles given by (influence, speed); any normalized cubic-bezier (x1,y1,x2,y2)
// with x in [0.001,1] maps exactly. So the question per preset is: how far is
// the best single cubic from easeOf()? And where do we need extra keys?

const HALF_PI = Math.PI / 2, TAU = Math.PI * 2;
const ease = {
  linear: u => u,
  easeInSine: u => 1 - Math.cos(u * HALF_PI),
  easeOutSine: u => Math.sin(u * HALF_PI),
  easeInOutSine: u => -(Math.cos(Math.PI * u) - 1) / 2,
  easeInQuad: u => u * u,
  easeOutQuad: u => 1 - (1 - u) * (1 - u),
  easeInOutQuad: u => (u < 0.5 ? 2 * u * u : 1 - Math.pow(-2 * u + 2, 2) / 2),
  easeInCubic: u => u * u * u,
  easeOutCubic: u => 1 - Math.pow(1 - u, 3),
  easeInOutCubic: u => (u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2),
  easeInExpo: u => (u === 0 ? 0 : Math.pow(2, 10 * u - 10)),
  easeOutExpo: u => (u === 1 ? 1 : 1 - Math.pow(2, -10 * u)),
  easeInBack: u => { const c1 = 1.70158, c3 = c1 + 1; return c3 * u * u * u - c1 * u * u; },
  easeOutBack: u => { const c1 = 1.70158, c3 = c1 + 1, i = u - 1; return 1 + c3 * i * i * i + c1 * i * i; },
  easeOutBounce: u => {
    const n1 = 7.5625, d1 = 2.75;
    if (u < 1 / d1) return n1 * u * u;
    if (u < 2 / d1) { const x = u - 1.5 / d1; return n1 * x * x + 0.75; }
    if (u < 2.5 / d1) { const x = u - 2.25 / d1; return n1 * x * x + 0.9375; }
    const x = u - 2.625 / d1; return n1 * x * x + 0.984375;
  },
  easeOutElastic: u => {
    if (u === 0) return 0; if (u === 1) return 1;
    const c4 = TAU / 3; return Math.pow(2, -10 * u) * Math.sin((u * 10 - 0.75) * c4) + 1;
  },
};

// toolbox EASING_PRESET_BEZIER (keyframes.ts:407)
const table = {
  linear: [0, 0, 1, 1],
  easeInQuad: [1 / 3, 0, 2 / 3, 1 / 3],
  easeOutQuad: [1 / 3, 2 / 3, 2 / 3, 1],
  easeInOutQuad: [0.455, 0.03, 0.515, 0.955],
  easeInCubic: [1 / 3, 0, 2 / 3, 0],
  easeOutCubic: [1 / 3, 1, 2 / 3, 1],
  easeInOutCubic: [0.645, 0.045, 0.355, 1],
  easeInSine: [0.47, 0, 0.745, 0.715],
  easeOutSine: [0.39, 0.575, 0.565, 1],
  easeInOutSine: [0.445, 0.05, 0.55, 0.95],
};
// Exact cubics for the polynomial presets the table lacks (derived: x at thirds,
// y from the power-basis coefficients).
const c1 = 1.70158;
const exact = {
  easeInBack: [1 / 3, 0, 2 / 3, -c1 / 3],
  easeOutBack: [1 / 3, 1 + c1 / 3, 2 / 3, 1],
};
// Customary CSS approximations for expo (Penner/easings.net)
const cssExpo = {
  easeInExpo: [0.7, 0, 0.84, 0],
  easeOutExpo: [0.16, 1, 0.3, 1],
};

function solveX(x1, x2, t) {
  // Newton + bisection on x(u) = t for the cubic with x0=0,x3=1
  const bx = u => 3 * (1 - u) * (1 - u) * u * x1 + 3 * (1 - u) * u * u * x2 + u * u * u;
  let lo = 0, hi = 1, u = t;
  for (let i = 0; i < 60; i++) {
    const x = bx(u);
    if (Math.abs(x - t) < 1e-12) return u;
    if (x < t) lo = u; else hi = u;
    u = (lo + hi) / 2;
  }
  return u;
}
function bez([x1, y1, x2, y2], t) {
  if (t <= 0) return 0; if (t >= 1) return 1;
  const u = solveX(Math.min(1, Math.max(0, x1)), Math.min(1, Math.max(0, x2)), t);
  const o = 1 - u;
  return 3 * o * o * u * y1 + 3 * o * u * u * y2 + u * u * u;
}
function maxErr(f, g, n = 2000) {
  let m = 0, at = 0;
  for (let i = 0; i <= n; i++) { const t = i / n; const e = Math.abs(f(t) - g(t)); if (e > m) { m = e; at = t; } }
  return { max: m, at };
}
// Nelder-Mead to find the best single cubic (minimax over samples) for a preset
function fitCubic(f, seed) {
  const cost = p => { const c = [p[0], p[1], p[2], p[3]]; if (c[0] < 0 || c[0] > 1 || c[2] < 0 || c[2] > 1) return 1e9; return maxErr(f, t => bez(c, t), 400).max; };
  let simplex = [seed, ...seed.map((_, i) => seed.map((v, j) => (i === j ? v + 0.1 : v)))];
  let vals = simplex.map(cost);
  for (let it = 0; it < 4000; it++) {
    const idx = vals.map((v, i) => i).sort((a, b) => vals[a] - vals[b]);
    simplex = idx.map(i => simplex[i]); vals = idx.map(i => vals[i]);
    const n = 4, cen = new Array(n).fill(0);
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) cen[j] += simplex[i][j] / n;
    const worst = simplex[n];
    const refl = cen.map((c, j) => c + (c - worst[j]));
    const fr = cost(refl);
    if (fr < vals[0]) {
      const exp = cen.map((c, j) => c + 2 * (c - worst[j])); const fe = cost(exp);
      if (fe < fr) { simplex[n] = exp; vals[n] = fe; } else { simplex[n] = refl; vals[n] = fr; }
    } else if (fr < vals[n - 1]) { simplex[n] = refl; vals[n] = fr; }
    else {
      const con = cen.map((c, j) => c + 0.5 * (worst[j] - c)); const fc = cost(con);
      if (fc < vals[n]) { simplex[n] = con; vals[n] = fc; }
      else { for (let i = 1; i <= n; i++) { simplex[i] = simplex[i].map((v, j) => simplex[0][j] + 0.5 * (v - simplex[0][j])); vals[i] = cost(simplex[i]); } }
    }
    if (Math.abs(vals[n] - vals[0]) < 1e-7) break;
  }
  return { cubic: simplex[0], err: vals[0] };
}

const fmt = n => (n * 100).toFixed(2) + "%";
const r4 = c => c.map(v => +v.toFixed(4));
console.log("== single-segment cubic vs easeOf (max |Δ| in normalized value) ==");
for (const [name, c] of Object.entries(table)) {
  const e = maxErr(ease[name], t => bez(c, t));
  console.log(`${name.padEnd(16)} table ${JSON.stringify(r4(c)).padEnd(34)} maxErr ${fmt(e.max)} @u=${e.at.toFixed(3)}`);
}
for (const [name, c] of Object.entries(exact)) {
  const e = maxErr(ease[name], t => bez(c, t));
  console.log(`${name.padEnd(16)} exact ${JSON.stringify(r4(c)).padEnd(34)} maxErr ${fmt(e.max)}`);
}
for (const [name, c] of Object.entries(cssExpo)) {
  const e = maxErr(ease[name], t => bez(c, t));
  const fit = fitCubic(ease[name], c);
  console.log(`${name.padEnd(16)} css   ${JSON.stringify(r4(c)).padEnd(34)} maxErr ${fmt(e.max)} | best-fit ${JSON.stringify(r4(fit.cubic))} maxErr ${fmt(fit.err)}`);
}
for (const name of ["easeInOutQuad", "easeInOutCubic", "easeInOutSine", "easeInSine", "easeOutSine"]) {
  const fit = fitCubic(ease[name], table[name]);
  console.log(`${name.padEnd(16)} best-fit ${JSON.stringify(r4(fit.cubic))} maxErr ${fmt(fit.err)}`);
}

// Two-segment exact export of the inOut polynomial presets: split at u=0.5,
// each half is the in/out quad/cubic shape renormalized.
console.log("\n== inOut presets split at the midpoint key (2 AE segments) ==");
function twoSeg(name, firstHalf, secondHalf) {
  const g = t => (t < 0.5 ? 0.5 * bez(firstHalf, t / 0.5) : 0.5 + 0.5 * bez(secondHalf, (t - 0.5) / 0.5));
  const e = maxErr(ease[name], g);
  console.log(`${name.padEnd(16)} halves ${JSON.stringify(r4(firstHalf))} + ${JSON.stringify(r4(secondHalf))} maxErr ${fmt(e.max)}`);
}
twoSeg("easeInOutQuad", table.easeInQuad, table.easeOutQuad);
twoSeg("easeInOutCubic", table.easeInCubic, table.easeOutCubic);
twoSeg("easeInOutSine", table.easeInSine, table.easeOutSine);

// Bounce: 4 parabolic pieces => 4 exact AE segments with keys at the bounce contacts.
console.log("\n== easeOutBounce as 4 exact segments ==");
{
  const d1 = 2.75, n1 = 7.5625;
  const cuts = [0, 1 / d1, 2 / d1, 2.5 / d1, 1];
  const f = ease.easeOutBounce;
  let worst = 0;
  const segs = [];
  for (let s = 0; s < 4; s++) {
    const t0 = cuts[s], t1 = cuts[s + 1], v0 = f(t0), v1 = f(t1);
    // each piece is n1*(u-m)^2 + k: a parabola => in local normalized coords a quadratic in time.
    // Fit exactly: sample three points and solve for y1,y2 with x at thirds.
    const D = t1 - t0, dv = v1 - v0 || 1;
    const loc = t => (f(t0 + t * D) - v0) / dv; // normalized value as fn of normalized time
    // quadratic y = a t^2 + b t (y(0)=0, y(1)=1 => a+b=1); bezier with x at thirds: y1 = b/3, y2 = (2b + a)/3 ... derive:
    // cubic bezier y(u)=3(1-u)^2 u y1 + 3(1-u)u^2 y2 + u^3 with coefficients t:3y1, t^2:-6y1+3y2, t^3: 3y1-3y2+1
    // want t^3 coeff 0 => y2 = y1 + 1/3 ; t coeff b = 3y1 => y1 = b/3 ; then a = -6y1+3y2 = -2b + b + 1 = 1 - b  (consistent)
    const b = (loc(0.5) - 0.25 * (1 - 0)) / (0.5 - 0.25); // y(0.5) = a/4 + b/2 = (1-b)/4 + b/2 = 1/4 + b/4 => b = 4*y(0.5) - 1
    const bb = 4 * loc(0.5) - 1;
    const c = [1 / 3, bb / 3, 2 / 3, bb / 3 + 1 / 3];
    const g = t => v0 + dv * bez(c, (t - t0) / D);
    let m = 0; for (let i = 0; i <= 500; i++) { const t = t0 + (i / 500) * D; m = Math.max(m, Math.abs(f(t) - g(t))); }
    worst = Math.max(worst, m);
    segs.push({ from: +t0.toFixed(4), to: +t1.toFixed(4), v0: +v0.toFixed(4), v1: +v1.toFixed(4), cubic: r4(c) });
  }
  console.log(JSON.stringify(segs, null, 0));
  console.log(`maxErr over all pieces ${fmt(worst)} (keys at u = ${cuts.map(c => c.toFixed(3)).join(", ")})`);
}

// Elastic & expo: how many evenly spaced LINEAR keys (baked) for < 1% / < 0.5% error?
console.log("\n== baked linear keys needed (uniform spacing) ==");
for (const name of ["easeOutElastic", "easeInExpo", "easeOutExpo", "easeInOutSine"]) {
  const f = ease[name];
  for (const tol of [0.01, 0.005]) {
    let n = 1;
    for (; n <= 400; n++) {
      const g = t => { const i = Math.min(n - 1, Math.floor(t * n)); const a = i / n, b = (i + 1) / n; const w = (t - a) / (b - a); return f(a) + (f(b) - f(a)) * w; };
      if (maxErr(f, g, 4000).max < tol) break;
    }
    console.log(`${name.padEnd(16)} tol ${fmt(tol)} → ${n} segments (${n + 1} keys)`);
  }
}
// Elastic with sampled keys at extrema + cubic segments? Report the extrema count instead.
{
  const f = ease.easeOutElastic; let ext = 0; let prev = f(0.0005) - f(0);
  for (let i = 2; i <= 4000; i++) { const d = f(i / 4000) - f((i - 1) / 4000); if (Math.sign(d) !== Math.sign(prev) && Math.abs(d) > 1e-9) ext++; prev = d; }
  console.log(`easeOutElastic has ${ext} interior extrema (each a natural key with zero speed)`);
}

// AE speed/influence for a demo segment
console.log("\n== AE KeyframeEase for a 1 s, 100 px segment ==");
function aeEase([x1, y1, x2, y2], D, dV) {
  const xo = Math.max(0.001, x1), xi = Math.max(0.001, 1 - x2);
  return {
    out: { influence: +(xo * 100).toFixed(3), speed: +((y1 / xo) * (dV / D)).toFixed(3) },
    in: { influence: +(xi * 100).toFixed(3), speed: +(((1 - y2) / xi) * (dV / D)).toFixed(3) },
  };
}
for (const name of ["easeOutCubic", "easeInOutQuad", "easeOutBack"]) {
  const c = table[name] ?? exact[name];
  console.log(name.padEnd(16), JSON.stringify(aeEase(c, 1, 100)));
}

// OKLab vs RGB color interpolation: how many intermediate keys until AE's
// per-channel linear-in-sRGB interpolation stays within 2/255 of OKLab?
console.log("\n== OKLab keyframe interpolation vs AE sRGB interpolation ==");
const s2l = c => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const l2s = c => (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);
function rgb2oklab([r, g, b]) {
  const [R, G, B] = [s2l(r), s2l(g), s2l(b)];
  const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
  const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
  const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}
function oklab2rgb([L, a, b]) {
  const l = Math.pow(L + 0.3963377774 * a + 0.2158037573 * b, 3);
  const m = Math.pow(L - 0.1055613458 * a - 0.0638541728 * b, 3);
  const s = Math.pow(L - 0.0894841775 * a - 1.291485548 * b, 3);
  const R = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  const G = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  const B = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s;
  return [R, G, B].map(v => Math.min(1, Math.max(0, l2s(v))));
}
const pairs = { "red→blue": [[1, 0, 0], [0, 0, 1]], "red→green": [[1, 0, 0], [0, 1, 0]], "black→white": [[0, 0, 0], [1, 1, 1]], "orange→teal": [[1, 0.5, 0], [0, 0.5, 0.5]], "navy→sky": [[0.05, 0.1, 0.3], [0.55, 0.8, 1]] };
for (const [label, [A, B]] of Object.entries(pairs)) {
  const la = rgb2oklab(A), lb = rgb2oklab(B);
  const ok = t => oklab2rgb(la.map((v, i) => v + (lb[i] - v) * t));
  const mid = ok(0.5).map(v => Math.round(v * 255)), midRgb = A.map((v, i) => Math.round((v + (B[i] - v) * 0.5) * 255));
  // find keys needed so piecewise-linear-in-sRGB (with the OKLab-sampled key values) is within tol per channel
  const need = tol => { for (let n = 1; n <= 64; n++) { let worst = 0; for (let i = 0; i <= 1000; i++) { const t = i / 1000; const k = Math.min(n - 1, Math.floor(t * n)); const a = k / n, b = (k + 1) / n; const w = (t - a) / (b - a); const ca = ok(a), cb = ok(b); const lin = ca.map((v, j) => v + (cb[j] - v) * w); const ref = ok(t); worst = Math.max(worst, ...lin.map((v, j) => Math.abs(v - ref[j]))); } if (worst < tol) return n; } return ">64"; };
  console.log(`${label.padEnd(12)} OKLab mid ${JSON.stringify(mid)} vs sRGB mid ${JSON.stringify(midRgb)} → segments for ≤2/255: ${need(2 / 255)}, ≤5/255: ${need(5 / 255)}`);
}
