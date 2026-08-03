"use client";

import { useEffect, useState } from "react";
import {
  loadUserPreferences,
  saveUserPreferences,
  testAnthropicKey,
  testHuggingFaceToken,
  testOpenAIKey,
} from "@/lib/supabase/user-preferences";
import { useInputOverride, type InputOverride } from "./input-device";
import { UI_FONTS, useUiFont } from "./ui-font";
import { useTheme } from "./theme/theme";
import { TINT_PRESETS } from "./theme/tokens";

export interface UserPreferencesModalProps {
  open: boolean;
  signedIn: boolean;
  onClose: () => void;
  // Fired after a successful save so the parent can refresh its
  // cached preferences (used by the Image Generate node and any
  // future AI-driven nodes that need the key in-hand).
  onSaved?: () => void;
}

// Editor-wide preferences. Hosts:
//  - OpenAI API key  → Image Generate node + future AI nodes
//  - HuggingFace token → optional, unlocks gated transformers.js
//                        models (e.g. briaai/RMBG-2.0). Non-gated
//                        models work without it.
//
// Each field uses the same masked-input + show/hide + test +
// last-4-tail placeholder UX, factored into <KeyField/>.
export default function UserPreferencesModal({
  open,
  signedIn,
  onClose,
  onSaved,
}: UserPreferencesModalProps) {
  const [openaiKey, setOpenaiKey] = useState("");
  const [openaiSavedTail, setOpenaiSavedTail] = useState<string | null>(null);
  const [openaiDirty, setOpenaiDirty] = useState(false);

  const [anthropicKey, setAnthropicKey] = useState("");
  const [anthropicSavedTail, setAnthropicSavedTail] = useState<string | null>(null);
  const [anthropicDirty, setAnthropicDirty] = useState(false);

  const [hfToken, setHfToken] = useState("");
  const [hfSavedTail, setHfSavedTail] = useState<string | null>(null);
  const [hfDirty, setHfDirty] = useState(false);

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // Input device is interaction-only and stored locally (per machine), so it
  // applies immediately and works without signing in.
  const [inputOverride, setInputOverride] = useInputOverride();

  // UI font is cosmetic and stored locally too (ui-font.ts) — the setter
  // applies it live, so the choice previews instantly.
  const [uiFont, setUiFontPref] = useUiFont();

  // Theme (theme/theme.ts) — same story: local, live, works signed out. The
  // brightness value returned is the one for the ACTIVE mode, so flipping
  // dark↔light swaps in that mode's own trim.
  const {
    mode: themeMode,
    brightness: themeBrightness,
    tintPreset,
    tintIntensity,
    setMode: setThemeModePref,
    setBrightness: setThemeBrightnessPref,
    setTintPreset,
    setTintIntensity,
  } = useTheme();

  // (Re)load preferences whenever the modal opens.
  useEffect(() => {
    if (!open) return;
    setError(null);
    setOpenaiDirty(false);
    setAnthropicDirty(false);
    setHfDirty(false);
    if (!signedIn) {
      setOpenaiKey("");
      setOpenaiSavedTail(null);
      setAnthropicKey("");
      setAnthropicSavedTail(null);
      setHfToken("");
      setHfSavedTail(null);
      return;
    }
    setLoading(true);
    loadUserPreferences()
      .then((prefs) => {
        const ok = prefs.openaiApiKey ?? "";
        const ak = prefs.anthropicApiKey ?? "";
        const hk = prefs.huggingfaceToken ?? "";
        setOpenaiKey(ok);
        setOpenaiSavedTail(ok ? ok.slice(-4) : null);
        setAnthropicKey(ak);
        setAnthropicSavedTail(ak ? ak.slice(-4) : null);
        setHfToken(hk);
        setHfSavedTail(hk ? hk.slice(-4) : null);
      })
      .finally(() => setLoading(false));
  }, [open, signedIn]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const submit = async () => {
    if (!signedIn || saving) return;
    setSaving(true);
    setError(null);
    const trimmedOpenai = openaiKey.trim();
    const trimmedAnthropic = anthropicKey.trim();
    const trimmedHf = hfToken.trim();
    const res = await saveUserPreferences({
      openaiApiKey: trimmedOpenai === "" ? null : trimmedOpenai,
      anthropicApiKey: trimmedAnthropic === "" ? null : trimmedAnthropic,
      huggingfaceToken: trimmedHf === "" ? null : trimmedHf,
    });
    setSaving(false);
    if (!res.ok) {
      setError(res.error ?? "Save failed");
      return;
    }
    onSaved?.();
    onClose();
  };

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.65)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 2000,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          minWidth: 480,
          maxWidth: 540,
          background: "var(--tb-n-3)",
          border: "1px solid var(--tb-n-7)",
          borderRadius: 6,
          padding: 16,
          fontFamily: "var(--ui-font)",
          fontSize: 12,
          color: "var(--tb-n-16)",
          boxShadow: "0 12px 32px rgba(0,0,0,0.5)",
          maxHeight: "85vh",
          overflowY: "auto",
        }}
      >
        <div
          style={{
            marginBottom: 12,
            color: "var(--tb-n-13)",
            fontSize: 10,
            textTransform: "uppercase",
            letterSpacing: 1,
          }}
        >
          User Preferences
        </div>

        {/* Input device — interaction-only, stored locally (per machine),
            so it's editable without signing in. */}
        <div style={{ marginBottom: 16 }}>
          <div
            style={{
              color: "var(--tb-n-13)",
              fontSize: 10,
              textTransform: "uppercase",
              letterSpacing: 1,
              marginBottom: 6,
            }}
          >
            Input device
          </div>
          <div
            style={{
              display: "flex",
              gap: 2,
              padding: 2,
              background: "var(--tb-n-0)",
              border: "1px solid var(--tb-n-7)",
              borderRadius: 999,
              width: "fit-content",
            }}
          >
            {(["auto", "mouse", "trackpad"] as const).map((m: InputOverride) => {
              const on = inputOverride === m;
              return (
                <button
                  key={m}
                  type="button"
                  onClick={() => setInputOverride(m)}
                  style={{
                    background: on ? "var(--tb-n-9)" : "transparent",
                    color: on ? "var(--tb-n-17)" : "var(--tb-n-13)",
                    border: "none",
                    borderRadius: 999,
                    padding: "4px 14px",
                    fontFamily: "inherit",
                    fontSize: 11,
                    textTransform: "capitalize",
                    cursor: "pointer",
                  }}
                >
                  {m}
                </button>
              );
            })}
          </div>
        </div>

        {/* Appearance — light/dark plus a per-mode brightness trim. Local to
            the machine and applied live, same as the UI font below. */}
        <div style={{ margin: "16px 0" }}>
          <div
            style={{
              color: "var(--tb-n-13)",
              fontSize: 10,
              textTransform: "uppercase",
              letterSpacing: 1,
              marginBottom: 6,
            }}
          >
            Appearance
          </div>
          <div
            style={{
              display: "flex",
              gap: 2,
              padding: 2,
              background: "var(--tb-n-0)",
              border: "1px solid var(--tb-n-7)",
              borderRadius: 999,
              width: "fit-content",
            }}
          >
            {(["dark", "light"] as const).map((m) => {
              const on = themeMode === m;
              return (
                <button
                  key={m}
                  type="button"
                  onClick={() => setThemeModePref(m)}
                  style={{
                    background: on ? "var(--tb-n-9)" : "transparent",
                    color: on ? "var(--tb-n-17)" : "var(--tb-n-13)",
                    border: "none",
                    borderRadius: 999,
                    padding: "4px 14px",
                    fontFamily: "inherit",
                    fontSize: 11,
                    textTransform: "capitalize",
                    cursor: "pointer",
                  }}
                >
                  {m}
                </button>
              );
            })}
          </div>

          {/* Brightness trim. Stored per mode, so tuning dark doesn't drag
              light along with it. */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              marginTop: 12,
            }}
          >
            <span
              style={{
                color: "var(--tb-n-11)",
                fontSize: 11,
                width: 78,
                flexShrink: 0,
              }}
            >
              Brightness
            </span>
            <input
              type="range"
              min={-1}
              max={1}
              step={0.05}
              value={themeBrightness}
              onChange={(e) => setThemeBrightnessPref(Number(e.target.value))}
              style={{ flex: 1, minWidth: 0 }}
              aria-label={`${themeMode} mode background brightness`}
            />
            <button
              type="button"
              onClick={() => setThemeBrightnessPref(0)}
              disabled={themeBrightness === 0}
              style={{
                ...btnStyle(),
                fontSize: 10,
                padding: "2px 8px",
                opacity: themeBrightness === 0 ? 0.4 : 1,
              }}
              title="Back to the designed ramp"
            >
              Reset
            </button>
          </div>

          {/* Tint — a hue wash over the greys only. Shared by both modes,
              unlike brightness: a chosen tint is a taste about the product,
              and having it evaporate on switching mode reads as a bug. */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              marginTop: 14,
            }}
          >
            <span
              style={{
                color: "var(--tb-n-11)",
                fontSize: 11,
                width: 78,
                flexShrink: 0,
              }}
            >
              Tint
            </span>
            <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
              {TINT_PRESETS.map((p) => {
                const on = tintPreset === p.id;
                return (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => setTintPreset(p.id)}
                    title={p.label}
                    aria-label={`${p.label} tint`}
                    aria-pressed={on}
                    style={{
                      width: 18,
                      height: 18,
                      borderRadius: 999,
                      padding: 0,
                      cursor: "pointer",
                      background: p.swatch,
                      // "None" reads as a slash rather than a colour, so it
                      // isn't mistaken for a grey tint option.
                      backgroundImage:
                        p.hue === null
                          ? "linear-gradient(45deg, transparent 44%, var(--tb-n-17) 44%, var(--tb-n-17) 56%, transparent 56%)"
                          : undefined,
                      border: on
                        ? "2px solid var(--tb-n-17)"
                        : "1px solid var(--tb-n-9)",
                    }}
                  />
                );
              })}
            </div>
          </div>

          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              marginTop: 8,
            }}
          >
            <span
              style={{
                color: "var(--tb-n-11)",
                fontSize: 11,
                width: 78,
                flexShrink: 0,
              }}
            >
              Tint amount
            </span>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={tintIntensity}
              disabled={tintPreset === "none"}
              onChange={(e) => setTintIntensity(Number(e.target.value))}
              style={{
                flex: 1,
                minWidth: 0,
                opacity: tintPreset === "none" ? 0.4 : 1,
              }}
              aria-label="Tint intensity"
            />
          </div>
        </div>

        {/* UI font — cosmetic, stored locally (per machine), applies live. */}
        <div style={{ margin: "16px 0" }}>
          <div
            style={{
              color: "var(--tb-n-13)",
              fontSize: 10,
              textTransform: "uppercase",
              letterSpacing: 1,
              marginBottom: 6,
            }}
          >
            UI font
          </div>
          <div
            style={{
              display: "flex",
              gap: 2,
              padding: 2,
              background: "var(--tb-n-0)",
              border: "1px solid var(--tb-n-7)",
              borderRadius: 999,
              width: "fit-content",
            }}
          >
            {UI_FONTS.map((f) => {
              const on = uiFont === f.id;
              return (
                <button
                  key={f.id}
                  type="button"
                  onClick={() => setUiFontPref(f.id)}
                  style={{
                    background: on ? "var(--tb-n-9)" : "transparent",
                    color: on ? "var(--tb-n-17)" : "var(--tb-n-13)",
                    border: "none",
                    borderRadius: 999,
                    padding: "4px 14px",
                    // Each pill previews its own font.
                    fontFamily: f.stack,
                    fontSize: 11,
                    cursor: "pointer",
                  }}
                >
                  {f.label}
                </button>
              );
            })}
          </div>
        </div>
        <div style={{ height: 1, background: "var(--tb-n-7)", margin: "0 0 16px" }} />

        {!signedIn && (
          <div
            style={{
              padding: 10,
              border: "1px solid var(--tb-a-amber-700)",
              background: "color-mix(in srgb, var(--tb-a-amber-700) 10%, transparent)",
              color: "var(--tb-a-amber-200)",
              borderRadius: 4,
              marginBottom: 12,
              lineHeight: 1.5,
            }}
          >
            Sign in to save API keys.
          </div>
        )}

        <KeyField
          label="OpenAI API Key"
          placeholder="sk-…"
          value={openaiKey}
          savedTail={openaiSavedTail}
          dirty={openaiDirty}
          onChange={(v) => {
            setOpenaiKey(v);
            setOpenaiDirty(true);
          }}
          onTest={() => testOpenAIKey(openaiKey)}
          disabled={!signedIn || loading}
          enterToSave={submit}
        />

        <div style={{ height: 14 }} />

        <KeyField
          label="Anthropic (Claude) API Key"
          placeholder="sk-ant-…"
          value={anthropicKey}
          savedTail={anthropicSavedTail}
          dirty={anthropicDirty}
          onChange={(v) => {
            setAnthropicKey(v);
            setAnthropicDirty(true);
          }}
          onTest={() => testAnthropicKey(anthropicKey)}
          disabled={!signedIn || loading}
          enterToSave={submit}
        />

        <div style={{ height: 14 }} />

        <KeyField
          label="HuggingFace Token (optional)"
          placeholder="hf_…"
          value={hfToken}
          savedTail={hfSavedTail}
          dirty={hfDirty}
          onChange={(v) => {
            setHfToken(v);
            setHfDirty(true);
          }}
          onTest={() => testHuggingFaceToken(hfToken)}
          disabled={!signedIn || loading}
          enterToSave={submit}
        />

        {error && (
          <div
            style={{
              color: "var(--tb-a-red-500)",
              fontSize: 11,
              marginTop: 12,
              marginBottom: 4,
            }}
          >
            {error}
          </div>
        )}

        <div
          style={{
            display: "flex",
            gap: 6,
            justifyContent: "flex-end",
            marginTop: 14,
          }}
        >
          <button onClick={onClose} style={btnStyle()}>
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={!signedIn || saving || loading}
            style={{
              ...btnStyle(),
              background: "var(--tb-a-green-600)",
              border: "1px solid var(--tb-a-green-600)",
              color: "var(--tb-a-green-100)",
              opacity: !signedIn || saving || loading ? 0.5 : 1,
            }}
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}

