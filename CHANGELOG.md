# Changelog

## 2.0.0 — 2026-10-28

**非 LTS。** 默认仍是单写者。本版不包含多写者、复制、列存、插件。

### Breaking
- `formatVersion` 升到 **2**（分页）。1.x 库必须 `migrate --from --to --yes`，`open` 对 format 1 抛 `MIGRATION_REQUIRED`
- `SERIALIZABLE` / `READ_UNCOMMITTED` 不再静默降级：`begin` 抛 `ISOLATION_UNSUPPORTED`，作为 `defaultIsolation` 抛 `INVALID_CONFIG`
- 文档正文在 `pages/pNNNNNN.jsonl`，不再把整表载入堆。`pageSize`（默认 32）与 `maxResidentDocs`（默认 256）
- 备份恢复校验 manifest checksum；不符抛 `BACKUP_CHECKSUM` 且不写目标。增量缺全量基线抛 `BACKUP_BASELINE`
- WAL 中间坏行抛 `WAL_CORRUPT` 并拒绝打开。只有缺少换行的尾部残行可以丢弃
- 非 loopback 的 Admin 必须同时有 token 和 TLS 材料

### Added
- `REPEATABLE_READ`：`begin` 建立快照，可与一个写事务并存。`query(q, { txId })` / `findById(col, id, { txId })` 不看见之后的提交
- `restoreChain({ type: 'full' | 'incremental', collection?, file? })`
- `migrateDatabase({ from, to, yes, encryptionKey })`
- CLI：`migrate --from --to --yes`；`backup restore --type full|incremental [--collection]`
- `pagingStats()`、`getCompatibilityInfo().writers === 'single'`
- §12.3 六场景写入 `apps/bench` 与 `devDocs/releases/v2.0/性能包络.md`

## 1.8.0 — 2026-10-27

### Added
- **索引落盘**：`meta/idx/*.seg.json`（format 1 + sha256）。reopen 在 WAL 为空且 docCount/revision 一致时直接装回 postings，跳过全量 rebuild；损坏段 `doctor` 报 `index-segments`，`rebuildIndexes()` / `index rebuild` 可重建
- **L2 缓存**（默认关）：`l2Cache` / `l2CacheSize`。写路径同时失效 L1；`getMetrics().l2` 含命中
- **压缩**（默认关）：`compression` + `compressionThreshold`，行前缀 `JSQC1:`，先压缩再加密；`vacuum({ compress: true })` / `vacuum --compress`
- **热冷分层**（实验，默认关）：`tiering` / `tierColdAfter`。`close()` 将低访问文档写入 `cold.jsonl`，按 id 读取时延迟加载；`getMetrics().tiers`
- **SQL**：`SELECT col, COUNT(*) … GROUP BY col`（无 JOIN）。`SQL_PARSE` / `SQL_UNSUPPORTED` 消息带 `[CODE]` 前缀
- **Bench**：点查 / 范围 / 批量写 / 并发读 / reopen，报告含 `threshold`（`apps/bench/thresholds.json`，`BENCH_SKIP_THRESHOLD=1` 可跳过）
- **CI**：`.github/workflows/ci.yml`，Ubuntu × Node 20 / 22（lint + build + test）
- CLI：`index rebuild [table]`；`doctor --json` 含 `indexSegments` / `compression` / `tiering` / `l2`；`stats --json` 含 `l2` / `tiers` / `compression`

### Changed
- 版本 **1.8.0**（非 LTS）；`getCompatibilityInfo().cliSurface === '1.8.0'`，`lts` 仍为 false
- `persistIndexes` 默认 **true**（缺段或校验失败时仍走 1.7 的 rebuild，查询结果不变）。可用 `persistIndexes: false` 关掉

### Notes
- 生产长期 pin 仍建议 **LTS-1 = 1.6.x**。热冷文件布局是实验旗标，不承诺冻结到 2.0
- 段格式带 `format: 1`，2.0 若改布局会另做迁移

## 1.7.0 — 2026-10-26

### Added
- **Admin**：仪表盘（指标 / 慢查询 / advise / 备份 / 时间点查询）+ REST 对齐 + **SSE**（`metrics` / `dataChanged`）
- **CompositeIndex** + `autoSelectIndexType`；Planner 等值前缀命中
- 聚合阶段 **`unwind` / `lookup`**（内存哈希）
- **StreamProcessor** 滑动窗口 API（进程内、可单测）
- **AutoTune**（默认关；`autoTuneDryRun` 默认 true；审计日志）
- CLI：`admin serve`、`advise`、`aggregate`、`compat` / `version --json`、`watch`、`index create --type composite --fields`
- 根文档 `API.md` / `CLI-API.md`「1.7 增补」；FT-V17 契约测试

### Changed
- 版本 **1.7.0**（非 LTS）；`getCompatibilityInfo().lts === false`，`cliSurface: '1.7.0'`
- 保留全部 1.6 稳定符号与 1.5.5 CLI 语义

### Notes
- 生产长期 pin 仍建议 **LTS-1 = 1.6.x**；1.7 为体验列车

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
