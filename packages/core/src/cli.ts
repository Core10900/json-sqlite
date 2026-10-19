#!/usr/bin/env node
import { open } from './engine/JSONSQLite.js';

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const storagePath =
    process.env.JSONSQLITE_PATH ??
    flag(rest, '--path') ??
    './data';

  if (!cmd || cmd === 'help' || cmd === '--help') {
    printHelp();
    return;
  }

  const db = await open({ storagePath });
  try {
    switch (cmd) {
      case 'doctor': {
        const h = await db.health();
        console.log(JSON.stringify(h, null, 2));
        process.exitCode = h.status === 'healthy' ? 0 : 1;
        break;
      }
      case 'query': {
        const raw = rest.find((a) => !a.startsWith('--')) ?? '{}';
        const q = JSON.parse(raw);
        console.log(JSON.stringify(await db.query(q), null, 2));
        break;
      }
      case 'backup': {
        const info = await db.backupFull();
        console.log(JSON.stringify(info, null, 2));
        break;
      }
      case 'collections': {
        console.log(JSON.stringify(await db.listCollections(), null, 2));
        break;
      }
      default:
        console.error(`Unknown command: ${cmd}`);
        printHelp();
        process.exitCode = 1;
    }
  } finally {
    await db.close();
  }
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function printHelp() {
  console.log(`jsql — JSONSQLite CLI

Usage:
  jsql doctor [--path ./data]
  jsql query '{"collection":"users","limit":10}' [--path ./data]
  jsql backup [--path ./data]
  jsql collections [--path ./data]

Env:
  JSONSQLITE_PATH   default storage path
`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
