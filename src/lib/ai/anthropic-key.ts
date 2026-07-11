// Authenticate the request and resolve the Claude API key, server-side:
// the signed-in user's BYO key from their (RLS-protected) preferences,
// falling back to the server env. Shared by the generate + edit recipe
// routes. The key is read here on the server — it never travels in a
// request body.
//
// A Supabase session is REQUIRED: without the check these routes are an
// anonymous LLM proxy on the server's env key (riskfix-plan §2). The env
// fallback is therefore only reachable by signed-in users without a BYO
// key.

import { createClient as createServerSupabase } from "@/lib/supabase/server";
import type { User } from "@supabase/supabase-js";

export type RecipeAuth =
  | { ok: true; user: User; apiKey: string }
  | { ok: false; status: number; error: string };

export async function resolveRecipeAuth(): Promise<RecipeAuth> {
  let user: User | null = null;
  let userKey: string | null = null;
  try {
    const supabase = await createServerSupabase();
    ({
      data: { user },
    } = await supabase.auth.getUser());
    if (user) {
      const { data } = await supabase
        .from("user_preferences")
        .select("anthropic_api_key")
        .eq("user_id", user.id)
        .maybeSingle();
      userKey = (data?.anthropic_api_key as string | null) ?? null;
    }
  } catch {
    // Supabase unreachable / auth error — treated as unauthenticated below
    // rather than silently falling through to the server env key.
  }
  if (!user)
    return { ok: false, status: 401, error: "Sign in to use AI recipes." };
  const apiKey = userKey ?? process.env.ANTHROPIC_API_KEY ?? null;
  if (!apiKey)
    return {
      ok: false,
      status: 400,
      error:
        "No Anthropic API key. Add one in User Preferences, or set ANTHROPIC_API_KEY on the server.",
    };
  return { ok: true, user, apiKey };
}
