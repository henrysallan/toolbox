"use client";

// The Assets panel (specdocs/090326_asset-library.md §4). One component,
// three mounts: the "assets" panel kind (with a kind chip), the parameter
// panel via File → Assets, and the Project view's Comps/Assets pill.
//
// Two libraries, picked by the header's selector menu (which also holds
// Upload Asset… / Refresh):
//   - Project (the default): the open project's own library,
//     state/project-library.ts — empty in a new project, saved with it.
//   - Server: the user's project-agnostic library — images / SVGs /
//     videos from state/user-assets.ts plus node presets from
//     state/node-presets.ts.
// Either shows as one card grid (or a row list — the header's grid/list
// toggle, remembered per browser). Cards drag into the node editor
// (`application/x-toolbox-asset` — NodeEditor's drop handler forwards any
// payload with a `ref`), double-click to insert at the last pointer
// position, right-click for Layer From Asset (a new layer holding it, wired
// up) / Rename / Replace Thumbnail / Copy to the other library / Delete. OS files dropped anywhere on the panel upload into the
// library on show.
//
// Under Project, the June sections (archive/062926_assets.md) stay as they
// were: "In project" (bundled fonts) and "Folder" (an external assets/
// folder).
//
// The panel reads the stores directly — the three mounts need no plumbing
// beyond `onInsert` (graph access lives in EffectsApp) and `onToast`.

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useUser } from "@/lib/auth-context";
import { useEntitlements } from "@/lib/entitlements";
import { fuzzyScore } from "@/lib/fuzzy-search";
import { userAssetThumbUrl } from "@/lib/supabase/user-assets";
import {
  encodeStorageThumb,
  encodeThumbDataUrlWithinCap,
  normalizeThumbnailFile,
} from "@/lib/asset-thumbnails";
import {
  copyProjectAssetToServer,
  copyServerAssetToProject,
  copyServerPresetToProject,
  importFilesToLibrary,
  type LibraryAddResult,
  type LibraryTarget,
} from "@/lib/asset-import";
import {
  deleteAsset,
  loadUserAssets,
  renameAsset,
  replaceAssetThumbnail,
  useUserAssets,
  type UserAssetRow,
} from "@/state/user-assets";
import {
  getUserNodePreset,
  removeUserNodePreset,
  renameUserNodePreset,
  setUserNodePresetThumbnail,
  useUserNodePresets,
  type UserNodePreset,
} from "@/state/node-presets";
import {
  getProjectAsset,
  removeProjectAsset,
  renameProjectAsset,
  setProjectAssetThumb,
  useProjectLibrary,
  type ProjectAsset,
} from "@/state/project-library";
import { MenuDropdown, type MenuItem } from "./MenuBar";
import PresetNameModal from "./PresetNameModal";
import { Spinner } from "./Spinner";
import { usePanelWindow } from "./layout/panel-window";

// --- legacy (project-scoped) items -------------------------------------------

export type AssetKind = "font" | "image" | "video" | "audio" | "svg" | "other";

export interface AssetItem {
  id: string;
  name: string;
  kind: AssetKind;
  source: "bundled" | "folder";
  // Opaque handle for resolving bytes on drop: a font's synthetic family, or a
  // folder file's read-ref. Encoded into the drag payload.
  ref: string;
  thumbnail?: string;
}

// --- drag payload ---------------------------------------------------------------

export const ASSET_DRAG_MIME = "application/x-toolbox-asset";

/**
 * What a card puts on the drag (and hands to onInsert). `ref` is the
 * library row id / preset id / font family / folder read-ref by source.
 */
export interface AssetDragPayload {
  source: "bundled" | "folder" | "library" | "preset" | "project";
  kind: string;
  ref: string;
  name: string;
}

// --- props ------------------------------------------------------------------------

interface AssetsViewProps {
  assets?: AssetItem[];
  folderName?: string | null;
  // Web: pick an assets folder (File System Access API). Absent ⇒ no picker
  // (desktop auto-scans; or not yet wired).
  onPickFolder?: () => void;
  /** The panel-kind chip when mounted as a layout panel. */
  kindMenu?: React.ReactNode;
  /** Double-click a card → insert at the last pointer position. */
  onInsert?: (payload: AssetDragPayload) => void;
  /** Card menu → Layer From Asset: a new layer holding it, wired up. */
  onInsertAsLayer?: (payload: AssetDragPayload) => void;
  onToast?: (message: string) => void;
}

// --- library items --------------------------------------------------------------

type LibraryKind = "image" | "svg" | "video" | "preset";
type Filter = "all" | LibraryKind;

const FILTERS: { id: Filter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "image", label: "Images" },
  { id: "svg", label: "SVG" },
  { id: "video", label: "Video" },
  { id: "preset", label: "Presets" },
];

