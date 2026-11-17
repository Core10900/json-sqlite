import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { index: 'src/index.ts' },
  format: ['esm', 'cjs'],
  dts: true,
  minify: true,
  sourcemap: true,
  splitting: false,
  treeshake: true,
  clean: true,
  target: 'node20',
  outDir: 'dist',
  external: ['@webofcat/jsonsqlite'],
});
