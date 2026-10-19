import path from 'node:path';
import { open } from './engine/JSONSQLite.js';
import { create, getVersion, init } from './lifecycle.js';

async function main() {
  const argv = process.argv.slice(2);

  if (argv.length === 0 || argv[0] === 'help' || argv[0] === '--help' || argv[0] === '-h') {
    printHelp();
    return;
  }

  // Global flags that don't need a subcommand
  if (
    argv[0] === '--version' ||
    argv[0] === '-V' ||
    argv[0] === '-v' ||
    argv[0] === 'version'
  ) {
    console.log(getVersion());
    return;
  }

  const [cmd, ...rest] = argv;
  const positional = rest.find((a) => !a.startsWith('-'));
  const storagePath =
    process.env.JSONSQLITE_PATH ??
    flag(rest, '--path') ??
    positional ??
    './data';

  switch (cmd) {
    case 'create': {
      const force = rest.includes('--force');
      const result = await create({ storagePath, force });
      console.log(
        JSON.stringify(
          {
            ok: true,
            action: 'create',
            ...result,
          },
          null,
          2,
        ),
      );
      return;
    }
    case 'init': {
      const result = await init({ storagePath });
      console.log(
        JSON.stringify(
          {
            ok: true,
            action: 'init',
            ...result,
          },
          null,
          2,
        ),
      );
      return;
    }
    case 'doctor':
    case 'query':
    case 'backup':
    case 'collections':
      break;
    default:
      console.error(`Unknown command: ${cmd}`);
      printHelp();
      process.exitCode = 1;
      return;
  }

  const db = await open({ storagePath: resolveDbPath(cmd, rest, storagePath) });
  try {
    switch (cmd) {
      case 'doctor': {
        const h = await db.health();
        console.log(JSON.stringify(h, null, 2));
        process.exitCode = h.status === 'healthy' ? 0 : 1;
        break;
      }
      case 'query': {
        const jsonArg =
          rest.find((a) => a.trim().startsWith('{')) ?? '{}';
        const q = JSON.parse(jsonArg);
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
    }
  } finally {
    await db.close();
  }
}

/** For doctor/backup/collections, path comes from --path or env or ./data (not first positional as path when it's JSON). */
function resolveDbPath(cmd: string, rest: string[], fallback: string): string {
  const fromFlag = flag(rest, '--path');
  if (fromFlag) return fromFlag;
  if (process.env.JSONSQLITE_PATH) return process.env.JSONSQLITE_PATH;
  if (cmd === 'query') return './data';
  const positional = rest.find((a) => !a.startsWith('-'));
  if (positional && !positional.trim().startsWith('{')) {
    return path.resolve(positional);
  }
  return fallback === positional ? './data' : fallback;
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function printHelp() {
  console.log(`jsonsqlite — JSONSQLite CLI (v${getVersion()})

Usage:
  jsonsqlite --version | -V | version
  jsonsqlite create [path] [--force]
  jsonsqlite init [path]
  jsonsqlite doctor [--path ./data]
  jsonsqlite query '<json>' [--path ./data]
  jsonsqlite backup [--path ./data]
  jsonsqlite collections [--path ./data]
  jsonsqlite help

Examples:
  npm i -g @webofcat/jsonsqlite
  jsonsqlite --version
  jsonsqlite create ./my-db
  jsonsqlite init ./my-db
  jsonsqlite doctor --path ./my-db

Env:
  JSONSQLITE_PATH   default storage path

Alias:
  jsql   same as jsonsqlite
`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
