"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import AccountMenu from "./AccountMenu";
import ChangelogPopover from "./VersionMenu";
import FileNameMenu, { type SaveState } from "./FileNameMenu";
import NodeBrowserDropdown from "./NodeBrowserDropdown";
import { useUser } from "@/lib/auth-context";
import { CURRENT_VERSION } from "@/lib/changelog";
import { platform } from "@/lib/platform";
import WindowControls from "./WindowControls";
import UpdateToast from "./UpdateToast";
import MessageConsole, {
  type ConsoleEntry,
  type ProgressStatus,
} from "./MessageConsole";
import { useDesktopUpdates } from "./useDesktopUpdates";
import type { RecentProjectEntry } from "@/lib/recent-projects";
import type { LayoutPresetEntry } from "./layout/presets";
import {
  isShortcutFrozen,
  setShortcutFrozen,
  subscribeShortcutFreeze,
} from "@/lib/shortcut-freeze";

type MenuItem =
  | {
      kind: "item";
      label: string;
      shortcut?: string;
      onClick?: () => void;
      disabled?: boolean;
    }
  | { kind: "divider" }
  // One level of nesting: a row with a ▸ that opens a flyout of plain
  // items/dividers to its right on hover (File → Open Recent).
  | { kind: "submenu"; label: string; items: MenuItem[] };

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
  // Save a new project directly under a given name (no modal) — used by
  // the file-name dropdown's Save on a fresh, unsaved project.
  onSaveAsNamed: (name: string) => Promise<void> | void;
  onSaveIncremental: () => void;
  canSaveIncremental: boolean;
  // Opens the cloud project browser (the "Projects…" item).
  onOpenLoad: () => void;
  // Opens the Assets view in the parameter panel (the "Assets" item).
  onOpenAssets: () => void;
  // Opens the OS file picker to load a local .toolbox file ("Load…").
  onOpenProjectFile: () => void;
  // File → Open Recent (spec 073026_open-recent.md): the merged
  // recency-sorted list (cloud + local), the open fan-out, and Clear Menu.
  recentProjects: RecentProjectEntry[];
  onOpenRecent: (entry: RecentProjectEntry) => void;
  onClearRecents: () => void;
  // Downloads the current project as a self-contained .toolbox file.
  onSaveToFile: () => void;
  // Project resolution — surfaced in the file-name dropdown so it can be
  // changed without opening Project Settings.
  canvasRes: [number, number];
  onCanvasResChange: (res: [number, number]) => void;
  // File-name pill (absolutely centered). Undefined disables rendering.
  projectName: string;
  projectId: string | null;
  saveState: SaveState;
  isPublic: boolean;
  // Public URL slug for the current project. When non-null and
  // isPublic is true, the file-name pill exposes a "Copy editor
  // link" button that hands out /p/<slug>.
  publicSlug: string | null;
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
  // True when the node editor shows root scope — the Node menu then
  // offers only the Layer entry (strict root).
  atRoot?: boolean;
  // Window-menu state + actions. `fullCanvas` reflects whether the
  // editor's chrome is currently hidden so the toggle row can render
  // a checkmark; the two callbacks fire from the menu items.
  fullCanvas: boolean;
  onToggleFullCanvas: () => void;
  onEnterBrowserFullscreen: () => void;
  // FPS readout — when on, an inline counter renders in the right
  // cluster (left of the docs button). Reflects overall page render
  // rate via rAF, so anything that stalls the main thread shows up.
  showFps: boolean;
  onToggleShowFps: () => void;
  // When on, every node renders its last compute() duration in ms
  // above its top-left corner. EffectNode subscribes to a
  // `node-timings` window event the parent dispatches after each
  // pipeline eval.
  showNodeTimings: boolean;
  onToggleShowNodeTimings: () => void;
  // Split-viewport mode stacks two preview canvases vertically; each
  // node's header gains a second active toggle so the user can drive
  // each viewport from a different terminal node.
  viewportSplit: boolean;
  onToggleViewportSplit: () => void;
  // Layout presets for the tiled window system
  // (072726_window-tiling.md), rendered as the Window → Layouts
  // flyout. The list is built-ins ("Default" = canvas left, nodes over
  // params on the right; "Timeline" = the AE-style arrangement)
  // followed by the user's saved presets — applying one replaces the
  // whole layout tree.
  layoutPresets: LayoutPresetEntry[];
  onApplyLayoutPreset: (id: string) => void;
  // Opens the name modal that saves the CURRENT arrangement as a new
  // preset on the user's profile.
  onNewLayoutPreset: () => void;
  // User-wide preferences (OpenAI key, etc.). Lives under the
  // Toolbox menu — application-scoped, distinct from the per-project
  // settings that live in Project Settings.
  onOpenUserPreferences: () => void;
  // Claude MCP bridge (spec 070926_claude-mcp-bridge.md): connection state
  // drives the Toolbox-menu label; the toggle connects/disconnects.
  mcpStatus: "off" | "connecting" | "pairing" | "connected";
  onToggleMcpBridge: () => void;
  // Status messages (EffectsApp's flashToast). `statusToast` is the
  // currently-flashing message (null once it times out); `consoleLog` is
  // the full history. Rendered by MessageConsole as a compact chip left
  // of the account button that opens a draggable console window.
  statusToast: string | null;
  consoleLog: ConsoleEntry[];
  // Save/load progress (EffectsApp's progressStatus — also fed by
  // node-progress events). Non-null takes over the chip: spinner +
  // label + percentage + thin fill bar.
  progressStatus: ProgressStatus | null;
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
  onSaveAsNamed,
  onSaveIncremental,
  canSaveIncremental,
  onOpenLoad,
  onOpenAssets,
  onOpenProjectFile,
  recentProjects,
  onOpenRecent,
  onClearRecents,
  onSaveToFile,
  canvasRes,
  onCanvasResChange,
  projectName,
  projectId,
  saveState,
  isPublic,
  publicSlug,
  ownedByMe,
  authorName,
  onRenameProject,
  onRequestToggleVisibility,
  findNameConflict,
  onAddNode,
  atRoot,
  fullCanvas,
  onToggleFullCanvas,
  onEnterBrowserFullscreen,
  showFps,
  onToggleShowFps,
  showNodeTimings,
  onToggleShowNodeTimings,
  viewportSplit,
  onToggleViewportSplit,
  layoutPresets,
  onApplyLayoutPreset,
  onNewLayoutPreset,
  onOpenUserPreferences,
  mcpStatus,
  onToggleMcpBridge,
  statusToast,
  consoleLog,
  progressStatus,
}: MenuBarProps) {
  const { user } = useUser();
  const signedIn = !!user;
  const [openId, setOpenId] = useState<string | null>(null);
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [changelogOpen, setChangelogOpen] = useState(false);
  const router = useRouter();
  const rootRef = useRef<HTMLDivElement>(null);
  // A single highlight rectangle that slides between menu buttons. We keep the
  // last rect when nothing is active (just fade it out) so the next hover
  // animates from where it was rather than snapping.
  const menuBtnRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const [hl, setHl] = useState<{
    left: number;
    top: number;
    width: number;
    height: number;
    visible: boolean;
  }>({ left: 0, top: 0, width: 0, height: 0, visible: false });

  useEffect(() => {
    const target = openId ?? hoverId;
    const root = rootRef.current;
    const btn = target ? menuBtnRefs.current[target] : null;
    if (!btn || !root) {
      setHl((p) => (p.visible ? { ...p, visible: false } : p));
      return;
    }
    const rb = btn.getBoundingClientRect();
    const rr = root.getBoundingClientRect();
    setHl({
      left: rb.left - rr.left,
      top: rb.top - rr.top,
      width: rb.width,
      height: rb.height,
      visible: true,
    });
  }, [openId, hoverId]);

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

  // Desktop auto-update: one state-driven slot in the Toolbox menu, right
  // under the version row (spec 070826_desktop-auto-update.md). Hidden on web
  // (no `updates` capability); native detected post-mount like `frameless`.
  const upd = useDesktopUpdates();
  const [canUpdate, setCanUpdate] = useState(false);
  useEffect(() => {
    setCanUpdate(platform.isNative && !!platform.updates);
  }, []);
  const [updateToastDismissed, setUpdateToastDismissed] = useState(false);
  const updPhase = upd.status.phase;
  useEffect(() => {
    // A new download un-dismisses the toast (progress should be visible again).
    if (updPhase === "downloading") setUpdateToastDismissed(false);
  }, [updPhase]);
  const updateItems: MenuItem[] = [];
  if (canUpdate) {
    const s = upd.status;
    switch (s.phase) {
      case "checking":
        updateItems.push({ kind: "item", label: "Checking for Updates…", disabled: true });
        break;
      case "upToDate":
        updateItems.push({ kind: "item", label: "Up to Date ✓", disabled: true });
        break;
      case "available":
        updateItems.push({
          kind: "item",
          label: `Update Toolbox to v${s.version ?? "…"}`,
          onClick: upd.download,
        });
        break;
      case "downloading":
        updateItems.push({
          kind: "item",
          label: `Downloading update… ${Math.round(s.percent)}%`,
          disabled: true,
        });
        break;
      case "ready":
        updateItems.push({ kind: "item", label: "Restart to Update", onClick: upd.install });
        break;
      default:
        updateItems.push({ kind: "item", label: "Check for Updates…", onClick: upd.check });
    }
  }

  const menus: MenuDef[] = [
    {
      id: "toolbox",
      label: "Toolbox",
      items: [
        { kind: "item", label: `Toolbox v${CURRENT_VERSION}`, disabled: true },
        ...updateItems,
        { kind: "divider" },
        {
          kind: "item",
          label: "Documentation",
          onClick: () => router.push("/docs"),
        },
        {
          kind: "item",
          label: "Changelog…",
          onClick: () => setChangelogOpen(true),
        },
        { kind: "divider" },
        {
          kind: "item",
          label: "User Preferences…",
          onClick: onOpenUserPreferences,
        },
        {
          kind: "item",
          label: "Project Settings…",
          onClick: onOpenProjectSettings,
        },
        { kind: "divider" },
        {
          kind: "item",
          label:
            mcpStatus === "connected"
              ? "● Claude Connected — Disconnect"
              : mcpStatus === "connecting"
                ? "Connecting to Claude… (Cancel)"
                : mcpStatus === "pairing"
                  ? "Cancel Claude Pairing"
                  : "Connect to Claude…",
          onClick: onToggleMcpBridge,
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
          // Opens a local .toolbox project file from disk — works offline,
          // no auth required.
          kind: "item",
          label: "Load…",
          onClick: onOpenProjectFile,
        },
        {
          // The cloud project browser. Public tab works without auth; the
          // Private tab gates itself internally.
          kind: "item",
          label: "Projects…",
          onClick: onOpenLoad,
        },
        {
          // Recently-opened cloud + local projects, newest first
          // (073026_open-recent.md). The dim right-side hint reuses the
          // shortcut slot to say where each entry lives.
          kind: "submenu",
          label: "Open Recent",
          items:
            recentProjects.length === 0
              ? [{ kind: "item", label: "No Recent Projects", disabled: true }]
              : [
                  ...recentProjects.slice(0, 10).map(
                    (r): MenuItem => ({
                      kind: "item",
                      label: r.name,
                      shortcut: r.kind === "cloud" ? "cloud" : "local",
                      onClick: () => onOpenRecent(r),
                    })
                  ),
                  { kind: "divider" },
                  { kind: "item", label: "Clear Menu", onClick: onClearRecents },
                ],
        },
        {
          // Opens the Assets view in the parameter panel — drag assets from
          // there into the node editor.
          kind: "item",
          label: "Assets",
          onClick: onOpenAssets,
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
        {
          // Self-contained download — no account needed. Always available.
          kind: "item",
          label: "Save to File…",
          onClick: onSaveToFile,
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
    {
      id: "window",
      label: "Window",
      items: [
        {
          kind: "item",
          label: fullCanvas ? "Exit Full Canvas" : "Full Canvas",
          shortcut: "F",
          onClick: onToggleFullCanvas,
        },
        {
          kind: "item",
          label: viewportSplit ? "Exit Split Viewport" : "Split Viewport",
          shortcut: "⇧S",
          onClick: onToggleViewportSplit,
        },
        {
          // Built-in presets, then the user's saved ones, then the
          // "+ New Preset…" row that captures the live arrangement.
          kind: "submenu",
          label: "Layouts",
          items: (() => {
            const builtins = layoutPresets.filter((p) => p.builtin);
            const saved = layoutPresets.filter((p) => !p.builtin);
            const row = (p: LayoutPresetEntry): MenuItem => ({
              kind: "item",
              label: p.name,
              onClick: () => onApplyLayoutPreset(p.id),
            });
            return [
              ...builtins.map(row),
              ...(saved.length > 0
                ? [{ kind: "divider" } as MenuItem, ...saved.map(row)]
                : []),
              { kind: "divider" },
              {
                kind: "item",
                label: "+ New Preset…",
                onClick: onNewLayoutPreset,
              },
            ];
          })(),
        },
        {
          kind: "item",
          label: "Enter Browser Fullscreen",
          onClick: onEnterBrowserFullscreen,
        },
        { kind: "divider" },
        {
          kind: "item",
          label: showFps ? "Hide FPS" : "Show FPS",
          onClick: onToggleShowFps,
        },
        {
          kind: "item",
          label: showNodeTimings
            ? "Hide Node Timings"
            : "Show Node Timings",
          onClick: onToggleShowNodeTimings,
        },
      ],
    },
  ];

  // Frameless desktop build: the nav bar is the title bar. Detected after mount
  // (client-only) so SSR/first-render markup matches and doesn't hydrate-mismatch.
  const [frameless, setFrameless] = useState(false);
  // Windows draws its caption buttons flush in the top-RIGHT corner; macOS keeps
  // its traffic lights on the LEFT. Detected post-mount alongside `frameless`.
  const [isWindows, setIsWindows] = useState(false);
  useEffect(() => {
    setFrameless(platform.isNative && !!platform.windowControls);
    setIsWindows(platform.isNative && platform.os === "windows");
  }, []);

  return (
    <div
      ref={rootRef}
      style={{
        // Desktop frameless build is a touch taller (no native title bar above)
        // so the centered items aren't tight against the window's top edge.
        height: BAR_HEIGHT + (frameless ? 10 : 0),
        flexShrink: 0,
        background: "var(--tb-frame)",
        display: "flex",
        // Center every item vertically so the traffic lights / avatar /
        // undo-redo line up with the menu text (they don't all self-center
        // under `stretch`). Web keeps its existing stretch behavior.
        alignItems: frameless ? "center" : "stretch",
        fontFamily: "var(--ui-font)",
        fontSize: 11,
        color: "var(--tb-n-16)",
        position: "relative",
        zIndex: 1000,
        userSelect: "none",
      }}
    >
      {/* Single sliding highlight behind the menu buttons. Position/size
          animate so it glides from one menu to the next on hover; fades out
          when none is active, keeping its last position so it slides in. */}
      <div
        style={{
          position: "absolute",
          left: hl.left,
          // Inset vertically so the pill sits with a little margin top/bottom
          // rather than filling the full button height. The top inset must be
          // half the height reduction to keep the pill vertically centered.
          top: hl.top + 2,
          width: hl.width,
          height: Math.max(0, hl.height - 4),
          background: "var(--tb-n-8)",
          borderRadius: 4,
          opacity: hl.visible ? 1 : 0,
          transition:
            "left 0.16s cubic-bezier(0.4,0,0.2,1), top 0.16s, width 0.16s, height 0.16s, opacity 0.12s",
          pointerEvents: "none",
          zIndex: 0,
        }}
      />
      {/* macOS traffic lights (desktop frameless build), left of the brand.
          Windows renders its caption buttons on the right instead (below). */}
      {frameless && !isWindows && <WindowControls />}
      {/* Inline undo/redo affordance — always visible (matches the
          desktop convention; also gives iPad/touch users a tappable
          alternative since the keyboard shortcut isn't reachable
          without a hardware keyboard). Sits between the left menus
          and the centered file-name pill, so render after the menus
          finish iterating. The actual buttons are below; this
          comment stays adjacent to keep them findable. */}
      {menus.map((m) => {
        const open = openId === m.id;
        const isBrand = m.id === "toolbox";
        // Labels sit dim until hovered/opened, so the menu bar reads
        // quietly until the user reaches for it. The brand stays bright.
        const labelColor = isBrand
          ? "var(--tb-n-16)"
          : open || hoverId === m.id
            ? "var(--tb-n-16)"
            : "var(--tb-n-10)";
        return (
          <div
            key={m.id}
            style={{
              position: "relative",
              display: "flex",
              alignItems: "center",
              zIndex: 1,
            }}
          >
            <button
              ref={(el) => {
                menuBtnRefs.current[m.id] = el;
              }}
              onMouseDown={(e) => {
                e.preventDefault();
                setOpenId(open ? null : m.id);
              }}
              onMouseEnter={() => {
                setHoverId(m.id);
                // Once a menu is open, hovering siblings swaps to that menu —
                // matches native menu-bar behavior.
                if (openId && openId !== m.id) setOpenId(m.id);
              }}
              onMouseLeave={() => setHoverId((h) => (h === m.id ? null : h))}
              style={{
                // Transparent — the shared sliding highlight (above) provides
                // the hover/open background; this keeps the pill margins/
                // padding so the highlight matches the button box.
                padding: "2px 10px",
                margin: "0 2px",
                borderRadius: 4,
                background: "transparent",
                color: labelColor,
                border: "none",
                fontFamily: "inherit",
                fontSize: "inherit",
                cursor: "default",
                fontWeight: m.id === "toolbox" ? 600 : 400,
                transition: "color 90ms",
              }}
            >
              {m.label}
            </button>
            {open &&
              (m.id === "node" ? (
                <NodeBrowserDropdown
                  onAdd={onAddNode}
                  onClose={() => setOpenId(null)}
                  atRoot={atRoot}
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
      <UndoRedoButtons
        canUndo={!!canUndo}
        canRedo={!!canRedo}
        onUndo={onUndo}
        onRedo={onRedo}
      />
      {/* Flexible gap doubles as the window drag handle on desktop. Must fill
          the full bar height — under the frameless `alignItems:center` an empty
          flex child collapses to 0px tall, leaving nothing to grab. */}
      <div
        style={{
          flex: 1,
          alignSelf: "stretch",
          WebkitAppRegion: frameless ? "drag" : undefined,
        }}
      />
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
          gap: 6,
          pointerEvents: "auto",
          WebkitAppRegion: frameless ? "no-drag" : undefined,
        }}
      >
        <FileNameMenu
          name={projectName}
          canvasRes={canvasRes}
          onCanvasResChange={onCanvasResChange}
          saveState={saveState}
          isPublic={isPublic}
          publicSlug={publicSlug}
          projectId={projectId}
          canEdit={signedIn}
          ownedByMe={ownedByMe}
          authorName={authorName}
          onRename={onRenameProject}
          onRequestToggleVisibility={onRequestToggleVisibility}
          onSave={onSave}
          onSaveAsNamed={onSaveAsNamed}
          findConflict={findNameConflict}
        />
        {process.env.NODE_ENV === "development" && <FreezePill />}
      </div>
      {/* Status readout + console (left of the FPS counter / account
          button) — the flashToast messages and save/load progress that
          used to overlay the canvas. Click opens the message-history
          console window. */}
      <MessageConsole
        toast={statusToast}
        log={consoleLog}
        progress={progressStatus}
      />
      {showFps && <FpsCounter />}
      <AccountMenu />
      {/* Windows caption buttons (desktop frameless build) — flush in the
          top-right corner, the rightmost element in the bar. */}
      {frameless && isWindows && <WindowControls />}
      <ChangelogPopover
        open={changelogOpen}
        onClose={() => setChangelogOpen(false)}
      />
      {/* Update download/ready toast (desktop auto-update). */}
      {!updateToastDismissed && (
        <UpdateToast
          status={upd.status}
          onInstall={upd.install}
          onDismiss={() => setUpdateToastDismissed(true)}
        />
      )}
    </div>
  );
}

function MenuDropdown({
  items,
  onClose,
  flyout,
}: {
  items: MenuItem[];
  onClose: () => void;
  // Submenu positioning: open to the RIGHT of the parent row instead of
  // below the menu-bar button.
  flyout?: boolean;
}) {
  // Which submenu row (by index) currently shows its flyout. Hovering any
  // plain row closes it; hovering the submenu row opens it.
  const [openSub, setOpenSub] = useState<number | null>(null);
  return (
    <div
      style={{
        position: "absolute",
        ...(flyout
          ? // -5 lines the flyout's first row up with the parent row
            // (4px padding + 1px border).
            { top: -5, left: "100%" }
          : { top: "100%", left: 0, marginTop: 2 }),
        minWidth: 200,
        background: "var(--tb-n-3)",
        border: "1px solid var(--tb-n-7)",
        borderRadius: 4,
        boxShadow: "0 6px 20px rgba(0,0,0,0.5)",
        padding: 4,
      }}
    >
      {items.map((it, i) =>
        it.kind === "divider" ? (
          <div
            key={i}
            style={{ height: 1, background: "var(--tb-n-7)", margin: "4px 0" }}
          />
        ) : it.kind === "submenu" ? (
          <SubmenuRow
            key={i}
            item={it}
            open={openSub === i}
            onOpen={() => setOpenSub(i)}
            onClose={onClose}
          />
        ) : (
          <MenuRow
            key={i}
            item={it}
            onClose={onClose}
            onHover={() => setOpenSub(null)}
          />
        )
      )}
    </div>
  );
}

// A menu row that opens a nested flyout of items to its right on hover.
// The flyout lives inside this row's relative wrapper, so crossing the
// border between row and flyout never leaves the hover tree — it only
// closes when a SIBLING row is hovered (native menu behavior).
function SubmenuRow({
  item,
  open,
  onOpen,
  onClose,
}: {
  item: Extract<MenuItem, { kind: "submenu" }>;
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
}) {
  const [hover, setHover] = useState(false);
  return (
    <div
      style={{ position: "relative" }}
      onMouseEnter={() => {
        setHover(true);
        onOpen();
      }}
      onMouseLeave={() => setHover(false)}
    >
      <button
        // Click also opens (touch users have no hover).
        onClick={onOpen}
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: 24,
          width: "100%",
          padding: "3px 10px",
          background: hover || open ? "var(--tb-a-blue-900)" : "transparent",
          border: "none",
          color: "var(--tb-n-16)",
          textAlign: "left",
          fontFamily: "inherit",
          fontSize: "inherit",
          cursor: "default",
          borderRadius: 3,
        }}
      >
        <span>{item.label}</span>
        <span style={{ color: hover || open ? "var(--tb-n-15)" : "var(--tb-n-11)", fontSize: 10 }}>
          ▸
        </span>
      </button>
      {open && <MenuDropdown items={item.items} onClose={onClose} flyout />}
    </div>
  );
}

function MenuRow({
  item,
  onClose,
  onHover,
}: {
  item: Extract<MenuItem, { kind: "item" }>;
  onClose: () => void;
  // Lets the parent dropdown close an open sibling submenu flyout.
  onHover?: () => void;
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
      onMouseEnter={() => {
        setHover(true);
        onHover?.();
      }}
      onMouseLeave={() => setHover(false)}
      style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        gap: 24,
        width: "100%",
        padding: "3px 10px",
        background: !disabled && hover ? "var(--tb-a-blue-900)" : "transparent",
        border: "none",
        color: disabled ? "var(--tb-n-10)" : "var(--tb-n-16)",
        textAlign: "left",
        fontFamily: "inherit",
        fontSize: "inherit",
        cursor: disabled ? "not-allowed" : "default",
        borderRadius: 3,
      }}
    >
      <span
        style={{
          // Recent-project names can be arbitrarily long — ellipsize
          // rather than letting one entry stretch the whole menu.
          maxWidth: 240,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {item.label}
      </span>
      {item.shortcut && (
        <span
          style={{
            color: disabled ? "var(--tb-n-9)" : hover ? "var(--tb-n-15)" : "var(--tb-n-11)",
            fontSize: 10,
          }}
        >
          {item.shortcut}
        </span>
      )}
    </button>
  );
}

// Lightweight FPS readout. Runs its own rAF loop independent of the
// pipeline so it measures BROWSER frame rate — gated by vsync and
// any main-thread blocking. If React reconciles a huge tree, MediaPipe
// stalls, or shaders take long to compile, the dt between rAF
// callbacks grows and the number drops here. Smoothing avoids the
// noisy single-frame spikes that hide the average performance.
// Dev-only pill next to the file name: toggles the global shortcut freeze
// (see lib/shortcut-freeze.ts). Never rendered in production builds — the
// NODE_ENV check at the call site compiles it out.
function FreezePill() {
  const frozen = useSyncExternalStore(
    subscribeShortcutFreeze,
    isShortcutFrozen,
    () => false,
  );
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => setShortcutFrozen(!frozen)}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      title={
        frozen
          ? "Shortcuts frozen — app keyboard shortcuts are suppressed (typing still works). Click to unfreeze."
          : "Dev: freeze app keyboard shortcuts (typing still works)"
      }
      style={{
        display: "flex",
        alignItems: "center",
        height: 16,
        padding: "0 10px",
        background: frozen ? "var(--tb-t-sky-d-0)" : hover ? "var(--tb-n-6)" : "var(--tb-n-4)",
        border: `1px solid ${
          frozen ? "#155e75" : hover ? "var(--tb-n-9)" : "var(--tb-n-7)"
        }`,
        borderRadius: 10,
        color: frozen ? "var(--tb-t-cyan-l-4)" : "var(--tb-n-13)",
        transition: "background 90ms, border-color 90ms, color 90ms",
        fontFamily: "inherit",
        fontSize: 10,
        cursor: "default",
        whiteSpace: "nowrap",
        userSelect: "none",
      }}
    >
      Freeze
    </button>
  );
}

function FpsCounter() {
  const [fps, setFps] = useState(60);
  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    // Exponential moving average of dt; alpha small enough that a
    // single bad frame doesn't tank the readout, large enough that
    // sustained drops are visible within ~half a second.
    let dtAvg = 1000 / 60;
    const alpha = 0.1;
    let lastDisplayedAt = last;
    const tick = (now: number) => {
      const dt = now - last;
      last = now;
      // Cap dt so a backgrounded tab returning doesn't flush the avg.
      const clamped = Math.min(dt, 250);
      dtAvg = dtAvg + (clamped - dtAvg) * alpha;
      // Update display state at most ~6 Hz to avoid flicker. The
      // measurement itself runs every frame.
      if (now - lastDisplayedAt >= 150) {
        lastDisplayedAt = now;
        setFps(Math.max(1, Math.round(1000 / dtAvg)));
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);
  // Color tiers tuned to common refresh rates: 55+ green, 30–55
  // yellow, below 30 red.
  const color =
    fps >= 55 ? "var(--tb-a-emerald-400)" : fps >= 30 ? "var(--tb-a-yellow-400)" : "var(--tb-a-red-500)";
  return (
    <div
      title="Frame rate (rAF) — overall page render rate"
      style={{
        height: "100%",
        display: "inline-flex",
        alignItems: "center",
        padding: "0 8px",
        fontSize: 10,
        color,
        letterSpacing: 0.3,
        fontVariantNumeric: "tabular-nums",
        userSelect: "none",
      }}
    >
      {fps} fps
    </div>
  );
}

// Inline undo/redo buttons. Visible alongside the menu bar so iPad
// and other touch users have a tappable affordance equivalent to the
// ⌘Z / ⇧⌘Z shortcuts. Disabled when the history buffer's edge has
// been reached.
function UndoRedoButtons({
  canUndo,
  canRedo,
  onUndo,
  onRedo,
}: {
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 2,
        marginLeft: 4,
      }}
    >
      <UndoRedoIconButton
        title="Undo  ⌘Z"
        disabled={!canUndo}
        onClick={onUndo}
        kind="undo"
      />
      <UndoRedoIconButton
        title="Redo  ⇧⌘Z"
        disabled={!canRedo}
        onClick={onRedo}
        kind="redo"
      />
    </div>
  );
}

function UndoRedoIconButton({
  title,
  disabled,
  onClick,
  kind,
}: {
  title: string;
  disabled: boolean;
  onClick: () => void;
  kind: "undo" | "redo";
}) {
  // Minimal curved-arrow glyph drawn in SVG. The redo variant is the
  // same path mirrored on X — keeps both icons visually identical
  // weight without two separate drawings.
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      style={{
        width: 22,
        height: 16,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "transparent",
        border: "none",
        cursor: disabled ? "default" : "pointer",
        opacity: disabled ? 0.35 : 1,
        padding: 0,
        color: "inherit",
      }}
    >
      <svg
        width={14}
        height={14}
        viewBox="0 0 14 14"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.4}
        strokeLinecap="round"
        strokeLinejoin="round"
        // Mirror the redo glyph so the arc bends in the opposite
        // direction without a second SVG.
        style={{ transform: kind === "redo" ? "scaleX(-1)" : undefined }}
      >
        <path d="M3 6 L1.5 4.5 L3 3" />
        <path d="M1.5 4.5 L8 4.5 A3.5 3.5 0 0 1 11.5 8 L11.5 11" />
      </svg>
    </button>
  );
}
