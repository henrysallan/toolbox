"use client";

import { useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { Edge, Node } from "@xyflow/react";
import { evalNumExpr } from "@/lib/num-expr";
import type { NodeDataPayload } from "@/state/graph";
import {
  addStripFrame,
  beginStripBake,
  commitStripBake,
  freeOutput,
  freeStrip,
  getDatamoshStatus,
  getDatamoshStoreRev,
  getScopedFrame,
  getStripBlob,
  isMoshed,
  isMoshLocked,
  setDatamoshStatusBusy,
  stripCount,
  subscribeDatamoshStore,
} from "@/engine/datamosh-session";

// Custom param panel for the Datamosh node.
//
// Bake each input clip into the node (frame-stepped PNG strips), drag the two
// clips on the mini-timeline so they overlap, tune the flow params, then Mosh
// to bake the moshed output for clean scrubbing/export. All strips are
// session-only — the panel renders whatever the session store reports.

export interface DatamoshPanelProps {
  node: Node<NodeDataPayload>;
  edges: Edge[];
  // Offline frame-stepper from EffectsApp: renders each requested frame
  // deterministically and hands back the named node's pixels as a PNG.
  captureNodeFrames?: (
    sourceNodeId: string,
    frames: number[],
    onFrame: (frame: number, blob: Blob) => Promise<boolean | void>
  ) => Promise<void>;
  sceneFrames?: number;
  onParamChange: (
    nodeId: string,
    paramName: string,
    value: unknown,
    coalesceKey?: string
  ) => void;
}

const num = (v: unknown, d: number) =>
  typeof v === "number" && Number.isFinite(v) ? v : d;

export default function DatamoshPanel({
  node,
  edges,
  captureNodeFrames,
  sceneFrames,
  onParamChange,
}: DatamoshPanelProps) {
  useSyncExternalStore(
    subscribeDatamoshStore,
    getDatamoshStoreRev,
    getDatamoshStoreRev
  );

  const p = node.data.params;
  const engine = (p.engine as string) ?? "flow";
  const estimator = (p.estimator as string) ?? "gradient";
  const flowScale = num(p.flowScale, 0.08);
  const smear = num(p.smear, 8);
  const decay = num(p.decay, 0.85);
  const refresh = num(p.refresh, 0.05);
  const searchRadius = num(p.searchRadius, 4);
  const iframeRemoval = p.iframeRemoval !== false;
  const pframeDup = num(p.pframeDup, 0);

  const aStart = Math.max(0, Math.round(num(p.aStart, 0)));
  const bStart = Math.max(0, Math.round(num(p.bStart, 0)));
  const sourceInA = Math.max(0, Math.round(num(p.sourceInA, 0)));
  const sourceInB = Math.max(0, Math.round(num(p.sourceInB, 0)));

  // Per-clip capture window (which upstream frames the Bake button grabs).
  const sceneEnd = Math.max(1, Math.round(sceneFrames ?? 61)) - 1;
  const bakeInA = Math.max(0, Math.round(num(p.bakeInA, 0)));
  const bakeOutA = Math.max(bakeInA, Math.round(num(p.bakeOutA, sceneEnd)));
  const bakeInB = Math.max(0, Math.round(num(p.bakeInB, 0)));
  const bakeOutB = Math.max(bakeInB, Math.round(num(p.bakeOutB, sceneEnd)));

  const aCount = stripCount(node.id, "A");
  const bCount = stripCount(node.id, "B");
  const aAvail = Math.max(0, aCount - sourceInA);
  const bAvail = Math.max(0, bCount - sourceInB);
  const aLen = Math.max(0, Math.min(aAvail, Math.round(num(p.aLen, aAvail))));
  const bLen = Math.max(0, Math.min(bAvail, Math.round(num(p.bLen, bAvail))));

  const status = getDatamoshStatus(node.id);
  const moshed = isMoshed(node.id);
  const locked = isMoshLocked(node.id);
  const busy =
    status.phase === "baking-a" ||
    status.phase === "baking-b" ||
    status.phase === "moshing";
  const cancelRef = useRef(false);

  const upstream = useMemo(() => {
    let a: string | null = null;
    let b: string | null = null;
    for (const e of edges) {
      if (e.target !== node.id) continue;
      if (e.targetHandle === "in:imageA") a = e.source;
      else if (e.targetHandle === "in:imageB") b = e.source;
    }
    return { a, b };
  }, [edges, node.id]);

  // ── Bake one input clip into a strip ──────────────────────────────────────
  const bakeClip = async (strip: "A" | "B") => {
    const upId = strip === "A" ? upstream.a : upstream.b;
    if (!upId || !captureNodeFrames) return;
    const bakeIn = Math.max(
      0,
      Math.round(num(p[strip === "A" ? "bakeInA" : "bakeInB"], 0))
    );
    const bakeOut = Math.max(
      bakeIn,
      Math.round(
        num(p[strip === "A" ? "bakeOutA" : "bakeOutB"], (sceneFrames ?? 61) - 1)
      )
    );
    const frames: number[] = [];
    for (let f = bakeIn; f <= bakeOut; f++) frames.push(f);
    cancelRef.current = false;
    beginStripBake(node.id, strip, frames.length);
    try {
      const sizes = new Set<number>();
      await captureNodeFrames(upId, frames, async (frame, blob) => {
        if (cancelRef.current) return false;
        sizes.add(blob.size);
        // Input strips are indexed strip-local from zero.
        addStripFrame(node.id, strip, frame - bakeIn, blob);
        return !cancelRef.current;
      });
      if (cancelRef.current) {
        freeStrip(node.id, strip);
        return;
      }
      commitStripBake(
        node.id,
        strip,
        sizes.size === 1 && frames.length > 1
          ? "Every captured frame was identical — is this input animating over the range?"
          : undefined
      );
      // Set this clip's length, and lay the clips out to overlap by default.
      const count = stripCount(node.id, strip);
      if (strip === "A") {
        onParamChange(node.id, "aLen", count);
        onParamChange(node.id, "aStart", 0);
        const other = stripCount(node.id, "B");
        if (other > 0) {
          onParamChange(node.id, "bStart", Math.max(0, count - Math.floor(other / 2)));
        }
      } else {
        onParamChange(node.id, "bLen", count);
        const a = stripCount(node.id, "A");
        const aL = Math.max(0, Math.min(a, Math.round(num(p.aLen, a))));
        onParamChange(node.id, "bStart", Math.max(0, aL - Math.floor(count / 2)));
      }
    } catch (e) {
      freeStrip(node.id, strip, (e as Error)?.message ?? "Bake failed.");
    }
  };

  // ── Mosh: bake the moshed output over the full node-local timeline ─────────
  const viewEnd = Math.max(aStart + aLen, bStart + bLen, 1);
  const overlapStart = Math.max(aStart, bStart);
  const overlapEnd = Math.min(aStart + aLen, bStart + bLen);

  // Flow engine: frame-step the node itself; compute advects live and we read
  // back each rendered frame into the output strip (keyed by the scoped clock).
  const moshFlow = async () => {
    if (!captureNodeFrames) return;
    const frames: number[] = [];
    for (let f = 0; f < viewEnd; f++) frames.push(f);
    cancelRef.current = false;
    beginStripBake(node.id, "out", frames.length);
    let done = 0;
    await captureNodeFrames(node.id, frames, async (frame, blob) => {
      if (cancelRef.current) return false;
      const scoped = getScopedFrame(node.id);
      addStripFrame(node.id, "out", scoped ?? frame, blob);
      done++;
      setDatamoshStatusBusy(node.id, {
        phase: "moshing",
        frameDone: done,
        frameTotal: frames.length,
      });
      return !cancelRef.current;
    });
    if (cancelRef.current) {
      freeOutput(node.id);
      return;
    }
    commitStripBake(node.id, "out");
  };

  // Codec engine: assemble the A→B sequence from the baked strips and run the
  // ffmpeg bitstream surgery, then store the decoded result as the output strip.
  const moshCodec = async () => {
    const aFrame = (f: number) =>
      Math.max(0, Math.min(aCount - 1, f - aStart + sourceInA));
    const bFrame = (f: number) =>
      Math.max(0, Math.min(bCount - 1, f - bStart + sourceInB));
    const blobs: Blob[] = [];
    for (let f = 0; f < viewEnd; f++) {
      const blob =
        f < overlapStart
          ? getStripBlob(node.id, "A", aFrame(f))
          : getStripBlob(node.id, "B", bFrame(f));
      if (blob) blobs.push(blob);
    }
    if (blobs.length < 2) throw new Error("Bake both clips and overlap them first.");
    setDatamoshStatusBusy(node.id, { phase: "moshing", frameDone: 0, frameTotal: blobs.length });
    const { buildCodecMosh } = await import("@/lib/datamosh-codec");
    const out = await buildCodecMosh({
      frames: blobs,
      fps: 30,
      cutIndex: Math.max(1, overlapStart),
      removeIframes: iframeRemoval,
      pframeDup,
      onProgress: (label, frac) =>
        setDatamoshStatusBusy(node.id, {
          phase: "moshing",
          frameDone: Math.round(frac * blobs.length),
          frameTotal: blobs.length,
        }),
    });
    if (cancelRef.current) return;
    beginStripBake(node.id, "out", out.length);
    for (let i = 0; i < out.length; i++) addStripFrame(node.id, "out", i, out[i]);
    commitStripBake(node.id, "out");
  };

  const mosh = async () => {
    if (aCount === 0 || bCount === 0) return;
    cancelRef.current = false;
    try {
      if (engine === "codec") await moshCodec();
      else await moshFlow();
    } catch (e) {
      freeStrip(node.id, "out", (e as Error)?.message ?? "Mosh failed.");
    }
  };

  const statusText = (() => {
    switch (status.phase) {
      case "baking-a":
        return `Baking clip A ${status.frameDone ?? 0}/${status.frameTotal ?? 0}`;
      case "baking-b":
        return `Baking clip B ${status.frameDone ?? 0}/${status.frameTotal ?? 0}`;
      case "moshing":
        return `Moshing ${status.frameDone ?? 0}/${status.frameTotal ?? 0}`;
      case "error":
        return "Error";
      default:
        return moshed
          ? `Moshed · ${stripCount(node.id, "out")}f`
          : aCount && bCount
          ? "Drag to overlap, then Mosh"
          : "Bake both clips";
    }
  })();
  const barProgress =
    busy && status.frameTotal
      ? (status.frameDone ?? 0) / status.frameTotal
      : null;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {/* Header / status */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "4px 8px",
          background: "var(--tb-n-1)",
          border: "1px solid var(--tb-n-7)",
          borderRadius: 4,
        }}
      >
        <div style={{ color: "var(--tb-n-17)", fontSize: 11, fontWeight: 600 }}>
          Datamosh
        </div>
        <div style={{ flex: 1 }} />
        <div
          style={{
            color:
              status.phase === "error"
                ? "var(--tb-a-red-400)"
                : moshed
                ? "var(--tb-a-green-400)"
                : busy
                ? "var(--tb-a-amber-400)"
                : "var(--tb-n-11)",
            fontSize: 10,
            display: "flex",
            alignItems: "center",
            gap: 4,
          }}
        >
          {busy && <InlineSpinner />}
          {statusText}
        </div>
      </div>

      {busy && barProgress != null && (
        <Progress value={barProgress} />
      )}
      {status.phase === "error" && status.error && (
        <Notice tone="error">{status.error}</Notice>
      )}
      {status.warning && status.phase !== "error" && (
        <Notice tone="warn">{status.warning}</Notice>
      )}

      {/* Clip bake rows — set the capture window, then bake each clip in. */}
      <ClipRow
        name="A"
        ready={!!upstream.a && !!captureNodeFrames}
        baked={aCount > 0}
        count={aCount}
        inFrame={bakeInA}
        outFrame={bakeOutA}
        sceneEnd={sceneEnd}
        disabled={busy || locked}
        onRange={(k, v) => onParamChange(node.id, k, v)}
        inKey="bakeInA"
        outKey="bakeOutA"
        onBake={() => void bakeClip("A")}
      />
      <ClipRow
        name="B"
        ready={!!upstream.b && !!captureNodeFrames}
        baked={bCount > 0}
        count={bCount}
        inFrame={bakeInB}
        outFrame={bakeOutB}
        sceneEnd={sceneEnd}
        disabled={busy || locked}
        onRange={(k, v) => onParamChange(node.id, k, v)}
        inKey="bakeInB"
        outKey="bakeOutB"
        onBake={() => void bakeClip("B")}
      />
      {(!upstream.a || !upstream.b) && (
        <div style={{ color: "var(--tb-n-11)", fontSize: 10 }}>
          Wire an image into <b>clip A</b> and <b>clip B</b>, set each
          clip&apos;s frame range, then bake.
        </div>
      )}

      {/* Overlap timeline */}
      {aCount > 0 && bCount > 0 && (
        <ClipTimeline
          aStart={aStart}
          aLen={aLen}
          bStart={bStart}
          bLen={bLen}
          aCount={aCount}
          bCount={bCount}
          sourceInA={sourceInA}
          sourceInB={sourceInB}
          disabled={locked}
          onChange={(k, v) =>
            onParamChange(node.id, k, v, `${node.id}:timeline`)
          }
        />
      )}

      {/* Engine */}
      <Field label="Engine">
        <div style={{ display: "flex", gap: 4 }}>
          {(["flow", "codec"] as const).map((m) => {
            const on = engine === m;
            const disabled = false;
            return (
              <button
                key={m}
                type="button"
                disabled={locked}
                title={
                  m === "codec"
                    ? "Authentic bitstream datamosh (ffmpeg) — bakes the result"
                    : "Real-time optical-flow advection"
                }
                onClick={() => onParamChange(node.id, "engine", m)}
                style={{
                  flex: 1,
                  padding: "4px 8px",
                  background: on ? "var(--tb-a-blue-900)" : "transparent",
                  border: `1px solid ${on ? "var(--tb-a-blue-700)" : "var(--tb-n-9)"}`,
                  color: disabled ? "var(--tb-n-10)" : on ? "var(--tb-a-blue-200)" : "var(--tb-n-13)",
                  fontFamily: "inherit",
                  fontSize: 11,
                  borderRadius: 3,
                  cursor: disabled ? "not-allowed" : "pointer",
                  textTransform: "capitalize",
                  opacity: disabled ? 0.6 : 1,
                }}
              >
                {m}
              </button>
            );
          })}
        </div>
      </Field>

      {/* Flow params */}
      {engine === "flow" && (
        <>
          <Field label="Algorithm">
            <select
              value={estimator}
              onChange={(e) => onParamChange(node.id, "estimator", e.target.value)}
              style={selectStyle}
            >
              <option value="gradient">Gradient (smooth melt)</option>
              <option value="residual">Residual (glitch)</option>
              <option value="block">Block-match (codec-like, slow)</option>
            </select>
          </Field>
          {estimator === "block" && (
            <Field label="Search">
              <Slider value={searchRadius} min={1} max={8} step={1} decimals={0}
                onChange={(v) => onParamChange(node.id, "searchRadius", v)} />
            </Field>
          )}
          <Field label="Flow Scale">
            <Slider value={flowScale} min={0} max={0.3} step={0.001} decimals={3}
              onChange={(v) => onParamChange(node.id, "flowScale", v)} />
          </Field>
          <Field label="Smear">
            <Slider value={smear} min={1} max={24} step={1} decimals={0}
              onChange={(v) => onParamChange(node.id, "smear", v)} />
          </Field>
          <Field label="Decay">
            <Slider value={decay} min={0} max={1} step={0.001} decimals={3}
              onChange={(v) => onParamChange(node.id, "decay", v)} />
          </Field>
          <Field label="Refresh">
            <Slider value={refresh} min={0} max={1} step={0.001} decimals={3}
              onChange={(v) => onParamChange(node.id, "refresh", v)} />
          </Field>
        </>
      )}

      {/* Codec params */}
      {engine === "codec" && (
        <>
          <Field label="Remove I-frames">
            <label style={{ display: "flex", alignItems: "center", gap: 6, color: "var(--tb-n-13)", fontSize: 11, cursor: "pointer" }}>
              <input
                type="checkbox"
                checked={iframeRemoval}
                onChange={(e) => onParamChange(node.id, "iframeRemoval", e.target.checked)}
              />
              Delete the keyframe at the cut (the mosh)
            </label>
          </Field>
          <Field label="P-frame Dup">
            <Slider value={pframeDup} min={0} max={8} step={1} decimals={0}
              onChange={(v) => onParamChange(node.id, "pframeDup", v)} />
          </Field>
          <div style={{ color: "var(--tb-n-10)", fontSize: 10, lineHeight: 1.5 }}>
            Authentic bitstream datamosh via ffmpeg (MPEG-4/AVI). Slower and
            coarser than Flow, but the &ldquo;real&rdquo; glitch. Always bakes.
          </div>
        </>
      )}

      {/* Mosh / Free */}
      <div style={{ display: "flex", gap: 6 }}>
        {moshed ? (
          <ActionButton label="Free Mosh" enabled={!busy} onClick={() => freeOutput(node.id)} />
        ) : busy ? (
          <ActionButton label="Cancel" enabled onClick={() => { cancelRef.current = true; }} />
        ) : (
          <ActionButton
            label={engine === "codec" ? "Mosh (codec)" : "Mosh"}
            enabled={aCount > 0 && bCount > 0 && (engine === "codec" || !!captureNodeFrames)}
            onClick={() => void mosh()}
          />
        )}
      </div>

      <div style={{ color: "var(--tb-n-10)", fontSize: 10, lineHeight: 1.5 }}>
        <i>Bake</i> each clip into the node (frame-stepped — the clip&apos;s
        chain must be renderable). Drag the bars so they overlap; the overlap is
        moshed — clip B&apos;s motion smears a frozen frame of clip A.{" "}
        <i>Preview</i> plays forward live; <i>Mosh</i> bakes the result so
        scrubbing and export are exact. Strips live in memory for this session —
        reopen → re-bake.
      </div>
    </div>
  );
}

