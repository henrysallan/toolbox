"use client";

import {
  H1,
  H2,
  Lede,
  P,
  UL,
  LI,
  Code,
  Note,
  Table,
  Th,
  Td,
} from "../DocPage";
import InPageToc from "../InPageToc";

export const TOC = [
  { id: "spreadsheet-panel", title: "The Spreadsheet panel" },
  { id: "built-in-data", title: "Built-in point data" },
  { id: "named-attributes", title: "Named attributes" },
  { id: "set-named-attribute", title: "Writing: Set Named Attribute" },
  { id: "point-expression", title: "Writing: Point Expression" },
  { id: "attribute-ops", title: "Math, Blur, Transfer" },
  { id: "spline-attributes", title: "Attributes on splines" },
  { id: "how-attributes-flow", title: "How attributes flow" },
  { id: "current-limits", title: "Current limits" },
];

export default function PointAttributesPage() {
  return (
    <>
      <H1>Point data &amp; the Spreadsheet</H1>
      <Lede>
        Every points wire carries a small table of per-point data — position,
        scale, rotation, group — and can carry your own named channels
        (&ldquo;attributes&rdquo;) on top, like Blender&rsquo;s geometry
        attributes. The Spreadsheet panel shows that table live for whatever
        node you select.
      </Lede>

      <InPageToc items={TOC} />

      <H2 id="spreadsheet-panel">The Spreadsheet panel</H2>
      <P>
        Click any panel&rsquo;s editor-kind chip (top-left corner) and pick
        <strong> Spreadsheet</strong>. The panel follows your selection: click
        a node in the node editor and the table shows the data flowing out of
        it — one row per point, one column per channel. It updates live while
        the graph plays.
      </P>
      <UL>
        <LI>
          <strong>Socket dropdown</strong> — a node with several outputs (a
          primary plus auxes) exposes them all here; the colored dot shows the
          selected socket&rsquo;s type.
        </LI>
        <LI>
          <strong>Pin</strong> — freezes the panel on the current node and
          socket so it stops following selection. Pin a node, then keep
          editing upstream and watch its numbers react.
        </LI>
        <LI>
          <strong>norm / px</strong> — 2D positions are stored normalized
          (0–1 on each axis, y down). The px toggle multiplies x by canvas
          width and y by canvas height.
        </LI>
        <LI>
          Splines (one row per anchor) and lists (one row per item) get
          tables too; other socket types show a one-line summary.
        </LI>
      </UL>
      <P>
        The table works even on a node whose branch isn&rsquo;t connected to
        anything — the panel quietly forces that node to evaluate, exactly
        like the hover peek on an output socket.
      </P>

      <H2 id="built-in-data">Built-in point data</H2>
      <P>
        Every points value has a fixed set of built-in channels. Some are
        always present, the rest exist only when a node upstream produced
        them:
      </P>
      <Table>
        <thead>
          <tr>
            <Th>Column</Th>
            <Th>Meaning</Th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <Td>
              <Code>index</Code>
            </Td>
            <Td>
              The point&rsquo;s position in the list — its identity. Not
              stored anywhere; it simply is the row number.
            </Td>
          </tr>
          <tr>
            <Td>
              <Code>x, y</Code> (and <Code>z</Code> for 3D)
            </Td>
            <Td>
              Position. 2D points are normalized canvas space; 3D points are
              world-space meters.
            </Td>
          </tr>
          <tr>
            <Td>
              <Code>scale x, scale y</Code>
            </Td>
            <Td>Per-point scale, consumed by Copy to Points and friends.</Td>
          </tr>
          <tr>
            <Td>
              <Code>rotation</Code>
            </Td>
            <Td>Per-point rotation (shown in degrees).</Td>
          </tr>
          <tr>
            <Td>
              <Code>group</Code>
            </Td>
            <Td>
              An identity tag assigned by Collect and friends — which source
              a point came from. Group-aware nodes (Group Pick, Copy to
              Points&rsquo; variant picking) key off it.
            </Td>
          </tr>
          <tr>
            <Td>
              <Code>nx, ny, nz</Code>
            </Td>
            <Td>Surface normals on 3D scattered points.</Td>
          </tr>
        </tbody>
      </Table>

      <H2 id="named-attributes">Named attributes</H2>
      <P>
        On top of the built-ins, points can carry any number of{" "}
        <strong>named channels</strong> you define — a <Code>weight</Code>{" "}
        per point, an <Code>age</Code>, a <Code>color</Code>. A channel has a
        name, a type (float, vec2–vec4, or color), and one value per point.
        Once written, it travels down the wire through every point node —
        transforms, filters, merges, simulations — and shows up as an extra
        column in the Spreadsheet.
      </P>
      <UL>
        <LI>Float channels show as a numeric column.</LI>
        <LI>
          Vector channels expand into per-component columns
          (<Code>name.x</Code>, <Code>name.y</Code>, …).
        </LI>
        <LI>Color channels show as swatches.</LI>
        <LI>A channel a point doesn&rsquo;t have reads as 0.</LI>
      </UL>
      <Note>
        Names are yours to choose, except the built-in column names
        (<Code>x</Code>, <Code>y</Code>, <Code>index</Code>,{" "}
        <Code>rotation</Code>, <Code>scale</Code>, <Code>group</Code>, …) —
        those are reserved and writes to them are ignored.
      </Note>
      <Note>
        Accumulator (points mode) and Advect Points (accumulate mode) stamp
        a well-known <Code>age</Code> channel: seconds since each point
        joined that node&rsquo;s state. Map Attribute can drive scale from
        it; Filter Points can drop old points. The node owns the name
        — an incoming <Code>age</Code> is overwritten.
      </Note>

      <H2 id="set-named-attribute">Writing: Set Named Attribute</H2>
      <P>
        The <strong>Set Named Attribute</strong> node (point category) is the
        direct way to author a channel. Wire points (or a spline — see
        below) through it, type the name right on the node body, pick a
        type, and choose where the values come from:
      </P>
      <UL>
        <LI>
          <strong>Constant</strong> — one value (or color) for every point.
        </LI>
        <LI>
          <strong>Index</strong> — a 0→1 ramp across point order, remapped
          through Lo/Hi. The classic &ldquo;gradient along the
          points&rdquo; driver.
        </LI>
        <LI>
          <strong>Random</strong> — a per-point random that is stable across
          frames (hashed on index + seed), so values don&rsquo;t flicker
          during playback.
        </LI>
        <LI>
          <strong>Image</strong> — samples the wired image at each
          point&rsquo;s position: luminance for float channels, RGBA for
          color channels. Scatter points over a photo and give each point
          the photo&rsquo;s color.
        </LI>
      </UL>
      <P>
        Stack several Set Named Attribute nodes to build up multiple
        channels; same-name writes replace the previous channel.
      </P>
      <Note>
        Set Named Attribute (and Attribute Math) also output the
        channel&rsquo;s <strong>name</strong> as a string socket. Expose
        the name field on any downstream attribute node (the ⊕ toggle in
        its parameter row) and wire the two together — now renaming the
        channel at the source updates every consumer at once. The wire
        carries the <em>reference</em>; the data itself always rides the
        points wire.
      </Note>

      <H2 id="point-expression">Writing: Point Expression</H2>
      <P>
        Point Expression can read and write channels from code, which makes
        attributes programmable:
      </P>
      <UL>
        <LI>
          <Code>attr(&quot;weight&quot;)</Code> reads the current
          point&rsquo;s <Code>weight</Code> (0 if absent).{" "}
          <Code>attr(&quot;color&quot;, 1)</Code> reads a specific component
          of a multi-component channel.
        </LI>
        <LI>
          <Code>setattr(&quot;age&quot;, t)</Code> writes a float channel at
          the current point, creating it if needed.
        </LI>
      </UL>
      <P>
        For example, cull by a channel written upstream:{" "}
        <Code>keep = attr(&quot;weight&quot;) &gt; 0.5</Code>. Or bake a
        computed value for downstream inspection:{" "}
        <Code>setattr(&quot;dist&quot;, hypot(px - 0.5, py - 0.5))</Code>.
      </P>
      <Note>
        Reads always see the <em>incoming</em> value — a{" "}
        <Code>setattr</Code> in the same expression isn&rsquo;t visible to{" "}
        <Code>attr</Code>, so results never depend on the order points are
        processed in.
      </Note>
      <P>
        Point Expression also runs on <strong>spline anchors</strong>: set
        its Target to &ldquo;spline anchors&rdquo; and the same code runs
        once per anchor — read <Code>px/py</Code>, the handle offsets{" "}
        <Code>inx0/iny0/outx0/outy0</Code>, <Code>width0</Code>, and{" "}
        <Code>subpath</Code>; write <Code>x, y, inx, iny, outx, outy,
        width</Code>, and <Code>keep</Code>. <Code>attr()</Code> reads
        anchor channels (falling back to the subpath&rsquo;s) and{" "}
        <Code>setattr()</Code> writes them.
      </P>

      <H2 id="attribute-ops">Math, Blur, Transfer</H2>
      <P>
        Three companion nodes operate on channels directly. Everywhere a
        node asks for an attribute name, the field offers a dropdown of the
        channels actually present on the wired input — pick one, or type a
        new name freely.
      </P>
      <UL>
        <LI>
          <strong>Attribute Math</strong> — componentwise
          add/subtract/multiply/divide/min/max/power against a constant{" "}
          <em>or a second channel</em>, plus a Remap operation that fits a
          range onto another. Writes in place, or to a new name via the
          Output field.
        </LI>
        <LI>
          <strong>Attribute Blur</strong> — smooths a channel: each
          iteration moves every point&rsquo;s value toward its
          neighborhood&rsquo;s mean. Spatial domain averages within a
          radius; Index domain averages adjacent points in order — the
          right choice for path-ordered points (Points from Spline, Points
          on Path).
        </LI>
        <LI>
          <strong>Attribute Transfer</strong> — copies a channel from a
          second point set by proximity: nearest source point, or a
          distance-weighted average within a radius (falling back to
          nearest, so every point gets a value). Scatter over a photo, Set
          Named Attribute its colors, then transfer them onto any other
          point set.
        </LI>
        <LI>
          <strong>Map Attribute</strong> — the bridge to visible motion:
          remap any point column (a named channel, or a built-in like{" "}
          <Code>index</Code>, <Code>x</Code>, <Code>y</Code>,{" "}
          <Code>scale.x</Code>, <Code>rotation</Code>, <Code>group</Code>)
          through In/Out ranges, shape it with a 0–1 curve, and apply it
          as a scale multiplier, rotation offset, or position offset.
        </LI>
      </UL>
      <P>
        Channels also drive three existing nodes: <strong>Filter
        Points</strong> gained an attribute mode (keep points whose channel
        clears a threshold); <strong>Copy to Points</strong> reads channels
        three ways — a Tint attribute (each copy&rsquo;s color, image
        mode), an Opacity attribute (each copy&rsquo;s alpha, image mode),
        and an &ldquo;attribute&rdquo; variant pick (which variant lands on
        each point, every mode — the channel&rsquo;s 0–1 value spreads
        across the variant set exactly like image luminance); and{" "}
        <strong>Point Labels / Points to Text</strong> templates accept{" "}
        <Code>{"{attr:name}"}</Code> alongside <Code>{"{x}"}</Code> and
        friends. <strong>Points to String</strong> joins a column (built-in
        or named) into one caption — comma-separated, one per line, or a
        grid — and wires into a Text node&rsquo;s text.
      </P>

      <H2 id="spline-attributes">Attributes on splines</H2>
      <P>
        Splines carry named channels too, on two domains: per{" "}
        <strong>anchor</strong> (like the built-in width profile) and per{" "}
        <strong>subpath</strong> (like the group tag). Set Named
        Attribute&rsquo;s Target parameter picks the domain; the input
        socket retypes to spline automatically. Spline channels survive the
        editing operations that copy anchors — trims, joins, transforms —
        and show in the Spreadsheet&rsquo;s spline table (subpath channels
        repeat across their anchors, labeled &ldquo;(subpath)&rdquo;).
      </P>
      <Note>
        Math, Blur, and Transfer operate on point channels today; spline
        channels are authored and inspected, and ride along until you
        convert (Points from Spline keeps its anchors&rsquo; order, so an
        anchor-domain workflow usually converts to points first).
      </Note>

      <H2 id="how-attributes-flow">How attributes flow</H2>
      <P>
        You shouldn&rsquo;t have to think about this — channels just follow
        the points — but the rules are simple and worth knowing:
      </P>
      <UL>
        <LI>
          <strong>Transforms</strong> (Transform, Jitter, Modulate, …) pass
          channels through untouched.
        </LI>
        <LI>
          <strong>Filters and picks</strong> keep each surviving
          point&rsquo;s values.
        </LI>
        <LI>
          <strong>Collect</strong> unions channels across its inputs; points
          from an input that lacks a channel read 0.
        </LI>
        <LI>
          <strong>Lerp</strong> blends channels both sides share; A-side-only
          channels carry.
        </LI>
        <LI>
          <strong>Proximity Merge</strong> blends each cluster toward its
          average value.
        </LI>
        <LI>
          <strong>Copy to Points</strong> (point mode) stamps the{" "}
          <em>target</em> point&rsquo;s channels onto every copy it places
          there.
        </LI>
        <LI>
          <strong>Simulators</strong> re-read channels from their seed input
          each frame, so animated upstream values keep flowing while
          positions simulate. Accumulator and Advect Points (accumulate)
          overlay their own <Code>age</Code> after that.
        </LI>
      </UL>

      <H2 id="current-limits">Current limits</H2>
      <UL>
        <LI>
          <Code>setattr</Code> writes float channels only — use Set Named
          Attribute for vectors and colors.
        </LI>
        <LI>
          3D is behind 2D: channels flow through <Code>points3d</Code>{" "}
          values, but the attribute nodes accept 2D points only, and 3D
          instancing doesn&rsquo;t read channels yet (Instance
          Color&rsquo;s attribute source is planned).
        </LI>
        <LI>
          Channels live on the wire, not in the file — they are recomputed
          from the graph on load, never saved.
        </LI>
      </UL>
    </>
  );
}
