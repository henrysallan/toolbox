<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Verifying a change

Read [TESTING.md](TESTING.md) before running gates or measuring performance.
It covers which command guards what, and the measurement traps that have
already produced confident wrong conclusions here (a backgrounded window
records zero frames; CPU time is usually not the bottleneck; `n/a` is not 0).
