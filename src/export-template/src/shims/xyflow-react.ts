// Type-only shim for @xyflow/react. The editor's `src/lib/project.ts`
// imports `Edge` and `Node` as types; both are erased at runtime so we
// only need the shapes the engine actually consumes.

export interface Node<TData = Record<string, unknown>> {
  id: string;
  type?: string;
  position: { x: number; y: number };
  data: TData;
}

export interface Edge {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string | null;
  targetHandle?: string | null;
}