// ─── Mini overlap timeline ──────────────────────────────────────────────────

type DragKind =
  | "moveA" | "lenA" | "trimInA"
  | "moveB" | "lenB" | "trimInB";

interface ClipBase {
  start: number;
  len: number;
  sourceIn: number;
}

function ClipTimeline({
  aStart,
  aLen,
  bStart,
  bLen,
  aCount,
  bCount,
  sourceInA,
  sourceInB,
  disabled,
  onChange,
}: {
  aStart: number;
  aLen: number;
  bStart: number;
  bLen: number;
  aCount: number;
  bCount: number;
  sourceInA: number;
  sourceInB: number;
  disabled: boolean;
  onChange: (key: string, value: number) => void;
}) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const [drag, setDrag] = useState<{
    kind: DragKind;
    startX: number;
    base: ClipBase;
  } | null>(null);

  const viewEnd = Math.max(aStart + aLen, bStart + bLen, 1);
  const view = Math.max(viewEnd + 2, 10); // a little headroom
  const pct = (frames: number) => `${(frames / view) * 100}%`;

  const overlapStart = Math.max(aStart, bStart);
  const overlapEnd = Math.min(aStart + aLen, bStart + bLen);
  const hasOverlap = overlapStart < overlapEnd;

  // Param key triples per clip.
  const keys = {
    A: { start: "aStart", len: "aLen", sourceIn: "sourceInA", count: aCount },
    B: { start: "bStart", len: "bLen", sourceIn: "sourceInB", count: bCount },
  };

  const onPointerDown =
    (kind: DragKind, base: ClipBase) => (e: React.PointerEvent) => {
      if (disabled) return;
      e.preventDefault();
      e.stopPropagation();
      // Capture on the TRACK (which owns the move/up handlers) so the drag
      // keeps tracking even when the pointer leaves the small bar/grip.
      trackRef.current?.setPointerCapture?.(e.pointerId);
      setDrag({ kind, startX: e.clientX, base });
    };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag || !trackRef.current) return;
    const rect = trackRef.current.getBoundingClientRect();
    if (rect.width <= 0) return;
    const d = Math.round(((e.clientX - drag.startX) / rect.width) * view);
    const clip = drag.kind.endsWith("A") ? keys.A : keys.B;
    const { start, len, sourceIn } = drag.base;
    if (drag.kind === "moveA" || drag.kind === "moveB") {
      onChange(clip.start, Math.max(0, start + d));
    } else if (drag.kind === "lenA" || drag.kind === "lenB") {
      // Right-edge: change length, capped by frames available after the trim.
      onChange(clip.len, Math.max(1, Math.min(clip.count - sourceIn, len + d)));
    } else {
      // Left-edge in-point trim: move start + in-point together, right edge fixed.
      const dd = Math.max(-sourceIn, Math.min(len - 1, d));
      onChange(clip.start, start + dd);
      onChange(clip.len, len - dd);
      onChange(clip.sourceIn, sourceIn + dd);
    }
  };
  const onPointerUp = (e: React.PointerEvent) => {
    if (drag) trackRef.current?.releasePointerCapture?.(e.pointerId);
    setDrag(null);
  };

  const Bar = ({
    row,
    start,
    len,
    sourceIn,
    color,
    which,
    label,
  }: {
    row: 0 | 1;
    start: number;
    len: number;
    sourceIn: number;
    color: string;
    which: "A" | "B";
    label: string;
  }) => {
    const base: ClipBase = { start, len, sourceIn };
    return (
      <div
        onPointerDown={onPointerDown(which === "A" ? "moveA" : "moveB", base)}
        style={{
          position: "absolute",
          top: row === 0 ? 4 : 30,
          left: pct(start),
          width: pct(Math.max(1, len)),
          height: 22,
          background: color,
          border: "1px solid color-mix(in srgb, var(--tb-lift) 25%, transparent)",
          borderRadius: 3,
          cursor: disabled ? "default" : "grab",
          display: "flex",
          alignItems: "center",
          paddingLeft: 10,
          color: "#fff",
          fontSize: 10,
          fontWeight: 600,
          userSelect: "none",
          overflow: "hidden",
          boxSizing: "border-box",
        }}
      >
        {label}
        {/* left-edge in-point grip */}
        <div
          onPointerDown={onPointerDown(which === "A" ? "trimInA" : "trimInB", base)}
          style={{
            position: "absolute", left: 0, top: 0, width: 7, height: "100%",
            cursor: disabled ? "default" : "ew-resize",
            background: "color-mix(in srgb, var(--tb-lift) 25%, transparent)",
          }}
        />
        {/* right-edge length grip */}
        <div
          onPointerDown={onPointerDown(which === "A" ? "lenA" : "lenB", base)}
          style={{
            position: "absolute", right: 0, top: 0, width: 7, height: "100%",
            cursor: disabled ? "default" : "ew-resize",
            background: "color-mix(in srgb, var(--tb-lift) 25%, transparent)",
          }}
        />
      </div>
    );
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <div style={{ color: "var(--tb-n-13)", fontSize: 10, textTransform: "uppercase", letterSpacing: 0.5 }}>
        Overlap timeline
      </div>
      <div
        ref={trackRef}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        style={{
          position: "relative",
          height: 56,
          background: "var(--tb-n-0)",
          border: "1px solid var(--tb-n-7)",
          borderRadius: 4,
          touchAction: "none",
        }}
      >
        {hasOverlap && (
          <div
            style={{
              position: "absolute",
              top: 0,
              bottom: 0,
              left: pct(overlapStart),
              width: pct(overlapEnd - overlapStart),
              background: "rgba(244, 63, 94, 0.18)",
              borderLeft: "1px dashed rgba(244,63,94,0.6)",
              borderRight: "1px dashed rgba(244,63,94,0.6)",
            }}
          />
        )}
        <Bar row={0} start={aStart} len={aLen} sourceIn={sourceInA} color="#1e3a8acc" which="A" label="A" />
        <Bar row={1} start={bStart} len={bLen} sourceIn={sourceInB} color="#166534cc" which="B" label="B" />
      </div>
      <div style={{ color: "var(--tb-n-10)", fontSize: 10 }}>
        {hasOverlap
          ? `Overlap ${overlapStart}–${overlapEnd} (${overlapEnd - overlapStart}f moshed)`
          : "No overlap — drag the bars together"}
      </div>
    </div>
  );
}

