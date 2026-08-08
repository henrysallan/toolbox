"use client";

import React, { useCallback, useEffect, useState } from "react";
import * as prof from "@/engine/profiler";
import { summarize, type PerfSummary } from "@/lib/perf-console";
import type { FrameSample } from "@/engine/profiler";

// Perf panel — spec specdocs/080726_perf-profiler.md (M3).
//
// Sorted and coloured by GPU time, not CPU, because that is what the traces
// said actually matters: a Merge chain at 4K cost 2.5 ms of GPU against
// 0.02 ms of CPU. A panel ranked by CPU would have pointed at the wrong nodes
// with total confidence.

const LEVELS: { value: 0 | 1 | 2 | 3; label: string; hint: string }[] = [
  { value: 0, label: "Off", hint: "No capture. Costs nothing." },
  { value: 1, label: "1", hint: "Per-node time + why each node recomputed." },
  { value: 2, label: "2", hint: "+ data volume, texture churn, fingerprint size." },
  { value: 3, label: "3", hint: "+ per-node GPU time (resolves 1–3 frames late)." },
];

const fmt = (n: number, d = 2) => n.toFixed(d);

// Cost → colour. One ramp shared by the table rows and the graph heatmap so a
// node reads the same in both places.
export function costColor(share: number): string {
  if (share >= 0.25) return "var(--tb-a-red-400)";
  if (share >= 0.12) return "var(--tb-a-amber-400)";
  if (share >= 0.05) return "var(--tb-a-yellow-400)";
  return "var(--tb-a-blue-400)";
}

const REASON_COLOR: Record<string, string> = {
  hit: "var(--tb-a-green-400)",
  input: "var(--tb-ink-muted)",
  anim: "var(--tb-a-violet-400)",
  unstable: "var(--tb-a-amber-400)",
  extras: "var(--tb-a-amber-400)",
  params: "var(--tb-a-blue-400)",
  cold: "var(--tb-ink-muted)",
  error: "var(--tb-a-red-400)",
};

/** Frame-time sparkline with the budget line drawn across it. */
function Sparkline({
  frames,
  budgetMs,
}: {
  frames: FrameSample[];
  budgetMs: number;
}) {
  const W = 100;
  const H = 34;
  if (frames.length === 0) {
    return (
      <div
        style={{
          height: H,
          display: "grid",
          placeItems: "center",
          fontSize: 10,
          color: "var(--tb-ink-muted)",
          border: "1px solid var(--tb-border)",
          borderRadius: 3,
        }}
      >
        no frames captured
      </div>
    );
  }
  const cpu = frames.map((f) => f.phases.total);
  const gpu = frames.map((f) =>
    f.nodes.reduce((a, n) => a + (n.gpuMs ?? 0), 0)
  );
  // Scale to the data or the budget, whichever is larger, so a healthy trace
  // doesn't look alarming just because it's autoscaled to its own noise.
  const peak = Math.max(budgetMs, ...cpu, ...gpu) * 1.1;
  const path = (vals: number[]) =>
    vals
      .map((v, i) => {
        const x = (i / Math.max(1, vals.length - 1)) * W;
        const y = H - (v / peak) * H;
        return `${i === 0 ? "M" : "L"}${x.toFixed(2)},${y.toFixed(2)}`;
      })
      .join("");
  const budgetY = H - (budgetMs / peak) * H;
  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      style={{
        width: "100%",
        height: H,
        display: "block",
        border: "1px solid var(--tb-border)",
        borderRadius: 3,
        background: "var(--tb-n-1)",
      }}
    >
      <line
        x1={0}
        x2={W}
        y1={budgetY}
        y2={budgetY}
        stroke="var(--tb-a-red-400)"
        strokeWidth={0.5}
        strokeDasharray="2 2"
        vectorEffect="non-scaling-stroke"
      />
      {gpu.some((v) => v > 0) && (
        <path
          d={path(gpu)}
          fill="none"
          stroke="var(--tb-a-amber-400)"
          strokeWidth={1}
          vectorEffect="non-scaling-stroke"
        />
      )}
      <path
        d={path(cpu)}
        fill="none"
        stroke="var(--tb-a-blue-400)"
        strokeWidth={1}
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

/** Stacked bar of where the evaluator's CPU time goes. */
function PhaseBar({ s }: { s: PerfSummary }) {
  const p = s.phaseMsPerFrame;
  const parts = [
    { k: "compute", v: p.compute ?? 0, c: "var(--tb-a-blue-400)" },
    { k: "fingerprint", v: p.fingerprint ?? 0, c: "var(--tb-a-violet-400)" },
    { k: "post", v: p.post ?? 0, c: "var(--tb-a-cyan-400)" },
    { k: "flatten", v: p.flatten ?? 0, c: "var(--tb-a-green-400)" },
    { k: "topo", v: p.topo ?? 0, c: "var(--tb-a-emerald-400)" },
    { k: "other", v: Math.max(0, s.unattributedMsPerFrame), c: "var(--tb-n-7)" },
  ].filter((x) => x.v > 0.001);
  const total = parts.reduce((a, b) => a + b.v, 0) || 1;
  return (
    <div>
      <div style={{ display: "flex", height: 8, borderRadius: 2, overflow: "hidden" }}>
        {parts.map((x) => (
          <div
            key={x.k}
            title={`${x.k} ${fmt(x.v)}ms`}
            style={{ width: `${(x.v / total) * 100}%`, background: x.c }}
          />
        ))}
      </div>
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: 8,
          marginTop: 4,
          fontSize: 9,
          color: "var(--tb-ink-muted)",
        }}
      >
        {parts.map((x) => (
          <span key={x.k} style={{ whiteSpace: "nowrap" }}>
            <span
              style={{
                display: "inline-block",
                width: 6,
                height: 6,
                borderRadius: 1,
                background: x.c,
                marginRight: 3,
              }}
            />
            {x.k} {fmt(x.v)}
          </span>
        ))}
      </div>
    </div>
  );
}

