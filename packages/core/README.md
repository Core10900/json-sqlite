# @webofcat/jsonsqlite

**版本：3.4.0** · **非 LTS** · **不是设计完工版** · 设计完工线 **3.6** · 默认单写者 · 复制默认关闭 · **没有自动选主** · Node.js ≥ 20 · 作者：hanlin

这一版是**复制硬化与接入层**。相对 3.3 为 **MINOR**。不开启复制、不加载适配器时，单机契约与 3.3 一致。主宕机**仍然没有自动选主**，也没有自动故障切换；唯一提升入口仍是 `replica promote --yes`。

生产 pin 在 3.6 宣布前仍是 **LTS-2（2.2）** / 多写者 **LTS-3（2.5）**。本包不是长期支持线。不带 tag 的安装得到 `latest`，这一版是 3.4.0。没有 `lts-4`。

```bash
# 不带 tag：latest，这一版是 3.4.0（复制默认关闭）
npm install @webofcat/jsonsqlite

# 单写者生产
npm install @webofcat/jsonsqlite@lts
npm install @webofcat/jsonsqlite@lts-2

# 需要多写者
npm install @webofcat/jsonsqlite@lts-3
```

`lts` / `lts-2` 是 2.2。`lts-3` 是 2.5。`latest` 是 3.4.0。

```ts
import { getCompatibilityInfo, open } from '@webofcat/jsonsqlite';

const info = getCompatibilityInfo();
// version: '3.4.0'
// lts: false
// ltsLine: '2.5'   // 最新的 LTS 线（LTS-3），不是本包版本
// writers: 'single'
// cliSurface: '3.4.0'
```

## 3.4 复制硬化与接入层

### 1. Quorum

配置键：`replica.quorum`（含在 `open({ replica: { quorum } })` 里）。默认 **1**（只计主库本地 ack）。`quorum > 1` 时，主库追加日志后等待从库 ack，最长 `QUORUM_WAIT_MS`（**2000** ms）。

达不到确认数：抛 `QUORUM_FAILED`，`details.retryable === true`，调用方可重试。此时 `replica status` 的 **`replicated` 为 false**（主库不把未确认写入报告为已复制）；同时可见 `quorum` / `quorumAcked`。

```ts
const primary = await open({
  storagePath: './primary',
  replica: { quorum: 2, syncIntervalMs: 100 },
});
await primary.replicaInit({ role: 'primary' });
// 没有从库 ack 时 insert → QUORUM_FAILED；status.replicated === false
```

```bash
jsonsqlite replica status -p ./primary --json
# 关注 quorum、quorumAcked、replicated
```

### 2. 读路由 / 写主

`ReadRouter`：写永远走主（`write` → `primary.insert`）；读在从库 `lagEntries` ≤ 阈值时走从。

| 选项 | 默认 | 含义 |
|------|------|------|
| `lagThresholdEntries` | **10** | 允许的最大从库滞后（条数） |
| `onLag` | **`'fail'`** | 超阈值：抛错（默认）或 `'primary'` 退回主库读 |

- `onLag: 'fail'`：超阈值抛 `INVALID_CONFIG`（含 `lagEntries` / `lagThresholdEntries`）。
- `onLag: 'primary'`：超阈值改从主库 `findById`。

```ts
import { ReadRouter, open } from '@webofcat/jsonsqlite';

const primary = await open({ storagePath: './primary', replica: { syncIntervalMs: 50 } });
const secondary = await open({ storagePath: './secondary', replica: { syncIntervalMs: 50 } });
await primary.replicaInit({ role: 'primary' });
await secondary.replicaInit({ role: 'secondary', primaryPath: './primary' });

const router = new ReadRouter(primary, secondary, {
  lagThresholdEntries: 10,
  onLag: 'fail', // 或 'primary'
});
await router.write('docs', { _id: '1', name: 'a' });
const doc = await router.read('docs', '1');
```

### 3. 三节点手册摘要

**没有自动选主。** 任一步失败就停，不要跳过。

```bash
# 1) 启动主 + 两个从
jsonsqlite init -p ./n1 && jsonsqlite replica init --role primary -p ./n1
jsonsqlite init -p ./n2 && jsonsqlite replica init --role secondary --primary-path ./n1 -p ./n2
jsonsqlite init -p ./n3 && jsonsqlite replica init --role secondary --primary-path ./n1 -p ./n3

# 2) 看滞后（预期：role、lagEntries、quorum、quorumAcked、replicated）
jsonsqlite replica status -p ./n2 --json

# 3) 停一个从（杀进程或关掉该目录的进程）。主在 quorum=1 时仍可写；
#    quorum=2 且只剩一个从时，再写入可能 QUORUM_FAILED（可重试）

# 4) 手动提升（确认旧主不再写入之后）
jsonsqlite replica promote --yes --operator ops -p ./n2
# 审计：action=promote，details.operator / fromRole / toRole / promotedAt
```

提升前数据停在 `appliedLsn`；未复制的主库尾部不会自动追回。

### 4. S3 / 对象存储冷层

`createS3Plugin({ rootDir })` 是文件系统示例（`stub: false`，`availableIn: '3.4'`），对象落在 `{rootDir}/{collection}/{id}.json`。`createS3Stub()` 仍只记调用、不落盘。

```ts
import { createS3Plugin, open } from '@webofcat/jsonsqlite';

const db = await open({ storagePath: './data', storageTiers: true });
const cold = createS3Plugin({ rootDir: './cold-root' });
db.registerPlugin(cold);

await cold.putCold('docs', { _id: 'c1', name: 'frozen', _version: 1 });
await cold.getCold('docs', 'c1'); // 读回同一文档
await db.findById('docs', 'c1');  // 热层未命中时可由插件召回
```

对象存储失败时，**热集合点查仍可用**。尚未取回的冷文档**不会**出现在热层 `query` 结果里；对未知冷 id 的 `findById` 为 `null`。

### 5. GraphQL

核心包内：`executeGraphQL(db, source)`。只支持两种形状，**不是**完整 GraphQL 数据库：

- `query { documents(collection: "...", filter?: "...") { fields } }` → `db.query`
- `mutation { insert(collection: "...", data: "{...}") { fields } }` → `db.insert`

```ts
import { executeGraphQL, open } from '@webofcat/jsonsqlite';

const db = await open({ storagePath: './data', graphql: true });
await executeGraphQL(
  db,
  'mutation { insert(collection: "users", data: "{\\"_id\\":\\"g1\\",\\"name\\":\\"Grace\\"}") { _id name } }',
);
await executeGraphQL(
  db,
  'query { documents(collection: "users") { _id name } }',
);
```

HTTP：`POST /graphql`（需 `graphql: true`，鉴权与 `/query` 相同）。也可用 `createGraphqlHandler(db)`。`config.example.json` 中 `"graphql": false`；`config validate` 接受它，仍拒绝 `cluster` / `wasm`。

不支持：subscription、复杂 schema、任意 GraphQL 方言。

### 6. 连接池

```ts
import { createConnectionPool } from '@webofcat/jsonsqlite';

const pool = createConnectionPool({ storagePath: './data', size: 1 });
const db = await pool.borrow();
await db.insert('docs', { _id: 'p1', name: 'pooled' });
pool.release(db);
await pool.close(); // 关闭并释放文件锁 / 句柄
// 之后 borrow / release → POOL_CLOSED
```

单写者存储下同一路径只开一个句柄；`size > 1` 仍共享并串行借还，避免锁争用。`close` 后不应再有泄漏的文件锁。

### 7. 多库注册表

