"use client";

import {
  Fragment,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  deleteProject,
  invalidateProjectCaches,
  listPrivateProjects,
  listPublicProjects,
  listSharedProjects,
  renameProject,
  thumbnailSrc,
  type ProjectRow,
} from "@/lib/supabase/projects";
import {
  createFolder,
  deleteFolder,
  invalidateFolderCache,
  listFolders,
  moveFolder,
  moveProjectToFolder,
  renameFolder,
  type FolderRow,
} from "@/lib/supabase/project-folders";
import RateProjectPopover from "./RateProjectPopover";
import CollaboratorsModal from "./CollaboratorsModal";
import {
  listActiveLeases,
  type ActiveLease,
} from "@/lib/supabase/project-editing";
import { platform, type LocalRecent } from "@/lib/platform";

interface RatePopover {
  row: ProjectRow;
  x: number;
  y: number;
}

// Per-item fade-in offset (ms). Each successive tile/row waits this much
// longer before it appears, producing the sequential cascade.
const STAGGER_STEP = 35;
const STAGGER_DURATION = 260;

// Flips to true one frame after `ready` becomes true, so a child that
// starts at opacity 0 transitions to its visible state. Returns the
// trigger; callers add a per-index transition-delay for the cascade.
function useStaggerShown(ready: boolean): boolean {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (!ready) return;
    const id = requestAnimationFrame(() => setShown(true));
    return () => cancelAnimationFrame(id);
  }, [ready]);
  return shown;
}

// Shared style for a staggered fade-in item.
function staggerStyle(shown: boolean, index: number): React.CSSProperties {
  return {
    opacity: shown ? 1 : 0,
    transform: shown ? "translateY(0)" : "translateY(6px)",
    transition: `opacity ${STAGGER_DURATION}ms ease, transform ${STAGGER_DURATION}ms ease`,
    transitionDelay: `${index * STAGGER_STEP}ms`,
  };
}

type Tab = "private" | "shared" | "public" | "local";
// "list" is the compact text table; "detail" is the same table with taller
// rows carrying a thumbnail in the leading column.
type View = "grid" | "list" | "detail";
type SortKey = "name" | "author" | "date";
type SortDir = "asc" | "desc";

// ========================================================================
// folder drag & drop — pointer-based
//
// Native HTML5 DnD renders a washed-out static snapshot the browser owns.
// Instead, tiles are dragged with pointer events: past a small movement
// threshold the tile "lifts" into a fixed-position ghost that chases the
// cursor with a short rAF-lerp ease, drop targets are hit-tested under
// the pointer (elementFromPoint + [data-drop-target] — the ghost is
// pointer-events:none so it's seen through), a valid drop fades the
// ghost out in place, and an invalid release flies it back to where it
// was picked up. Plain clicks stay clicks: nothing engages until the
// threshold, and a real drag suppresses the click that follows
// pointerup. Spec: specdocs/archive/072726_project-folders.md.
// ========================================================================

// Drop-target keys carried in data-drop-target: "root" or "f:<folderId>".
function dropKeyToTarget(key: string): string | null {
  return key === "root" ? null : key.slice(2);
}

// True from drag activation until just after pointerup, so the click the
// browser fires after a completed drag doesn't also load/open.
let suppressClick = false;

interface DragPayload {
  kind: "project" | "folder";
  id: string;
  // Projects being moved together (list/detail multi-select drag).
  projectIds?: string[];
}

// What beginDrag needs to know about the grabbed tile.
interface DragSpec extends DragPayload {
  row?: ProjectRow;
  folder?: FolderRow;
  count?: number;
  view: View;
}

// What the ghost renders + where it starts (screen px).
interface DragState extends DragPayload {
  row: ProjectRow | null;
  folder: FolderRow | null;
  count: number;
  view: View;
  width: number;
  startLeft: number;
  startTop: number;
}

// List/detail checkbox column width.
const LIST_CHECK = 28;

// Edge auto-scroll while dragging: zone depth inside the scroll
// container's top/bottom edges, and the max px/frame at the very edge
// (speed scales linearly with proximity).
const SCROLL_ZONE = 36;
const SCROLL_MAX = 14;

// Mutable per-drag motion state, owned by useTileDrag.
interface DragSession {
  active: boolean;
  grabDX: number;
  grabDY: number;
  curX: number;
  curY: number;
  targetX: number;
  targetY: number;
  originX: number;
  originY: number;
  // Raw pointer position (screen px) — the auto-scroll zone test and
  // post-scroll re-hit-test need it between pointermove events.
  pointerX: number;
  pointerY: number;
  releasing: null | "drop" | "cancel";
  raf: number;
  cleanup: () => void;
}

// The drag manager. One instance lives in LoadGrid; tiles call beginDrag
// from pointerdown and everything else (threshold, ghost motion, target
// hit-testing, drop dispatch, cancel fly-back) happens on window
// listeners installed for the duration of the gesture.
function useTileDrag(opts: {
  canDrop: (p: DragPayload, into: string | null) => boolean;
  onDrop: (p: DragPayload, into: string | null) => void;
  // The grid's scroll container — dragging near its top/bottom edge
  // auto-scrolls it so long lists are reachable mid-drag.
  scrollRef?: React.RefObject<HTMLDivElement | null>;
}) {
  const [drag, setDrag] = useState<DragState | null>(null);
  const [hoverKey, setHoverKeyState] = useState<string | null>(null);
  const ghostRef = useRef<HTMLDivElement | null>(null);
  const sessionRef = useRef<DragSession | null>(null);

  // Latest-callback ref so the gesture's window listeners never see a
  // stale canDrop/onDrop closure. Synced post-render (not during — the
  // react-hooks/refs rule) which is early enough for any pointer event.
  const optsRef = useRef(opts);
  useEffect(() => {
    optsRef.current = opts;
  });

  const hoverKeyRef = useRef<string | null>(null);
  const setHoverKey = (k: string | null) => {
    if (hoverKeyRef.current === k) return;
    hoverKeyRef.current = k;
    setHoverKeyState(k);
  };

  const beginDrag = (e: React.PointerEvent, spec: DragSpec) => {
    if (e.button !== 0 || sessionRef.current) return;
    const el = e.currentTarget as HTMLElement;
    const startX = e.clientX;
    const startY = e.clientY;
    const s: DragSession = {
      active: false,
      grabDX: 0,
      grabDY: 0,
      curX: 0,
      curY: 0,
      targetX: 0,
      targetY: 0,
      originX: 0,
      originY: 0,
      pointerX: 0,
      pointerY: 0,
      releasing: null,
      raf: 0,
      cleanup: () => {},
    };

    const step = () => {
      const node = ghostRef.current;
      if (node) {
        // Short ease toward the pointer — the "picked up" feel. The
        // fly-back uses a slightly softer factor so it reads as a glide.
        const k = s.releasing === "cancel" ? 0.22 : 0.4;
        s.curX += (s.targetX - s.curX) * k;
        s.curY += (s.targetY - s.curY) * k;
        node.style.transform = `translate3d(${s.curX}px, ${s.curY}px, 0)`;
      }
      // Edge auto-scroll: pointer parked in the zone inside the scroll
      // container's top/bottom edge scrolls it each frame, faster the
      // closer to the edge. Only while the pointer is INSIDE the
      // container — hovering the toolbar (breadcrumbs) must not scroll.
      // Content slides under a stationary pointer, so re-run the hit
      // test after any actual scroll.
      const scrollEl = optsRef.current.scrollRef?.current;
      if (scrollEl && !s.releasing && s.active) {
        const rect = scrollEl.getBoundingClientRect();
        let dy = 0;
        if (
          s.pointerX >= rect.left &&
          s.pointerX <= rect.right &&
          s.pointerY >= rect.top &&
          s.pointerY <= rect.bottom
        ) {
          const topT = (s.pointerY - rect.top) / SCROLL_ZONE;
          const botT = (rect.bottom - s.pointerY) / SCROLL_ZONE;
          if (topT < 1) dy = -SCROLL_MAX * (1 - topT);
          else if (botT < 1) dy = SCROLL_MAX * (1 - botT);
        }
        if (dy !== 0) {
          const before = scrollEl.scrollTop;
          scrollEl.scrollTop = before + dy;
          if (scrollEl.scrollTop !== before) {
            hitTest(s.pointerX, s.pointerY);
          }
        }
      }
      if (s.releasing === "cancel") {
        const dx = s.targetX - s.curX;
        const dy = s.targetY - s.curY;
        if (dx * dx + dy * dy < 0.6) {
          finish();
          return;
        }
      }
      s.raf = requestAnimationFrame(step);
    };

    const activate = (ev: PointerEvent) => {
      const rect = el.getBoundingClientRect();
      // List/detail rows are panel-wide; their ghost compacts to a chip,
      // so keep the grab point inside the chip's footprint.
      const width =
        spec.view === "grid" ? rect.width : Math.min(rect.width, 240);
      s.grabDX = Math.max(8, Math.min(ev.clientX - rect.left, width - 16));
      s.grabDY = Math.max(4, Math.min(ev.clientY - rect.top, rect.height - 4));
      s.curX = rect.left;
      s.curY = rect.top;
      s.originX = rect.left;
      s.originY = rect.top;
      s.targetX = ev.clientX - s.grabDX;
      s.targetY = ev.clientY - s.grabDY;
      s.pointerX = ev.clientX;
      s.pointerY = ev.clientY;
      s.active = true;
      suppressClick = true;
      document.body.style.userSelect = "none";
      document.body.style.cursor = "grabbing";
      setDrag({
        kind: spec.kind,
        id: spec.id,
        projectIds: spec.projectIds,
        row: spec.row ?? null,
        folder: spec.folder ?? null,
        count: spec.count ?? 0,
        view: spec.view,
        width,
        startLeft: rect.left,
        startTop: rect.top,
      });
      s.raf = requestAnimationFrame(step);
    };

    const hitTest = (x: number, y: number) => {
      const under = document.elementFromPoint(x, y);
      const targetEl = under?.closest<HTMLElement>("[data-drop-target]") ?? null;
      let key = targetEl?.dataset.dropTarget ?? null;
      if (key) {
        const into = dropKeyToTarget(key);
        if (
          (into !== null && into === spec.id) ||
          !optsRef.current.canDrop({ kind: spec.kind, id: spec.id }, into)
        ) {
          key = null;
        }
      }
      setHoverKey(key);
    };

    const move = (ev: PointerEvent) => {
      if (!s.active) {
        const dx = ev.clientX - startX;
        const dy = ev.clientY - startY;
        if (dx * dx + dy * dy < 25) return; // 5px threshold — clicks stay clicks
        activate(ev);
      }
      if (s.releasing) return;
      s.targetX = ev.clientX - s.grabDX;
      s.targetY = ev.clientY - s.grabDY;
      s.pointerX = ev.clientX;
      s.pointerY = ev.clientY;
      hitTest(ev.clientX, ev.clientY);
    };

    const finish = () => {
      cancelAnimationFrame(s.raf);
      sessionRef.current = null;
      setDrag(null);
      setHoverKey(null);
    };

    const restoreBody = () => {
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
    };

    // Clears click suppression on the next tick — by then the click the
    // browser fires for the gesture's pointerup has already been eaten.
    const armClickRelease = () => {
      setTimeout(() => {
        suppressClick = false;
      }, 0);
    };

    // Shared release path: `key` is the resolved drop key, null = cancel.
    // `viaPointerUp` distinguishes a real mouse release (its click is
    // imminent) from Escape (the button is still down — keep suppressing
    // until it actually comes up, or the cancel would click through and
    // load/open whatever the pointer happens to be over).
    const release = (key: string | null, viaPointerUp: boolean) => {
      s.cleanup();
      if (!s.active) {
        // Never crossed the threshold — this was just a click.
        sessionRef.current = null;
        return;
      }
      restoreBody();
      if (viaPointerUp) {
        armClickRelease();
      } else {
        window.addEventListener("pointerup", armClickRelease, { once: true });
      }
      setHoverKey(null);
      if (key !== null) {
        optsRef.current.onDrop(
          { kind: spec.kind, id: spec.id },
          dropKeyToTarget(key)
        );
        // Settle into the drop: quick fade + slight shrink in place.
        s.releasing = "drop";
        cancelAnimationFrame(s.raf);
        const node = ghostRef.current;
        if (node) {
          node.style.transition = "opacity 130ms ease, transform 130ms ease";
          node.style.opacity = "0";
          node.style.transform = `translate3d(${s.curX}px, ${s.curY + 4}px, 0) scale(0.94)`;
        }
        setTimeout(finish, 140);
      } else {
        // No valid target — glide home, then dissolve.
        s.releasing = "cancel";
        s.targetX = s.originX;
        s.targetY = s.originY;
        // Safety net: never let a lost frame strand the ghost.
        setTimeout(() => {
          if (sessionRef.current === s) finish();
        }, 450);
      }
    };

    const onMove = (ev: PointerEvent) => move(ev);
    const onUp = () => release(hoverKeyRef.current, true);
    const onCancel = () => {
      // pointercancel (e.g. the browser reclaimed a touch gesture) —
      // clean up immediately, no animation. No click follows one, so
      // suppression lifts right away.
      s.cleanup();
      if (s.active) restoreBody();
      suppressClick = false;
      finish();
    };
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape" && s.active) release(null, false);
    };
    s.cleanup = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      window.removeEventListener("keydown", onKey);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    window.addEventListener("keydown", onKey);
    sessionRef.current = s;
  };

  // Unmount during a drag: drop the listeners and body overrides.
  useEffect(
    () => () => {
      const s = sessionRef.current;
      if (!s) return;
      s.cleanup();
      cancelAnimationFrame(s.raf);
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
      suppressClick = false;
      sessionRef.current = null;
    },
    []
  );

  return { drag, hoverKey, beginDrag, ghostRef };
}

