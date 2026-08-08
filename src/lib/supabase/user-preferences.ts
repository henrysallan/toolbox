import { createClient } from "@/lib/supabase/client";

// Editor-wide user preferences.
// - openaiApiKey: BYO-key for AI nodes (Image Generate).
// - anthropicApiKey: BYO Claude key for AI Recipe generation. Read
//   server-side by /api/generate-recipe for the authenticated user.
// - huggingfaceToken: optional read-only HF token for gated models
//   (e.g. briaai/RMBG-2.0). Anonymous access works for non-gated
//   weights; gated repos return 401 without a token.
//
// Schema mirrors specdocs/sql_archive/user-preferences-migration.sql (+ the
// anthropic_api_key column from user-preferences-anthropic-migration.sql).

export interface UserPreferences {
  openaiApiKey: string | null;
  anthropicApiKey: string | null;
  huggingfaceToken: string | null;
}

const EMPTY: UserPreferences = {
  openaiApiKey: null,
  anthropicApiKey: null,
  huggingfaceToken: null,
};

export async function loadUserPreferences(): Promise<UserPreferences> {
  const supa = createClient();
  const { data: userData } = await supa.auth.getUser();
  const uid = userData.user?.id;
  if (!uid) return EMPTY;
  const { data, error } = await supa
    .from("user_preferences")
    .select("openai_api_key, hf_token, anthropic_api_key")
    .eq("user_id", uid)
    .maybeSingle();
  if (error) {
    // Row-not-found surfaces as data=null without an error; treat
    // any genuine error as "no preferences yet" rather than
    // throwing — a transient prefs failure shouldn't break the
    // whole editor.
    console.warn("loadUserPreferences:", error.message);
    return EMPTY;
  }
  return {
    openaiApiKey: (data?.openai_api_key as string | null) ?? null,
    anthropicApiKey: (data?.anthropic_api_key as string | null) ?? null,
    huggingfaceToken: (data?.hf_token as string | null) ?? null,
  };
}

