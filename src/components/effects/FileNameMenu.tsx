"use client";

import { useEffect, useRef, useState } from "react";
import { Dropdown } from "@/lib/param-controls";
import {
  AspectLock,
  RES_PRESETS,
  ResField,
  useAspectLock,
} from "./res-controls";

// Menu-bar pill showing the current project name with a save-state dot.
// Click opens a small dropdown to rename the project and flip its
// visibility. The visibility toggle routes through a confirm modal so
// going public isn't an accidental click.

export type SaveState = "saved" | "dirty" | "error";

const DOT_COLOR: Record<SaveState, string> = {
  saved: "var(--tb-a-green-500)",
  dirty: "var(--tb-a-yellow-500)",
  error: "var(--tb-a-red-500)",
};

const DOT_LABEL: Record<SaveState, string> = {
  saved: "saved",
  dirty: "unsaved changes",
  error: "save failed",
};

export interface FileNameMenuProps {
  name: string;
  // Project render resolution + setter, surfaced in the dropdown.
  canvasRes: [number, number];
  onCanvasResChange: (res: [number, number]) => void;
  saveState: SaveState;
  isPublic: boolean;
  // Public URL slug. Non-null when the project is currently public —
  // unlocks the "Copy editor link" button (/p/<slug>) below the
  // visibility toggle. Mirrors the /live/<slug> button on the project
  // grid's right-click popover.
  publicSlug: string | null;
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
  // Save the current project in place — same semantics as File → Save.
  // The dropdown only routes here when the name is unchanged.
  onSave: () => void;
  // Save a project under the given name as a NEW row, then make it the
  // current project. The dropdown's Save uses this both for a brand-new
  // (unsaved) project and as a "save as" when the user typed a name that
  // differs from the current project's. Handles name collisions like the
  // Save As flow (overwrites a same-named row of the user's).
  onSaveAsNamed: (name: string) => Promise<void> | void;
  // Non-null when the current draft matches another of the user's
  // existing projects (excluding the current row). The Rename button
  // relabels to "Overwrite" and the parent handler forks the current
  // graph into that row.
  findConflict?: (name: string) => { name: string } | null;
  // Own cloud rows only (M2 shared projects): opens the Collaborators
  // modal (member list + invite link). The modal lives in the parent;
  // the dropdown closes when it opens.
  onCollaborators?: () => void;
}