// Everything the body views need to render + mutate folders. Undefined on
// the Public/Local tabs (and signed out), which keeps those rendering
// exactly as before folders existed.
interface FolderCtx {
  // Folders visible in the current location, already sorted.
  folders: FolderRow[];
  // Direct-child count (projects + subfolders) per folder id.
  counts: Map<string, number>;
  // True while drilled into a folder (drives the empty-state copy).
  inFolder: boolean;
  // Folder currently in inline-rename mode, if any.
  renameId: string | null;
  onOpen: (id: string) => void;
  onMenu: (f: FolderRow, x: number, y: number) => void;
  onRenameCommit: (id: string, name: string) => void;
  onRenameCancel: () => void;
  // Pointer-drag entry points (wired from tile pointerdown).
  beginDragProject: (e: React.PointerEvent, row: ProjectRow) => void;
  beginDragFolder: (
    e: React.PointerEvent,
    folder: FolderRow,
    count: number
  ) => void;
  // Drop-target key ("root" / "f:<id>") under the live drag, if any.
  dropHoverKey: string | null;
  // Id of the tile being dragged — its source dims while the ghost flies.
  dragId: string | null;
  // All project ids in a multi-select drag (null when dragging a folder).
  dragProjectIds: string[] | null;
}

// Multi-select in list/detail views: checkbox toggles, bulk delete, bulk move.
interface SelectionCtx {
  selectedIds: Set<string>;
  toggle: (id: string) => void;
  isSelected: (id: string) => boolean;
}

interface Props {
  onLoad: (id: string) => void;
  signedIn: boolean;
  // Bumped by the parent after save/delete so the grid refetches without
  // needing its own subscription to change events.
  refreshKey?: number;
  // Current user's id — used to label public projects that belong to
  // the viewer (so a user's own public work shows "you" instead of
  // their display name).
  currentUserId?: string | null;
  // When provided, a synthetic "New Project" tile is rendered as the
  // first grid item (and list row). Used by the landing screen so the
  // grid doubles as the entry point to a fresh, empty project.
  onNewProject?: () => void;
  // Open a recent local .toolbox by path. Presence (+ a native build)
  // enables the desktop-only "Local" tab.
  onLoadLocal?: (path: string) => void;
}

