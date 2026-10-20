# Changelog

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
