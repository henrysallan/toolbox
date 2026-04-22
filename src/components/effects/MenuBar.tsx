"use client";

import { useEffect, useRef, useState } from "react";
import AccountMenu from "./AccountMenu";

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
}

const BAR_HEIGHT = 22;

export default function MenuBar({
  onUndo,
  onRedo,
  canUndo,
  canRedo,
  onOpenProjectSettings,
}: MenuBarProps) {
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
        { kind: "item", label: "New", shortcut: "⌘N", disabled: true },
        { kind: "item", label: "Open…", shortcut: "⌘O", disabled: true },
        { kind: "divider" },
        { kind: "item", label: "Save", shortcut: "⌘S", disabled: true },
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
            {open && <MenuDropdown items={m.items} onClose={() => setOpenId(null)} />}
          </div>
        );
      })}
      <div style={{ flex: 1 }} />
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