export default function FileNameMenu({
  name,
  canvasRes,
  onCanvasResChange,
  saveState,
  isPublic,
  publicSlug,
  projectId,
  canEdit,
  ownedByMe,
  authorName,
  onRename,
  onRequestToggleVisibility,
  onSave,
  onSaveAsNamed,
  findConflict,
  onCollaborators,
}: FileNameMenuProps) {
  const canMutate = canEdit && ownedByMe;
  const [open, setOpen] = useState(false);
  const [hover, setHover] = useState(false);
  const [draft, setDraft] = useState(name);
  const [editorLinkCopied, setEditorLinkCopied] = useState(false);
  const [liveLinkCopied, setLiveLinkCopied] = useState(false);
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
      const t = e.target as Element | null;
      // The resolution Dropdown's list portals to <body>, so it's outside
      // our subtree — without this, picking a preset would read as a
      // click-away and close the whole panel before the pick lands.
      if (t?.closest?.("[data-tb-dropdown]")) return;
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

  const resKey = `${canvasRes[0]}×${canvasRes[1]}`;
  const isResPreset = RES_PRESETS.some((r) => `${r.w}×${r.h}` === resKey);

  // Aspect lock — the ratio-snapshot mechanics live in useAspectLock
  // (res-controls), shared with Project Settings.
  const aspect = useAspectLock(canvasRes, onCanvasResChange);

  // Build the public URLs only when we have a slug and the project
  // is currently public. Hidden otherwise so the user doesn't see
  // dead controls — matches the pattern in RateProjectPopover.
  const editorUrl =
    isPublic && publicSlug
      ? typeof window === "undefined"
        ? `/p/${publicSlug}`
        : `${window.location.origin}/p/${publicSlug}`
      : null;
  const liveUrl =
    isPublic && publicSlug
      ? typeof window === "undefined"
        ? `/live/${publicSlug}`
        : `${window.location.origin}/live/${publicSlug}`
      : null;

  const copyToClipboard = async (
    url: string,
    setCopied: (v: boolean) => void
  ) => {
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      // Insecure-origin / sandboxed iframe fallback — same trick
      // RateProjectPopover uses. Visual confirmation still fires.
      const ta = document.createElement("textarea");
      ta.value = url;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand("copy");
      } catch {
        // ignore
      }
      document.body.removeChild(ta);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };

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
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        title={`${name} — ${DOT_LABEL[saveState]}`}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          height: 16,
          padding: "0 10px",
          background: open ? "var(--tb-n-7)" : hover ? "var(--tb-n-6)" : "var(--tb-n-4)",
          border: `1px solid ${open || hover ? "var(--tb-n-9)" : "var(--tb-n-7)"}`,
          borderRadius: 10,
          color: "var(--tb-n-16)",
          transition: "background 90ms, border-color 90ms",
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
            background: "var(--tb-n-3)",
            border: "1px solid var(--tb-n-7)",
            borderRadius: 12,
            boxShadow: "0 6px 20px rgba(0,0,0,0.5)",
            padding: 12,
            marginTop: 2,
            fontSize: 11,
            color: "var(--tb-n-16)",
            // Uniform rhythm between rows — the section labels and rules
            // are gone, so spacing is what separates the groups now.
            display: "flex",
            flexDirection: "column",
            gap: 8,
          }}
        >
          <input
            ref={inputRef}
            type="text"
            aria-label="Project name"
            placeholder="Project name"
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
              padding: "8px 12px",
              background: "var(--tb-n-0)",
              border: "1px solid var(--tb-n-7)",
              color: canMutate ? "var(--tb-n-16)" : "var(--tb-n-11)",
              fontFamily: "inherit",
              // Doubles as the panel's title now that the label is gone.
              fontSize: 13,
              fontWeight: 600,
              borderRadius: 10,
            }}
          />
          {!ownedByMe && authorName && (
            <div
              style={{
                color: "var(--tb-n-13)",
                fontSize: 10,
                fontStyle: "italic",
              }}
            >
              by {authorName} · save creates your own copy
            </div>
          )}

          {/* Resolution — same presets as Project Settings, editable here
              without leaving the dropdown. Not gated by ownership: it's a
              local render setting, like in Project Settings. Unlabelled:
              the fields carry aria-labels instead. */}
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <ResField
              label="Width"
              value={canvasRes[0]}
              onGestureStart={aspect.snapRatio}
              onCommit={aspect.applyWidth}
            />
            <AspectLock locked={aspect.locked} onToggle={aspect.toggle} />
            <ResField
              label="Height"
              value={canvasRes[1]}
              onGestureStart={aspect.snapRatio}
              onCommit={aspect.applyHeight}
            />
            <Dropdown
              value={isResPreset ? resKey : "__custom__"}
              options={[
                // Only offered as a readout of the current off-preset
                // size; picking it is a no-op below.
                ...(isResPreset
                  ? []
                  : [{ value: "__custom__", label: "custom" }]),
                ...RES_PRESETS.map((r) => ({
                  value: `${r.w}×${r.h}`,
                  label: r.label,
                })),
              ]}
              onChange={(v) => {
                if (v === "__custom__") return;
                const [w, h] = v.split("×").map(Number);
                onCanvasResChange([w, h]);
              }}
              title="Resolution preset"
              style={{
                flex: 1,
                minWidth: 0,
                height: 30,
                borderRadius: 10,
                padding: "0 10px",
                color: "var(--tb-n-16)",
              }}
            />
          </div>

          <VisibilityToggle
            value={isPublic}
            disabled={!canMutate || !projectId}
            onChange={(next) => onRequestToggleVisibility(next)}
          />

          {editorUrl && liveUrl && (
            <div
              style={{
                display: "flex",
                gap: 6,
              }}
            >
              <button
                onClick={() => copyToClipboard(editorUrl, setEditorLinkCopied)}
                title="Copy a link that opens this project in the full editor (read-only for non-owners; signed-in viewers can save their own forked copy)."
                style={{
                  ...btnStyle(),
                  flex: 1,
                  background: editorLinkCopied ? "var(--tb-a-blue-900)" : "transparent",
                  color: editorLinkCopied ? "var(--tb-a-blue-100)" : "var(--tb-n-16)",
                  border: `1px solid ${editorLinkCopied ? "var(--tb-a-blue-900)" : "var(--tb-n-9)"}`,
                }}
              >
                {editorLinkCopied ? "Copied" : "Copy editor link"}
              </button>
              <button
                onClick={() => copyToClipboard(liveUrl, setLiveLinkCopied)}
                title="Copy the minimal client view link — full-screen output only, no editor chrome. Same project graph; different audience."
                style={{
                  ...btnStyle(),
                  flex: 1,
                  background: liveLinkCopied ? "var(--tb-a-green-800)" : "transparent",
                  color: liveLinkCopied ? "var(--tb-a-green-100)" : "var(--tb-n-16)",
                  border: `1px solid ${liveLinkCopied ? "var(--tb-a-green-800)" : "var(--tb-n-9)"}`,
                }}
              >
                {liveLinkCopied ? "Copied" : "Copy live link"}
              </button>
            </div>
          )}

          {onCollaborators && (
            <button
              onClick={() => {
                setOpen(false);
                onCollaborators();
              }}
              title="Manage who can open and save this project, and copy an invite link."
              style={{ ...btnStyle(), width: "100%" }}
            >
              Collaborators…
            </button>
          )}

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
            // The green Save button is a "save as": when the user typed
            // a name that differs from the current project (or there's
            // no project row yet) it forks the current graph into a NEW
            // project under that name. An unchanged name saves progress
            // to the current row.
            const savesAsNew =
              !!draftTrimmed && (!projectId || draftTrimmed !== name);
            return (
              <>
                {conflict && (
                  <div
                    style={{
                      color: "var(--tb-a-yellow-400)",
                      fontSize: 10,
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
                      color: "var(--tb-n-11)",
                      fontSize: 11,
                    }}
                  >
                    <span
                      style={{
                        width: 9,
                        height: 9,
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
                          background: conflict ? "var(--tb-a-amber-700)" : "var(--tb-a-blue-900)",
                          border: `1px solid ${conflict ? "var(--tb-a-amber-700)" : "var(--tb-a-blue-900)"}`,
                          color: conflict ? "var(--tb-a-amber-100)" : "var(--tb-a-blue-100)",
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
                        // "Save as": fork the current graph into a new
                        // project under the typed name and switch to
                        // working in it (onSaveAsNamed repoints the
                        // current-project state) — the original row stays
                        // put. Use Rename (beside this) to relabel the
                        // current project in place. An unchanged name just
                        // saves progress to the current row.
                        if (savesAsNew) {
                          Promise.resolve(onSaveAsNamed(draftTrimmed)).catch(
                            () => {}
                          );
                        } else {
                          onSave();
                        }
                      }}
                      disabled={!canEdit}
                      title={
                        savesAsNew && projectId
                          ? "Save a new project under this name and continue working in it. The current project is left unchanged."
                          : "Save the current project."
                      }
                      style={{
                        ...btnStyle(),
                        background: "var(--tb-a-green-600)",
                        border: "1px solid var(--tb-a-green-600)",
                        color: "var(--tb-a-green-100)",
                        padding: "7px 18px",
                        fontSize: 13,
                        opacity: canEdit ? 1 : 0.5,
                      }}
                    >
                      {savesAsNew && projectId ? "Save as" : "Save"}
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

// Full-width Private / Public segmented pill. A rounded indicator slides
// behind whichever side is active; clicking the inactive side switches.
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
    <div
      style={{
        position: "relative",
        display: "flex",
        width: "100%",
        height: 30,
        borderRadius: 999,
        flexShrink: 0,
        background: "var(--tb-n-0)",
        border: "1px solid var(--tb-n-7)",
        opacity: disabled ? 0.5 : 1,
        overflow: "hidden",
      }}
    >
      {/* sliding indicator */}
      <span
        aria-hidden
        style={{
          position: "absolute",
          top: 2,
          bottom: 2,
          left: value ? "50%" : 2,
          width: "calc(50% - 2px)",
          borderRadius: 999,
          background: value ? "var(--tb-a-green-800)" : "var(--tb-n-9)",
          transition: "left 160ms ease, background 160ms ease",
        }}
      />
      {([false, true] as const).map((isPublicSide) => {
        const active = isPublicSide === value;
        return (
          <button
            key={isPublicSide ? "public" : "private"}
            onClick={() => {
              if (disabled || active) return;
              onChange(isPublicSide);
            }}
            title={
              disabled
                ? "Save the project first to set visibility"
                : isPublicSide
                  ? "Anyone with the link can view."
                  : "Only you can view."
            }
            style={{
              flex: 1,
              zIndex: 1,
              background: "transparent",
              border: "none",
              padding: 0,
              fontFamily: "inherit",
              fontSize: 11,
              letterSpacing: 0.3,
              color: active
                ? isPublicSide
                  ? "var(--tb-a-green-100)"
                  : "var(--tb-n-17)"
                : "var(--tb-n-11)",
              cursor: disabled || active ? "default" : "pointer",
              transition: "color 160ms ease",
            }}
          >
            {isPublicSide ? "Public" : "Private"}
          </button>
        );
      })}
    </div>
  );
}

function btnStyle(): React.CSSProperties {
  return {
    padding: "6px 14px",
    background: "transparent",
    border: "1px solid var(--tb-n-9)",
    color: "var(--tb-n-16)",
    fontFamily: "inherit",
    fontSize: 11,
    // Pill, to sit with the rounded fields and the visibility toggle.
    borderRadius: 999,
    cursor: "pointer",
  };
}
