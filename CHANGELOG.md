# Changelog

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
