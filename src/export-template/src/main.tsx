import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles.css";
import "@/lib/live-viewer/styles.css";

const container = document.getElementById("root");
if (!container) {
  throw new Error("#root element missing in host HTML");
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>
);
