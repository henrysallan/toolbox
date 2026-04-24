"use client";

import { useEffect, useRef, useState } from "react";

// Menu-bar pill showing the current project name with a save-state dot.
// Click opens a small dropdown to rename the project and flip its
// visibility. The visibility toggle routes through a confirm modal so
// going public isn't an accidental click.

export type SaveState = "saved" | "dirty" | "error";

const DOT_COLOR: Record<SaveState, string> = {
  saved: "#22c55e",
  dirty: "#eab308",
  error: "#ef4444",
};

const DOT_LABEL: Record<SaveState, string> = {
  saved: "saved",
  dirty: "unsaved changes",
  error: "save failed",
};

export interface FileNameMenuProps {
  name: string;
  saveState: SaveState;
  isPublic: boolean;
  // null when there's no project row yet — in that case Save from the
  // dropdown falls through to the Save As flow (modal).
  projectId: string | null;
  canEdit: boolean;
  // False when viewing someone else's public project — rename + the
  // visibility toggle get disabled; Save still works (copy-on-save).
  ownedByMe: boolean;
  // Display name of the author when the viewer doesn't own the row.
  authorName: string | null;
  onRename: (next: string) => Promise<void> | void;
  // Called after the user confirms the visibility change in the modal.
  onRequestToggleVisibility: (next: boolean) => void;
  // Save from the dropdown — same semantics as File → Save.
  onSave: () => void;
  // Non-null when the current draft matches another of the user's
  // existing projects (excluding the current row). The Rename button
  // relabels to "Overwrite" and the parent handler forks the current
  // graph into that row.
  findConflict?: (name: string) => { name: string } | null;
}

