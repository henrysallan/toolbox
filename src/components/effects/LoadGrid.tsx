"use client";

import { useEffect, useState } from "react";
import {
  invalidateProjectCaches,
  listPrivateProjects,
  listPublicProjects,
  thumbnailSrc,
  type ProjectRow,
} from "@/lib/supabase/projects";
import RateProjectPopover from "./RateProjectPopover";

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

type Tab = "private" | "public";
type View = "grid" | "list";
type SortKey = "name" | "author" | "date";
type SortDir = "asc" | "desc";

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
}

export default function LoadGrid({
  onLoad,
  signedIn,
  refreshKey,
  currentUserId,
  onNewProject,
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

  // Open sequence: the panel mounts with everything hidden, then the
  // chrome (tab bar) fades in first. The tiles handle their own
  // staggered fade once rows arrive, so the eye reads it as: menu bar
  // settles → projects cascade in.
  const [chromeIn, setChromeIn] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => setChromeIn(true));
    return () => cancelAnimationFrame(id);
  }, []);

  // If sign-in state flips to signed-out while we're on the Private
  // tab, bounce to Public. Done as a render-time reconciliation
  // against the previously-seen `signedIn` to avoid a setState-in-
  // effect cascade.
  const [seenSignedIn, setSeenSignedIn] = useState(signedIn);
  if (seenSignedIn !== signedIn) {
    setSeenSignedIn(signedIn);
    if (!signedIn && tab === "private") setTab("public");
  }

  // Reset rows to the loading state whenever the inputs change so
  // we don't flash stale data from the previous tab / refresh key.
  const fetchKey = `${tab}|${refreshKey ?? 0}|${manualRefresh}|${signedIn ? 1 : 0}`;
  const [seenFetchKey, setSeenFetchKey] = useState(fetchKey);
  if (seenFetchKey !== fetchKey) {
    setSeenFetchKey(fetchKey);
    setRows(null);
  }

  useEffect(() => {
    // Private tab shows a sign-in message when logged out (Body handles
    // that case via a prop check) — skip the doomed request entirely.
    if (tab === "private" && !signedIn) return;
    let cancelled = false;
    const loader =
      tab === "private" ? listPrivateProjects : listPublicProjects;
    loader().then((list) => {
      if (!cancelled) setRows(list);
    });
    return () => {
      cancelled = true;
    };
  }, [tab, signedIn, refreshKey, manualRefresh]);

  const sortedRows =
    rows && sortRows(rows, sort, currentUserId ?? null);

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
          view={view}
          onViewChange={setView}
          onRefresh={() => {
            // Drop the session cache so the refetch actually hits the
            // DB; otherwise the list call would return the cached rows
            // and defeat the whole point of the button.
            invalidateProjectCaches();
            setManualRefresh((n) => n + 1);
          }}
        />
      </div>
      <div
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: "auto",
          padding: 12,
        }}
      >
        <Body
          tab={tab}
          view={view}
          rows={sortedRows}
          sort={sort}
          onSort={toggleSort}
          signedIn={signedIn}
          currentUserId={currentUserId ?? null}
          onLoad={onLoad}
          onRate={(row, x, y) => setRatePopover({ row, x, y })}
          staggerReady={chromeIn}
          onNewProject={onNewProject}
        />
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
        />
      )}
    </div>
  );
}

// ========================================================================
// toolbar
// ========================================================================

function Toolbar({
  tab,
  onTabChange,
  signedIn,
  view,
  onViewChange,
  onRefresh,
}: {
  tab: Tab;
  onTabChange: (next: Tab) => void;
  signedIn: boolean;
  view: View;
  onViewChange: (next: View) => void;
  onRefresh: () => void;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        height: 28,
        flexShrink: 0,
        background: "#111113",
        borderBottom: "1px solid #27272a",
        padding: "0 6px",
        gap: 6,
        fontFamily: "inherit",
        fontSize: 11,
        color: "#e5e7eb",
        userSelect: "none",
      }}
    >
      <div style={{ display: "flex", gap: 2 }}>
        <MenuTab
          active={tab === "private"}
          disabled={!signedIn}
          onClick={() => onTabChange("private")}
          title={
            signedIn ? "Your saved projects" : "Sign in to see your projects"
          }
        >
          Private
        </MenuTab>
        <MenuTab
          active={tab === "public"}
          onClick={() => onTabChange("public")}
          title="Projects shared by the community"
        >
          Public
        </MenuTab>
      </div>
      <div style={{ flex: 1 }} />
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
      </div>
    </div>
  );
}

