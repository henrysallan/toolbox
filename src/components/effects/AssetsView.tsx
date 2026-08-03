"use client";

// Shared Assets view (v5 / assets spec). Mounted in two places: the Project
// view (via the Comps/Assets toggle) and the parameter panel (via File →
// Assets, the mount you drag assets from into the node editor).
//
// M-A1 ships the surface with empty states; M-A2 fills "In project" with
// bundled custom fonts, M-A3 fills "Folder" with the scanned/picked assets/
// folder, M-A4 makes the cards draggable into the node editor.
//
// See specdocs/062926_assets.md.

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

interface AssetsViewProps {
  assets?: AssetItem[];
  folderName?: string | null;
  // Web: pick an assets folder (File System Access API). Absent ⇒ no picker
  // (desktop auto-scans; or not yet wired).
  onPickFolder?: () => void;
}

export function AssetsView({
  assets = [],
  folderName,
  onPickFolder,
}: AssetsViewProps) {
  const bundled = assets.filter((a) => a.source === "bundled");
  const folder = assets.filter((a) => a.source === "folder");

  return (
    <div
      style={{
        height: "100%",
        minHeight: 0,
        display: "flex",
        flexDirection: "column",
        background: "var(--tb-n-0)",
        color: "var(--tb-n-16)",
        overflowY: "auto",
      }}
    >
      <AssetSection
        title="In project"
        hint="Custom fonts you add are bundled with the project and appear here."
        items={bundled}
      />
      <AssetSection
        title={folderName ? `Folder · ${folderName}` : "Folder"}
        hint={
          onPickFolder
            ? "Choose a folder of assets to reference alongside this project."
            : "Open a .toolbox that sits next to an assets/ folder to see its files here."
        }
        items={folder}
        action={
          onPickFolder
            ? { label: "Choose folder…", onClick: onPickFolder }
            : undefined
        }
      />
    </div>
  );
}

function AssetSection({
  title,
  hint,
  items,
  action,
}: {
  title: string;
  hint: string;
  items: AssetItem[];
  action?: { label: string; onClick: () => void };
}) {
  return (
    <div style={{ padding: "8px 10px" }}>
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
        <div
          style={{
            fontSize: 10,
            color: "var(--tb-n-10)",
            padding: "6px 2px",
            lineHeight: 1.5,
          }}
        >
          {hint}
        </div>
      ) : (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(96px, 1fr))",
            gap: 6,
          }}
        >
          {items.map((a) => (
            <AssetCard key={a.id} asset={a} />
          ))}
        </div>
      )}
    </div>
  );
}

function AssetCard({ asset }: { asset: AssetItem }) {
  return (
    <div
      title={`${asset.name} — drag into the node editor`}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = "copy";
        e.dataTransfer.setData(
          "application/x-toolbox-asset",
          JSON.stringify({
            source: asset.source,
            kind: asset.kind,
            ref: asset.ref,
            name: asset.name,
          })
        );
      }}
      style={{
        display: "flex",
        flexDirection: "column",
        borderRadius: 5,
        border: "1px solid var(--tb-n-5)",
        background: "var(--tb-n-1)",
        overflow: "hidden",
        cursor: "grab",
      }}
    >
      <div
        style={{
          aspectRatio: "1",
          background: "var(--tb-n-0)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: "var(--tb-n-10)",
          fontSize: 9,
          textTransform: "uppercase",
          letterSpacing: 0.5,
        }}
      >
        {asset.thumbnail ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={asset.thumbnail}
            alt={asset.name}
            style={{ width: "100%", height: "100%", objectFit: "contain" }}
          />
        ) : (
          asset.kind
        )}
      </div>
      <div
        style={{
          fontSize: 9,
          color: "var(--tb-n-13)",
          padding: "3px 5px",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {asset.name}
      </div>
    </div>
  );
}
