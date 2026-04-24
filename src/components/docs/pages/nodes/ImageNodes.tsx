"use client";

import NodeCategoryPage, { makeNodeCategoryToc } from "../../NodeRef";

export const TOC = makeNodeCategoryToc("image");

export default function ImageNodesPage() {
  return <NodeCategoryPage category="image" />;
}
