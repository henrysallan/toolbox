"use client";

import { useState } from "react";
import type { SavedComposition } from "@/lib/project";
import { AssetsView, type AssetItem } from "./AssetsView";

// The Project view (v5): a file-browser panel that replaces the node editor,
// showing the project's compositions as a grid of cards or a table. Double-
// click to enter; create / duplicate / delete / rename / reorder from here.
// The live preview keeps rendering the last-active composition while open.
//
// See specdocs/062926_compositions-and-project-view.md.

interface ProjectViewProps {
  projectName: string;
  canRenameProject: boolean;
  compositions: SavedComposition[];
  activeId: string;
  assets?: AssetItem[];
  assetsFolderName?: string | null;
  onPickAssetsFolder?: () => void;
  onRenameProject: (name: string) => void;
  onEnter: (id: string) => void;
  onCreate: () => void;
  onDelete: (id: string) => void;
  onDuplicate: (id: string) => void;
  onRename: (id: string, name: string) => void;
  onReorder: (orderedIds: string[]) => void;
}

function formatEdited(ms: number): string {
  const diff = Math.max(0, Date.now() - ms);
  const min = 60_000;
  const hr = 3_600_000;
  const day = 86_400_000;
  if (diff < min) return "just now";
  if (diff < hr) return `${Math.floor(diff / min)}m ago`;
  if (diff < day) return `${Math.floor(diff / hr)}h ago`;
  if (diff < 7 * day) return `${Math.floor(diff / day)}d ago`;
  return new Date(ms).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

function settingsLine(c: SavedComposition): string {
  const s = c.scene;
  const parts: string[] = [];
  if (s?.width && s?.height) parts.push(`${s.width}×${s.height}`);
  if (s?.fps) parts.push(`${s.fps} fps`);
  if (c.modifiedAt) parts.push(formatEdited(c.modifiedAt));
  return parts.join("  ·  ");
}

type DnD = {
  dragId: string | null;
  overId: string | null;
  start: (id: string) => void;
  enter: (id: string) => void;
  end: () => void;
  drop: (id: string) => void;
};

export function ProjectView({
  projectName,
  canRenameProject,
  compositions,
  activeId,
  assets,
  assetsFolderName,
  onPickAssetsFolder,
  onRenameProject,
  onEnter,
  onCreate,
  onDelete,
  onDuplicate,
  onRename,
  onReorder,
}: ProjectViewProps) {
  const [mode, setMode] = useState<"comps" | "assets">("comps");
  const [view, setView] = useState<"grid" | "list">("grid");
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const pendingComp = compositions.find((c) => c.id === pendingDelete);

  const dnd: DnD = {
    dragId,
    overId,
    start: setDragId,
    enter: setOverId,
    end: () => {
      setDragId(null);
      setOverId(null);
    },
    drop: (targetId) => {
      if (dragId && dragId !== targetId) {
        const ids = compositions.map((c) => c.id);
        const from = ids.indexOf(dragId);
        const to = ids.indexOf(targetId);
        if (from !== -1 && to !== -1) {
          ids.splice(to, 0, ids.splice(from, 1)[0]);
          onReorder(ids);
        }
      }
      setDragId(null);
      setOverId(null);
    },
  };

  return (
    <div
      style={{
        position: "relative",
        height: "100%",
        minHeight: 0,
        display: "flex",
        flexDirection: "column",
        background: "#0a0a0a",
        color: "#e5e7eb",
      }}
    >
      <ProjectHeader
        projectName={projectName}
        canRename={canRenameProject}
        mode={mode}
        onMode={setMode}
        count={compositions.length}
        view={view}
        onView={setView}
        onRenameProject={onRenameProject}
        onCreate={onCreate}
      />

      {mode === "assets" ? (
        <AssetsView
          assets={assets}
          folderName={assetsFolderName}
          onPickFolder={onPickAssetsFolder}
        />
      ) : view === "grid" ? (
        <div
          style={{
            flex: 1,
            minHeight: 0,
            overflowY: "auto",
            padding: 8,
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))",
            gap: 8,
            alignContent: "start",
          }}
        >
          {compositions.map((c) => (
            <CompositionCard
              key={c.id}
              comp={c}
              active={c.id === activeId}
              dnd={dnd}
              onEnter={() => onEnter(c.id)}
              onDelete={() => setPendingDelete(c.id)}
              onDuplicate={() => onDuplicate(c.id)}
              onRename={(name) => onRename(c.id, name)}
            />
          ))}
        </div>
      ) : (
        <CompositionTable
          compositions={compositions}
          activeId={activeId}
          dnd={dnd}
          onEnter={onEnter}
          onDelete={setPendingDelete}
          onDuplicate={onDuplicate}
          onRename={onRename}
        />
      )}

      {pendingComp && (
        <ConfirmDeleteModal
          name={pendingComp.name}
          onCancel={() => setPendingDelete(null)}
          onConfirm={() => {
            onDelete(pendingComp.id);
            setPendingDelete(null);
          }}
        />
      )}
    </div>
  );
}

