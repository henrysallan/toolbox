//! toolbox-vector-kernel — kurbo compiled to WASM for Toolbox.
//! Spec: specdocs/attractor-vector-kernel-spec.md.
//!
//! lib.rs contains ONLY #[wasm_bindgen] shims: delegate to ops.rs, convert
//! errors. Logic lives in plain modules so `cargo test` covers it natively.

mod ops;
mod opt;
mod wire;

use wasm_bindgen::prelude::*;

#[wasm_bindgen(getter_with_clone)]
pub struct PathResult {
    pub verbs: Vec<u8>,
    pub coords: Vec<f64>,
}

/// Simplify/refit a path to the fewest cubic segments within `accuracy`
/// (same units as the coordinates — canvas px by our convention).
/// `angle_thresh` is the TANGENT of the join angle above which a join is
/// treated as a hard corner (fitting runs split there); pass tan(corner_angle).
/// `optimize` selects optimal subdivision-point search (~50x slower).
#[wasm_bindgen]
pub fn simplify(
    verbs: &[u8],
    coords: &[f64],
    accuracy: f64,
    optimize: bool,
    angle_thresh: f64,
) -> Result<PathResult, JsError> {
    let (v, c) = ops::simplify_op(verbs, coords, accuracy, optimize, angle_thresh)
        .map_err(|e| JsError::new(&e))?;
    Ok(PathResult { verbs: v, coords: c })
}

/// Axis-aligned bounding box as [x0, y0, x1, y1].
#[wasm_bindgen]
pub fn bbox(verbs: &[u8], coords: &[f64]) -> Result<Vec<f64>, JsError> {
    ops::bbox_op(verbs, coords)
        .map(|r| r.to_vec())
        .map_err(|e| JsError::new(&e))
}

/// Signed area (nonzero winding; open subpaths treated as closed by chord).
#[wasm_bindgen]
pub fn area(verbs: &[u8], coords: &[f64]) -> Result<f64, JsError> {
    ops::area_op(verbs, coords).map_err(|e| JsError::new(&e))
}

#[wasm_bindgen]
pub fn kernel_version() -> String {
    format!(
        "toolbox-vector-kernel {} (kurbo 0.13.1)",
        env!("CARGO_PKG_VERSION")
    )
}