```ts
import { createDatabaseRegistry } from '@webofcat/jsonsqlite';

const registry = await createDatabaseRegistry();
await registry.register('A', './data-a');
await registry.register('B', './data-b');
const dbA = await registry.use('A');
const dbB = await registry.use('B');
await dbA.insert('docs', { _id: 'only-a' });
await dbB.findById('docs', 'only-a'); // null — 读 A 看不到 B
await dbA.close({ flush: true });
await dbB.findById('docs', 'keep'); // 关掉 A 不影响 B
await registry.closeAll();
```

```bash
jsonsqlite db register --name A --path ./data-a
jsonsqlite db register --name B --path ./data-b
jsonsqlite db list
jsonsqlite db use --name A          # 打印 -p / JSONSQLITE_PATH 提示
jsonsqlite db unregister --name A
```

注册文件：cwd `.jsonsqlite-registry.json` 或 `~/.jsonsqlite/registry.json`。

### 8. Express / Nest 示例

核心包**不**把 `express` / `@nestjs/*` 列为 dependency 或 peerDependency。

| 示例 | 路径 | 启动 |
|------|------|------|
| Express | `apps/examples/express` | `pnpm --filter @jsonsqlite/example-express start`（默认端口 3100） |
| Nest 风格 | `apps/examples/nest` | `pnpm --filter @jsonsqlite/example-nest start`（默认端口 3200） |

两者都演示：对 `users` 写入再按 id 读回（Express 还挂了 `createGraphqlHandler`）。

### 9. advisorProvider

未配置时 `db.advise(query)` 只返回规则引擎建议。配置后注入异步函数；**provider 抛错时退回规则建议，原查询仍成功**。安装包不依赖外部 LLM。

```ts
const db = await open({
  storagePath: './data',
  advisorProvider: async (_query, rules) => {
    throw new Error('LLM unavailable'); // 调用方仍拿到 rules；query 不受影响
  },
});
const advice = await db.advise({ collection: 'users', filter: { age: { $gt: 18 } } });
const rows = await db.query({ collection: 'users', filter: { age: { $gt: 18 } } });
```

### 10. 向量插件（可用实现，不是通用向量库）

`createVectorPlugin()`：内存索引，`upsertVector` + 余弦相似度 `search` / `db.vectorSearch`。`stub: false`，`availableIn: '3.4'`。命中含 `{ id, score }`（`score` 为余弦相似度，越大越近）。适合**小样本**（进程内、维数一致的演示数据）。**不保证**复杂过滤、持久化、实时增量同步，也**不是**通用向量数据库。`createVectorStub()` 仍返回空命中。

```ts
import { createVectorPlugin, open } from '@webofcat/jsonsqlite';

const db = await open({ storagePath: './data' });
const vector = createVectorPlugin();
db.registerPlugin(vector);
vector.upsertVector('docs', 'v1', [1, 0, 0]);
const result = await db.vectorSearch('docs', [1, 0, 0]);
// result.stub === false；result.hits[0].score > 0
```

### 11. serve

```bash
jsonsqlite serve -p ./data --host 127.0.0.1 --port 3000
# 等同 jsonsqlite admin serve …；监听现有 HTTP/Admin（含 REST、SSE、/stream）
```

```ts
await db.serve({ host: '127.0.0.1', port: 3000 });
await db.startServer({ host: '127.0.0.1', port: 3000 }); // 同一行为
```

`open()` **不会**因配置自动监听端口。没有新的 TCP / 线协议。

### 12. collection / table

`db.collection(name)` 与 `db.table(name)` 返回同一类 `CollectionHandle`；`insert` / `find` / `findById` / `update` / `delete` 委托现有引擎方法，不另建存储。

```ts
await db.collection('items').insert({ _id: 'i1', sku: 'X' });
await db.table('items').findById('i1'); // 与 db.findById('items', 'i1') 相同
```

### 13. REST 文档接口

鉴权与 `POST /query` 相同（token / TLS 规则不变）。全部委托现有引擎：

| 方法 | 路径 | 等价 |
|------|------|------|
| `POST` | `/collections/:name` | `db.insert(name, body)` → 201 `{ doc }` |
| `GET` | `/collections/:name/:id` | `db.findById`；未找到 `DOCUMENT_NOT_FOUND` 404 |
| `PATCH` | `/collections/:name/:id` | `db.update` |
| `DELETE` | `/collections/:name/:id` | `db.delete`；未找到 404 |
| `POST` | `/query` | 保留，JSON 查询 |

### 14. 明确不在本版

Raft、自动分片、**自动选主**、跨机锁、WASM、多语言 TCP。`config validate` 仍拒绝 `cluster` 与 `wasm`。稳定帮助**没有** `cluster`。选主与集群浸泡在 **3.5**；长期稳定线是 **3.6**。

---

## 3.3 异步复制（默认关闭，历史）

拓扑是**一个主、一个或多个从**。主库本地提交成功**不能**当成从库已经收到。从库异步拉取主库的 `replication/log.jsonl`，达到**最终可见**。3.4 在此基础上增加 quorum、读路由与接入层；本节仍是复制基础行为。

### 关闭 vs 开启

```ts
// 关闭（默认）：仍是单机，可直接打开 2.5 / 3.2 / 3.3 库
const db = await open({ storagePath: './data' });
const dbOff = await open({ storagePath: './data', replica: false });

const primary = await open({
  storagePath: './primary',
  replica: { syncIntervalMs: 100 },
});
await primary.replicaInit({ role: 'primary' });

const secondary = await open({
  storagePath: './secondary',
  replica: { syncIntervalMs: 100 },
});
await secondary.replicaInit({
  role: 'secondary',
  primaryPath: './primary',
});
```

```bash
jsonsqlite replica init --role primary -p ./primary
jsonsqlite replica init --role secondary --primary-path ./primary -p ./secondary
jsonsqlite replica status -p ./secondary --json
```

### 滞后字段与单位

| 字段 | 单位 | 含义 |
|------|------|------|
| `lagEntries` | **条数** | 主库尖端 LSN − 已应用 LSN |
| `lagMs` | **毫秒** | 主库尖端时间 − 已应用时间 |
| `appliedLsn` / `replicatedPrefix` | LSN | 已安全应用的前缀 |
| `role` | 枚举 | `none` / `primary` / `secondary` |
| `quorum` / `quorumAcked` / `replicated` | — | 3.4 status 字段 |

### 主宕机之后

1. 从库停在已复制前缀，**继续拒绝写入**。
2. 没有自动选主。错误码：`REPLICA_READONLY`。
3. 确认旧主不再写入后：`jsonsqlite replica promote --yes [--operator name] -p ./secondary`

### `/health` 与配置

- 复制关闭：`/health` 成功，`replica.enabled === false`，**不**因没有从库而失败。
- 复制打开：含 `role`、`lagEntries`、`lagMs` 等。

`config.example.json` 中 `"replica": false`、`"graphql": false`。`config validate` 接受它们，仍拒绝 `cluster` / `wasm`。

详细协议见 [`devDocs/releases/v3.3.0/RFC-异步复制.md`](../../devDocs/releases/v3.3.0/RFC-异步复制.md)。

## 3.2 单机运维

### PITR

时间戳单位是 **epoch 毫秒**。全量备份之后，再按序应用不晚于该时间的增量。该时间之后的写入不在恢复结果里。checksum 失败错误码是 `BACKUP_CHECKSUM`，目标目录不变。

```bash
jsonsqlite backup --type full -p ./data
jsonsqlite backup --type incremental -p ./data
jsonsqlite backup restore --to 1730000000000 -p ./data
```

```ts
await db.restoreChain({ type: 'incremental', to: Date.now() });
```

### 时间旅行保留与回滚

`timeTravelRetentionMs` 默认 **7 天**（604800000）。它裁 changelog；备份 `keepDays` 裁备份文件。过期变更被裁掉之后，更早的 `queryAtTime` 返回 **空数组**，不抛未说明的异常。

