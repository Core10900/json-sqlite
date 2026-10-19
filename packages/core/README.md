# @webofcat/jsonsqlite

JSON-native embedded database for Node.js — install into your backend, open a local data directory, query documents with indexes, WAL, backup, and ops APIs.

**Version: 1.0.0** · Requires **Node.js ≥ 20** · Author: **hanlin**

## Install

```bash
npm install @webofcat/jsonsqlite
# or: pnpm add @webofcat/jsonsqlite
```

## Quick start

```ts
import { open } from '@webofcat/jsonsqlite';

const db = await open({ storagePath: './data' });

await db.insert('users', { name: '寒', age: 30 });
await db.createIndex('users', 'age', 'tree');

const rows = await db.query({
  collection: 'users',
  filter: { age: { $gte: 18 } },
  orderBy: { age: 'desc' },
  limit: 10,
});

await db.aggregate('users', [
  { type: 'group', by: 'age', fields: { n: { op: 'count' } } },
]);

await db.backupFull();
console.log(await db.health());

await db.close();
```

## Docs

See the repository root [README.md](https://github.com/Core10900/json-sqlite#readme) for the full Chinese guide.

## License

MIT