function ConfirmDeleteModal({
  name,
  onCancel,
  onConfirm,
}: {
  name: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div
      onClick={onCancel}
      style={{
        position: "absolute",
        inset: 0,
        background: "#000000aa",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 50,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 300,
          background: "#161619",
          border: "1px solid #2a2a2e",
          borderRadius: 8,
          padding: 16,
          boxShadow: "0 12px 40px #000000cc",
        }}
      >
        <div style={{ fontSize: 13, fontWeight: 600, color: "#fafafa" }}>
          Confirm Deletion
        </div>
        <div style={{ fontSize: 11, color: "#a1a1aa", marginTop: 8, lineHeight: 1.5 }}>
          Delete <span style={{ color: "#e5e7eb" }}>{name}</span>? This removes
          the composition and its nodes. You can undo it afterwards.
        </div>
        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            gap: 8,
            marginTop: 16,
          }}
        >
          <button
            type="button"
            onClick={onCancel}
            style={{
              fontSize: 11,
              color: "#d4d4d8",
              background: "#1f1f23",
              border: "1px solid #2a2a2e",
              borderRadius: 6,
              padding: "5px 12px",
              cursor: "pointer",
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            autoFocus
            onClick={onConfirm}
            style={{
              fontSize: 11,
              fontWeight: 600,
              color: "#fee2e2",
              background: "#b91c1c",
              border: "1px solid #dc2626",
              borderRadius: 6,
              padding: "5px 12px",
              cursor: "pointer",
            }}
          >
            Delete
          </button>
        </div>
      </div>
    </div>
  );
}

function ProjectHeader({
  projectName,
  canRename,
  mode,
  onMode,
  count,
  view,
  onView,
  onRenameProject,
  onCreate,
}: {
  projectName: string;
  canRename: boolean;
  mode: "comps" | "assets";
  onMode: (m: "comps" | "assets") => void;
  count: number;
  view: "grid" | "list";
  onView: (v: "grid" | "list") => void;
  onRenameProject: (name: string) => void;
  onCreate: () => void;
}) {
  const [draft, setDraft] = useState(projectName);
  const [dirty, setDirty] = useState(false);
  // Re-sync the field when the project name changes externally (load /
  // cloud rename) and we're not mid-edit — done during render (no effect).
  const [seenName, setSeenName] = useState(projectName);
  if (projectName !== seenName) {
    setSeenName(projectName);
    if (!dirty) setDraft(projectName);
  }

  const commit = () => {
    const name = draft.trim();
    if (name && name !== projectName) onRenameProject(name);
    setDirty(false);
  };

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        height: 28,
        padding: "0 8px",
        borderBottom: "1px solid #1c1c1f",
        flexShrink: 0,
      }}
    >
      <input
        value={draft}
        disabled={!canRename}
        onChange={(e) => {
          setDraft(e.target.value);
          setDirty(e.target.value.trim() !== projectName);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
          else if (e.key === "Escape") {
            setDraft(projectName);
            setDirty(false);
          }
        }}
        spellCheck={false}
        style={{
          fontSize: 12,
          fontWeight: 600,
          color: "#fafafa",
          background: "transparent",
          border: "1px solid transparent",
          borderRadius: 4,
          padding: "2px 5px",
          outline: "none",
          minWidth: 60,
          maxWidth: 240,
          cursor: canRename ? "text" : "default",
        }}
        onFocus={(e) => {
          if (canRename) e.currentTarget.style.borderColor = "#27272a";
        }}
        onBlur={(e) => {
          e.currentTarget.style.borderColor = "transparent";
        }}
      />
      {dirty && (
        <button
          type="button"
          onClick={commit}
          style={{
            fontSize: 10,
            fontWeight: 600,
            color: "#052e16",
            background: "#4ade80",
            border: "none",
            borderRadius: 999,
            padding: "2px 9px",
            cursor: "pointer",
          }}
        >
          Save
        </button>
      )}
      <div style={{ width: 6 }} />
      <SegmentedToggle
        options={[
          { id: "comps", label: "Comps" },
          { id: "assets", label: "Assets" },
        ]}
        value={mode}
        onChange={(v) => onMode(v as "comps" | "assets")}
      />
      <div style={{ flex: 1 }} />
      {mode === "comps" && (
        <>
          <span style={{ fontSize: 10, color: "#52525b" }}>
            {count} {count === 1 ? "comp" : "comps"}
          </span>
          <div style={{ display: "flex", gap: 2 }}>
            <HeaderIconButton
              title="Grid view"
              active={view === "grid"}
              onClick={() => onView("grid")}
            >
              <GridIcon />
            </HeaderIconButton>
            <HeaderIconButton
              title="Table view"
              active={view === "list"}
              onClick={() => onView("list")}
            >
              <ListIcon />
            </HeaderIconButton>
          </div>
          <HeaderIconButton title="New composition" onClick={onCreate}>
            <PlusIcon />
          </HeaderIconButton>
        </>
      )}
    </div>
  );
}