```ts
await db.rollbackToTime('docs', ts); // CONFIRM_REQUIRED，数据不变，审计 confirmed:false
await db.rollbackToTime('docs', ts, { confirm: true, caller: 'ops' });
// 审计字段：action=rollbackToTime，details.collection / timestamp / caller / confirmed
```

```bash
jsonsqlite rollback --to 1730000000000 docs -p ./data          # 拒绝
jsonsqlite rollback --to 1730000000000 docs --yes -p ./data    # 确认
```

### AutoTune

默认关闭（`autoTune: false`）。打开后可灰度建议 **cacheSize** 与 **compression**；校验失败回到应用前配置。`autoIndex` 就是 `autoTune`；`autoTuneMinHits` 默认 **2**。

```bash
jsonsqlite tune --dry-run '{"collection":"users","filter":{"age":{"$gte":18}}}' -p ./data --json
# entries 里能看到 action: cache | compression | recommend；dry-run 不改配置
```

### 数据质量

`quality` / `analyzeQuality` 输出五项：completeness、uniqueness、accuracy、consistency、timeliness。建议不写库。

```ts
await db.analyzeQuality('docs', ['name']);
await db.autoFix('docs', ['name']); // 仅显式调用；open 不会调用
```

### WebSocket 与 Admin

```bash
jsonsqlite admin serve -p ./data --port 3000
```

路径：`/admin`、`/admin/queries`、`/admin/tables`、`/admin/monitor`、`/admin/backup`、`/admin/settings`。查询台字段：`stages.parse|optimize|indexScan|dataLoad|execute`、`usedIndex`。生产仍要 token；非本机绑定与 2.0 TLS 门禁相同。SSE `/admin/events` 仍可用。

```js
const ws = new WebSocket('ws://127.0.0.1:3000/stream');
ws.onmessage = (ev) => JSON.parse(ev.data); // { event: 'dataChanged'|'metrics', data }
```

`/stream` 上除了窗口结果，还有与 SSE 相同结构的 `metrics` 事件。

### 插件与 Redis

```bash
jsonsqlite plugin load ./my-plugin.mjs -p ./data   # 校验失败非 0；随后查询仍可用
```

```ts
import {
  PLUGIN_KINDS,
  PluginRegistry,
  assertPluginManifest,
  builtinPluginCatalog,
  builtinPluginInfo,
  createS3Plugin,
  createS3Stub,
  createVectorPlugin,
  createVectorStub,
  isJsonQueryShape,
  loadPluginFromPath,
} from '@webofcat/jsonsqlite/plugin';
```

`l3` / `redis` 默认 false。未安装客户端时 `open` 成功，`db.l3Status()` 为关闭（`reason: 'module-not-found'`）。3.4 起 `replica` / `graphql` 已移出危险键（example 默认关闭）；`config validate` 仍拒绝 `cluster` / `wasm`。可用冷存储与向量见上文 3.4 节（`createS3Plugin` / `createVectorPlugin`）。

### Advisor、指标、事务、Delta

```ts
db.rejectAdvice({ collection: 'users', field: 'age' }); // 写入 Monitor.adviceFeedback；下次不自动建该索引
db.on('metrics', (m) => m.p99); // metricsIntervalMs 默认 5000
// 无 error 监听器时失败只增加 errorsTotal，进程不崩
```

`getMetrics()` 含窗口 `qps`、`p50`/`p95`/`p99`、`lockWaitMs`（单写者为 0）、`walBytes`、`tables`。`alerts.responseTimeMs` 与 **p99** 比较。`/health` 含 `memoryBytes`、`lockCount`；`memoryWatermarkBytes: 0` 时不因此 degraded。

`transactionTimeoutMs` 默认 0。大于 0 时超时回滚，错误码 `TX_TIMEOUT`；已提交的上一笔仍在。

Delta 只记变更字段（`patch: true`）。达到 `deltaSnapshotThreshold`（默认 1000）后写带 checksum 的快照，成功后才按 7 天窗删旧 delta；checksum 失败不删。磁盘满 / 无权限：`STORAGE_FULL` / `STORAGE_PERMISSION`。

配置保持扁平。示例：`timeTravelRetentionMs`、`transactionTimeoutMs`、`alerts.responseTimeMs`、`autoTuneMinHits`、`metricsIntervalMs`。不接受嵌套 `cache`。`syncMode: 'full'` 即 fsync。

性能数字只引用 [`devDocs/releases/v3.2.0/性能包络.md`](../../devDocs/releases/v3.2.0/性能包络.md)。

### 这一版（3.2）明确不做

异步复制、Quorum、GraphQL、多库、可用向量、可用 S3、Raft、WASM、HTTP 文档 REST（这些在 3.3 / 3.4 陆续交付；见上文）。

## 3.1 索引与存储（历史）

下面的开关不写进配置时，行为与 3.0 相同。2.5 库可以直接打开。索引分段如果和当前进程不兼容，会在 `open` 时重建索引，文档页不迁移。

### B+Tree

有序索引的内存结构是 B+Tree。配置键 `bTreeOrder` 是一个节点最多放多少个键，默认 **128**。它不会自己建索引。建树用：

```bash
jsonsqlite index create nums n --type tree -p ./data
jsonsqlite index compact nums -p ./data
```

范围查询走树时，`explain` 的 `access` 是 `index`，`structure` 是 `btree`。`index compact` 合并分段之后，范围里的 `_id` 不变；关掉再打开，范围结果仍相同。节点访问次数在 `db.indexAccess(collection, field).nodeVisits`，点查随键数量按树高增长，不是把每个键扫一遍。

```ts
await db.createIndex('nums', 'n', 'tree');
db.explain({ collection: 'nums', filter: { n: { $gte: 1, $lte: 10 } } });
// access: 'index'，structure: 'btree'
```

### Geo

```bash
jsonsqlite index create places loc --type geo -p ./data
```

网格只检查和包围盒相交的格子。有索引时不会先读出全部点再过滤，查询也只按命中的 `_id` 取文档。

```ts
const box = { minLat: 30, minLon: 120, maxLat: 32, maxLon: 122 };
await db.query({ collection: 'places', filter: { loc: { $geoWithin: box } } });
```

没建索引时结果仍然正确，`explain` 的 `access` 是 `scan`。

### 分词

不传 `tokenizerModule` 时，`open` 不会 `import` 外部包。`tokenizerStatus().reason` 是 `not-configured`。

模块在加载或切词时抛错，`open` 仍然成功。之后带 `$contains` 的分词查询抛 `TOKENIZER_FAILED`。同一库上的 `findById` 仍然成功。缺包时 `reason` 是 `module-not-found`，等值查询可用，这和 2.3 一样。

### 列存与 hybrid

按表打开。`columnCollections` 把表收成列文件。`hybridCollections` 加上 `hybridFields`（写成 `表.字段`）时，列出的热字段进列文件，其余字段留在文档页。

写入仍先落 WAL，列文件是事后重建的投影。`projection: ['name']` 读取行键文件和 `name` 这一列，文件数是投影字段数加行键。数值列是差分加变长整数（文件头 `JSQC2|num`），字符串列是字典（`JSQC2|dict`）。

列文件校验和不符，或还没就绪时，查询退回文档页。退回不是错误，`lastPlan().source` 是 `document`。

```ts
const db = await open({
  storagePath: './data',
  hybridCollections: ['docs'],
  hybridFields: ['docs.name'],
});
await db.flushColumnStore('docs');
await db.query({ collection: 'docs', projection: ['name', 'meta'] });
// meta 不在列里，从文档页补上。结果与纯文档模式的同一投影一致
```

### storage advise