export default function LoadGrid({
  onLoad,
  signedIn,
  refreshKey,
  currentUserId,
  onNewProject,
  onLoadLocal,
}: Props) {
  // Default to Public when signed out so visitors see something useful;
  // default to Private for signed-in users since that's their own work.
  const [tab, setTab] = useState<Tab>(signedIn ? "private" : "public");
  const [view, setView] = useState<View>("grid");
  const [sort, setSort] = useState<{ key: SortKey; dir: SortDir }>({
    key: "date",
    dir: "desc",
  });
  const [rows, setRows] = useState<ProjectRow[] | null>(null);
  // Manual refresh bumps this to bust both the server fetch and any
  // cache we might layer in later.
  const [manualRefresh, setManualRefresh] = useState(0);
  // Right-click → rate popover. Stored at top-level so it survives
  // re-renders inside the grid/list child views.
  const [ratePopover, setRatePopover] = useState<RatePopover | null>(null);
  // Collaborators modal target (own rows, M2 shared projects) — opened
  // from the rate popover's manage section.
  const [collabTarget, setCollabTarget] = useState<ProjectRow | null>(null);
  // "● editing" badges (M3 lease): who currently holds each listed
  // project's editing lease. Fetched alongside the private/shared
  // listings; refresh rides the refresh button — never a poll.
  const [leases, setLeases] = useState<Map<string, ActiveLease>>(new Map());

  // Folder hierarchy (Private tab only). `folders` is the user's WHOLE
  // flat folder list — drill-in is pure client-side filtering on
  // parent_id/folder_id, so navigation costs zero egress. `folderId` is
  // the current location (null = root). Stale folders are kept during a
  // refetch so the breadcrumb doesn't flicker.
  const [folders, setFolders] = useState<FolderRow[] | null>(null);
  const [folderId, setFolderId] = useState<string | null>(null);
  const [folderMenu, setFolderMenu] = useState<{
    folder: FolderRow;
    x: number;
    y: number;
  } | null>(null);
  const [renameId, setRenameId] = useState<string | null>(null);
  // List/detail multi-select — cleared on tab/folder navigation.
  const [selectedProjectIds, setSelectedProjectIds] = useState<Set<string>>(
    () => new Set()
  );

  const toggleProjectSelection = (id: string) => {
    setSelectedProjectIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectionCtx: SelectionCtx = {
    selectedIds: selectedProjectIds,
    toggle: toggleProjectSelection,
    isSelected: (id) => selectedProjectIds.has(id),
  };

  // Desktop "Local" tab: detected post-mount (client-only) to avoid a
  // hydration mismatch. Recents come from the native bridge.
  const [localEnabled, setLocalEnabled] = useState(false);
  useEffect(() => {
    setLocalEnabled(platform.isNative && !!platform.recents && !!onLoadLocal);
  }, [onLoadLocal]);
  const [recents, setRecents] = useState<LocalRecent[] | null>(null);

  // Open sequence: the panel mounts with everything hidden, then the
  // chrome (tab bar) fades in first. The tiles handle their own
  // staggered fade once rows arrive, so the eye reads it as: menu bar
  // settles → projects cascade in.
  const [chromeIn, setChromeIn] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => setChromeIn(true));
    return () => cancelAnimationFrame(id);
  }, []);

  // Reconcile the tab when sign-in state flips, done render-time
  // against the previously-seen `signedIn` to avoid a setState-in-
  // effect cascade. Signed out on Private → bounce to Public. Signed
  // in on Public → bounce to Private: auth resolves async (getSession
  // runs in an effect), so a signed-in user still mounts as signed-out
  // and the useState default above locks in Public — this flip is what
  // actually lands them on their own work. Local is left alone (it can
  // only be reached by an explicit click).
  const [seenSignedIn, setSeenSignedIn] = useState(signedIn);
  if (seenSignedIn !== signedIn) {
    setSeenSignedIn(signedIn);
    if (!signedIn && (tab === "private" || tab === "shared")) setTab("public");
    if (signedIn && tab === "public") setTab("private");
  }

  // Reset rows to the loading state whenever the inputs change so
  // we don't flash stale data from the previous tab / refresh key.
  const fetchKey = `${tab}|${refreshKey ?? 0}|${manualRefresh}|${signedIn ? 1 : 0}`;
  const [seenFetchKey, setSeenFetchKey] = useState(fetchKey);
  if (seenFetchKey !== fetchKey) {
    setSeenFetchKey(fetchKey);
    setRows(null);
  }

  // Leaving the tab exits folder navigation; refresh alone keeps the
  // current location (hence a separate reconcile from fetchKey).
  const [seenTab, setSeenTab] = useState(tab);
  if (seenTab !== tab) {
    setSeenTab(tab);
    setFolderId(null);
    setRenameId(null);
    setFolderMenu(null);
    setSelectedProjectIds(new Set());
  }

  // Folder drill-in clears selection — selected items may not be visible.
  const [seenFolderId, setSeenFolderId] = useState(folderId);
  if (seenFolderId !== folderId) {
    setSeenFolderId(folderId);
    setSelectedProjectIds(new Set());
  }

  // The current folder vanished (deleted in another window + refresh) —
  // fall back to root rather than showing an unreachable location.
  if (folderId && folders && !folders.some((f) => f.id === folderId)) {
    setFolderId(null);
  }

  useEffect(() => {
    // Private/Shared tabs show a sign-in message when logged out (Body
    // handles that case via a prop check) — skip the doomed request
    // entirely.
    if ((tab === "private" || tab === "shared") && !signedIn) return;
    let cancelled = false;
    const loader =
      tab === "private"
        ? listPrivateProjects
        : tab === "shared"
          ? listSharedProjects
          : listPublicProjects;
    loader().then((list) => {
      if (cancelled) return;
      setRows(list);
      // Editing badges only make sense where the viewer is a member
      // (lease RLS returns nothing elsewhere) — skip the query on the
      // public tab entirely.
      if (tab === "private" || tab === "shared") {
        void listActiveLeases(list.map((r) => r.id)).then((m) => {
          if (!cancelled) setLeases(m);
        });
      } else {
        setLeases(new Map());
      }
    });
    return () => {
      cancelled = true;
    };
  }, [tab, signedIn, refreshKey, manualRefresh]);

  // Folder list fetch (Private tab only). Degrades to [] if the folders
  // migration hasn't been run — the grid then renders flat as before.
  useEffect(() => {
    if (tab !== "private" || !signedIn) return;
    let cancelled = false;
    listFolders().then((f) => {
      if (!cancelled) setFolders(f);
    });
    return () => {
      cancelled = true;
    };
  }, [tab, signedIn, refreshKey, manualRefresh]);

  // Local recents fetch (desktop only).
  useEffect(() => {
    if (tab !== "local" || !platform.recents) return;
    let cancelled = false;
    setRecents(null);
    platform.recents.list().then((r) => {
      if (!cancelled) setRecents(r);
    });
    return () => {
      cancelled = true;
    };
  }, [tab, manualRefresh]);

  const sortedRows =
    rows && sortRows(rows, sort, currentUserId ?? null);

  // ---- folder derived data + handlers (Private tab only) ----

  const showFolders = tab === "private" && signedIn;

  const folderById = useMemo(() => {
    const m = new Map<string, FolderRow>();
    for (const f of folders ?? []) m.set(f.id, f);
    return m;
  }, [folders]);

  // Ancestor chain of the current folder, root-first — the breadcrumb.
  const crumbs = useMemo(() => {
    const chain: FolderRow[] = [];
    let cur = folderId ? folderById.get(folderId) : undefined;
    let guard = 0;
    while (cur && guard++ < 100) {
      chain.unshift(cur);
      cur = cur.parent_id ? folderById.get(cur.parent_id) : undefined;
    }
    return chain;
  }, [folderId, folderById]);

  // Direct-child counts (subfolders + projects) for the tile subtitles.
  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const f of folders ?? []) {
      if (f.parent_id) m.set(f.parent_id, (m.get(f.parent_id) ?? 0) + 1);
    }
    for (const r of rows ?? []) {
      const fid = r.folder_id ?? null;
      if (fid) m.set(fid, (m.get(fid) ?? 0) + 1);
    }
    return m;
  }, [folders, rows]);

  const visibleFolders = useMemo(
    () =>
      showFolders && folders
        ? sortFolders(
            folders.filter((f) => (f.parent_id ?? null) === folderId),
            sort
          )
        : [],
    [showFolders, folders, folderId, sort]
  );

  // Rows filtered to the current location. Public/Local ignore folders.
  const filteredRows =
    showFolders && sortedRows
      ? sortedRows.filter((r) => (r.folder_id ?? null) === folderId)
      : sortedRows;

  // Optimistic-move error path: something the local state already shows
  // failed to persist — drop caches and refetch to resync.
  const resyncFolders = () => {
    invalidateProjectCaches();
    invalidateFolderCache();
    setManualRefresh((n) => n + 1);
  };

  const handleCreateFolder = async () => {
    const f = await createFolder("New Folder", folderId);
    if (!f) return; // pre-migration / offline — logged by the data layer
    setFolders((prev) => (prev ? [...prev, f] : [f]));
    setRenameId(f.id);
  };

  const handleRenameCommit = (id: string, name: string) => {
    setRenameId(null);
    const trimmed = name.trim();
    const prev = folderById.get(id);
    if (!trimmed || !prev || trimmed === prev.name) return;
    setFolders(
      (cur) => cur?.map((f) => (f.id === id ? { ...f, name: trimmed } : f)) ?? cur
    );
    void renameFolder(id, trimmed).then((ok) => {
      if (!ok) resyncFolders();
    });
  };

  const handleDeleteFolder = (f: FolderRow) => {
    if (
      !window.confirm(
        `Delete folder "${f.name}"? Projects and folders inside move up a level.`
      )
    ) {
      return;
    }
    const parent = f.parent_id ?? null;
    // Optimistic mirror of the data layer's re-home-then-delete.
    setFolders((cur) =>
      cur
        ? cur
            .filter((x) => x.id !== f.id)
            .map((x) =>
              x.parent_id === f.id ? { ...x, parent_id: parent } : x
            )
        : cur
    );
    setRows((cur) =>
      cur
        ? cur.map((r) =>
            (r.folder_id ?? null) === f.id ? { ...r, folder_id: parent } : r
          )
        : cur
    );
    if (folderId === f.id) setFolderId(parent);
    void deleteFolder(f.id, parent).then((ok) => {
      if (!ok) resyncFolders();
    });
  };

  // Rename / delete from the project tile's right-click popover (own
  // projects only — the popover render below gates on ownership). Same
  // optimistic contract as the folder handlers: update local rows now,
  // resync from the server if persistence fails. expectedUpdatedAt is
  // omitted on rename — these rows were never loaded into an editor, so
  // last-writer-wins is the documented contract (see renameProject).
  const handleRenameProject = (row: ProjectRow, name: string) => {
    setRows((cur) =>
      cur ? cur.map((r) => (r.id === row.id ? { ...r, name } : r)) : cur
    );
    void renameProject(row.id, name).then((res) => {
      if (!res.ok) resyncFolders();
    });
  };

  const handleDeleteProject = (row: ProjectRow) => {
    const allRows = rows ?? [];
    const targets =
      selectedProjectIds.size > 0 && selectedProjectIds.has(row.id)
        ? allRows.filter((r) => selectedProjectIds.has(r.id))
        : [row];
    const ownTargets = targets.filter(
      (r) => currentUserId && r.user_id === currentUserId
    );
    if (ownTargets.length === 0) return;
    const msg =
      ownTargets.length === 1
        ? `Delete project "${ownTargets[0].name}"? This can't be undone.`
        : `Delete ${ownTargets.length} projects? This can't be undone.`;
    if (!window.confirm(msg)) return;
    const ids = new Set(ownTargets.map((r) => r.id));
    setRows((cur) => (cur ? cur.filter((r) => !ids.has(r.id)) : cur));
    setSelectedProjectIds(new Set());
    for (const r of ownTargets) {
      void deleteProject(r.id).then((ok) => {
        if (!ok) resyncFolders();
      });
    }
  };

  // Is `candidate` inside `ancestor`'s subtree (or the same folder)?
  const isWithin = (candidate: string, ancestor: string): boolean => {
    let cur: FolderRow | undefined = folderById.get(candidate);
    let guard = 0;
    while (cur && guard++ < 100) {
      if (cur.id === ancestor) return true;
      cur = cur.parent_id ? folderById.get(cur.parent_id) : undefined;
    }
    return false;
  };

  const canDropPayload = (p: DragPayload, into: string | null): boolean => {
    if (p.kind === "project") return true;
    if (into === null) return true;
    if (into === p.id) return false;
    // A folder can't land on itself or anything inside itself.
    return !isWithin(into, p.id);
  };

  const handleDropProjects = (pids: string[], into: string | null) => {
    const idSet = new Set(pids);
    setRows((cur) =>
      cur
        ? cur.map((r) => (idSet.has(r.id) ? { ...r, folder_id: into } : r))
        : cur
    );
    setSelectedProjectIds(new Set());
    for (const pid of pids) {
      void moveProjectToFolder(pid, into).then((ok) => {
        if (!ok) resyncFolders();
      });
    }
  };

  const handleDropFolder = (fid: string, into: string | null) => {
    if (into !== null && (into === fid || isWithin(into, fid))) return;
    const prev = folderById.get(fid);
    if (!prev || (prev.parent_id ?? null) === into) return;
    setFolders((cur) =>
      cur ? cur.map((f) => (f.id === fid ? { ...f, parent_id: into } : f)) : cur
    );
    void moveFolder(fid, into).then((ok) => {
      if (!ok) resyncFolders();
    });
  };

  // The body's scroll container — the drag manager auto-scrolls it when
  // the ghost hovers near its top/bottom edge.
  const gridScrollRef = useRef<HTMLDivElement | null>(null);

  const { drag, hoverKey, beginDrag, ghostRef } = useTileDrag({
    canDrop: canDropPayload,
    onDrop: (p, into) => {
      if (p.kind === "project") {
        const ids = p.projectIds ?? [p.id];
        handleDropProjects(ids, into);
      } else {
        handleDropFolder(p.id, into);
      }
    },
    scrollRef: gridScrollRef,
  });

  const dragProjectIds =
    drag?.kind === "project" ? (drag.projectIds ?? [drag.id]) : null;

  const folderCtx: FolderCtx | undefined = showFolders
    ? {
        folders: visibleFolders,
        counts,
        inFolder: folderId !== null,
        renameId,
        onOpen: setFolderId,
        onMenu: (f, x, y) => setFolderMenu({ folder: f, x, y }),
        onRenameCommit: handleRenameCommit,
        onRenameCancel: () => setRenameId(null),
        beginDragProject: (e, row) => {
          const ids =
            selectedProjectIds.has(row.id) && selectedProjectIds.size > 0
              ? Array.from(selectedProjectIds)
              : [row.id];
          beginDrag(e, {
            kind: "project",
            id: row.id,
            row,
            view,
            projectIds: ids,
          });
        },
        beginDragFolder: (e, folder, count) =>
          beginDrag(e, { kind: "folder", id: folder.id, folder, count, view }),
        dropHoverKey: hoverKey,
        dragId: drag?.id ?? null,
        dragProjectIds,
      }
    : undefined;

  const toggleSort = (key: SortKey) => {
    setSort((prev) =>
      prev.key === key
        ? { key, dir: prev.dir === "asc" ? "desc" : "asc" }
        : { key, dir: key === "date" ? "desc" : "asc" }
    );
  };

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        minHeight: 0,
        // Negate the 12px padding the parent panel applies so the tab
        // bar spans the full width like a real menu bar.
        margin: -12,
      }}
    >
      <div
        style={{
          flexShrink: 0,
          opacity: chromeIn ? 1 : 0,
          transition: "opacity 220ms ease",
        }}
      >
        <Toolbar
          tab={tab}
          onTabChange={setTab}
          signedIn={signedIn}
          showLocal={localEnabled}
          view={view}
          onViewChange={setView}
          onRefresh={() => {
            // Drop the session cache so the refetch actually hits the
            // DB; otherwise the list call would return the cached rows
            // and defeat the whole point of the button.
            invalidateProjectCaches();
            invalidateFolderCache();
            setManualRefresh((n) => n + 1);
          }}
          folderNav={
            folderCtx
              ? {
                  crumbs,
                  onNavigate: setFolderId,
                  onNewFolder: () => void handleCreateFolder(),
                  dropHoverKey: hoverKey,
                }
              : undefined
          }
        />
      </div>
      <div
        ref={gridScrollRef}
        className="thin-scrollbar"
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: "auto",
          padding: 12,
        }}
      >
        {tab === "local" ? (
          <LocalBody
            recents={recents}
            onOpen={(p) => onLoadLocal?.(p)}
            onRemove={async (p) => {
              await platform.recents?.remove(p);
              setManualRefresh((n) => n + 1);
            }}
            staggerReady={chromeIn}
          />
        ) : (
          <Body
            tab={tab}
            view={view}
            rows={filteredRows}
            sort={sort}
            onSort={toggleSort}
            signedIn={signedIn}
            currentUserId={currentUserId ?? null}
            onLoad={onLoad}
            onRate={(row, x, y) => setRatePopover({ row, x, y })}
            staggerReady={chromeIn}
            onNewProject={onNewProject}
            folderCtx={folderCtx}
            leases={leases}
            selectionCtx={selectionCtx}
          />
        )}
      </div>
      {ratePopover && (
        <RateProjectPopover
          x={ratePopover.x}
          y={ratePopover.y}
          row={ratePopover.row}
          signedIn={signedIn}
          onClose={() => setRatePopover(null)}
          onChanged={() => {
            // Bust the cache and bump the refresh key so the tile picks
            // up the new aggregate from the trigger-maintained columns.
            invalidateProjectCaches();
            setManualRefresh((n) => n + 1);
          }}
          // Manage actions only on the user's own rows — RLS would
          // reject anyone else's anyway; hiding them keeps the popover
          // honest about what can happen.
          onRename={
            !!currentUserId && ratePopover.row.user_id === currentUserId
              ? (name) => handleRenameProject(ratePopover.row, name)
              : undefined
          }
          onDelete={
            !!currentUserId && ratePopover.row.user_id === currentUserId
              ? () => handleDeleteProject(ratePopover.row)
              : undefined
          }
          onCollaborators={
            !!currentUserId && ratePopover.row.user_id === currentUserId
              ? () => setCollabTarget(ratePopover.row)
              : undefined
          }
        />
      )}
      {collabTarget && (
        <CollaboratorsModal
          projectId={collabTarget.id}
          projectName={collabTarget.name}
          onClose={() => setCollabTarget(null)}
        />
      )}
      {folderMenu && (
        <FolderMenuPopover
          x={folderMenu.x}
          y={folderMenu.y}
          name={folderMenu.folder.name}
          onClose={() => setFolderMenu(null)}
          onRename={() => setRenameId(folderMenu.folder.id)}
          onDelete={() => handleDeleteFolder(folderMenu.folder)}
        />
      )}
      {drag && <DragGhost drag={drag} ghostRef={ghostRef} />}
    </div>
  );
}

