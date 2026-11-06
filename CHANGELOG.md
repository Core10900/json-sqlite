# Changelog

## 3.0.0 — 2026-11-06 · 非 LTS

**非 LTS。** 相对 2.5 为 MINOR。默认仍是单写者，文档页格式不变。不传新参数时，已有 JSON 过滤和 SQL 子集的结果保持不变。

`latest` 指向 3.0.0。`lts` / `lts-2` 仍是 2.2。`lts-3` 仍是 2.5。生产 pin 仍是 `lts`（2.2）。需要多写者用 `lts-3`。

### Added
- JSONPath 比较和存在过滤，安全表达式树，相同路径复用解释树。脚本和 `..` 抛 `JSONPATH_UNSUPPORTED`
- 扫描中的 `queryTimeout` 与 `AbortSignal`。超时 `QUERY_TIMEOUT`，取消 `QUERY_CANCELLED`，不返回部分结果
- 计划器：常量折叠、`?` 参数绑定、投影下推、LIMIT 早停、按选择率 × 索引权重选索引。没有统计时退回 2.5 规则
- 剖析：`parse`、`optimize`、`indexScan`、`dataLoad`、`execute` 与内存增量
- 分批执行的结果与关闭分批一致
- 单字段 `GROUP BY` 的 `COUNT` / `SUM` / `AVG` / `MIN` / `MAX`。不支持的语法用 `SQL_UNSUPPORTED` 点名构造
- `compileFilters` 默认关闭。只编译引擎白名单运算符
- Advisor 给出替代 `jsonPath` 和 `estimatedCost`
- CLI：`explain` 输出选择率、权重、是否分批、是否早停；`query --timeout`

### Not in this release
B+Tree、新的列存编码、复制、Redis、GraphQL、集群、完整 SQL 方言、`READ_UNCOMMITTED`。

## 2.5.0 — 2026-11-05 · LTS-3

**LTS-3。** 相对 2.4 为 MINOR，本版不增加功能。默认仍是单写者。需要多写者才升级；否则留在 LTS-2。

`writers: 'multi'`、`SERIALIZABLE`、死锁错误码、savepoint 的语义与 2.4 已冻结的锁协议相同，`2.5.x` PATCH 不缩小这些语义，也不加入复制或集群。

`lts` 继续指向 2.2。`lts-2` 指向 2.2。`lts-3` 指向 2.5。`latest` 指向 2.5。`npm install` 不带 tag 装到 2.5，默认仍是单写者。生产 pin 仍是 `lts`（2.2）。

### Changed
- `getCompatibilityInfo()`：`lts: true`，`ltsLine: '2.5'`，`cliSurface: '2.5.0'`，默认 `writers: 'single'`
- `version --json` 能区分 `ltsLine: "2.5"`。这是本包所属的线，不是包版本字符串，也不是单写者用户的主推荐 pin

### Not in this release
新存储格式、复制、GraphQL、选主。

## 2.4.0 — 2026-11-04 · 非 LTS

**非 LTS。** 相对 2.3 为 MINOR。默认仍是单写者。`writers: 'multi'` 必须显式打开，锁语义见 [RFC-锁协议.md](./devDocs/releases/v2.4.0/RFC-锁协议.md)。

生产仍应 pin **2.2**。需要多写者的生产 pin 是 **2.5**，不是本版。`lts` 继续指向 2.2。`latest` 指向 2.4.0。

### Added
- 同一台机器上的多进程写（opt-in）。冲突返回 `WRITE_CONFLICT`，可重试；成功的文档不丢
- multi 模式下的 `SERIALIZABLE`。single 模式仍拒绝。冲突返回 `SERIALIZABLE_CONFLICT`
- 等待图死锁检测。pid 较大的一方回滚，错误码 `DEADLOCK`
- savepoint：回滚内层不影响外层已暂存的修改。默认事务仍是一层
- CLI `--writers single|multi`。`doctor` 的 JSON 含 `writers` 与 `lockHolder`
- `getCompatibilityInfo()`：`lts: false`，`ltsLine: '2.2'`，`cliSurface: '2.4.0'`，默认 `writers: 'single'`

### Not in this release
异步复制、Quorum、Raft、自动分片、GraphQL、多库管理、跨机锁。

## 2.3.0 — 2026-11-03 · 非 LTS

**非 LTS。** 相对 2.2 为 MINOR。默认配置打开 2.2 库时行为与 LTS-2 一致。列存、热/温/冷新布局、智能压缩、插件、缓存压缩、热页预取、chunk 执行、Geo 索引、中文分词全部默认关闭。