// ─── Small UI helpers (local, matching the Depth panel's style) ─────────────

const selectStyle: React.CSSProperties = {
  width: "100%",
  padding: "3px 6px",
  background: "var(--tb-n-1)",
  border: "1px solid var(--tb-n-7)",
  color: "var(--tb-n-16)",
  fontFamily: "inherit",
  fontSize: 11,
  borderRadius: 3,
};

function ClipRow({
  name,
  ready,
  baked,
  count,
  inFrame,
  outFrame,
  sceneEnd,
  disabled,
  inKey,
  outKey,
  onRange,
  onBake,
}: {
  name: "A" | "B";
  ready: boolean;
  baked: boolean;
  count: number;
  inFrame: number;
  outFrame: number;
  sceneEnd: number;
  disabled: boolean;
  inKey: string;
  outKey: string;
  onRange: (key: string, value: number) => void;
  onBake: () => void;
}) {
  const enabled = ready && !disabled;
  const span = outFrame - inFrame + 1;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
      <div style={{ width: 38, color: "var(--tb-n-13)", fontSize: 10, fontWeight: 600 }}>
        {name}
        {baked ? (
          <span style={{ color: "var(--tb-n-10)", fontWeight: 400 }}> {count}f</span>
        ) : null}
      </div>
      <FrameInput
        value={inFrame}
        disabled={disabled}
        onChange={(v) => onRange(inKey, Math.min(v, outFrame))}
      />
      <span style={{ color: "var(--tb-n-10)", fontSize: 10 }}>–</span>
      <FrameInput
        value={outFrame}
        disabled={disabled}
        onChange={(v) => onRange(outKey, Math.max(v, inFrame))}
      />
      <button
        type="button"
        disabled={disabled}
        title="Set out frame to the end of the scene"
        onClick={() => onRange(outKey, sceneEnd)}
        style={miniBtnStyle(!disabled)}
      >
        End
      </button>
      <button
        type="button"
        disabled={!enabled}
        onClick={onBake}
        title={`Capture ${span} frame${span === 1 ? "" : "s"} of clip ${name}`}
        style={{
          flex: 1,
          padding: "5px 8px",
          background: baked ? "transparent" : enabled ? "var(--tb-a-blue-900)" : "transparent",
          border: `1px solid ${baked ? "var(--tb-n-9)" : enabled ? "var(--tb-a-blue-700)" : "var(--tb-n-9)"}`,
          color: baked ? "var(--tb-n-13)" : enabled ? "var(--tb-a-blue-200)" : "var(--tb-n-10)",
          fontFamily: "inherit",
          fontSize: 11,
          borderRadius: 3,
          cursor: enabled ? "pointer" : "not-allowed",
          opacity: enabled ? 1 : 0.6,
        }}
      >
        {baked ? "Re-bake" : "Bake"}
      </button>
    </div>
  );
}

