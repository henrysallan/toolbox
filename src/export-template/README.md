# Export App template

Standalone Vite + React + TypeScript runtime that the editor's packager
combines with a per-export `graph.json` and `manifest.json` to produce a
runnable end-user app. Imports the engine and node defs directly from
the editor codebase via Vite path aliases — no engine fork lives here.

See `specdocs/exportappspec.md` for the design.