// ========================================================================
// toolbar
// ========================================================================

// Toolbar folder controls (Private tab only): a breadcrumb while drilled
// into a folder — each chip navigates AND accepts drops (move to that
// ancestor / root, via the pointer-drag hit test) — plus a new-folder
// button.
interface FolderNav {
  crumbs: FolderRow[];
  onNavigate: (id: string | null) => void;
  onNewFolder: () => void;
  // Drop-target key under the live drag (lights the hovered chip).
  dropHoverKey: string | null;
}

function Toolbar({
  tab,
  onTabChange,
  signedIn,
  showLocal,
  view,
  onViewChange,
  onRefresh,
  folderNav,
}: {
  tab: Tab;
  onTabChange: (next: Tab) => void;
  signedIn: boolean;
  showLocal: boolean;
  view: View;
  onViewChange: (next: View) => void;
  onRefresh: () => void;
  folderNav?: FolderNav;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        height: 28,
        flexShrink: 0,
        background: "var(--tb-n-1)",
        borderBottom: "1px solid var(--tb-n-7)",
        padding: "0 6px",
        gap: 6,
        fontFamily: "inherit",
        fontSize: 11,
        color: "var(--tb-n-16)",
        userSelect: "none",
      }}
    >
      <SegmentedTabs
        tab={tab}
        onTabChange={onTabChange}
        signedIn={signedIn}
        showLocal={showLocal}
      />
      {folderNav && folderNav.crumbs.length > 0 && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 2,
            minWidth: 0,
            overflow: "hidden",
          }}
        >
          <Crumb
            label="All"
            target={null}
            onNavigate={folderNav.onNavigate}
            dropHot={folderNav.dropHoverKey === "root"}
          />
          {folderNav.crumbs.map((c, i) => (
            <Fragment key={c.id}>
              <span style={{ color: "var(--tb-n-9)", flexShrink: 0 }}>›</span>
              <Crumb
                label={c.name}
                target={c.id}
                current={i === folderNav.crumbs.length - 1}
                onNavigate={folderNav.onNavigate}
                dropHot={folderNav.dropHoverKey === `f:${c.id}`}
              />
            </Fragment>
          ))}
        </div>
      )}
      <div style={{ flex: 1 }} />
      {folderNav && (
        <IconButton
          onClick={folderNav.onNewFolder}
          title="New folder"
          ariaLabel="Create a new folder"
        >
          <NewFolderIcon />
        </IconButton>
      )}
      <IconButton
        onClick={onRefresh}
        title="Refresh"
        ariaLabel="Refresh project list"
      >
        <RefreshIcon />
      </IconButton>
      <div style={{ display: "flex", gap: 2 }}>
        <IconButton
          onClick={() => onViewChange("grid")}
          active={view === "grid"}
          title="Grid view"
          ariaLabel="Grid view"
        >
          <GridIcon />
        </IconButton>
        <IconButton
          onClick={() => onViewChange("list")}
          active={view === "list"}
          title="List view"
          ariaLabel="List view"
        >
          <ListIcon />
        </IconButton>
        <IconButton
          onClick={() => onViewChange("detail")}
          active={view === "detail"}
          title="Detail view"
          ariaLabel="Detail view"
        >
          <DetailIcon />
        </IconButton>
      </div>
    </div>
  );
}

// Private / Public / (Local, desktop-only) as one segmented toggle pill:
// a rounded track holding the options, the active one lit blue. Replaces
// the old row of separate pill buttons.
function SegmentedTabs({
  tab,
  onTabChange,
  signedIn,
  showLocal,
}: {
  tab: Tab;
  onTabChange: (next: Tab) => void;
  signedIn: boolean;
  showLocal: boolean;
}) {
  const items: {
    key: Tab;
    label: string;
    disabled?: boolean;
    title: string;
  }[] = [
    {
      key: "private",
      label: "Private",
      disabled: !signedIn,
      title: signedIn ? "Your saved projects" : "Sign in to see your projects",
    },
    {
      key: "shared",
      label: "Shared",
      disabled: !signedIn,
      title: signedIn
        ? "Projects other users shared with you"
        : "Sign in to see projects shared with you",
    },
    {
      key: "public",
      label: "Public",
      title: "Projects shared by the community",
    },
  ];
  if (showLocal) {
    items.push({
      key: "local",
      label: "Local",
      title: "Recently opened local .toolbox files on this Mac",
    });
  }
  return (
    <div
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 2,
        padding: 2,
        background: "var(--tb-n-2)",
        border: "1px solid var(--tb-n-7)",
        borderRadius: 999,
      }}
    >
      {items.map((it) => (
        <Segment
          key={it.key}
          active={tab === it.key}
          disabled={it.disabled}
          title={it.title}
          onClick={() => onTabChange(it.key)}
        >
          {it.label}
        </Segment>
      ))}
    </div>
  );
}

function Segment({
  active,
  disabled,
  onClick,
  title,
  children,
}: {
  active: boolean;
  disabled?: boolean;
  onClick: () => void;
  title?: string;
  children: React.ReactNode;
}) {
  const [hover, setHover] = useState(false);
  const hot = hover && !disabled && !active;
  // Soft blue highlight when active (matching the app's DockButton), a subtle
  // fill on hover; the track supplies the border so segments stay borderless.
  return (
    <button
      onMouseDown={(e) => {
        if (disabled) return;
        e.preventDefault();
        onClick();
      }}
      disabled={disabled}
      title={title}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        padding: "3px 12px",
        borderRadius: 999,
        border: "none",
        background: active ? "var(--tb-a-navy-deep)" : hot ? "var(--tb-n-6)" : "transparent",
        color: disabled
          ? "var(--tb-n-9)"
          : active
            ? "var(--tb-a-blue-200)"
            : hot
              ? "var(--tb-n-16)"
              : "var(--tb-n-12)",
        fontFamily: "inherit",
        fontSize: 11,
        lineHeight: 1,
        cursor: disabled ? "not-allowed" : "pointer",
        transition: "background 80ms, color 80ms",
      }}
    >
      {children}
    </button>
  );
}

function IconButton({
  onClick,
  active,
  title,
  ariaLabel,
  children,
}: {
  onClick: () => void;
  active?: boolean;
  title: string;
  ariaLabel: string;
  children: React.ReactNode;
}) {
  const [hover, setHover] = useState(false);
  // Same DockButton treatment as the tabs: faint rest border, hover lift,
  // soft blue when active.
  return (
    <button
      onMouseDown={(e) => {
        e.preventDefault();
        onClick();
      }}
      title={title}
      aria-label={ariaLabel}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        width: 22,
        height: 20,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        background: active ? "var(--tb-a-navy-deep)" : hover ? "var(--tb-n-3)" : "transparent",
        border: `1px solid ${
          active ? "var(--tb-a-navy-tint)" : hover ? "var(--tb-n-8)" : "var(--tb-n-3)"
        }`,
        borderRadius: 3,
        color: active ? "var(--tb-a-blue-200)" : hover ? "var(--tb-n-16)" : "var(--tb-n-12)",
        cursor: "pointer",
        padding: 0,
        transition: "background 80ms, border-color 80ms, color 80ms",
      }}
    >
      {children}
    </button>
  );
}

function GridIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
      <rect x="1" y="1" width="4" height="4" fill="currentColor" />
      <rect x="7" y="1" width="4" height="4" fill="currentColor" />
      <rect x="1" y="7" width="4" height="4" fill="currentColor" />
      <rect x="7" y="7" width="4" height="4" fill="currentColor" />
    </svg>
  );
}

function ListIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
      <rect x="1" y="2" width="10" height="1.5" fill="currentColor" />
      <rect x="1" y="5.25" width="10" height="1.5" fill="currentColor" />
      <rect x="1" y="8.5" width="10" height="1.5" fill="currentColor" />
    </svg>
  );
}

// Detail view: list rows, each led by a thumbnail block.
function DetailIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
      <rect x="1" y="1" width="4" height="4" rx="0.5" fill="currentColor" />
      <rect x="6.5" y="2.5" width="4.5" height="1" fill="currentColor" />
      <rect x="1" y="7" width="4" height="4" rx="0.5" fill="currentColor" />
      <rect x="6.5" y="8.5" width="4.5" height="1" fill="currentColor" />
    </svg>
  );
}

function RefreshIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
      <path
        d="M2.5 6a3.5 3.5 0 1 1 1.03 2.47"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
        fill="none"
      />
      <path
        d="M2 2.5v2.5h2.5"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    </svg>
  );
}

// ========================================================================
// body
// ========================================================================

