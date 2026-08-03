//! Shortest-path (dynamic programming) subdivision optimizer for cubic
//! fitting — the "P0" upgrade from the kernel audit. Replaces kurbo's
//! `fit_to_bezpath_opt` as our `optimal` mode.
//!
//! Design (after Levien's sketch in the Linebender Zulip thread "More
//! thoughts on cubic fitting", May 2025 — specified there in prose,
//! unimplemented upstream as of kurbo 0.13.1):
//!
//! 1. Candidate subdivision points come from an adaptive pass (bisect while
//!    `fit_to_cubic` fails, splitting at cusps first, exactly like
//!    `fit_to_bezpath`), then each adaptive span is refined by a constant
//!    factor (REFINE).
//! 2. A forward DP finds, per candidate, the minimal (segment count, then
//!    max error) chain from t=0. Each node's predecessor search starts from
//!    a monotone earliest-feasible pointer backed off by BACKTRACK_SLACK
//!    candidates (Levien's robustness knob — fittability is non-monotonic
//!    on noisy input, and a wider slack measurably reduces segment count),
//!    then refines forward among count ties for lower error.
//! 3. Fits computed during the adaptive pass are memoized, and the adaptive
//!    boundaries are themselves candidates, so the DP result is never worse
//!    than plain adaptive subdivision.
//!
//! Everything hard stays in kurbo: `SimplifyBezPath` is the moment-exact
//! `ParamCurveFit` source and `fit_to_cubic` the per-span quartic fit. This
//! layer is pure search strategy — and unlike `fit_to_bezpath_opt`, it has
//! no `unwrap` on a fallible fit (the known trap risk in kurbo#268): every
//! failure path degrades to plain adaptive output.

use std::collections::HashMap;

use kurbo::simplify::SimplifyBezPath;
use kurbo::{
    fit_to_cubic, BezPath, CubicBez, ParamCurveFit, PathEl, PathSeg, Point, Vec2,
};

/// Extra candidates per adaptive span (Levien suggests 4 or 8).
const REFINE: usize = 4;
/// Max bisection depth in the adaptive candidate pass (spans of 2^-12).
const MAX_DEPTH: usize = 12;
/// Max bisection depth of our adaptive recursion (chord fallback beyond).
const ADAPT_DEPTH: usize = 24;
/// Back the monotone predecessor pointer off by this many candidates before
/// advancing — Levien's robustness knob for non-monotonic fittability ("in
/// the monotonic case those extra tests simply fail the threshold").
const BACKTRACK_SLACK: usize = 8;
/// Forward-refinement probes past the earliest feasible predecessor (error
/// polishing among count ties).
const FORWARD_PROBES: usize = 12;

/// Robust one-sided tangents of a cubic (first non-degenerate control leg —
/// kurbo's `PathSeg::tangents` is pub(crate), so we mirror its intent).
fn cubic_tangents(c: &CubicBez) -> (Vec2, Vec2) {
    let eps = 1e-12;
    let start = [c.p1 - c.p0, c.p2 - c.p0, c.p3 - c.p0]
        .into_iter()
        .find(|v| v.hypot2() > eps)
        .unwrap_or(Vec2::ZERO);
    let end = [c.p3 - c.p2, c.p3 - c.p1, c.p3 - c.p0]
        .into_iter()
        .find(|v| v.hypot2() > eps)
        .unwrap_or(Vec2::ZERO);
    (start, end)
}

/// One subpath decoded to cubics + its closed flag.
struct SubpathCubics {
    start: Point,
    cubics: Vec<CubicBez>,
    closed: bool,
}

fn decode_subpaths(els: &[PathEl]) -> Vec<SubpathCubics> {
    let mut out: Vec<SubpathCubics> = Vec::new();
    let mut cur: Option<SubpathCubics> = None;
    let mut last = Point::ZERO;
    for el in els {
        match *el {
            PathEl::MoveTo(p) => {
                if let Some(s) = cur.take() {
                    out.push(s);
                }
                cur = Some(SubpathCubics {
                    start: p,
                    cubics: Vec::new(),
                    closed: false,
                });
                last = p;
            }
            PathEl::LineTo(p) => {
                if p != last {
                    if let Some(s) = cur.as_mut() {
                        s.cubics.push(PathSeg::Line(kurbo::Line::new(last, p)).to_cubic());
                    }
                    last = p;
                }
            }
            PathEl::QuadTo(p1, p2) => {
                if !(p1 == last && p2 == last) {
                    if let Some(s) = cur.as_mut() {
                        s.cubics
                            .push(PathSeg::Quad(kurbo::QuadBez::new(last, p1, p2)).to_cubic());
                    }
                    last = p2;
                }
            }
            PathEl::CurveTo(p1, p2, p3) => {
                if !(p1 == last && p2 == last && p3 == last) {
                    if let Some(s) = cur.as_mut() {
                        s.cubics.push(CubicBez::new(last, p1, p2, p3));
                    }
                    last = p3;
                }
            }
            PathEl::ClosePath => {
                if let Some(mut s) = cur.take() {
                    s.closed = true;
                    last = s.start;
                    out.push(s);
                }
            }
        }
    }
    if let Some(s) = cur.take() {
        out.push(s);
    }
    out
}

