# Changelog

## 1.6.0 — 2026-10-23 · **LTS**

### Added
- Root authority docs: [`API.md`](./API.md), [`CLI-API.md`](./CLI-API.md) (CLI surface frozen from **1.5.5**)
- `getCompatibilityInfo()` → `{ version, formatVersion, lts: true, cliSurface: '1.5.5', features }`
- FT-V16 LTS contract tests (exports ⊆ API.md, help ⊆ CLI-API.md, inventory alignment)
- Verified on Node 20 + 22 (macOS); Ubuntu CI workflow deferred (token lacks `workflow` scope)

### Changed
- Package version / docs mark **1.6 LTS**; support policy: patches only on 1.6.x; no CLI feature expansion
- README / package README link to root `API.md` + `CLI-API.md`

### Notes
- No new CLI subcommands vs 1.5.5 — this release freezes and documents the contract

## 1.5.5 — 2026-10-22

### Added
- CLI LTS surface: unified `-p/--path`, `-y/--yes`, `--json`, `-q/--quiet`, hierarchical `--help`
- Exit codes: `0/1/2/3` (lock → 3); JSON errors `{ ok:false, code, message }`
- New commands: `insert`, `update`, `delete`, `get`, `count`, `index`, `stats`, `explain`, `sql` (TTY REPL)
- Command inventory: `devDocs/releases/v1.5.5/cli-command-inventory.md` (1.6 CLI-API draft)

### Changed
- CLI modularized under `src/cli/` (`args`, `output`, `exit`, `help`, `commands`)
- Non-TTY guards for interactive `table create/alter`, `drop` without `--yes`, `sql` REPL

## 1.5.0 — 2026-10-21

### Added
- **Offline rekey**: `rekeyDatabase` / `db.rekey` + CLI `jsonsqlite rekey` (`--out` default; `--in-place --yes` with journal recovery)
- **`lazyCollections`** (default `true`) + `prefetchCollections`; metrics `collectionsLoaded` / `loadMs` / `openLoadMs`
- **`vacuum`** API + CLI — rewrite JSONL, truncate WAL (deltas kept for time-travel)
- **`doctor({ deep })`** + CLI `doctor --deep` — catalog/dir/WAL/index sampling; exit ≠ 0 when unhealthy
- SQL: **`NOT LIKE`**, **`SELECT COUNT(*)`** (single-table; rows `[{ count }]`)
- Bench: JOIN smoke + optional `BENCH_WRITE_BASELINE=1` → `apps/bench/baseline.json`
- `devDocs/releases/v1.6.0/LTS准入检查表.md` draft

### Changed
- Default open no longer preloads all collections (set `lazyCollections: false` for 1.4-style eager load)

### Deprecated
- `dropCollection` — prefer `dropTable` (still aliased)

### Docs
- README: 1.4→1.5 migration, rekey handbook, performance notes

## 1.4.0 — 2026-10-20

### Added
- Optional **main-store AES-256-GCM encryption** (`encryptionKey` / `JSONSQLITE_KEY`) for collection JSONL + WAL; catalog marks `encryption: true`
- SQL **`LIKE`** with `%` / `_` wildcards (`\` escape); filter op `$like`
- SQL **two-table `INNER` / `LEFT JOIN`** (equi-join `ON` only); result columns use `alias.field` prefixes
- API: `exportCollection`, `importCollection({ mode: 'append'|'replace' })`, `queryCursor`
- CLI: `table export|import <name> --file … [--mode …]`
- Admin: non-loopback bind requires `adminToken`; loopback without token warns on stderr
- Error code `ENCRYPTION`

### Docs
- README: encryption, LIKE/JOIN bounds, import/export/cursor
- `devDocs/releases/v1.4.0/` plans

## 1.3.0 — 2026-10-19

### Added
- `syncMode`: `none` | `normal` | `full` — durable writes (fsync) for catalog / WAL / JSONL
- `schemaMode`: `off` | `warn` | `strict` — optional soft-schema enforcement on write
- DDL journal + recovery for `dropTable` / `renameTable` crash windows
- Catalog `formatVersion` migration framework (`FORMAT_VERSION`, migrators map)
- SQL: `IN (...)`, `BETWEEN … AND …`, `IS [NOT] NULL`
- CLI: `table create --name … --field …`; `table drop --yes`; TTY guard for interactive flows
- `queryTimeout` now enforced (0 disables)

### Changed
- Unsupported isolation levels coerce to `READ_COMMITTED` (with warn)
- Atomic catalog / indexes writes via tmp + rename
- `count()` no longer goes through full query cache path; SELECT `total` only when paginated

### Docs
- `devDocs/releases/v1.3.0/` harden plan & tests

## 1.2.0 — 2026-10-19

### Added
- Table APIs: `listTables`, `createTable`, `dropTable`, `alterTable`, `describeTable`, `count`
- Soft schema `fields` on collections (catalog metadata)
- SQL subset via **`db.run(sql)`** and **`parseSql`**: SELECT / INSERT / UPDATE / DELETE / CREATE|DROP|ALTER TABLE / SHOW TABLES / DESCRIBE
- CLI table management:
  - `tables` / `table create` (interactive dialogue)
  - `table drop` (double confirmation)
  - `table alter` (dialogue + double confirmation)
  - `table show` (friendly paginated table; `-i` interactive)
  - `table describe`
- CLI **`jsonsqlite run "<sql>"`**
- Error codes `SQL_PARSE`, `SQL_UNSUPPORTED`

### Docs
- `devDocs/releases/v1.2.0/` 开发计划与功能测试计划
- Root README: table CLI + SQL section

## 1.1.0 — 2026-10-19

### Added
- Global CLI command **`jsonsqlite`** (`npm i -g @webofcat/jsonsqlite`)
- `jsonsqlite --version` / `-V` / `version`
- Library APIs: **`create()`**, **`init()`**, **`getVersion()`**
- CLI: `jsonsqlite create [path] [--force]`, `jsonsqlite init [path]`
- Error code `DB_EXISTS` when creating over an existing database without `force`
- Keep alias `jsql`

### Docs
- Root README: global install, create/init API & CLI
- `devDocs/releases/v1.1.0/` 开发计划与功能测试计划

## 1.0.0 — 2026-10-19

### Added
- **P0/P1**: Embedded library `@webofcat/jsonsqlite` with open/close, JSONL storage, WAL recovery, file lock, CRUD, JSON Query, transactions
- **P2**: Object / Tree / Inverted indexes, query planner, L1 LRU cache, aggregation pipeline, JSONPath subset, `apps/bench`
- **P3**: Full/incremental backup (+ optional AES-GCM), health/metrics, ChangeLog, CLI `jsql`, HTTP Admin API (`startServer`)
- **P4**: Time travel (`queryAtTime` / `diffBetweenTimes` / `rollbackToTime`), QueryAdvisor, DataQuality, Admin dashboard HTML, `subscribe` stream hooks

### Notes
- Single-writer per `storagePath` (v1)
- Disk `formatVersion` = 1
- Node.js ≥ 20; ESM + CJS + TypeScript types
