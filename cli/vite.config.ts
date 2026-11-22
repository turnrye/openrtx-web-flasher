// SPDX-License-Identifier: GPL-3.0-or-later
import { defineConfig } from 'vite';
import site from '../vite.config.ts';

// Bundles the command line into one file for Node, cli/dist/openrtx-flasher.mjs. npm runs
// this (`prepare`) when the package is installed, also from a git address, which is how
// `npx github:<owner>/<repo>` gets a program to run without anything being published.
// The three packages that reach real devices are loaded by name at run time and stay out.
export default defineConfig({
  root: import.meta.dirname,
  // The same build ID and report address as the page.
  define: site.define,
  logLevel: 'warn',
  ssr: { noExternal: true },
  build: {
    ssr: 'bin.ts',
    outDir: 'dist',
    emptyOutDir: true,
    target: 'node22',
    minify: false,
    rollupOptions: { output: { entryFileNames: 'openrtx-flasher.mjs' } },
  },
});
