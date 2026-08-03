//! PathData wire format: verbs (u8) + packed x,y coords (f64).
//! Mirrors src/engine/vector-kernel.ts — keep the two in sync.
//! Verbs: 0 MoveTo, 1 LineTo, 2 QuadTo, 3 CurveTo, 4 ClosePath.
//!
//! Validation lives here and must be total: panic = "abort" means any panic
//! permanently poisons the WASM instance, so every malformed input has to be
//! rejected with an Err before it reaches kurbo.

use kurbo::{BezPath, PathEl, Point};

pub const MOVE_TO: u8 = 0;
pub const LINE_TO: u8 = 1;
pub const QUAD_TO: u8 = 2;
pub const CURVE_TO: u8 = 3;
pub const CLOSE_PATH: u8 = 4;

fn coords_for_verb(verb: u8) -> Option<usize> {
    match verb {
        MOVE_TO | LINE_TO => Some(2),
        QUAD_TO => Some(4),
        CURVE_TO => Some(6),
        CLOSE_PATH => Some(0),
        _ => None,
    }
}

pub fn decode(verbs: &[u8], coords: &[f64]) -> Result<Vec<PathEl>, String> {
    if verbs.is_empty() {
        return Err("empty path (no verbs)".into());
    }
    if verbs[0] != MOVE_TO {
        return Err("path must start with MoveTo".into());
    }
    let mut els = Vec::with_capacity(verbs.len());
    let mut i = 0usize;
    for (vi, &verb) in verbs.iter().enumerate() {
        let n = coords_for_verb(verb)
            .ok_or_else(|| format!("invalid verb byte {verb} at index {vi}"))?;
        if i + n > coords.len() {
            return Err(format!(
                "coords array too short: verb at index {vi} needs {n} more values"
            ));
        }
        let c = &coords[i..i + n];
        if c.iter().any(|v| !v.is_finite()) {
            return Err(format!("non-finite coordinate at verb index {vi}"));
        }
        els.push(match verb {
            MOVE_TO => PathEl::MoveTo(Point::new(c[0], c[1])),
            LINE_TO => PathEl::LineTo(Point::new(c[0], c[1])),
            QUAD_TO => PathEl::QuadTo(Point::new(c[0], c[1]), Point::new(c[2], c[3])),
            CURVE_TO => PathEl::CurveTo(
                Point::new(c[0], c[1]),
                Point::new(c[2], c[3]),
                Point::new(c[4], c[5]),
            ),
            _ => PathEl::ClosePath,
        });
        i += n;
    }
    if i != coords.len() {
        return Err(format!(
            "coords length {} does not match verbs (expected {i})",
            coords.len()
        ));
    }
    Ok(els)
}

pub fn encode(path: &BezPath) -> (Vec<u8>, Vec<f64>) {
    let els = path.elements();
    let mut verbs = Vec::with_capacity(els.len());
    let mut coords = Vec::with_capacity(els.len() * 6);
    for el in els {
        match el {
            PathEl::MoveTo(p) => {
                verbs.push(MOVE_TO);
                coords.extend_from_slice(&[p.x, p.y]);
            }
            PathEl::LineTo(p) => {
                verbs.push(LINE_TO);
                coords.extend_from_slice(&[p.x, p.y]);
            }
            PathEl::QuadTo(p1, p2) => {
                verbs.push(QUAD_TO);
                coords.extend_from_slice(&[p1.x, p1.y, p2.x, p2.y]);
            }
            PathEl::CurveTo(p1, p2, p3) => {
                verbs.push(CURVE_TO);
                coords.extend_from_slice(&[p1.x, p1.y, p2.x, p2.y, p3.x, p3.y]);
            }
            PathEl::ClosePath => verbs.push(CLOSE_PATH),
        }
    }
    (verbs, coords)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip() {
        let verbs = vec![MOVE_TO, CURVE_TO, LINE_TO, CLOSE_PATH];
        let coords = vec![0.0, 0.0, 1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0];
        let els = decode(&verbs, &coords).unwrap();
        let (v2, c2) = encode(&BezPath::from_vec(els));
        assert_eq!(verbs, v2);
        assert_eq!(coords, c2);
    }

    #[test]
    fn rejects_bad_input() {
        assert!(decode(&[], &[]).is_err());
        assert!(decode(&[LINE_TO], &[0.0, 0.0]).is_err()); // must start MoveTo
        assert!(decode(&[MOVE_TO], &[0.0]).is_err()); // short coords
        assert!(decode(&[MOVE_TO], &[0.0, 0.0, 1.0]).is_err()); // long coords
        assert!(decode(&[MOVE_TO], &[f64::NAN, 0.0]).is_err());
        assert!(decode(&[MOVE_TO, 9], &[0.0, 0.0]).is_err()); // bad verb byte
    }
}
