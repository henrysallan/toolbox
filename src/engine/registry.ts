import type { NodeDefinition } from "./types";

const registry = new Map<string, NodeDefinition>();

export function registerNode(def: NodeDefinition): void {
  if (registry.has(def.type)) {
    console.warn(`Node type "${def.type}" re-registered — replacing.`);
  }
  registry.set(def.type, def);
}

export function getNodeDef(type: string): NodeDefinition | undefined {
  return registry.get(type);
}

export function allNodeDefs(): NodeDefinition[] {
  return Array.from(registry.values());
}
