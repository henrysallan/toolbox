"use client";

import Link from "next/link";
import { H1, H2, Lede, P, UL, LI, Code } from "../DocPage";

export default function WelcomePage() {
  return (
    <>
      <H1>Welcome</H1>
      <Lede>
        Toolbox is a node-based visual effects editor that runs in the
        browser. Drag nodes onto a canvas, wire them together, and see
        the result live.
      </Lede>

      <P>
        Every frame is a WebGL2 render pipeline, but you never have to
        write a shader. Instead, you compose primitives — images,
        splines, points, noise, text, audio — through a graph of
        nodes, each one a small operation with its own parameters.
      </P>

      <H2>What you can build</H2>
      <UL>
        <LI>Still images and animated loops, exported as PNG, WebM, or MP4.</LI>
        <LI>Generative systems driven by time, cursor, audio, or a webcam feed.</LI>
        <LI>Feedback simulations — reaction-diffusion, trails, accumulation.</LI>
        <LI>Type-driven compositions: splines from SVG, text layout, dither.</LI>
      </UL>

      <H2>How the rest of these docs are organized</H2>
      <UL>
        <LI>
          <strong style={{ color: "#e5e7eb" }}>Editor</strong> — how
          the graph works, keyboard shortcuts, save/load, public and
          private projects.
        </LI>
        <LI>
          <strong style={{ color: "#e5e7eb" }}>Node reference</strong>{" "}
          (coming soon) — what each node does, its parameters, and
          what plugs into what.
        </LI>
        <LI>
          <strong style={{ color: "#e5e7eb" }}>Data types</strong>{" "}
          (coming soon) — the socket colors, what they mean, and how
          to convert between them.
        </LI>
      </UL>

      <P>
        If you&rsquo;re brand new, start with{" "}
        <Link
          href="/docs/editor/basics"
          style={{ color: "#93c5fd", textDecoration: "underline" }}
        >
          Editor basics
        </Link>
        . If you just want the full shortcut list, jump to{" "}
        <Link
          href="/docs/editor/keyboard"
          style={{ color: "#93c5fd", textDecoration: "underline" }}
        >
          Keyboard shortcuts
        </Link>
        .
      </P>

      <H2>Getting back to the editor</H2>
      <P>
        Click the project name at the top-center of the docs header,
        or just hit browser back. Any unsaved graph you had open is
        waiting for you — docs is a round-trip, not a reset.
      </P>

      <P>
        <em style={{ color: "#71717a" }}>
          Tip: you can always re-open this documentation from any
          screen via the <Code>i</Code> button in the top menu bar.
        </em>
      </P>
    </>
  );
}