export async function saveUserPreferences(
  next: Partial<UserPreferences>
): Promise<{ ok: boolean; error?: string }> {
  const supa = createClient();
  const { data: userData } = await supa.auth.getUser();
  const uid = userData.user?.id;
  if (!uid) return { ok: false, error: "Not signed in." };
  const payload: Record<string, unknown> = { user_id: uid };
  if ("openaiApiKey" in next) payload.openai_api_key = next.openaiApiKey;
  if ("anthropicApiKey" in next) payload.anthropic_api_key = next.anthropicApiKey;
  if ("huggingfaceToken" in next) payload.hf_token = next.huggingfaceToken;
  const { error } = await supa
    .from("user_preferences")
    .upsert(payload, { onConflict: "user_id" });
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

// --- Brush presets (Paint node, 071926_paint-toolkit.md) -------------------
// Stored in a dedicated `brush_presets jsonb` column (migration:
// specdocs/sql_archive/user-preferences-brush-presets-migration.sql). Deliberately NOT
// part of loadUserPreferences' select: while the migration is unapplied that
// select would error and take the API-key prefs down with it. Callers treat
// null as "cloud unavailable" (signed out / offline / column missing) and
// fall back to localStorage (paint-editor/presets.ts).

export async function loadCloudBrushPresets(): Promise<unknown[] | null> {
  const supa = createClient();
  const { data: userData } = await supa.auth.getUser();
  const uid = userData.user?.id;
  if (!uid) return null;
  const { data, error } = await supa
    .from("user_preferences")
    .select("brush_presets")
    .eq("user_id", uid)
    .maybeSingle();
  if (error) {
    console.warn("loadCloudBrushPresets:", error.message);
    return null;
  }
  const list = data?.brush_presets;
  return Array.isArray(list) ? list : null;
}

export async function saveCloudBrushPresets(
  presets: unknown[]
): Promise<boolean> {
  const supa = createClient();
  const { data: userData } = await supa.auth.getUser();
  const uid = userData.user?.id;
  if (!uid) return false;
  const { error } = await supa
    .from("user_preferences")
    .upsert({ user_id: uid, brush_presets: presets }, { onConflict: "user_id" });
  if (error) {
    console.warn("saveCloudBrushPresets:", error.message);
    return false;
  }
  return true;
}

// --- Layout presets (window tiling, 072726_window-tiling.md) --------------
// Stored in a dedicated `layout_presets jsonb` column (migration:
// specdocs/sql_archive/user-preferences-layout-presets-migration.sql). Kept out of
// loadUserPreferences' select for the same reason as brush_presets: an
// unapplied migration would take the API-key prefs down with it. Callers
// treat null as "cloud unavailable" and fall back to localStorage
// (components/effects/layout/presets.ts).

export async function loadCloudLayoutPresets(): Promise<unknown[] | null> {
  const supa = createClient();
  const { data: userData } = await supa.auth.getUser();
  const uid = userData.user?.id;
  if (!uid) return null;
  const { data, error } = await supa
    .from("user_preferences")
    .select("layout_presets")
    .eq("user_id", uid)
    .maybeSingle();
  if (error) {
    console.warn("loadCloudLayoutPresets:", error.message);
    return null;
  }
  const list = data?.layout_presets;
  return Array.isArray(list) ? list : null;
}

export async function saveCloudLayoutPresets(
  presets: unknown[]
): Promise<boolean> {
  const supa = createClient();
  const { data: userData } = await supa.auth.getUser();
  const uid = userData.user?.id;
  if (!uid) return false;
  const { error } = await supa
    .from("user_preferences")
    .upsert({ user_id: uid, layout_presets: presets }, { onConflict: "user_id" });
  if (error) {
    console.warn("saveCloudLayoutPresets:", error.message);
    return false;
  }
  return true;
}

// OpenAI key validator: hits /v1/models, free + fast.
export async function testOpenAIKey(
  key: string
): Promise<{ ok: boolean; error?: string }> {
  const trimmed = key.trim();
  if (!trimmed) return { ok: false, error: "Key is empty." };
  try {
    const res = await fetch("https://api.openai.com/v1/models", {
      method: "GET",
      headers: { Authorization: `Bearer ${trimmed}` },
    });
    if (res.ok) return { ok: true };
    if (res.status === 401)
      return { ok: false, error: "Invalid API key (401)." };
    if (res.status === 429)
      return { ok: false, error: "Rate-limited (429). Key works but throttled." };
    const body = await res.text().catch(() => "");
    return {
      ok: false,
      error: `OpenAI returned ${res.status}${body ? ": " + body.slice(0, 200) : ""}`,
    };
  } catch (e) {
    return {
      ok: false,
      error: `Network error: ${(e as Error).message ?? "unknown"}`,
    };
  }
}

// Anthropic key validator: hits /v1/models. The
// `anthropic-dangerous-direct-browser-access` header opts into Anthropic's
// CORS path so this works from the browser (the key still only goes to
// Anthropic). A 200 means the key is accepted.
export async function testAnthropicKey(
  key: string
): Promise<{ ok: boolean; error?: string }> {
  const trimmed = key.trim();
  if (!trimmed) return { ok: false, error: "Key is empty." };
  try {
    const res = await fetch("https://api.anthropic.com/v1/models?limit=1", {
      method: "GET",
      headers: {
        "x-api-key": trimmed,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
      },
    });
    if (res.ok) return { ok: true };
    if (res.status === 401)
      return { ok: false, error: "Invalid API key (401)." };
    const body = await res.text().catch(() => "");
    return {
      ok: false,
      error: `Anthropic returned ${res.status}${body ? ": " + body.slice(0, 200) : ""}`,
    };
  } catch (e) {
    return {
      ok: false,
      error: `Network error: ${(e as Error).message ?? "unknown"}`,
    };
  }
}

// HF token validator: hits the whoami endpoint, confirms the token
// is well-formed and accepted. Doesn't validate access to a
// specific gated repo (we'd need the repo path) — a 401 here means
// the token itself is invalid, while a 200 + bad-repo-access lands
// later when the model loads.
export async function testHuggingFaceToken(
  token: string
): Promise<{ ok: boolean; error?: string }> {
  const trimmed = token.trim();
  if (!trimmed) return { ok: false, error: "Token is empty." };
  try {
    const res = await fetch("https://huggingface.co/api/whoami-v2", {
      method: "GET",
      headers: { Authorization: `Bearer ${trimmed}` },
    });
    if (res.ok) return { ok: true };
    if (res.status === 401)
      return { ok: false, error: "Invalid token (401)." };
    const body = await res.text().catch(() => "");
    return {
      ok: false,
      error: `HuggingFace returned ${res.status}${
        body ? ": " + body.slice(0, 200) : ""
      }`,
    };
  } catch (e) {
    return {
      ok: false,
      error: `Network error: ${(e as Error).message ?? "unknown"}`,
    };
  }
}