// One masked-input + test-button row. Same UX shared between the
// OpenAI and HuggingFace fields.
function KeyField({
  label,
  placeholder,
  value,
  savedTail,
  dirty,
  onChange,
  onTest,
  disabled,
  enterToSave,
}: {
  label: string;
  placeholder: string;
  value: string;
  savedTail: string | null;
  dirty: boolean;
  onChange: (v: string) => void;
  onTest: () => Promise<{ ok: boolean; error?: string }>;
  disabled: boolean;
  enterToSave: () => void;
}) {
  const [reveal, setReveal] = useState(false);
  const [status, setStatus] = useState<
    | { kind: "idle" }
    | { kind: "testing" }
    | { kind: "ok" }
    | { kind: "err"; message: string }
  >({ kind: "idle" });

  useEffect(() => {
    setStatus({ kind: "idle" });
  }, [value]);

  const runTest = async () => {
    if (status.kind === "testing") return;
    setStatus({ kind: "testing" });
    const res = await onTest();
    if (res.ok) setStatus({ kind: "ok" });
    else setStatus({ kind: "err", message: res.error ?? "Failed" });
  };

  return (
    <div>
      <div
        style={{
          color: "var(--tb-n-13)",
          fontSize: 10,
          textTransform: "uppercase",
          letterSpacing: 1,
          marginBottom: 6,
        }}
      >
        {label}
      </div>
      <div style={{ display: "flex", gap: 6, marginBottom: 6 }}>
        <input
          type={reveal ? "text" : "password"}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") enterToSave();
          }}
          placeholder={
            savedTail ? `•••• •••• •••• ${savedTail}` : placeholder
          }
          spellCheck={false}
          disabled={disabled}
          style={{
            flex: 1,
            boxSizing: "border-box",
            padding: "6px 8px",
            background: "var(--tb-n-0)",
            border: "1px solid var(--tb-n-7)",
            color: "var(--tb-n-16)",
            fontFamily: "inherit",
            fontSize: 12,
            borderRadius: 3,
            opacity: disabled ? 0.5 : 1,
          }}
        />
        <button
          type="button"
          onClick={() => setReveal((v) => !v)}
          disabled={disabled}
          style={btnStyle()}
          title={reveal ? "Hide" : "Show"}
        >
          {reveal ? "Hide" : "Show"}
        </button>
      </div>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
        }}
      >
        <button
          type="button"
          onClick={runTest}
          disabled={
            disabled ||
            value.trim() === "" ||
            status.kind === "testing"
          }
          style={{
            ...btnStyle(),
            opacity:
              disabled ||
              value.trim() === "" ||
              status.kind === "testing"
                ? 0.5
                : 1,
          }}
        >
          {status.kind === "testing" ? "Testing…" : "Test connection"}
        </button>
        {status.kind === "ok" && (
          <span style={{ color: "var(--tb-a-green-500)", fontSize: 11 }}>✓ Works</span>
        )}
        {status.kind === "err" && (
          <span style={{ color: "var(--tb-a-red-500)", fontSize: 11 }}>
            ✗ {status.message}
          </span>
        )}
        {savedTail && !dirty && status.kind === "idle" && (
          <span style={{ color: "var(--tb-n-13)", fontSize: 11 }}>
            Saved on file
          </span>
        )}
      </div>
    </div>
  );
}

function btnStyle(): React.CSSProperties {
  return {
    padding: "4px 10px",
    background: "transparent",
    border: "1px solid var(--tb-n-9)",
    color: "var(--tb-n-16)",
    fontFamily: "inherit",
    fontSize: 11,
    borderRadius: 3,
    cursor: "pointer",
  };
}