const KIND_LABEL: Record<LibraryKind, string> = {
  image: "img",
  svg: "svg",
  video: "vid",
  preset: "preset",
};

// Grid (thumbnail cards) or list (one row per item). Remembered per browser
// — a convenience: the default is "grid" when storage is unavailable.
type ViewMode = "grid" | "list";
const VIEW_MODE_STORAGE_KEY = "toolbox.assets.view";

function readViewMode(): ViewMode {
  try {
    return window.localStorage.getItem(VIEW_MODE_STORAGE_KEY) === "list"
      ? "list"
      : "grid";
  } catch {
    return "grid";
  }
}

function writeViewMode(v: ViewMode) {
  try {
    window.localStorage.setItem(VIEW_MODE_STORAGE_KEY, v);
  } catch {
    // storage blocked — the toggle still works for this mount
  }
}

interface LibraryItem {
  id: string;
  kind: LibraryKind;
  name: string;
  thumb: string | null;
  meta: string;
  payload: AssetDragPayload;
}

function fmtDuration(s: number): string {
  if (s >= 60) {
    const m = Math.floor(s / 60);
    const r = Math.round(s - m * 60);
    return `${m}:${String(r).padStart(2, "0")}`;
  }
  return `${s.toFixed(1)} s`;
}

function itemFromRow(r: UserAssetRow): LibraryItem {
  let meta = KIND_LABEL[r.kind];
  if (r.kind === "video" && r.duration) meta = fmtDuration(r.duration);
  else if (r.kind === "image" && r.width && r.height)
    meta = `${r.width}×${r.height}`;
  return {
    id: `lib:${r.id}`,
    kind: r.kind,
    name: r.name,
    thumb: userAssetThumbUrl(r),
    meta,
    payload: { source: "library", kind: r.kind, ref: r.id, name: r.name },
  };
}

function itemFromPreset(p: UserNodePreset): LibraryItem {
  const n = p.fragment.nodes.length;
  return {
    id: `preset:${p.id}`,
    kind: "preset",
    name: p.name,
    thumb: p.thumbnail ?? null,
    meta: `${n} node${n === 1 ? "" : "s"}`,
    payload: { source: "preset", kind: "preset", ref: p.id, name: p.name },
  };
}

function itemFromProject(a: ProjectAsset): LibraryItem {
  let meta: string = KIND_LABEL[a.kind];
  if (a.kind === "video" && a.duration) meta = fmtDuration(a.duration);
  else if (a.kind === "image" && a.width && a.height)
    meta = `${a.width}×${a.height}`;
  else if (a.kind === "preset" && a.fragment) {
    const n = a.fragment.nodes.length;
    meta = `${n} node${n === 1 ? "" : "s"}`;
  }
  return {
    id: `project:${a.id}`,
    kind: a.kind,
    name: a.name,
    thumb: a.thumb,
    meta,
    payload: { source: "project", kind: a.kind, ref: a.id, name: a.name },
  };
}

const LIBRARY_LABEL: Record<LibraryTarget, string> = {
  project: "Project",
  server: "Server",
};

function itemFromLegacy(a: AssetItem): LibraryItem {
  return {
    id: a.id,
    kind: a.kind === "svg" ? "svg" : a.kind === "video" ? "video" : "image",
    name: a.name,
    thumb: a.thumbnail ?? null,
    meta: a.kind,
    payload: { source: a.source, kind: a.kind, ref: a.ref, name: a.name },
  };
}

// --- component -------------------------------------------------------------------