function Body({
  tab,
  view,
  rows,
  sort,
  onSort,
  signedIn,
  currentUserId,
  onLoad,
  onRate,
  staggerReady,
  onNewProject,
  folderCtx,
  leases,
  selectionCtx,
}: {
  tab: Tab;
  view: View;
  rows: ProjectRow[] | null;
  sort: { key: SortKey; dir: SortDir };
  onSort: (key: SortKey) => void;
  signedIn: boolean;
  currentUserId: string | null;
  onLoad: (id: string) => void;
  onRate: (row: ProjectRow, x: number, y: number) => void;
  // True once the menu bar has begun fading in — gates the project
  // cascade so the chrome always settles first.
  staggerReady: boolean;
  // Landing-only: renders the "New Project" tile/row first.
  onNewProject?: () => void;
  // Present on the Private tab only — folder tiles/rows + DnD.
  folderCtx?: FolderCtx;
  // "● editing" badges (M3 lease): active lease per listed project id.
  leases?: Map<string, ActiveLease>;
  selectionCtx: SelectionCtx;
}) {
  if ((tab === "private" || tab === "shared") && !signedIn) {
    return (
      <div style={{ color: "var(--tb-n-10)" }}>
        {tab === "private"
          ? "Sign in to see your saved projects."
          : "Sign in to see projects shared with you."}
      </div>
    );
  }
  if (rows === null) {
    return <div style={{ color: "var(--tb-n-10)" }}>Loading…</div>;
  }
  // Empty list: still surface the New Project entry on its own when the
  // landing supplies it, so the user is never stranded with no action.
  const folderCount = folderCtx?.folders.length ?? 0;
  if (rows.length === 0 && folderCount === 0 && !onNewProject) {
    return (
      <div style={{ color: "var(--tb-n-10)" }}>
        {tab === "private"
          ? folderCtx?.inFolder
            ? "This folder is empty — drag projects here."
            : "No saved projects yet — use File → Save."
          : tab === "shared"
            ? "No projects shared with you yet."
            : "No public projects yet."}
      </div>
    );
  }
  if (view === "list" || view === "detail") {
    return (
      <ListView
        rows={rows}
        detail={view === "detail"}
        sort={sort}
        onSort={onSort}
        currentUserId={currentUserId}
        showAuthor={tab === "public" || tab === "shared"}
        onLoad={onLoad}
        onRate={onRate}
        staggerReady={staggerReady}
        onNewProject={onNewProject}
        folderCtx={folderCtx}
        leases={leases}
        selectionCtx={selectionCtx}
      />
    );
  }
  return (
    <GridView
      rows={rows}
      currentUserId={currentUserId}
      showAuthor={tab === "public" || tab === "shared"}
      leases={leases}
      onLoad={onLoad}
      onRate={onRate}
      staggerReady={staggerReady}
      onNewProject={onNewProject}
      folderCtx={folderCtx}
      selectionCtx={selectionCtx}
    />
  );
}

function GridView({
  rows,
  currentUserId,
  showAuthor,
  onLoad,
  onRate,
  staggerReady,
  onNewProject,
  folderCtx,
  leases,
  selectionCtx,
}: {
  rows: ProjectRow[];
  currentUserId: string | null;
  showAuthor: boolean;
  onLoad: (id: string) => void;
  onRate: (row: ProjectRow, x: number, y: number) => void;
  staggerReady: boolean;
  onNewProject?: () => void;
  folderCtx?: FolderCtx;
  leases?: Map<string, ActiveLease>;
  selectionCtx: SelectionCtx;
}) {
  const shown = useStaggerShown(staggerReady);
  // The New Project tile, when present, takes slot 0; folder tiles come
  // next; project tiles shift along in the cascade after both.
  const folders = folderCtx?.folders ?? [];
  const folderOffset = onNewProject ? 1 : 0;
  const offset = folderOffset + folders.length;
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fill, minmax(120px, 1fr))",
        gap: 8,
      }}
    >
      {onNewProject && (
        <NewProjectTile
          onClick={onNewProject}
          appearStyle={staggerStyle(shown, 0)}
        />
      )}
      {folderCtx &&
        folders.map((f, i) => (
          <FolderTile
            key={f.id}
            folder={f}
            count={folderCtx.counts.get(f.id) ?? 0}
            ctx={folderCtx}
            appearStyle={staggerStyle(shown, i + folderOffset)}
          />
        ))}
      {rows.map((r, i) => (
        <ProjectTile
          key={r.id}
          row={r}
          showAuthor={showAuthor}
          isMine={!!currentUserId && currentUserId === r.user_id}
          editingLabel={leaseLabel(leases?.get(r.id), currentUserId)}
          onLoad={onLoad}
          onRate={onRate}
          appearStyle={staggerStyle(shown, i + offset)}
          beginDrag={
            folderCtx ? (e) => folderCtx.beginDragProject(e, r) : undefined
          }
          dimmed={folderCtx?.dragProjectIds?.includes(r.id)}
          selected={selectionCtx.isSelected(r.id)}
          onToggleSelection={() => selectionCtx.toggle(r.id)}
        />
      ))}
    </div>
  );
}

// First-slot tile that starts a fresh, empty project. Mirrors the
// ProjectTile footprint (square thumb + label) but swaps the screenshot
// for a flat dark panel with a centred plus.
function NewProjectTile({
  onClick,
  appearStyle,
}: {
  onClick: () => void;
  appearStyle: React.CSSProperties;
}) {
  const [hover, setHover] = useState(false);
  return (
    <button
      onClick={onClick}
      title="Start a new, empty project"
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "stretch",
        padding: 0,
        background: "var(--tb-n-1)",
        border: `1px solid ${hover ? "var(--tb-n-9)" : "var(--tb-n-7)"}`,
        borderRadius: 4,
        overflow: "hidden",
        color: "var(--tb-n-16)",
        cursor: "pointer",
        fontFamily: "inherit",
        position: "relative",
        transition: "border-color 100ms",
        ...appearStyle,
      }}
    >
      <div
        style={{
          aspectRatio: "1 / 1",
          background: hover ? "var(--tb-n-4)" : "var(--tb-n-3)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          transition: "background 100ms",
        }}
      >
        <svg width="28" height="28" viewBox="0 0 28 28" fill="none">
          <path
            d="M14 6v16M6 14h16"
            stroke={hover ? "var(--tb-n-13)" : "var(--tb-n-10)"}
            strokeWidth="2"
            strokeLinecap="round"
          />
        </svg>
      </div>
      <div
        style={{
          padding: "4px 6px",
          textAlign: "left",
          display: "flex",
          flexDirection: "column",
          gap: 1,
        }}
      >
        <div
          style={{
            fontSize: 10,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
            color: hover ? "var(--tb-n-16)" : "var(--tb-n-13)",
          }}
        >
          New Project
        </div>
      </div>
    </button>
  );
}

// Thumbnail edge (square, matching the grid tile's 1:1 crop) and the gap
// to the name — detail rows only. The header's Title cell is indented by
// the same amount so the column still reads as one.
const DETAIL_THUMB = 40;
const DETAIL_THUMB_GAP = 10;

