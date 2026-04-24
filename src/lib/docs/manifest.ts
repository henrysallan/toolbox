import type { ComponentType } from "react";
// Ensure the node registry is populated before any docs page
// (or TOC helper) reads from it. Idempotent.
import { registerAllNodes } from "@/nodes";
registerAllNodes();
import WelcomePage from "@/components/docs/pages/Welcome";
import YourFirstGraphPage, {
  TOC as YourFirstGraphToc,
} from "@/components/docs/pages/YourFirstGraph";
import EditorBasicsPage, {
  TOC as EditorBasicsToc,
} from "@/components/docs/pages/EditorBasics";
import KeyboardShortcutsPage from "@/components/docs/pages/KeyboardShortcuts";
import SavingAndLoadingPage, {
  TOC as SavingAndLoadingToc,
} from "@/components/docs/pages/SavingAndLoading";
import PublicPrivatePage, {
  TOC as PublicPrivateToc,
} from "@/components/docs/pages/PublicPrivate";
import ImageNodesPage, {
  TOC as ImageNodesToc,
} from "@/components/docs/pages/nodes/ImageNodes";
import SplineNodesPage, {
  TOC as SplineNodesToc,
} from "@/components/docs/pages/nodes/SplineNodes";
import PointNodesPage, {
  TOC as PointNodesToc,
} from "@/components/docs/pages/nodes/PointNodes";
import AudioNodesPage, {
  TOC as AudioNodesToc,
} from "@/components/docs/pages/nodes/AudioNodes";
import UtilityNodesPage, {
  TOC as UtilityNodesToc,
} from "@/components/docs/pages/nodes/UtilityNodes";
import EffectNodesPage, {
  TOC as EffectNodesToc,
} from "@/components/docs/pages/nodes/EffectNodes";
import OutputNodesPage, {
  TOC as OutputNodesToc,
} from "@/components/docs/pages/nodes/OutputNodes";

// Single source of truth for the /docs tree. Every entry lives
// under a section (for sidebar grouping) and carries the URL slug
// plus the component that renders its body. Adding a page means:
//   1. Write the component under src/components/docs/pages.
//   2. Append an entry to one of the sections below.
// That's it — the sidebar, landing-page index, and dynamic route
// all consume this same manifest.

// Entries in the sidebar's per-page TOC. Regular items link to an
// in-page anchor; group entries are non-clickable visual headers
// used by the auto-generated node-category pages to keep long
// flat lists readable.
export interface TocItem {
  id: string;
  title: string;
  kind?: "group";
}

export interface DocPage {
  // URL path segments under /docs. ["editor", "basics"] →
  // /docs/editor/basics. Must be URL-safe (lowercase, hyphens).
  slug: string[];
  title: string;
  // Short sentence shown under the title in the landing-page
  // index and (eventually) search results.
  summary: string;
  Component: ComponentType;
  // In-page H2 anchors. When the page is active in the sidebar,
  // these show up indented beneath its title as a second-level
  // nav. Optional because short pages (landing, shortcuts
  // reference, auto-generated node categories) don't need one.
  toc?: TocItem[];
}

export interface DocSection {
  title: string;
  pages: DocPage[];
}

export const DOCS: DocSection[] = [
  {
    title: "Introduction",
    pages: [
      {
        slug: ["welcome"],
        title: "Welcome",
        summary: "What Toolbox is, and what you can build with it.",
        Component: WelcomePage,
      },
      {
        slug: ["first-graph"],
        title: "Your first graph",
        summary: "Five-minute walkthrough: load an image, add an effect, save it.",
        Component: YourFirstGraphPage,
        toc: YourFirstGraphToc,
      },
    ],
  },
  {
    title: "Editor",
    pages: [
      {
        slug: ["editor", "basics"],
        title: "Editor basics",
        summary: "The node graph, wiring, and the parameters panel.",
        Component: EditorBasicsPage,
        toc: EditorBasicsToc,
      },
      {
        slug: ["editor", "keyboard"],
        title: "Keyboard shortcuts",
        summary: "Every shortcut in one table.",
        Component: KeyboardShortcutsPage,
      },
    ],
  },
  {
    title: "Projects",
    pages: [
      {
        slug: ["projects", "saving"],
        title: "Saving and loading",
        summary: "Save, Save As, Save Incremental, collisions, thumbnails.",
        Component: SavingAndLoadingPage,
        toc: SavingAndLoadingToc,
      },
      {
        slug: ["projects", "public-private"],
        title: "Public vs. private",
        summary: "Ownership rules, copy-on-save, authorship display.",
        Component: PublicPrivatePage,
        toc: PublicPrivateToc,
      },
    ],
  },
  {
    title: "Node reference",
    pages: [
      {
        slug: ["nodes", "image"],
        title: "Image",
        summary: "Raster sources and modifiers.",
        Component: ImageNodesPage,
        toc: ImageNodesToc,
      },
      {
        slug: ["nodes", "spline"],
        title: "Spline",
        summary: "Vector geometry, shapes, path operations.",
        Component: SplineNodesPage,
        toc: SplineNodesToc,
      },
      {
        slug: ["nodes", "point"],
        title: "Point",
        summary: "Point clouds and instance-by-point operations.",
        Component: PointNodesPage,
        toc: PointNodesToc,
      },
      {
        slug: ["nodes", "audio"],
        title: "Audio",
        summary: "Audio sources and scalar coercion.",
        Component: AudioNodesPage,
        toc: AudioNodesToc,
      },
      {
        slug: ["nodes", "utility"],
        title: "Utility",
        summary: "Cross-type helpers — math, grouping, arraying, transform.",
        Component: UtilityNodesPage,
        toc: UtilityNodesToc,
      },
      {
        slug: ["nodes", "effect"],
        title: "Effect",
        summary: "Compound effects like simulation zones.",
        Component: EffectNodesPage,
        toc: EffectNodesToc,
      },
      {
        slug: ["nodes", "output"],
        title: "Output",
        summary: "Terminal nodes — what the preview canvas sees.",
        Component: OutputNodesPage,
        toc: OutputNodesToc,
      },
    ],
  },
];

// Helpers ------------------------------------------------------------

export function slugPath(slug: string[]): string {
  return `/docs/${slug.join("/")}`;
}

export function findPageBySlug(slug: string[]): DocPage | null {
  const joined = slug.join("/");
  for (const section of DOCS) {
    for (const page of section.pages) {
      if (page.slug.join("/") === joined) return page;
    }
  }
  return null;
}

// Flat list in manifest order, used for prev/next footer links.
export function flatPages(): DocPage[] {
  return DOCS.flatMap((s) => s.pages);
}
