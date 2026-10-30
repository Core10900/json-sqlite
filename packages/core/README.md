# @webofcat/jsonsqlite

JSON-native embedded database for Node.js.

**Version: 2.1.0**（非 LTS，单写者） · Node.js ≥ 20 · Author: hanlin  
**LTS pin:** production long-term → **1.6.x** ([ROADMAP](https://github.com/Core10900/json-sqlite/blob/main/devDocs/releases/ROADMAP.md))

## Authority docs

- Library API: [API.md](https://github.com/Core10900/json-sqlite/blob/main/API.md)（含 1.7 / 1.8 增补）
- CLI: [CLI-API.md](https://github.com/Core10900/json-sqlite/blob/main/CLI-API.md)（1.5.5 冻结面 + 1.7 / 1.8 增补）

## Install

```bash
npm install @webofcat/jsonsqlite
npm install -g @webofcat/jsonsqlite
jsonsqlite --version
```

## Library

```ts
import {
  create,
  open,
  getCompatibilityInfo,
  rekeyDatabase,
} from '@webofcat/jsonsqlite';

console.log(getCompatibilityInfo());
// 1.8: { version, formatVersion, lts: false, cliSurface: '1.8.0', features }

await create({ storagePath: './data' });
const db = await open({
  storagePath: './data',
  lazyCollections: true,
  encryptionKey: process.env.JSONSQLITE_KEY,
});

await db.run("SELECT COUNT(*) FROM users WHERE name NOT LIKE 'test%'");
await db.vacuum();
await db.doctor({ deep: true });
await db.close();

await rekeyDatabase({
  storagePath: './data',
  fromKey: 'old',
  toKey: 'new',
  targetPath: './data-v2',
});
```

## CLI

```bash
jsonsqlite help
jsonsqlite insert users --data '{"name":"寒"}' -p ./data --json
jsonsqlite doctor --deep -p ./data
```

Global flags: `-p/--path`, `-y/--yes`, `--json`, `-q/--quiet`. Exit codes: `0/1/2/3`.

Alias: `jsql`

## LTS

1.6.x receives security and correctness patches only. CLI command surface does not expand (frozen at 1.5.5). New features go to 1.7+ or 2.0.

## License

MIT