export function AssetsView({
  assets = [],
  folderName,
  onPickFolder,
  kindMenu,
  onInsert,
  onInsertAsLayer,
  onToast,
}: AssetsViewProps) {
  const toast = useCallback(
    (m: string) => {
      if (onToast) onToast(m);
      else console.warn("[assets]", m);
    },
    [onToast]
  );
  const { user } = useUser();
  const { entitlements } = useEntitlements();
  const library = useUserAssets();
  const presets = useUserNodePresets();
  const projectLib = useProjectLibrary();
  // Which library the panel shows — Project unless the user picks Server.
  const [target, setTarget] = useState<LibraryTarget>("project");

  // A cold mount (e.g. the panel opened before EffectsApp's identity
  // effect ran) kicks the first load; later mounts reuse the store.
  useEffect(() => {
    if (library.status === "idle") void loadUserAssets();
  }, [library.status]);

  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [view, setView] = useState<ViewMode>(readViewMode);
  const changeView = useCallback((v: ViewMode) => {
    setView(v);
    writeViewMode(v);
  }, []);
  const [menuOpen, setMenuOpen] = useState(false);
  const [cardMenu, setCardMenu] = useState<{
    x: number;
    y: number;
    item: LibraryItem;
  } | null>(null);
  const [renaming, setRenaming] = useState<LibraryItem | null>(null);
  const [dropHover, setDropHover] = useState(false);
  const menuWrapRef = useRef<HTMLDivElement | null>(null);
  const uploadInputRef = useRef<HTMLInputElement | null>(null);
  const thumbInputRef = useRef<HTMLInputElement | null>(null);
  const thumbTargetRef = useRef<LibraryItem | null>(null);
  const panelWin = usePanelWindow();

  // Close the Assets ▾ menu on any press outside it (capture, so the
  // press that lands on a card never has to know about the menu).
  useEffect(() => {
    if (!menuOpen) return;
    const win = panelWin ?? window;
    const onDown = (e: MouseEvent) => {
      if (menuWrapRef.current?.contains(e.target as globalThis.Node)) return;
      setMenuOpen(false);
    };
    win.addEventListener("mousedown", onDown, true);
    return () => win.removeEventListener("mousedown", onDown, true);
  }, [menuOpen, panelWin]);

  const items = useMemo(() => {
    const media =
      target === "project"
        ? projectLib.filter((a) => a.kind !== "preset").map(itemFromProject)
        : library.rows.map(itemFromRow); // newest first (query order)
    const pres =
      target === "project"
        ? projectLib.filter((a) => a.kind === "preset").map(itemFromProject)
        : presets.slice().reverse().map(itemFromPreset); // newest last in store
    let list: LibraryItem[] =
      filter === "all"
        ? [...media, ...pres]
        : filter === "preset"
          ? pres
          : media.filter((i) => i.kind === filter);
    const q = query.trim();
    if (q) {
      list = list
        .map((i) => ({ i, s: fuzzyScore(q, i.name) }))
        .filter((x): x is { i: LibraryItem; s: number } => x.s !== null)
        .sort((a, b) => b.s - a.s)
        .map((x) => x.i);
    }
    return list;
  }, [target, projectLib, library.rows, presets, filter, query]);

  // --- uploads ------------------------------------------------------------------

  const importFiles = useCallback(
    async (files: File[]) => {
      if (files.length === 0) return;
      if (target === "server" && !user)
        return toast("Sign in to use your server asset library.");
      const results = await importFilesToLibrary(files, {
        cloudMedia: entitlements.cloudMedia,
        target,
      });
      const where = target === "project" ? "project assets" : "server assets";
      const failed = results.filter((r) => !r.result.ok);
      const dups = results.filter((r) => r.result.ok && r.result.duplicate);
      const added = results.length - failed.length - dups.length;
      if (failed.length) {
        const first = failed[0].result as { ok: false; error: string };
        toast(
          failed.length === 1
            ? first.error
            : `${failed.length} files failed — ${first.error}`
        );
      } else if (added === 0 && dups.length) {
        toast(
          dups.length === 1
            ? `"${dups[0].result.ok ? dups[0].result.name : ""}" is already in your ${where}`
            : `${dups.length} files were already in your ${where}`
        );
      } else {
        toast(
          `added ${added} asset${added === 1 ? "" : "s"} to ${where}` +
            (dups.length ? ` (${dups.length} already there)` : "")
        );
      }
    },
    [user, entitlements.cloudMedia, toast, target]
  );

  // The selector: the two libraries (✓ on the one showing), then the
  // actions for it.
  const canUpload = target === "project" || !!user;
  const menuItems: MenuItem[] = [
    ...(["project", "server"] as const).map(
      (t): MenuItem => ({
        kind: "item",
        label: LIBRARY_LABEL[t],
        shortcut: target === t ? "✓" : undefined,
        title:
          t === "project"
            ? "Assets saved with this project"
            : "Your library across every project",
        onClick: () => setTarget(t),
      })
    ),
    { kind: "divider" },
    {
      kind: "item",
      label: "Upload Asset…",
      disabled: !canUpload,
      title: canUpload
        ? (entitlements.cloudMedia
            ? "Images, SVGs, and videos"
            : "Images and SVGs (video assets need cloud media)") +
          (target === "project" ? " — saved with this project" : "")
        : "Sign in to use your server asset library",
      onClick: () => uploadInputRef.current?.click(),
    },
    ...(target === "server"
      ? ([
          {
            kind: "item",
            label: "Refresh",
            onClick: () => void loadUserAssets(),
          },
        ] as MenuItem[])
      : []),
  ];

  // --- card actions ------------------------------------------------------------------

  const startReplaceThumb = useCallback((item: LibraryItem) => {
    thumbTargetRef.current = item;
    thumbInputRef.current?.click();
  }, []);

  const onThumbFile = useCallback(
    async (file: File | undefined) => {
      const item = thumbTargetRef.current;
      thumbTargetRef.current = null;
      if (!file || !item) return;
      const canvas = await normalizeThumbnailFile(file);
      if (!canvas) return toast("Couldn't read that image.");
      if (item.payload.source === "project") {
        const url = encodeThumbDataUrlWithinCap(canvas, "jpeg");
        if (!url) return toast("Thumbnail is too large.");
        setProjectAssetThumb(item.payload.ref, url);
        toast(`updated thumbnail for "${item.name}"`);
        return;
      }
      if (item.kind === "preset") {
        const url = encodeThumbDataUrlWithinCap(canvas, "jpeg");
        if (!url) return toast("Thumbnail is too large.");
        setUserNodePresetThumbnail(item.payload.ref, url);
        toast(`updated thumbnail for "${item.name}"`);
        return;
      }
      const blob = await encodeStorageThumb(canvas);
      if (!blob) return toast("Couldn't encode the thumbnail.");
      const res = await replaceAssetThumbnail(item.payload.ref, blob);
      toast(res.ok ? `updated thumbnail for "${item.name}"` : (res.error ?? "Thumbnail update failed."));
    },
    [toast]
  );

  const deleteItem = useCallback(
    async (item: LibraryItem) => {
      if (item.payload.source === "project") {
        removeProjectAsset(item.payload.ref);
        toast(`removed "${item.name}" from project assets`);
        return;
      }
      if (item.kind === "preset") {
        removeUserNodePreset(item.payload.ref);
        toast(`deleted preset "${item.name}"`);
        return;
      }
      const res = await deleteAsset(item.payload.ref);
      toast(res.ok ? `deleted "${item.name}"` : (res.error ?? "Delete failed."));
    },
    [toast]
  );

  // Copy to the other library (a copy — the source card stays).
  const copyItem = useCallback(
    async (item: LibraryItem) => {
      const { source, ref } = item.payload;
      let res: LibraryAddResult;
      try {
        if (source === "project") {
          const a = getProjectAsset(ref);
          if (!a) return;
          if (!user) return toast("Sign in to use your server asset library.");
          res = await copyProjectAssetToServer(a);
        } else if (source === "preset") {
          const p = getUserNodePreset(ref);
          if (!p) return;
          res = copyServerPresetToProject(p);
        } else {
          const row = library.rows.find((r) => r.id === ref);
          if (!row) return;
          res = await copyServerAssetToProject(row);
        }
      } catch (err) {
        return toast(err instanceof Error ? err.message : "Copy failed.");
      }
      const where = source === "project" ? "server assets" : "project assets";
      if (!res.ok) toast(res.error);
      else
        toast(
          res.duplicate
            ? `"${res.name}" is already in ${where}`
            : `copied "${res.name}" to ${where}`
        );
    },
    [user, library.rows, toast]
  );

  const cardMenuItems: { label: string; onClick: () => void }[] = cardMenu
    ? [
        ...(onInsertAsLayer
          ? [
              {
                label: "Layer From Asset",
                onClick: () => onInsertAsLayer(cardMenu.item.payload),
              },
            ]
          : []),
        { label: "Rename…", onClick: () => setRenaming(cardMenu.item) },
        {
          label: "Replace Thumbnail…",
          onClick: () => startReplaceThumb(cardMenu.item),
        },
        {
          label:
            cardMenu.item.payload.source === "project"
              ? "Copy to Server"
              : "Copy to Project",
          onClick: () => void copyItem(cardMenu.item),
        },
        { label: "Delete", onClick: () => void deleteItem(cardMenu.item) },
      ]
    : [];

  // --- states --------------------------------------------------------------------------

  const onServer = target === "server";
  const signedOut = !user;
  const loading =
    onServer && library.status === "loading" && library.rows.length === 0;
  const hasAnyLibrary = onServer
    ? library.rows.length > 0 || presets.length > 0
    : projectLib.length > 0;

  const chip = (active: boolean): React.CSSProperties => ({
    padding: "1px 7px",
    fontSize: 10,
    borderRadius: 3,
    border: "1px solid var(--tb-border)",
    background: active ? "var(--tb-a-blue-500)" : "var(--tb-n-2)",
    color: active ? "var(--tb-n-0)" : "var(--tb-ink)",
    cursor: "pointer",
    flexShrink: 0,
  });

  return (
    <div
      style={{
        height: "100%",
        minHeight: 0,
        display: "flex",
        flexDirection: "column",
        background: "var(--tb-n-0)",
        color: "var(--tb-n-16)",
        fontFamily: "var(--ui-font)",
        fontSize: 11,
        position: "relative",
        outline: dropHover ? "2px solid var(--tb-a-blue-500)" : "none",
        outlineOffset: -2,
      }}
      onDragOver={(e) => {
        // Only OS file drags — our own card drags carry no Files entry.
        if (!e.dataTransfer.types.includes("Files")) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
        if (!dropHover) setDropHover(true);
      }}
      onDragLeave={(e) => {
        if (e.currentTarget.contains(e.relatedTarget as globalThis.Node | null))
          return;
        setDropHover(false);
      }}
      onDrop={(e) => {
        if (!e.dataTransfer.types.includes("Files")) return;
        e.preventDefault();
        setDropHover(false);
        void importFiles(Array.from(e.dataTransfer.files));
      }}
    >
      {/* header — the kind chip rides inline, PerfPanel-style */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          flexWrap: "wrap",
          gap: 6,
          padding: "4px 6px",
          borderBottom: "1px solid var(--tb-border)",
          flex: "0 0 auto",
          minWidth: 0,
          position: "relative",
          zIndex: 5,
        }}
      >
        {kindMenu}
        <div ref={menuWrapRef} style={{ position: "relative", flexShrink: 0 }}>
          <button
            type="button"
            onMouseDown={(e) => {
              e.preventDefault();
              setMenuOpen((o) => !o);
            }}
            style={{
              ...chip(menuOpen),
              display: "flex",
              alignItems: "center",
              gap: 4,
            }}
          >
            {LIBRARY_LABEL[target]}
            <span style={{ fontSize: 8, opacity: 0.8 }}>▾</span>
          </button>
          {menuOpen && (
            <MenuDropdown items={menuItems} onClose={() => setMenuOpen(false)} />
          )}
        </div>
        <div style={{ display: "flex", gap: 2, flexShrink: 0 }}>
          {FILTERS.map((f) => (
            <button
              key={f.id}
              type="button"
              onClick={() => setFilter(f.id)}
              style={chip(filter === f.id)}
            >
              {f.label}
            </button>
          ))}
        </div>
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search…"
          spellCheck={false}
          style={{
            flex: "1 1 80px",
            minWidth: 60,
            maxWidth: 200,
            background: "var(--tb-n-2)",
            color: "var(--tb-ink)",
            border: "1px solid var(--tb-border)",
            borderRadius: 3,
            fontSize: 10,
            padding: "1px 5px",
            fontFamily: "inherit",
          }}
        />
        <span style={{ fontSize: 9, color: "var(--tb-n-10)", flexShrink: 0 }}>
          {items.length}
        </span>
        {library.busy > 0 && <Spinner size={12} />}
        <div style={{ display: "flex", gap: 2, flexShrink: 0, marginLeft: "auto" }}>
          {(["grid", "list"] as const).map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => changeView(v)}
              title={v === "grid" ? "Grid view" : "List view"}
              aria-label={v === "grid" ? "Grid view" : "List view"}
              aria-pressed={view === v}
              style={{
                ...chip(view === v),
                padding: "2px 4px",
                display: "flex",
                alignItems: "center",
              }}
            >
              <ViewGlyph mode={v} />
            </button>
          ))}
        </div>
        <input
          ref={uploadInputRef}
          type="file"
          multiple
          accept="image/*,.svg,image/svg+xml,video/*,.exr"
          style={{ display: "none" }}
          onChange={(e) => {
            const files = Array.from(e.target.files ?? []);
            e.target.value = "";
            void importFiles(files);
          }}
        />
        <input
          ref={thumbInputRef}
          type="file"
          accept="image/*"
          style={{ display: "none" }}
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = "";
            void onThumbFile(f);
          }}
        />
      </div>

      <div style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
        {/* library */}
        <div style={{ padding: "8px 10px" }}>
          {onServer && signedOut && (
            <Hint>
              Sign in to keep images, SVGs, and videos in a library you can
              drag into any project.
              {presets.length > 0 ? " Your node presets are listed below." : ""}
            </Hint>
          )}
          {onServer && !signedOut && library.status === "error" && (
            <Hint>
              Couldn&apos;t load your assets — {library.error}.{" "}
              <button
                type="button"
                onClick={() => void loadUserAssets()}
                style={{ ...chip(false), fontSize: 9 }}
              >
                Retry
              </button>
            </Hint>
          )}
          {loading && !signedOut && (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                color: "var(--tb-n-10)",
                fontSize: 10,
                padding: "6px 2px",
              }}
            >
              <Spinner size={12} /> loading assets…
            </div>
          )}
          {onServer && !loading && !hasAnyLibrary && !signedOut && library.status === "ready" && (
            <Hint>
              Nothing here yet. Use <b>Server ▸ Upload Asset…</b>, drop files
              on this panel, or right-click a node → <b>Add to Assets ▸
              Server</b>. Node presets you save land here too.
            </Hint>
          )}
          {!onServer && !hasAnyLibrary && (
            <Hint>
              This project&apos;s library is empty. Use <b>Project ▸ Upload
              Asset…</b>, drop files on this panel, right-click a node →{" "}
              <b>Add to Assets ▸ Project</b>, or copy cards over from{" "}
              <b>Server</b>. Everything here is saved with the project.
            </Hint>
          )}
          {items.length === 0 && hasAnyLibrary && (query || filter !== "all") && (
            <Hint>No matches.</Hint>
          )}
          {items.length > 0 && (
            <ItemCollection
              items={items}
              view={view}
              onInsert={onInsert}
              onContextMenu={(e, it) => {
                e.preventDefault();
                setCardMenu({ x: e.clientX, y: e.clientY, item: it });
              }}
            />
          )}
        </div>

        {/* project-scoped sections (062926_assets.md) — Project only */}
        {!onServer && (
          <>
            <AssetSection
              title="In project"
              hint="Custom fonts you add are bundled with the project and appear here."
              items={assets
                .filter((a) => a.source === "bundled")
                .map(itemFromLegacy)}
              view={view}
              onInsert={onInsert}
            />
            <AssetSection
              title={folderName ? `Folder · ${folderName}` : "Folder"}
              hint={
                onPickFolder
                  ? "Choose a folder of assets to reference alongside this project."
                  : "Open a .toolbox that sits next to an assets/ folder to see its files here."
              }
              items={assets
                .filter((a) => a.source === "folder")
                .map(itemFromLegacy)}
              view={view}
              onInsert={onInsert}
              action={
                onPickFolder
                  ? { label: "Choose folder…", onClick: onPickFolder }
                  : undefined
              }
            />
          </>
        )}
      </div>

      {cardMenu && (
        <CardMenu
          x={cardMenu.x}
          y={cardMenu.y}
          items={cardMenuItems}
          onClose={() => setCardMenu(null)}
        />
      )}
      {renaming && (
        <PresetNameModal
          title={renaming.kind === "preset" ? "Rename preset" : "Rename asset"}
          description={
            renaming.kind === "preset"
              ? "Changes the name shown in the add menus and the Assets panel."
              : "Changes the name shown in the Assets panel."
          }
          initialName={renaming.name}
          existingNames={[]}
          saveLabel="Rename"
          onClose={() => setRenaming(null)}
          onSave={async (name) => {
            if (renaming.payload.source === "project") {
              if (!renameProjectAsset(renaming.payload.ref, name))
                throw new Error("A preset with that name already exists.");
              return;
            }
            if (renaming.kind === "preset") {
              if (!renameUserNodePreset(renaming.payload.ref, name))
                throw new Error("A preset with that name already exists.");
              return;
            }
            const res = await renameAsset(renaming.payload.ref, name);
            if (!res.ok) throw new Error(res.error ?? "Rename failed.");
          }}
        />
      )}
    </div>
  );
}

