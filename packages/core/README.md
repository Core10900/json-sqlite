# @webofcat/jsonsqlite

JSON-native embedded database for Node.js.

**Version: 2.2.0** · **LTS-2** · single writer · Node.js ≥ 20 · Author: hanlin  
**Production pin:** `npm install @webofcat/jsonsqlite@lts` (this line, until 2.3 exists `latest` is the same package)

LTS-2 is the default long-term pin for a new single-process embed: recoverable backups, and an isolation level that means what it says. It is not a cluster release. Multi-writer, replication, column store, and Raft are not in this line.

**LTS-1 (1.6.x)** stays on security and correctness patches in parallel: at least 12 months from this release, or 6 months after LTS-3 (2.5) ships, whichever the release notes keep. Pin `1.6` by version if you are staying there. The dist-tag `lts` moves to 2.2 with this release; it no longer selects 1.6.

## Authority docs

- Library API: [API.md](https://github.com/Core10900/json-sqlite/blob/main/API.md) (1.6 base, supplements through the 2.2 freeze)
- CLI: [CLI-API.md](https://github.com/Core10900/json-sqlite/blob/main/CLI-API.md) (frozen for 2.2.x)
- Migration: [1.6 / 1.8 → 2.2](https://github.com/Core10900/json-sqlite/blob/main/devDocs/releases/v2.2.0/迁移指南.md)

## Install

```bash
npm install @webofcat/jsonsqlite
npm install -g @webofcat/jsonsqlite
jsonsqlite --version
```

Until 2.3 is published, `npm install @webofcat/jsonsqlite` and `@latest` both install 2.2.0. After 2.3, `@latest` may move to that non-LTS line. `@lts` stays on 2.2.x. New features go to 2.3+, not to `2.2.x` patches.

## What `getCompatibilityInfo()` tells you

```ts
import { getCompatibilityInfo } from '@webofcat/jsonsqlite';

const info = getCompatibilityInfo();
// {
//   version: '2.2.0',   // package version; patches stay 2.2.x
//   formatVersion: 2,   // on-disk format; a 2.2.x patch does not bump this
//   lts: true,          // this binary is a long-term line
//   ltsLine: '2.2',     // which line; do not parse `version` for this
//   writers: 'single',  // a second process on the same directory fails
//   cliSurface: '2.2.0',// CLI names frozen at this surface
//   features: [/* shipped capabilities; no cluster or replica */]
// }
```

| Field | How to use it |
|-------|----------------|
| `lts` | `true` only on a long-term line. 2.0 and 2.1 were `false`. |
| `ltsLine` | `'2.2'` is LTS-2. A later line will change this string; `lts` alone will not tell them apart. |
| `writers` | `'single'`. This build has no multi-writer switch. |
| `formatVersion` | `2`. A 1.x directory cannot be `open`ed; migrate it (below). |
| `cliSurface` | `'2.2.0'`. A 2.2.x patch does not add subcommands. |

## Library

```ts
import {
  create,
  open,
  getCompatibilityInfo,
  rekeyDatabase,
} from '@webofcat/jsonsqlite';

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

`open` / `create` options and defaults are the keys in [`config.example.json`](./config.example.json). Defaults are unchanged from 2.1: `walMode: true`, `defaultIsolation: 'READ_COMMITTED'`, `queryTimeout: 30000`, `cacheSize: 1000`, `syncMode: 'normal'`, `schemaMode: 'off'`, `lazyCollections: true`, `pageSize: 32`, `maxResidentDocs: 256`, `backupIntervalMs: 0`. `tiering` stays `false`; the 1.8 cold-file layout is experimental and is not a 2.2 format promise.

### One writer

A second `open` of the same directory fails. The error code is `LOCK_FAILED` (CLI exit code `3`).

```ts
const db = await open({ storagePath: './data' });
await open({ storagePath: './data' }); // JSONSQLiteError, code LOCK_FAILED
await db.close();
```

### Isolation

Default `READ_COMMITTED` reads the latest commit. There is no snapshot until you ask for one.

```ts
await db.insert('items', { _id: 'a', n: 1 });
const latest = await db.query({ collection: 'items' });
// latest includes every committed row, including rows committed after this process started
```

`REPEATABLE_READ` is a snapshot taken at `beginTransaction`. A later commit is visible to a normal query and invisible to the snapshot.

```ts
await db.insert('items', { _id: 'a', n: 1 });
const snap = await db.beginTransaction('REPEATABLE_READ');
const write = await db.beginTransaction('READ_COMMITTED');
await db.insert('items', { _id: 'b', n: 2 });
await db.commitTransaction(write);

const frozen = await db.query({ collection: 'items' }, { txId: snap });
// frozen is only row a

const live = await db.query({ collection: 'items' });
// live is row a and row b

await db.commitTransaction(snap);
```

`SERIALIZABLE` and `READ_UNCOMMITTED` are rejected. As `defaultIsolation` the error is `INVALID_CONFIG`. On `beginTransaction` the error is `ISOLATION_UNSUPPORTED`. They are not downgraded to read committed.

## CLI

Global flags are unchanged from 2.1: `-p` / `--path`, `-y` / `--yes`, `--json`, `-q` / `--quiet`, `-h` / `--help`.  
Exit codes are unchanged: `0` ok, `1` usage or business error, `2` system/IO, `3` lock failed.  
Alias: `jsql`.

Stable subcommand names are not renamed. A `2.2.x` patch does not add subcommands.

```bash
jsonsqlite help
jsonsqlite version --json
jsonsqlite compat --json
jsonsqlite config validate --file ./node_modules/@webofcat/jsonsqlite/config.example.json
jsonsqlite insert users --data '{"name":"寒"}' -p ./data --json
jsonsqlite doctor --deep -p ./data
```

`version --json` and `compat` print `getCompatibilityInfo()`, including `lts: true` and `ltsLine: "2.2"`.

`config validate --file` reads that JSON file and checks it against the frozen keys. It does not open a database. Exit `0` means the file matches [`config.example.json`](./config.example.json). The example contains only fields this release implements. It does not contain design-doc §9 cluster or L3 fields (`cluster`, `replica`, `raft`, `l3`, `redis`, nested `cache.l3`, `writers`, and the rest of that list).

An unknown key, or one of those dangerous keys, exits `1` with code `INVALID_CONFIG`. The message names the key and says it is not applied. Example: a file with `"cluster": true` is rejected; the process does not start a cluster and does not ignore the key.

```bash
jsonsqlite config validate --file ./bad.json --json
# { "ok": false, "code": "INVALID_CONFIG", "message": "Rejected dangerous config key(s) \"cluster\": ..." }
```

The frozen cache field is `cacheSize`. A `cache` object is rejected because that shape is the unimplemented Redis L3 block, not the L1 size.

## Patches on 2.2.x

A `2.2.x` release only ships security and correctness fixes.

- It does not add commands.
- It does not change defaults.
- It does not bump `formatVersion`. If a security fix must change the disk format, that patch will include a migration and this README will gain a section for it. There is no such migration in 2.2.0.
- New behavior ships in 2.3 or later.

## Migrate from 1.6 or 1.8

1.6 and 1.8 are both `formatVersion` 1. 2.2 will not `open` them (`MIGRATION_REQUIRED`). The writer mode stays single. Full steps and the cold-file warning are in the [migration guide](https://github.com/Core10900/json-sqlite/blob/main/devDocs/releases/v2.2.0/迁移指南.md). Short path:

1. Stop the process that holds the directory. Copy it aside: `cp -R ./data ./data-1x-backup`.
2. If this database was written by 1.8 with `tiering: true`, fold `cold.jsonl` back before you change versions. On the 1.8 binary, `open({ storagePath, tiering: false })` and `close()`. `migrate` reads `data.jsonl` and the committed WAL only. It does not read `cold.jsonl`.
3. Install 2.2.0. Do not `open` the old directory.
4. Move to a new directory. Plaintext:

   ```bash
   jsonsqlite migrate --from ./data --to ./data-v2 --yes
   ```

   Encrypted source (wrong key does not leave a target directory):

   ```bash
   jsonsqlite migrate --from ./data --to ./data-v2 --yes --from-key "$JSONSQLITE_KEY"
   ```

5. Open `./data-v2`. The sample document `{ "_id": "u1", "name": "寒" }` is still that row. `formatVersion` is 2. Default isolation is `READ_COMMITTED`. A second process still gets `LOCK_FAILED`.
6. Changing the encryption key is a separate step, not part of migrate:

   ```bash
   jsonsqlite rekey --out ./data-v3 --to-key NEW --from-key OLD -p ./data-v2
   ```

CLI names from 1.6 are still the same names (`insert`, `update`, `delete`, `doctor`, …). Commands added after 1.6 and frozen here: `compat`, `admin serve`, `advise`, `aggregate`, `watch`, `index rebuild`, `vacuum --compress`, `migrate`, `backup --type full|incremental|differential`, `backup prune`, `tune`, `audit list`, `config validate`. There is no `plugin`, `replica`, or `cluster` command.

## Who should pin 2.2

Pin 2.2 if you embed one process, accept a single writer, and want backups that fail closed when a checksum or WAL record is bad. Stay on 1.6 if you cannot take the format 2 migration yet; that line still receives security and correctness patches through the window above.

Do not pin 2.2 as a finished distributed database. Multi-writer, replication, column store, and cluster are later lines.

## License

MIT