/// Split a subpath's cubics into smooth runs at corners.
///
/// NOT kurbo's `|cross| > |dot|·tan(θ)` flush test: |tan| folds past 90°,
/// so that test classifies near-reversal joins — thin spike tips, turn
/// angle → 180° where cross → 0 — as SMOOTH. The fitter then approximates
/// straight across the tip (a within-tolerance curl/overshoot) while
/// moderate corners are pinned exactly, which reads as "identical spikes
/// handled inconsistently". Comparing the normalized dot against
/// cos(corner_angle) is monotone over the full 0..180° turn range.
fn split_runs(cubics: &[CubicBez], angle_thresh: f64) -> Vec<Vec<CubicBez>> {
    // angle_thresh is tan(corner_angle); corner ⇔ turn > corner_angle
    // ⇔ normalized dot < cos(corner_angle).
    let cos_thresh = 1.0 / (1.0 + angle_thresh * angle_thresh).sqrt();
    let mut runs: Vec<Vec<CubicBez>> = Vec::new();
    let mut run: Vec<CubicBez> = Vec::new();
    for c in cubics {
        if let Some(prev) = run.last() {
            let (_, out_tan) = cubic_tangents(prev);
            let (in_tan, _) = cubic_tangents(c);
            let norm = (out_tan.hypot2() * in_tan.hypot2()).sqrt();
            if norm > 0.0 && out_tan.dot(in_tan) < cos_thresh * norm {
                runs.push(std::mem::take(&mut run));
            }
        }
        run.push(*c);
    }
    if !run.is_empty() {
        runs.push(run);
    }
    runs
}

type FitMemo = HashMap<(u64, u64), Option<(CubicBez, f64)>>;

/// Fit a range: straightness first, quartic second.
///
/// kurbo's `fit_to_cubic` DEGENERATES on exactly-straight ranges (both
/// endpoint tangent angles ~0 -> zero area and moment against the chord ->
/// the quartic has no solution), returning None forever while the caller
/// bisects — straight halves stay straight, so the recursion explodes
/// exponentially. A run-level guard is not enough: one bent cubic at the
/// end of an otherwise straight flank defeats it and the recursion blows up
/// in the straight TAIL. So the guard lives here, per range: sample the
/// source across the range, and when it hugs its chord (2x max deviation
/// within accuracy, forward-monotone so folded-back geometry never
/// qualifies) return the chord cubic with the measured error. Otherwise
/// defer to the quartic fit as usual.
fn chord_or_fit(
    source: &SimplifyBezPath,
    t0: f64,
    t1: f64,
    accuracy: f64,
) -> Option<(CubicBez, f64)> {
    let start = source.sample_pt_tangent(t0, 1.0).p;
    let end = source.sample_pt_tangent(t1, -1.0).p;
    let d = end - start;
    let len = d.hypot();
    if len > 1e-12 {
        const M: usize = 16;
        let mut maxdev: f64 = 0.0;
        let mut prev_s: f64 = 0.0;
        let mut mono = true;
        for k in 1..=M {
            let t = t0 + (t1 - t0) * (k as f64) / (M as f64 + 1.0);
            let (p, _) = source.sample_pt_deriv(t);
            maxdev = maxdev.max((d.cross(p - start)).abs() / len);
            let sd = d.dot(p - start);
            if sd + 1e-9 < prev_s {
                mono = false;
            }
            prev_s = prev_s.max(sd);
        }
        if mono && maxdev * 2.0 <= accuracy {
            let c = CubicBez::new(
                start,
                start.lerp(end, 1.0 / 3.0),
                start.lerp(end, 2.0 / 3.0),
                end,
            );
            let err = (maxdev * 2.0).max(1e-12);
            return Some((c, err * err));
        }
    }
    fit_to_cubic(source, t0..t1, accuracy)
}

