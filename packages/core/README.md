# @webofcat/jsonsqlite

JSON-native embedded database for Node.js.

**Version: 1.5.0** · Node.js ≥ 20 · Author: hanlin

## Install

```bash
npm install @webofcat/jsonsqlite
npm install -g @webofcat/jsonsqlite
jsonsqlite --version
```

## Library

```ts
import { create, open, rekeyDatabase } from '@webofcat/jsonsqlite';

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
jsonsqlite vacuum --path ./data
jsonsqlite doctor --deep --path ./data
jsonsqlite rekey --path ./data --out ./data-v2 --from-key OLD --to-key NEW
```

Alias: `jsql`

Full docs: https://github.com/Core10900/json-sqlite#readme

## License

MIT
