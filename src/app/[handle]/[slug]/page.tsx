import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { loadPublicProjectByVanity } from "@/lib/supabase/projects";
import { handleFromSegment, isValidVanitySlug } from "@/lib/vanity-slug";
import LiveClient from "@/app/live/[slug]/LiveClient";
import type { Metadata } from "next";

// Named live link (specdocs/092126_vanity-live-links.md): /@<handle>/<slug>
// renders the same live viewer as /live/<public_slug>, resolved through
// the owner's handle and the project's title-derived vanity slug.
//
// The [handle] segment is a root-level dynamic route, so it receives EVERY
// two-segment URL Next didn't match statically (/p, /live, /docs, /join,
// /api, /auth all win first). Only "@<valid handle>" is ours — anything
// else 404s here, same as it did before this route existed.
//
// Dynamic like /live: a private flip, a rename or a slug change shows on
// the next load.
export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ handle: string; slug: string }>;
}

async function resolve(params: PageProps["params"]) {
  const { handle: seg, slug } = await params;
  const handle = handleFromSegment(seg);
  if (!handle || !isValidVanitySlug(slug)) return null;
  const supabase = await createClient();
  return loadPublicProjectByVanity(supabase, handle, slug);
}

export async function generateMetadata({
  params,
}: PageProps): Promise<Metadata> {
  const project = await resolve(params);
  if (!project) {
    return { title: "Live · not found" };
  }
  return {
    title: `${project.name} · Toolbox Live`,
    description: project.author?.display_name
      ? `A live patch by ${project.author.display_name} on Toolbox`
      : "A live patch on Toolbox",
  };
}

export default async function VanityLivePage({ params }: PageProps) {
  const project = await resolve(params);
  if (!project) notFound();

  return (
    <LiveClient
      // The panel's share code and "Editor" link come from the random
      // public slug — that is the project's permanent identity; the
      // vanity path is an alias on top of it.
      slug={project.public_slug ?? ""}
      name={project.name}
      authorName={project.author?.display_name ?? null}
      graph={project.graph}
    />
  );
}