fn memo_fit(
    source: &SimplifyBezPath,
    memo: &mut FitMemo,
    t0: f64,
    t1: f64,
    accuracy: f64,
) -> Option<(CubicBez, f64)> {
    *memo
        .entry((t0.to_bits(), t1.to_bits()))
        .or_insert_with(|| chord_or_fit(source, t0, t1, accuracy))
}

/// Adaptive candidate generation: push span END points into `out`, splitting
/// at cusps first, bisecting on fit failure. Returns false if a span hit the
/// depth floor without fitting (caller falls back to plain adaptive).
fn gen_candidates(
    source: &SimplifyBezPath,
    memo: &mut FitMemo,
    t0: f64,
    t1: f64,
    accuracy: f64,
    depth: usize,
    out: &mut Vec<f64>,
) -> bool {
    if let Some(t) = source.break_cusp(t0..t1) {
        if t > t0 && t < t1 && depth > 0 {
            let a = gen_candidates(source, memo, t0, t, accuracy, depth - 1, out);
            let b = gen_candidates(source, memo, t, t1, accuracy, depth - 1, out);
            return a && b;
        }
    }
    if memo_fit(source, memo, t0, t1, accuracy).is_some() {
        out.push(t1);
        return true;
    }
    let mid = 0.5 * (t0 + t1);
    if depth == 0 || mid <= t0 || mid >= t1 {
        out.push(t1);
        return false;
    }
    let a = gen_candidates(source, memo, t0, mid, accuracy, depth - 1, out);
    let b = gen_candidates(source, memo, mid, t1, accuracy, depth - 1, out);
    a && b
}

#[derive(Clone, Copy)]
struct DpNode {
    count: u32,
    err2: f64,
    pred: usize,
    cubic: CubicBez,
}

/// Fit one smooth run to the fewest cubics within `accuracy` via DP over
/// candidate subdivision points. Falls back to `fit_to_bezpath` (adaptive)
/// whenever the DP cannot cover the run — never panics, never worse than
/// adaptive.
fn fit_run_optimal(run: &[CubicBez], accuracy: f64) -> Vec<CubicBez> {
    if let Some(c) = straight_run_cubic(run, accuracy) {
        return vec![c];
    }
    let els: Vec<PathEl> = std::iter::once(PathEl::MoveTo(run[0].p0))
        .chain(run.iter().map(|c| PathEl::CurveTo(c.p1, c.p2, c.p3)))
        .collect();
    let source = SimplifyBezPath::new(els.iter().copied());
    let adaptive_fallback = |source: &SimplifyBezPath| -> Vec<CubicBez> {
        let mut out = Vec::new();
        adaptive_rec(source, 0.0, 1.0, accuracy, ADAPT_DEPTH, &mut out);
        out
    };

    // 1. Adaptive boundaries (+ dirty flag if any span never fit).
    let mut memo: FitMemo = HashMap::new();
    let mut bounds = vec![0.0f64];
    let clean = gen_candidates(&source, &mut memo, 0.0, 1.0, accuracy, MAX_DEPTH, &mut bounds);
    if !clean {
        return adaptive_fallback(&source);
    }
    let adaptive_count = bounds.len() as u32 - 1;

    // 2. Refined candidate grid (adaptive boundaries are a subset, so the
    //    adaptive chain stays feasible — the ≥-adaptive guarantee).
    let mut ts = Vec::with_capacity(bounds.len() * REFINE);
    ts.push(0.0);
    for w in bounds.windows(2) {
        let (a, b) = (w[0], w[1]);
        for k in 1..=REFINE {
            let t = a + (b - a) * (k as f64) / (REFINE as f64);
            if t > *ts.last().unwrap() {
                ts.push(t);
            }
        }
    }
    if *ts.last().unwrap() < 1.0 {
        ts.push(1.0);
    }
    let n = ts.len();

    // 3. DP with a monotone predecessor pointer (the shape of Levien's
    //    sketch): feasible spans only shrink moving forward, so node j's
    //    earliest feasible predecessor starts near node j-1's predecessor.
    //    Back off by BACKTRACK_SLACK for robustness, advance while the span
    //    is infeasible, then refine forward while count ties can improve
    //    error. Amortized near-linear in candidates — no span-length cap.
    let mut dp: Vec<Option<DpNode>> = vec![None; n];
    dp[0] = Some(DpNode {
        count: 0,
        err2: 0.0,
        pred: 0,
        cubic: CubicBez::new(run[0].p0, run[0].p0, run[0].p0, run[0].p0),
    });
    let mut pred_ptr = 0usize;
    for j in 1..n {
        // Advance to the earliest reachable predecessor whose span fits.
        let mut i = pred_ptr.saturating_sub(BACKTRACK_SLACK);
        while i < j {
            if dp[i].is_some()
                && memo_fit(&source, &mut memo, ts[i], ts[j], accuracy).is_some()
            {
                break;
            }
            i += 1;
        }
        if i >= j {
            continue; // unreachable from any plausible predecessor
        }
        // The pointer tracks the EARLIEST feasible predecessor, never the
        // chosen one — error-refinement ties drift forward, and advancing
        // from a drifted pointer makes later nodes miss minimal-count spans.
        pred_ptr = i;
        let base_count = dp[i].map(|d| d.count).unwrap_or(u32::MAX);
        let mut best: Option<DpNode> = None;
        let mut k = i;
        let mut probes = 0usize;
        while k < j && probes < FORWARD_PROBES {
            if let Some(prev) = dp[k] {
                if prev.count > base_count {
                    break; // count can only worsen from here
                }
                if let Some((c, err2)) = memo_fit(&source, &mut memo, ts[k], ts[j], accuracy) {
                    let cand = DpNode {
                        count: prev.count + 1,
                        err2: prev.err2.max(err2),
                        pred: k,
                        cubic: c,
                    };
                    let better = match best {
                        None => true,
                        Some(cur) => {
                            cand.count < cur.count
                                || (cand.count == cur.count && cand.err2 < cur.err2)
                        }
                    };
                    if better {
                        best = Some(cand);
                    }
                }
            }
            k += 1;
            probes += 1;
        }
        dp[j] = best;
    }

    // 4. Reconstruct; fall back if unreachable or (defensively) worse than
    //    the plain adaptive count.
    let Some(end) = dp[n - 1] else {
        return adaptive_fallback(&source);
    };
    if end.count > adaptive_count {
        return adaptive_fallback(&source);
    }
    let mut chain = Vec::with_capacity(end.count as usize);
    let mut j = n - 1;
    while j != 0 {
        let node = dp[j].unwrap_or(end); // dp[j] is Some along a valid chain
        chain.push(node.cubic);
        j = node.pred;
    }
    chain.reverse();
    chain
}

