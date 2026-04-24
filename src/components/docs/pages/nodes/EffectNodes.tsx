"use client";

import NodeCategoryPage, { makeNodeCategoryToc } from "../../NodeRef";

export const TOC = makeNodeCategoryToc("effect");

export default function EffectNodesPage() {
  return <NodeCategoryPage category="effect" />;
}
