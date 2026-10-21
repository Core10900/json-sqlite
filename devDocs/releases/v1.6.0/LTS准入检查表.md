# JSONSQLite 1.6 LTS 准入检查表（1.5.0 移交草稿）

> 由 **1.5.0** 发版产出；1.6 冻结文档前请逐项复核并勾选。

## 1. 公开 API 清单（快照）

### 自由函数
- `create`, `init`, `open`, `getVersion`, `parseSql`, `rekeyDatabase`

### `JSONSQLite` 主要方法
- 生命周期：`open`, `close`, `isReady`, `storagePath`
- 表：`createTable` / `createCollection`, `listTables` / `listCollections`, `describeTable`, `dropTable`, `dropCollection`（**@deprecated** → `dropTable`）, `alterTable`, `count`
- CRUD：`insert`, `update`, `delete`, `upsert`, `findById`, `query`, `queryCursor`, `exportCollection`, `importCollection`
- SQL：`run`
- 索引：`createIndex`, `listIndexes`, `dropIndex`
- 事务：`beginTransaction`, `commitTransaction`, `rollbackTransaction`
- 备份：`backupFull`, `backupIncremental`, `restoreBackup`
- 运维：`vacuum`, `doctor`, `rekey`, `health`, `getMetrics`, `loadedCollectionCount`
- 特性：`queryAtTime`, `diffBetweenTimes`, `rollbackToTime`, `advise`, `profile`, `analyzeQuality`, `startServer`, `subscribe`

### 稳定 ErrorCode
`NOT_READY`, `ALREADY_OPEN`, `INVALID_CONFIG`, `COLLECTION_NOT_FOUND`, `COLLECTION_EXISTS`, `DOCUMENT_NOT_FOUND`, `VERSION_CONFLICT`, `LOCK_FAILED`, `TX_*`, `WAL_CORRUPT`, `DB_EXISTS`, `DB_NOT_FOUND`, `SQL_PARSE`, `SQL_UNSUPPORTED`, `SCHEMA_VIOLATION`, `QUERY_TIMEOUT`, `ENCRYPTION`, `INTERNAL`

### CLI 命令
`create`, `init`, `tables`, `table *`, `run`, `vacuum`, `rekey`, `doctor [--deep]`, `query`, `backup`, `version`, `help`

## 2. 兼容性承诺草案

| 变更类型 | 1.6.x patch | 禁止（需 2.0） |
|----------|-------------|----------------|
| bugfix / 安全修复 | ✅ | — |
| 新增可选选项（默认保持） | ✅ | — |
| 删除 / 改语义公开 API | — | ✅ |
| 默认 `schemaMode: strict` | — | ✅ |
| 多写者 / 存储格式破坏 | — | ✅ |

## 3. 已知限制

1. **内存模型**：集合加载后驻留内存；大表需 lazy + 容量规划
2. **单写者**：`FileLock`；非多进程共享写
3. **SQL**：单 JOIN、无子查询/窗口/`BEGIN`
4. **加密**：无在线 rekey（用离线 `rekey`）；deltas 变更日志仍为明文
5. **vacuum**：不压缩 deltas（保留时间旅行）

## 4. 测试矩阵（1.5 本地）

| 项 | 结果 |
|----|------|
| Vitest FT-V12/V13/V14/V15 | 发版时全绿 |
| Node | ≥ 20（engines） |
| OS | 开发机 macOS；Linux CI 待 1.6 补齐 |

## 5. 安全事项

- 生产 Admin：非 loopback 必须 `adminToken`
- 密钥：`encryptionKey` / `JSONSQLITE_KEY`；rekey 优先 `--out` 新路径
- 文件权限：收紧 `storagePath` 目录权限（OS 层）

## 6. 1.6 交付物对照

- [ ] 根目录 `API.md` / `CLI-API.md` 终稿
- [ ] 本检查表终态勾选
- [ ] 宣布 LTS 支持窗口
