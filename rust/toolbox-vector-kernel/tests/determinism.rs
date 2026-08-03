//! Native side of the §10.1 determinism check. Prints a bit-exact hash of
//! simplify output for an arithmetic-only corpus (no transcendentals, so the
//! INPUTS are bit-identical between Rust and JS). Compare against the WASM
//! side (scripts in the repo run the same corpus through the binding).
//! Run: cargo test --release --test determinism -- --nocapture

use toolbox_vector_kernel::simplify;

fn fold(h: u64, bits: u64) -> u64 {
    h.rotate_left(7) ^ bits
}

fn hash_output(verbs: &[u8], coords: &[f64]) -> u64 {
    let mut h = 0u64;
    for &v in verbs {
        h = fold(h, v as u64);
    }
    for &c in coords {
        h = fold(h, c.to_bits());
    }
    h
}

// Corpus A: open wobble polyline, integer-derived coords.
fn wobble() -> (Vec<u8>, Vec<f64>) {
    let n = 200usize;
    let mut verbs = vec![0u8];
    let mut coords = Vec::new();
    for k in 0..n {
        let kf = k as f64;
        if k > 0 {
            verbs.push(1);
        }
        coords.push(100.0 + 4.0 * kf + (((k * k) % 17) as f64) * 0.37);
        coords.push(300.0 + (((k * 3) % 29) as f64) * 2.1 - kf * 0.05);
    }
    (verbs, coords)
}

// Corpus B: two cubics with fixed control points.
fn curves() -> (Vec<u8>, Vec<f64>) {
    (
        vec![0, 3, 3],
        vec![
            100.0, 500.0, 250.0, 100.0, 400.0, 900.0, 500.0, 500.0, 650.0, 100.0,
            800.0, 900.0, 900.0, 500.0,
        ],
    )
}

#[test]
fn print_hashes() {
    for (name, (verbs, coords)) in [("wobble", wobble()), ("curves", curves())] {
        for (mode, optimize) in [("subdivide", false), ("optimize", true)] {
            let out = simplify(&verbs, &coords, 0.25, optimize, 0.5773).unwrap();
            println!(
                "native {name}/{mode}: {:016x} ({} verbs)",
                hash_output(&out.verbs, &out.coords),
                out.verbs.len()
            );
        }
    }
}

#[test]
fn huge_coords_do_not_panic() {
    // ±1e300 is finite so it passes validation; make sure the fit degrades
    // gracefully (Ok or Err) rather than panicking — a panic here would be
    // an instance-poisoning trap under panic="abort" in WASM.
    let verbs = vec![0u8, 1, 1, 1];
    let coords = vec![1e300, 1e300, -1e300, 1e300, -1e300, -1e300, 1e300, -1e300];
    let r = simplify(&verbs, &coords, 0.25, false, 0.5773);
    println!("native huge coords: ok={}", r.is_ok());
    let r2 = simplify(&verbs, &coords, 0.25, true, 0.5773);
    println!("native huge coords optimize: ok={}", r2.is_ok());
}
