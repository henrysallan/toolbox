// Resolve the Claude API key for a request, server-side: the signed-in user's
// BYO key from their (RLS-protected) preferences, falling back to the server
// env. Shared by the generate + edit recipe routes. The key is read here on the
// server — it never travels in a request body.

import { createClient as createServerSupabase } from "@/lib/supabase/server";

export async function resolveAnthropicKey(): Promise<string | null> {
  try {
    const supabase = await createServerSupabase();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (user) {
      const { data } = await supabase
        .from("user_preferences")
        .select("anthropic_api_key")
        .eq("user_id", user.id)
        .maybeSingle();
      const userKey = (data?.anthropic_api_key as string | null) ?? null;
      if (userKey) return userKey;
    }
  } catch {
    // Auth/prefs unavailable — fall through to the server env key.
  }
  return process.env.ANTHROPIC_API_KEY ?? null;
}