// --- pieces ----------------------------------------------------------------------

function Hint({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        fontSize: 10,
        color: "var(--tb-n-10)",
        padding: "6px 2px",
        lineHeight: 1.5,
      }}
    >
      {children}
    </div>
  );
}

function AssetSection({
  title,
  hint,
  items,
  view,
  action,
  onInsert,
}: {
  title: string;
  hint: string;
  items: LibraryItem[];
  view: ViewMode;
  action?: { label: string; onClick: () => void };
  onInsert?: (payload: AssetDragPayload) => void;
}) {
  return (
    <div style={{ padding: "8px 10px", borderTop: "1px solid var(--tb-n-3)" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          marginBottom: 6,
        }}
      >
        <span
          style={{
            fontSize: 9,
            letterSpacing: 0.5,
            textTransform: "uppercase",
            color: "var(--tb-n-11)",
          }}
        >
          {title}
        </span>
        <span style={{ fontSize: 9, color: "var(--tb-n-9)" }}>{items.length}</span>
        <div style={{ flex: 1 }} />
        {action && (
          <button
            type="button"
            onClick={action.onClick}
            style={{
              fontSize: 10,
              color: "var(--tb-n-15)",
              background: "var(--tb-n-3)",
              border: "1px solid var(--tb-n-7)",
              borderRadius: 5,
              padding: "3px 8px",
              cursor: "pointer",
            }}
          >
            {action.label}
          </button>
        )}
      </div>
      {items.length === 0 ? (
        <Hint>{hint}</Hint>
      ) : (
        <ItemCollection items={items} view={view} onInsert={onInsert} />
      )}
    </div>
  );
}

