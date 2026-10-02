Figma plugin exports ("Copy to toolbox" → Download JSON). `check-figma-import`
converts every `*.json` here and validates the resulting graph, so each file
is a regression test. Keep them small — untick "Include Figma's render" unless
the file is meant for a pixel comparison, and prefer frames with few images.

Everything here except this README is gitignored: exports are real design
files, so they stay on the machine that made them. Exact-placement assertions
on a particular export go in `real-exports.mts` (also local), which the check
runs when it exists.
