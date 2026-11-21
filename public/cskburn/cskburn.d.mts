// SPDX-License-Identifier: GPL-3.0-or-later
/** Emscripten module factory for the cskburn WebAssembly build (tools/cskburn-wasm). */
declare const createModule: (options: Record<string, unknown>) => Promise<unknown>;
export default createModule;
