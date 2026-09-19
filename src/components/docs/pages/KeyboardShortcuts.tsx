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
  { keys: <><Kbd>⇧</Kbd>+<Kbd>R</Kbd></>, action: "Toggle rulers and guides on the preview viewport (also Window → Rulers, or the ruler chip in the viewport bar). Rulers read in project pixels and follow pan and zoom." },
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
  { keys: <><Kbd>Shift</Kbd>+<Kbd>F</Kbd></>, action: "Frame the selected nodes (a Blender-style shaded frame that follows them; empty frame at the cursor when nothing is selected). Drag a node in to add it, Cmd-drag it out to remove it; drag the frame's edges or label to move it and everything inside; click the label to rename." },
  { keys: "Right-click a node", action: "Context menu — tint swatches and Bold outline live here, alongside copy/paste/duplicate/detach and Tidy. With a multi-selection, styling applies to every selected node, and an align / distribute strip appears (left, centre, right, top, middle, bottom; distribute horizontally / vertically). A zone or a frame's members move as one unit." },
  { keys: <><Kbd>L</Kbd></>, action: "Tidy — lay the selected nodes (or the whole scope when nothing is selected) out along their wires: left-to-right columns, straight wires, fan-in in socket order, zones and frames kept together. Unselected nodes are ignored and the selection stays centred where it was; the move animates and is one undo step. Right-click → Tidy does the same for the selection, or for the clicked node's connected nodes; right-click empty space → Tidy All." },
  { keys: <><Kbd>Alt</Kbd>+drag a wire</>, action: "Cut the wire." },
  { keys: <><Kbd>Shift</Kbd>+drag across wires</>, action: "Drop a reroute node on the wires (double-click a wire also inserts one)." },
  { keys: "Middle-click drag", action: "Pan the graph." },
  { keys: "Scroll", action: "Zoom the graph." },
];

const PARAM_PANEL: Shortcut[] = [
  { keys: <><Kbd>⌥</Kbd>+edit a parameter</>, action: "With several nodes selected, start an edit with Option held — Option-drag a slider, Option-click a swatch, checkbox or dropdown, or Option-click into a field, then type and press Enter — and the value also lands on every other selected node that has the same parameter (same name and type, whatever its current value; a wire-driven one is skipped). Hold Option to see which rows qualify: they show a ⌥ ×N tag with the number of nodes the edit will reach. Option+Enter links a value you typed into a plainly focused field. The whole gesture across all nodes is one undo step." },
];

const CANVAS: Shortcut[] = [
  { keys: "Two-finger scroll / middle-click drag", action: "Pan the active preview viewport (the one your cursor is over)." },
  { keys: <><Kbd>⌘</Kbd>+scroll</>, action: "Zoom the active preview viewport, anchored at the cursor." },
  { keys: <><Kbd>0</Kbd></>, action: "Reset both preview viewports' pan and zoom to 1:1." },
  { keys: "Drag files onto the canvas", action: "Drops an image / video / audio / SVG as a new source node." },
  { keys: "Lock chip in the viewport bar", action: "Toggle snapping for transform gizmos and spline drawing. On by default; hold ⌘ / Ctrl while dragging to suppress one gesture." },
  { keys: "Drag out of a ruler (⇧R shows them)", action: "Drop a guide over the canvas — the top ruler gives a horizontal guide, the side ruler a vertical one. Guides land on whole project pixels and save with the project. Transform boxes, shape primitives, text boxes, point handles and spline anchors snap their edges, centres and points to them (the lock chip and ⌘ / Ctrl still suppress snapping)." },
  { keys: "Drag a guide (or its ruler marker)", action: "Move it; a readout shows its pixel position. A plain drag reaches a guide over the bare canvas and over a transform / shape gizmo's move surface (handles still win), and every guide has a small marker on the ruler it crosses. Inside tools that own their clicks — the pen, paint, the 3D orbit — hold ⌘ / Ctrl to grab the guide instead. Hovering where a press would grab highlights the guide. Drop it back on a ruler (or off the viewport) to remove it, or Esc mid-drag to put it back." },
  { keys: "Right-click a guide (or its ruler marker)", action: "Edit position… (type an exact pixel value; Enter sets it), Mirror across centre (adds a one-off copy at the same distance from the opposite edge), Delete guide. Right-click a bare ruler for Clear all guides; Window → Clear Guides does the same." },
  { keys: <><Kbd>Shift</Kbd>+drag a transform handle</>, action: "Constrain the move to the X or Y axis based on the initial drag direction (text box, spline primitives, and other on-canvas gizmos)." },
];

