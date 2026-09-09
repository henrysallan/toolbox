"use client";

// The Assets panel (specdocs/090326_asset-library.md §4). One component,
// three mounts: the "assets" panel kind (with a kind chip), the parameter
// panel via File → Assets, and the Project view's Comps/Assets pill.
//
// Primary section: the user's project-agnostic LIBRARY — images / SVGs /
// videos from state/user-assets.ts plus node presets from
// state/node-presets.ts, merged into one card grid. Cards drag into the
// node editor (`application/x-toolbox-asset` — NodeEditor's drop handler
// forwards any payload with a `ref`), double-click to insert at the last
// pointer position, right-click for Rename / Replace Thumbnail / Delete.
// OS files dropped anywhere on the panel upload into the library.
//
// Below it, the June sections (archive/062926_assets.md) stay as they were:
// "In project" (bundled fonts) and "Folder" (an external assets/ folder).
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
import { importFilesToLibrary } from "@/lib/asset-import";
import {
  deleteAsset,
  loadUserAssets,
  renameAsset,
  replaceAssetThumbnail,
  useUserAssets,
  type UserAssetRow,
} from "@/state/user-assets";
import {
  removeUserNodePreset,
  renameUserNodePreset,
  setUserNodePresetThumbnail,
  useUserNodePresets,
  type UserNodePreset,
} from "@/state/node-presets";
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
  source: "bundled" | "folder" | "library" | "preset";
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

  // A cold mount (e.g. the panel opened before EffectsApp's identity
  // effect ran) kicks the first load; later mounts reuse the store.
  useEffect(() => {
    if (library.status === "idle") void loadUserAssets();
  }, [library.status]);

  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
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
    const media = library.rows.map(itemFromRow); // newest first (query order)
    const pres = presets.slice().reverse().map(itemFromPreset); // newest last in store
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
  }, [library.rows, presets, filter, query]);

  // --- uploads ------------------------------------------------------------------

  const importFiles = useCallback(
    async (files: File[]) => {
      if (files.length === 0) return;
      if (!user) return toast("Sign in to use your asset library.");
      const results = await importFilesToLibrary(files, {
        cloudMedia: entitlements.cloudMedia,
      });
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
            ? `"${dups[0].result.ok ? dups[0].result.row.name : ""}" is already in your assets`
            : `${dups.length} files were already in your assets`
        );
      } else {
        toast(
          `added ${added} asset${added === 1 ? "" : "s"}` +
            (dups.length ? ` (${dups.length} already there)` : "")
        );
      }
    },
    [user, entitlements.cloudMedia, toast]
  );

  const menuItems: MenuItem[] = [
    {
      kind: "item",
      label: "Upload Asset…",
      disabled: !user,
      title: user
        ? entitlements.cloudMedia
          ? "Images, SVGs, and videos"
          : "Images and SVGs (video assets need cloud media)"
        : "Sign in to use your asset library",
      onClick: () => uploadInputRef.current?.click(),
    },
    { kind: "divider" },
    {
      kind: "item",
      label: "Refresh",
      onClick: () => void loadUserAssets(),
    },
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

  const cardMenuItems: { label: string; onClick: () => void }[] = cardMenu
    ? [
        { label: "Rename…", onClick: () => setRenaming(cardMenu.item) },
        {
          label: "Replace Thumbnail…",
          onClick: () => startReplaceThumb(cardMenu.item),
        },
        { label: "Delete", onClick: () => void deleteItem(cardMenu.item) },
      ]
    : [];

  // --- states --------------------------------------------------------------------------

  const signedOut = !user;
  const loading = library.status === "loading" && library.rows.length === 0;
  const hasAnyLibrary = library.rows.length > 0 || presets.length > 0;

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
            Assets
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
          {signedOut && (
            <Hint>
              Sign in to keep images, SVGs, and videos in a library you can
              drag into any project.
              {presets.length > 0 ? " Your node presets are listed below." : ""}
            </Hint>
          )}
          {!signedOut && library.status === "error" && (
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
          {!loading && !hasAnyLibrary && !signedOut && library.status === "ready" && (
            <Hint>
              Nothing here yet. Use <b>Assets ▸ Upload Asset…</b>, drop files
              on this panel, or right-click a node → <b>Add to Assets</b>.
              Node presets you save land here too.
            </Hint>
          )}
          {items.length === 0 && hasAnyLibrary && (query || filter !== "all") && (
            <Hint>No matches.</Hint>
          )}
          {items.length > 0 && (
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fill, minmax(96px, 1fr))",
                gap: 6,
              }}
            >
              {items.map((it) => (
                <Card
                  key={it.id}
                  item={it}
                  onDoubleClick={onInsert ? () => onInsert(it.payload) : undefined}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setCardMenu({ x: e.clientX, y: e.clientY, item: it });
                  }}
                />
              ))}
            </div>
          )}
        </div>

        {/* project-scoped sections (062926_assets.md) */}
        <AssetSection
          title="In project"
          hint="Custom fonts you add are bundled with the project and appear here."
          items={assets.filter((a) => a.source === "bundled").map(itemFromLegacy)}
          onInsert={onInsert}
        />
        <AssetSection
          title={folderName ? `Folder · ${folderName}` : "Folder"}
          hint={
            onPickFolder
              ? "Choose a folder of assets to reference alongside this project."
              : "Open a .toolbox that sits next to an assets/ folder to see its files here."
          }
          items={assets.filter((a) => a.source === "folder").map(itemFromLegacy)}
          onInsert={onInsert}
          action={
            onPickFolder
              ? { label: "Choose folder…", onClick: onPickFolder }
              : undefined
          }
        />
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
  action,
  onInsert,
}: {
  title: string;
  hint: string;
  items: LibraryItem[];
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
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(96px, 1fr))",
            gap: 6,
          }}
        >
          {items.map((it) => (
            <Card
              key={it.id}
              item={it}
              onDoubleClick={onInsert ? () => onInsert(it.payload) : undefined}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function Card({
  item,
  onDoubleClick,
  onContextMenu,
}: {
  item: LibraryItem;
  onDoubleClick?: () => void;
  onContextMenu?: (e: React.MouseEvent) => void;
}) {
  const [hover, setHover] = useState(false);
  return (
    <div
      title={`${item.name} — drag into the node editor${onDoubleClick ? ", or double-click to insert" : ""}`}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = "copy";
        e.dataTransfer.setData(ASSET_DRAG_MIME, JSON.stringify(item.payload));
      }}
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

function KindGlyph({ kind }: { kind: LibraryKind }) {
  const common = { fill: "none", stroke: "currentColor", strokeWidth: 1.2 } as const;
  const size = 28;
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
