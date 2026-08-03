// Which files the theme sweep owns. Shared by the codemod and the audit so
// the two can never disagree about scope. Spec: 080226_theme-modes.md.

import { execSync } from "node:child_process";

/**
 * Colour that answers to user artwork rather than to the UI, plus the theme
 * module itself (which necessarily spells the hexes out).
 */
export const EXCLUDED = [
  // Canvas overlays + gizmos: contrast is against the user's render, so a
  // themed handle could vanish on a bright frame.
  "src/components/effects/TransformGizmo.tsx",
  "src/components/effects/PrimitiveGizmo.tsx",
  "src/components/effects/MotionPathOverlay.tsx",
  "src/components/effects/PointsOverlay.tsx",
  "src/components/effects/GizmoTickOverlays.tsx",
  "src/components/effects/SegmentDotsOverlay.tsx",
  "src/components/effects/KeyerSampleOverlay.tsx",
  "src/components/effects/GradientOverlay.tsx",
  "src/components/effects/CustomCursor.tsx",
  "src/components/effects/spline-editor/SplineEditorOverlay.tsx",
  // Themed by hand, not by the codemod: socketColor.ts IS the socket
  // palette, so it has to spell both modes' hexes out. Hue is identical in
  // both modes (that's the wire identity); only lightness is capped for
  // light mode.
  "src/components/effects/socketColor.ts",
  // Brush pigment is content.
  "src/components/effects/paint-editor/brushes.ts",
  // PERSISTED: a picked node tint is saved onto the node (state/graph.ts
  // `tint`), so these presets must stay literal hex — a var() would be
  // written into project files and would not resolve outside the editor.
  "src/components/effects/node-tints.ts",
  // The token table itself.
  "src/components/effects/theme/tokens.ts",
  "src/components/effects/theme/oklch.ts",
  "src/components/effects/theme/theme.ts",
];

export function inScopeFiles(): string[] {
  return execSync(
    "find src/components src/app src/lib -name '*.tsx' -o -name '*.ts'",
    { encoding: "utf8" }
  )
    .trim()
    .split("\n")
    .filter(
      (f) => f && !f.includes("/live-viewer/") && !f.includes("/export-template/")
    )
    .filter((f) => !EXCLUDED.includes(f));
}
