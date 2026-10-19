# @jsonsqlite/core

JSON-native embedded database for Node.js — install into your backend, open a local data directory, query documents with indexes, WAL, backup, and ops APIs.

**Version: 1.0.0** · Requires **Node.js ≥ 20**

## Install

```bash
npm install @jsonsqlite/core
# or: pnpm add @jsonsqlite/core
```

## Quick start

```ts
import { open } from '@jsonsqlite/core';

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

## Highlights

| Area | API |
|------|-----|
| CRUD | `insert` / `update` / `delete` / `upsert` / `findById` / `query` |
| Indexes | `createIndex(collection, field, 'object'\|'tree'\|'inverted')` |
| Aggregate | `aggregate(collection, pipeline)` |
| JSONPath | `jsonPath(collection, '$.field')` |
| Tx | `beginTransaction` / `commitTransaction` / `rollbackTransaction` |
| Backup | `backupFull` / `backupIncremental` / `restoreBackup` |
| Time travel | `queryAtTime` / `diffBetweenTimes` / `rollbackToTime` |
| Ops | `health` / `getMetrics` / `advise` / `analyzeQuality` |
| HTTP Admin | `startServer({ host, port, adminToken })` |
| Stream | `subscribe(handler)` |
| CLI | `jsql doctor \| query \| backup \| collections` |

## Limits (v1)

- **Single writer** per `storagePath` (file lock)
- Embedded library — not a shared multi-instance network DB
- Always `await db.close()` on shutdown
- Nested transactions are not supported

## License

MIT
