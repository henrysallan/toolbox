import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

function isLoopbackHost(host: string): boolean {
  const hostname = host.split(":")[0]?.replace(/^\[|\]$/g, "") ?? "";
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

// Prefer the Host the browser actually hit. Next can populate request.url
// from x-forwarded-host (often the production domain), which would bounce a
// successful local OAuth callback off localhost and onto the live site.
function resolveAuthOrigin(request: NextRequest): string {
  const host = request.headers.get("host") ?? "";
  if (isLoopbackHost(host)) {
    return `http://${host}`;
  }
  const forwardedHost = request.headers.get("x-forwarded-host");
  const forwardedProto = request.headers.get("x-forwarded-proto") ?? "https";
  if (forwardedHost) {
    return `${forwardedProto}://${forwardedHost}`;
  }
  return new URL(request.url).origin;
}

function safeNextPath(raw: string | null): string {
  if (!raw || !raw.startsWith("/") || raw.startsWith("//")) return "/";
  return raw;
}

// Receives the OAuth redirect from Supabase after the user signs in with
// Google, swaps the single-use `code` for a session, and bounces back to the
// app. The `next` query param (set when kicking off the flow) controls
// where the user lands — defaults to the home page.
export async function GET(request: NextRequest) {
  const origin = resolveAuthOrigin(request);
  const code = request.nextUrl.searchParams.get("code");
  const next = safeNextPath(request.nextUrl.searchParams.get("next"));

  if (!code) {
    return NextResponse.redirect(`${origin}/?auth_error=1`);
  }

  let redirect = NextResponse.redirect(`${origin}${next}`);
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value)
          );
          redirect = NextResponse.redirect(`${origin}${next}`);
          cookiesToSet.forEach(({ name, value, options }) =>
            redirect.cookies.set(name, value, options)
          );
        },
      },
    }
  );

  const { error } = await supabase.auth.exchangeCodeForSession(code);
  if (error) {
    return NextResponse.redirect(`${origin}/?auth_error=1`);
  }
  return redirect;
}