`storageAdvise` 默认 **false**。打开之后 `db.storageAdvise(table)` 或下面的命令只打印建议，`applied` 恒为 `false`，表的存储模式不变。本版没有「会自动切换」的命令。

```bash
jsonsqlite storage advise docs -p ./data --json
```

输入是字段基数、嵌套深度，以及 Monitor 记下的过滤字段直方图（字段名和次数，不记文档内容）。输出是 `document`、`columnar`、`hybrid`、`compressed` 之一。`compressed` 表示超过 `compressionThreshold` 的大文档适合走压缩块，读出来仍和 document 模式一致。调用方要自己执行 `enableColumnStore` 或 `enableHybrid` 才会换存储。

### 压缩

在 2.3 的 `delta`、`dict`、`rle`、`gzip` 上增加 `front`。front-coding 用于有共享前缀的字符串数组：记下和上一串相同的前缀长度，再写下后缀。

`compressionSampleWindow` 默认 64。采样时，如果类型启发式已经选出 `delta` / `dict` / `rle`，就沿用它。启发式落到 `gzip` 的字符串数组，才用这个窗口比较 front-coding 和 gzip 的体积，较小的那个写入块头。

块头是 `JSQB1|<algorithm>|<payload>`。算法名字段叫 `algorithm`，可以用 `readSmartHeader` 读出来。再次打开时按块头里的 `algorithm` 解压，不会重新采样。

和加密叠在一起时，顺序是先压缩、再 `encryptLine`。解压是先解密、再按块头解压。块对不上时错误码是 `DATA_CORRUPT`，这种块不会被当成已提交的数据留下。

### 分层

`storageTiers` 仍默认关闭。打开后，温层用 deflate（块头 `JSQL1|deflate`），冷层用 gzip；当前运行时如果有 zstd，冷层用 zstd。块头是 `JSQC1|gzip` 或 `JSQC1|zstd`。迁移在后台或 `migrateTiersOnce()` 里做，不在写入调用里完成。

`coldExternalDir` 把冷副本写到数据库目录外面。这个目录不可写时，`tierSummary().externalFailures` 增加，热文档按 `_id` 仍可读：

```ts
const db = await open({
  storagePath: './data',
  storageTiers: true,
  coldExternalDir: './cold-copy',
  coldAfter: 0,
  warmAfter: 0,
});
await db.insert('docs', { _id: 'hot', name: 'H' });
await db.findById('docs', 'hot');
await db.migrateTiersOnce();
await db.findById('docs', 'hot');
// name 仍是 'H'
```

### 热 key 与预取

热 key 在 L1 里被提升到 LRU 的热端。次数在 `db.getMetrics().l1.promotions`。预取计数在 `db.prefetchStats()`，字段是 `hits` 和 `fallbacks`。预取下一页失败时退回按需读当前页，退回不是错误，原来的点查仍然成功。本版没有 L3 Redis。

### 停用词

配置键是 `stopWords`。不写这个键时，倒排索引用现有的中英停用词：`的`、`了`、`是`、`在`、`和`、`有`、`the`、`a`、`an`、`and`、`or`、`to`。

空数组 `[]` 表示不丢弃任何词。改表用 `db.setStopWords(words)`，它会重建倒排索引，之后的查询用新表。

### 这一版明确不做

Redis（默认关）、S3 实际上传、可用的向量检索、GraphQL、集群。异步复制在 3.3 以默认关闭的形式提供。`vector` 仍是 stub，`availableIn` 是 `3.4`。`s3` 仍是 stub，`availableIn` 是 `3.4`，`putCold` 只计数，不上传对象。

下面用同一批文档说明旧过滤没有改结果：

```ts
const db = await open({ storagePath: './data' });
await db.insert('users', { _id: 'a', name: 'ann', age: 17 });
await db.insert('users', { _id: 'b', name: 'bo', age: 21 });

const legacy = await db.query({
  collection: 'users',
  filter: { age: { $gt: 18 } },
});
// 仍然是 [_id = b]。不传 signal、timeout、chunkSize 时走原来的过滤
```

## JSONPath

支持字段读取，以及比较和存在判断。解释器是表达式树。同一条路径文本会复用解释树，缓存键只有路径，不含文档或参数。默认不使用 `new Function`。

支持：

- `$.name`、`$.a.b`、`$[*].age`
- `$[?(@.age>18)]`、`$[?(@.age>18)].name`
- 比较：`=`、`==`、`!=`、`>`、`>=`、`<`、`<=`
- 存在：`@.nickname`（字段不是 `undefined`）
- `&&`、`||`

不支持脚本（例如 `$.name()`）和递归下降 `..`。这两种在执行前抛 `JSONPATH_UNSUPPORTED`，表达式不会跑。

```ts
const names = await db.jsonPath('users', '$[?(@.age>18)].name');
// ['bo']

await db.jsonPath('users', '$..name');
// JSONSQLiteError，code 是 JSONPATH_UNSUPPORTED，消息里有 recursive descent (..)

await db.jsonPath('users', '$.name()');
// 同样是 JSONPATH_UNSUPPORTED，消息里有 script
```

## 取消

`queryTimeout` 在扫描过程中检查，不是等结果拼完再抛。调用可以再传 `AbortSignal`。中止后抛错，不会把扫到一半的数组当成成功。下一次查询还能用。超时错误码是 `QUERY_TIMEOUT`，取消错误码是 `QUERY_CANCELLED`。

```ts
await db.query(
  { collection: 'users', filter: { age: { $gte: 0 } } },
  { timeout: 30 },
);

const ac = new AbortController();
const pending = db.query({ collection: 'users' }, { signal: ac.signal });
ac.abort();
// pending 拒绝，code 是 QUERY_CANCELLED
```

命令行用 `--timeout` 覆盖这一次的 `queryTimeout`。超时的退出码是 `1`，JSON 里的 `code` 是 `QUERY_TIMEOUT`。

```bash
jsonsqlite query '{"collection":"users"}' --timeout 30 -p ./data --json
```

## explain

`db.explain(query)` 和 `jsonsqlite explain` 不扫文档。字段：

| 字段 | 含义 |
|------|------|
| `selectivity` | 估计选择率。等值索引有统计时是 `1 / 键数` |
| `indexWeight` | 索引类型权重。代价是选择率 × 权重，越小越优先 |
| `indexChoice` | `cost` 表示按代价选；`rules` 表示没有统计，退回 2.5 的规则选择 |
| `chunked` | 打开库时的 `queryChunkSize > 0` |
| `earlyStop` | 有 `limit`、没有排序、也不做全量聚合时，扫到 `offset + limit` 即停 |
| `projectionPushed` | 排序键都在投影里（或没有排序）时，投影可以提前做 |
| `stages` | `parse`、`optimize`、`indexScan`、`dataLoad`、`execute` |

没有统计时 `indexChoice` 是 `rules`，选中的索引与 2.5 相同，结果与全表过滤一致。

参数用占位符，值不写进语句文本：

```ts
const sql = 'SELECT * FROM users WHERE name = ?';
await db.run(sql, ['bo']);
```

`parseSql(sql)` 的文本里只有 `$param`，没有 `bo`。绑定在折叠之前完成。

## Advisor

`db.advise(query)` 不执行查询，也不访问网络。建议里有一条替代 JSONPath 和预估代价：

- `jsonPath`：例如 `$[?(@.age>18)]`
- `estimatedCost`：用本版的 parse、optimize、indexScan、dataLoad、execute 权重估算

```ts
const advice = db.advise({
  collection: 'users',
  filter: { age: { $gt: 18 } },
});
const alt = advice.find((item) => item.jsonPath);
```

## 分批

`queryChunkSize` 默认 `0`，一次扫完，和 2.2 一样。设成正数后按块过滤（能提前投影时也在块内投影），再排序、分页。排序在分批过滤之后。打开和关闭的文档集合一致。