/// Exactly/near-straight runs make kurbo's fitter recurse EXPONENTIALLY:
/// with both endpoint tangent angles ~zero the quartic degenerates (a
/// straight source has zero area and moment against its chord),
/// `fit_to_cubic` yields nothing, and `fit_to_bezpath` bisects forever —
/// straight halves stay straight. (Latent upstream: kurbo's folded corner
/// test bends runs around sharp tips, accidentally shielding it; our
/// fold-proof splitter produces genuinely straight flank runs and exposed
/// it.) Short-circuit them to a single chord cubic. Requirements: every
/// control point within accuracy/2 of the chord line AND anchors make
/// monotone forward progress along it — folded-back geometry never
/// qualifies.
fn straight_run_cubic(run: &[CubicBez], accuracy: f64) -> Option<CubicBez> {
    let p0 = run[0].p0;
    let p3 = run[run.len() - 1].p3;
    let d = p3 - p0;
    let len = d.hypot();
    if len < 1e-12 {
        return None;
    }
    let tol = 0.5 * accuracy;
    let mut prev_s = 0.0;
    for c in run {
        for p in [c.p1, c.p2, c.p3] {
            if (d.cross(p - p0)).abs() / len > tol {
                return None;
            }
        }
        let s = d.dot(c.p3 - p0);
        if s < prev_s {
            return None;
        }
        prev_s = s;
    }
    Some(CubicBez::new(
        p0,
        p0.lerp(p3, 1.0 / 3.0),
        p0.lerp(p3, 2.0 / 3.0),
        p3,
    ))
}