const SPLINE_DRAW: Shortcut[] = [
  { keys: <><Kbd>P</Kbd></>, action: "Pen tool — click empty space to add an anchor; drag to define handles." },
  { keys: <><Kbd>N</Kbd></>, action: "Pencil — freehand drag; the stroke is fitted to a smooth curve on release." },
  { keys: <><Kbd>M</Kbd> / <Kbd>L</Kbd></>, action: "Rectangle / Ellipse — drag to draw the shape as a new closed sub-path." },
  { keys: <><Kbd>Shift</Kbd>+drag (M / L)</>, action: "Constrain the shape to 1:1 — a square or a circle." },
  { keys: <><Kbd>Alt</Kbd>+drag (M / L)</>, action: "Draw from the centre: the press point is the shape's centre, not a corner. Combine with Shift for a 1:1 shape centred there." },
  { keys: <><Kbd>G</Kbd> / <Kbd>S</Kbd> / <Kbd>R</Kbd></>, action: "Blender-style move / scale / rotate of the selected anchors (the whole sub-path when nothing is selected; the whole path in Path Select). Needs the cursor over the canvas; the geometry then follows the pointer with no button held." },
  { keys: <><Kbd>E</Kbd></>, action: "Extrude — grow a new anchor off the open sub-path's end (the selected endpoint, else the tail) and move it, without leaving the sub-path tool. Repeats to keep drawing." },
  { keys: <>Click or <Kbd>Enter</Kbd> / <Kbd>Esc</Kbd> or right-click</>, action: "Confirm / cancel a G-S-R-E transform. Cancelling an extrude removes the new anchor." },
  { keys: <><Kbd>X</Kbd> / <Kbd>Y</Kbd> during G or S</>, action: "Constrain the transform to that axis (press again to release)." },
  { keys: <><Kbd>Shift</Kbd> during R</>, action: "Snap the rotation to 45° increments." },
  { keys: <><Kbd>V</Kbd> / <Kbd>A</Kbd></>, action: "Path select (move / scale the whole path) / Sub-path select (edit anchors: click to select, drag to move, click-drag empty space for marquee)." },
  { keys: <><Kbd>B</Kbd> / <Kbd>W</Kbd></>, action: "Shape Builder (click / drag overlap faces to extract or merge, Alt-click deletes) / Width tool (drag an anchor's widgets to taper the stroke)." },
  { keys: <><Kbd>Shift</Kbd>+click an anchor</>, action: "Add / remove that anchor from the selection (select tool)." },
  { keys: "Click a segment (sub-path select)", action: "Select the segment's two anchors; dragging moves them together, so the segment travels rigidly." },
  { keys: "Double-click a segment or sub-path", action: "Select every anchor of that sub-path (activating it first if needed)." },
  { keys: <><Kbd>Alt</Kbd>+drag a segment</>, action: "Bend the curve between its two anchors (a plain drag moves the segment instead)." },
  { keys: <><Kbd>J</Kbd></>, action: "Join — close the active open sub-path (both endpoints selected), or splice it onto the nearest other open sub-path." },
  { keys: <><Kbd>⌘</Kbd> / <Kbd>Ctrl</Kbd> while dragging</>, action: "Suppress snapping for the gesture — anchors otherwise snap onto, and line up with, other anchors and the canvas edges / centre / thirds. The lock chip in the viewport bar turns snapping off entirely." },
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
        commands, the node graph, the parameter panel, the preview canvas,
        the spline pen tool, and the timeline curve editor.
      </Lede>

      <H2>Global</H2>
      <ShortcutTable items={GLOBAL} />

      <H2>Node graph</H2>
      <ShortcutTable items={NODE_GRAPH} />

      <H2>Parameter panel</H2>
      <ShortcutTable items={PARAM_PANEL} />

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