export default function FileNameMenu({
  name,
  saveState,
  isPublic,
  projectId,
  canEdit,
  ownedByMe,
  authorName,
  onRename,
  onRequestToggleVisibility,
  onSave,
  findConflict,
}: FileNameMenuProps) {
  const canMutate = canEdit && ownedByMe;
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(name);
  // Tracks the last external `name` we've reconciled against. When the
  // dropdown is closed and `name` changes (load, Save As, rename
  // elsewhere), we pull the new value in. This is the React-idiomatic
  // derived-state pattern — the stale value is replaced in the same
  // render, so there's no extra effect round-trip.
  const [seenName, setSeenName] = useState(name);
  if (!open && name !== seenName) {
    setSeenName(name);
    setDraft(name);
  }
  const [saving, setSaving] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  useEffect(() => {
    if (open) {
      const t = setTimeout(() => inputRef.current?.select(), 30);
      return () => clearTimeout(t);
    }
  }, [open]);

  const commitRename = async () => {
    const trimmed = draft.trim();
    if (!trimmed || trimmed === name || saving) return;
    setSaving(true);
    try {
      await onRename(trimmed);
    } finally {
      setSaving(false);
    }
  };

  const dotColor = DOT_COLOR[saveState];

  return (
    <div
      ref={rootRef}
      style={{
        position: "relative",
        display: "flex",
        alignItems: "center",
        height: "100%",
      }}
    >
      <button
        onMouseDown={(e) => {
          e.preventDefault();
          setOpen((v) => !v);
        }}
        title={`${name} — ${DOT_LABEL[saveState]}`}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          height: 16,
          padding: "0 10px",
          background: open ? "#27272a" : "#1c1c1f",
          border: "1px solid #27272a",
          borderRadius: 10,
          color: "#e5e7eb",
          fontFamily: "inherit",
          fontSize: 10,
          cursor: "default",
          whiteSpace: "nowrap",
          maxWidth: 260,
          overflow: "hidden",
          textOverflow: "ellipsis",
        }}
      >
        <span
          style={{
            width: 7,
            height: 7,
            borderRadius: "50%",
            background: dotColor,
            boxShadow: `0 0 4px ${dotColor}`,
            flexShrink: 0,
          }}
        />
        <span
          style={{
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {name}
        </span>
      </button>
      {open && (
        <div
          style={{
            position: "absolute",
            top: "100%",
            left: "50%",
            transform: "translateX(-50%)",
            width: 280,
            background: "#18181b",
            border: "1px solid #27272a",
            borderRadius: 4,
            boxShadow: "0 6px 20px rgba(0,0,0,0.5)",
            padding: 10,
            marginTop: 2,
            fontSize: 11,
            color: "#e5e7eb",
          }}
        >
          <div
            style={{
              color: "#a1a1aa",
              fontSize: 10,
              textTransform: "uppercase",
              letterSpacing: 0.5,
              marginBottom: 4,
            }}
          >
            Project name
          </div>
          <input
            ref={inputRef}
            type="text"
            value={draft}
            disabled={!canMutate}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                commitRename();
              }
            }}
            spellCheck={false}
            style={{
              width: "100%",
              boxSizing: "border-box",
              padding: "5px 8px",
              background: "#0a0a0a",
              border: "1px solid #27272a",
              color: canMutate ? "#e5e7eb" : "#71717a",
              fontFamily: "inherit",
              fontSize: 11,
              borderRadius: 3,
              marginBottom: ownedByMe ? 8 : 6,
            }}
          />
          {!ownedByMe && authorName && (
            <div
              style={{
                color: "#a1a1aa",
                fontSize: 10,
                marginBottom: 8,
                fontStyle: "italic",
              }}
            >
              by {authorName} · save creates your own copy
            </div>
          )}

          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              padding: "6px 2px",
              marginBottom: 8,
              borderTop: "1px solid #27272a",
              borderBottom: "1px solid #27272a",
            }}
          >
            <div>
              <div style={{ color: "#e5e7eb" }}>
                {isPublic ? "Public" : "Private"}
              </div>
              <div style={{ color: "#71717a", fontSize: 10, marginTop: 2 }}>
                {isPublic
                  ? "Anyone with the link can view."
                  : "Only you can view."}
              </div>
            </div>
            <VisibilityToggle
              value={isPublic}
              disabled={!canMutate || !projectId}
              onChange={(next) => onRequestToggleVisibility(next)}
            />
          </div>

          {(() => {
            // Compute collision only when the draft differs from
            // the current name — otherwise every open-of-dropdown
            // would show an (inaccurate) warning on the current
            // name itself.
            const draftTrimmed = draft.trim();
            const conflict =
              canMutate &&
              draftTrimmed &&
              draftTrimmed !== name
                ? findConflict?.(draftTrimmed) ?? null
                : null;
            return (
              <>
                {conflict && (
                  <div
                    style={{
                      color: "#facc15",
                      fontSize: 10,
                      marginBottom: 8,
                      lineHeight: 1.4,
                    }}
                  >
                    A project named &ldquo;{conflict.name}&rdquo; already
                    exists — renaming will overwrite it with the current
                    graph.
                  </div>
                )}
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: 8,
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 6,
                      color: "#71717a",
                      fontSize: 10,
                    }}
                  >
                    <span
                      style={{
                        width: 7,
                        height: 7,
                        borderRadius: "50%",
                        background: dotColor,
                      }}
                    />
                    {DOT_LABEL[saveState]}
                  </div>
                  <div style={{ display: "flex", gap: 6 }}>
                    {canMutate && projectId && draftTrimmed && draftTrimmed !== name && (
                      <button
                        onClick={commitRename}
                        disabled={saving}
                        style={{
                          ...btnStyle(),
                          background: conflict ? "#b45309" : "#1e3a8a",
                          border: `1px solid ${conflict ? "#b45309" : "#1e3a8a"}`,
                          color: conflict ? "#fef3c7" : "#dbeafe",
                          opacity: saving ? 0.5 : 1,
                        }}
                      >
                        {saving
                          ? conflict
                            ? "Overwriting…"
                            : "Renaming…"
                          : conflict
                          ? "Overwrite"
                          : "Rename"}
                      </button>
                    )}
                    <button
                      onClick={() => {
                        setOpen(false);
                        onSave();
                      }}
                      disabled={!canEdit}
                      style={{
                        ...btnStyle(),
                        background: "#16a34a",
                        border: "1px solid #16a34a",
                        color: "#dcfce7",
                        opacity: canEdit ? 1 : 0.5,
                      }}
                    >
                      Save
                    </button>
                  </div>
                </div>
              </>
            );
          })()}
        </div>
      )}
    </div>
  );
}

function VisibilityToggle({
  value,
  disabled,
  onChange,
}: {
  value: boolean;
  disabled: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <button
      onClick={() => {
        if (disabled) return;
        onChange(!value);
      }}
      title={
        disabled
          ? "Save the project first to set visibility"
          : value
          ? "Switch to private"
          : "Switch to public"
      }
      style={{
        width: 32,
        height: 18,
        borderRadius: 9,
        background: value ? "#16a34a" : "#3f3f46",
        border: "none",
        position: "relative",
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.5 : 1,
        padding: 0,
        transition: "background 120ms",
      }}
    >
      <span
        style={{
          position: "absolute",
          top: 2,
          left: value ? 16 : 2,
          width: 14,
          height: 14,
          borderRadius: "50%",
          background: "#fafafa",
          transition: "left 120ms",
        }}
      />
    </button>
  );
}

function btnStyle(): React.CSSProperties {
  return {
    padding: "3px 10px",
    background: "transparent",
    border: "1px solid #3f3f46",
    color: "#e5e7eb",
    fontFamily: "inherit",
    fontSize: 11,
    borderRadius: 3,
    cursor: "pointer",
  };
}