function ListView({
  rows,
  detail,
  sort,
  onSort,
  currentUserId,
  showAuthor,
  onLoad,
  onRate,
  staggerReady,
  onNewProject,
  folderCtx,
  leases,
  selectionCtx,
}: {
  rows: ProjectRow[];
  // Taller rows with a thumbnail in the leading column.
  detail: boolean;
  sort: { key: SortKey; dir: SortDir };
  onSort: (key: SortKey) => void;
  currentUserId: string | null;
  showAuthor: boolean;
  onLoad: (id: string) => void;
  onRate: (row: ProjectRow, x: number, y: number) => void;
  staggerReady: boolean;
  onNewProject?: () => void;
  folderCtx?: FolderCtx;
  leases?: Map<string, ActiveLease>;
  selectionCtx: SelectionCtx;
}) {
  const shown = useStaggerShown(staggerReady);
  const folders = folderCtx?.folders ?? [];
  const folderOffset = onNewProject ? 1 : 0;
  const offset = folderOffset + folders.length;
  // Grid so column widths are consistent between header and body rows.
  const grid = `${LIST_CHECK}px 1fr 160px 90px 140px`;
  // Rows in detail mode are thumbnail-tall, so their contents centre
  // against it rather than sitting on the text baseline.
  const rowStyle: React.CSSProperties = {
    display: "grid",
    gridTemplateColumns: grid,
    gap: 8,
    alignItems: "center",
    padding: detail ? "5px 6px" : "6px 6px",
    width: "100%",
    textAlign: "left",
    border: "none",
    borderBottom: "1px solid var(--tb-n-3)",
    fontFamily: "inherit",
    fontSize: "inherit",
    cursor: "pointer",
  };
  return (
    <div style={{ fontSize: detail ? 12 : 11 }}>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: grid,
          gap: 8,
          padding: "4px 6px",
          color: "var(--tb-n-13)",
          fontSize: 10,
          textTransform: "uppercase",
          letterSpacing: 0.5,
          borderBottom: "1px solid var(--tb-n-7)",
        }}
      >
        <span />
        <HeaderCell
          active={sort.key === "name"}
          dir={sort.key === "name" ? sort.dir : null}
          onClick={() => onSort("name")}
          style={
            detail ? { paddingLeft: DETAIL_THUMB + DETAIL_THUMB_GAP } : undefined
          }
        >
          Title
        </HeaderCell>
        <HeaderCell
          active={sort.key === "author"}
          dir={sort.key === "author" ? sort.dir : null}
          onClick={() => onSort("author")}
        >
          Author
        </HeaderCell>
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            color: "var(--tb-n-13)",
          }}
        >
          Rating
        </span>
        <HeaderCell
          active={sort.key === "date"}
          dir={sort.key === "date" ? sort.dir : null}
          onClick={() => onSort("date")}
        >
          Date
        </HeaderCell>
      </div>
      <div>
        {onNewProject && (
          <button
            onClick={onNewProject}
            title="Start a new, empty project"
            style={{
              ...rowStyle,
              background: "transparent",
              color: "var(--tb-n-13)",
              ...staggerStyle(shown, 0),
            }}
            onMouseEnter={(e) => (e.currentTarget.style.background = "var(--tb-n-3)")}
            onMouseLeave={(e) =>
              (e.currentTarget.style.background = "transparent")
            }
          >
            <span />
            <span
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: detail ? DETAIL_THUMB_GAP : 6,
                minWidth: 0,
              }}
            >
              {detail ? (
                <ThumbSlot>
                  <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
                    <path
                      d="M9 3v12M3 9h12"
                      stroke="var(--tb-n-10)"
                      strokeWidth="1.5"
                      strokeLinecap="round"
                    />
                  </svg>
                </ThumbSlot>
              ) : (
                <span
                  style={{ color: "var(--tb-n-10)", fontSize: 13, lineHeight: 1 }}
                >
                  +
                </span>
              )}
              New Project
            </span>
            <span />
            <span />
            <span />
          </button>
        )}
        {folderCtx &&
          folders.map((f, i) => (
            <FolderListRow
              key={f.id}
              folder={f}
              count={folderCtx.counts.get(f.id) ?? 0}
              ctx={folderCtx}
              rowStyle={rowStyle}
              detail={detail}
              style={staggerStyle(shown, i + folderOffset)}
            />
          ))}
        {rows.map((r, idx) => {
          const i = idx + offset;
          const isMine = !!currentUserId && currentUserId === r.user_id;
          const author = showAuthor
            ? isMine
              ? "you"
              : r.author?.display_name?.trim() || "unknown"
            : "you";
          const selected = selectionCtx.isSelected(r.id);
          const baseBg = selected ? "var(--tb-n-3)" : "transparent";
          const dragging = folderCtx?.dragProjectIds?.includes(r.id);
          return (
            <button
              key={r.id}
              onClick={() => {
                if (suppressClick) return;
                onLoad(r.id);
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                onRate(r, e.clientX, e.clientY);
              }}
              onPointerDown={
                folderCtx ? (e) => folderCtx.beginDragProject(e, r) : undefined
              }
              style={{
                ...rowStyle,
                background: baseBg,
                color: "var(--tb-n-16)",
                ...staggerStyle(shown, i),
                ...(dragging
                  ? { opacity: 0.3, transition: "opacity 120ms ease" }
                  : {}),
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = selected
                  ? "var(--tb-n-4)"
                  : "var(--tb-n-3)";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = baseBg;
              }}
            >
              <RowCheckbox
                checked={selected}
                onToggle={() => selectionCtx.toggle(r.id)}
              />
              <span
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: detail ? DETAIL_THUMB_GAP : 0,
                  minWidth: 0,
                }}
              >
                {detail && <RowThumb row={r} />}
                <span
                  style={{
                    minWidth: 0,
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                  }}
                >
                  {r.name}
                </span>
                {(() => {
                  const editing = leaseLabel(leases?.get(r.id), currentUserId);
                  return editing ? (
                    <span
                      style={{
                        color: "var(--tb-a-green-400)",
                        fontSize: 9,
                        flexShrink: 0,
                        marginLeft: 6,
                      }}
                    >
                      ● {editing}
                    </span>
                  ) : null;
                })()}
              </span>
              <span
                style={{
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  color: isMine ? "var(--tb-n-13)" : "var(--tb-n-11)",
                }}
              >
                {author}
              </span>
              <span style={{ color: "var(--tb-n-11)" }}>
                {r.ratings_count > 0 ? (
                  <>
                    <span style={{ color: "var(--tb-a-yellow-400)" }}>★</span>{" "}
                    {(r.ratings_avg ?? 0).toFixed(1)} ({r.ratings_count})
                  </>
                ) : (
                  <span style={{ color: "var(--tb-n-9)" }}>—</span>
                )}
              </span>
              <span style={{ color: "var(--tb-n-11)" }}>
                {new Date(r.updated_at).toLocaleDateString()}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// The fixed square a detail row leads with. Holds a screenshot, a folder
// glyph, or the New Project plus — whatever it wraps stays centred and
// every row keeps the same height.
function ThumbSlot({
  children,
  checker,
}: {
  children: React.ReactNode;
  // Checkerboard behind transparent screenshots; flat panel otherwise.
  checker?: boolean;
}) {
  return (
    <span
      style={{
        width: DETAIL_THUMB,
        height: DETAIL_THUMB,
        flexShrink: 0,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        overflow: "hidden",
        borderRadius: 3,
        border: "1px solid var(--tb-n-7)",
        background: checker
          ? "repeating-conic-gradient(var(--tb-n-3) 0% 25%, var(--tb-n-1) 0% 50%) 0 0 / 8px 8px"
          : "var(--tb-n-3)",
      }}
    >
      {children}
    </span>
  );
}

// Detail-row screenshot — the same source the grid tile uses, cropped
// square. Rows without a thumbnail keep the slot so the column stays flush.
function RowThumb({ row }: { row: ProjectRow }) {
  const src = thumbnailSrc(row);
  return (
    <ThumbSlot checker>
      {src ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={src}
          alt=""
          loading="lazy"
          // A native image-drag would steal the row's pointer gesture.
          draggable={false}
          style={{
            width: "100%",
            height: "100%",
            objectFit: "cover",
            display: "block",
          }}
        />
      ) : null}
    </ThumbSlot>
  );
}

function RowCheckbox({
  checked,
  onToggle,
}: {
  checked: boolean;
  onToggle: () => void;
}) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
      }}
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={() => onToggle()}
        aria-label={checked ? "Deselect project" : "Select project"}
        style={{
          width: 13,
          height: 13,
          margin: 0,
          cursor: "pointer",
          accentColor: "var(--tb-a-blue-400)",
        }}
      />
    </span>
  );
}

function HeaderCell({
  active,
  dir,
  onClick,
  style,
  children,
}: {
  active: boolean;
  dir: SortDir | null;
  onClick: () => void;
  // Detail view indents the Title header to clear the thumbnail column.
  style?: React.CSSProperties;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        background: "transparent",
        border: "none",
        padding: 0,
        color: active ? "var(--tb-n-16)" : "var(--tb-n-13)",
        fontFamily: "inherit",
        fontSize: "inherit",
        textTransform: "inherit",
        letterSpacing: "inherit",
        cursor: "pointer",
        textAlign: "left",
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        ...style,
      }}
    >
      <span>{children}</span>
      <span style={{ opacity: active ? 1 : 0.35, fontSize: 9 }}>
        {dir === "asc" ? "▲" : dir === "desc" ? "▼" : "▾"}
      </span>
    </button>
  );
}

// ========================================================================
// tile (grid view)
// ========================================================================

function ProjectTile({
  row,
  showAuthor,
  isMine,
  editingLabel,
  onLoad,
  onRate,
  appearStyle,
  beginDrag,
  dimmed,
  selected,
  onToggleSelection,
}: {
  row: ProjectRow;
  showAuthor: boolean;
  isMine: boolean;
  // Non-null when someone holds this project's editing lease (M3):
  // their display label ("you" for the viewer's own other window).
  editingLabel?: string | null;
  onLoad: (id: string) => void;
  onRate: (row: ProjectRow, x: number, y: number) => void;
  // Staggered fade-in style supplied by the parent grid.
  appearStyle: React.CSSProperties;
  // Private tab only: pointer-drag into a folder. A real drag suppresses
  // the click, so load-on-click is unaffected.
  beginDrag?: (e: React.PointerEvent) => void;
  // True while this tile's ghost is in flight — the source fades back.
  dimmed?: boolean;
  selected?: boolean;
  onToggleSelection?: () => void;
}) {
  const [hover, setHover] = useState(false);
  const authorLabel = isMine
    ? "you"
    : row.author?.display_name?.trim() || "unknown";
  const ratingLabel =
    row.ratings_count > 0
      ? `★ ${(row.ratings_avg ?? 0).toFixed(1)} (${row.ratings_count})`
      : "";
  const baseBg = selected ? "var(--tb-n-3)" : "var(--tb-n-1)";
  const hoverBg = selected ? "var(--tb-n-4)" : "var(--tb-n-3)";
  return (
    <button
      onClick={() => {
        if (suppressClick) return;
        onLoad(row.id);
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        onRate(row, e.clientX, e.clientY);
      }}
      onPointerDown={beginDrag}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      title={`${row.name}${showAuthor ? ` · by ${authorLabel}` : ""}${ratingLabel ? ` · ${ratingLabel}` : ""} · ${new Date(row.updated_at).toLocaleString()} · ${isMine ? "right-click to rate, rename or delete" : "right-click to rate"}`}
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "stretch",
        padding: 0,
        background: hover ? hoverBg : baseBg,
        border: `1px solid ${hover ? "var(--tb-n-9)" : "var(--tb-n-7)"}`,
        borderRadius: 4,
        overflow: "hidden",
        color: "var(--tb-n-16)",
        cursor: "pointer",
        fontFamily: "inherit",
        position: "relative",
        transition: "background 100ms, border-color 100ms",
        ...appearStyle,
        ...(dimmed ? { opacity: 0.3, transition: "opacity 120ms ease" } : {}),
      }}
    >
      <div
        style={{
          aspectRatio: "1 / 1",
          background:
            "repeating-conic-gradient(var(--tb-n-3) 0% 25%, var(--tb-n-1) 0% 50%) 0 0 / 12px 12px",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          overflow: "hidden",
        }}
      >
        {(() => {
          const src = thumbnailSrc(row);
          return src ? (
            // Storage URL (cache-busted via ?v=<updated_at>) for new
            // rows; legacy inline data URL for not-yet-migrated rows.
            // Either way the <img> handles it directly without any
            // Next image-optimizer config.
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={src}
              alt=""
              loading="lazy"
              // A native image-drag would steal the pointer gesture from
              // the tile's pointer-based drag.
              draggable={false}
              style={{
                width: "100%",
                height: "100%",
                objectFit: "cover",
                display: "block",
              }}
            />
          ) : (
            <span style={{ color: "var(--tb-n-10)", fontSize: 10 }}>no thumb</span>
          );
        })()}
        {ratingLabel && (
          <span
            style={{
              position: "absolute",
              top: 4,
              right: 4,
              padding: "1px 4px",
              borderRadius: 2,
              background: "rgba(0,0,0,0.6)",
              color: "var(--tb-a-yellow-400)",
              fontSize: 9,
              lineHeight: "12px",
              fontFamily: "inherit",
              pointerEvents: "none",
            }}
          >
            {ratingLabel}
          </span>
        )}
        {editingLabel && (
          <span
            style={{
              position: "absolute",
              top: 4,
              left: 4,
              padding: "1px 4px",
              borderRadius: 2,
              background: "rgba(0,0,0,0.6)",
              color: "var(--tb-a-green-400)",
              fontSize: 9,
              lineHeight: "12px",
              fontFamily: "inherit",
              pointerEvents: "none",
            }}
          >
            ● {editingLabel}
          </span>
        )}
      </div>
      <div
        style={{
          padding: "4px 6px",
          textAlign: "left",
          display: "flex",
          flexDirection: "column",
          gap: 1,
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 4,
            minWidth: 0,
          }}
        >
          {onToggleSelection && (
            <RowCheckbox
              checked={!!selected}
              onToggle={onToggleSelection}
            />
          )}
          <div
            style={{
              fontSize: 10,
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
              minWidth: 0,
              flex: 1,
            }}
          >
            {row.name}
          </div>
        </div>
        {showAuthor && (
          <div
            style={{
              fontSize: 9,
              color: isMine ? "var(--tb-n-13)" : "var(--tb-n-11)",
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            by {authorLabel}
          </div>
        )}
      </div>
    </button>
  );
}

// ========================================================================
// folders (Private tab): tiles, rows, rename, crumbs, context menu
// ========================================================================

