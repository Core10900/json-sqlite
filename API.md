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
