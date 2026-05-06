import { createClient } from "@/lib/supabase/client";

// Editor-wide user preferences. v1 carries an OpenAI API key for the
// BYO-key AI nodes (Image Generate, etc.). Schema mirrors the
// migration in specdocs/user-preferences-migration.sql.

export interface UserPreferences {
  openaiApiKey: string | null;
}

const EMPTY: UserPreferences = { openaiApiKey: null };

// Fetch the row for the active session. Returns EMPTY when the user
// is signed out OR the row simply doesn't exist yet (first-time
// load — saving creates it).
export async function loadUserPreferences(): Promise<UserPreferences> {
  const supa = createClient();
  const { data: userData } = await supa.auth.getUser();
  const uid = userData.user?.id;
  if (!uid) return EMPTY;
  const { data, error } = await supa
    .from("user_preferences")
    .select("openai_api_key")
    .eq("user_id", uid)
    .maybeSingle();
  if (error) {
    // Row-not-found surfaces as data=null without an error; treat any
    // genuine error as "no preferences yet" rather than throwing —
    // a transient prefs failure shouldn't break the whole editor.
    console.warn("loadUserPreferences:", error.message);
    return EMPTY;
  }
  return {
    openaiApiKey: (data?.openai_api_key as string | null) ?? null,
  };
}

// Upsert the active session's preferences row. Pass `null` to clear a
// field (e.g. removing a saved key).
export async function saveUserPreferences(
  next: Partial<UserPreferences>
): Promise<{ ok: boolean; error?: string }> {
  const supa = createClient();
  const { data: userData } = await supa.auth.getUser();
  const uid = userData.user?.id;
  if (!uid) return { ok: false, error: "Not signed in." };
  const payload: Record<string, unknown> = { user_id: uid };
  if ("openaiApiKey" in next) payload.openai_api_key = next.openaiApiKey;
  const { error } = await supa
    .from("user_preferences")
    .upsert(payload, { onConflict: "user_id" });
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

// Lightweight key validator: hits OpenAI's /v1/models endpoint, which
// is free + immediate and confirms the key is valid + not blocked.
// Returns a structured result so the modal can phrase the error.
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
