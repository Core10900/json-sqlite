import { getVersion } from '../lifecycle.js';

export function helpRoot(): string {
  return `jsonsqlite — JSONSQLite CLI (v${getVersion()})

Usage:
  jsonsqlite [--version|-V] | help | <command> [options]

Global flags (anywhere):
  -p, --path <dir>   storage path (default: ./data or $JSONSQLITE_PATH)
  --writers single|multi
                     default single (second process gets LOCK_FAILED).
                     multi is opt-in (LTS-3). Omitting it stays single.
                     The lts tag stays on 2.2; install this line with lts-3
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
  query [--timeout ms]       JSON query. --timeout overrides queryTimeout (exit 1 on QUERY_TIMEOUT)
  index list|create|drop|rebuild|compact   index management
  storage advise <table>     print a storage suggestion; does not change the table
  plugin list|info           built-in plugin catalog (no remote install)
  stats                      database / table statistics
  explain                    index, selectivity, chunked, earlyStop, profile stages
  advise                     Advisor (aligns with explain fields)
  aggregate                  aggregation pipeline (unwind/lookup)
  admin serve                start Admin HTTP + SSE
  watch                      subscribe to dataChanged
  compat / version [--json]  compatibility / version (3.1.0, lts: false, ltsLine 2.5)
  config validate --file <f> check a file against the frozen 2.2 config keys
  backup / vacuum [--compress] / rekey    ops
  backup --type full|incremental|differential
  backup prune --keep-days <n> [--max-count <n>]
  backup restore --type full|incremental|differential [--collection name]
  tune [--dry-run] [json-query]          AutoTune / Advisor (default dry-run)
  audit list [--action name]             read-only audit log
  migrate --from <db> --to <new> --yes   1.x → 2.x
  doctor [--deep]            health / consistency; JSON includes writers and lockHolder
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
jsonsqlite index create <table> <field> [--type object|tree|inverted|geo]
jsonsqlite index create <table> --type composite --fields a,b
jsonsqlite index drop <table> <field>
jsonsqlite index rebuild [table]
jsonsqlite index compact [table]
--type tree builds a B+Tree (order from bTreeOrder, default 128).
--type geo builds a grid index. explain shows structure btree or grid.
`;
}

export function helpStorage(): string {
  return `jsonsqlite storage advise <table>

Print a storage suggestion for one table. Requires the process to opt in;
this command opens with storageAdvise enabled for the suggestion only.
It does not change currentMode. Suggestions are document, columnar, hybrid,
or compressed. compressed means a large document would use a compressed block
and still read like document mode.
The inputs are field cardinality, nesting depth, and the in-process filter
field histogram (field names and counts, not document text).
`;
}

export function helpPlugin(): string {
  return `jsonsqlite plugin list
jsonsqlite plugin info <name>

Lists the built-in catalog. vector and s3 are callable stubs.
A usable vector index is planned for 3.3. A usable S3 upload is planned for 3.4.
This command does not install plugins from a registry.
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
  return `jsonsqlite backup [--type full|incremental|differential]
jsonsqlite backup prune --keep-days <n> [--max-count <n>]
jsonsqlite backup restore --type full|incremental|differential [--collection <name>] [--file <path>]

backup                  default --type full
  --type incremental    changes since last backup
  --type differential   changes since last full backup
backup prune            retention: delete expired / excess backups
backup restore          apply a full backup, or full + incremental/differential chain
  --collection <name>   restore one collection; other collections stay unchanged
Checksum mismatch refuses the restore and does not modify the target.
`;
}

export function helpTune(): string {
  return `jsonsqlite tune [--dry-run] [--apply] ['{"collection":"users","filter":{...}}']

Default is --dry-run: Advisor / AutoTune recommendations only; indexes are not changed.
Pass --apply to create recommended indexes (still subject to AutoTune rollback on validation failure).
`;
}

export function helpAudit(): string {
  return `jsonsqlite audit list [--action rekey|rollbackToTime|drop|migrate|repair] [--limit N]

Read-only audit log (meta/audit.jsonl). Covers rekey, rollbackToTime, drop, migrate, repair.
`;
}

export function helpCompat(): string {
  return `jsonsqlite compat [--json]
jsonsqlite version [--json]
Print getCompatibilityInfo() / version.
On 3.1.0: lts is false. ltsLine stays "2.5" (latest LTS line, LTS-3), not this package version.
writers is "single". Default open stays single-writer. Pin 2.2 unless you need multi-writer (lts-3 / 2.5).
This release is not LTS. The lts tag stays on 2.2. PATCH on 3.0.x adds no subcommands.
`;
}

export function helpConfig(): string {
  return `jsonsqlite config validate --file <path>

Check a JSON file against the 2.2 keys plus the 2.3 and 2.4 opt-in keys.
Does not open a database.
Unknown keys are refused (exit 1, code INVALID_CONFIG) and are not applied.
Dangerous keys (cluster, replica, replication, raft, quorum, shard,
graphql, wasm, l3, redis, cache) are named in the error.
2.4 opt-in key writers is single or multi (default single). Omitting it stays single.
2.3 opt-in keys (columnStore, storageTiers, smartCompression, and the rest
listed in config validation) are accepted and default off.
3.1 opt-in keys (bTreeOrder, storageAdvise, hybridCollections, hybridFields,
coldExternalDir, compressionSampleWindow, stopWords) are accepted.
Omitting them keeps the 3.0 read path. storage advise does not switch modes.
The frozen cache field is cacheSize, not cache / cache.l3.
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
    case 'storage':
    case 'storage advise':
      return helpStorage();
    case 'plugin':
    case 'plugin list':
    case 'plugin info':
      return helpPlugin();
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
    case 'config':
    case 'config validate':
      return helpConfig();
    case 'migrate':
      return helpMigrate();
    case 'backup':
    case 'backup restore':
    case 'backup prune':
      return helpBackup();
    case 'tune':
      return helpTune();
    case 'audit':
    case 'audit list':
      return helpAudit();
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