function MenuTab({
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
  const hot = hover && !disabled;
  // Mirrors EffectsApp's DockButton: near-invisible border at rest, a subtle
  // hover, and a soft blue highlight when active.
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
        borderRadius: 3,
        background: active ? "#1b2741" : hot ? "#19191c" : "transparent",
        border: `1px solid ${
          active ? "#26375f" : hot ? "#2a2a2e" : "#171719"
        }`,
        color: disabled
          ? "#3f3f46"
          : active
            ? "#bfdbfe"
            : hot
              ? "#e5e7eb"
              : "#8a8a90",
        fontFamily: "inherit",
        fontSize: 11,
        lineHeight: 1,
        cursor: disabled ? "not-allowed" : "pointer",
        transition: "background 80ms, border-color 80ms, color 80ms",
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
        background: active ? "#1b2741" : hover ? "#19191c" : "transparent",
        border: `1px solid ${
          active ? "#26375f" : hover ? "#2a2a2e" : "#171719"
        }`,
        borderRadius: 3,
        color: active ? "#bfdbfe" : hover ? "#e5e7eb" : "#8a8a90",
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
}) {
  if (tab === "private" && !signedIn) {
    return (
      <div style={{ color: "#52525b" }}>
        Sign in to see your saved projects.
      </div>
    );
  }
  if (rows === null) {
    return <div style={{ color: "#52525b" }}>Loading…</div>;
  }
  // Empty list: still surface the New Project entry on its own when the
  // landing supplies it, so the user is never stranded with no action.
  if (rows.length === 0 && !onNewProject) {
    return (
      <div style={{ color: "#52525b" }}>
        {tab === "private"
          ? "No saved projects yet — use File → Save."
          : "No public projects yet."}
      </div>
    );
  }
  if (view === "list") {
    return (
      <ListView
        rows={rows}
        sort={sort}
        onSort={onSort}
        currentUserId={currentUserId}
        showAuthor={tab === "public"}
        onLoad={onLoad}
        onRate={onRate}
        staggerReady={staggerReady}
        onNewProject={onNewProject}
      />
    );
  }
  return (
    <GridView
      rows={rows}
      currentUserId={currentUserId}
      showAuthor={tab === "public"}
      onLoad={onLoad}
      onRate={onRate}
      staggerReady={staggerReady}
      onNewProject={onNewProject}
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
}: {
  rows: ProjectRow[];
  currentUserId: string | null;
  showAuthor: boolean;
  onLoad: (id: string) => void;
  onRate: (row: ProjectRow, x: number, y: number) => void;
  staggerReady: boolean;
  onNewProject?: () => void;
}) {
  const shown = useStaggerShown(staggerReady);
  // The New Project tile, when present, takes slot 0 — project tiles
  // shift one place along in the cascade so it always fades first.
  const offset = onNewProject ? 1 : 0;
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
      {rows.map((r, i) => (
        <ProjectTile
          key={r.id}
          row={r}
          showAuthor={showAuthor}
          isMine={!!currentUserId && currentUserId === r.user_id}
          onLoad={onLoad}
          onRate={onRate}
          appearStyle={staggerStyle(shown, i + offset)}
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
        background: "#111113",
        border: `1px solid ${hover ? "#3f3f46" : "#27272a"}`,
        borderRadius: 4,
        overflow: "hidden",
        color: "#e5e7eb",
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
          background: hover ? "#1b1b1f" : "#161619",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          transition: "background 100ms",
        }}
      >
        <svg width="28" height="28" viewBox="0 0 28 28" fill="none">
          <path
            d="M14 6v16M6 14h16"
            stroke={hover ? "#a1a1aa" : "#52525b"}
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
            color: hover ? "#e5e7eb" : "#a1a1aa",
          }}
        >
          New Project
        </div>
      </div>
    </button>
  );
}