function miniBtnStyle(enabled: boolean): React.CSSProperties {
  return {
    padding: "4px 6px",
    background: "transparent",
    border: "1px solid var(--tb-n-9)",
    color: enabled ? "var(--tb-n-13)" : "var(--tb-n-10)",
    fontFamily: "inherit",
    fontSize: 10,
    borderRadius: 3,
    cursor: enabled ? "pointer" : "not-allowed",
  };
}

function FrameInput({
  value,
  disabled,
  onChange,
}: {
  value: number;
  disabled: boolean;
  onChange: (v: number) => void;
}) {
  // Draft only exists while focused — idle, the live value shows through,
  // so no draft-sync effect is needed when the value changes externally.
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const commit = () => {
    setEditing(false);
    const p = evalNumExpr(draft); // plain numbers or math: "24*8", "300/2"
    const n = p === null ? NaN : Math.max(0, Math.round(p));
    if (Number.isFinite(n) && n !== value) onChange(n);
  };
  return (
    <input
      type="text"
      inputMode="decimal"
      value={editing ? draft : String(value)}
      disabled={disabled}
      onFocus={() => {
        setDraft(String(value));
        setEditing(true);
      }}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        else if (e.key === "Escape") {
          setEditing(false);
          (e.target as HTMLInputElement).blur();
        }
      }}
      style={{
        width: 42,
        padding: "3px 4px",
        background: "var(--tb-n-1)",
        border: "1px solid var(--tb-n-7)",
        color: disabled ? "var(--tb-n-10)" : "var(--tb-n-16)",
        fontFamily: "inherit",
        fontSize: 11,
        borderRadius: 3,
      }}
    />
  );
}