```ts
const db = await open({ storagePath: './data', queryChunkSize: 2 });
const rows = await db.query({
  collection: 'users',
  filter: { age: { $gte: 0 } },
  orderBy: { name: 'asc' },
});
```

单次覆盖：`db.query(q, { chunkSize: 0 })` 关掉分批，`{ chunkSize: 8 }` 打开。

## SQL 子集

单个 `GROUP BY` 字段支持 `COUNT`、`SUM`、`AVG`、`MIN`、`MAX`。这不是完整 SQL。

```ts
const summed = await db.run(
  'SELECT city, SUM(amount) AS total FROM orders GROUP BY city',
);
```

不支持的构造会抛 `SQL_UNSUPPORTED`，消息里带构造名。例如：

```ts
await db.run('SELECT city, SUM(amount) FROM orders GROUP BY city HAVING SUM(amount) > 1');
// 消息含 HAVING

await db.run('SELECT city, COUNT(*) FROM orders GROUP BY city, name');
// 消息含 GROUP BY（多个字段）
```

`SELECT * FROM t GROUP BY city` 同样是 `SQL_UNSUPPORTED`，因为 `GROUP BY` 必须带聚合函数。

## 编译开关

配置名是 `compileFilters`，默认 `false`。默认路径不调用 `new Function`。

打开之后，只有引擎自己的白名单运算符（等值、比较、`$exists`）可以编译。用户字符串不能拼进函数体；调用 `compileUserSource` 会抛 `INVALID_CONFIG`，查询不会执行那段字符串。值通过参数数组传入。

```ts
const db = await open({ storagePath: './data', compileFilters: true });
```

`config.example.json` 里写着 `"compileFilters": false`。

## 这一版没有

B+Tree、新的列存编码、复制、Redis、GraphQL、集群、完整 SQL 方言、`READ_UNCOMMITTED`。多写者仍是显式 `writers: 'multi'`，默认单写者。

---

## 2.5 LTS-3 说明（历史）

**版本：2.5.0** · **LTS-3** · 默认单写者。

**需要多写者才升级；否则留在 LTS-2（2.2）。** 2.5 不增加功能，只冻结 2.4 已经跑绿的契约。不传 `writers` 时仍是单写者。`lts` 不会因为本版发布就改到 2.5；2.5 走 `lts-3`。从 2.2 升上来不会自动变成多写者。

| 线 | 谁应该 pin |
|----|------------|
| **LTS-2 = 2.2.x** | 单写者生产。不需要多进程写就留在这里。 |
| **LTS-3 = 2.5.x** | 同一台机器上的多进程写。默认仍是单写者。 |

```bash
# 主推荐仍是单写者
npm install @webofcat/jsonsqlite@lts
npm install @webofcat/jsonsqlite@2.2

# 需要同一台机器多进程写时才装本线
npm install @webofcat/jsonsqlite@lts-3
npm install @webofcat/jsonsqlite@2.5
```

`npm install @webofcat/jsonsqlite` 不带 tag，装到的是 `latest`（2.5.0）。默认仍是单写者。`lts` 继续指向 2.2。`lts-2` 指向 2.2。`lts-3` 指向 2.5。两条线并行维护，安全补丁两条线的公告都要看。生产 pin 仍是 `lts`（2.2）。

承诺边界：默认 single 的正确性不低于 LTS-2。`writers: 'multi'`、`SERIALIZABLE`、死锁错误码、savepoint 的文档语义在 `2.5.x` PATCH 中不缩小。PATCH 不加入复制或集群，也不新增子命令。

`formatVersion` 仍是 2。列存、分层、智能压缩、插件、大值缓存压缩、热页预取、chunk 执行、Geo 索引、中文分词**全部默认关闭**。多写者也默认关闭。

## 怎么看兼容字段

`version` 是包版本字符串。`ltsLine` 是这条二进制所属的长期支持线。两者不是同一个数。2.2 包上的同一字段是 `ltsLine: '2.2'`。本包是 `ltsLine: '2.5'`，同时 `lts: true`。

```ts
import { getCompatibilityInfo, open } from '@webofcat/jsonsqlite';

const info = getCompatibilityInfo();
// {
//   version: '2.5.0',    // 包版本。不要把它读成线名
//   formatVersion: 2,    // 与 2.2 相同，旧的 2.2 目录可以直接 open
//   lts: true,           // 本二进制是长期支持线（LTS-3）
//   ltsLine: '2.5',      // 本包所属的线。不是「建议所有人 pin 2.5」
//   writers: 'single',   // 默认开库模式。不写 writers 时第二个进程得到 LOCK_FAILED
//   cliSurface: '2.5.0', // 冻结的命令面，包含全局 --writers。PATCH 不新增子命令
// }
```

| 字段 | 含义 |
|------|------|
| `version: '2.5.0'` | 这个包的版本字符串。 |
| `lts: true` | 这个 2.5.0 包是长期支持版本，线名是 LTS-3。单写者生产仍 pin 2.2。 |
| `ltsLine: '2.5'` | 本二进制的线。2.2 包上报的是 `ltsLine: '2.2'`。 |
| `writers: 'single'` | 默认开库模式。显式 `writers: 'multi'` 才会多进程写。 |
| `cliSurface: '2.5.0'` | 稳定入口含 2.2 起的子命令，以及 2.4 的全局 `--writers single\|multi`。 |

```bash
jsonsqlite version --json
# version 2.5.0，lts true，ltsLine "2.5"，writers "single"，cliSurface "2.5.0"

jsonsqlite compat --json
# 与 getCompatibilityInfo() 相同的字段
```

默认隔离级别仍是 `READ_COMMITTED`。另一种在 single 下可用的级别是 `REPEATABLE_READ`。`READ_UNCOMMITTED` 会拒绝。single 模式下 `SERIALIZABLE` 也会拒绝。LTS-1（1.6.x）继续收安全补丁，并行窗口不少于 12 个月，或到 LTS-3（2.5）发布后 6 个月。`@webofcat/jsonsqlite@2.2.0` 是 LTS-2 的首个版本。

## 从 2.2 迁到 2.5

2.2 的库是 `formatVersion` 2，直接打开。下面每一步都不写 `writers`，所以写者模式仍是 single。

```ts
const db = await open({ storagePath: './data' });
// 第二个进程再 open 同一个目录：LOCK_FAILED
await db.close();
```

```bash
jsonsqlite doctor -p ./data --json
# writers 是 "single"，lockHolder 是 { "pid": <持有 meta/.lock 的进程> }
```

1.x（`formatVersion` 1）不能直接 `open`，先迁移。迁移本身不改写者模式，打开目标库时默认仍是 single：

```bash
jsonsqlite migrate --from ./old --to ./data --yes
jsonsqlite doctor -p ./data --json
```

```ts
import { migrateDatabase, open } from '@webofcat/jsonsqlite';

await migrateDatabase({ from: './old', to: './data', yes: true });
const db = await open({ storagePath: './data' });
await db.close();
```

只有需要同一台机器上多个进程一起写时，才显式打开 multi。不写就不会变成 multi：

```ts
const db = await open({ storagePath: './data', writers: 'multi' });
await db.close();
```

```bash
jsonsqlite --writers multi doctor -p ./data --json
```

锁的持有、崩溃后谁拥有锁、冲突时谁成功，见下一节。协议全文在 [RFC-锁协议.md](../../devDocs/releases/v2.4.0/RFC-锁协议.md)。

---

## 单写者与多写者

下面是 2.4 已经跑绿、并在 2.5.x PATCH 中不缩小的契约。锁协议全文在 [RFC-锁协议.md](../../devDocs/releases/v2.4.0/RFC-锁协议.md)。

