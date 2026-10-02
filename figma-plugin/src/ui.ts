// "Copy to toolbox" — UI iframe.
//
// The iframe is a null-origin page, not a secure context: navigator.clipboard
// is unavailable, so the copy goes through document.execCommand("copy") and a
// `copy` listener that writes the payload. Browsers only allow that inside a
// user gesture (transient activation), which is why Convert builds the
// payload first and Copy writes it synchronously in its own click.

type Stats = {
  layers: number;
  shapes: number;
  texts: number;
  images: number;
  rasters: number;
  hidden: number;
};

type FromMain =
  | { type: "selection"; ok: false; message: string }
  | { type: "selection"; ok: true; id: string; name: string; width: number; height: number }
  | { type: "progress"; done: number }
  | { type: "scene"; frameId: string; scene: { warnings: string[] }; stats: Stats }
  | { type: "stale" }
  | { type: "error"; message: string };

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const frameEl = $<HTMLDivElement>("frame");
const refBox = $<HTMLInputElement>("reference");
const primary = $<HTMLButtonElement>("primary");
const download = $<HTMLButtonElement>("download");
const summaryEl = $<HTMLDivElement>("summary");
const statusEl = $<HTMLDivElement>("status");
const warningsEl = $<HTMLDetailsElement>("warnings");
const warningsTitle = $<HTMLElement>("warnings-title");
const warningsList = $<HTMLUListElement>("warnings-list");

// Clipboard failures above this size have been reported by other plugins.
const LARGE_PAYLOAD = 4.5 * 1024 * 1024;

let selected: { id: string; name: string } | null = null;
let payload = "";
let converting = false;

const post = (msg: unknown) => parent.postMessage({ pluginMessage: msg }, "*");

function fitHeight() {
  requestAnimationFrame(() => post({ type: "resize", height: document.body.scrollHeight }));
}

function setStatus(text: string, tone: "" | "ok" | "warn" | "err" = "") {
  statusEl.textContent = text;
  statusEl.className = `status${tone ? ` ${tone}` : ""}`;
}

function formatSize(chars: number): string {
  return chars >= 1024 * 1024
    ? `${(chars / 1024 / 1024).toFixed(1)} MB`
    : `${Math.max(1, Math.round(chars / 1024))} KB`;
}

// Back to "Convert" — the frame, the selection or the options changed.
function invalidate() {
  payload = "";
  primary.textContent = "Convert";
  primary.disabled = !selected || converting;
  download.hidden = true;
  summaryEl.hidden = true;
  warningsEl.hidden = true;
  setStatus("");
  fitHeight();
}

function showSelection(msg: Extract<FromMain, { type: "selection" }>) {
  if (msg.ok) {
    const changed = selected?.id !== msg.id;
    selected = { id: msg.id, name: msg.name };
    frameEl.className = "frame";
    frameEl.textContent = msg.name;
    const size = document.createElement("span");
    size.className = "size";
    size.textContent = `${msg.width} × ${msg.height}`;
    frameEl.appendChild(size);
    if (changed) invalidate();
  } else {
    selected = null;
    frameEl.className = "frame empty";
    frameEl.textContent = msg.message;
    invalidate();
  }
}

function showScene(msg: Extract<FromMain, { type: "scene" }>) {
  converting = false;
  if (!selected || msg.frameId !== selected.id) {
    invalidate();
    return;
  }
  payload = JSON.stringify(msg.scene);
  const s = msg.stats;
  const parts = [`${s.layers} layer${s.layers === 1 ? "" : "s"}`];
  if (s.shapes) parts.push(`${s.shapes} shape${s.shapes === 1 ? "" : "s"}`);
  if (s.texts) parts.push(`${s.texts} text`);
  if (s.images) parts.push(`${s.images} image${s.images === 1 ? "" : "s"}`);
  if (s.rasters) parts.push(`${s.rasters} flattened`);
  summaryEl.textContent = `${parts.join(" · ")} — ${formatSize(payload.length)}`;
  summaryEl.hidden = false;

  const warnings = msg.scene.warnings;
  warningsList.replaceChildren(
    ...warnings.map((w) => {
      const li = document.createElement("li");
      li.textContent = w;
      return li;
    })
  );
  warningsTitle.textContent = `${warnings.length} note${warnings.length === 1 ? "" : "s"} from Figma`;
  warningsEl.hidden = warnings.length === 0;

  primary.textContent = "Copy to clipboard";
  primary.disabled = false;
  download.hidden = false;
  if (payload.length > LARGE_PAYLOAD) {
    setStatus(
      "Large payload — if pasting does nothing, use Download JSON and drop the file on toolbox's node editor.",
      "warn"
    );
  } else {
    setStatus(s.hidden ? `${s.hidden} hidden layer${s.hidden === 1 ? "" : "s"} skipped.` : "");
  }
  fitHeight();
}

// One copy listener writes the payload; execCommand("copy") triggers it.
document.addEventListener("copy", (e) => {
  if (!payload || !e.clipboardData) return;
  e.clipboardData.setData("text/plain", payload);
  e.preventDefault();
});

function copyPayload(): boolean {
  try {
    if (document.execCommand("copy")) return true;
  } catch {
    // fall through to the textarea path
  }
  // Fallback: a selected textarea (some hosts only copy a real selection).
  const ta = document.createElement("textarea");
  ta.value = payload;
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  ta.remove();
  return ok;
}

primary.onclick = () => {
  if (!selected) return;
  if (!payload) {
    converting = true;
    primary.disabled = true;
    primary.textContent = "Converting…";
    setStatus("");
    post({ type: "convert", reference: refBox.checked });
    return;
  }
  // Synchronous — must stay inside this click for the copy to be allowed.
  if (copyPayload()) {
    setStatus("Copied — paste into toolbox with ⌘V over the node editor.", "ok");
    post({ type: "notify", message: "Copied for toolbox" });
  } else {
    setStatus("Figma blocked the copy — use Download JSON and drop the file on toolbox's node editor.", "err");
  }
};

download.onclick = () => {
  if (!payload || !selected) return;
  const safe = selected.name.replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "") || "frame";
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([payload], { type: "application/json" }));
  a.download = `${safe}.toolbox-figma.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
};

refBox.onchange = () => {
  if (payload) invalidate();
};

window.onmessage = (e: MessageEvent) => {
  const msg = e.data?.pluginMessage as FromMain | undefined;
  if (!msg) return;
  switch (msg.type) {
    case "selection":
      showSelection(msg);
      break;
    case "progress":
      if (converting) primary.textContent = `Converting… ${msg.done} layers`;
      break;
    case "scene":
      showScene(msg);
      break;
    case "stale":
      if (payload) {
        invalidate();
        setStatus("The frame changed — convert again.", "warn");
      }
      break;
    case "error":
      converting = false;
      invalidate();
      setStatus(`Couldn't convert: ${msg.message}`, "err");
      break;
  }
};

fitHeight();
