"use client";

import { useState } from "react";
import { TogglePill } from "@/lib/param-controls";
import type { SetVanitySlugResult } from "@/lib/supabase/projects";
import {
  displayVanityUrl,
  slugifyTitle,
  vanityPathFor,
} from "@/lib/vanity-slug";

// Project Settings → "live link" (specdocs/092126_vanity-live-links.md).
//
// The row is a deliberate two-step: flip the toggle, then hit Save. The
// write can fail on uniqueness (another of the owner's projects already
// sits at that address), so the draft has to be visible before it lands.
// The slug is FROZEN at save time — it's derived from the title when you
// save, not kept in sync with it, so renaming the project never silently
// moves a link you've already shared. When the title drifts, an "update
// link" action offers the new slug as a fresh draft.
//
// The random /live/<public_slug> link is never touched; the named link is
// an alias on top of it.

export interface LiveLinkSettingsProps {
  projectName: string;
  // A cloud row exists (null projectId = never saved).
  hasRow: boolean;
  ownedByMe: boolean;
  isPublic: boolean;
  // The owner's handle (the signed-in user's for own rows). `handleLoaded`
  // false while the profile fetch is in flight.
  handle: string | null;
  handleLoaded: boolean;
  // The saved vanity slug on the row (null = named link off).
  vanitySlug: string | null;
  onSave: (slug: string | null) => Promise<SetVanitySlugResult>;
}

type Draft = { slug: string | null };

