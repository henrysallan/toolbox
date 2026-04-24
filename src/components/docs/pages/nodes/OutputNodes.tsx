"use client";

import NodeCategoryPage, { makeNodeCategoryToc } from "../../NodeRef";

export const TOC = makeNodeCategoryToc("output");

export default function OutputNodesPage() {
  return <NodeCategoryPage category="output" />;
}
