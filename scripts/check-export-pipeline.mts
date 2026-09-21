// check-export-pipeline: the pure half of the pipelined export frame loop
// (src/lib/export-pipeline.ts) — issue order, hand-off order, one read in
// flight, timings, and the abort paths. The GPU half
// (EngineBackend.readImagePixelsAsync: PBO + fence) is browser-only — verify
// it in the live app per TESTING.md (byte parity against the sync path).
//
//   npx tsx scripts/check-export-pipeline.mts

import { runFramePipeline, type AsyncRead } from "../src/lib/export-pipeline";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    console.log(`PASS  ${name}`);
  } else {
    failures++;
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// A read the test resolves by hand.
class FakeRead implements AsyncRead<string> {
  promise: Promise<string | null>;
  resolve!: (v: string | null) => void;
  cancelled = false;
  constructor(public readonly i: number) {
    this.promise = new Promise((r) => {
      this.resolve = r;
    });
  }
  cancel(): void {
    this.cancelled = true;
    this.resolve(null);
  }
}

// Let queued microtasks + the pipeline's awaits run.
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

// ---- happy path: order, overlap, timings -----------------------------------
{
  const events: string[] = [];
  const reads: FakeRead[] = [];
  const consumed: { i: number; v: string; capture: number; render: number }[] = [];
  let clock = 0;
  const N = 4;

  const done = runFramePipeline<string>({
    frames: N,
    now: () => clock,
    render: async (i) => {
      events.push(`render ${i}`);
      clock += 10; // 10 ms of eval per frame
    },
    read: (i) => {
      events.push(`read ${i}`);
      const r = new FakeRead(i);
      reads.push(r);
      return r;
    },
    consume: async (i, v, t) => {
      events.push(`consume ${i}`);
      clock += 5; // 5 ms of write
      consumed.push({ i, v, ...t });
    },
  });

  await tick();
  check(
    "issue: render 0, read 0, then render 1 + read 1 BEFORE waiting on frame 0",
    events.join(",") === "render 0,read 0,render 1,read 1",
    events.join(",")
  );
  check("in flight: exactly two reads issued while frame 0 is unresolved", reads.length === 2);

  // Frame 0 lands 30 ms later; frame 1 must be waited for next, and frame 2
  // issued only after frame 0 is consumed.
  clock += 30;
  reads[0].resolve("px0");
  await tick();
  check(
    "hand-off: frame 0 consumed, then render 2 + read 2 issued",
    events.slice(4).join(",") === "consume 0,render 2,read 2",
    events.slice(4).join(",")
  );
  check(
    "timings: render = eval span, capture = fence wait (write is the consumer's)",
    consumed[0].render === 10 && consumed[0].capture === 30,
    JSON.stringify(consumed[0])
  );

  // Resolve out of order: frame 2 lands before frame 1. Consumption must
  // still be 1 then 2.
  reads[2].resolve("px2");
  await tick();
  check("order: a later frame landing first is NOT consumed early", consumed.length === 1);
  reads[1].resolve("px1");
  await tick();
  check(
    "order: frames consumed strictly in index order",
    consumed.map((c) => c.i).join(",") === "0,1,2",
    consumed.map((c) => c.i).join(",")
  );
  check("in flight: last frame issued after frame 2 consumed", reads.length === 4);
  reads[3].resolve("px3");
  await done;
  check(
    "complete: every frame consumed with its own bytes",
    consumed.length === N && consumed.every((c) => c.v === `px${c.i}`)
  );
  check("clean: no read cancelled on the happy path", reads.every((r) => !r.cancelled));
}

// ---- degenerate sizes -------------------------------------------------------
{
  let calls = 0;
  await runFramePipeline<string>({
    frames: 0,
    render: () => {
      calls++;
    },
    read: () => {
      calls++;
      return { promise: Promise.resolve("x"), cancel() {} };
    },
    consume: () => {
      calls++;
    },
  });
  check("zero frames: nothing called", calls === 0);

  const seen: number[] = [];
  await runFramePipeline<string>({
    frames: 1,
    render: () => {},
    read: () => ({ promise: Promise.resolve("only"), cancel() {} }),
    consume: (i, v) => {
      seen.push(i);
      check("one frame: bytes delivered", v === "only");
    },
  });
  check("one frame: consumed once", seen.join(",") === "0");
}

// ---- abort: a null read is a hard error naming the frame --------------------
{
  const reads: FakeRead[] = [];
  let err: Error | null = null;
  const p = runFramePipeline<string>({
    frames: 5,
    render: () => {},
    read: (i) => {
      const r = new FakeRead(i);
      reads.push(r);
      return r;
    },
    consume: () => {},
  }).catch((e: Error) => {
    err = e;
  });
  await tick();
  reads[0].resolve(null);
  await p;
  check(
    "null read: rejects with the default message naming the frame",
    err !== null && (err as Error).message === "Frame 1/5: nothing to capture",
    err ? (err as Error).message : "no error"
  );
  check(
    "null read: the read already issued for the next frame is cancelled",
    reads.length === 2 && reads[1].cancelled
  );
}

// ---- abort: consume throws → next read cancelled, error propagates ---------
{
  const reads: FakeRead[] = [];
  const boom = new Error("pipe closed");
  let err: unknown = null;
  const p = runFramePipeline<string>({
    frames: 5,
    render: () => {},
    read: (i) => {
      const r = new FakeRead(i);
      reads.push(r);
      return r;
    },
    consume: async (i) => {
      if (i === 1) throw boom;
    },
    missing: (i) => new Error(`custom ${i}`),
  }).catch((e) => {
    err = e;
  });
  await tick();
  reads[0].resolve("a");
  await tick();
  reads[1].resolve("b");
  await p;
  check("consume throws: the same error propagates", err === boom);
  check(
    "consume throws: frame 2's outstanding read is cancelled, no further frames issued",
    reads.length === 3 && reads[2].cancelled && !reads[0].cancelled && !reads[1].cancelled,
    `${reads.length} reads`
  );
}

// ---- abort: render throws → pending read cancelled -------------------------
{
  const reads: FakeRead[] = [];
  const boom = new Error("context lost");
  let err: unknown = null;
  await runFramePipeline<string>({
    frames: 5,
    render: (i) => {
      if (i === 1) throw boom;
    },
    read: (i) => {
      const r = new FakeRead(i);
      reads.push(r);
      return r;
    },
    consume: () => {},
  }).catch((e) => {
    err = e;
  });
  check("render throws: the same error propagates", err === boom);
  check(
    "render throws: frame 0's pending read is cancelled",
    reads.length === 1 && reads[0].cancelled
  );
}

// ---- custom `missing` ------------------------------------------------------
{
  let err: unknown = null;
  await runFramePipeline<string>({
    frames: 2,
    render: () => {},
    read: () => ({ promise: Promise.resolve(null), cancel() {} }),
    consume: () => {},
    missing: (i) => new Error(`no pixels for ${i}`),
  }).catch((e) => {
    err = e;
  });
  check(
    "missing: custom error factory is used",
    err instanceof Error && err.message === "no pixels for 0"
  );
}

if (failures > 0) {
  console.log(`\ncheck-export-pipeline: ${failures} failure(s)`);
  process.exit(1);
}
console.log("\nall passed");
