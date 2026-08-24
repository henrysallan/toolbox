"use client";

import PresetNameModal from "./PresetNameModal";

export interface NewLayoutPresetModalProps {
  onClose: () => void;
  // Saves the CURRENT window arrangement under `name`. Throwing surfaces
  // the message; resolving closes the modal.
  onSave: (name: string) => Promise<void> | void;
  // Existing preset names (user presets only) — typing one relabels the
  // primary button to Replace, matching upsertLayoutPreset's by-name
  // overwrite.
  existingNames: string[];
}

// Window → Layouts → + New Preset…. Captures the live layout tree (the
// parent reads it at save time) under a user-supplied name. Thin wrapper
// over the shared PresetNameModal (081226_user-node-presets.md).
export default function NewLayoutPresetModal(props: NewLayoutPresetModalProps) {
  return (
    <PresetNameModal
      title="New layout preset"
      description="Saves the current window arrangement to your profile."
      {...props}
    />
  );
}
