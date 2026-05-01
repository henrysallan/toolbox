"use client";

import { useStore, type Node } from "@xyflow/react";
import type { NodeDataPayload } from "@/state/graph";
import type {
  ImageGroupValue,
  ImageValue,
  MaskValue,
  NodeOutput,
  PointsValue,
  SocketValue,
  SplineValue,
  UvValue,
} from "@/engine/types";

// Floating data-inspector popup anchored above a node in the editor.
// Rendered inside <ViewportPortal>, so the popup's coordinate space is
// React Flow's flow-coords — pan/zoom is applied by the portal's parent
// transform. Reads live snapshots from EffectsApp's ref and re-renders
// when the parent bumps inspectTick. Closes via the same
// `effect-node-toggle` event that opened it.

interface Snapshot {
  inputs: Record<string, SocketValue | undefined>;
  output: NodeOutput | undefined;
}

interface Props {
  node: Node<NodeDataPayload>;
  snapshot: Snapshot | undefined;
}

export default function NodeInspectorPopup({ node, snapshot }: Props) {
  // The portal applies the viewport transform for us; we just need the
  // node's stored flow-coord position and its current rendered width to
  // size the panel.
  const measured = useStore((s) => {
    const internal = s.nodeLookup.get(node.id);
    return internal?.measured;
  });
  const x = node.position.x;
  const y = node.position.y;
  const nodeW = measured?.width ?? 200;

  return (
    <div
      data-node-inspector="1"
      style={{
        position: "absolute",
        left: x,
        top: y,
        width: nodeW,
        // Pop the panel above the node. translateY(-100% - gap) lifts
        // it by its own height; transform-origin top-left so the
        // measurement is straightforward.
        transform: "translateY(calc(-100% - 8px))",
        pointerEvents: "auto",
        background: "#0a0a0a",
        border: "1px solid #3f3f46",
        borderRadius: 4,
        boxShadow: "0 8px 24px rgba(0,0,0,0.6)",
        color: "#e5e7eb",
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
        fontSize: 10,
        padding: 8,
        minWidth: 200,
        maxWidth: 320,
        zIndex: 50,
      }}
      onMouseDown={(e) => e.stopPropagation()}
      onWheel={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.stopPropagation()}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 6,
        }}
      >
        <span style={{ color: "#a1a1aa", letterSpacing: 0.3 }}>inspect</span>
        <button
          onClick={() =>
            window.dispatchEvent(
              new CustomEvent("effect-node-toggle", {
                detail: { id: node.id, kind: "toggleInspect" },
              })
            )
          }
          title="Close inspector"
          style={{
            background: "transparent",
            border: "none",
            color: "#71717a",
            cursor: "pointer",
            fontFamily: "inherit",
            fontSize: 11,
            padding: 0,
          }}
        >
          ✕
        </button>
      </div>
      <Section label="inputs">
        {(() => {
          const entries = Object.entries(snapshot?.inputs ?? {});
          if (entries.length === 0) {
            return <Empty>(no inputs)</Empty>;
          }
          return entries.map(([name, val]) => (
            <SocketRow key={`in-${name}`} label={name} value={val} />
          ));
        })()}
      </Section>
      <Section label="outputs">
        {(() => {
          const out = snapshot?.output;
          const rows: React.ReactNode[] = [];
          if (out?.primary) {
            rows.push(
              <SocketRow key="out-primary" label="primary" value={out.primary} />
            );
          }
          for (const [name, val] of Object.entries(out?.aux ?? {})) {
            rows.push(
              <SocketRow key={`out-aux-${name}`} label={name} value={val} />
            );
          }
          if (rows.length === 0) {
            return <Empty>(no outputs)</Empty>;
          }
          return rows;
        })()}
      </Section>
    </div>
  );
}

function Section({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div style={{ marginBottom: 6 }}>
      <div
        style={{
          color: "#52525b",
          textTransform: "uppercase",
          letterSpacing: 0.5,
          fontSize: 9,
          marginBottom: 2,
        }}
      >
        {label}
      </div>
      {children}
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div style={{ color: "#52525b" }}>{children}</div>;
}

function SocketRow({
  label,
  value,
}: {
  label: string;
  value: SocketValue | undefined;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: 6,
        padding: "2px 0",
      }}
    >
      <span style={{ color: "#a1a1aa", minWidth: 56 }}>{label}</span>
      <ValueSummary value={value} />
    </div>
  );
}

function ValueSummary({ value }: { value: SocketValue | undefined }) {
  if (!value) {
    return <span style={{ color: "#52525b" }}>—</span>;
  }
  switch (value.kind) {
    case "scalar":
      return <span>scalar · {formatNumber(value.value)}</span>;
    case "vec2":
    case "vec3":
    case "vec4":
      return (
        <span>
          {value.kind} · [{value.value.map(formatNumber).join(", ")}]
        </span>
      );
    case "image":
    case "mask":
    case "uv":
      return <ImageSummary value={value} />;
    case "spline":
      return <SplineSummary value={value} />;
    case "points":
      return <PointsSummary value={value} />;
    case "audio":
      return <span>audio · {value.source === "mic" ? "mic" : "file"}</span>;
    case "image_group":
      return <ImageGroupSummary value={value} />;
    default:
      return <span style={{ color: "#52525b" }}>?</span>;
  }
}

function ImageSummary({
  value,
}: {
  value: ImageValue | MaskValue | UvValue;
}) {
  return (
    <span>
      {value.kind} · {value.width}×{value.height}
    </span>
  );
}

function SplineSummary({ value }: { value: SplineValue }) {
  let total = 0;
  for (const sp of value.subpaths) total += sp.anchors.length;
  return (
    <span>
      spline · {value.subpaths.length} subpath
      {value.subpaths.length === 1 ? "" : "s"}, {total} anchor
      {total === 1 ? "" : "s"}
    </span>
  );
}

function PointsSummary({ value }: { value: PointsValue }) {
  return (
    <span>
      points · {value.count} point
      {value.count === 1 ? "" : "s"}
    </span>
  );
}

function ImageGroupSummary({ value }: { value: ImageGroupValue }) {
  // Surface the resolution of the first image when the group is
  // homogeneous-sized — common case for downstream pipelines.
  const first = value.items[0];
  const sizeNote = first ? ` · ${first.width}×${first.height}` : "";
  return (
    <span>
      image_group · {value.items.length} image
      {value.items.length === 1 ? "" : "s"}
      {sizeNote}
    </span>
  );
}

function formatNumber(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  if (Math.abs(n) >= 1000 || (Math.abs(n) < 0.01 && n !== 0)) {
    return n.toExponential(2);
  }
  return n.toFixed(4).replace(/\.?0+$/, "") || "0";
}