### 两种模式

什么都不写，就是 single，和第二进程互斥：

```ts
const db = await open({ storagePath: './data' });
// 另一个进程再 open 同一个目录：错误码 LOCK_FAILED，不可重试
await db.close();
```

```bash
jsonsqlite doctor -p ./data --json
# writers 字段是 "single"
# lockHolder 字段是 { "pid": <持有 meta/.lock 的进程> }
```

显式打开多写者（库 API 和 CLI 等价，都不写就不会变成 multi）：

```ts
const db = await open({ storagePath: './data', writers: 'multi' });
await db.close();
```

```bash
jsonsqlite --writers multi doctor -p ./data --json
# writers 字段是 "multi"
# lockHolder 字段是 { "pids": [ <活着的持有者> ] }
# 已经退出的 pid 不会出现在 pids 里
```

`writers: 'single'` 与 LTS-2 相同。`config validate --file` 接受 `writers`，默认仍是 `single`。

### 崩溃之后谁持有锁

文档锁、提交锁、`meta/.lock`、`meta/holders/<pid>.json` 都只记录 pid。进程死了，这把锁**无人持有**。下一个需要它的进程删掉过期文件再获取，不会把锁过继给别的进程。已 fsync 的提交留在页上；没 fsync 的修改消失。可重试的错误是 `WRITE_CONFLICT`、`DEADLOCK`、`SERIALIZABLE_CONFLICT`（`details.retryable === true`）。`LOCK_FAILED` 不可重试，要等对方 `close`。

### 两个进程写同一个文档

1. 进程 A、B 都用 `writers: 'multi'` 打开同一目录，并都读到 `{ _id: 'doc1', _version: 1 }`。
2. 两边都 `update('docs', 'doc1', { name })`。
3. 先提交成功的那一边，文档留在库里。另一边得到 `WRITE_CONFLICT`，`details.retryable` 为 `true`。
4. 失败的一边重新 `findById`，在新的 `_version` 上再改一次，再提交。

写不同 `_id` 时两边都会成功。

### SERIALIZABLE

只在 multi 下提供。single 里 `beginTransaction('SERIALIZABLE')` 得到 `ISOLATION_UNSUPPORTED`；把 `defaultIsolation` 设成 `SERIALIZABLE` 且不写 `writers: 'multi'`，`open` 得到 `INVALID_CONFIG`。换隔离级别不会打开多写者。

```ts
const db = await open({ storagePath: './data', writers: 'multi' });
await db.beginTransaction('SERIALIZABLE');
await db.findById('docs', 'doc1');
await db.update('docs', 'doc1', { name: 'next' });
await db.commitTransaction();
```

如果另一个 multi 进程在这次 `begin` 之后提交了同一个文档，这边 `commit` 得到 `SERIALIZABLE_CONFLICT`（可重试），事务回滚，不会留下脏写。

### 死锁

`acquireDocLock(collection, id)` 按调用顺序立刻加文档锁。两个进程以相反顺序各锁两个文档时，等待图成环。**pid 较大的一方**得到 `DEADLOCK`（可重试），整个事务回滚并释放自己的锁。pid 较小的一方继续，然后提交成功。这是看等待图，不是靠超时猜的。

### savepoint

默认事务仍是一层。`beginTransaction()` 两次得到 `TX_NESTED`。savepoint 是显式 API，不是第二层 `begin`：

```ts
await db.beginTransaction();
await db.update('docs', 'a', { n: 2 });          // 外层暂存
const sp = await db.savepoint('inner');
await db.update('docs', 'a', { n: 3 });          // savepoint 内
await db.insert('docs', { _id: 'inner', n: 9 });
await db.rollbackSavepoint(sp);                  // 内层撤销
// findById('docs','a').n === 2，inner 不存在
await db.commitTransaction();                    // 外层的 n: 2 被提交
```

### 崩溃之后能看到什么

写进程在页 fsync 之前死掉：重新打开后，已提交的文档还在，这次没写完的字段不在，页里没有半个文档。fsync 完成之后再死：这次 `commit`（或自动提交）的文档还在，同一个事务里没有 `commit` 的修改不在。索引用页上的已提交文档，不会把没提交的修改算进去。

### 本版没有的东西

异步复制、Quorum、Raft、自动分片、GraphQL、多库管理、跨机锁。`writers: 'multi'` 不是 LTS。生产环境的多写者等 2.5。

---

## 默认路径，以及按表打开列存

什么都不开：

```ts
const db = await open({ storagePath: './data' });
await db.insert('orders', { _id: 'o1', sku: 'A', qty: 2 });
const rows = await db.query({ collection: 'orders', projection: ['sku'] });
// lastPlan().source === 'document'
// columnStoreStatus('orders').enabled === false
await db.close();
```

文档仍写在分页文件里，查询会读文档页。这和 LTS-2 相同。

按表打开列存（两种方式等价，都要指名表）：

```ts
const db = await open({
  storagePath: './data',
  columnCollections: ['orders'],
});
// 或者在已经 open 的库上：
await db.enableColumnStore('orders');
await db.flushColumnStore('orders'); // 等到这一代表重建结束

const rows = await db.query({
  collection: 'orders',
  projection: ['sku'],
});
// rows 与 { column: false } 的投影结果相同
// lastPlan().source === 'column'
await db.close();
```

- 写入仍先落到 WAL，再进入页文件。列存是派生物，不是提交事实来源。
- `enableColumnStore` 立刻返回，重建在后台进行。重建期间 `columnStoreStatus(table).ready` 为 false，查询自动改走文档页，结果仍然正确。
- `flushColumnStore(table)` 等到当前这一轮重建结束。
- 投影查询只读用到的列，加上行键文件 `rowkey.json`（`_id`、`_version`、`_createdAt`、`_updatedAt`）。过滤和排序用到的字段也会读，返回前再按 `projection` 裁掉。
- 列文件还没就绪、校验和不符、或某个字段不在清单里时，这次查询退回文档页。退回不是错误。

对照（功能测试 `FT-V23-COL-01`，不是生产耗时承诺）：`pageSize: 4`、16 条文档、只投影一个用户字段。列存读 2 个列文件（行键 + 该字段），文档模式读 4 个数据页。同一组结果深度相等。没有单独的毫秒基准。

列存重建被打断时，已提交的数据以 WAL 为准。把 `collections/<表>/columns/manifest.json` 写成 `ready: false` 或截断列文件后再次 `open`，查询仍返回 WAL 重放出来的文档，不会采用半截列文件。`FT-V23-COL-02` 覆盖了「WAL 已写入、页文件还没刷盘、列清单被拆掉」这一种崩溃。

---

## 热 / 温 / 冷

1.8 的 `tiering: true` 仍是实验旗标：只在 `close()` 时把低访问文档扫进 `cold.jsonl`。2.3 **默认保持 `tiering: false`**。新布局是另一个开关。

| 1.8 / 2.2 | 2.3 |
|-----------|-----|
| `tiering: true` | 保持 `false`，除非你还要旧的 close 扫冷行为 |
| `tierColdAfter` | 改填 `coldAfter`（默认 0） |
| 没有温层 | `warmAfter`（默认 1）。访问次数 `<= coldAfter` 进冷层；高于冷层且 `<= warmAfter` 进温层；更高的留在热层（页缓存） |

从带 `cold.jsonl` 的 1.8 库迁到这个布局：

