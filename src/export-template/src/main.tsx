import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { CANVASKIT_VERSION, setCanvasKitBase } from "@/engine/skia/canvaskit";
import App from "./App";
import "./styles.css";
import "@/lib/live-viewer/styles.css";

// Skia-rendered nodes (SkSL Shader, skia-*) load CanvasKit from the copy
// build-export-template.mjs puts next to this page (dist/canvaskit/<ver>/),
// relative to the document so the app works under any path on any host.
setCanvasKitBase(new URL(`./canvaskit/${CANVASKIT_VERSION}/`, document.baseURI).href);

const container = document.getElementById("root");
if (!container) {
  throw new Error("#root element missing in host HTML");
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>
);
