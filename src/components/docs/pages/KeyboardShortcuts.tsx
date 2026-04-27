"use client";

import {
  H1,
  H2,
  Lede,
  Kbd,
  Table,
  Th,
  Td,
} from "../DocPage";

interface Shortcut {
  keys: React.ReactNode;
  action: string;
}

const GLOBAL: Shortcut[] = [
  { keys: <><Kbd>⌘</Kbd>+<Kbd>⌥</Kbd>+<Kbd>N</Kbd></>, action: "New project (the plain ⌘N is reserved by the browser for opening a new window, so we use the Option-modified variant)." },
  { keys: <><Kbd>⌘</Kbd>+<Kbd>S</Kbd></>, action: "Save current project (prompts for a name if new)." },
  { keys: <><Kbd>⇧</Kbd>+<Kbd>⌘</Kbd>+<Kbd>S</Kbd></>, action: "Save As — always prompts for a name." },
  { keys: <><Kbd>⌘</Kbd>+<Kbd>Z</Kbd></>, action: "Undo." },
  { keys: <><Kbd>⇧</Kbd>+<Kbd>⌘</Kbd>+<Kbd>Z</Kbd></>, action: "Redo." },
  { keys: <><Kbd>Space</Kbd></>, action: "Play / pause the scene." },
  { keys: <><Kbd>F</Kbd></>, action: "Toggle full-canvas mode (hides editor chrome)." },
  { keys: <><Kbd>⇧</Kbd>+<Kbd>S</Kbd></>, action: "Toggle split viewport — stacks two preview canvases with independent active terminals." },
  { keys: <><Kbd>Esc</Kbd></>, action: "Exit full-canvas mode." },
];

const NODE_GRAPH: Shortcut[] = [
  { keys: <><Kbd>Shift</Kbd>+<Kbd>A</Kbd></>, action: "Open the add-node search palette at the cursor." },
  { keys: <><Kbd>⌘</Kbd>+<Kbd>C</Kbd></>, action: "Copy selected nodes to the internal clipboard." },
  { keys: <><Kbd>⌘</Kbd>+<Kbd>V</Kbd></>, action: "Paste nodes from the clipboard (or a file / image from the OS clipboard)." },
  { keys: <><Kbd>⇧</Kbd>+<Kbd>⌘</Kbd>+<Kbd>C</Kbd></>, action: "Copy selected nodes as shareable JSON." },
  { keys: <><Kbd>Delete</Kbd> / <Kbd>Backspace</Kbd> / <Kbd>X</Kbd></>, action: "Delete selected nodes and edges." },
  { keys: <><Kbd>Alt</Kbd>+drag a node</>, action: "Duplicate-on-drag — clones the node, keeping its edges on the original." },
  { keys: <><Kbd>Cmd</Kbd>+drag a node</>, action: "Detach — strips all incoming and outgoing edges." },
  { keys: <><Kbd>Alt</Kbd>+drag a wire</>, action: "Cut the wire." },
  { keys: <><Kbd>Shift</Kbd>+drag a wire</>, action: "Merge two wires at a junction." },
  { keys: "Middle-click drag", action: "Pan the graph." },
  { keys: "Scroll", action: "Zoom the graph." },
];

const CANVAS: Shortcut[] = [
  { keys: "Two-finger scroll / middle-click drag", action: "Pan the active preview viewport (the one your cursor is over)." },
  { keys: <><Kbd>⌘</Kbd>+scroll</>, action: "Zoom the active preview viewport, anchored at the cursor." },
  { keys: <><Kbd>0</Kbd></>, action: "Reset both preview viewports' pan and zoom to 1:1." },
  { keys: "Drag files onto the canvas", action: "Drops an image / video / audio / SVG as a new source node." },
];

const SPLINE_DRAW: Shortcut[] = [
  { keys: <><Kbd>P</Kbd></>, action: "Pen tool — click empty space to add an anchor; drag to define handles." },
  { keys: <><Kbd>V</Kbd></>, action: "Select tool — click anchors to select, drag to move; shift-click to extend; click-drag empty space for marquee." },
  { keys: <><Kbd>Shift</Kbd>+click an anchor</>, action: "Add / remove that anchor from the selection (select tool)." },
  { keys: <><Kbd>Delete</Kbd> / <Kbd>Backspace</Kbd></>, action: "Delete every selected anchor (select tool)." },
  { keys: <><Kbd>Esc</Kbd></>, action: "Clear the current anchor selection." },
  { keys: <><Kbd>Alt</Kbd>+drag a handle</>, action: "Break handle symmetry for the gesture (asymmetric tangents)." },
  { keys: "Right-click an anchor", action: "Delete the anchor." },
  { keys: "Right-click a handle", action: "Drop that side of the handle (turns the tangent into a corner)." },
  { keys: "Click the start anchor (pen tool)", action: "Close the loop on an open path with ≥3 anchors." },
  { keys: "Click an existing anchor (pen tool)", action: "Toggle corner ↔ smooth on that anchor." },
];

const TIMELINE_CURVE_EDITOR: Shortcut[] = [
  { keys: <><Kbd>Shift</Kbd>+click empty graph</>, action: "Add a new control point at the cursor." },
  { keys: "Click + drag empty graph", action: "Marquee-select control points." },
  { keys: <><Kbd>Shift</Kbd>+drag a point or handle</>, action: "Constrain the drag to the X or Y axis based on initial direction." },
  { keys: "Two-finger scroll / middle-click drag", action: "Pan the curve view (can extend past 0–1; outside range is greyed out)." },
  { keys: <><Kbd>⌘</Kbd>+scroll</>, action: "Zoom the curve view — horizontal gesture zooms X, vertical zooms Y." },
  { keys: "Drag the green playhead handle", action: "Scrub scene time directly from the curve editor." },
  { keys: <><Kbd>Delete</Kbd> / <Kbd>Backspace</Kbd></>, action: "Delete the selected point(s). Endpoints are locked." },
  { keys: <><Kbd>Esc</Kbd></>, action: "Clear the current selection." },
  { keys: "Right-click a control point", action: "Open the handle-mode / easing-preset menu." },
];

export default function KeyboardShortcutsPage() {
  return (
    <>
      <H1>Keyboard shortcuts</H1>
      <Lede>
        Everything the editor responds to, grouped by surface: global
        commands, the node graph, the preview canvas, the spline pen
        tool, and the timeline curve editor.
      </Lede>

      <H2>Global</H2>
      <ShortcutTable items={GLOBAL} />

      <H2>Node graph</H2>
      <ShortcutTable items={NODE_GRAPH} />

      <H2>Preview canvas</H2>
      <ShortcutTable items={CANVAS} />

      <H2>Spline draw</H2>
      <ShortcutTable items={SPLINE_DRAW} />

      <H2>Timeline curve editor</H2>
      <ShortcutTable items={TIMELINE_CURVE_EDITOR} />
    </>
  );
}

function ShortcutTable({ items }: { items: Shortcut[] }) {
  return (
    <Table>
      <thead>
        <tr>
          <Th>Shortcut</Th>
          <Th>Action</Th>
        </tr>
      </thead>
      <tbody>
        {items.map((row, i) => (
          <tr key={i}>
            <Td>{row.keys}</Td>
            <Td>{row.action}</Td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}