function SegmentedToggle({
  options,
  value,
  onChange,
}: {
  options: { id: string; label: string }[];
  value: string;
  onChange: (id: string) => void;
}) {
  return (
    <div
      style={{
        display: "flex",
        background: "#0f0f11",
        border: "1px solid #232327",
        borderRadius: 6,
        padding: 1,
      }}
    >
      {options.map((o) => {
        const active = o.id === value;
        return (
          <button
            key={o.id}
            type="button"
            onClick={() => onChange(o.id)}
            style={{
              fontSize: 10,
              fontWeight: 600,
              color: active ? "#fafafa" : "#71717a",
              background: active ? "#26262b" : "transparent",
              border: "none",
              borderRadius: 5,
              padding: "2px 10px",
              cursor: "pointer",
            }}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

function CompositionCard({
  comp,
  active,
  dnd,
  onEnter,
  onDelete,
  onDuplicate,
  onRename,
}: {
  comp: SavedComposition;
  active: boolean;
  dnd: DnD;
  onEnter: () => void;
  onDelete: () => void;
  onDuplicate: () => void;
  onRename: (name: string) => void;
}) {
  const [hover, setHover] = useState(false);
  const dragging = dnd.dragId === comp.id;
  const dragOver = dnd.overId === comp.id && dnd.dragId !== comp.id;
  const aspect =
    comp.scene?.width && comp.scene?.height
      ? comp.scene.width / comp.scene.height
      : 1;

  return (
    <div
      draggable
      onDragStart={() => dnd.start(comp.id)}
      onDragEnter={() => dnd.enter(comp.id)}
      onDragOver={(e) => e.preventDefault()}
      onDragEnd={dnd.end}
      onDrop={(e) => {
        e.preventDefault();
        dnd.drop(comp.id);
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onDoubleClick={onEnter}
      style={{
        display: "flex",
        flexDirection: "column",
        borderRadius: 6,
        border: `1px solid ${
          active ? "#3f3f46" : dragOver ? "#52525b" : "#1f1f23"
        }`,
        background: "#111114",
        overflow: "hidden",
        cursor: "pointer",
        opacity: dragging ? 0.4 : 1,
      }}
    >
      <div
        style={{
          position: "relative",
          width: "100%",
          aspectRatio: `${Math.max(aspect, 0.4)}`,
          maxHeight: 120,
          background: "#0a0a0a",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          borderBottom: "1px solid #1c1c1f",
        }}
      >
        {comp.thumbnail ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={comp.thumbnail}
            alt={comp.name}
            style={{ width: "100%", height: "100%", objectFit: "contain" }}
          />
        ) : (
          <span style={{ fontSize: 10, color: "#3f3f46" }}>no preview</span>
        )}
        {active && (
          <span
            style={{
              position: "absolute",
              top: 4,
              left: 4,
              fontSize: 8,
              letterSpacing: 0.4,
              textTransform: "uppercase",
              color: "#a1a1aa",
              background: "#000000aa",
              borderRadius: 3,
              padding: "1px 4px",
            }}
          >
            active
          </span>
        )}
        {hover && (
          <div
            style={{ position: "absolute", top: 4, right: 4, display: "flex", gap: 3 }}
          >
            <OverlayIconButton title="Duplicate" onClick={onDuplicate}>
              <DuplicateIcon />
            </OverlayIconButton>
            <OverlayIconButton title="Delete" onClick={onDelete} danger>
              <TrashIcon />
            </OverlayIconButton>
          </div>
        )}
      </div>

      <div style={{ padding: "4px 6px" }}>
        <EditableName
          name={comp.name}
          active={active}
          onRename={onRename}
          fontSize={11}
        />
        <div style={{ fontSize: 9, color: "#52525b", marginTop: 1 }}>
          {settingsLine(comp)}
        </div>
      </div>
    </div>
  );
}

function CompositionTable({
  compositions,
  activeId,
  dnd,
  onEnter,
  onDelete,
  onDuplicate,
  onRename,
}: {
  compositions: SavedComposition[];
  activeId: string;
  dnd: DnD;
  onEnter: (id: string) => void;
  onDelete: (id: string) => void;
  onDuplicate: (id: string) => void;
  onRename: (id: string, name: string) => void;
}) {
  const grid = "1fr 160px 70px";
  return (
    <div style={{ flex: 1, minHeight: 0, overflowY: "auto", fontSize: 11 }}>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: grid,
          gap: 8,
          padding: "4px 8px",
          color: "#71717a",
          fontSize: 9,
          textTransform: "uppercase",
          letterSpacing: 0.5,
          borderBottom: "1px solid #1c1c1f",
          position: "sticky",
          top: 0,
          background: "#0a0a0a",
        }}
      >
        <span>Composition</span>
        <span>Settings</span>
        <span />
      </div>
      {compositions.map((c) => {
        const active = c.id === activeId;
        const dragOver = dnd.overId === c.id && dnd.dragId !== c.id;
        return (
          <div
            key={c.id}
            draggable
            onDragStart={() => dnd.start(c.id)}
            onDragEnter={() => dnd.enter(c.id)}
            onDragOver={(e) => e.preventDefault()}
            onDragEnd={dnd.end}
            onDrop={(e) => {
              e.preventDefault();
              dnd.drop(c.id);
            }}
            onDoubleClick={() => onEnter(c.id)}
            style={{
              display: "grid",
              gridTemplateColumns: grid,
              gap: 8,
              alignItems: "center",
              padding: "3px 8px",
              borderBottom: "1px solid #141416",
              background: active ? "#161619" : "transparent",
              borderLeft: `2px solid ${
                active ? "#3f3f46" : dragOver ? "#52525b" : "transparent"
              }`,
              cursor: "pointer",
              opacity: dnd.dragId === c.id ? 0.4 : 1,
            }}
          >
            <div
              style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}
            >
              <EditableName
                name={c.name}
                active={active}
                onRename={(name) => onRename(c.id, name)}
                fontSize={11}
              />
              {active && (
                <span
                  style={{
                    fontSize: 8,
                    letterSpacing: 0.4,
                    textTransform: "uppercase",
                    color: "#71717a",
                    flexShrink: 0,
                  }}
                >
                  active
                </span>
              )}
            </div>
            <span style={{ color: "#71717a", fontSize: 10 }}>
              {settingsLine(c)}
            </span>
            <div
              style={{ display: "flex", gap: 4, justifyContent: "flex-end" }}
            >
              <RowIconButton title="Duplicate" onClick={() => onDuplicate(c.id)}>
                <DuplicateIcon />
              </RowIconButton>
              <RowIconButton
                title="Delete"
                onClick={() => onDelete(c.id)}
                danger
              >
                <TrashIcon />
              </RowIconButton>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function EditableName({
  name,
  active,
  onRename,
  fontSize,
}: {
  name: string;
  active: boolean;
  onRename: (name: string) => void;
  fontSize: number;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);

  const commit = () => {
    const next = draft.trim();
    if (next && next !== name) onRename(next);
    else setDraft(name);
    setEditing(false);
  };

  if (editing) {
    return (
      <input
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
          else if (e.key === "Escape") {
            setDraft(name);
            setEditing(false);
          }
        }}
        onClick={(e) => e.stopPropagation()}
        onDoubleClick={(e) => e.stopPropagation()}
        style={{
          width: "100%",
          fontSize,
          color: "#fafafa",
          background: "#000",
          border: "1px solid #3f3f46",
          borderRadius: 3,
          padding: "1px 4px",
          outline: "none",
        }}
      />
    );
  }
  return (
    <div
      onDoubleClick={(e) => {
        e.stopPropagation();
        setDraft(name);
        setEditing(true);
      }}
      title="Double-click to rename"
      style={{
        fontSize,
        color: active ? "#fafafa" : "#d4d4d8",
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
        minWidth: 0,
      }}
    >
      {name}
    </div>
  );
}

// --- buttons ---------------------------------------------------------------

function HeaderIconButton({
  title,
  active,
  onClick,
  children,
}: {
  title: string;
  active?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      title={title}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onClick={onClick}
      style={{
        width: 20,
        height: 18,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        background: active ? "#1b2741" : hover ? "#19191c" : "transparent",
        border: `1px solid ${
          active ? "#26375f" : hover ? "#2a2a2e" : "transparent"
        }`,
        borderRadius: 3,
        color: active ? "#bfdbfe" : hover ? "#e5e7eb" : "#8a8a90",
        cursor: "pointer",
        padding: 0,
      }}
    >
      {children}
    </button>
  );
}

function OverlayIconButton({
  title,
  onClick,
  danger,
  children,
}: {
  title: string;
  onClick: () => void;
  danger?: boolean;
  children: React.ReactNode;
}) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      title={title}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      style={{
        width: 20,
        height: 20,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        borderRadius: 4,
        border: "none",
        cursor: "pointer",
        color: hover ? (danger ? "#fca5a5" : "#fafafa") : "#d4d4d8",
        background: hover ? "#000000dd" : "#000000aa",
      }}
    >
      {children}
    </button>
  );
}

function RowIconButton({
  title,
  onClick,
  danger,
  children,
}: {
  title: string;
  onClick: () => void;
  danger?: boolean;
  children: React.ReactNode;
}) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      title={title}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      style={{
        width: 20,
        height: 18,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        borderRadius: 3,
        border: "none",
        cursor: "pointer",
        color: hover ? (danger ? "#fca5a5" : "#e5e7eb") : "#6b6b71",
        background: hover ? "#19191c" : "transparent",
      }}
    >
      {children}
    </button>
  );
}

// --- icons -----------------------------------------------------------------

function PlusIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
      <path
        d="M6 1.5v9M1.5 6h9"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  );
}

function GridIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 12 12" fill="none">
      <rect x="1" y="1" width="4" height="4" fill="currentColor" />
      <rect x="7" y="1" width="4" height="4" fill="currentColor" />
      <rect x="1" y="7" width="4" height="4" fill="currentColor" />
      <rect x="7" y="7" width="4" height="4" fill="currentColor" />
    </svg>
  );
}

function ListIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 12 12" fill="none">
      <rect x="1" y="2" width="10" height="1.5" fill="currentColor" />
      <rect x="1" y="5.25" width="10" height="1.5" fill="currentColor" />
      <rect x="1" y="8.5" width="10" height="1.5" fill="currentColor" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
      <path
        d="M3 4h10M6.5 4V3h3v1M5 4l.7 9h4.6L11 4"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function DuplicateIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
      <rect
        x="5.5"
        y="5.5"
        width="7.5"
        height="7.5"
        rx="1.4"
        stroke="currentColor"
        strokeWidth="1.3"
      />
      <path
        d="M10 3.5H4.5A1 1 0 0 0 3.5 4.5V10"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