export function PerfPanel({
  kindMenu,
  getEdges,
  fps,
  onSelectNode,
}: {
  kindMenu?: React.ReactNode;
  getEdges: () => readonly { source: string; target: string }[];
  fps: number;
  onSelectNode?: (id: string) => void;
}) {
  const [level, setLevel] = useState<0 | 1 | 2 | 3>(() =>
    prof.getCaptureLevel()
  );
  const [summary, setSummary] = useState<PerfSummary | null>(null);
  const [frames, setFrames] = useState<FrameSample[]>([]);

  // Poll rather than subscribe: GPU timings resolve one to three frames after
  // the frame they belong to, so a push on eval-complete would render numbers
  // that are still arriving. 500ms also keeps the panel from re-rendering at
  // frame rate while profiling — which would itself distort the measurement.
  //
  // `getEdges` must be a STABLE callback from the caller; an inline arrow
  // would re-create this interval on every parent render.
  useEffect(() => {
    // Nothing to clear on the way down: every readout below is already
    // gated on `level > 0`, so stale state is unreachable rather than
    // wrong — and clearing it here would be a setState directly in an
    // effect body, which cascades a render.
    if (level === 0) return;
    const tick = () => {
      setSummary(summarize({ top: 40, edges: getEdges() }));
      setFrames(prof.readTrace({ frames: 180 }).frames);
    };
    // First sample on the next frame rather than synchronously here —
    // setState directly inside an effect body cascades an extra render.
    const first = requestAnimationFrame(tick);
    const id = window.setInterval(tick, 500);
    return () => {
      cancelAnimationFrame(first);
      window.clearInterval(id);
    };
  }, [level, getEdges]);

  const arm = useCallback((next: 0 | 1 | 2 | 3) => {
    prof.setCaptureLevel(next, { frames: 600 });
    setLevel(next);
  }, []);

  const budgetMs = 1000 / Math.max(1, fps);
  const gpuTotal = summary?.gpu?.msPerFrame ?? 0;
  const byGpu = !!summary?.gpu;
  const worstBudget = Math.max(summary?.frameMs.mean ?? 0, gpuTotal);

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        minHeight: 0,
        background: "var(--tb-bg)",
        color: "var(--tb-ink)",
        fontSize: 11,
      }}
    >
      {/* header */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "4px 6px",
          borderBottom: "1px solid var(--tb-border)",
          flex: "0 0 auto",
        }}
      >
        {kindMenu}
        <span style={{ fontSize: 10, color: "var(--tb-ink-muted)" }}>Capture</span>
        <div style={{ display: "flex", gap: 2 }}>
          {LEVELS.map((l) => (
            <button
              key={l.value}
              title={l.hint}
              onClick={() => arm(l.value)}
              style={{
                padding: "1px 7px",
                fontSize: 10,
                borderRadius: 3,
                border: "1px solid var(--tb-border)",
                background:
                  level === l.value ? "var(--tb-a-blue-500)" : "var(--tb-n-2)",
                color: level === l.value ? "var(--tb-n-0)" : "var(--tb-ink)",
                cursor: "pointer",
              }}
            >
              {l.label}
            </button>
          ))}
        </div>
        {level > 0 && (
          <button
            onClick={() => {
              prof.resetTrace();
              setSummary(null);
            }}
            style={{
              padding: "1px 7px",
              fontSize: 10,
              borderRadius: 3,
              border: "1px solid var(--tb-border)",
              background: "var(--tb-n-2)",
              color: "var(--tb-ink)",
              cursor: "pointer",
            }}
          >
            Clear
          </button>
        )}
        <span style={{ marginLeft: "auto", fontSize: 10, color: "var(--tb-ink-muted)" }}>
          {summary ? `${summary.frames} frames` : "idle"}
        </span>
      </div>

      <div style={{ flex: "1 1 auto", minHeight: 0, overflowY: "auto", padding: 6 }}>
        {level === 0 && (
          <div style={{ fontSize: 10, color: "var(--tb-ink-muted)", lineHeight: 1.6 }}>
            Capture is off. Pick a level above, then drive the workload —
            playback, a param edit, or a graph change. An idle editor evaluates
            nothing and records no frames.
            <br />
            <br />
            Level 3 adds per-node GPU time. On a 4K canvas the GPU is usually
            where the frame actually goes, so start there when something feels
            slow.
          </div>
        )}

        {level > 0 && summary && summary.frames === 0 && (
          <div style={{ fontSize: 10, color: "var(--tb-ink-muted)", lineHeight: 1.6 }}>
            Armed, nothing captured yet. Press play or edit a parameter.
            <br />
            <br />
            If the editor window is in the background, requestAnimationFrame is
            suspended and no frames will be recorded at all.
          </div>
        )}

        {level > 0 && summary && summary.frames > 0 && (
          <>
            <Sparkline frames={frames} budgetMs={budgetMs} />
            <div
              style={{
                display: "flex",
                gap: 10,
                margin: "5px 0 8px",
                fontSize: 10,
                flexWrap: "wrap",
              }}
            >
              <Stat
                label="CPU"
                value={`${fmt(summary.frameMs.mean)} ms`}
                sub={`p95 ${fmt(summary.frameMs.p95)}`}
              />
              {summary.gpu && (
                <Stat
                  label="GPU"
                  value={`${fmt(summary.gpu.msPerFrame)} ms`}
                  sub={`${Math.round(summary.gpu.coverage * 100)}% resolved`}
                  danger={summary.gpu.msPerFrame > budgetMs}
                />
              )}
              <Stat
                label="budget"
                value={`${fmt(budgetMs, 1)} ms`}
                sub={`${fps} fps target`}
                danger={worstBudget > budgetMs}
              />
              {summary.fps && (
                <Stat
                  label="actual"
                  value={`${summary.fps.mean} fps`}
                  sub={`p5 ${summary.fps.p5}`}
                  danger={summary.fps.p5 < fps * 0.9}
                />
              )}
              <Stat
                label="cache"
                value={`${Math.round(summary.cache.hitRate * 100)}%`}
                sub={`${summary.cache.alwaysRecomputing}/${summary.cache.totalNodes} always`}
              />
              {summary.poolPerFrame.allocs > 0 && (
                <Stat
                  label="textures"
                  value={`${summary.poolPerFrame.allocs}/f`}
                  sub={`${summary.poolPerFrame.mb} MB`}
                />
              )}
            </div>

            <PhaseBar s={summary} />

            {summary.truncatedFrames > 0 && (
              <div
                style={{
                  marginTop: 6,
                  fontSize: 9,
                  color: "var(--tb-a-amber-400)",
                }}
              >
                {summary.truncatedFrames} frame(s) lost their node samples to
                ring wrap — reduce the ring or shorten the capture.
              </div>
            )}

            {summary.poisonRoots.length > 0 && (
              <div style={{ marginTop: 10 }}>
                <SectionTitle>
                  Recompute roots — uncacheable nodes dragging a chain
                </SectionTitle>
                {summary.poisonRoots.slice(0, 4).map((r) => (
                  <div
                    key={r.id}
                    onClick={() => onSelectNode?.(r.id)}
                    style={{
                      display: "flex",
                      gap: 6,
                      alignItems: "baseline",
                      padding: "2px 0",
                      cursor: onSelectNode ? "pointer" : "default",
                      fontSize: 10,
                    }}
                  >
                    <span style={{ color: REASON_COLOR[r.reason] ?? "var(--tb-ink)" }}>
                      {r.reason}
                    </span>
                    <span style={{ color: "var(--tb-ink-hi)" }}>{r.type}</span>
                    <span style={{ marginLeft: "auto", color: "var(--tb-ink-muted)" }}>
                      +{fmt(r.downstreamMsPerFrame)} ms across {r.downstreamNodes}
                    </span>
                  </div>
                ))}
                <div
                  style={{
                    fontSize: 9,
                    color: "var(--tb-ink-muted)",
                    marginTop: 3,
                    lineHeight: 1.5,
                  }}
                >
                  Animated roots are normal — an animated graph is supposed to
                  recompute. This ranks who owns the cost, not what is broken.
                </div>
              </div>
            )}

            <div style={{ marginTop: 10 }}>
              <SectionTitle>
                Nodes by {byGpu ? "GPU" : "CPU"} time
              </SectionTitle>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 10 }}>
                <thead>
                  <tr style={{ color: "var(--tb-ink-muted)", textAlign: "left" }}>
                    <th style={{ fontWeight: 400, padding: "2px 0" }}>node</th>
                    <th style={{ fontWeight: 400, textAlign: "right" }}>cpu</th>
                    {byGpu && (
                      <th style={{ fontWeight: 400, textAlign: "right" }}>gpu</th>
                    )}
                    <th style={{ fontWeight: 400, textAlign: "right" }}>recomp</th>
                    <th style={{ fontWeight: 400, paddingLeft: 6 }}>why</th>
                  </tr>
                </thead>
                <tbody>
                  {summary.nodes.map((n) => {
                    const cost = byGpu ? (n.gpuMsPerFrame ?? 0) : n.msPerFrame;
                    const share =
                      byGpu && gpuTotal > 0
                        ? cost / gpuTotal
                        : cost / Math.max(0.001, summary.frameMs.mean);
                    return (
                      <tr
                        key={n.id}
                        onClick={() => onSelectNode?.(n.id)}
                        style={{
                          cursor: onSelectNode ? "pointer" : "default",
                          borderTop: "1px solid var(--tb-border)",
                        }}
                      >
                        <td style={{ padding: "2px 0", maxWidth: 0 }}>
                          <div
                            style={{
                              display: "flex",
                              alignItems: "center",
                              gap: 4,
                              overflow: "hidden",
                            }}
                          >
                            <span
                              style={{
                                flex: "0 0 auto",
                                width: 3,
                                height: 10,
                                borderRadius: 1,
                                background: costColor(share),
                              }}
                            />
                            <span
                              style={{
                                color: "var(--tb-ink-hi)",
                                whiteSpace: "nowrap",
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                              }}
                              title={`${n.type} (${n.id})${n.points !== undefined ? ` · ${n.points} pts` : ""}${n.allocs ? ` · ${n.allocs} tex` : ""}`}
                            >
                              {n.type}
                            </span>
                          </div>
                        </td>
                        <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                          {fmt(n.msPerFrame)}
                        </td>
                        {byGpu && (
                          <td
                            style={{
                              textAlign: "right",
                              fontVariantNumeric: "tabular-nums",
                              color:
                                n.gpuMsPerFrame === undefined
                                  ? "var(--tb-ink-disabled)"
                                  : "var(--tb-ink-hi)",
                            }}
                          >
                            {n.gpuMsPerFrame === undefined ? "–" : fmt(n.gpuMsPerFrame)}
                          </td>
                        )}
                        <td
                          style={{
                            textAlign: "right",
                            color: "var(--tb-ink-muted)",
                            fontVariantNumeric: "tabular-nums",
                          }}
                        >
                          {Math.round(n.recomputeRate * 100)}%
                        </td>
                        <td
                          style={{
                            paddingLeft: 6,
                            color: REASON_COLOR[n.dominantReason] ?? "var(--tb-ink)",
                          }}
                        >
                          {n.dominantReason}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {byGpu && summary.gpu && summary.gpu.coverage < 0.5 && (
                <div style={{ fontSize: 9, color: "var(--tb-ink-muted)", marginTop: 4 }}>
                  Only {Math.round(summary.gpu.coverage * 100)}% of samples have a
                  GPU timing yet — a dash means not-yet-resolved, not zero.
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        fontSize: 9,
        textTransform: "uppercase",
        letterSpacing: 0.5,
        color: "var(--tb-ink-muted)",
        marginBottom: 3,
      }}
    >
      {children}
    </div>
  );
}

function Stat({
  label,
  value,
  sub,
  danger,
}: {
  label: string;
  value: string;
  sub?: string;
  danger?: boolean;
}) {
  return (
    <div style={{ lineHeight: 1.25 }}>
      <div style={{ fontSize: 9, color: "var(--tb-ink-muted)" }}>{label}</div>
      <div
        style={{
          fontSize: 12,
          fontVariantNumeric: "tabular-nums",
          color: danger ? "var(--tb-a-red-400)" : "var(--tb-ink-hi)",
        }}
      >
        {value}
      </div>
      {sub && <div style={{ fontSize: 9, color: "var(--tb-ink-muted)" }}>{sub}</div>}
    </div>
  );
}
