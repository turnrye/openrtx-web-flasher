// SPDX-License-Identifier: GPL-3.0-or-later
/** The cskburn WebAssembly module that scripts/vendor.mjs builds into public/cskburn/. */
declare module '*/cskburn/cskburn.mjs' {
  /** Emscripten module factory. */
  const createModule: (options: Record<string, unknown>) => Promise<unknown>;
  export default createModule;
}
