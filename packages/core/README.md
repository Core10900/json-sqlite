# @webofcat/jsonsqlite

JSON-native embedded database for Node.js.

**Version: 1.2.0** · Node.js ≥ 20 · Author: hanlin

## Install

```bash
npm install @webofcat/jsonsqlite
npm install -g @webofcat/jsonsqlite
jsonsqlite --version
```

## Library

```ts
import { create, open } from '@webofcat/jsonsqlite';

await create({ storagePath: './data' });
const db = await open({ storagePath: './data' });

await db.createTable('users', {
  fields: [{ name: 'name', type: 'string' }],
});
await db.run("INSERT INTO users (name) VALUES ('寒')");
const r = await db.run('SELECT * FROM users LIMIT 10');
await db.close();
```

## CLI

```bash
jsonsqlite tables --path ./data
jsonsqlite table create --path ./data
jsonsqlite table show users --path ./data --page 1 --size 20
jsonsqlite run "SELECT * FROM users WHERE name = '寒'" --path ./data
```

Alias: `jsql`

Full docs: https://github.com/Core10900/json-sqlite#readme

## License

MIT
