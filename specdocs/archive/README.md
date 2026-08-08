# Archived specs

Design docs for features that have **already shipped**. Kept for the reasoning
behind a decision — why a socket type works the way it does, what alternatives
were rejected, which invariant a node was built around. Source comments across
the repo still link here.

**Treat these as historical, not current.** They describe intent at the time of
writing, and the code has moved since. Where they disagree with the code, the
code wins. A number of them link to files that no longer exist.

For current material, see `specdocs/`:

| Doc | What it is |
|---|---|
| `061226_devguide.md` | Architecture guide — start here |
| `072226_architecture-review.md` | Most recent architecture review |
| `080726_perf-profiler.md` | Perf tooling: profiler, GPU timing, bench |
| `devlist.md` / `3Ddevlist.md` | Feature backlogs |
| `essentials.md` | Missing-primitive-node todo list |
| `typed-array-points-refactor.md` | Open migration checklist |

`../sql_archive/` holds the Supabase migrations that have already been applied.

When a doc here becomes relevant again — a feature reopened, a spec revived —
move it back up to `specdocs/` rather than editing it in place, so "what is
current" stays answerable by looking at one directory.
