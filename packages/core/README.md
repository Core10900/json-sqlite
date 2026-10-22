# @webofcat/jsonsqlite

JSON-native embedded database for Node.js.

**Version: 1.5.5** · Node.js ≥ 20 · Author: hanlin

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

## CLI (1.5.5 LTS surface)

```bash
jsonsqlite help
jsonsqlite insert users --data '{"name":"寒"}' -p ./data --json
jsonsqlite get users --id <id> -p ./data
jsonsqlite update users --id <id> --set age=30 -p ./data
jsonsqlite count users --where '{"age":{"$gt":18}}' -p ./data --json
jsonsqlite index create users age --type tree -p ./data
jsonsqlite stats -p ./data --json
jsonsqlite explain "SELECT * FROM users WHERE age > 18" -p ./data
jsonsqlite vacuum -y -p ./data
jsonsqlite doctor --deep -p ./data
jsonsqlite rekey --path ./data --out ./data-v2 --from-key OLD --to-key NEW
```

Global flags: `-p/--path`, `-y/--yes`, `--json`, `-q/--quiet`. Exit codes: `0/1/2/3` (lock → 3).

Alias: `jsql`

Full docs: https://github.com/Core10900/json-sqlite#readme

## License

MIT
