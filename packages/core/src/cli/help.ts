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
  index list|create|drop|rebuild   index management
  stats                      database / table statistics
  explain                    query advice / plan hints
  advise                     Advisor (aligns with explain fields)
  aggregate                  aggregation pipeline (unwind/lookup)
  admin serve                start Admin HTTP + SSE
  watch                      subscribe to dataChanged
  compat / version [--json]  compatibility / version
  backup / vacuum [--compress] / rekey    ops
  backup restore --type full|incremental [--collection name]
  migrate --from <db> --to <new> --yes   1.x → 2.0
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
jsonsqlite index create <table> --type composite --fields a,b
jsonsqlite index drop <table> <field>
jsonsqlite index rebuild [table]
`;
}

export function helpSql(): string {
  return `jsonsqlite sql   # TTY REPL only
Meta: .tables  .schema [table]  .quit
Non-TTY: use jsonsqlite run "<sql>"
`;
}

export function helpAdmin(): string {
  return `jsonsqlite admin serve [--host 127.0.0.1] [--port 3000] [--token SECRET] [--once]

Start Admin HTTP (dashboard + REST + SSE).
Loopback may omit --token (a warning is printed).
Non-loopback requires both --token and --cert/--key (TLS). Missing either refuses to listen.
--once starts then exits (smoke / tests).
`;
}

export function helpAdvise(): string {
  return `jsonsqlite advise '<sql|json-query>' [--json]
Advisor suggestions (same fields as explain).
`;
}

export function helpAggregate(): string {
  return `jsonsqlite aggregate <table> '<pipeline-json>' [--json]
Pipeline stages: match, group, sort, limit, project, unwind, lookup
`;
}

export function helpWatch(): string {
  return `jsonsqlite watch [--once] [--timeout ms] [--json]
Subscribe to dataChanged. Non-TTY requires --once or --timeout.
`;
}

export function helpMigrate(): string {
  return `jsonsqlite migrate --from <db> --to <new> --yes [--from-key KEY]

Copy a 1.x database into a 2.0 (formatVersion 2) directory.
Non-TTY and scripts must pass --yes. Exit 0 on success, 1 if --yes is missing or the source is rejected.
A failed migrate does not leave a partial target directory.
Re-running without --yes refuses when --to already exists; --yes replaces it.
Does not add plugin, replica, or cluster commands.
`;
}

export function helpBackup(): string {
  return `jsonsqlite backup
jsonsqlite backup restore --type full|incremental [--collection <name>] [--file <path>]

backup                  full backup
backup restore          apply a full backup, or a full backup plus incrementals in order
  --type full           default; does not apply incrementals
  --type incremental    requires a full baseline; fails without writing if the baseline is missing
  --collection <name>   restore one collection from the full backup; other collections stay unchanged
Checksum mismatch refuses the restore and does not modify the target.
`;
}

export function helpCompat(): string {
  return `jsonsqlite compat [--json]
jsonsqlite version [--json]
Print getCompatibilityInfo() / version.
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
    case 'admin':
    case 'admin serve':
      return helpAdmin();
    case 'advise':
      return helpAdvise();
    case 'aggregate':
      return helpAggregate();
    case 'watch':
      return helpWatch();
    case 'compat':
    case 'version':
      return helpCompat();
    case 'migrate':
      return helpMigrate();
    case 'backup':
    case 'backup restore':
      return helpBackup();
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
