// Electron's `-webkit-app-region` (frameless-window drag regions) isn't in
// csstype, so React.CSSProperties rejects it. Augment it in.
import "react";

declare module "react" {
  interface CSSProperties {
    WebkitAppRegion?: "drag" | "no-drag";
  }
}
