# @webofcat/jsonsqlite

JSON-native embedded database for Node.js.

**Version: 1.3.0** · Node.js ≥ 20 · Author: hanlin

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
const db = await open({
  storagePath: './data',
  syncMode: 'normal',
  schemaMode: 'off', // or 'warn' | 'strict'
});

await db.createTable('users', {
  fields: [{ name: 'name', type: 'string', required: true }],
});
await db.run("INSERT INTO users (name) VALUES ('寒')");
await db.close();
```

## CLI

```bash
jsonsqlite table create --name users --field name:string --path ./data
jsonsqlite table drop users --yes --path ./data
jsonsqlite run "SELECT * FROM users WHERE name IN ('寒')" --path ./data
```

Alias: `jsql`

Full docs: https://github.com/Core10900/json-sqlite#readme

## License

MIT
