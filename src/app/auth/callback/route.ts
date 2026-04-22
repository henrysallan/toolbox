import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";

// Receives the OAuth redirect from Supabase after the user signs in with
// Google, swaps the single-use `code` for a session, and bounces back to the
// app. The `next` query param (set when kicking off the flow) controls
// where the user lands — defaults to the home page.
export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const next = searchParams.get("next") ?? "/";

  if (code) {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) {
      return NextResponse.redirect(`${origin}${next}`);
    }
  }

  // Something went wrong — land on home with an error query so the UI can
  // surface it without crashing.
  return NextResponse.redirect(`${origin}/?auth_error=1`);
}