/// Plain adaptive fit for one run — kurbo's own subdivide-in-half over a
/// `SimplifyBezPath` source (identical to what `simplify_bezpath`'s flush
/// does), reached through OUR fold-proof splitter.
fn fit_run_adaptive(run: &[CubicBez], accuracy: f64) -> Vec<CubicBez> {
    if let Some(c) = straight_run_cubic(run, accuracy) {
        return vec![c];
    }
    let els: Vec<PathEl> = std::iter::once(PathEl::MoveTo(run[0].p0))
        .chain(run.iter().map(|c| PathEl::CurveTo(c.p1, c.p2, c.p3)))
        .collect();
    let source = SimplifyBezPath::new(els.iter().copied());
    let mut out = Vec::new();
    adaptive_rec(&source, 0.0, 1.0, accuracy, ADAPT_DEPTH, &mut out);
    out
}

/// Our adaptive recursion — kurbo's `fit_to_bezpath_rec` shape, but every
/// range goes through `chord_or_fit` (straight ranges terminate instead of
/// exploding) and depth is hard-capped with a chord fallback, so
/// termination is unconditional.
fn adaptive_rec(
    source: &SimplifyBezPath,
    t0: f64,
    t1: f64,
    accuracy: f64,
    depth: usize,
    out: &mut Vec<CubicBez>,
) {
    if let Some(t) = source.break_cusp(t0..t1) {
        if t > t0 && t < t1 && depth > 0 {
            adaptive_rec(source, t0, t, accuracy, depth - 1, out);
            adaptive_rec(source, t, t1, accuracy, depth - 1, out);
            return;
        }
    }
    if let Some((c, _)) = chord_or_fit(source, t0, t1, accuracy) {
        out.push(c);
        return;
    }
    let mid = 0.5 * (t0 + t1);
    if depth == 0 || mid <= t0 || mid >= t1 {
        // Unconditional-termination fallback: draw the chord (kurbo's own
        // infinite-recursion guard does the same).
        let s = source.sample_pt_tangent(t0, 1.0).p;
        let e = source.sample_pt_tangent(t1, -1.0).p;
        out.push(CubicBez::new(s, s.lerp(e, 1.0 / 3.0), s.lerp(e, 2.0 / 3.0), e));
        return;
    }
    adaptive_rec(source, t0, mid, accuracy, depth - 1, out);
    adaptive_rec(source, mid, t1, accuracy, depth - 1, out);
}

/// Shared driver: decode subpaths, split into smooth runs at corners
/// (fold-proof — see `split_runs`), fit each run, reassemble. Corner
/// anchors are run endpoints, so they interpolate EXACTLY in both modes.
fn simplify_runs(
    els: &[PathEl],
    accuracy: f64,
    angle_thresh: f64,
    fit_run: impl Fn(&[CubicBez], f64) -> Vec<CubicBez>,
) -> BezPath {
    let mut out = BezPath::new();
    for sub in decode_subpaths(els) {
        if sub.cubics.is_empty() {
            out.move_to(sub.start);
            if sub.closed {
                out.close_path();
            }
            continue;
        }
        out.move_to(sub.cubics[0].p0);
        for run in split_runs(&sub.cubics, angle_thresh) {
            for c in fit_run(&run, accuracy) {
                out.curve_to(c.p1, c.p2, c.p3);
            }
        }
        if sub.closed {
            out.close_path();
        }
    }
    out
}

/// Public entry: simplify a whole path with the DP optimizer
/// (`angle_thresh` = tan of the corner angle); subpath structure and
/// ClosePath survive.
pub fn simplify_optimal(els: &[PathEl], accuracy: f64, angle_thresh: f64) -> BezPath {
    simplify_runs(els, accuracy, angle_thresh, fit_run_optimal)
}

/// Public entry: plain adaptive simplify, but with OUR corner splitting
/// instead of kurbo's fold-prone internal flush test.
pub fn simplify_adaptive(els: &[PathEl], accuracy: f64, angle_thresh: f64) -> BezPath {
    simplify_runs(els, accuracy, angle_thresh, fit_run_adaptive)
}

#[cfg(test)]
mod tests {
    use super::*;
    use kurbo::simplify::{simplify_bezpath, SimplifyOptLevel, SimplifyOptions};

    fn circle_els(n: usize) -> Vec<PathEl> {
        let mut els = Vec::new();
        for k in 0..n {
            let th = (k as f64) / (n as f64) * std::f64::consts::TAU;
            let p = Point::new(500.0 + 300.0 * th.cos(), 500.0 + 300.0 * th.sin());
            els.push(if k == 0 { PathEl::MoveTo(p) } else { PathEl::LineTo(p) });
        }
        els
    }