// The items of one section, as a card grid or a row list. Both carry the
// same drag payload / double-click / right-click behavior.
function ItemCollection({
  items,
  view,
  onInsert,
  onContextMenu,
}: {
  items: LibraryItem[];
  view: ViewMode;
  onInsert?: (payload: AssetDragPayload) => void;
  onContextMenu?: (e: React.MouseEvent, item: LibraryItem) => void;
}) {
  const Item = view === "list" ? Row : Card;
  return (
    <div
      style={
        view === "list"
          ? { display: "flex", flexDirection: "column", gap: 1 }
          : {
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(96px, 1fr))",
              gap: 6,
            }
      }
    >
      {items.map((it) => (
        <Item
          key={it.id}
          item={it}
          onDoubleClick={onInsert ? () => onInsert(it.payload) : undefined}
          onContextMenu={onContextMenu ? (e) => onContextMenu(e, it) : undefined}
        />
      ))}
    </div>
  );
}

interface ItemProps {
  item: LibraryItem;
  onDoubleClick?: () => void;
  onContextMenu?: (e: React.MouseEvent) => void;
}

// The drag source both views share.
function dragProps(item: LibraryItem, onDoubleClick?: () => void) {
  return {
    title: `${item.name} — drag into the node editor${onDoubleClick ? ", or double-click to insert" : ""}`,
    draggable: true,
    onDragStart: (e: React.DragEvent) => {
      e.dataTransfer.effectAllowed = "copy";
      e.dataTransfer.setData(ASSET_DRAG_MIME, JSON.stringify(item.payload));
    },
  };
}

