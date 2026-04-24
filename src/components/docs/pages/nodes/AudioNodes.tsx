"use client";

import NodeCategoryPage, { makeNodeCategoryToc } from "../../NodeRef";

export const TOC = makeNodeCategoryToc("audio");

export default function AudioNodesPage() {
  return <NodeCategoryPage category="audio" />;
}