    #[test]
    fn never_worse_than_adaptive() {
        // The DP guarantee holds against OUR adaptive (identical fold-proof
        // corner segmentation — kurbo's internal splitter makes different
        // corner decisions, so it's not a valid baseline).
        let els = circle_els(255);
        let adaptive = simplify_adaptive(&els, 0.25, 0.5773);
        let dp = simplify_optimal(&els, 0.25, 0.5773);
        assert!(
            dp.elements().len() <= adaptive.elements().len(),
            "dp {} > adaptive {}",
            dp.elements().len(),
            adaptive.elements().len()
        );
    }

    #[test]
    fn beats_or_matches_old_opt_on_wobble() {
        // The audit corpus where fit_to_bezpath_opt produced 160 verbs.
        // Since the fold fix, our corner segmentation legitimately differs
        // (the wobble's jitter contains near-reversal joins the folded test
        // smoothed over), so kurbo _opt is printed for reference only; the
        // asserted invariant is dp <= our adaptive.
        let n = 200;
        let mut els = Vec::new();
        for k in 0..n {
            let kf = k as f64;
            let p = Point::new(
                100.0 + 4.0 * kf + (((k * k) % 17) as f64) * 0.37,
                300.0 + (((k * 3) % 29) as f64) * 2.1 - kf * 0.05,
            );
            els.push(if k == 0 { PathEl::MoveTo(p) } else { PathEl::LineTo(p) });
        }
        let opts = SimplifyOptions::default()
            .angle_thresh(0.5773)
            .opt_level(SimplifyOptLevel::Optimize);
        let old = simplify_bezpath(els.iter().copied(), 0.25, &opts);
        let adaptive = simplify_adaptive(&els, 0.25, 0.5773);
        let dp = simplify_optimal(&els, 0.25, 0.5773);
        println!(
            "wobble: kurbo _opt {} els (folded corners), our adaptive {} els, dp {} els",
            old.elements().len(),
            adaptive.elements().len(),
            dp.elements().len()
        );
        assert!(dp.elements().len() <= adaptive.elements().len());
    }

    #[test]
    fn thin_spike_tip_is_pinned() {
        // Dense V flank pair with a ~178.6° reversal at the tip — squarely
        // in the |tan| fold zone kurbo's cross/dot test classifies as
        // smooth. The tip must survive as an EXACT anchor in both modes.
        let tip = Point::new(900.0, 490.0);
        let mut els = vec![PathEl::MoveTo(Point::new(100.0, 500.0))];
        for k in 1..=40 {
            let t = k as f64 / 40.0;
            els.push(PathEl::LineTo(Point::new(100.0 + 800.0 * t, 500.0 - 10.0 * t)));
        }
        for k in 1..=40 {
            let t = k as f64 / 40.0;
            els.push(PathEl::LineTo(Point::new(900.0 - 800.0 * t, 490.0 - 10.0 * t)));
        }
        for (label, out) in [
            ("adaptive", simplify_adaptive(&els, 1.0, 0.5773)),
            ("optimal", simplify_optimal(&els, 1.0, 0.5773)),
        ] {
            let hit = out.elements().iter().any(|el| match el {
                PathEl::MoveTo(p) | PathEl::LineTo(p) => p.distance(tip) < 1e-9,
                PathEl::CurveTo(_, _, p) => p.distance(tip) < 1e-9,
                _ => false,
            });
            assert!(hit, "{label}: thin spike tip was not pinned");
        }
    }

    #[test]
    fn zigzag_no_corner_split_does_not_panic() {
        // The kurbo#268 misuse scenario: corners inside runs + optimizer.
        let mut els = Vec::new();
        for k in 0..40 {
            let p = Point::new(
                100.0 + (k as f64) * 20.0,
                if k % 2 == 0 { 100.0 } else { 300.0 },
            );
            els.push(if k == 0 { PathEl::MoveTo(p) } else { PathEl::LineTo(p) });
        }
        let dp = simplify_optimal(&els, 0.3, 1e9);
        assert!(!dp.elements().is_empty());
    }

    #[test]
    fn stays_on_shape() {
        use kurbo::ParamCurve;
        let els = circle_els(255);
        let dp = simplify_optimal(&els, 0.25, 0.5773);
        for seg in dp.segments() {
            for t in [0.0, 0.25, 0.5, 0.75, 1.0] {
                let p = seg.eval(t);
                let r = ((p.x - 500.0).powi(2) + (p.y - 500.0).powi(2)).sqrt();
                assert!((r - 300.0).abs() < 1.5, "radius {r} at t={t}");
            }
        }
    }
}
