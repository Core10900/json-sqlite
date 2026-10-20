# @webofcat/jsonsqlite

JSON-native embedded database for Node.js.

**Version: 1.4.0** · Node.js ≥ 20 · Author: hanlin

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
  encryptionKey: process.env.JSONSQLITE_KEY, // optional main-store AES
  syncMode: 'normal',
  schemaMode: 'off', // or 'warn' | 'strict'
});

await db.createTable('users', {
  fields: [{ name: 'name', type: 'string', required: true }],
});
await db.run("INSERT INTO users (name) VALUES ('寒')");
await db.run("SELECT * FROM users WHERE name LIKE '寒%'");
await db.exportCollection('users');
await db.close();
```

## CLI

```bash
jsonsqlite table create --name users --field name:string --path ./data
jsonsqlite table export users --file users.jsonl --path ./data
jsonsqlite table import users --file users.jsonl --mode replace --path ./data
jsonsqlite run "SELECT u.name, o.total FROM users u INNER JOIN orders o ON u._id = o.userId" --path ./data
```

Alias: `jsql`

Full docs: https://github.com/Core10900/json-sqlite#readme

## License

MIT