function Row({ item, onDoubleClick, onContextMenu }: ItemProps) {
  const [hover, setHover] = useState(false);
  return (
    <div
      {...dragProps(item, onDoubleClick)}
      onDoubleClick={onDoubleClick}
      onContextMenu={onContextMenu}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 7,
        padding: "2px 4px",
        borderRadius: 3,
        background: hover ? "var(--tb-n-2)" : "transparent",
        cursor: "grab",
        userSelect: "none",
        minWidth: 0,
      }}
    >
      <div
        style={{
          width: 24,
          height: 24,
          flexShrink: 0,
          borderRadius: 3,
          border: "1px solid var(--tb-n-5)",
          background: "var(--tb-n-1)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          overflow: "hidden",
          color: "var(--tb-n-10)",
        }}
      >
        {item.thumb ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={item.thumb}
            alt=""
            draggable={false}
            style={{
              width: "100%",
              height: "100%",
              objectFit: "contain",
              pointerEvents: "none",
            }}
          />
        ) : (
          <KindGlyph kind={item.kind} size={14} />
        )}
      </div>
      <div
        style={{
          flex: 1,
          minWidth: 0,
          fontSize: 10,
          color: "var(--tb-n-13)",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {item.name}
      </div>
      <span
        style={{
          fontSize: 9,
          color: "var(--tb-n-9)",
          flexShrink: 0,
          whiteSpace: "nowrap",
        }}
      >
        {item.meta}
      </span>
      <span
        style={{
          fontSize: 8,
          padding: "1px 4px",
          borderRadius: 3,
          background: "var(--tb-n-3)",
          color: "var(--tb-n-12)",
          letterSpacing: 0.4,
          textTransform: "uppercase",
          flexShrink: 0,
          minWidth: 30,
          textAlign: "center",
        }}
      >
        {KIND_LABEL[item.kind]}
      </span>
    </div>
  );
}

