# JSONSQLite Library API

> **适用于 `@webofcat/jsonsqlite` 1.6.x LTS**  
> CLI 细节以 [`CLI-API.md`](./CLI-API.md) 为准（命令面冻结自 **1.5.5**）  
> 本文档覆盖全部稳定 `import` 符号与 `JSONSQLite` 实例方法

---

## 1. 安装与双格式

```bash
npm install @webofcat/jsonsqlite
```

```ts
// ESM
import { open, create, init, getVersion, getCompatibilityInfo } from '@webofcat/jsonsqlite';

// CJS
const { open, create } = require('@webofcat/jsonsqlite');
```

**运行时**：Node.js ≥ 20

---

## 2. 快速开始

```ts
import { create, open } from '@webofcat/jsonsqlite';

await create({ storagePath: './data' });
const db = await open({ storagePath: './data' });

await db.createTable('users', {
  fields: [
    { name: 'name', type: 'string' },
    { name: 'age', type: 'number' },
  ],
});
await db.insert('users', { name: '寒', age: 30 });
const rows = await db.run('SELECT * FROM users WHERE age >= 18');
await db.close();
```

---

## 3. 生命周期

| 符号 | 说明 |
|------|------|
| `create(options)` | 新建库目录；已存在且未 `force` → `DB_EXISTS` |
| `init(options)` | 幂等初始化 |
| `open(options)` | 打开并持锁；返回 `JSONSQLite` 实例 |
| `db.close({ flush? })` | 关闭并释放锁 |
| `db.isReady` | 是否已 open |
| `db.storagePath` | 数据目录 |
| `getVersion()` | 包版本字符串（如 `"1.6.0"`） |
| `getCompatibilityInfo()` | LTS 兼容信息（见下） |

```ts
import { getCompatibilityInfo } from '@webofcat/jsonsqlite';

const info = getCompatibilityInfo();
// {
//   version: '1.6.0',
//   formatVersion: 1,
//   lts: true,
//   cliSurface: '1.5.5',
//   features: ['encryption', 'sql-like-join-count', ...]
// }
```

`CreateDatabaseOptions` 在 `JSONSQLiteOptions` 上增加可选 `force?: boolean`。

---

## 4. 配置：`JSONSQLiteOptions`

| 字段 | 默认 | 说明 |
|------|------|------|
| `storagePath` | （必填） | 数据目录 |
| `walMode` | `true` | WAL |
| `defaultIsolation` | `'READ_COMMITTED'` | 仅 READ_COMMITTED 真正实现；其它值会降级 |
| `queryTimeout` | `30000` | ms；`0` 关闭 |
| `cacheSize` | `1000` | L1 查询缓存条数 |
| `encryptionKey` | `null` | AES 密钥；或环境变量 `JSONSQLITE_KEY` |
| `syncMode` | `'normal'` | `'none'` \| `'normal'` \| `'full'` |
| `schemaMode` | `'off'` | `'off'` \| `'warn'` \| `'strict'` |
| `lazyCollections` | `true` | open 时不预加载全部集合 |
| `prefetchCollections` | `[]` | open 时预热的集合名 |

---

## 5. 表 / 集合 DDL

| 方法 | 说明 |
|------|------|
| `createTable(name, options?)` / `createCollection` | 建表；可选软 Schema `fields` |
| `listTables()` / `listCollections()` | 列表（含 `documentCount`） |
| `describeTable(name)` | 表元数据 |
| `dropTable(name)` | 删表 |
| `dropCollection(name)` | **@deprecated** → 请用 `dropTable` |
| `alterTable(name, spec)` | `renameTo` / `addFields` / `dropFields` |
| `renameTable(from, to)` | 重命名 |
| `count(collection, filter?)` | 文档计数 |

字段类型：`string` | `number` | `boolean` | `json` | `any`。

---

## 6. 文档 CRUD

| 方法 | 说明 |
|------|------|
| `insert(collection, doc \| doc[])` | 插入；自动 `_id` / `_version` / 时间戳 |
| `update(collection, id, patch)` | 按 id 更新 |
| `delete(collection, id)` | 按 id 删除 |
| `upsert(collection, doc)` | 有 `_id` 则更新否则插入 |
| `findById(collection, id)` | 单行或 `null` |
| `query(JsonQuery)` | 过滤 / 投影 / 排序 / limit / offset |
| `queryCursor(opts)` | 游标分页（`nextCursor`） |
| `exportCollection(name)` | 导出全部文档 |
| `importCollection(name, docs, { mode? })` | `append`（默认）或 `replace` |

