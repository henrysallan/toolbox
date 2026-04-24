"use client";

import { H1, H2, Lede, P, UL, LI, Code, Note } from "../DocPage";
import InPageToc from "../InPageToc";

export const TOC = [
  { id: "making-a-project-public", title: "Making a project public" },
  { id: "who-sees-what", title: "Who sees what" },
  { id: "ownership-rules", title: "Ownership rules" },
  { id: "save-a-copy", title: "Saving a copy of someone else's project" },
  { id: "authorship", title: "Authorship display" },
];

export default function PublicPrivatePage() {
  return (
    <>
      <H1>Public vs. private projects</H1>
      <Lede>
        Every project you save is private by default. Flipping one to
        public lets anyone open it and remix it — without risking
        your original.
      </Lede>

      <InPageToc items={TOC} />

      <H2 id="making-a-project-public">Making a project public</H2>
      <UL>
        <LI>Click the file-name pill in the menu bar.</LI>
        <LI>
          Flip the <strong>Public / Private</strong> toggle.
        </LI>
        <LI>
          Confirm the change in the modal. Public and private can be
          flipped either direction at any time.
        </LI>
      </UL>
      <P>
        Only the owner of a project can flip its visibility. The
        toggle in the pill grays out when you&rsquo;re viewing
        someone else&rsquo;s public project.
      </P>

      <H2 id="who-sees-what">Who sees what</H2>
      <UL>
        <LI>
          <strong>Private projects</strong> appear only in your own
          Private tab under File → Load. Nobody else can see or open
          them.
        </LI>
        <LI>
          <strong>Public projects</strong> appear in the Public tab
          for everyone, including visitors who aren&rsquo;t signed
          in. Authorship is displayed next to the title.
        </LI>
        <LI>
          Your own public projects also show up in your Private tab
          (so you never lose track of them).
        </LI>
      </UL>

      <H2 id="ownership-rules">Ownership rules</H2>
      <P>
        Ownership is enforced by row-level security in the database,
        so the rules below are literally guaranteed — not just UI
        conventions:
      </P>
      <UL>
        <LI>
          The user who first saved the project is the permanent owner.
        </LI>
        <LI>
          Only the owner can <Code>rename</Code>, <Code>overwrite</Code>,
          or <Code>delete</Code> the project.
        </LI>
        <LI>
          Only the owner can change visibility.
        </LI>
        <LI>
          Anyone who&rsquo;s signed in (plus anonymous visitors, once
          search is wired up) can <em>view</em> a public project.
        </LI>
      </UL>

      <H2 id="save-a-copy">Saving a copy of someone else&rsquo;s project</H2>
      <P>
        If you open a public project authored by someone else and
        start editing, the menu-bar pill dims its rename field and
        visibility toggle — you can&rsquo;t mutate the original.
        Hitting Save in this state does something different: it{" "}
        <strong>forks a private copy</strong> into your own account.
      </P>
      <UL>
        <LI>
          The new copy&rsquo;s name is the original with{" "}
          <Code>_copy</Code> appended.
        </LI>
        <LI>
          The copy starts private, regardless of the original&rsquo;s
          visibility.
        </LI>
        <LI>
          From that point on you own the copy, and all the normal
          rename / overwrite / visibility controls apply.
        </LI>
        <LI>
          A <Code>saved a copy</Code> toast confirms what happened.
        </LI>
      </UL>

      <Note>
        This means it&rsquo;s impossible to accidentally stomp on
        someone else&rsquo;s public work, even if you forget you
        opened their project. Save always preserves the original.
      </Note>

      <H2 id="authorship">Authorship display</H2>
      <P>
        Public project tiles show <em>&ldquo;by &lt;display
        name&gt;&rdquo;</em> under the title. The display name comes
        from your OAuth profile — whatever Google passed through at
        signup, stored in a public profiles table.
      </P>
      <P>
        Projects you authored show as <em>&ldquo;by you&rdquo;</em>{" "}
        in the Public tab, so you can spot your own public work
        mixed in with the feed.
      </P>
    </>
  );
}
