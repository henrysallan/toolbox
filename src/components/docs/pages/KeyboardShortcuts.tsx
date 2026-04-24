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
  { keys: <><Kbd>⌘</Kbd>+<Kbd>S</Kbd></>, action: "Save current project (prompts for a name if new)." },
  { keys: <><Kbd>⇧</Kbd>+<Kbd>⌘</Kbd>+<Kbd>S</Kbd></>, action: "Save As — always prompts for a name." },
  { keys: <><Kbd>⌘</Kbd>+<Kbd>Z</Kbd></>, action: "Undo." },
  { keys: <><Kbd>⇧</Kbd>+<Kbd>⌘</Kbd>+<Kbd>Z</Kbd></>, action: "Redo." },
];

const NODE_GRAPH: Shortcut[] = [
  { keys: <><Kbd>Shift</Kbd>+<Kbd>A</Kbd></>, action: "Open the add-node search palette at the cursor." },
  { keys: <><Kbd>⌘</Kbd>+<Kbd>C</Kbd></>, action: "Copy selected nodes to the internal clipboard." },
  { keys: <><Kbd>⌘</Kbd>+<Kbd>V</Kbd></>, action: "Paste nodes from the clipboard (or a file / image from the OS clipboard)." },
  { keys: <><Kbd>⇧</Kbd>+<Kbd>⌘</Kbd>+<Kbd>C</Kbd></>, action: "Copy selected nodes as shareable JSON." },
  { keys: <><Kbd>Delete</Kbd> / <Kbd>Backspace</Kbd></>, action: "Delete selected nodes and edges." },
  { keys: <><Kbd>Alt</Kbd>+drag a node</>, action: "Duplicate-on-drag — clones the node, keeping its edges on the original." },
  { keys: <><Kbd>Cmd</Kbd>+drag a node</>, action: "Detach — strips all incoming and outgoing edges." },
  { keys: <><Kbd>Alt</Kbd>+drag a wire</>, action: "Cut the wire." },
  { keys: <><Kbd>Shift</Kbd>+drag a wire</>, action: "Merge two wires at a junction." },
  { keys: "Middle-click drag", action: "Pan the graph." },
  { keys: "Scroll", action: "Zoom the graph." },
];

const CANVAS: Shortcut[] = [
  { keys: "Drag files onto the canvas", action: "Drops an image / video / audio / SVG as a new source node." },
  { keys: <><Kbd>Space</Kbd> (in timeline)</>, action: "Play / pause the scene." },
];

export default function KeyboardShortcutsPage() {
  return (
    <>
      <H1>Keyboard shortcuts</H1>
      <Lede>
        Everything the editor responds to, in three groups: global
        app commands, the node graph, and the canvas + timeline.
      </Lede>

      <H2>Global</H2>
      <ShortcutTable items={GLOBAL} />

      <H2>Node graph</H2>
      <ShortcutTable items={NODE_GRAPH} />

      <H2>Canvas and timeline</H2>
      <ShortcutTable items={CANVAS} />
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
