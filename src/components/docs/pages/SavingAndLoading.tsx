"use client";

import Link from "next/link";
import { H1, H2, H3, Lede, P, UL, LI, Code, Kbd, Note } from "../DocPage";
import InPageToc from "../InPageToc";

export const TOC = [
  { id: "save-vs-save-as", title: "Save vs. Save As" },
  { id: "save-incremental", title: "Save Incremental" },
  { id: "the-save-state-dot", title: "The save-state dot" },
  { id: "name-collisions", title: "Name collisions and overwriting" },
  { id: "loading", title: "Loading a project" },
  { id: "thumbnails", title: "How thumbnails are stored" },
];

export default function SavingAndLoadingPage() {
  return (
    <>
      <H1>Saving and loading</H1>
      <Lede>
        Projects live in Supabase, scoped to your account. The editor
        is honest about save state at every moment so you always know
        whether the graph in front of you is safely persisted.
      </Lede>

      <InPageToc items={TOC} />

      <H2 id="save-vs-save-as">Save vs. Save As</H2>
      <UL>
        <LI>
          <Kbd>⌘</Kbd>+<Kbd>S</Kbd> saves the current project. If
          this is a new project without a name yet, it prompts you
          for one; otherwise it silently overwrites.
        </LI>
        <LI>
          <Kbd>⇧</Kbd>+<Kbd>⌘</Kbd>+<Kbd>S</Kbd> (or{" "}
          <Code>File → Save As…</Code>) always prompts, so you can
          fork the current graph into a new project row.
        </LI>
      </UL>

      <H2 id="save-incremental">Save Incremental</H2>
      <P>
        <Code>File → Save Incremental</Code> snapshots a numbered
        copy of the current project without touching the original.
        The name auto-increments trailing digits: <Code>foo</Code>{" "}
        becomes <Code>foo_01</Code>, then <Code>foo_02</Code>, and so
        on. Useful for version-pinning a known-good state before a
        big experiment.
      </P>

      <H2 id="the-save-state-dot">The save-state dot</H2>
      <P>
        The file-name pill in the center of the menu bar shows the
        current project&rsquo;s name with a colored dot on the left:
      </P>
      <UL>
        <LI>
          <strong style={{ color: "#22c55e" }}>Green</strong> — every
          change is saved.
        </LI>
        <LI>
          <strong style={{ color: "#eab308" }}>Yellow</strong> — you
          have unsaved changes since the last save.
        </LI>
        <LI>
          <strong style={{ color: "#ef4444" }}>Red</strong> — the
          last save attempt failed. Check your network, then retry.
          Making another edit drops the red state back to yellow so
          you can see the work is still dirty.
        </LI>
      </UL>
      <P>
        Clicking the pill opens a dropdown where you can rename the
        project and flip its visibility (public or private). Saving
        from there is equivalent to <Kbd>⌘</Kbd>+<Kbd>S</Kbd>.
      </P>

      <H2 id="name-collisions">Name collisions and overwriting</H2>
      <P>
        The Save As dialog and the rename field in the file-name pill
        both watch for name collisions against your existing
        projects. If you type a name that already exists, the button
        label flips from <strong>Save</strong> to{" "}
        <strong>Overwrite</strong> (and the hint line explains what
        will happen).
      </P>
      <P>
        This matters because the default name for a fresh project is
        &ldquo;Untitled&rdquo; — without collision detection, quickly
        hitting Save on a few new projects would quietly stack
        multiple rows with the same name.
      </P>
      <Note tone="warning">
        Rename-to-overwrite is more aggressive than save-to-overwrite.
        Renaming project A to a name that another project B already
        has will write A&rsquo;s graph into B&rsquo;s row and{" "}
        <em>delete</em> A&rsquo;s old row. The pill&rsquo;s dropdown
        spells this out before you click.
      </Note>

      <H3 id="new-vs-load">File → New</H3>
      <P>
        Starting a new project from an unsaved graph pops a confirm
        with Save / Don&rsquo;t save / Cancel. Save routes through
        the normal save flow and only resets the editor after the
        save completes. Don&rsquo;t save discards the current work.
        Cancel keeps everything as is.
      </P>

      <H2 id="loading">Loading a project</H2>
      <P>
        <Code>File → Load…</Code> swaps the lower-right panel into a
        project browser with two tabs: <strong>Private</strong>{" "}
        (your projects) and <strong>Public</strong> (everyone
        else&rsquo;s shared work). Both tabs support a grid view and
        a list view with sortable columns; toggle between the two
        with the icons on the right of the load-panel toolbar.
      </P>
      <P>
        The refresh icon next to the view toggles re-pulls the
        listing from the database. Under the hood, listings are
        cached in memory for the session (up to an hour) so opening
        the Load panel repeatedly doesn&rsquo;t re-bill you every
        time. Saves and deletes invalidate the cache automatically —
        you&rsquo;ll only reach for the refresh button to see other
        people&rsquo;s recent changes.
      </P>

      <H2 id="thumbnails">How thumbnails are stored</H2>
      <P>
        Thumbnails come from a 256px JPEG snapshot of whatever the
        canvas is showing at save time. Newer saves store thumbnails
        in Supabase Storage and serve them via the CDN; older
        pre-migration projects keep a base64 data URL inline in the
        row. Both render identically — the difference is invisible
        except that Storage thumbnails don&rsquo;t bloat list-query
        bandwidth.
      </P>
      <P>
        If you ever see a stale thumbnail, it&rsquo;s the CDN cache.
        A re-save bumps the cache-busting parameter on the URL, so
        the next view picks up the new bytes.
      </P>

      <P>
        Next:{" "}
        <Link
          href="/docs/projects/public-private"
          style={{ color: "#93c5fd", textDecoration: "underline" }}
        >
          Public vs. private projects
        </Link>{" "}
        — the rules when you&rsquo;re working on someone else&rsquo;s
        graph.
      </P>
    </>
  );
}
