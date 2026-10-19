# @webofcat/jsonsqlite

JSON-native embedded database for Node.js.

**Version: 1.1.0** · Node.js ≥ 20 · Author: hanlin

## Install

```bash
# project dependency
npm install @webofcat/jsonsqlite

# global CLI
npm install -g @webofcat/jsonsqlite
jsonsqlite --version
```

## Library

```ts
import { create, init, open, getVersion } from '@webofcat/jsonsqlite';

await create({ storagePath: './data' }); // or init() for idempotent setup
const db = await open({ storagePath: './data' });
await db.insert('users', { name: '寒' });
await db.close();
```

## CLI

```bash
jsonsqlite --version
jsonsqlite create ./my-db
jsonsqlite init ./my-db
jsonsqlite doctor --path ./my-db
```

Alias: `jsql`

Full docs: https://github.com/Core10900/json-sqlite#readme

## License

MIT