生产仍应 pin **2.2**，除非需要本版存储格式。`lts` 继续指向 2.2。`latest` 指向 2.3.0。

### Added
- 按表列存。写入仍先落 WAL，列存异步重建。投影跳过无用列，结果与文档模式一致
- `storageTiers` 热/温/冷后台迁移，不阻塞写入。冷层可接 `storage` 插件。1.8 的 `tiering` 仍是实验旗标，对应关系见迁移指南
- 智能压缩：数值差分、低基数字典、RLE、gzip。块头记录算法。先压缩再加密
- `index compact` 合并分段。查询结果不变，再次打开命中合并段
- 大缓存值压缩；热页预取有命中计数，失败则退回按需读页（退回不是错误）
- 插件：`index` / `storage` / `compression` / `backup` / `queryLanguage`。校验名称与版本。钩子抛错不拖垮查询
- vector stub（可用实现在 3.3）、S3 stub（可用实现在 3.1）
- 大结果 chunk 执行，与非 chunk 结果相同
- 可选 GeoIndex、可选中文分词。缺少分词模块时 `open` 仍然成功
- CLI：`plugin list`、`plugin info`、`index create --type geo`、`index compact`
- `getCompatibilityInfo()`：`lts: false`，`ltsLine: '2.2'`，`cliSurface: '2.3.0'`

### Not in this release
savepoint（2.4）、多写者、复制、GraphQL、Raft、WASM、可用向量检索、可用 S3 上传。

## 2.2.0 — 2026-11-02 · **LTS-2**

**LTS-2。** 相对 2.1 为 MINOR，**不增加功能**。默认仍是单写者。本版不是集群版。

生产 pin 从 LTS-1（1.6.x）改为本线。1.6.x 继续收安全与正确性补丁，并行窗口不少于 12 个月，或至 LTS-3（2.5）发布后 6 个月，以本 Release 为准。`lts` 与 `latest` 都指向 2.2，直到 2.3 发布；2.3 起 `latest` 可以离开本线，`lts` 仍留在 2.2。

### Changed
- `getCompatibilityInfo()`：`lts: true`，`ltsLine: '2.2'`，`cliSurface: '2.2.0'`，`writers: 'single'`
- CLI 面冻结。`2.2.x` 补丁不新增子命令、不改默认值、不升 `formatVersion`（安全修复若必须动格式，须可迁移并单独说明）
- 新增并冻结 `config validate --file`：只接受已实现字段；`cluster` / `replica` / `l3` / `redis` / `cache`（方案 §9 的 Redis 嵌套，不是 `cacheSize`）等危险键拒绝且不生效，退出码 1，`INVALID_CONFIG`
- 发布 `config.example.json`（已冻结字段，不含集群 / L3）
- 迁移指南：[1.6 / 1.8 → 2.2](./devDocs/releases/v2.2.0/迁移指南.md)
- 备份演练脚本 `packages/core/scripts/backup-drill.mjs`（全量、增量、差异、坏 checksum、中间坏 WAL、坏数据页）

### Not in this release
多写者、复制、列存、插件、Geo、savepoint、GraphQL、Raft、集群。

## 2.1.0 — 2026-10-30

**非 LTS**（为 2.2 = LTS-2 浸泡）。默认仍是**单写者**。相对 2.0 为 MINOR。

### Added
- **差异备份** `backupDifferential()` / CLI `backup --type differential`；恢复走 `restoreChain({ type: 'differential' })`
- **保留策略** `pruneBackups({ keepDays, maxCount })` / `backup prune --keep-days`
- **定时备份** `backupIntervalMs`（默认 0 关闭）；失败发 `alert`
- **告警** `alerts.rules` + EventEmitter `alert` / 可选 webhook（cache_hit、error_rate、corrupt、backup_failed）
- **审计** `meta/audit.jsonl`：rekey、rollbackToTime、drop、migrate、repair；`audit list`
- **自动恢复**：损坏索引分段在 open 时重建；数据页损坏抛 `DATA_CORRUPT` 拒绝打开；显式 `repair()` 只重建索引、不静默改数据页
- **AutoTune** 灰度失败回滚 + `getTuneHistory()`；CLI `tune --dry-run`
- **`$regex`** 过滤；高选择性索引查询页读取次数低于全表扫描
- Advisor `rewrite` 建议（limit / projection），dry-run 不改库

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
