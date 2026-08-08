import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { PanelWindowProvider, registerPanelWindow } from "./panel-window";

// Pop a layout panel into its own OS window (multi-monitor).
// Spec: specdocs/archive/080226_panel-popout-windows.md.
//
// The child is a SAME-ORIGIN `window.open`, so it is script-connected
// to this one: same JS heap, same event loop, synchronous DOM access
// both ways. That lets us portal the panel's React subtree into the
// child document — it stays the SAME React tree, with the same state,
// context providers and handlers. There is no message protocol, no
// serialized graph, and no second engine: the eval loop keeps blitting
// into the detached viewport's canvas because `blitToCanvas` ends in a
// plain `drawImage`, which is legal cross-document while same-origin.
//
// What the child does NOT inherit is its document: styles, the theme
// ramp, and every `window`/`document` reference inside the panel. The
// first two are handled here; the third is the panel's own job (resolve
// the window from `ownerDocument.defaultView`, never module scope).

/** Big enough to be useful on a second monitor; the OS remembers after. */
const DEFAULT_W = 1100;
const DEFAULT_H = 720;

/**
 * The child's own sheet, appended AFTER the cloned ones so it wins.
 * Kept minimal: the app's own tokens do the rest once the theme ramp
 * is mirrored onto the root element.
 */
const HOST_CSS = `
html, body { height: 100%; margin: 0; padding: 0; overflow: hidden; }
body { background: var(--tb-n-0); color: var(--tb-n-15); }
`;

function isStyleNode(n: Node): n is HTMLStyleElement | HTMLLinkElement {
  if (n.nodeName === "STYLE") return true;
  return n.nodeName === "LINK" && (n as HTMLLinkElement).rel === "stylesheet";
}

/**
 * Clone every stylesheet from the opener's head and keep them in step.
 * `<link>` clones re-fetch (from cache) asynchronously, which is why
 * the caller keeps the body hidden until the first paint settles.
 * The observer is what makes dev HMR style injection follow.
 */
function syncStyles(src: Document, dst: Document): () => void {
  const clones = new Map<Node, Node>();
  const sync = () => {
    const live = new Set<Node>();
    for (const node of Array.from(src.head.childNodes)) {
      if (!isStyleNode(node)) continue;
      live.add(node);
      const existing = clones.get(node);
      if (existing) {
        // Turbopack rewrites a <style>'s text in place on HMR rather
        // than swapping the node, so childList alone would miss it.
        if (node.nodeName === "STYLE" && existing.textContent !== node.textContent) {
          existing.textContent = node.textContent;
        }
        continue;
      }
      const clone = dst.importNode(node, true);
      dst.head.appendChild(clone);
      clones.set(node, clone);
    }
    for (const [node, clone] of clones) {
      if (live.has(node)) continue;
      clone.parentNode?.removeChild(clone);
      clones.delete(node);
    }
  };
  sync();
  const obs = new MutationObserver(sync);
  obs.observe(src.head, {
    childList: true,
    subtree: true,
    characterData: true,
  });
  return () => obs.disconnect();
}

/**
 * Mirror the opener's <html> class / data-theme / inline style.
 *
 * The inline style is NOT cosmetic: theme.ts writes the whole `--tb-n-*`
 * neutral ramp as inline custom properties on documentElement, so a
 * child without it renders token-less. The class carries next/font's
 * `--font-*` variables the same way.
 */
function syncRootAttrs(src: Document, dst: Document): () => void {
  const apply = () => {
    const s = src.documentElement;
    const d = dst.documentElement;
    if (d.className !== s.className) d.className = s.className;
    const theme = s.getAttribute("data-theme");
    if (theme == null) d.removeAttribute("data-theme");
    else if (d.getAttribute("data-theme") !== theme) {
      d.setAttribute("data-theme", theme);
    }
    const style = s.getAttribute("style") ?? "";
    if (d.getAttribute("style") !== style) d.setAttribute("style", style);
  };
  apply();
  const obs = new MutationObserver(apply);
  obs.observe(src.documentElement, {
    attributes: true,
    attributeFilter: ["class", "data-theme", "style"],
  });
  return () => obs.disconnect();
}

interface PopoutEntry {
  win: Window;
  mount: HTMLElement;
  stop: () => void;
  /** Pending StrictMode-remount close; cancelled if the id is reclaimed. */
  closeTimer: number | null;
}

// Module-level so React 19's StrictMode double-invoke (mount → cleanup →
// mount) reuses the window instead of flashing a new one: cleanup only
// SCHEDULES the close, and the immediate re-mount cancels it.
const REGISTRY = new Map<string, PopoutEntry>();