function ListView({
  rows,
  sort,
  onSort,
  currentUserId,
  showAuthor,
  onLoad,
  onRate,
  staggerReady,
  onNewProject,
}: {
  rows: ProjectRow[];
  sort: { key: SortKey; dir: SortDir };
  onSort: (key: SortKey) => void;
  currentUserId: string | null;
  showAuthor: boolean;
  onLoad: (id: string) => void;
  onRate: (row: ProjectRow, x: number, y: number) => void;
  staggerReady: boolean;
  onNewProject?: () => void;
}) {
  const shown = useStaggerShown(staggerReady);
  const offset = onNewProject ? 1 : 0;
  // Grid so column widths are consistent between header and body rows.
  const grid = "1fr 160px 90px 140px";
  return (
    <div style={{ fontSize: 11 }}>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: grid,
          gap: 8,
          padding: "4px 6px",
          color: "#a1a1aa",
          fontSize: 10,
          textTransform: "uppercase",
          letterSpacing: 0.5,
          borderBottom: "1px solid #27272a",
        }}
      >
        <HeaderCell
          active={sort.key === "name"}
          dir={sort.key === "name" ? sort.dir : null}
          onClick={() => onSort("name")}
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
            color: "#a1a1aa",
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
              display: "grid",
              gridTemplateColumns: grid,
              gap: 8,
              padding: "6px 6px",
              width: "100%",
              textAlign: "left",
              background: "transparent",
              border: "none",
              borderBottom: "1px solid #1a1a1d",
              color: "#a1a1aa",
              fontFamily: "inherit",
              fontSize: "inherit",
              cursor: "pointer",
              ...staggerStyle(shown, 0),
            }}
            onMouseEnter={(e) => (e.currentTarget.style.background = "#161619")}
            onMouseLeave={(e) =>
              (e.currentTarget.style.background = "transparent")
            }
          >
            <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
              <span style={{ color: "#52525b", fontSize: 13, lineHeight: 1 }}>
                +
              </span>
              New Project
            </span>
            <span />
            <span />
            <span />
          </button>
        )}
        {rows.map((r, idx) => {
          const i = idx + offset;
          const isMine = !!currentUserId && currentUserId === r.user_id;
          const author = showAuthor
            ? isMine
              ? "you"
              : r.author?.display_name?.trim() || "unknown"
            : "you";
          return (
            <button
              key={r.id}
              onClick={() => onLoad(r.id)}
              onContextMenu={(e) => {
                e.preventDefault();
                onRate(r, e.clientX, e.clientY);
              }}
              style={{
                display: "grid",
                gridTemplateColumns: grid,
                gap: 8,
                padding: "6px 6px",
                width: "100%",
                textAlign: "left",
                background: "transparent",
                border: "none",
                borderBottom: "1px solid #1a1a1d",
                color: "#e5e7eb",
                fontFamily: "inherit",
                fontSize: "inherit",
                cursor: "pointer",
                ...staggerStyle(shown, i),
              }}
              onMouseEnter={(e) =>
                (e.currentTarget.style.background = "#161619")
              }
              onMouseLeave={(e) =>
                (e.currentTarget.style.background = "transparent")
              }
            >
              <span
                style={{
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
              >
                {r.name}
              </span>
              <span
                style={{
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  color: isMine ? "#a1a1aa" : "#71717a",
                }}
              >
                {author}
              </span>
              <span style={{ color: "#71717a" }}>
                {r.ratings_count > 0 ? (
                  <>
                    <span style={{ color: "#facc15" }}>★</span>{" "}
                    {(r.ratings_avg ?? 0).toFixed(1)} ({r.ratings_count})
                  </>
                ) : (
                  <span style={{ color: "#3f3f46" }}>—</span>
                )}
              </span>
              <span style={{ color: "#71717a" }}>
                {new Date(r.updated_at).toLocaleDateString()}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function HeaderCell({
  active,
  dir,
  onClick,
  children,
}: {
  active: boolean;
  dir: SortDir | null;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        background: "transparent",
        border: "none",
        padding: 0,
        color: active ? "#e5e7eb" : "#a1a1aa",
        fontFamily: "inherit",
        fontSize: "inherit",
        textTransform: "inherit",
        letterSpacing: "inherit",
        cursor: "pointer",
        textAlign: "left",
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
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
  onLoad,
  onRate,
  appearStyle,
}: {
  row: ProjectRow;
  showAuthor: boolean;
  isMine: boolean;
  onLoad: (id: string) => void;
  onRate: (row: ProjectRow, x: number, y: number) => void;
  // Staggered fade-in style supplied by the parent grid.
  appearStyle: React.CSSProperties;
}) {
  const authorLabel = isMine
    ? "you"
    : row.author?.display_name?.trim() || "unknown";
  const ratingLabel =
    row.ratings_count > 0
      ? `★ ${(row.ratings_avg ?? 0).toFixed(1)} (${row.ratings_count})`
      : "";
  return (
    <button
      onClick={() => onLoad(row.id)}
      onContextMenu={(e) => {
        e.preventDefault();
        onRate(row, e.clientX, e.clientY);
      }}
      title={`${row.name}${showAuthor ? ` · by ${authorLabel}` : ""}${ratingLabel ? ` · ${ratingLabel}` : ""} · ${new Date(row.updated_at).toLocaleString()} · right-click to rate`}
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "stretch",
        padding: 0,
        background: "#111113",
        border: "1px solid #27272a",
        borderRadius: 4,
        overflow: "hidden",
        color: "#e5e7eb",
        cursor: "pointer",
        fontFamily: "inherit",
        position: "relative",
        ...appearStyle,
      }}
    >
      <div
        style={{
          aspectRatio: "1 / 1",
          background:
            "repeating-conic-gradient(#1a1a1a 0% 25%, #0f0f0f 0% 50%) 0 0 / 12px 12px",
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
              style={{
                width: "100%",
                height: "100%",
                objectFit: "cover",
                display: "block",
              }}
            />
          ) : (
            <span style={{ color: "#52525b", fontSize: 10 }}>no thumb</span>
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
              color: "#facc15",
              fontSize: 9,
              lineHeight: "12px",
              fontFamily: "inherit",
              pointerEvents: "none",
            }}
          >
            {ratingLabel}
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
            fontSize: 10,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {row.name}
        </div>
        {showAuthor && (
          <div
            style={{
              fontSize: 9,
              color: isMine ? "#a1a1aa" : "#71717a",
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
// sort helper
// ========================================================================

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
