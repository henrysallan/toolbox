"use client";

import { useEffect, useRef, useState } from "react";
import AccountMenu from "./AccountMenu";
import VersionMenu from "./VersionMenu";
import FileNameMenu, { type SaveState } from "./FileNameMenu";
import NodeBrowserDropdown from "./NodeBrowserDropdown";
import { useUser } from "@/lib/auth-context";

type MenuItem =
  | {
      kind: "item";
      label: string;
      shortcut?: string;
      onClick?: () => void;
      disabled?: boolean;
    }
  | { kind: "divider" };

interface MenuDef {
  id: string;
  label: string;
  items: MenuItem[];
}

export interface MenuBarProps {
  onUndo: () => void;
  onRedo: () => void;
  canUndo?: boolean;
  canRedo?: boolean;
  onOpenProjectSettings: () => void;
  // File → New. Clears the current graph back to a fresh seed,
  // prompting the user first if there's unsaved work.
  onNewProject: () => void;
  // Save overwrites the current project silently; if there's no current
  // project it falls through to Save As (open the name modal).
  onSave: () => void;
  onSaveAs: () => void;
  onSaveIncremental: () => void;
  canSaveIncremental: boolean;
  onOpenLoad: () => void;
  // File-name pill (absolutely centered). Undefined disables rendering.
  projectName: string;
  projectId: string | null;
  saveState: SaveState;
  isPublic: boolean;
  // False when viewing someone else's public project — disables
  // rename + visibility toggle. Save still works (forks a copy).
  ownedByMe: boolean;
  authorName: string | null;
  onRenameProject: (next: string) => Promise<void> | void;
  onRequestToggleVisibility: (next: boolean) => void;
  // Sync name-collision check for the rename field. Returns the
  // conflicting row (or null) so the pill can relabel Rename →
  // Overwrite when typing over another of the user's projects.
  findNameConflict?: (name: string) => { name: string } | null;
  // Called by the Node menu when the user picks a node type from the
  // dropdown. Same signature as the Shift+A popup's add path so the
  // parent can reuse onAddNode verbatim.
  onAddNode: (type: string) => void;
}

const BAR_HEIGHT = 22;

