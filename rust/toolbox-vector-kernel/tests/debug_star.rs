//! Ad-hoc repro harness: feeds adapter-encoded arcs (dumped by the TS
//! scratch script to /private/tmp/claude-501/-Users-henryallan-Documents-toolbox/44bf2ecf-c9a9-49d4-82c1-a31c613d5304/scratchpad/star-arcs.txt) through the kernel natively.
//! Skips silently when the dump file is absent (CI).
use std::time::Instant;

#[test]
fn debug_star_arcs() {
    let Ok(txt) = std::fs::read_to_string("/private/tmp/claude-501/-Users-henryallan-Documents-toolbox/44bf2ecf-c9a9-49d4-82c1-a31c613d5304/scratchpad/star-arcs.txt") else {
        eprintln!("no dump file, skipping");
        return;
    };
    let mut lines = txt.lines();
    let mut arc = 0;
    while let (Some(vl), Some(cl)) = (lines.next(), lines.next()) {
        let verbs: Vec<u8> = vl.split_whitespace().map(|s| s.parse().unwrap()).collect();
        let coords: Vec<f64> = cl.split_whitespace().map(|s| s.parse().unwrap()).collect();
        for (label, optimize) in [("adaptive", false), ("optimal", true)] {
            let t0 = Instant::now();
            let out = toolbox_vector_kernel::simplify(&verbs, &coords, 1.0, optimize, 0.5773502691896257)
                .unwrap();
            eprintln!(
                "arc {arc} {label}: {} -> {} verbs in {:?}",
                verbs.len(),
                out.verbs.len(),
                t0.elapsed()
            );
        }
        arc += 1;
    }
}
