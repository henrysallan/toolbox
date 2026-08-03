//! Kernel operations over the wire format. Plain Rust, String errors —
//! natively testable; lib.rs wraps these in #[wasm_bindgen] shims.

use crate::wire;
use kurbo::{BezPath, Shape};

pub fn simplify_op(
    verbs: &[u8],
    coords: &[f64],
    accuracy: f64,
    optimize: bool,
    angle_thresh: f64,
) -> Result<(Vec<u8>, Vec<f64>), String> {
    if !accuracy.is_finite() || accuracy <= 0.0 {
        return Err("accuracy must be finite and > 0".into());
    }
    if !angle_thresh.is_finite() || angle_thresh < 0.0 {
        return Err("angle_thresh must be finite and >= 0".into());
    }
    let els = wire::decode(verbs, coords)?;
    // Both modes route through opt.rs's fold-proof corner splitting (thin
    // spike tips pin exactly — see split_runs). optimize=true adds the
    // shortest-path/DP optimizer: never worse than adaptive, and it retires
    // the fit_to_bezpath_opt unwrap trap (kurbo#268).
    let out = if optimize {
        crate::opt::simplify_optimal(&els, accuracy, angle_thresh)
    } else {
        crate::opt::simplify_adaptive(&els, accuracy, angle_thresh)
    };
    Ok(wire::encode(&out))
}

pub fn bbox_op(verbs: &[u8], coords: &[f64]) -> Result<[f64; 4], String> {
    let els = wire::decode(verbs, coords)?;
    let r = BezPath::from_vec(els).bounding_box();
    Ok([r.x0, r.y0, r.x1, r.y1])
}

pub fn area_op(verbs: &[u8], coords: &[f64]) -> Result<f64, String> {
    let els = wire::decode(verbs, coords)?;
    Ok(BezPath::from_vec(els).area())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::wire;

    fn circle_polyline(n: usize) -> (Vec<u8>, Vec<f64>) {
        let mut verbs = vec![wire::MOVE_TO];
        let mut coords = Vec::new();
        for k in 0..n {
            let th = (k as f64) / (n as f64) * std::f64::consts::TAU;
            if k > 0 {
                verbs.push(wire::LINE_TO);
            }
            coords.push(500.0 + 300.0 * th.cos());
            coords.push(500.0 + 300.0 * th.sin());
        }
        verbs.push(wire::CLOSE_PATH);
        (verbs, coords)
    }

    #[test]
    fn circle_segment_counts() {
        let (verbs, coords) = circle_polyline(256);
        for (label, optimize, acc) in [
            ("subdivide/0.25", false, 0.25),
            ("subdivide/1.0", false, 1.0),
            ("optimize/0.25", true, 0.25),
            ("optimize/1.0", true, 1.0),
        ] {
            let (v, _) = simplify_op(&verbs, &coords, acc, optimize, 0.5773).unwrap();
            println!("{label}: {} verbs", v.len());
        }
    }

    #[test]
    fn simplifies_dense_circle() {
        let (verbs, coords) = circle_polyline(256);
        let (ov, oc) = simplify_op(&verbs, &coords, 0.25, false, 0.5773).unwrap();
        assert!(ov.len() < 40, "still {} verbs", ov.len());
        let els = wire::decode(&ov, &oc).unwrap();
        let bp = BezPath::from_vec(els);
        for seg in bp.segments() {
            for t in [0.0, 0.25, 0.5, 0.75, 1.0] {
                let p = kurbo::ParamCurve::eval(&seg, t);
                let r = ((p.x - 500.0).powi(2) + (p.y - 500.0).powi(2)).sqrt();
                assert!((r - 300.0).abs() < 1.5, "radius {r} at t={t}");
            }
        }
    }

    #[test]
    fn preserves_rectangle_corners() {
        let verbs = vec![
            wire::MOVE_TO,
            wire::LINE_TO,
            wire::LINE_TO,
            wire::LINE_TO,
            wire::CLOSE_PATH,
        ];
        let coords = vec![0.0, 0.0, 100.0, 0.0, 100.0, 50.0, 0.0, 50.0];
        let (ov, oc) = simplify_op(&verbs, &coords, 0.25, false, 0.5773).unwrap();
        let els = wire::decode(&ov, &oc).unwrap();
        let bp = BezPath::from_vec(els);
        assert!((bp.area().abs() - 5000.0).abs() < 1.0);
        assert!(ov.len() <= 6);
    }

    #[test]
    fn rejects_garbage() {
        assert!(simplify_op(&[wire::MOVE_TO], &[f64::NAN, 0.0], 0.25, false, 0.5).is_err());
        assert!(simplify_op(&[wire::MOVE_TO], &[0.0, 0.0], 0.0, false, 0.5).is_err());
        assert!(simplify_op(&[wire::MOVE_TO], &[0.0, 0.0], f64::INFINITY, false, 0.5).is_err());
        assert!(simplify_op(&[], &[], 0.25, false, 0.5).is_err());
    }
}

#[cfg(test)]
mod bench {
    use super::*;
    use crate::wire;
    use std::time::Instant;

    #[test]
    fn timing() {
        // noisy blob: 2048 samples of a wobbly closed curve
        let n = 2048;
        let mut verbs = vec![wire::MOVE_TO];
        let mut coords = Vec::new();
        for k in 0..n {
            let th = (k as f64) / (n as f64) * std::f64::consts::TAU;
            let r = 300.0 + 40.0 * (th * 5.0).sin() + 1.5 * (th * 97.0).sin();
            if k > 0 { verbs.push(wire::LINE_TO); }
            coords.push(500.0 + r * th.cos());
            coords.push(500.0 + r * th.sin());
        }
        verbs.push(wire::CLOSE_PATH);
        for (label, optimize) in [("subdivide", false), ("optimize", true)] {
            let t0 = Instant::now();
            let mut out_len = 0;
            for _ in 0..10 {
                let (v, _) = simplify_op(&verbs, &coords, 2.0, optimize, 0.5773).unwrap();
                out_len = v.len();
            }
            println!("{label}: {:?}/iter, {} out verbs (2048 in)", t0.elapsed() / 10, out_len);
        }
    }
}
