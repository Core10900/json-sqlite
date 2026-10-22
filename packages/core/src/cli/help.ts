import { getVersion } from '../lifecycle.js';

export function helpRoot(): string {
  return `jsonsqlite — JSONSQLite CLI (v${getVersion()})

Usage:
  jsonsqlite [--version|-V] | help | <command> [options]

Global flags (anywhere):
  -p, --path <dir>   storage path (default: ./data or $JSONSQLITE_PATH)
  -y, --yes          skip confirmations
  --json             machine-readable JSON output
  -q, --quiet        suppress human chatter
  -h, --help         show help for this level

Commands:
  create / init              create or initialize a database directory
  tables / collections       list tables
  table <sub>                table DDL / show / export / import
  insert / update / delete   row mutations
  get / count                row read helpers
  run / sql                  SQL execute / interactive REPL
  query                      JSON query
  index list|create|drop     index management
  stats                      database / table statistics
  explain                    query advice / plan hints
  backup / vacuum / rekey    ops
  doctor [--deep]            health / consistency
  version                    print version

Exit codes: 0 ok · 1 usage/business · 2 system/IO · 3 lock failed

Try: jsonsqlite <command> --help
Env: JSONSQLITE_PATH, JSONSQLITE_KEY, NO_COLOR
Alias: jsql
`;
}

export function helpTable(): string {
  return `jsonsqlite table — table management

Subcommands:
  table list | tables
  table create [--name t] [--field name:type]...   # or interactive (TTY)
  table drop <name> [--yes]
  table alter <name>                              # interactive (TTY)
  table show <name> [--page N] [--size N] [-i] [--json]
  table describe <name>
  table export <name> --file out.jsonl
  table import <name> --file in.jsonl [--mode append|replace]

Global: -p/--path -y/--yes --json -q/--quiet -h/--help
`;
}

export function helpTableCreate(): string {
  return `jsonsqlite table create

Interactive (TTY):
  jsonsqlite table create -p ./data

Non-interactive:
  jsonsqlite table create --name users --field name:string --field age:number -p ./data --json

Field types: string|number|boolean|json|any
`;
}

export function helpInsert(): string {
  return `jsonsqlite insert <table> --data '{...}' | --field k=v... | --file file.jsonl
`;
}

export function helpUpdate(): string {
  return `jsonsqlite update <table> --set k=v... (--id <id> | --where '<json-filter>') [--yes]
Without --id/--where, --yes is required (updates all matching / all rows).
`;
}

export function helpDelete(): string {
  return `jsonsqlite delete <table> (--id <id> | --where '<json-filter>') [--yes]
`;
}

export function helpIndex(): string {
  return `jsonsqlite index list
jsonsqlite index create <table> <field> [--type object|tree|inverted]
jsonsqlite index drop <table> <field>
`;
}

export function helpSql(): string {
  return `jsonsqlite sql   # TTY REPL only
Meta: .tables  .schema [table]  .quit
Non-TTY: use jsonsqlite run "<sql>"
`;
}

export function helpFor(path: string[]): string | null {
  const key = path.join(' ');
  switch (key) {
    case '':
    case 'help':
      return helpRoot();
    case 'table':
      return helpTable();
    case 'table create':
      return helpTableCreate();
    case 'insert':
      return helpInsert();
    case 'update':
      return helpUpdate();
    case 'delete':
      return helpDelete();
    case 'index':
      return helpIndex();
    case 'sql':
      return helpSql();
    default:
      return null;
  }
}

/** Stable snapshot text for tests (root help without version line volatility handled in test). */
export function helpRootCommandsBlock(): string {
  return helpRoot()
    .split('\n')
    .filter((l) => !l.startsWith('jsonsqlite —'))
    .join('\n');
}
