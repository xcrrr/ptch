import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { main: 'src/main.ts' },
  format: ['esm'],
  platform: 'node',
  target: 'node20',
  outDir: 'dist',
  clean: true,
  splitting: false,
  sourcemap: true,
  // Internal workspace packages are bundled; third-party packages stay external dependencies.
  noExternal: [/^@patch\//],
  external: ['react-devtools-core'],
  banner: { js: '#!/usr/bin/env node' },
  esbuildOptions(options) {
    options.jsx = 'automatic';
  },
});
