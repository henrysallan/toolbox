"use client";

import NodeCategoryPage, { makeNodeCategoryToc } from "../../NodeRef";

export const TOC = makeNodeCategoryToc("point");

export default function PointNodesPage() {
  return <NodeCategoryPage category="point" />;
}
