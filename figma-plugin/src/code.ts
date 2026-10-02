// "Copy to toolbox" — main thread (specdocs/092326_figma-import.md).
//
// Select a frame → Convert (extract the scene) → Copy. The copy itself
// happens in the UI iframe: the clipboard write has to run synchronously
// inside the button click, so the payload is built BEFORE that click.

import { extractScene, isExportableFrame } from "./extract";

const WIDTH = 320;

figma.showUI(__html__, { width: WIDTH, height: 220, themeColors: true, title: "Copy to toolbox" });
// Hidden layers are skipped anyway; this makes the walk much faster.
figma.skipInvisibleInstanceChildren = true;

type FromUi =
  | { type: "convert"; reference: boolean }
  | { type: "resize"; height: number }
  | { type: "notify"; message: string };

function selectionMessage() {
  const sel = figma.currentPage.selection;
  if (sel.length !== 1) {
    return {
      type: "selection",
      ok: false,
      message: sel.length ? "Select a single frame" : "Select a frame to copy",
    };
  }
  const n = sel[0];
  if (!isExportableFrame(n)) {
    return {
      type: "selection",
      ok: false,
      message: `Select a frame — this is a ${n.type.toLowerCase().replace(/_/g, " ")}`,
    };
  }
  return {
    type: "selection",
    ok: true,
    id: n.id,
    name: n.name,
    width: Math.round(n.width),
    height: Math.round(n.height),
  };
}

let running = false;
const postSelection = () => figma.ui.postMessage(selectionMessage());

// Once a payload exists, any edit inside its frame makes it stale — tell the
// UI so Copy can't hand out an outdated scene. (A delete can't be traced to
// its old parent, so any delete on the page counts.)
let watchedFrameId: string | null = null;
function isInside(node: BaseNode | null, id: string): boolean {
  for (let n: BaseNode | null = node; n; n = n.parent) if (n.id === id) return true;
  return false;
}
function onNodeChange(e: NodeChangeEvent) {
  if (!watchedFrameId) return;
  const id = watchedFrameId;
  const touched = e.nodeChanges.some((c) =>
    c.type === "DELETE" || c.node.removed ? true : isInside(c.node as BaseNode, id)
  );
  if (touched) {
    watchedFrameId = null;
    figma.ui.postMessage({ type: "stale" });
  }
}
let watchedPage: PageNode = figma.currentPage;
watchedPage.on("nodechange", onNodeChange);

figma.on("selectionchange", postSelection);
figma.on("currentpagechange", () => {
  watchedPage.off("nodechange", onNodeChange);
  watchedPage = figma.currentPage;
  watchedPage.on("nodechange", onNodeChange);
  watchedFrameId = null;
  postSelection();
});

figma.ui.onmessage = async (msg: FromUi) => {
  if (msg.type === "resize") {
    figma.ui.resize(WIDTH, Math.max(120, Math.min(640, Math.round(msg.height))));
    return;
  }
  if (msg.type === "notify") {
    figma.notify(msg.message);
    return;
  }
  if (msg.type !== "convert" || running) return;
  const sel = figma.currentPage.selection;
  const frame = sel.length === 1 ? sel[0] : undefined;
  if (!isExportableFrame(frame)) {
    postSelection();
    return;
  }
  running = true;
  try {
    const { scene, stats } = await extractScene(frame, {
      reference: msg.reference,
      onProgress: (done) => figma.ui.postMessage({ type: "progress", done }),
    });
    figma.ui.postMessage({ type: "scene", frameId: frame.id, scene, stats });
    watchedFrameId = frame.id;
  } catch (err) {
    figma.ui.postMessage({
      type: "error",
      message: err instanceof Error ? err.message : String(err),
    });
  } finally {
    running = false;
  }
};

postSelection();
