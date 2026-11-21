import { defineConfig } from 'vitest/config';
import preact from '@preact/preset-vite';

// base './' keeps every URL relative, so the same build runs at a domain root, under
// /<repo>/ on a Pages host, or under /pr-preview/pr-N/.
export default defineConfig({
  base: './',
  plugins: [preact()],
  build: { target: 'es2022', sourcemap: true },
  test: { include: ['src/**/*.test.ts'], environment: 'node' },
});
