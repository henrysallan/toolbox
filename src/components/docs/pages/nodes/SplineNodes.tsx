"use client";

import NodeCategoryPage, { makeNodeCategoryToc } from "../../NodeRef";

export const TOC = makeNodeCategoryToc("spline");

export default function SplineNodesPage() {
  return <NodeCategoryPage category="spline" />;
}
