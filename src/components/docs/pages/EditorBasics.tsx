"use client";

import { H1, H2, H3, Lede, P, UL, LI, Code, Kbd } from "../DocPage";
import InPageToc from "../InPageToc";

export const TOC = [
  { id: "the-graph", title: "The graph" },
  { id: "the-parameters-panel", title: "The parameters panel" },
  { id: "saving-your-work", title: "Saving your work" },
];

export default function EditorBasicsPage() {
  return (
    <>
      <H1>Editor basics</H1>
      <Lede>
        The editor is three panes: a preview canvas on the left, a
        node graph on the upper right, and a parameters panel on the
        lower right. You wire nodes together in the graph; the canvas
        shows the result of whatever terminal node (usually{" "}
        <Code>Output</Code>) is active.
      </Lede>

      <InPageToc items={TOC} />

      <H2>The graph</H2>
      <P>
        Every node has inputs on its left edge and outputs on its
        right. Drag from an output to an input to wire them. Sockets
        are colored by data type: blue for image, pink for mask, green
        for UV, and so on — only matching colors can connect.
      </P>

      <H3>Adding a node</H3>
      <UL>
        <LI>
          Press <Kbd>Shift</Kbd> + <Kbd>A</Kbd> anywhere on the graph
          to open the search palette. Type to filter, arrow keys to
          navigate, <Kbd>Enter</Kbd> to add.
        </LI>
        <LI>
          Or use the <Code>Node</Code> menu in the top menu bar — same
          list, grouped into columns by data type (Image / Spline /
          Point / Audio) and role (Generator / Modifier / Utility).
        </LI>
        <LI>
          Drag an output wire out onto empty pane — when you let go,
          the search palette opens pre-filtered. Pick a node and
          it&rsquo;ll auto-wire itself to your drop.
        </LI>
      </UL>

      <H3>Connecting, disconnecting, splicing</H3>
      <UL>
        <LI>Drag from an output socket to an input to create a wire.</LI>
        <LI>Drag a node over an existing wire to splice it in.</LI>
        <LI>
          <Kbd>Alt</Kbd>+drag on a wire cuts it; <Kbd>Shift</Kbd>+drag
          merges two wires at a junction.
        </LI>
        <LI>
          To detach a node from its neighbors entirely: select it and{" "}
          <Kbd>Cmd</Kbd>+drag.
        </LI>
      </UL>

      <H3>Selecting and moving</H3>
      <UL>
        <LI>Left-click drags a marquee selection.</LI>
        <LI>Middle-click drags the canvas.</LI>
        <LI>
          Scroll zooms; two-finger trackpad swipe pans (the browser
          back-gesture is disabled so this feels natural).
        </LI>
      </UL>

      <H2>The parameters panel</H2>
      <P>
        Selecting a node shows its parameters on the lower right.
        Drag sliders to adjust; click the circle next to a param to
        <em> expose</em> it as a socket, so another node can drive it.
        When a param is driven by an incoming wire, its slider
        displays grayed out — the incoming value wins.
      </P>

      <H2>Saving your work</H2>
      <P>
        The file-name pill in the center of the menu bar shows the
        current project name with a colored dot: green = saved,
        yellow = unsaved changes, red = a save failed. Clicking the
        pill lets you rename the project or flip it between Public
        and Private.
      </P>
      <UL>
        <LI>
          <Kbd>⌘</Kbd>+<Kbd>S</Kbd> saves (or opens the name prompt
          if this is a fresh project).
        </LI>
        <LI>
          <Kbd>⇧</Kbd>+<Kbd>⌘</Kbd>+<Kbd>S</Kbd> is Save As (always
          prompts for a name).
        </LI>
        <LI>
          <Code>File → Save Incremental</Code> snapshots a numbered
          copy (<Code>foo_01</Code>, <Code>foo_02</Code>, …) without
          touching the current project.
        </LI>
      </UL>

      <H3>Public vs. Private</H3>
      <P>
        Your projects are private by default. Flipping a project to
        public (via the file-name pill) makes it visible to everyone
        in the Public tab of File → Load, attributed to your display
        name. Nobody but you can rename or overwrite it — if someone
        opens your public project and hits Save, their change forks a
        private copy of their own, leaving yours untouched.
      </P>
    </>
  );
}
