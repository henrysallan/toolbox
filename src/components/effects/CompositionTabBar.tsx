"use client";

import { useState } from "react";

// The thin composition tab bar at the top of the node-editor panel (v5).
// Shows the open compositions; click to switch, × to close (close removes
// the tab, it never deletes the composition), + to create a new one. Tabs
// drag to reorder; the strip scrolls horizontally when they overflow.
//
// See specdocs/062926_compositions-and-project-view.md.

export interface CompositionTab {
  id: string;
  name: string;
}

interface CompositionTabBarProps {
  tabs: CompositionTab[];
  activeId: string;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onCreate: () => void;
  // Reorder the tab bar (the new id order). Tab order is independent of the
  // project/composition order in the Project view.
  onReorder: (orderedIds: string[]) => void;
  // Closing is disabled when only one tab is open (there's nowhere to fall
  // back to until the Project view exists).
  canClose: boolean;
}

export function CompositionTabBar({
  tabs,
  activeId,
  onSelect,
  onClose,
  onCreate,
  onReorder,
  canClose,
}: CompositionTabBarProps) {
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);

  const drop = (targetId: string) => {
    if (dragId && dragId !== targetId) {
      const ids = tabs.map((t) => t.id);
      const from = ids.indexOf(dragId);
      const to = ids.indexOf(targetId);
      if (from !== -1 && to !== -1) {
        ids.splice(to, 0, ids.splice(from, 1)[0]);
        onReorder(ids);
      }
    }
    setDragId(null);
    setOverId(null);
  };

  return (
    <div
      style={{
        display: "flex",
        alignItems: "stretch",
        height: 22,
        flexShrink: 0,
        background: "#0a0a0a",
        borderBottom: "1px solid #1c1c1f",
        overflowX: "auto",
        overflowY: "hidden",
        scrollbarWidth: "none",
        WebkitOverflowScrolling: "touch",
      }}
    >
      {tabs.map((tab) => (
        <CompositionTabItem
          key={tab.id}
          tab={tab}
          active={tab.id === activeId}
          canClose={canClose}
          dragging={dragId === tab.id}
          dragOver={overId === tab.id && dragId !== tab.id}
          onSelect={() => onSelect(tab.id)}
          onClose={() => onClose(tab.id)}
          onDragStart={() => setDragId(tab.id)}
          onDragEnter={() => setOverId(tab.id)}
          onDragEnd={() => {
            setDragId(null);
            setOverId(null);
          }}
          onDrop={() => drop(tab.id)}
        />
      ))}
      <NewCompButton onCreate={onCreate} />
    </div>
  );
}

function CompositionTabItem({
  tab,
  active,
  canClose,
  dragging,
  dragOver,
  onSelect,
  onClose,
  onDragStart,
  onDragEnter,
  onDragEnd,
  onDrop,
}: {
  tab: CompositionTab;
  active: boolean;
  canClose: boolean;
  dragging: boolean;
  dragOver: boolean;
  onSelect: () => void;
  onClose: () => void;
  onDragStart: () => void;
  onDragEnter: () => void;
  onDragEnd: () => void;
  onDrop: () => void;
}) {
  const [hover, setHover] = useState(false);
  return (
    <div
      draggable
      onDragStart={onDragStart}
      onDragEnter={onDragEnter}
      onDragOver={(e) => e.preventDefault()}
      onDragEnd={onDragEnd}
      onDrop={(e) => {
        e.preventDefault();
        onDrop();
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onClick={onSelect}
      style={{
        flexShrink: 0,
        display: "flex",
        alignItems: "center",
        gap: 5,
        maxWidth: 180,
        padding: "0 8px",
        background: active ? "#18181b" : "transparent",
        borderRight: "1px solid #1c1c1f",
        // Active gets a top accent; a drop target gets a left accent.
        boxShadow: [
          active ? "inset 0 1.5px 0 0 #3f3f46" : "",
          dragOver ? "inset 1.5px 0 0 0 #52525b" : "",
        ]
          .filter(Boolean)
          .join(", ") || "none",
        color: active ? "#fafafa" : "#a1a1aa",
        fontSize: 9.5,
        letterSpacing: 0.2,
        cursor: "pointer",
        userSelect: "none",
        whiteSpace: "nowrap",
        opacity: dragging ? 0.4 : 1,
      }}
    >
      <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>
        {tab.name}
      </span>
      {canClose && (
        <span
          role="button"
          title="Close tab"
          onClick={(e) => {
            e.stopPropagation();
            onClose();
          }}
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            width: 12,
            height: 12,
            borderRadius: 3,
            color: hover ? "#a1a1aa" : "transparent",
            background: "transparent",
            fontSize: 11,
            lineHeight: 1,
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = "#27272a";
            e.currentTarget.style.color = "#fafafa";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = "transparent";
            e.currentTarget.style.color = hover ? "#a1a1aa" : "transparent";
          }}
        >
          ×
        </span>
      )}
    </div>
  );
}

function NewCompButton({ onCreate }: { onCreate: () => void }) {
  const [hover, setHover] = useState(false);
  return (
    <div
      style={{
        flexShrink: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        width: 24,
        borderRight: "1px solid #1c1c1f",
      }}
    >
      <button
        type="button"
        title="New composition"
        onClick={onCreate}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          width: 16,
          height: 16,
          padding: 0,
          // Square stroke appears on hover.
          background: hover ? "#18181b" : "transparent",
          border: `1px solid ${hover ? "#3f3f46" : "transparent"}`,
          borderRadius: 3,
          color: hover ? "#d4d4d8" : "#71717a",
          cursor: "pointer",
          fontSize: 12,
          lineHeight: 1,
        }}
      >
        +
      </button>
    </div>
  );
}
