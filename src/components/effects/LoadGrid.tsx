"use client";

import { useEffect, useState } from "react";
import { listProjects, type ProjectRow } from "@/lib/supabase/projects";

interface Props {
  onLoad: (id: string) => void;
  signedIn: boolean;
  // Bumped by the parent after save/delete so the grid refetches without
  // needing its own subscription to change events.
  refreshKey?: number;
}

export default function LoadGrid({ onLoad, signedIn, refreshKey }: Props) {
  const [rows, setRows] = useState<ProjectRow[] | null>(null);

  useEffect(() => {
    if (!signedIn) {
      setRows(null);
      return;
    }
    let cancelled = false;
    setRows(null);
    listProjects().then((list) => {
      if (!cancelled) setRows(list);
    });
    return () => {
      cancelled = true;
    };
  }, [signedIn, refreshKey]);

  if (!signedIn) {
    return (
      <div style={{ color: "#52525b" }}>Sign in to load saved projects.</div>
    );
  }
  if (rows === null) {
    return <div style={{ color: "#52525b" }}>Loading…</div>;
  }
  if (rows.length === 0) {
    return (
      <div style={{ color: "#52525b" }}>
        No saved projects yet — use File → Save.
      </div>
    );
  }

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fill, minmax(120px, 1fr))",
        gap: 8,
      }}
    >
      {rows.map((r) => (
        <button
          key={r.id}
          onClick={() => onLoad(r.id)}
          title={`${r.name} · ${new Date(r.updated_at).toLocaleString()}`}
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "stretch",
            padding: 0,
            background: "#111113",
            border: "1px solid #27272a",
            borderRadius: 4,
            overflow: "hidden",
            color: "#e5e7eb",
            cursor: "pointer",
            fontFamily: "inherit",
          }}
        >
          <div
            style={{
              aspectRatio: "1 / 1",
              background:
                "repeating-conic-gradient(#1a1a1a 0% 25%, #0f0f0f 0% 50%) 0 0 / 12px 12px",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              overflow: "hidden",
            }}
          >
            {r.thumbnail ? (
              // Avatars / thumbnails are small inline data URLs — <img> keeps
              // the code dependency-free without Next image-optimizer config.
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={r.thumbnail}
                alt=""
                style={{
                  width: "100%",
                  height: "100%",
                  objectFit: "cover",
                  display: "block",
                }}
              />
            ) : (
              <span style={{ color: "#52525b", fontSize: 10 }}>no thumb</span>
            )}
          </div>
          <div
            style={{
              padding: "4px 6px",
              fontSize: 10,
              textAlign: "left",
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {r.name}
          </div>
        </button>
      ))}
    </div>
  );
}
