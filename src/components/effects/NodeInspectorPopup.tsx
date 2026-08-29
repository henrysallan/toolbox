"use client";

import { useState } from "react";
import { useStore, type Node } from "@xyflow/react";
import type { NodeDataPayload } from "@/state/graph";
import { getNodeDef } from "@/engine/registry";
import { listItemType } from "@/engine/list-value";
import type {
  ImageGroupValue,
  ImageValue,
  ListValue,
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
  // What the node *is*, above what's currently flowing through it. Comes
  // from the registry def (a handful of defs have none) — never from
  // node.data, so a renamed node still explains itself.
  const description = getNodeDef(node.data.defType)?.description;

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
        background: "var(--tb-n-0)",
        border: "1px solid var(--tb-n-9)",
        borderRadius: 4,
        boxShadow: "0 8px 24px rgba(0,0,0,0.6)",
        color: "var(--tb-n-16)",
        fontFamily: "var(--code-font)",
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
        <span style={{ color: "var(--tb-n-13)", letterSpacing: 0.3 }}>inspect</span>
        <CloseButton nodeId={node.id} />
      </div>
      {description && (
        <div
          style={{
            color: "var(--tb-n-13)",
            lineHeight: 1.45,
            marginBottom: 6,
            paddingBottom: 6,
            borderBottom: "1px solid var(--tb-n-7)",
          }}
        >
          {description}
        </div>
      )}
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

function CloseButton({ nodeId }: { nodeId: string }) {
  const [hover, setHover] = useState(false);
  return (
    <button
      onClick={() =>
        window.dispatchEvent(
          new CustomEvent("effect-node-toggle", {
            detail: { id: nodeId, kind: "toggleInspect" },
          })
        )
      }
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      title="Close inspector"
      style={{
        background: "transparent",
        border: "none",
        color: hover ? "var(--tb-n-16)" : "var(--tb-n-11)",
        cursor: "pointer",
        fontFamily: "inherit",
        fontSize: 11,
        padding: 0,
        transition: "color 100ms ease",
      }}
    >
      ✕
    </button>
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
          color: "var(--tb-n-10)",
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
  return <div style={{ color: "var(--tb-n-10)" }}>{children}</div>;
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
      <span style={{ color: "var(--tb-n-13)", minWidth: 56 }}>{label}</span>
      <ValueSummary value={value} />
    </div>
  );
}

// One-line textual summary of a socket value. Shared with the
// socket-peek popover (SocketPeekPopover.tsx), which adds visual
// previews on top of the same summary line.
export function ValueSummary({ value }: { value: SocketValue | undefined }) {
  if (!value) {
    return <span style={{ color: "var(--tb-n-10)" }}>—</span>;
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
    case "instances": {
      const src = value.source.geometry.getAttribute("position");
      return (
        <span>
          instances · {value.count} × {src ? src.count : 0} verts
          {value.colors ? ", colored" : ""}
        </span>
      );
    }
    case "geometry": {
      // Raw mesh data in the 3D modeling chain — vertex/triangle counts
      // read straight off the retained BufferGeometry.
      const pos = value.geometry.getAttribute("position");
      const verts = pos ? pos.count : 0;
      const idx = value.geometry.getIndex();
      const tris = Math.floor((idx ? idx.count : verts) / 3);
      return (
        <span>
          geometry · {verts} vert{verts === 1 ? "" : "s"}, {tris} tri
          {tris === 1 ? "" : "s"}
          {value.materials[0] ? ", material" : ""}
        </span>
      );
    }
    case "list":
      return <ListSummary value={value} />;
    case "string":
      return (
        <span>
          string · &quot;
          {value.value.length > 40
            ? value.value.slice(0, 40) + "…"
            : value.value}
          &quot;
        </span>
      );
    case "transform": {
      const n = value.ops.length;
      return (
        <span>
          transform · {n === 0 ? "identity" : `${n} op${n === 1 ? "" : "s"}`}
        </span>
      );
    }
    default:
      // Runtime-only kinds (sdf, element, particles, …) — name the kind
      // rather than rendering an opaque "?".
      return (
        <span style={{ color: "var(--tb-n-13)" }}>
          {(value as { kind?: string }).kind ?? "?"}
        </span>
      );
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
  // A z array marks a world-space 3D value (rides `points3d` sockets) —
  // say so, since the count line is otherwise identical to 2D points.
  const is3d = value.z !== undefined;
  const nAttrs = value.attributes ? Object.keys(value.attributes).length : 0;
  return (
    <span>
      {is3d ? "points3d" : "points"} · {value.count} point
      {value.count === 1 ? "" : "s"}
      {is3d && value.normals ? ", normals" : ""}
      {nAttrs > 0 ? `, ${nAttrs} attr${nAttrs === 1 ? "" : "s"}` : ""}
    </span>
  );
}

function ListSummary({ value }: { value: ListValue }) {
  // Lists carry no declared item type — name the shared one, or "mixed".
  const n = value.items.length;
  const type = listItemType(value);
  return (
    <span>
      list · {n} item{n === 1 ? "" : "s"}
      {n > 0 && ` × ${type ?? "mixed"}`}
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
