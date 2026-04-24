import { notFound } from "next/navigation";
import { findPageBySlug } from "@/lib/docs/manifest";
import PrevNext from "@/components/docs/PrevNext";

// Dynamic article route. Slug segments map back to the manifest;
// if no page matches, we surface a 404 rather than an empty shell.
// Each page component renders its own typography (via DocPage
// primitives); this wrapper just adds the prev/next footer.

interface Props {
  params: Promise<{ slug: string[] }>;
}

export default async function DocArticle({ params }: Props) {
  const { slug } = await params;
  const page = findPageBySlug(slug);
  if (!page) notFound();
  const Body = page.Component;
  return (
    <>
      <Body />
      <PrevNext currentSlug={slug} />
    </>
  );
}
