/* @ts-self-types="./flood_wasm.d.ts" */

export class DamInfo {
    static __wrap(ptr) {
        const obj = Object.create(DamInfo.prototype);
        obj.__wbg_ptr = ptr;
        DamInfoFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        DamInfoFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_daminfo_free(ptr, 0);
    }
    /**
     * @returns {number}
     */
    get cells() {
        const ret = wasm.__wbg_get_daminfo_cells(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {number}
     */
    get terrain_max() {
        const ret = wasm.__wbg_get_daminfo_terrain_max(this.__wbg_ptr);
        return ret;
    }
    /**
     * Lowest and highest terrain under the dam, 0 if it has no cells.
     * @returns {number}
     */
    get terrain_min() {
        const ret = wasm.__wbg_get_daminfo_terrain_min(this.__wbg_ptr);
        return ret;
    }
    /**
     * @param {number} arg0
     */
    set cells(arg0) {
        wasm.__wbg_set_daminfo_cells(this.__wbg_ptr, arg0);
    }
    /**
     * @param {number} arg0
     */
    set terrain_max(arg0) {
        wasm.__wbg_set_daminfo_terrain_max(this.__wbg_ptr, arg0);
    }
    /**
     * Lowest and highest terrain under the dam, 0 if it has no cells.
     * @param {number} arg0
     */
    set terrain_min(arg0) {
        wasm.__wbg_set_daminfo_terrain_min(this.__wbg_ptr, arg0);
    }
}
if (Symbol.dispose) DamInfo.prototype[Symbol.dispose] = DamInfo.prototype.free;

export class FloodModel {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        FloodModelFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_floodmodel_free(ptr, 0);
    }
    /**
     * Adds a dam (LV95 polyline as [x0, y0, x1, y1, ...]) with its crest in metres a.s.l.
     * Dams are numbered in the order they're added, which `lake_dam` refers to.
     * @param {Float64Array} xy
     * @param {number} crest
     */
    add_dam(xy, crest) {
        const ptr0 = passArrayF64ToWasm0(xy, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        wasm.floodmodel_add_dam(this.__wbg_ptr, ptr0, len0, crest);
    }
    /**
     * @param {number} i
     * @returns {number}
     */
    base_level_at(i) {
        const ret = wasm.floodmodel_base_level_at(this.__wbg_ptr, i);
        return ret;
    }
    clear_dams() {
        wasm.floodmodel_clear_dams(this.__wbg_ptr);
    }
    /**
     * @returns {number}
     */
    cols() {
        const ret = wasm.floodmodel_cols(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Floods with the current dams, renders the overlay and finds lakes. Only recomputes the
     * region upstream of the dams, see the module docs.
     * @returns {Stats}
     */
    compute() {
        const ret = wasm.floodmodel_compute(this.__wbg_ptr);
        return Stats.__wrap(ret);
    }
    /**
     * Pointer to the terrain with dam crests applied (cols × rows u16), for tests and benchmarks.
     * @returns {number}
     */
    dam_height_ptr() {
        const ret = wasm.floodmodel_dam_height_ptr(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Rasterizes a dam polyline without adding it, e.g. to pick a default crest.
     * `xy`: LV95 coordinates as [x0, y0, x1, y1, ...].
     * @param {Float64Array} xy
     * @returns {DamInfo}
     */
    dam_info(xy) {
        const ptr0 = passArrayF64ToWasm0(xy, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.floodmodel_dam_info(this.__wbg_ptr, ptr0, len0);
        return DamInfo.__wrap(ret);
    }
    /**
     * @param {number} k
     * @returns {number}
     */
    lake_cells(k) {
        const ret = wasm.floodmodel_lake_cells(this.__wbg_ptr, k);
        return ret >>> 0;
    }
    /**
     * @returns {number}
     */
    lake_count() {
        const ret = wasm.floodmodel_lake_count(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Index of the dam the lake overflows, or -1.
     * @param {number} k
     * @returns {number}
     */
    lake_dam(k) {
        const ret = wasm.floodmodel_lake_dam(this.__wbg_ptr, k);
        return ret;
    }
    /**
     * True if the pour cell is an outlet, i.e. the lake drains straight across the border.
     * @param {number} k
     * @returns {boolean}
     */
    lake_drains_to_border(k) {
        const ret = wasm.floodmodel_lake_drains_to_border(this.__wbg_ptr, k);
        return ret !== 0;
    }
    /**
     * @param {number} k
     * @returns {number}
     */
    lake_level(k) {
        const ret = wasm.floodmodel_lake_level(this.__wbg_ptr, k);
        return ret;
    }
    /**
     * Cells from the overflow point down to the border.
     * @param {number} k
     * @returns {Uint32Array}
     */
    lake_path(k) {
        const ret = wasm.floodmodel_lake_path(this.__wbg_ptr, k);
        var v1 = getArrayU32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * @param {number} k
     * @returns {number}
     */
    lake_pour(k) {
        const ret = wasm.floodmodel_lake_pour(this.__wbg_ptr, k);
        return ret >>> 0;
    }
    /**
     * @param {number} k
     * @returns {number}
     */
    lake_spill(k) {
        const ret = wasm.floodmodel_lake_spill(this.__wbg_ptr, k);
        return ret >>> 0;
    }
    /**
     * @param {number} i
     * @returns {number}
     */
    level_at(i) {
        const ret = wasm.floodmodel_level_at(this.__wbg_ptr, i);
        return ret;
    }
    /**
     * Pointer to the water levels with dams (cols × rows u16), for tests and benchmarks.
     * @returns {number}
     */
    level_ptr() {
        const ret = wasm.floodmodel_level_ptr(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * `compressed`: dem.bin.zst (zstd of delta-encoded u16 heights split into low/high byte
     * planes, see preprocess/). `west`/`north`: LV95 north-west corner.
     * @param {Uint8Array} compressed
     * @param {number} cols
     * @param {number} rows
     * @param {number} west
     * @param {number} north
     * @param {number} cellsize
     */
    constructor(compressed, cols, rows, west, north, cellsize) {
        const ptr0 = passArray8ToWasm0(compressed, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.floodmodel_new(ptr0, len0, cols, rows, west, north, cellsize);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        this.__wbg_ptr = ret[0];
        FloodModelFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * Number of cells the last compute re-flooded (dam cells and their upstream catchment).
     * @returns {number}
     */
    region_cells() {
        const ret = wasm.floodmodel_region_cells(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Pointer to the RGBA overlay (cols × rows × 4 bytes) in WASM memory. Create the JS view
     * after `compute`: if WASM memory grew, older views are detached.
     * @returns {number}
     */
    rgba_ptr() {
        const ret = wasm.floodmodel_rgba_ptr(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {number}
     */
    rows() {
        const ret = wasm.floodmodel_rows(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @param {number} i
     * @returns {number}
     */
    terrain_at(i) {
        const ret = wasm.floodmodel_terrain_at(this.__wbg_ptr, i);
        return ret;
    }
}
if (Symbol.dispose) FloodModel.prototype[Symbol.dispose] = FloodModel.prototype.free;

export class Stats {
    static __wrap(ptr) {
        const obj = Object.create(Stats.prototype);
        obj.__wbg_ptr = ptr;
        StatsFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        StatsFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_stats_free(ptr, 0);
    }
    /**
     * Number of flooded cells (level above baseline, not a dam cell).
     * @returns {number}
     */
    get flooded_cells() {
        const ret = wasm.__wbg_get_stats_flooded_cells(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Sum over flooded cells of (level - baseline) in metres; × cell area = volume.
     * @returns {number}
     */
    get volume_cell_metres() {
        const ret = wasm.__wbg_get_stats_volume_cell_metres(this.__wbg_ptr);
        return ret;
    }
    /**
     * Number of flooded cells (level above baseline, not a dam cell).
     * @param {number} arg0
     */
    set flooded_cells(arg0) {
        wasm.__wbg_set_stats_flooded_cells(this.__wbg_ptr, arg0);
    }
    /**
     * Sum over flooded cells of (level - baseline) in metres; × cell area = volume.
     * @param {number} arg0
     */
    set volume_cell_metres(arg0) {
        wasm.__wbg_set_stats_volume_cell_metres(this.__wbg_ptr, arg0);
    }
}
if (Symbol.dispose) Stats.prototype[Symbol.dispose] = Stats.prototype.free;
function __wbg_get_imports() {
    const import0 = {
        __proto__: null,
        __wbg_Error_30c8987f7c2ed4e2: function(arg0, arg1) {
            const ret = Error(getStringFromWasm0(arg0, arg1));
            return ret;
        },
        __wbg___wbindgen_throw_41e9ee4f547fc59a: function(arg0, arg1) {
            throw new Error(getStringFromWasm0(arg0, arg1));
        },
        __wbindgen_init_externref_table: function() {
            const table = wasm.__wbindgen_externrefs;
            const offset = table.grow(4);
            table.set(0, undefined);
            table.set(offset + 0, undefined);
            table.set(offset + 1, null);
            table.set(offset + 2, true);
            table.set(offset + 3, false);
        },
    };
    return {
        __proto__: null,
        "./flood_wasm_bg.js": import0,
    };
}

const DamInfoFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_daminfo_free(ptr, 1));
const FloodModelFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_floodmodel_free(ptr, 1));
const StatsFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_stats_free(ptr, 1));

function getArrayU32FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getUint32ArrayMemory0().subarray(ptr / 4, ptr / 4 + len);
}

let cachedFloat64ArrayMemory0 = null;
function getFloat64ArrayMemory0() {
    if (cachedFloat64ArrayMemory0 === null || cachedFloat64ArrayMemory0.byteLength === 0) {
        cachedFloat64ArrayMemory0 = new Float64Array(wasm.memory.buffer);
    }
    return cachedFloat64ArrayMemory0;
}

function getStringFromWasm0(ptr, len) {
    return decodeText(ptr >>> 0, len);
}

let cachedUint32ArrayMemory0 = null;
function getUint32ArrayMemory0() {
    if (cachedUint32ArrayMemory0 === null || cachedUint32ArrayMemory0.byteLength === 0) {
        cachedUint32ArrayMemory0 = new Uint32Array(wasm.memory.buffer);
    }
    return cachedUint32ArrayMemory0;
}

let cachedUint8ArrayMemory0 = null;
function getUint8ArrayMemory0() {
    if (cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.byteLength === 0) {
        cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);
    }
    return cachedUint8ArrayMemory0;
}

function passArray8ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 1, 1) >>> 0;
    getUint8ArrayMemory0().set(arg, ptr / 1);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function passArrayF64ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 8, 8) >>> 0;
    getFloat64ArrayMemory0().set(arg, ptr / 8);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function takeFromExternrefTable0(idx) {
    const value = wasm.__wbindgen_externrefs.get(idx);
    wasm.__externref_table_dealloc(idx);
    return value;
}

let cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
cachedTextDecoder.decode();
const MAX_SAFARI_DECODE_BYTES = 2146435072;
let numBytesDecoded = 0;
function decodeText(ptr, len) {
    numBytesDecoded += len;
    if (numBytesDecoded >= MAX_SAFARI_DECODE_BYTES) {
        cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
        cachedTextDecoder.decode();
        numBytesDecoded = len;
    }
    return cachedTextDecoder.decode(getUint8ArrayMemory0().subarray(ptr, ptr + len));
}

let WASM_VECTOR_LEN = 0;

let wasmModule, wasmInstance, wasm;
function __wbg_finalize_init(instance, module) {
    wasmInstance = instance;
    wasm = instance.exports;
    wasmModule = module;
    cachedFloat64ArrayMemory0 = null;
    cachedUint32ArrayMemory0 = null;
    cachedUint8ArrayMemory0 = null;
    wasm.__wbindgen_start();
    return wasm;
}

async function __wbg_load(module, imports) {
    if (typeof Response === 'function' && module instanceof Response) {
        if (!module.ok) {
            throw new Error(`failed to fetch Wasm: ${module.status} ${module.statusText} fetching '${module.url}'`);
        }

        if (typeof WebAssembly.instantiateStreaming === 'function') {
            try {
                return await WebAssembly.instantiateStreaming(module, imports);
            } catch (e) {
                const validResponse = expectedResponseType(module.type);

                if (validResponse && module.headers.get('Content-Type') !== 'application/wasm') {
                    console.warn("`WebAssembly.instantiateStreaming` failed because your server does not serve Wasm with `application/wasm` MIME type. Falling back to `WebAssembly.instantiate` which is slower. Original error:\n", e);

                } else { throw e; }
            }
        }

        const bytes = await module.arrayBuffer();
        return await WebAssembly.instantiate(bytes, imports);
    } else {
        const instance = await WebAssembly.instantiate(module, imports);

        if (instance instanceof WebAssembly.Instance) {
            return { instance, module };
        } else {
            return instance;
        }
    }

    function expectedResponseType(type) {
        switch (type) {
            case 'basic': case 'cors': case 'default': return true;
        }
        return false;
    }
}

function initSync(module) {
    if (wasm !== undefined) return wasm;


    if (module !== undefined) {
        if (Object.getPrototypeOf(module) === Object.prototype) {
            ({module} = module)
        } else {
            console.warn('using deprecated parameters for `initSync()`; pass a single object instead')
        }
    }

    const imports = __wbg_get_imports();
    if (!(module instanceof WebAssembly.Module)) {
        module = new WebAssembly.Module(module);
    }
    const instance = new WebAssembly.Instance(module, imports);
    return __wbg_finalize_init(instance, module);
}

async function __wbg_init(module_or_path) {
    if (wasm !== undefined) return wasm;


    if (module_or_path !== undefined) {
        if (Object.getPrototypeOf(module_or_path) === Object.prototype) {
            ({module_or_path} = module_or_path)
        } else {
            console.warn('using deprecated parameters for the initialization function; pass a single object instead')
        }
    }

    if (module_or_path === undefined) {
        module_or_path = new URL('flood_wasm_bg.wasm', import.meta.url);
    }
    const imports = __wbg_get_imports();

    if (typeof module_or_path === 'string' || (typeof Request === 'function' && module_or_path instanceof Request) || (typeof URL === 'function' && module_or_path instanceof URL)) {
        module_or_path = fetch(module_or_path);
    }

    const { instance, module } = await __wbg_load(await module_or_path, imports);

    return __wbg_finalize_init(instance, module);
}

export { initSync, __wbg_init as default };