// Inline rename field shown in place of a folder's name label. Commits
// on Enter/blur, cancels on Escape; the ref guard keeps the unmount blur
// from double-firing (or firing after an explicit cancel).
function FolderNameInput({
  initial,
  onCommit,
  onCancel,
}: {
  initial: string;
  onCommit: (name: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  const doneRef = useRef(false);
  const finish = (fn: () => void) => {
    if (doneRef.current) return;
    doneRef.current = true;
    fn();
  };
  return (
    <input
      autoFocus
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onFocus={(e) => e.currentTarget.select()}
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") finish(() => onCommit(value));
        else if (e.key === "Escape") finish(onCancel);
      }}
      onBlur={() => finish(() => onCommit(value))}
      style={{
        width: "100%",
        boxSizing: "border-box",
        background: "var(--tb-n-1)",
        border: "1px solid var(--tb-a-navy-tint)",
        borderRadius: 2,
        color: "var(--tb-n-16)",
        fontFamily: "inherit",
        fontSize: 10,
        padding: "1px 3px",
        outline: "none",
      }}
    />
  );
}

function FolderGlyph({ size, color }: { size: number; color: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <path
        d="M3 6.5A1.5 1.5 0 0 1 4.5 5h4.2a1.5 1.5 0 0 1 1.17.56L11.2 7.2h8.3A1.5 1.5 0 0 1 21 8.7V18a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18V6.5Z"
        fill={color}
      />
    </svg>
  );
}

function NewFolderIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
      <path
        d="M1.5 3h2.6l.9 1.1h5.5v5.4a.5.5 0 0 1-.5.5H2a.5.5 0 0 1-.5-.5V3Z"
        stroke="currentColor"
        strokeWidth="1"
        fill="none"
        strokeLinejoin="round"
      />
      <path
        d="M6 5.6v2.6M4.7 6.9h2.6"
        stroke="currentColor"
        strokeWidth="1"
        strokeLinecap="round"
      />
    </svg>
  );
}

// Grid-view folder: mirrors the ProjectTile footprint (square area +
// label strip) with a big glyph instead of a thumbnail. Click enters,
// right-click opens the context menu, pointer-drag moves it, and the
// drag hit test lands on its data-drop-target to file things into it.
function FolderTile({
  folder,
  count,
  ctx,
  appearStyle,
}: {
  folder: FolderRow;
  count: number;
  ctx: FolderCtx;
  appearStyle: React.CSSProperties;
}) {
  const [hover, setHover] = useState(false);
  const renaming = ctx.renameId === folder.id;
  const dropHot = ctx.dropHoverKey === `f:${folder.id}`;
  const dimmed = ctx.dragId === folder.id;
  const itemsLabel = `${count} item${count === 1 ? "" : "s"}`;
  return (
    <button
      onClick={() => {
        if (!renaming && !suppressClick) ctx.onOpen(folder.id);
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        ctx.onMenu(folder, e.clientX, e.clientY);
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onPointerDown={(e) => {
        if (!renaming) ctx.beginDragFolder(e, folder, count);
      }}
      data-drop-target={`f:${folder.id}`}
      title={`${folder.name} · ${itemsLabel} · right-click to rename or delete`}
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "stretch",
        padding: 0,
        background: "var(--tb-n-1)",
        border: `1px solid ${dropHot ? "var(--tb-a-navy-tint)" : hover ? "var(--tb-n-9)" : "var(--tb-n-7)"}`,
        boxShadow: dropHot ? "0 0 0 1px var(--tb-a-navy-tint) inset" : "none",
        borderRadius: 4,
        overflow: "hidden",
        color: "var(--tb-n-16)",
        cursor: "pointer",
        fontFamily: "inherit",
        position: "relative",
        transition: "border-color 100ms, opacity 120ms ease",
        ...appearStyle,
        ...(dimmed ? { opacity: 0.3 } : {}),
      }}
    >
      <div
        style={{
          aspectRatio: "1 / 1",
          background: dropHot ? "var(--tb-t-navy-d-2)" : hover ? "var(--tb-n-4)" : "var(--tb-n-3)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          transition: "background 100ms",
        }}
      >
        <FolderGlyph
          size={34}
          color={dropHot ? "#5b7fd4" : hover ? "var(--tb-n-13)" : "var(--tb-n-10)"}
        />
      </div>
      <div
        style={{
          padding: "4px 6px",
          textAlign: "left",
          display: "flex",
          flexDirection: "column",
          gap: 1,
        }}
      >
        {renaming ? (
          <FolderNameInput
            initial={folder.name}
            onCommit={(name) => ctx.onRenameCommit(folder.id, name)}
            onCancel={ctx.onRenameCancel}
          />
        ) : (
          <div
            style={{
              fontSize: 10,
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {folder.name}
          </div>
        )}
        <div style={{ fontSize: 9, color: "var(--tb-n-11)" }}>{itemsLabel}</div>
      </div>
    </button>
  );
}

// List-view folder row: same column grid as project rows so everything
// lines up; author/rating columns show a dash.
function FolderListRow({
  folder,
  count,
  ctx,
  rowStyle,
  detail,
  style,
}: {
  folder: FolderRow;
  count: number;
  ctx: FolderCtx;
  // Column grid + padding shared with the project rows around it.
  rowStyle: React.CSSProperties;
  detail: boolean;
  style: React.CSSProperties;
}) {
  const [hover, setHover] = useState(false);
  const renaming = ctx.renameId === folder.id;
  const dropHot = ctx.dropHoverKey === `f:${folder.id}`;
  const dimmed = ctx.dragId === folder.id;
  return (
    <button
      onClick={() => {
        if (!renaming && !suppressClick) ctx.onOpen(folder.id);
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        ctx.onMenu(folder, e.clientX, e.clientY);
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onPointerDown={(e) => {
        if (!renaming) ctx.beginDragFolder(e, folder, count);
      }}
      data-drop-target={`f:${folder.id}`}
      title={`${folder.name} · ${count} item${count === 1 ? "" : "s"} · right-click to rename or delete`}
      style={{
        ...rowStyle,
        background: dropHot ? "var(--tb-t-navy-d-2)" : hover ? "var(--tb-n-3)" : "transparent",
        color: "var(--tb-n-16)",
        ...style,
        ...(dimmed ? { opacity: 0.3, transition: "opacity 120ms ease" } : {}),
      }}
    >
      <span />
      <span
        style={{
          display: "flex",
          alignItems: "center",
          gap: detail ? DETAIL_THUMB_GAP : 6,
          minWidth: 0,
        }}
      >
        {detail ? (
          <ThumbSlot>
            <FolderGlyph
              size={22}
              color={dropHot ? "#5b7fd4" : "var(--tb-n-11)"}
            />
          </ThumbSlot>
        ) : (
          <span style={{ flexShrink: 0, display: "inline-flex" }}>
            <FolderGlyph
              size={13}
              color={dropHot ? "#5b7fd4" : "var(--tb-n-10)"}
            />
          </span>
        )}
        {renaming ? (
          <FolderNameInput
            initial={folder.name}
            onCommit={(name) => ctx.onRenameCommit(folder.id, name)}
            onCancel={ctx.onRenameCancel}
          />
        ) : (
          <span
            style={{
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {folder.name}
          </span>
        )}
      </span>
      <span style={{ color: "var(--tb-n-11)" }}>
        {count} item{count === 1 ? "" : "s"}
      </span>
      <span style={{ color: "var(--tb-n-9)" }}>—</span>
      <span style={{ color: "var(--tb-n-11)" }}>
        {new Date(folder.updated_at).toLocaleDateString()}
      </span>
    </button>
  );
}

// One breadcrumb chip. Navigates on click; while a drag is live the
// pointer hit test lands on its data-drop-target (move to that ancestor
// — "All" is the root), lighting it via dropHot.
function Crumb({
  label,
  target,
  current,
  onNavigate,
  dropHot,
}: {
  label: string;
  target: string | null;
  current?: boolean;
  onNavigate: (id: string | null) => void;
  dropHot: boolean;
}) {
  const [hover, setHover] = useState(false);
  return (
    <button
      onMouseDown={(e) => {
        e.preventDefault();
        if (!current) onNavigate(target);
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      data-drop-target={current ? undefined : target === null ? "root" : `f:${target}`}
      title={current ? label : `Go to ${label}`}
      style={{
        border: "none",
        background: dropHot ? "var(--tb-a-navy-deep)" : "transparent",
        color: current
          ? "var(--tb-n-16)"
          : dropHot
            ? "var(--tb-a-blue-200)"
            : hover
              ? "var(--tb-n-16)"
              : "var(--tb-n-12)",
        fontFamily: "inherit",
        fontSize: 11,
        lineHeight: 1,
        padding: "3px 4px",
        borderRadius: 3,
        maxWidth: 110,
        whiteSpace: "nowrap",
        overflow: "hidden",
        textOverflow: "ellipsis",
        cursor: current ? "default" : "pointer",
        transition: "background 80ms, color 80ms",
      }}
    >
      {label}
    </button>
  );
}

// Right-click menu on a folder: Rename / Delete. Same fixed-position,
// click-outside + Escape dismiss contract as RateProjectPopover.
function FolderMenuPopover({
  x,
  y,
  name,
  onClose,
  onRename,
  onDelete,
}: {
  x: number;
  y: number;
  name: string;
  onClose: () => void;
  onRename: () => void;
  onDelete: () => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current) return;
      if (rootRef.current.contains(e.target as globalThis.Node)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);
  const W = 160;
  const H = 76;
  const vw = typeof window !== "undefined" ? window.innerWidth : 0;
  const vh = typeof window !== "undefined" ? window.innerHeight : 0;
  const left = Math.max(8, Math.min(vw - W - 8, x));
  const top = Math.max(8, Math.min(vh - H - 8, y));
  const itemStyle = (danger: boolean, hot: boolean): React.CSSProperties => ({
    display: "block",
    width: "100%",
    textAlign: "left",
    background: hot ? (danger ? "var(--tb-t-red-d-1)" : "var(--tb-n-6)") : "transparent",
    border: "none",
    borderRadius: 3,
    color: danger ? "var(--tb-a-red-400)" : "var(--tb-n-16)",
    fontFamily: "inherit",
    fontSize: 11,
    padding: "5px 8px",
    cursor: "pointer",
  });
  return (
    <div
      ref={rootRef}
      style={{
        position: "fixed",
        left,
        top,
        width: W,
        background: "var(--tb-n-3)",
        border: "1px solid var(--tb-n-7)",
        borderRadius: 4,
        boxShadow: "0 6px 20px rgba(0,0,0,0.5)",
        padding: 4,
        zIndex: 4000,
        fontFamily: "var(--ui-font)",
      }}
      onMouseDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
    >
      <div
        style={{
          color: "var(--tb-n-13)",
          fontSize: 9,
          textTransform: "uppercase",
          letterSpacing: 0.5,
          padding: "3px 8px 5px",
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
        }}
      >
        {name}
      </div>
      <MenuItem
        label="Rename"
        onClick={() => {
          onClose();
          onRename();
        }}
        style={itemStyle}
      />
      <MenuItem
        label="Delete…"
        danger
        onClick={() => {
          onClose();
          onDelete();
        }}
        style={itemStyle}
      />
    </div>
  );
}

function MenuItem({
  label,
  danger,
  onClick,
  style,
}: {
  label: string;
  danger?: boolean;
  onClick: () => void;
  style: (danger: boolean, hot: boolean) => React.CSSProperties;
}) {
  const [hot, setHot] = useState(false);
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHot(true)}
      onMouseLeave={() => setHot(false)}
      style={style(!!danger, hot)}
    >
      {label}
    </button>
  );
}

// ========================================================================
// drag ghost
// ========================================================================

// The floating clone that follows the pointer during a drag. The OUTER
// div's translate3d is driven imperatively by useTileDrag's rAF loop
// (never transitioned — the lerp itself is the smoothing); the INNER div
// carries the presentational "lift": it scales up and gains a deep
// shadow one frame after mount, and the drop/cancel endings restyle the
// outer node directly. pointer-events:none keeps it invisible to the
// elementFromPoint drop hit test.
function DragGhost({
  drag,
  ghostRef,
}: {
  drag: DragState;
  ghostRef: React.RefObject<HTMLDivElement | null>;
}) {
  const [lifted, setLifted] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => setLifted(true));
    return () => cancelAnimationFrame(id);
  }, []);
  // The outer transform deliberately lives OUTSIDE the React style prop:
  // the rAF loop owns it, and if React also declared it, any re-render
  // (e.g. a drop-target highlight elsewhere in the grid) would write the
  // initial value back and snap the ghost to its start position. Seed it
  // here once, before first paint.
  useLayoutEffect(() => {
    const node = ghostRef.current;
    if (node) {
      node.style.transform = `translate3d(${drag.startLeft}px, ${drag.startTop}px, 0)`;
    }
  }, [drag, ghostRef]);
  return (
    <div
      ref={ghostRef}
      style={{
        position: "fixed",
        left: 0,
        top: 0,
        width: drag.width,
        zIndex: 5000,
        pointerEvents: "none",
        willChange: "transform",
        fontFamily: "var(--ui-font)",
      }}
    >
      <div
        style={{
          transform: lifted ? "scale(1.04)" : "scale(1)",
          transition: "transform 160ms ease, box-shadow 160ms ease",
          boxShadow: lifted
            ? "0 14px 32px rgba(0,0,0,0.55)"
            : "0 2px 8px rgba(0,0,0,0.3)",
          borderRadius: 4,
          border: "1px solid var(--tb-n-9)",
          background: "var(--tb-n-1)",
          overflow: "hidden",
          opacity: 0.95,
        }}
      >
        {drag.view === "grid" ? (
          <GhostTile drag={drag} />
        ) : (
          <GhostChip drag={drag} />
        )}
      </div>
    </div>
  );
}

// Grid-view ghost: full tile replica (thumb/glyph square + label strip).
function GhostTile({ drag }: { drag: DragState }) {
  const src = drag.row ? thumbnailSrc(drag.row) : null;
  const bulk =
    drag.projectIds && drag.projectIds.length > 1
      ? drag.projectIds.length
      : 0;
  return (
    <>
      <div
        style={{
          aspectRatio: "1 / 1",
          background: drag.row
            ? "repeating-conic-gradient(var(--tb-n-3) 0% 25%, var(--tb-n-1) 0% 50%) 0 0 / 12px 12px"
            : "var(--tb-n-3)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          overflow: "hidden",
        }}
      >
        {drag.row ? (
          src ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={src}
              alt=""
              draggable={false}
              style={{
                width: "100%",
                height: "100%",
                objectFit: "cover",
                display: "block",
              }}
            />
          ) : (
            <span style={{ color: "var(--tb-n-10)", fontSize: 10 }}>no thumb</span>
          )
        ) : (
          <FolderGlyph size={34} color="var(--tb-n-13)" />
        )}
      </div>
      <div
        style={{
          padding: "4px 6px",
          textAlign: "left",
          display: "flex",
          flexDirection: "column",
          gap: 1,
        }}
      >
        <div
          style={{
            fontSize: 10,
            color: "var(--tb-n-16)",
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {drag.row ? drag.row.name : (drag.folder?.name ?? "")}
        </div>
        {drag.folder && (
          <div style={{ fontSize: 9, color: "var(--tb-n-11)" }}>
            {drag.count} item{drag.count === 1 ? "" : "s"}
          </div>
        )}
        {bulk > 0 && (
          <div style={{ fontSize: 9, color: "var(--tb-n-11)" }}>
            {bulk} project{bulk === 1 ? "" : "s"}
          </div>
        )}
      </div>
    </>
  );
}

// List-view ghost: rows are panel-wide, so the ghost compacts to a chip
// (thumb/glyph + name) rather than hauling a full-width bar around.
function GhostChip({ drag }: { drag: DragState }) {
  const src = drag.row ? thumbnailSrc(drag.row) : null;
  const bulk =
    drag.projectIds && drag.projectIds.length > 1
      ? drag.projectIds.length
      : 0;
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        padding: "5px 8px",
      }}
    >
      {drag.row ? (
        src ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={src}
            alt=""
            draggable={false}
            style={{
              width: 18,
              height: 18,
              objectFit: "cover",
              borderRadius: 2,
              display: "block",
              flexShrink: 0,
            }}
          />
        ) : null
      ) : (
        <span style={{ display: "inline-flex", flexShrink: 0 }}>
          <FolderGlyph size={14} color="var(--tb-n-13)" />
        </span>
      )}
      <span
        style={{
          fontSize: 11,
          color: "var(--tb-n-16)",
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
        }}
      >
        {drag.row ? drag.row.name : (drag.folder?.name ?? "")}
        {bulk > 0 ? ` (${bulk})` : ""}
      </span>
    </div>
  );
}