function Progress({ value }: { value: number }) {
  return (
    <div style={{ background: "var(--tb-n-0)", border: "1px solid var(--tb-n-7)", borderRadius: 3, height: 6, overflow: "hidden" }}>
      <div style={{ background: "var(--tb-a-blue-900)", height: "100%", width: `${value * 100}%`, transition: "width 150ms linear" }} />
    </div>
  );
}

function Notice({ tone, children }: { tone: "error" | "warn"; children: React.ReactNode }) {
  const c =
    tone === "error"
      ? { bg: "color-mix(in srgb, var(--tb-a-red-500) 10%, transparent)", bd: "var(--tb-a-red-700)", fg: "var(--tb-a-red-200)" }
      : { bg: "color-mix(in srgb, var(--tb-a-amber-400) 8%, transparent)", bd: "var(--tb-a-amber-800)", fg: "var(--tb-a-amber-200)" };
  return (
    <div style={{ padding: "6px 10px", background: c.bg, border: `1px solid ${c.bd}`, color: c.fg, borderRadius: 4, fontSize: 11, lineHeight: 1.4 }}>
      {children}
    </div>
  );
}

function InlineSpinner() {
  return (
    <svg className="toolbox-spinner" width="9" height="9" viewBox="0 0 24 24" aria-hidden>
      <circle cx="12" cy="12" r="9" fill="none" stroke="var(--tb-a-amber-400)" strokeWidth="3" strokeLinecap="round" strokeDasharray="40" strokeDashoffset="20" />
    </svg>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <div style={{ width: 90, color: "var(--tb-n-13)", fontSize: 10, textTransform: "uppercase", letterSpacing: 0.5 }}>
        {label}
      </div>
      <div style={{ flex: 1 }}>{children}</div>
    </div>
  );
}

function Slider({
  value, min, max, step, decimals, onChange,
}: {
  value: number; min: number; max: number; step: number; decimals: number; onChange: (v: number) => void;
}) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <input type="range" min={min} max={max} step={step} value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))} style={{ flex: 1 }} />
      <span style={{ color: "var(--tb-n-13)", fontSize: 10, fontVariantNumeric: "tabular-nums", width: 40, textAlign: "right" }}>
        {value.toFixed(decimals)}
      </span>
    </div>
  );
}

function ActionButton({ label, enabled, onClick }: { label: string; enabled: boolean; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} disabled={!enabled}
      style={{
        flex: 1, padding: "6px 10px",
        background: enabled ? "var(--tb-a-blue-900)" : "transparent",
        border: `1px solid ${enabled ? "var(--tb-a-blue-700)" : "var(--tb-n-9)"}`,
        color: enabled ? "var(--tb-a-blue-200)" : "var(--tb-n-10)",
        fontFamily: "inherit", fontSize: 11, borderRadius: 3,
        cursor: enabled ? "pointer" : "not-allowed", opacity: enabled ? 1 : 0.6,
      }}>
      {label}
    </button>
  );
}