1. 停掉占用该目录的进程，复制一份备份。
2. 若当时开过 `tiering: true`，先用 **1.8** 的程序执行 `open({ storagePath, tiering: false })` 然后 `close()`，让 `cold.jsonl` 回到热数据。2.3 对 `formatVersion: 1` 会抛 `MIGRATION_REQUIRED`，不能用来做这一步。
3. 按 [2.2 迁移指南](https://github.com/Core10900/json-sqlite/blob/main/devDocs/releases/v2.2.0/迁移指南.md) 把库迁到 format 2。
4. 用 2.3 打开，并显式加上新开关：

```ts
const db = await open({
  storagePath: './data-v2',
  tiering: false,
  storageTiers: true,
  coldAfter: 0,
  warmAfter: 1,
});
```

后台定时器约每秒跑一轮迁移，`insert` / `update` / `delete` **不会等待**这一轮。需要当场做完时调用 `await db.migrateTiersOnce()`。`FT-V23-TIER-01` 在冷层钩子被挡住时仍能完成一次 `insert`。

没有存储插件时，冷、温副本写在：

```text
collections/<表>/tiers/cold.jsonl
collections/<表>/tiers/warm.jsonl
```

库若开了 `encryptionKey`，这两份文件用同一把密钥加密。

冷层接到存储插件：注册一个 `kind: 'storage'` 且带 `putCold` 的插件。迁移时会调用它。插件抛错只记入 `pluginErrors()`，文档仍写入本地冷文件，查询继续。读的时候，若冷/温副本的 `_version` 不低于页里的文档，`findById` 返回副本，并在 `tierSummary().coldReads` / `warmReads` 上计数。更新过的文档以页里的新版本为准。

```ts
db.registerPlugin({
  kind: 'storage',
  name: 'cold-disk',
  version: '1.0.0',
  async putCold(collection, doc) {
    // 这里接你自己的冷存储。抛错不会让 insert 失败。
  },
});
await db.migrateTiersOnce();
const summary = db.tierSummary();
// summary.enabled === true，summary.cold 是本轮放进冷层的文档数
```

`storageTiers` 关闭时调用 `migrateTiersOnce()` 会抛 `INVALID_CONFIG`。

---

## 智能压缩

默认关闭。2.2 的 `compression: true` 仍是「超过 `compressionThreshold` 就 gzip」，行为不变。2.3 的多算法开关是 `smartCompression: true`（不要两个同时当同一条策略用；同时打开时智能压缩优先）。

| 算法 | 用在什么数据上 | 块头 |
|------|----------------|------|
| `delta` | 长度至少 4 的有限数字数组 | `JSQB1\|delta\|` |
| `dict` | 字符串数组，且不同值不超过长度的 25% | `JSQB1\|dict\|` |
| `rle` | 字符串数组里有长串重复，但基数又不够进字典 | `JSQB1\|rle\|` |
| `gzip` | 普通对象、长文本，以及上面三种还原失败时的退路 | `JSQB1\|gzip\|` |

选择由值的形状决定，调用方不用指定算法。块头里的算法名会在下次打开时被认出来：看到 `JSQB1|` 就按竖线后的名字还原，不以「这次 open 有没有打开 smartCompression」为准。

和加密叠在一起时的顺序是：**先压缩，再加密**。读取时先解密，再按块头解压。这和 2.2「先 gzip 再 AES」的顺序一致。

```ts
const db = await open({
  storagePath: './data',
  smartCompression: true,
  encryptionKey: 'secret',
});
await db.insert('docs', { _id: 'e', name: '密文', values: [1, 2, 3, 4, 5] });
await db.close();

const again = await open({
  storagePath: './data',
  smartCompression: true,
  encryptionKey: 'secret',
});
await again.findById('docs', 'e'); // name 仍是「密文」
```

往返失败时调用方看到的是 `JSONSQLiteError`：

- 写入前会自己还原一次。首选算法对不上原始字节时改用 gzip。gzip 仍失败则抛 `DATA_CORRUPT`，坏块不会落盘。
- 读到块头合法但载荷还原失败（或页里被改坏）时抛 `DATA_CORRUPT`。`open` 的页校验会因此拒绝打开，不会把坏行当成空文档。
- 密文本身损坏或密钥不对，抛的是 `ENCRYPTION`，不是 `DATA_CORRUPT`。

`FT-V23-CMP-01` 覆盖四种算法的字节级还原，以及加密开、关两条存储往返。

---

## 索引合并

`index compact` 合并的是**分段文件**，不是删索引。合并后内存里的倒排表还在，查询结果不变；再次 `open` 会命中带 `merged: true` 的那一个分段。

默认仍是 2.2 的单文件分段（`indexDeltaSegments: false`）。要让更新追加分段而不是覆盖同一个文件，打开：

```ts
const db = await open({ storagePath: './data', indexDeltaSegments: true });
await db.createIndex('users', 'name', 'object');
const merged = await db.compactIndexes('users');
// merged.indexes 含 'users:name'，merged.partsMerged 是合并前的分段数
```

命令行（非 TTY 可以直接跑，不提问）：

```bash
jsonsqlite index create users name --type object -p ./data
jsonsqlite index compact users -p ./data --json
```

省略表名时合并当前库里的全部分段。`index rebuild` 仍然是按文档重建，和 compact 不是一回事。

---

## 缓存与热页预取

大缓存值压缩默认关闭。打开后，JSON 字节数达到 `cacheCompressionThreshold`（默认 4096）的查询结果会 gzip 后再放进 L1。命中时返回原来的文档，不是压缩包。

```ts
const db = await open({
  storagePath: './data',
  cacheCompression: true,
  cacheCompressionThreshold: 4096,
});
await db.insert('docs', { _id: 'a', blob: '寒'.repeat(5000) });
await db.query({ collection: 'docs' });
const again = await db.query({ collection: 'docs' });
// again[0].blob 与写入的字符串相同
db.getMetrics().cacheCompression;
// { enabled: true, threshold: 4096, compressedSets: 1 }
// 第二次查询 lastPlan().source === 'cache'
```

压缩自检失败时抛 `DATA_CORRUPT`，这次查询不会返回半截文档。

热页预取默认关闭。`prefetchPages: true` 时，一次页缺失会尝试把下一页读进缓存。计数在 `prefetchStats()`：

```ts
db.prefetchStats();
// { enabled: true, hits: 0, fallbacks: 0 }
```

- `hits`：后来的按需读用上了刚才预取进缓存的页。
- `fallbacks`：下一页不在目录里，或预取读失败。
- 预取失败**不是错误**。当前这次 `findById` / 查询照常返回，之后的页仍按需读。

---

## 插件

五类：`index`、`storage`、`compression`、`backup`、`queryLanguage`。注册在进程内完成，不从网络安装。

```ts
db.registerPlugin({
  kind: 'queryLanguage',
  name: 'boom',
  version: '1.0.0',
  onQuery() {
    throw new Error('plugin exploded');
  },
});
const rows = await db.query({ collection: 'users' });
// rows 仍是原来的文档
db.pluginErrors();
// [{ name: 'boom', kind: 'queryLanguage', message: 'plugin exploded', at: ... }]
```

名称必须匹配 `^[a-z][a-z0-9_-]{0,63}$`，版本必须是 `主.次.补`（可带 semver 的预发布后缀）。名字、版本或 `kind` 不合法时 `registerPlugin` 抛 `INVALID_CONFIG`，插件不会登记，已经 open 的库继续能查。重复登记同一个 `kind + name` 同样抛 `INVALID_CONFIG`。

钩子抛错被隔离：记入 `pluginErrors()`，不会变成查询失败。上面的 `onQuery` 就是隔离之后的调用方式。

vector 和 S3 **只是可调用的 stub**，不是可用实现。可用的向量检索计划在 **3.4+**，可用的 S3 冷存储计划在 **3.4**。

```ts
import { createS3Stub, createVectorStub } from '@webofcat/jsonsqlite';

const vector = createVectorStub();
const s3 = createS3Stub();
db.registerPlugin(vector);
db.registerPlugin(s3);

const found = await db.vectorSearch('docs', [0.1, 0.2]);
// { hits: [], stub: true, availableIn: '3.4', called: true, collection: 'docs' }
// vector.calls === 1。hits 永远是空的，不能用来做近邻检索。

await db.migrateTiersOnce();
// s3.calls 增加。putCold 只计数，不会上传对象。文档仍在本地冷文件里。
```

没注册就调用 `vectorSearch` 会抛 `INVALID_CONFIG`，文案会说明 stub 不是可用向量索引。

命令只查看内置目录，不会远程安装：

```bash
jsonsqlite plugin list --json
jsonsqlite plugin info vector --json
jsonsqlite plugin info s3 --json
```

`plugin info vector` 的 `stub` 为 true，`availableIn` 为 `"3.4"`。`s3` 的 `availableIn` 为 `"3.4"`。本版不会实际上传对象。

---

## 大结果的 chunk 执行

`queryChunkSize` 默认 **0**：整表一次过滤、排序、分页、投影，和 2.2 相同。

设为大于 0 的整数后，**没有走索引的扫描**会按这个大小分块过滤，再对合在一起的命中做一次排序、分页和投影。索引已经把候选 id 收窄时，不再拆块。

```ts
const once = await db.query({ collection: 'nums', orderBy: { n: 'asc' }, projection: ['n'] });
const chunked = await db.query(
  { collection: 'nums', orderBy: { n: 'asc' }, projection: ['n'] },
  { chunkSize: 2 },
);
// chunked 与 once 深度相等
// lastPlan().chunked === true，lastPlan().chunks 是块数
```

单次选项 `chunkSize: 0` 强制走整表一次，不受 open 时的 `queryChunkSize` 影响。文档数不超过块大小时 `chunked` 为 false，因为实际只跑了一块。`FT-V23-EXE-01` 用 5 条文档和 `chunkSize: 2`，得到 3 块，结果与非 chunk 相同。

---

## GeoIndex 与中文分词

两者都是可选的。默认 `open` 不会加载 Geo 专用逻辑以外的索引，也不会加载任何分词依赖。

点可以写成 `{ lat, lon }`、`{ latitude, longitude }`、GeoJSON `{ type: 'Point', coordinates: [lon, lat] }`，或裸数组 `[lon, lat]`（GeoJSON 顺序，经度在前）。

没建索引时，`$geoWithin` 扫描全表，结果与建了索引之后相同。`lastPlan().usedIndex` 为空说明这次是扫描。框不合法（缺边或不是有限数字）抛 `INVALID_CONFIG`。

```ts
await db.insert('places', { _id: 'in', loc: { lat: 31.2, lon: 121.5 } });
await db.insert('places', { _id: 'out', loc: { lat: 39.9, lon: 116.4 } });

const box = { minLat: 30, minLon: 120, maxLat: 32, maxLon: 122 };
await db.query({ collection: 'places', filter: { loc: { $geoWithin: box } } });
// 只有 _id === 'in'。此时没有索引。

await db.createIndex('places', 'loc', 'geo');
await db.query({ collection: 'places', filter: { loc: { $geoWithin: box } } });
// 仍然只有 'in'。lastPlan().usedIndex === 'geo:loc'
```

```bash
jsonsqlite index create places loc --type geo -p ./data --json
```

中文分词默认关闭（`chineseTokenizer: 'none'`）。不传 `tokenizerModule` 时，`open` 不会去 `import` 任何分词包。

缺依赖时打开仍然成功。下面这个包并不存在：

```ts
const db = await open({
  storagePath: './data',
  tokenizerModule: 'jsonsqlite-cjk-tokenizer-missing',
});
db.tokenizerStatus();
// { available: false, name: null, reason: 'module-not-found' }
await db.query({ collection: 'users', filter: { name: '寒' } });
// 等值查询可用。不可用的是依赖分词器的全文切分。
```

内置 bigram 不需要额外依赖，必须显式打开。它把连续汉字切成两字词，英文单词保持整词：

```ts
import { createBigramTokenizer } from '@webofcat/jsonsqlite';

const db = await open({
  storagePath: './data',
  chineseTokenizer: 'bigram',
});
// 也可以：await db.registerTokenizer(createBigramTokenizer())
await db.insert('notes', { _id: 'n1', text: '欢迎使用数据库引擎' });
await db.createIndex('notes', 'text', 'inverted');
await db.query({ collection: 'notes', filter: { text: { $contains: '数据库' } } });
// 命中 n1。默认分词器不会把这句切词，同样的查询命中为空。
```

分词器名字和版本用与插件相同的规则校验。校验失败抛 `INVALID_CONFIG`，库仍然开着。

---

## CLI

命令面在本线冻结，包含全局 `--writers`。`2.5.x` PATCH 不新增子命令。2.2 起的稳定命令没有改名，也没有删掉。

读者会用到的稳定入口：

| 入口 | 作用 |
|------|------|
| `create` / `init` | 建库。不传 `--writers` 时是 single |
| `insert` / `update` / `delete` / `get` / `count` | 行读写 |
| `run` / `sql` / `query` | SQL 与 JSON 查询 |
| `tables` / `table` | 表 |
| `index` | 索引，含 `index rebuild`、`index compact` |
| `backup` / `vacuum` / `rekey` / `migrate` / `doctor` | 运维。`doctor` 的 JSON 含 `writers` 与 `lockHolder` |
| `config validate --file` | 校验配置文件，不打开数据库 |
| `version --json` / `compat` | 打印兼容信息，能区分 `ltsLine: "2.5"` |
| `--writers single\|multi` | 全局 flag，默认 `single` |

全局 flag 还有 `-p/--path`、`-y/--yes`、`--json`、`-q/--quiet`、`-h/--help`。退出码仍是 `0` 成功、`1` 用法或业务、`2` 系统/IO、`3` 锁失败。

```bash
jsonsqlite version --json
jsonsqlite --writers multi doctor -p ./data --json
jsonsqlite plugin list --json
jsonsqlite index compact places -p ./data --json
```

这些命令在非 TTY 下不提问。`plugin list` / `plugin info` 不打开数据库，也不安装远程插件。

`config validate --file` 接受 `config.example.json` 里的 2.2 字段，也接受已经落地的可选字段：`writers`（`single` 或 `multi`，默认 `single`），2.3 的 `columnStore`、`columnCollections`、`storageTiers`、`coldAfter`、`warmAfter`、`smartCompression`、`indexDeltaSegments`、`cacheCompression`、`cacheCompressionThreshold`、`prefetchPages`、`queryChunkSize`、`chineseTokenizer`、`tokenizerModule`，以及 3.1 的 `bTreeOrder`（默认 128）、`storageAdvise`（默认 false）、`hybridCollections`、`hybridFields`、`coldExternalDir`、`compressionSampleWindow`（默认 64）、`stopWords`。不写这些键就不会打开对应能力，存储格式保持 3.0。`cluster`、`replica`、`raft`、`l3`、`redis`、`cache`（嵌套对象；冻结字段是 `cacheSize`）、`savepoint`（这是库 API，不是配置键）、`graphql`、`wasm` 会拒绝且不生效，退出码 1，`INVALID_CONFIG`。

---

## 这一版没有的东西

- 文档页格式升级。`formatVersion` 仍是 2。新存储不写配置时不会打开。
- 复制、集群、自动选主、Redis。
- GraphQL、Raft、WASM。
- 可用的向量检索。`vectorSearch` 和 `createVectorStub()` 只证明钩子能被调用，命中列表为空。可用实现在 3.4+。
- 可用的 S3 上传。`createS3Stub()` 只计数，不传对象。可用实现在 3.4。

需要多写者才升级；否则留在 LTS-2。

## 许可

MIT
