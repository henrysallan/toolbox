---
title: Spline Merge → its evaluated path
type: spline-merge
class: vector
---

AE has no merge with toolbox's bridges, so the merged outline exports as a
path.

- **Exact mode** (`flow` off) evaluates on the CPU: static → one path,
  animated → path keys per frame (a constant vertex count, or the segment
  bakes).
- **Flow** runs on the GPU, which the export's own evaluator does not have.
  - On a still input the outline is still: it exports from the editor's own
    evaluation. A seek snaps Flow onto its input's outline; during playback
    it relaxes a little over the first frames.
  - On moving geometry Flow simulates every frame, which the export can't
    replay, so it bakes.
  - Offline exports (no editor) bake it, naming the failed node.
