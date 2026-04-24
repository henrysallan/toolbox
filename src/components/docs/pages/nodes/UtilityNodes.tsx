"use client";

import NodeCategoryPage, { makeNodeCategoryToc } from "../../NodeRef";

export const TOC = makeNodeCategoryToc("utility");

export default function UtilityNodesPage() {
  return <NodeCategoryPage category="utility" />;
}
