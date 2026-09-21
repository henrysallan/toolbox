// Export log — one structured record per export run.
//
// Every exporter (video fast / high / max, PNG sequence, GIF) opens one of
// these at the top, feeds it the settings it resolved, the tier decisions it
// took, per-frame timings + capture checksums, and the encoder's own output,
// then closes it with a status and a summary. Levels:
//
//   info / warn / error → mirrored to the browser console with an
//                          `[export:<kind>]` prefix, and to the file sink.
//   debug               → file sink (and the in-memory ring) only: per-frame
//                          lines and ffmpeg's stderr are far too chatty for
//                          the console, but they are exactly what a failed
//                          export needs after the fact.
//
// The sink is the platform's: the desktop shell writes a file per export
// under app.getPath("logs")/exports (macOS: ~/Library/Logs/Toolbox/exports),
// with the native ffmpeg process appending its own stderr to the SAME file
// via the log id; the web build has no sink, so the ring is dumped to the
// console on failure (`tail()`). Callers show `path` in the failure toast.
//
// Why this exists: the 2026-09-20 export freeze shipped silently — the
// desktop encoder reported "Exported 240 frames" for a file that held one
// picture for 230 of them, and neither tier surfaced ffmpeg's messages or
// even its exit code. The identical-frame run in `summary()` would have
// named the problem on the first run.

import { FrameRunTracker } from "./export-capture";
import type { ExportLogSink } from "./platform/types";

export type ExportLogLevel = "debug" | "info" | "warn" | "error";
export type ExportStatus = "ok" | "failed" | "cancelled";

export interface FrameTimings {
  /** Graph evaluation + blit (renderSettledFrameAt), ms. */
  render: number;
  /** GPU readback (+ PNG encode where the tier needs one), ms. */
  capture: number;
  /** Hand-off to the encoder — IPC + pipe drain, or the wasm FS write, ms. */
  write: number;
}

const RING = 600;
// Per-frame debug lines: the first few frames, then every 30th, then the last.
const FRAME_LOG_EVERY = 30;
// The first identical run of this length is called out once at WARN.
const RUN_WARN_AT = 10;

export class ExportLog {
  readonly kind: string;
  readonly lines: string[] = [];
  readonly runs = new FrameRunTracker();
  private readonly t0 = performance.now();
  private readonly sink: ExportLogSink | null;
  private closed = false;
  private warnedRun = false;
  private bytesOut = 0;
  private readonly stats = {
    count: 0,
    render: 0,
    capture: 0,
    write: 0,
    maxRender: 0,
    maxCapture: 0,
    maxWrite: 0,
  };

  constructor(kind: string, sink: ExportLogSink | null = null) {
    this.kind = kind;
    this.sink = sink;
  }

  /** Path of the file sink (desktop), or null. */
  get path(): string | null {
    return this.sink?.path ?? null;
  }

  /** Sink id the native encoder appends ffmpeg's stderr under, or null. */
  get sinkId(): string | null {
    return this.sink?.id ?? null;
  }

  debug(msg: string, data?: Record<string, unknown>): void {
    this.write("debug", msg, data);
  }
  info(msg: string, data?: Record<string, unknown>): void {
    this.write("info", msg, data);
  }
  warn(msg: string, data?: Record<string, unknown>): void {
    this.write("warn", msg, data);
  }
  error(msg: string, data?: Record<string, unknown>): void {
    this.write("error", msg, data);
  }