export default function MenuBar({
  onUndo,
  onRedo,
  canUndo,
  canRedo,
  onOpenProjectSettings,
  onNewProject,
  onSave,
  onSaveAs,
  onSaveIncremental,
  canSaveIncremental,
  onOpenLoad,
  projectName,
  projectId,
  saveState,
  isPublic,
  ownedByMe,
  authorName,
  onRenameProject,
  onRequestToggleVisibility,
  findNameConflict,
  onAddNode,
}: MenuBarProps) {
  const { user } = useUser();
  const signedIn = !!user;
  const [openId, setOpenId] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  // Click-outside and escape both dismiss the open menu.
  useEffect(() => {
    if (!openId) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpenId(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpenId(null);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [openId]);

  const menus: MenuDef[] = [
    {
      id: "toolbox",
      label: "Toolbox",
      items: [
        { kind: "item", label: "About Toolbox", disabled: true },
        { kind: "divider" },
        {
          kind: "item",
          label: "Project Settings…",
          onClick: onOpenProjectSettings,
        },
      ],
    },
    {
      id: "file",
      label: "File",
      items: [
        {
          // No keyboard shortcut — ⌘N is claimed by the browser for
          // a new window and not worth the fight.
          kind: "item",
          label: "New",
          onClick: onNewProject,
        },
        {
          // Always available — the Load panel has a Public tab that
          // works without auth. The Private tab gates itself internally.
          kind: "item",
          label: "Load…",
          onClick: onOpenLoad,
        },
        { kind: "divider" },
        {
          kind: "item",
          label: "Save",
          shortcut: "⌘S",
          disabled: !signedIn,
          onClick: onSave,
        },
        {
          kind: "item",
          label: "Save As…",
          shortcut: "⇧⌘S",
          disabled: !signedIn,
          onClick: onSaveAs,
        },
        {
          kind: "item",
          label: "Save Incremental",
          disabled: !canSaveIncremental,
          onClick: onSaveIncremental,
        },
        { kind: "item", label: "Export…", disabled: true },
      ],
    },
    {
      id: "edit",
      label: "Edit",
      items: [
        {
          kind: "item",
          label: "Undo",
          shortcut: "⌘Z",
          disabled: !canUndo,
          onClick: onUndo,
        },
        {
          kind: "item",
          label: "Redo",
          shortcut: "⇧⌘Z",
          disabled: !canRedo,
          onClick: onRedo,
        },
      ],
    },
    // Node menu is special-cased in the render loop below — it uses
    // NodeBrowserDropdown instead of the flat list MenuDropdown, so
    // `items` is left empty and never rendered.
    { id: "node", label: "Node", items: [] },
  ];

  return (
    <div
      ref={rootRef}
      style={{
        height: BAR_HEIGHT,
        flexShrink: 0,
        background: "#111113",
        borderBottom: "1px solid #27272a",
        display: "flex",
        alignItems: "stretch",
        fontFamily: "ui-monospace, monospace",
        fontSize: 11,
        color: "#e5e7eb",
        position: "relative",
        zIndex: 1000,
        userSelect: "none",
      }}
    >
      {menus.map((m) => {
        const open = openId === m.id;
        return (
          <div key={m.id} style={{ position: "relative" }}>
            <button
              onMouseDown={(e) => {
                e.preventDefault();
                setOpenId(open ? null : m.id);
              }}
              onMouseEnter={() => {
                // Once a menu is open, hovering siblings swaps to that menu —
                // matches native menu-bar behavior.
                if (openId && openId !== m.id) setOpenId(m.id);
              }}
              style={{
                height: "100%",
                padding: "0 10px",
                background: open ? "#27272a" : "transparent",
                color: "#e5e7eb",
                border: "none",
                fontFamily: "inherit",
                fontSize: "inherit",
                cursor: "default",
                fontWeight: m.id === "toolbox" ? 600 : 400,
              }}
            >
              {m.label}
            </button>
            {open &&
              (m.id === "node" ? (
                <NodeBrowserDropdown
                  onAdd={onAddNode}
                  onClose={() => setOpenId(null)}
                />
              ) : (
                <MenuDropdown
                  items={m.items}
                  onClose={() => setOpenId(null)}
                />
              ))}
          </div>
        );
      })}
      <div style={{ flex: 1 }} />
      {/* Absolutely centered so the left-menu width and right-cluster
          width don't shift the pill off-center. */}
      <div
        style={{
          position: "absolute",
          left: "50%",
          top: 0,
          height: "100%",
          transform: "translateX(-50%)",
          display: "flex",
          alignItems: "center",
          pointerEvents: "auto",
        }}
      >
        <FileNameMenu
          name={projectName}
          saveState={saveState}
          isPublic={isPublic}
          projectId={projectId}
          canEdit={signedIn}
          ownedByMe={ownedByMe}
          authorName={authorName}
          onRename={onRenameProject}
          onRequestToggleVisibility={onRequestToggleVisibility}
          onSave={onSave}
          findConflict={findNameConflict}
        />
      </div>
      <VersionMenu />
      <AccountMenu />
    </div>
  );
}

function MenuDropdown({
  items,
  onClose,
}: {
  items: MenuItem[];
  onClose: () => void;
}) {
  return (
    <div
      style={{
        position: "absolute",
        top: "100%",
        left: 0,
        minWidth: 200,
        background: "#18181b",
        border: "1px solid #27272a",
        borderRadius: 4,
        boxShadow: "0 6px 20px rgba(0,0,0,0.5)",
        padding: 4,
        marginTop: 2,
      }}
    >
      {items.map((it, i) =>
        it.kind === "divider" ? (
          <div
            key={i}
            style={{ height: 1, background: "#27272a", margin: "4px 0" }}
          />
        ) : (
          <MenuRow key={i} item={it} onClose={onClose} />
        )
      )}
    </div>
  );
}

function MenuRow({
  item,
  onClose,
}: {
  item: Extract<MenuItem, { kind: "item" }>;
  onClose: () => void;
}) {
  const [hover, setHover] = useState(false);
  const disabled = !!item.disabled;
  return (
    <button
      disabled={disabled}
      onClick={() => {
        if (disabled) return;
        item.onClick?.();
        onClose();
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        gap: 24,
        width: "100%",
        padding: "3px 10px",
        background: !disabled && hover ? "#1e3a8a" : "transparent",
        border: "none",
        color: disabled ? "#52525b" : "#e5e7eb",
        textAlign: "left",
        fontFamily: "inherit",
        fontSize: "inherit",
        cursor: disabled ? "not-allowed" : "default",
        borderRadius: 3,
      }}
    >
      <span>{item.label}</span>
      {item.shortcut && (
        <span
          style={{
            color: disabled ? "#3f3f46" : hover ? "#d4d4d8" : "#71717a",
            fontSize: 10,
          }}
        >
          {item.shortcut}
        </span>
      )}
    </button>
  );
}
