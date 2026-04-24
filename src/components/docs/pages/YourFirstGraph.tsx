"use client";

import Link from "next/link";
import {
  H1,
  H2,
  Lede,
  P,
  OL,
  UL,
  LI,
  Code,
  Kbd,
  Note,
} from "../DocPage";
import InPageToc from "../InPageToc";

export const TOC = [
  { id: "the-starting-graph", title: "The starting graph" },
  { id: "swap-the-source", title: "Swap the source" },
  { id: "add-an-effect", title: "Add an effect" },
  { id: "expose-a-parameter", title: "Expose a parameter" },
  { id: "save-it", title: "Save it" },
];

export default function YourFirstGraphPage() {
  return (
    <>
      <H1>Your first graph</H1>
      <Lede>
        Five minutes, end to end. We&rsquo;ll load an image, add an
        effect, drive one of its parameters with time, and save the
        result.
      </Lede>

      <InPageToc items={TOC} />

      <H2 id="the-starting-graph">The starting graph</H2>
      <P>
        A fresh project opens with three nodes already wired together:
        <Code>Image Source</Code> → <Code>Bloom</Code> → <Code>Output</Code>.
        The preview on the left shows whatever the <Code>Output</Code>{" "}
        node receives. It starts black because no image is loaded yet.
      </P>

      <H2 id="swap-the-source">Swap the source</H2>
      <OL>
        <LI>
          Click the <Code>Image Source</Code> node. The parameters
          panel on the lower right reveals an upload slot.
        </LI>
        <LI>
          Click it and pick an image file. The preview updates as
          soon as the image decodes.
        </LI>
        <LI>
          Alternatively, drag any image file directly onto the graph
          pane — it turns into a new Image Source node at the drop
          point.
        </LI>
      </OL>

      <H2 id="add-an-effect">Add an effect</H2>
      <P>
        Our graph already has <Code>Bloom</Code>, but let&rsquo;s
        layer another effect in. We&rsquo;ll add a gaussian blur
        between the image and the bloom.
      </P>
      <OL>
        <LI>
          Press <Kbd>Shift</Kbd>+<Kbd>A</Kbd>. The add-node search
          opens.
        </LI>
        <LI>
          Type <Code>gauss</Code>. <Code>Gaussian Blur</Code>{" "}
          filters to the top of the list. <Kbd>Enter</Kbd> drops it
          onto the graph.
        </LI>
        <LI>
          Drag the new node over the wire between Image Source and
          Bloom. The wire highlights yellow — release to splice the
          blur in. Both connections rewire automatically.
        </LI>
      </OL>

      <H2 id="expose-a-parameter">Expose a parameter</H2>
      <P>
        Select the <Code>Gaussian Blur</Code> node. In the parameters
        panel, notice the small empty circle to the left of the
        &ldquo;Radius&rdquo; slider — that&rsquo;s the expose toggle.
        Click it.
      </P>
      <P>
        A new <em>radius</em> input socket appears on the node in the
        graph. Anything that outputs a scalar value can drive the
        blur&rsquo;s radius through that socket.
      </P>
      <OL>
        <LI>
          <Kbd>Shift</Kbd>+<Kbd>A</Kbd>, type <Code>scene time</Code>, <Kbd>Enter</Kbd>.
        </LI>
        <LI>
          Drag from the new node&rsquo;s output into the Gaussian
          Blur&rsquo;s newly-exposed radius input.
        </LI>
        <LI>
          Hit <Kbd>Space</Kbd> or the play button on the timeline at
          the bottom. The blur pulses as scene time ticks forward.
        </LI>
      </OL>

      <Note>
        The exposed parameter&rsquo;s slider is now grayed out in the
        panel — the incoming wire is driving it. Disconnect the wire
        to get manual control back.
      </Note>

      <H2 id="save-it">Save it</H2>
      <P>
        Hit <Kbd>⌘</Kbd>+<Kbd>S</Kbd>. Since this is a new project,
        you&rsquo;ll be asked for a name. Anything goes — the save
        system will warn you if the name collides with another
        project of yours and offer to overwrite.
      </P>
      <P>
        The file-name pill at the top center of the menu bar now
        shows your chosen name with a green dot. Make any change and
        it flips yellow; hit <Kbd>⌘</Kbd>+<Kbd>S</Kbd> again and it
        goes back to green.
      </P>

      <H2 id="whats-next">What&rsquo;s next</H2>
      <UL>
        <LI>
          Read{" "}
          <Link
            href="/docs/editor/basics"
            style={{ color: "#93c5fd", textDecoration: "underline" }}
          >
            Editor basics
          </Link>{" "}
          for every gesture the graph responds to.
        </LI>
        <LI>
          Peek at{" "}
          <Link
            href="/docs/projects/saving"
            style={{ color: "#93c5fd", textDecoration: "underline" }}
          >
            Saving and loading
          </Link>{" "}
          for the difference between Save, Save As, and Save
          Incremental.
        </LI>
        <LI>
          Browse the node reference — one page per category,
          accessible from the sidebar.
        </LI>
      </UL>
    </>
  );
}
