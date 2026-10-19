import { readFileSync } from 'node:fs';
import { defineConfig } from 'tsup';

const pkg = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf8'),
) as { version: string };

const shared = {
  define: {
    __JSONSQLITE_VERSION__: JSON.stringify(pkg.version),
  },
  sourcemap: true,
  splitting: false,
  target: 'node20' as const,
  outDir: 'dist',
};

export default defineConfig([
  {
    ...shared,
    entry: { index: 'src/index.ts' },
    format: ['esm', 'cjs'],
    dts: true,
    clean: true,
  },
  {
    ...shared,
    entry: { cli: 'src/cli.ts' },
    format: ['esm'],
    dts: false,
    clean: false,
    banner: { js: '#!/usr/bin/env node' },
  },
]);
