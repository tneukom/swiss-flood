/* tslint:disable */
/* eslint-disable */

export class DamInfo {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    cells: number;
    terrain_max: number;
    /**
     * Lowest and highest terrain under the dam, 0 if it has no cells.
     */
    terrain_min: number;
}

export class FloodModel {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Adds a dam (LV95 polyline as [x0, y0, x1, y1, ...]) with its crest in metres a.s.l.
     * Dams are numbered in the order they're added, which `lake_dam` refers to.
     */
    add_dam(xy: Float64Array, crest: number): void;
    base_level_at(i: number): number;
    clear_dams(): void;
    cols(): number;
    /**
     * Floods with the current dams, renders the overlay and finds lakes. Only recomputes the
     * region upstream of the dams, see the module docs.
     */
    compute(): Stats;
    /**
     * Pointer to the terrain with dam crests applied (cols × rows u16), for tests and benchmarks.
     */
    dam_height_ptr(): number;
    /**
     * Rasterizes a dam polyline without adding it, e.g. to pick a default crest.
     * `xy`: LV95 coordinates as [x0, y0, x1, y1, ...].
     */
    dam_info(xy: Float64Array): DamInfo;
    lake_cells(k: number): number;
    lake_count(): number;
    /**
     * Index of the dam the lake overflows, or -1.
     */
    lake_dam(k: number): number;
    /**
     * True if the pour cell is an outlet, i.e. the lake drains straight across the border.
     */
    lake_drains_to_border(k: number): boolean;
    lake_level(k: number): number;
    /**
     * Cells from the overflow point down to the border.
     */
    lake_path(k: number): Uint32Array;
    lake_pour(k: number): number;
    lake_spill(k: number): number;
    level_at(i: number): number;
    /**
     * Pointer to the water levels with dams (cols × rows u16), for tests and benchmarks.
     */
    level_ptr(): number;
    /**
     * `compressed`: dem.bin.zst (zstd of delta-encoded u16 heights split into low/high byte
     * planes, see preprocess/). `west`/`north`: LV95 north-west corner.
     */
    constructor(compressed: Uint8Array, cols: number, rows: number, west: number, north: number, cellsize: number);
    /**
     * Number of cells the last compute re-flooded (dam cells and their upstream catchment).
     */
    region_cells(): number;
    /**
     * Pointer to the RGBA overlay (cols × rows × 4 bytes) in WASM memory. Create the JS view
     * after `compute`: if WASM memory grew, older views are detached.
     */
    rgba_ptr(): number;
    rows(): number;
    terrain_at(i: number): number;
}

export class Stats {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Number of flooded cells (level above baseline, not a dam cell).
     */
    flooded_cells: number;
    /**
     * Sum over flooded cells of (level - baseline) in metres; × cell area = volume.
     */
    volume_cell_metres: number;
}

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_daminfo_free: (a: number, b: number) => void;
    readonly __wbg_floodmodel_free: (a: number, b: number) => void;
    readonly __wbg_get_daminfo_cells: (a: number) => number;
    readonly __wbg_get_daminfo_terrain_max: (a: number) => number;
    readonly __wbg_get_daminfo_terrain_min: (a: number) => number;
    readonly __wbg_get_stats_flooded_cells: (a: number) => number;
    readonly __wbg_get_stats_volume_cell_metres: (a: number) => number;
    readonly __wbg_set_daminfo_cells: (a: number, b: number) => void;
    readonly __wbg_set_daminfo_terrain_max: (a: number, b: number) => void;
    readonly __wbg_set_daminfo_terrain_min: (a: number, b: number) => void;
    readonly __wbg_set_stats_flooded_cells: (a: number, b: number) => void;
    readonly __wbg_set_stats_volume_cell_metres: (a: number, b: number) => void;
    readonly __wbg_stats_free: (a: number, b: number) => void;
    readonly floodmodel_add_dam: (a: number, b: number, c: number, d: number) => void;
    readonly floodmodel_base_level_at: (a: number, b: number) => number;
    readonly floodmodel_clear_dams: (a: number) => void;
    readonly floodmodel_cols: (a: number) => number;
    readonly floodmodel_compute: (a: number) => number;
    readonly floodmodel_dam_height_ptr: (a: number) => number;
    readonly floodmodel_dam_info: (a: number, b: number, c: number) => number;
    readonly floodmodel_lake_cells: (a: number, b: number) => number;
    readonly floodmodel_lake_count: (a: number) => number;
    readonly floodmodel_lake_dam: (a: number, b: number) => number;
    readonly floodmodel_lake_drains_to_border: (a: number, b: number) => number;
    readonly floodmodel_lake_level: (a: number, b: number) => number;
    readonly floodmodel_lake_path: (a: number, b: number) => [number, number];
    readonly floodmodel_lake_pour: (a: number, b: number) => number;
    readonly floodmodel_lake_spill: (a: number, b: number) => number;
    readonly floodmodel_level_at: (a: number, b: number) => number;
    readonly floodmodel_level_ptr: (a: number) => number;
    readonly floodmodel_new: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => [number, number, number];
    readonly floodmodel_region_cells: (a: number) => number;
    readonly floodmodel_rgba_ptr: (a: number) => number;
    readonly floodmodel_rows: (a: number) => number;
    readonly floodmodel_terrain_at: (a: number, b: number) => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_start: () => void;
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