function dressWindow(win: Window, title: string): PopoutEntry {
  const doc = win.document;
  doc.head.replaceChildren();
  doc.body.replaceChildren();
  doc.title = title;

  const stopStyles = syncStyles(document, doc);
  const stopAttrs = syncRootAttrs(document, doc);

  const host = doc.createElement("style");
  host.textContent = HOST_CSS;
  doc.head.appendChild(host);

  const mount = doc.createElement("div");
  mount.style.cssText =
    "width:100%;height:100%;display:flex;flex-direction:column;min-width:0;min-height:0;";
  doc.body.appendChild(mount);

  return {
    win,
    mount,
    stop: () => {
      stopStyles();
      stopAttrs();
    },
    closeTimer: null,
  };
}

export function PanelPopout({
  id,
  title,
  onClose,
  onBlocked,
  children,
}: {
  /** Stable per detached panel — also the window name, so reloads reuse it. */
  id: string;
  title: string;
  /** The window went away (user closed it, or the opener is unloading). */
  onClose: () => void;
  /** `window.open` returned null — popup blocker. Caller re-homes + tells the user. */
  onBlocked?: () => void;
  children: React.ReactNode;
}) {
  const [mount, setMount] = useState<HTMLElement | null>(null);
  // Latest callbacks without re-running the open effect (which would
  // close and reopen the window on every parent render). Synced in an
  // effect rather than during render, and declared FIRST so it lands
  // before the open effect reads them on mount.
  const onCloseRef = useRef(onClose);
  const onBlockedRef = useRef(onBlocked);
  const titleRef = useRef(title);
  // The child document, kept off `mount` so the title effect doesn't
  // read through a state value.
  const docRef = useRef<Document | null>(null);
  useEffect(() => {
    onCloseRef.current = onClose;
    onBlockedRef.current = onBlocked;
    titleRef.current = title;
  });

  useEffect(() => {
    const name = `tb-panel-${id}`;
    let entry = REGISTRY.get(id);
    if (entry && !entry.win.closed) {
      // Reclaimed before the scheduled close fired — a StrictMode
      // remount, or a re-run from a changed id.
      if (entry.closeTimer != null) {
        window.clearTimeout(entry.closeTimer);
        entry.closeTimer = null;
      }
    } else {
      // Runs inside the click's transient activation window, so the
      // popup blocker allows it. A null return means the user blocks
      // popups outright.
      const win = window.open(
        "",
        name,
        `popup=yes,width=${DEFAULT_W},height=${DEFAULT_H}`
      );
      if (!win) {
        onBlockedRef.current?.();
        return;
      }
      entry = dressWindow(win, titleRef.current);
      REGISTRY.set(id, entry);
    }

    const live = entry;
    docRef.current = live.win.document;
    // Makes this window a target for broadcastAppEvent — the app's own
    // CustomEvents have to reach panels wherever they live.
    const unregister = registerPanelWindow(live.win);
    // The portal container is an external resource this effect just
    // created; publishing it is the point of the effect.
    setMount(live.mount);

    // Gone-detection: `pagehide` covers the browser path; the poll is
    // the backstop (an Electron native close doesn't reliably fire it).
    // Both run on the OPENER's timer so they survive the child's
    // teardown.
    let poll = 0;
    const handleGone = () => {
      window.clearInterval(poll);
      onCloseRef.current();
    };
    poll = window.setInterval(() => {
      if (live.win.closed) handleGone();
    }, 400);
    live.win.addEventListener("pagehide", handleGone);

    // Never orphan a child window: one referencing a torn-down heap is
    // a dead frame the user has to close by hand.
    const closeChild = () => {
      if (!live.win.closed) live.win.close();
    };
    window.addEventListener("pagehide", closeChild);

    return () => {
      window.clearInterval(poll);
      unregister();
      live.win.removeEventListener("pagehide", handleGone);
      window.removeEventListener("pagehide", closeChild);
      live.closeTimer = window.setTimeout(() => {
        REGISTRY.delete(id);
        live.stop();
        if (!live.win.closed) live.win.close();
      }, 0);
    };
  }, [id]);

  // Retitling must not reopen the window, so it lives outside the open
  // effect's identity (which keys on id alone). `mount` is here purely
  // as the readiness signal.
  useEffect(() => {
    if (mount && docRef.current) docRef.current.title = title;
  }, [mount, title]);

  if (!mount) return null;
  // The provider is INSIDE the portal so the panel's subtree — and only
  // it — resolves to the child window.
  const win = mount.ownerDocument.defaultView;
  return createPortal(
    win ? <PanelWindowProvider win={win}>{children}</PanelWindowProvider> : children,
    mount
  );
}
