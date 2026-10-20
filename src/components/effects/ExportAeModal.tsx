"use client";

// Export to After Effects (spec 091926_after-effects-handoff.md §5.4).
//
// CONTRACT STUB — committed before wave 2. The modal lane replaces this body;
// the package lane mounts <ExportAeModal> in EffectsApp with every prop.
// Props: AeExportModalProps (src/lib/ae-export/package/index.ts).

import type { JSX } from "react";
import type { AeExportModalProps } from "@/lib/ae-export/package";

export default function ExportAeModal(props: AeExportModalProps): JSX.Element | null {
  if (!props.open) return null;
  return null;
}
