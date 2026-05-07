import { createClient } from "@/lib/supabase/client";

// Editor-wide user preferences.
// - openaiApiKey: BYO-key for AI nodes (Image Generate).
// - huggingfaceToken: optional read-only HF token for gated models
//   (e.g. briaai/RMBG-2.0). Anonymous access works for non-gated
//   weights; gated repos return 401 without a token.
//
// Schema mirrors specdocs/user-preferences-migration.sql.

export interface UserPreferences {
  openaiApiKey: string | null;
  huggingfaceToken: string | null;
}

const EMPTY: UserPreferences = {
  openaiApiKey: null,
  huggingfaceToken: null,
};

export async function loadUserPreferences(): Promise<UserPreferences> {
  const supa = createClient();
  const { data: userData } = await supa.auth.getUser();
  const uid = userData.user?.id;
  if (!uid) return EMPTY;
  const { data, error } = await supa
    .from("user_preferences")
    .select("openai_api_key, hf_token")
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
  if ("huggingfaceToken" in next) payload.hf_token = next.huggingfaceToken;
  const { error } = await supa
    .from("user_preferences")
    .upsert(payload, { onConflict: "user_id" });
  if (error) return { ok: false, error: error.message };
  return { ok: true };
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