  /**
   * One captured frame. `checksum` feeds the identical-run tracker (omit it
   * for tiers that never see pixels, like WebCodecs' CanvasSource); `bytes`
   * is what went to the encoder.
   */
  frame(
    index: number,
    total: number,
    timings: FrameTimings,
    checksum?: number,
    bytes?: number
  ): void {
    if (checksum != null) this.runs.push(checksum);
    const s = this.stats;
    s.count++;
    s.render += timings.render;
    s.capture += timings.capture;
    s.write += timings.write;
    if (timings.render > s.maxRender) s.maxRender = timings.render;
    if (timings.capture > s.maxCapture) s.maxCapture = timings.capture;
    if (timings.write > s.maxWrite) s.maxWrite = timings.write;
    if (bytes) this.bytesOut += bytes;

    const cadence =
      index < 3 || (index + 1) % FRAME_LOG_EVERY === 0 || index === total - 1;
    if (cadence) {
      this.debug(
        `frame ${index + 1}/${total} render ${ms(timings.render)} capture ${ms(
          timings.capture
        )} write ${ms(timings.write)}` +
          (checksum != null
            ? ` checksum ${hex(checksum)} run ${this.runs.currentRun}`
            : "") +
          (bytes ? ` bytes ${bytes}` : "")
      );
    }
    if (
      checksum != null &&
      !this.warnedRun &&
      this.runs.currentRun === RUN_WARN_AT
    ) {
      this.warnedRun = true;
      this.warn(
        `captured frames unchanged for ${RUN_WARN_AT} frames from frame ${
          this.runs.currentRunStart + 1
        } — expected for a still graph, a capture stall otherwise`
      );
    }
  }

  summary(): Record<string, unknown> {
    const s = this.stats;
    const n = Math.max(1, s.count);
    return {
      ...this.runs.summary(),
      capturedFrames: s.count,
      avgMs: {
        render: s.render / n,
        capture: s.capture / n,
        write: s.write / n,
      },
      maxMs: { render: s.maxRender, capture: s.maxCapture, write: s.maxWrite },
      bytesToEncoder: this.bytesOut,
      elapsedSec: (performance.now() - this.t0) / 1000,
    };
  }

  /** Last `n` lines — for a console dump when there is no file. */
  tail(n = 40): string {
    return this.lines.slice(-n).join("\n");
  }

  /** Close the run: one summary line at the status' level, then the sink. */
  async finish(
    status: ExportStatus,
    extra?: Record<string, unknown>
  ): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const data = { ...this.summary(), ...(extra ?? {}) };
    if (status === "ok") this.info(`${this.kind} export ok`, data);
    else if (status === "cancelled") this.warn(`${this.kind} export cancelled`, data);
    else this.error(`${this.kind} export failed`, data);
    try {
      await this.sink?.close();
    } catch {
      // the log is best-effort; never let it fail the export
    }
  }

  private write(
    level: ExportLogLevel,
    msg: string,
    data?: Record<string, unknown>
  ): void {
    const t = ((performance.now() - this.t0) / 1000).toFixed(3).padStart(8);
    const suffix = data ? ` ${safeJson(data)}` : "";
    const line = `[${t}s] ${level.toUpperCase().padEnd(5)} ${msg}${suffix}`;
    this.lines.push(line);
    if (this.lines.length > RING) {
      this.lines.splice(0, this.lines.length - RING);
    }
    if (level === "error") console.error(`[export:${this.kind}] ${msg}${suffix}`);
    else if (level === "warn") console.warn(`[export:${this.kind}] ${msg}${suffix}`);
    else if (level === "info") console.info(`[export:${this.kind}] ${msg}${suffix}`);
    if (!this.closed || level !== "debug") {
      try {
        this.sink?.append(line);
      } catch {
        // best-effort
      }
    }
  }
}

/**
 * Open a log for one export run. Uses the platform's file sink when the
 * shell offers one (desktop), otherwise memory + console only. Never throws:
 * a broken log must not stop an export.
 */
export async function openExportLog(
  kind: string,
  header: Record<string, unknown>
): Promise<ExportLog> {
  let sink: ExportLogSink | null = null;
  try {
    // Lazy so the pure half (this file's formatting + the run tracker) can
    // be imported by the offline check without pulling the platform seam.
    const { platform } = await import("./platform");
    sink = platform.openExportLog ? await platform.openExportLog(kind) : null;
  } catch (e) {
    console.warn("[export] log file unavailable, logging to console only:", e);
  }
  const log = new ExportLog(kind, sink);
  log.info(`${kind} export start`, header);
  if (sink?.path) log.info(`log file: ${sink.path}`);
  return log;
}

function ms(v: number): string {
  return `${v.toFixed(1)}ms`;
}

function hex(v: number): string {
  return (v >>> 0).toString(16).padStart(8, "0");
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v, (_k, x) =>
      typeof x === "number" && !Number.isInteger(x) ? Number(x.toFixed(3)) : x
    );
  } catch {
    return String(v);
  }
}