export default function LiveLinkSettings({
  projectName,
  hasRow,
  ownedByMe,
  isPublic,
  handle,
  handleLoaded,
  vanitySlug,
  onSave,
}: LiveLinkSettingsProps) {
  // Derived-state pattern (FileNameMenu's name field): the draft follows
  // the saved value until the user diverges from it; a save elsewhere
  // (another window, a reload) re-seeds it.
  const [seenSaved, setSeenSaved] = useState<string | null>(vanitySlug);
  const [draft, setDraft] = useState<Draft>({ slug: vanitySlug });
  if (vanitySlug !== seenSaved) {
    setSeenSaved(vanitySlug);
    setDraft({ slug: vanitySlug });
  }
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const titleSlug = slugifyTitle(projectName);
  const enabled = draft.slug !== null;
  const dirty = draft.slug !== vanitySlug;
  const canMutate = hasRow && ownedByMe;
  const noHandle = handleLoaded && !handle;

  // Why the toggle is locked, if it is — the first applicable reason.
  const lockReason = !hasRow
    ? "Save the project to the cloud first."
    : !ownedByMe
      ? "Only the project's owner can change this."
      : !isPublic
        ? "Make the project public first — live links are public-only."
        : noHandle
          ? "Claim a handle from the account menu first."
          : !titleSlug && !enabled
            ? "The project title has no letters or numbers to build a URL from."
            : null;
  const locked = lockReason !== null || !handleLoaded;

  const origin = typeof window === "undefined" ? null : window.location.origin;
  const previewSlug = draft.slug ?? titleSlug;
  const previewUrl =
    handle && previewSlug ? displayVanityUrl(origin, handle, previewSlug) : null;
  const savedUrl =
    handle && vanitySlug && isPublic && origin
      ? `${origin}${vanityPathFor(handle, vanitySlug)}`
      : null;
  // Saved, and the title has since moved on: offer the new slug.
  const stale =
    vanitySlug !== null && titleSlug !== null && titleSlug !== vanitySlug;

  const toggle = (next: boolean) => {
    if (locked && !(enabled && !next && canMutate)) return;
    setError(null);
    setDraft({ slug: next ? titleSlug : null });
  };

  const cancel = () => {
    setError(null);
    setDraft({ slug: vanitySlug });
  };

  const save = async () => {
    if (busy || !dirty) return;
    setBusy(true);
    setError(null);
    try {
      const res = await onSave(draft.slug);
      if (!res.ok) {
        setError(describeFailure(res.reason));
      }
      // On success the parent updates `vanitySlug`, which re-seeds the
      // draft through the derived-state block above.
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    if (!savedUrl) return;
    try {
      await navigator.clipboard.writeText(savedUrl);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = savedUrl;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand("copy");
      } catch {
        // ignore
      }
      document.body.removeChild(ta);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <TogglePill
          on={enabled}
          onChange={toggle}
          // Turning OFF is always allowed on an owned row so a link can be
          // retired even when the project has since gone private.
          disabled={busy || (locked && !(enabled && canMutate))}
        />
        <span
          style={{
            color: locked && !enabled ? "var(--tb-n-10)" : "var(--tb-n-15)",
          }}
        >
          Use the project title in the live link
        </span>
      </div>

      {(previewUrl || lockReason) && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            minWidth: 0,
            fontSize: 10,
          }}
        >
          {previewUrl && (
            <span
              title={previewUrl}
              style={{
                flex: 1,
                minWidth: 0,
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
                color: enabled ? "var(--tb-n-14)" : "var(--tb-n-10)",
                textDecoration: enabled ? "none" : "line-through",
                fontFamily: "var(--mono-font, ui-monospace, monospace)",
              }}
            >
              {previewUrl}
            </span>
          )}
          {!dirty && savedUrl && (
            <button
              type="button"
              onClick={copy}
              style={{
                ...smallBtn(),
                background: copied ? "var(--tb-a-green-800)" : "transparent",
                color: copied ? "var(--tb-a-green-100)" : "var(--tb-n-15)",
                borderColor: copied ? "var(--tb-a-green-800)" : "var(--tb-n-9)",
              }}
            >
              {copied ? "Copied" : "Copy"}
            </button>
          )}
        </div>
      )}

      {lockReason && !enabled && (
        <div style={{ color: "var(--tb-n-10)", fontSize: 10, lineHeight: 1.4 }}>
          {lockReason}
        </div>
      )}

      {!dirty && stale && canMutate && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            color: "var(--tb-a-yellow-400)",
            fontSize: 10,
            lineHeight: 1.4,
          }}
        >
          <span style={{ flex: 1 }}>
            The title changed. The link still points here; update it to
            match?
          </span>
          <button
            type="button"
            onClick={() => {
              setError(null);
              setDraft({ slug: titleSlug });
            }}
            style={smallBtn()}
          >
            Update link
          </button>
        </div>
      )}

      {error && (
        <div
          style={{ color: "var(--tb-a-red-400)", fontSize: 10, lineHeight: 1.4 }}
        >
          {error}
        </div>
      )}

      {dirty && (
        <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
          <button type="button" onClick={cancel} disabled={busy} style={smallBtn()}>
            Cancel
          </button>
          <button
            type="button"
            onClick={save}
            disabled={busy || !canMutate}
            style={{
              ...smallBtn(),
              background: "var(--tb-a-green-600)",
              border: "1px solid var(--tb-a-green-600)",
              color: "var(--tb-a-green-100)",
              opacity: busy ? 0.6 : 1,
            }}
          >
            {busy ? "Saving…" : "Save"}
          </button>
        </div>
      )}
    </div>
  );
}

function describeFailure(reason: Exclude<SetVanitySlugResult, { ok: true }>["reason"]): string {
  switch (reason) {
    case "taken":
      return "Another of your projects already uses this address. Rename one of them first.";
    case "invalid":
      return "That title doesn't make a valid URL. Use letters, numbers, spaces or dashes.";
    case "conflict":
      return "This project was saved from another window — reload it before changing the link.";
    case "migration":
      return "Named live links aren't enabled on this database yet (run specdocs/vanity-live-links-migration.sql).";
    case "error":
      return "Couldn't save the link. Try again.";
  }
}

function smallBtn(): React.CSSProperties {
  return {
    padding: "3px 10px",
    background: "transparent",
    border: "1px solid var(--tb-n-9)",
    color: "var(--tb-n-15)",
    fontFamily: "inherit",
    fontSize: 10,
    borderRadius: 999,
    cursor: "pointer",
    whiteSpace: "nowrap",
  };
}
