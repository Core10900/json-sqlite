import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { index: 'src/index.ts' },
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  splitting: false,
  clean: true,
  target: 'node20',
  outDir: 'dist',
  external: ['@webofcat/jsonsqlite'],
});