过滤器支持：`$eq` `$ne` `$gt` `$gte` `$lt` `$lte` `$in` `$nin` `$contains` `$like` `$nlike` `$exists` `$and` `$or`。

---

## 7. 查询辅助

| 方法 | 说明 |
|------|------|
| `aggregate(collection, stages)` | 聚合管道 |
| `jsonPath(collection, pathExpr)` | JSONPath 抽取 |
| `advise(query)` | 索引建议 |
| `profileQuery(...)` | 查询画像采样 |
| `analyzeQuality(collection, requiredFields?)` | 数据质量 |

---

## 8. SQL

| 符号 | 说明 |
|------|------|
| `db.run(sql)` | 执行单条 SQL 子集 |
| `parseSql(sql)` | 解析为 AST（不执行） |

### 支持

- `SELECT`（含 `WHERE` / `ORDER BY` / `LIMIT` / `OFFSET`）
- `SELECT COUNT(*)`（单表；结果 `[{ count }]`；不支持 JOIN / ORDER BY）
- 单次两表 `INNER JOIN` / `LEFT JOIN`（等值 `ON`）
- `LIKE` / `NOT LIKE`（`%` `_`；`\` 转义）
- `INSERT` / `UPDATE` / `DELETE`
- DDL：`CREATE TABLE` / `DROP TABLE` / `ALTER TABLE` / `SHOW TABLES` / `DESCRIBE` / `SHOW`

### 不支持（稳定拒绝）

- 子查询、窗口函数、多 JOIN、`UNION`
- 完整事务语法 `BEGIN` / `COMMIT`（请用 API 事务）
- 任意方言扩展

错误码：`SQL_PARSE`、`SQL_UNSUPPORTED`。

---

## 9. 索引 / 事务

### 索引

| 方法 | 说明 |
|------|------|
| `createIndex(collection, field, type?)` | `object` \| `tree` \| `inverted` |
| `listIndexes()` | 索引元数据 |
| `dropIndex(collection, field)` | 删除 |

### 事务

| 方法 | 说明 |
|------|------|
| `beginTransaction(isolation?)` | 返回 txId；真实语义为 READ_COMMITTED |
| `commitTransaction(txId?)` | 提交 |
| `rollbackTransaction(txId?)` | 回滚 |

不支持嵌套事务（`TX_NESTED`）。

---

## 10. 备份 / 时间旅行 / 监控 / Advisor

| 方法 | 说明 |
|------|------|
| `backupFull()` | 全量备份 |
| `backupIncremental()` | 增量（可能 `null`） |
| `restoreBackup(file)` | 恢复 |
| `queryAtTime(collection, ts, filter?)` | 时间点查询 |
| `diffBetweenTimes(collection, from, to)` | 区间差异 |
| `rollbackToTime(collection, ts)` | 回滚集合到时间点 |
| `health()` | 健康报告 |
| `getMetrics()` | 运行指标 |
| `loadedCollectionCount()` | 已加载集合数 |

---

## 11. 导出导入 / vacuum / rekey

| 方法 / 函数 | 说明 |
|-------------|------|
| `exportCollection` / `importCollection` | 见 §6 |
| `vacuum({ collection? })` | 重写 JSONL、截断 WAL；**不压缩 deltas** |
| `doctor({ deep? })` | 诊断；`deep` 含一致性抽样 |
| `db.rekey(opts)` / `rekeyDatabase(opts)` | 离线换钥；推荐 `--out` 新路径 |

`RekeyOptions`：`fromKey`、`toKey`、`targetPath`、`inPlace`、`yes`、`syncMode`。

---

## 12. HTTP Admin

```ts
await db.startServer({ host: '127.0.0.1', port: 3000, adminToken?: string });
```

- 绑定非 loopback **必须**提供 `adminToken`
- loopback 无 token 会 stderr 告警

类型：`HttpServerOptions`。

---

## 13. 事件

```ts
const unsubscribe = db.subscribe((event) => { /* ... */ });
unsubscribe();
```

---

## 14. ErrorCode 全表

| Code | 含义 |
|------|------|
| `NOT_READY` | 未 open |
| `ALREADY_OPEN` | 重复 open |
| `INVALID_CONFIG` | 配置非法 |
| `COLLECTION_NOT_FOUND` | 表/集合不存在 |
| `COLLECTION_EXISTS` | 已存在 |
| `DOCUMENT_NOT_FOUND` | 文档不存在 |
| `VERSION_CONFLICT` | 乐观锁冲突 |
| `LOCK_FAILED` | 文件锁失败 |
| `TX_ACTIVE` | 事务状态冲突 |
| `TX_NOT_FOUND` | 事务不存在 |
| `TX_NESTED` | 嵌套事务 |
| `WAL_CORRUPT` | WAL 损坏 |
| `DB_EXISTS` | create 时目录已存在 |
| `DB_NOT_FOUND` | 库不存在 |
| `SQL_PARSE` | SQL 语法错误 |
| `SQL_UNSUPPORTED` | SQL 能力外 |
| `SCHEMA_VIOLATION` | `schemaMode: strict` 校验失败 |
| `QUERY_TIMEOUT` | 查询超时 |
| `ENCRYPTION` | 加密/密钥错误 |
| `INTERNAL` | 内部错误 |

异常类型：`JSONSQLiteError`（`code`、`message`、`details?`）。

---

## 15. 类型 / 值导出表

### 值导出

`JSONSQLite` · `open` · `create` · `init` · `getVersion` · `getCompatibilityInfo` · `parseSql` · `rekeyDatabase` · `JSONSQLiteError` · `ErrorCode` · `FORMAT_VERSION`

### 类型导出

`CreateDatabaseOptions` · `CreateDatabaseResult` · `InitDatabaseResult` · `CompatibilityInfo` · `JSONSQLiteOptions` · `Document` · `JsonQuery` · `FilterCondition` · `FilterOp` · `IsolationLevel` · `CollectionInfo` · `TableInfo` · `FieldDef` · `FieldType` · `CreateTableOptions` · `AlterTableSpec` · `SqlResult` · `OrderBySpec` · `IndexType` · `SyncMode` · `SchemaMode` · `QueryCursorOptions` · `QueryCursorResult` · `ImportCollectionOptions` · `RekeyOptions` · `RekeyResult` · `VacuumOptions` · `VacuumResult` · `DoctorCheck` · `DoctorReport` · `AggregateStage` · `AggregateField` · `AggregateOp` · `BackupInfo` · `Advice` · `HealthReport` · `IndexMeta` · `SqlStatement` · `HttpServerOptions`

---

## 16. LTS 兼容承诺与已知限制

### 保证（1.6.x）

1. 不删除、不重命名本文稳定符号（除非 major）  
2. 不缩小已承诺 SQL 语义（安全修复除外并记 CHANGELOG）  
3. `formatVersion` 升级必须可迁移，否则升 major  
4. CLI 子命令 / 全局 flags / exit / `--json` 错误包络与 [`CLI-API.md`](./CLI-API.md) 兼容  

### 不保证

1. 多进程多写  
2. 性能绝对值  
3. `@internal` / 测试钩子  
4. Admin HTML 视觉细节  
5. 在 1.6.x **新增**与 1.5.5 同级的 CLI 功能面  

### 已知限制

1. **单写者**：`FileLock`；第二进程 open → `LOCK_FAILED`  
2. **内存模型**：集合加载后驻留；大表用 lazy + 容量规划  
3. **SQL**：单 JOIN、无子查询/窗口/`BEGIN`  
4. **加密**：无在线 rekey；deltas 变更日志仍为明文  
5. **vacuum**：不压缩 deltas（保留时间旅行）  
6. **CLI REPL**：仅 TTY  

---

## 17. 升级指南：1.5.5 → 1.6.0

通常 **无破坏性变更**：

1. 依赖升到 `1.6.0`  
2. 可选使用 `getCompatibilityInfo()` 做运维探测  
3. CLI 脚本继续按 1.5.5 命令面工作；以本仓库 `CLI-API.md` 为准  
4. 相对 **2.0**：预期可能引入多写者、硬 Schema 默认、存储格式大变——勿假设 1.6 API 在 2.0 不变  

从更早版本升级：先读 1.4 / 1.5 README 迁移节（加密、lazy、rekey），再升到 1.6。  

---

## 18. 1.7 增补（非 LTS）

> 以下为 **1.7.0+** 新增能力；**1.6.x LTS 契约符号仍全部保留**。生产 pin LTS 请继续使用 `1.6.x`。

### 新增导出

| 符号 | 说明 |
|------|------|
| `StreamProcessor` | 进程内滑动窗口（基于 `subscribe`） |
| `autoSelectIndexType` | 索引类型启发式选择 |
| `isLoopbackHost` | Admin 绑定判定辅助 |
| 类型 `SlidingWindowOptions` / `AutoTuneAuditEntry` / `AutoSelectSample` | 配套类型 |

### `JSONSQLiteOptions` 增补

| 字段 | 默认 | 说明 |
|------|------|------|
| `autoTune` | `false` | 开启后对慢查询跑 Advisor；配合 `autoTuneDryRun` |
| `autoTuneDryRun` | `true` | 只推荐不建索引 |

### 实例方法增补

| 方法 | 说明 |
|------|------|
| `createIndex(col, field, type, { fields? })` | `type: 'composite'` + `fields` |
| `autoSelectIndexType(sample, field?)` | 返回 `object\|tree\|inverted\|composite` |
| `getSlowQueries(threshold?)` | 慢查询缓冲 |
| `setAutoTune` / `runAutoTune` / `getAutoTuneAudit` | AutoTune 控制与审计 |
| `createStreamProcessor()` | 滑动窗口工厂 |

### 聚合阶段增补

- `{ type: 'unwind', path, preserveNullAndEmpty? }`
- `{ type: 'lookup', from, localField, foreignField, as }`（内存哈希）

### Admin / 实时

- `startServer`：仪表盘 + `/admin/metrics|slow|tables|advise|profile|backup|timetravel|events`
- SSE：`/admin/events`（`metrics` / `dataChanged`）；token 可用 `Authorization` 或 `?token=`

### `getCompatibilityInfo()`（1.7）

- `lts: false`，`cliSurface: '1.7.0'`，`features` 含 `admin-sse` / `composite-index` 等

---

## 19. 1.8 增补（非 LTS）

> 性能与存储预备。**1.6 符号保留**。L2 / 压缩 / 热冷默认关闭，不改变 1.7 的查询结果。`persistIndexes` 默认 true：没有段或校验失败时仍全量 rebuild。

### `JSONSQLiteOptions`

| 字段 | 默认 | 说明 |
|------|------|------|
| `persistIndexes` | `true` | 索引段落盘。`false` 时每次加载集合都 rebuild |
| `l2Cache` | `false` | 进程内二级查询缓存 |
| `l2CacheSize` | `5000` | L2 条数上限 |
| `compression` | `false` | 大 JSON 行 gzip（`JSQC1:`），再交给加密 |
| `compressionThreshold` | `1024` | 达到该字节数才尝试压缩，且仅在变小时保留 |
| `tiering` | `false` | **实验**热冷分层。冷文档在 `cold.jsonl`，按 id 延迟加载 |
| `tierColdAfter` | `0` | 访问次数 ≤ 该值的文档在 `close()` 时进入冷层 |

### 实例方法

| 方法 | 说明 |
|------|------|
| `indexPersistence()` | `{ buildCount, restored, servedFromSegment, rebuilt, corrupt }` |
| `rebuildIndexes(collection?)` | 重建 postings 并重写段 |
| `storageSummary()` | doctor / CLI 用的段、压缩、tier、L2 摘要 |
| `getMetrics()` | 额外字段 `l2`、`tiers`、`compression`、`indexes` |
| `vacuum({ compress: true })` | 打开压缩并重写 JSONL |

### SQL

- `SELECT city, COUNT(*) FROM t GROUP BY city`（可 `ORDER BY` / `LIMIT`；不支持 JOIN）
- `SQL_PARSE` / `SQL_UNSUPPORTED` 的 `message` 以 `[SQL_PARSE]` 或 `[SQL_UNSUPPORTED]` 开头

### 兼容信息（1.8）

- `getVersion() === '1.8.0'`
- `lts: false`，`cliSurface: '1.8.0'`
- `features` 含 `index-segments`、`l2-cache`、`compression`、`tiering`、`group-by-count`

热冷布局和段格式都带版本（段 `format: 1`），**不**作为 2.0 的冻结承诺。2.0 的分页、备份链和隔离以下面一节为准。生产 pin 继续用 **1.6.x**，直到 2.2。

---

## 2.0 破坏与契约（非 LTS，单写者）

本版是 **MAJOR**。默认仍是**单写者**（第二进程 `LOCK_FAILED`）。没有 plugin、replica、cluster API。

相对 1.8 的破坏点：

1. 磁盘 `formatVersion` 从 1 升到 2。旧库用 `migrateDatabase({ from, to, yes: true })` 或 CLI `migrate --from --to --yes`。直接 `open` 抛 `MIGRATION_REQUIRED`。损坏源不会留下目标目录。
2. 文档按页存放（`pages.json` + `pages/pNNNNNN.jsonl`）。`pageSize` 默认 32，`maxResidentDocs` 默认 256，且必须 `>= pageSize`。点查读一页；扫描受页预算约束。
3. 隔离：默认 `READ_COMMITTED`（读最新已提交）。`REPEATABLE_READ` 在 `begin` 建快照，重复读不看见之后的提交。只读快照可与一个写事务并存。`SERIALIZABLE` 与 `READ_UNCOMMITTED` 抛 `ISOLATION_UNSUPPORTED`（配置成默认值则 `INVALID_CONFIG`），不再降级。
4. `restoreChain` / `backup restore`：checksum 不符抛 `BACKUP_CHECKSUM` 且目标字节不变；增量没有全量基线抛 `BACKUP_BASELINE` 且不部分套用。`collection` 只恢复该集合。
5. WAL：尾部不完整的一行可丢弃；中间行校验失败抛 `WAL_CORRUPT`，不跳过其后的已提交记录。
6. Admin：非 loopback 必须同时提供 `adminToken` 与 `tls: { cert, key }`，否则 `INVALID_CONFIG`。loopback 仍可省略 token，并打印警告。

### 新增选项

| 选项 | 默认 | 说明 |
|------|------|------|
| `pageSize` | `32` | 每页文档数 |
| `maxResidentDocs` | `256` | 页缓存中的文档上限 |

### 新增方法

| 方法 | 说明 |
|------|------|
| `beginTransaction('REPEATABLE_READ')` | 返回快照 id |
| `query(q, { txId })` / `findById(col, id, { txId })` | 在该快照上读 |
| `restoreChain({ type, file?, collection? })` | 全量或全量+增量恢复 |
| `pagingStats()` | `{ pageSize, maxResidentDocs, residentDocs, pageReads }` |
| `migrateDatabase({ from, to, yes, encryptionKey? })` | 1.x → 2.0 |

### 兼容信息（2.0）

- `getVersion() === '2.0.0'`
- `lts: false`，`writers: 'single'`，`cliSurface: '2.0.0'`
- **非 LTS**。长期 pin 仍是 1.6.x，下一档推荐 pin 是 2.2

---

## 2.1 运维与查询补齐（非 LTS，仍单写者）

相对 2.0 为 **MINOR**。不删除 2.0 稳定符号。下一版 **2.2** 将冻结本契约为 LTS-2。

### 行为

1. 差异备份：自最近一次全量起的变更；恢复 = 全量 + 该 differential。
2. `backupIntervalMs` 默认 `0`（关）。开启后失败经 `alert` / webhook 投递。
3. 损坏索引分段：open 时自动重建。数据页损坏：`DATA_CORRUPT`，拒绝打开；**不会**静默改写数据。显式 `repair({ rebuildIndexes: true })` 只重建索引。
4. `$regex`：字符串或 `{ pattern, flags? }`；非法表达式 `INVALID_CONFIG`。
5. 审计覆盖 `rekey` / `rollbackToTime` / `drop` / `migrate` / `repair`，`listAudit()` / CLI `audit list`。

### 新增选项

| 选项 | 默认 | 说明 |
|------|------|------|
| `backupIntervalMs` | `0` | 定时备份间隔；0 = 关 |
| `backupKeepDays` / `backupMaxCount` | — | 可选保留策略（定时备份后也可手动 prune） |
| `alerts` | — | `{ rules, webhookUrl? }` |

### 兼容信息（2.1）

- `getVersion() === '2.1.0'`
- `lts: false`，`writers: 'single'`，`cliSurface: '2.1.0'`
- **非 LTS，仍单写者**

