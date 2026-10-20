// Shared harness for the After Effects export gates (scripts/check-ae-export.mts).
//
// Every scripts/ae-export/check-*.mts default-exports an async function that
// returns its failure count. They must NOT call process.exit — the runner
// imports them all into one process and sums the failures. Add a new area by
// adding a file; the runner discovers it, so package.json never changes.

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface Checker {
  check(label: string, ok: boolean, detail?: unknown): void;
  // Numeric compare with an absolute tolerance; prints both values on failure.
  near(label: string, actual: number, expected: number, tol: number): void;
  readonly failures: number;
}

export function makeChecker(area: string): Checker {
  let failures = 0;
  return {
    check(label, ok, detail) {
      if (ok) {
        console.log(`  ok   ${label}`);
        return;
      }
      failures++;
      const extra = detail === undefined ? "" : ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}`;
      console.log(`  FAIL [${area}] ${label}${extra}`);
    },
    near(label, actual, expected, tol) {
      const ok = Number.isFinite(actual) && Math.abs(actual - expected) <= tol;
      this.check(label, ok, ok ? undefined : `got ${actual}, want ${expected} ± ${tol}`);
    },
    get failures() {
      return failures;
    },
  };
}

let registryLoaded = false;

// Stub the DOM/GL globals the node modules touch at import time, then
// register every node — the same preamble as the other registry-backed gates.
export async function loadRegistry(): Promise<void> {
  if (registryLoaded) return;
  const g = globalThis as any;
  const stub = () => ({ getContext: () => null, style: {}, addEventListener() {} });
  g.window ??= g;
  g.self ??= g;
  g.document ??= {
    createElement: stub,
    createElementNS: stub,
    fonts: { add() {}, forEach() {} },
    body: { appendChild() {} },
    addEventListener() {},
  };
  g.navigator ??= { userAgent: "node" };
  g.HTMLCanvasElement ??= class {};
  g.OffscreenCanvas ??= class {
    getContext() {
      return null;
    }
  };
  g.WebGL2RenderingContext ??= class {};
  const { registerAllNodes } = await import("@/nodes/index");
  registerAllNodes();
  registryLoaded = true;
}
