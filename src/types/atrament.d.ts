declare module "atrament" {
  export type AtramentMode = "draw" | "erase" | "fill" | "disabled";

  export interface AtramentOptions {
    width?: number;
    height?: number;
    color?: string;
    fill?: new () => Worker;
  }

  export interface StrokeEndEvent {
    x: number;
    y: number;
  }

  export default class Atrament {
    constructor(canvas: HTMLCanvasElement, options?: AtramentOptions);
    readonly canvas: HTMLCanvasElement;
    readonly dirty: boolean;
    color: string;
    weight: number;
    mode: AtramentMode;
    smoothing: number;
    adaptiveStroke: boolean;
    pressureLow: number;
    pressureHigh: number;
    secondaryMouseButton: boolean;
    ignoreModifiers: boolean;
    addEventListener(event: "strokeend", handler: (e: StrokeEndEvent) => void): void;
    addEventListener(event: "fillend", handler: (e: unknown) => void): void;
    addEventListener(event: string, handler: (e: unknown) => void): void;
    removeEventListener(event: string, handler: (e: unknown) => void): void;
    dispatchEvent(event: string, payload?: unknown): void;
    beginStroke(x: number, y: number): void;
    endStroke(x: number, y: number): void;
    draw(
      x: number,
      y: number,
      prevX: number,
      prevY: number,
      pressure?: number
    ): { x: number; y: number };
    clear(): void;
    destroy(): void;
  }

  export const MODE_DRAW: "draw";
  export const MODE_ERASE: "erase";
  export const MODE_FILL: "fill";
  export const MODE_DISABLED: "disabled";
}

declare module "atrament/fill" {
  const FillWorker: new () => Worker;
  export default FillWorker;
}
