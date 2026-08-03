/* tslint:disable */
/* eslint-disable */

export class PathResult {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    coords: Float64Array;
    verbs: Uint8Array;
}

/**
 * Signed area (nonzero winding; open subpaths treated as closed by chord).
 */
export function area(verbs: Uint8Array, coords: Float64Array): number;

/**
 * Axis-aligned bounding box as [x0, y0, x1, y1].
 */
export function bbox(verbs: Uint8Array, coords: Float64Array): Float64Array;

export function kernel_version(): string;

/**
 * Simplify/refit a path to the fewest cubic segments within `accuracy`
 * (same units as the coordinates — canvas px by our convention).
 * `angle_thresh` is the TANGENT of the join angle above which a join is
 * treated as a hard corner (fitting runs split there); pass tan(corner_angle).
 * `optimize` selects optimal subdivision-point search (~50x slower).
 */
export function simplify(verbs: Uint8Array, coords: Float64Array, accuracy: number, optimize: boolean, angle_thresh: number): PathResult;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_get_pathresult_coords: (a: number, b: number) => void;
    readonly __wbg_get_pathresult_verbs: (a: number, b: number) => void;
    readonly __wbg_pathresult_free: (a: number, b: number) => void;
    readonly __wbg_set_pathresult_coords: (a: number, b: number, c: number) => void;
    readonly __wbg_set_pathresult_verbs: (a: number, b: number, c: number) => void;
    readonly area: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly bbox: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly kernel_version: (a: number) => void;
    readonly simplify: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => void;
    readonly __wbindgen_add_to_stack_pointer: (a: number) => number;
    readonly __wbindgen_export: (a: number, b: number) => number;
    readonly __wbindgen_export2: (a: number, b: number, c: number) => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