function Card({ item, onDoubleClick, onContextMenu }: ItemProps) {
  const [hover, setHover] = useState(false);
  return (
    <div
      {...dragProps(item, onDoubleClick)}
      onDoubleClick={onDoubleClick}
      onContextMenu={onContextMenu}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: "flex",
        flexDirection: "column",
        borderRadius: 5,
        border: `1px solid ${hover ? "var(--tb-n-9)" : "var(--tb-n-5)"}`,
        background: "var(--tb-n-1)",
        overflow: "hidden",
        cursor: "grab",
        userSelect: "none",
      }}
    >
      <div
        style={{
          aspectRatio: "1",
          background: "var(--tb-n-0)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          position: "relative",
          color: "var(--tb-n-10)",
          fontSize: 9,
          textTransform: "uppercase",
          letterSpacing: 0.5,
        }}
      >
        {item.thumb ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={item.thumb}
            alt=""
            draggable={false}
            style={{
              width: "100%",
              height: "100%",
              objectFit: "contain",
              pointerEvents: "none",
            }}
          />
        ) : (
          <KindGlyph kind={item.kind} />
        )}
        <span
          style={{
            position: "absolute",
            right: 3,
            bottom: 3,
            fontSize: 8,
            padding: "1px 4px",
            borderRadius: 3,
            background: "rgba(0,0,0,0.55)",
            color: "var(--tb-n-14)",
            letterSpacing: 0.4,
          }}
        >
          {KIND_LABEL[item.kind]}
        </span>
      </div>
      <div
        style={{
          fontSize: 9,
          color: "var(--tb-n-13)",
          padding: "3px 5px 0",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {item.name}
      </div>
      <div
        style={{
          fontSize: 8,
          color: "var(--tb-n-9)",
          padding: "0 5px 3px",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {item.meta}
      </div>
    </div>
  );
}

function ViewGlyph({ mode }: { mode: ViewMode }) {
  const common = { fill: "none", stroke: "currentColor", strokeWidth: 1 } as const;
  if (mode === "grid") {
    return (
      <svg width={10} height={10} viewBox="0 0 10 10" aria-hidden>
        <rect x={0.5} y={0.5} width={3.5} height={3.5} {...common} />
        <rect x={6} y={0.5} width={3.5} height={3.5} {...common} />
        <rect x={0.5} y={6} width={3.5} height={3.5} {...common} />
        <rect x={6} y={6} width={3.5} height={3.5} {...common} />
      </svg>
    );
  }
  return (
    <svg width={10} height={10} viewBox="0 0 10 10" aria-hidden>
      <path d="M0.5 1.5h9M0.5 5h9M0.5 8.5h9" {...common} />
    </svg>
  );
}

function KindGlyph({ kind, size = 28 }: { kind: LibraryKind; size?: number }) {
  const common = { fill: "none", stroke: "currentColor", strokeWidth: 1.2 } as const;
  if (kind === "preset") {
    return (
      <svg width={size} height={size} viewBox="0 0 12 12" aria-hidden>
        <rect x={1} y={1.5} width={4} height={3} rx={0.8} {...common} />
        <rect x={7} y={7.5} width={4} height={3} rx={0.8} {...common} />
        <path d="M5 3h2.5v6H7" {...common} />
      </svg>
    );
  }
  if (kind === "video") {
    return (
      <svg width={size} height={size} viewBox="0 0 12 12" aria-hidden>
        <rect x={1.5} y={2.5} width={9} height={7} rx={1} {...common} />
        <path d="M5 4.6v2.8l2.6-1.4z" {...common} />
      </svg>
    );
  }
  if (kind === "svg") {
    return (
      <svg width={size} height={size} viewBox="0 0 12 12" aria-hidden>
        <path d="M1.5 9.5C3 3 5 3 6 6s3 3 4.5-3.5" {...common} />
      </svg>
    );
  }
  return (
    <svg width={size} height={size} viewBox="0 0 12 12" aria-hidden>
      <rect x={1.5} y={2} width={9} height={8} rx={1} {...common} />
      <circle cx={4.4} cy={5} r={1} {...common} />
      <path d="M2.5 9l2.6-2.6 1.8 1.8L9 6l1.4 1.6" {...common} />
    </svg>
  );
}

// Right-click menu for a library card — the NodeContextMenu shape.
function CardMenu({
  x,
  y,
  items,
  onClose,
}: {
  x: number;
  y: number;
  items: { label: string; onClick: () => void }[];
  onClose: () => void;
}) {
  const panelWin = usePanelWindow();
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const win = panelWin ?? window;
    const onDown = (e: MouseEvent) => {
      if (ref.current?.contains(e.target as globalThis.Node)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    win.addEventListener("mousedown", onDown, true);
    win.addEventListener("keydown", onKey);
    return () => {
      win.removeEventListener("mousedown", onDown, true);
      win.removeEventListener("keydown", onKey);
    };
  }, [onClose, panelWin]);
  return (
    <div
      ref={ref}
      onMouseDown={(e) => e.stopPropagation()}
      style={{
        position: "fixed",
        left: x,
        top: y,
        minWidth: 170,
        background: "var(--tb-n-3)",
        border: "1px solid var(--tb-n-7)",
        borderRadius: 4,
        boxShadow: "0 6px 20px rgba(0,0,0,0.5)",
        padding: 4,
        zIndex: 2000,
        fontFamily: "var(--ui-font)",
        fontSize: 11,
        color: "var(--tb-n-16)",
        userSelect: "none",
      }}
    >
      {items.map((it) => (
        <button
          key={it.label}
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            it.onClick();
            onClose();
          }}
          onMouseEnter={(e) => {
            (e.currentTarget as HTMLButtonElement).style.background =
              "var(--tb-a-blue-900)";
          }}
          onMouseLeave={(e) => {
            (e.currentTarget as HTMLButtonElement).style.background =
              "transparent";
          }}
          style={{
            display: "block",
            width: "100%",
            padding: "4px 10px",
            background: "transparent",
            border: "none",
            color: "var(--tb-n-16)",
            textAlign: "left",
            fontFamily: "inherit",
            fontSize: "inherit",
            cursor: "default",
            borderRadius: 3,
          }}
        >
          {it.label}
        </button>
      ))}
    </div>
  );
}
