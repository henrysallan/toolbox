// GPU timing via EXT_disjoint_timer_query_webgl2 — spec
// specdocs/080726_perf-profiler.md (M5, pulled forward into M3).
//
// WHY THIS EXISTS: the evaluator measures CPU dispatch. `def.compute` queues
// draw calls and returns; the GPU may still be working long after. On a 4K
// canvas that gap is the whole story — a Merge chain costs ~0.02 ms of CPU
// and can cost tens of ms of fill. Without this, a perf panel confidently
// reports a 3 ms frame while the user watches 30fps.
//
// THREE CONSTRAINTS THIS MODULE EXISTS TO HANDLE:
//
//  1. Only ONE TIME_ELAPSED query may be active at a time in WebGL2. So
//     queries cannot nest — this serializes them, one per node, which works
//     because the evaluator runs nodes sequentially. Nested (Iterate) passes
//     must NOT open their own; their GPU time bills to the enclosing shell,
//     matching how the node table treats depth-0 samples.
//  2. Results are ASYNCHRONOUS — typically ready one to three frames later.
//     Polling for them synchronously would stall the pipeline and destroy the
//     thing being measured. So results resolve backwards into an already
//     committed frame (see profiler.resolveNodeGpu).
//  3. The GPU can declare a DISJOINT event (clock change, context loss,
//     preemption) which invalidates every in-flight timing. When that flag
//     trips, everything outstanding is discarded rather than reported —
//     wrong numbers are worse than missing ones in a diagnostic.

/**
 * Where a pending result should be written. The timer holds this BY
 * REFERENCE and reads it at poll time, which is what lets a caller open a
 * query before it knows the sample's index and fill `idx` in afterwards.
 * `idx < 0` at poll time means "never addressed" and the result is dropped.
 */
export interface GpuTimerSlot {
  seq: number;
  idx: number;
}

export interface GpuTimer {
  /** False when the extension is unavailable; all other calls become no-ops. */
  readonly available: boolean;
  /** Open a query for one node. Returns false if it couldn't start. */
  begin(slot: GpuTimerSlot): boolean;
  /** Close the currently open query. Safe to call with none open. */
  end(): void;
  /** Resolve whatever finished, then release those query objects. */
  poll(sink: (seq: number, idx: number, ms: number) => void): void;
  /** Drop everything in flight (e.g. capture disarmed). */
  reset(): void;
  dispose(): void;
}

// Bound on outstanding queries. Each is a few bytes of driver state; the cap
// exists so a stalled or lost context can't grow this without limit. When it
// is hit, timing is skipped for that node rather than queued — a gap in the
// data, which the summary reports as unmeasured coverage.
const MAX_IN_FLIGHT = 256;

interface InFlight {
  query: WebGLQuery;
  slot: GpuTimerSlot;
}

const NOOP: GpuTimer = {
  available: false,
  begin: () => false,
  end: () => {},
  poll: () => {},
  reset: () => {},
  dispose: () => {},
};

// One timer per GL context. The engine recreates its backend (and context) on
// resolution changes, so keying by context avoids handing back query objects
// that belong to a dead context.
const byContext = new WeakMap<WebGL2RenderingContext, GpuTimer>();

export function getGpuTimer(gl: WebGL2RenderingContext): GpuTimer {
  const hit = byContext.get(gl);
  if (hit) return hit;
  const made = create(gl);
  byContext.set(gl, made);
  return made;
}

function create(gl: WebGL2RenderingContext): GpuTimer {
  const ext = gl.getExtension("EXT_disjoint_timer_query_webgl2") as {
    TIME_ELAPSED_EXT: number;
    GPU_DISJOINT_EXT: number;
  } | null;
  if (!ext) return NOOP;

  const inFlight: InFlight[] = [];
  const free: WebGLQuery[] = [];
  let open: InFlight | null = null;
  let disposed = false;

  const release = (q: WebGLQuery) => {
    // Cap the free list too — a burst shouldn't permanently retain hundreds
    // of query objects.
    if (free.length < 64) free.push(q);
    else gl.deleteQuery(q);
  };

  return {
    available: true,

    begin(slot) {
      if (disposed || open) return false;
      if (inFlight.length >= MAX_IN_FLIGHT) return false;
      const query = free.pop() ?? gl.createQuery();
      if (!query) return false;
      try {
        gl.beginQuery(ext.TIME_ELAPSED_EXT, query);
      } catch {
        // A context that lost the extension mid-session, or a query left open
        // by a throwing compute. Don't let instrumentation take down a render.
        release(query);
        return false;
      }
      open = { query, slot };
      return true;
    },

    end() {
      if (disposed || !open) return;
      try {
        gl.endQuery(ext.TIME_ELAPSED_EXT);
        inFlight.push(open);
      } catch {
        release(open.query);
      }
      open = null;
    },

    poll(sink) {
      if (disposed || inFlight.length === 0) return;

      // A disjoint event invalidates EVERY outstanding timing, not just the
      // ones spanning it — the spec gives no way to tell which are affected.
      if (gl.getParameter(ext.GPU_DISJOINT_EXT)) {
        for (const f of inFlight) release(f.query);
        inFlight.length = 0;
        return;
      }

      // Queries complete in submission order, so stop at the first pending
      // one rather than scanning the whole list every frame.
      let done = 0;
      for (const f of inFlight) {
        if (!gl.getQueryParameter(f.query, gl.QUERY_RESULT_AVAILABLE)) break;
        const ns = gl.getQueryParameter(f.query, gl.QUERY_RESULT) as number;
        if (f.slot.idx >= 0) sink(f.slot.seq, f.slot.idx, ns / 1e6);
        release(f.query);
        done++;
      }
      if (done > 0) inFlight.splice(0, done);
    },

    reset() {
      if (open) {
        try {
          gl.endQuery(ext.TIME_ELAPSED_EXT);
        } catch {
          /* context already gone */
        }
        release(open.query);
        open = null;
      }
      for (const f of inFlight) release(f.query);
      inFlight.length = 0;
    },

    dispose() {
      this.reset();
      for (const q of free) gl.deleteQuery(q);
      free.length = 0;
      disposed = true;
    },
  };
}