// Folders follow the active sort where it makes sense; the "author"
// column has no folder equivalent so it falls back to name order.
function sortFolders(
  folders: FolderRow[],
  sort: { key: SortKey; dir: SortDir }
): FolderRow[] {
  const dir = sort.dir === "asc" ? 1 : -1;
  const cmp = (a: FolderRow, b: FolderRow): number =>
    sort.key === "date"
      ? (new Date(a.updated_at).getTime() - new Date(b.updated_at).getTime()) *
        dir
      : a.name.localeCompare(b.name) * dir;
  return [...folders].sort(cmp);
}

// ========================================================================
// sort helper
// ========================================================================

// "● editing" badge label for a project's active lease (M3): the
// holder's display name, "you" when it's the viewer's own other window,
// null when nobody holds it.
function leaseLabel(
  lease: ActiveLease | undefined,
  currentUserId: string | null
): string | null {
  if (!lease) return null;
  if (currentUserId && lease.userId === currentUserId) return "you";
  return lease.displayName?.trim() || "someone";
}

function sortRows(
  rows: ProjectRow[],
  sort: { key: SortKey; dir: SortDir },
  currentUserId: string | null
): ProjectRow[] {
  const dir = sort.dir === "asc" ? 1 : -1;
  const authorOf = (r: ProjectRow) => {
    if (currentUserId && r.user_id === currentUserId) return "you";
    return r.author?.display_name?.trim() || "unknown";
  };
  const cmp = (a: ProjectRow, b: ProjectRow): number => {
    switch (sort.key) {
      case "name":
        return a.name.localeCompare(b.name) * dir;
      case "author":
        return authorOf(a).localeCompare(authorOf(b)) * dir;
      case "date":
        return (
          (new Date(a.updated_at).getTime() -
            new Date(b.updated_at).getTime()) *
          dir
        );
    }
  };
  // Copy — we must not mutate the fetched array; React sees the same
  // reference as data and wouldn't re-render.
  return [...rows].sort(cmp);
}

// ========================================================================
// local recents (desktop "Local" tab)
// ========================================================================

function relTime(ms: number): string {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return "just now";
  const m = s / 60;
  if (m < 60) return `${Math.floor(m)}m ago`;
  const h = m / 60;
  if (h < 24) return `${Math.floor(h)}h ago`;
  const d = h / 24;
  if (d < 7) return `${Math.floor(d)}d ago`;
  return new Date(ms).toLocaleDateString();
}

function LocalBody({
  recents,
  onOpen,
  onRemove,
  staggerReady,
}: {
  recents: LocalRecent[] | null;
  onOpen: (path: string) => void;
  onRemove: (path: string) => void | Promise<void>;
  staggerReady: boolean;
}) {
  const shown = useStaggerShown(staggerReady && recents !== null);
  if (recents === null) {
    return (
      <div style={{ color: "var(--tb-n-11)", fontSize: 12, padding: 8 }}>Loading…</div>
    );
  }
  if (recents.length === 0) {
    return (
      <div
        style={{ color: "var(--tb-n-11)", fontSize: 12, padding: 8, lineHeight: 1.7 }}
      >
        No recent local projects yet.
        <br />
        Open or save a .toolbox file and it&apos;ll show up here.
      </div>
    );
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      {recents.map((r, i) => (
        <LocalRow
          key={r.path}
          recent={r}
          onOpen={onOpen}
          onRemove={onRemove}
          style={staggerStyle(shown, i)}
        />
      ))}
    </div>
  );
}

function LocalRow({
  recent,
  onOpen,
  onRemove,
  style,
}: {
  recent: LocalRecent;
  onOpen: (path: string) => void;
  onRemove: (path: string) => void | Promise<void>;
  style: React.CSSProperties;
}) {
  const [hover, setHover] = useState(false);
  const name = recent.name.replace(/\.toolbox$/i, "");
  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        borderRadius: 4,
        background: hover ? "var(--tb-n-3)" : "transparent",
        border: `1px solid ${hover ? "var(--tb-n-8)" : "transparent"}`,
        ...style,
      }}
    >
      <button
        onClick={() => onOpen(recent.path)}
        title={recent.path}
        style={{
          flex: 1,
          minWidth: 0,
          textAlign: "left",
          background: "transparent",
          border: "none",
          padding: "7px 10px",
          cursor: "pointer",
          fontFamily: "inherit",
          color: "var(--tb-n-16)",
        }}
      >
        <div
          style={{
            fontSize: 12,
            color: "var(--tb-n-16)",
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {name}
        </div>
        <div
          style={{
            fontSize: 10,
            color: "var(--tb-n-11)",
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
            marginTop: 1,
          }}
        >
          {relTime(recent.lastOpened)} · {recent.path}
        </div>
      </button>
      <button
        onClick={() => void onRemove(recent.path)}
        title="Remove from recents"
        aria-label="Remove from recents"
        style={{
          flexShrink: 0,
          width: 22,
          height: 22,
          marginRight: 6,
          borderRadius: 4,
          background: "transparent",
          border: "none",
          color: hover ? "var(--tb-n-13)" : "transparent",
          cursor: "pointer",
          fontSize: 14,
          lineHeight: 1,
        }}
      >
        ×
      </button>
    </div>
  );
}
