# JSONSQLite

**版本：1.0.0** · **运行时：Node.js ≥ 20** · **包名：`@jsonsqlite/core`**

JSONSQLite 是一个面向 Node.js 后端的 **JSON 原生嵌入式数据库**：以 JSON/JSONL 文件为存储载体，提供文档 CRUD、查询、索引、事务、WAL 崩溃恢复、备份与运维能力。通过 `npm install` 装进业务工程后，在进程内打开本地数据目录即可使用——角色类似 better-sqlite3，而不是必须单独部署的网络数据库服务。

```text
业务后端（Express / Nest / Fastify / …）
        │  npm i @jsonsqlite/core
        ▼
   进程内引擎 + 本地 ./data 目录
```

---

## 目录

- [1. 能做什么](#1-能做什么)
- [2. 环境与安装](#2-环境与安装)
- [3. 快速开始](#3-快速开始)
- [4. 打开与关闭](#4-打开与关闭)
- [5. 集合与文档 CRUD](#5-集合与文档-crud)
- [6. JSON 查询](#6-json-查询)
- [7. 索引](#7-索引)
- [8. 聚合与 JSONPath](#8-聚合与-jsonpath)
- [9. 事务](#9-事务)
- [10. 备份与恢复](#10-备份与恢复)
- [11. 时间旅行](#11-时间旅行)
- [12. 监控、健康检查与建议](#12-监控健康检查与建议)
- [13. HTTP Admin 与事件订阅](#13-http-admin-与事件订阅)
- [14. CLI：jsql](#14-clijsql)
- [15. 配置项](#15-配置项)
- [16. 数据目录结构](#16-数据目录结构)
- [17. 使用限制与最佳实践](#17-使用限制与最佳实践)
- [18. 本仓库开发](#18-本仓库开发)
- [19. 更多文档](#19-更多文档)
- [License](#license)

---

## 1. 能做什么

| 能力 | 说明 |
|------|------|
| **嵌入式库** | `import { open } from '@jsonsqlite/core'`，无需独立 DB 进程 |
| **文档存储** | 动态 Schema，集合（collection）即「表」 |
| **JSON Query** | 过滤 / 投影 / 排序 / 分页 |
| **三类索引** | 等值（object）、范围（tree）、全文（inverted） |
| **查询规划** | 有索引时优先走索引，写路径增量维护 |
| **L1 缓存** | 查询结果 LRU 缓存，写入自动失效 |
| **WAL** | 预写日志 + 启动重放，支撑崩溃恢复 |
| **事务** | 单层 begin / commit / rollback（默认 READ_COMMITTED） |
| **聚合管道** | match / group / sort / limit / project |
| **JSONPath** | 安全子集（如 `$.field`） |
| **备份** | 全量 / 增量；可选 AES-256-GCM |
| **时间旅行** | 按时间点查询、差异对比、回滚 |
| **可观测** | health、metrics、慢查询记录、QueryAdvisor |
| **运维入口** | CLI `jsql`、可选 localhost HTTP Admin |

**相对传统 SQLite 的定位差异（不是性能全面替代）**：JSON 第一公民、动态 Schema、内置监控/Admin/时间旅行等开发与运维体验；适合中小型后端、配置中心、本地工具、快速迭代场景。

---

## 2. 环境与安装

### 要求

- Node.js **≥ 20**
- 支持 ESM `import` 与 CJS `require`（双格式发布）
- TypeScript 类型开箱即用（附带 `.d.ts`）

### 安装（业务项目）

```bash
npm install @jsonsqlite/core
# 或
pnpm add @jsonsqlite/core
# 或
yarn add @jsonsqlite/core
```

> 若当前尚未发布到 npm 公网，可在本 monorepo 内用 `workspace:` 依赖，或 `pnpm pack` 后本地安装 tarball。

### 从本仓库本地联调

```bash
pnpm install
pnpm build
# 在其他项目：pnpm add /path/to/json-sqlite/packages/core
```

---

## 3. 快速开始

```ts
import { open } from '@jsonsqlite/core';

const db = await open({ storagePath: './data' });

// 写入
await db.insert('users', { name: '寒', age: 30, tags: ['vip'] });

// 建索引（可选，加速过滤）
await db.createIndex('users', 'age', 'tree');

// 查询
const rows = await db.query({
  collection: 'users',
  filter: { age: { $gte: 18 } },
  orderBy: { age: 'desc' },
  limit: 20,
});

console.log(rows);

// 进程退出前务必关闭
await db.close();
```

CommonJS：

```js
const { open } = require('@jsonsqlite/core');

(async () => {
  const db = await open({ storagePath: './data' });
  // ...
  await db.close();
})();
```

---

## 4. 打开与关闭

### `open(options)` / `new JSONSQLite(options).open()`

```ts
import { open, JSONSQLite } from '@jsonsqlite/core';

const db = await open({
  storagePath: './data',   // 必填：数据目录
  walMode: true,           // 默认 true
  cacheSize: 1000,         // L1 缓存条目数
});

// 或分步：
const db2 = new JSONSQLite({ storagePath: './data' });
await db2.open();
```

打开时会：创建目录结构 → 获取文件锁 → 加载 catalog → 重放 WAL → 加载索引元数据。

### `close(opts?)`

```ts
await db.close();                 // 刷盘快照后释放锁
await db.close({ flush: false }); // 仅测试/模拟崩溃用，生产勿用
```

建议挂到框架生命周期：

```ts
process.on('SIGINT', async () => {
  await db.close();
  process.exit(0);
});
```

### 事件

```ts
db.on('ready', () => console.log('ready'));
db.on('close', () => console.log('closed'));
db.on('dataChanged', (e) => console.log('changed', e));
```

---

## 5. 集合与文档 CRUD

集合名在首次写入时会自动创建，也可显式管理：

```ts
await db.createCollection('orders');
const list = await db.listCollections();
```

### 系统字段

每条文档自动包含：

| 字段 | 说明 |
|------|------|
| `_id` | 主键（可自带；否则自动生成） |
| `_version` | 乐观锁版本，从 1 递增 |
| `_createdAt` / `_updatedAt` | 毫秒时间戳 |

### 写入 API

```ts
// 单条 / 批量插入
const doc = await db.insert('users', { name: 'Alice', age: 22 });
const docs = await db.insert('users', [
  { name: 'Bob', age: 35 },
  { name: 'Carol', age: 28 },
]);

// 按 _id 更新（可选期望版本）
await db.update('users', doc._id, { age: 23 });
await db.update('users', doc._id, { age: 24 }, { expectedVersion: 2 });

// 删除
await db.delete('users', doc._id);

// 存在则更新，否则插入（需提供 _id 才能命中更新）
await db.upsert('users', { _id: doc._id, name: 'Alice', age: 25 });

// 点查
const one = await db.findById('users', doc._id);
```

版本冲突时抛出 `JSONSQLiteError`，`code === 'VERSION_CONFLICT'`。

---

## 6. JSON 查询

```ts
import type { JsonQuery } from '@jsonsqlite/core';

const q: JsonQuery = {
  collection: 'users',
  filter: {
    age: { $gte: 18, $lte: 40 },
    name: { $contains: 'A' },
  },
  projection: ['name', 'age'], // 另会保留系统字段
  orderBy: { age: 'desc' },
  limit: 50,
  offset: 0,
};

const rows = await db.query(q);
```

### 过滤器运算符

| 运算符 | 含义 |
|--------|------|
| 直接等值 / `$eq` | 相等 |
| `$ne` | 不等 |
| `$gt` `$gte` `$lt` `$lte` | 比较 |
| `$in` `$nin` | 属于 / 不属于集合 |
| `$contains` | 字符串包含（可配合倒排索引） |
| `$exists` | 字段是否存在 |
| `$and` `$or` | 逻辑组合 |

嵌套字段可用点路径，例如：`filter: { 'profile.city': 'SH' }`。

---

## 7. 索引

```ts
// type: 'object' | 'tree' | 'inverted'
await db.createIndex('users', 'city', 'object');   // 等值
await db.createIndex('users', 'age', 'tree');      // 范围
await db.createIndex('posts', 'title', 'inverted'); // 全文分词

console.log(await db.listIndexes());
await db.dropIndex('users', 'city');
```

| 类型 | 适合场景 | 查询形态 |
|------|----------|----------|
| `object` | 低基数字段等值 | `{ city: 'SH' }` / `$eq` |
| `tree` | 有序数值/字符串范围 | `$gte` / `$lte` 等 |
| `inverted` | 文本检索 | `$contains` |

查询规划器会在「单字段过滤」且存在对应索引时优先走索引，再套用其余 filter / sort / limit。

---

## 8. 聚合与 JSONPath

### 聚合管道

```ts
const result = await db.aggregate('orders', [
  { type: 'match', filter: { amount: { $gte: 10 } } },
  {
    type: 'group',
    by: 'city',
    fields: {
      total: { op: 'sum', field: 'amount' },
      n: { op: 'count' },
      avg: { op: 'avg', field: 'amount' },
    },
  },
  { type: 'sort', orderBy: { total: 'desc' } },
  { type: 'limit', limit: 10 },
]);
```

支持的 stage：`match` | `group` | `sort` | `limit` | `project`  
聚合算子：`sum` | `avg` | `min` | `max` | `count` | `push`

### JSONPath（安全子集）

```ts
const names = await db.jsonPath('users', '$.name');
const ages = await db.jsonPath('users', '$[*].age');
```

不支持脚本表达式与 `..` 递归，以避免注入风险。

---

## 9. 事务

```ts
const txId = await db.beginTransaction(); // 默认 READ_COMMITTED
try {
  await db.insert('accounts', { name: 'A', balance: 100 });
  await db.insert('accounts', { name: 'B', balance: 0 });
  await db.commitTransaction(txId);
} catch (e) {
  await db.rollbackTransaction(txId);
  throw e;
}
```

注意：

- **不支持嵌套事务**（再次 `begin` 会报 `TX_NESTED`）
- 事务内写操作先落内存，`commit` 时持久化；`rollback` 恢复快照
- 同一 `storagePath` 同时只允许一个写进程（文件锁）

---

## 10. 备份与恢复

```ts
// 全量备份 → data/backups/full_*.bak
const full = await db.backupFull();
console.log(full.file, full.checksum);

// 增量（基于变更日志；无变更时可能返回 null）
const inc = await db.backupIncremental();

// 从全量备份恢复（覆盖对应集合）
await db.restoreBackup(full.file);
```

可选加密：配置 `encryptionKey` 或环境变量 `JSONSQLITE_KEY` 后，备份内容使用 AES-256-GCM。

---

## 11. 时间旅行

依赖写入时追加的 ChangeLog（`deltas/`）：

```ts
const t0 = Date.now();
await db.insert('users', { name: 'v1' });
// ... 后续更新 ...

// 查询某一时刻的数据视图
const past = await db.queryAtTime('users', t0, {
  filter: { name: { $exists: true } },
});

// 两个时间点之间的差异
const diff = await db.diffBetweenTimes('users', t0, Date.now());
// { added, removed, modified }

// 危险：将集合回滚到历史时间点（会改写当前数据）
await db.rollbackToTime('users', t0);
```

---

## 12. 监控、健康检查与建议

```ts
const health = await db.health();
// { status: 'healthy' | 'degraded', checks: {...}, timestamp }

const metrics = db.getMetrics();
// queriesTotal / writesTotal / cacheHitRate / recentSlow / memory ...

// 查询建议（例如缺少索引时提示建索引）
const advice = db.advise({
  collection: 'users',
  filter: { age: { $gte: 18 } },
});

// 数据质量（完整度等）
const quality = db.analyzeQuality('users', ['name', 'age']);
```

错误类型：

```ts
import { JSONSQLiteError, ErrorCode } from '@jsonsqlite/core';

try {
  await db.update('users', 'missing', { x: 1 });
} catch (e) {
  if (e instanceof JSONSQLiteError) {
    console.error(e.code, e.message); // 如 DOCUMENT_NOT_FOUND
  }
}
```

常见 `ErrorCode`：`NOT_READY`、`LOCK_FAILED`、`VERSION_CONFLICT`、`TX_NESTED`、`COLLECTION_NOT_FOUND` 等。

---

## 13. HTTP Admin 与事件订阅

### 启动管理端（默认仅本机）

```ts
await db.startServer({
  host: '127.0.0.1',
  port: 3000,
  adminToken: 'change-me', // 建议生产必填
});
```

| 路径 | 说明 |
|------|------|
| `GET /health` | 健康检查 |
| `GET /admin` | 简易管理页（指标 + 查询台） |
| `GET /admin/metrics` | 指标 JSON |
| `POST /query` | body 为 JsonQuery |

带 Token 时请求头：`Authorization: Bearer <token>`。

### 变更订阅

```ts
const unsubscribe = db.subscribe((event) => {
  console.log('dataChanged', event);
});
// ...
unsubscribe();
```

---

## 14. CLI：`jsql`

构建产物提供二进制（`packages/core` 的 `bin`）：

```bash
# 本仓库内
pnpm --filter @jsonsqlite/core build
node packages/core/dist/cli.js doctor --path ./data
node packages/core/dist/cli.js collections --path ./data
node packages/core/dist/cli.js query '{"collection":"users","limit":5}' --path ./data
node packages/core/dist/cli.js backup --path ./data
```

也可用环境变量：`JSONSQLITE_PATH=./data`。

| 命令 | 作用 |
|------|------|
| `doctor` | 打印 health，非 healthy 时 exit 1 |
| `query <json>` | 执行 JSON 查询 |
| `backup` | 全量备份 |
| `collections` | 列出集合 |

---

## 15. 配置项

```ts
interface JSONSQLiteOptions {
  storagePath: string;           // 必填
  walMode?: boolean;             // 默认 true
  defaultIsolation?: IsolationLevel; // 默认 READ_COMMITTED
  queryTimeout?: number;         // 默认 30000（预留）
  cacheSize?: number;            // 默认 1000
  encryptionKey?: string | null; // 或环境变量 JSONSQLITE_KEY
}
```

---

## 16. 数据目录结构

打开 `storagePath` 后大致布局：

```text
data/
├── meta/
│   ├── catalog.json      # 集合目录
│   ├── indexes.json      # 索引元数据
│   └── .lock             # 单写者文件锁
├── collections/
│   └── {name}/docs/data.jsonl
├── wal/                  # 预写日志
├── deltas/               # 变更日志（备份增量 / 时间旅行）
└── backups/              # 备份文件与 manifest
```

容器部署时请将 `storagePath` 挂到**持久卷**，不要只写在可丢弃的容器层。

---

## 17. 使用限制与最佳实践

1. **单写者**：同一 `storagePath` 同时只能有一个进程持有写锁；第二进程 `open` 会得到 `LOCK_FAILED`。
2. **不是共享网络库**：多实例水平扩展不要多进程直连同一目录写；需要共享请自建单写者服务或等待后续复制能力。
3. **进程退出要 `close()`**：确保刷盘与释放锁。
4. **事务不嵌套**：一次只开一个事务。
5. **Admin 默认绑定 127.0.0.1**：公网暴露必须加 Token / 反代鉴权。
6. **磁盘格式**：当前 `formatVersion = 1`；破坏性变更将走 major 版本。

---

## 18. 本仓库开发

本仓库为 pnpm monorepo：

```text
packages/core     → 可发布的 @jsonsqlite/core
apps/examples     → 示例
apps/bench        → 基准
docs/             → 设计与计划文档
```

```bash
pnpm install
pnpm test                 # 单元 / 集成测试
pnpm build                # 产出 dist（esm + cjs + dts + cli）
pnpm pack:smoke           # 打包安装冒烟
pnpm --filter @jsonsqlite/example-basic start
pnpm --filter @jsonsqlite/bench start
```

---

## 19. 更多文档

| 文档 | 内容 |
|------|------|
| [packages/core/README.md](./packages/core/README.md) | npm 包简版说明 |
| [CHANGELOG.md](./CHANGELOG.md) | 版本变更 |
| [docs/v1.0 开发计划.md](./docs/v1.0%20开发计划.md) | v1.0 开发计划 |
| [docs/v1.0 功能测试计划.md](./docs/v1.0%20功能测试计划.md) | 功能测试计划 |
| [docs/JSONSQLite 技术实现方案与计划.md](./docs/JSONSQLite%20技术实现方案与计划.md) | 架构与实现方案 |
| [docs/JSONSQLite npm包与后端接入说明.md](./docs/JSONSQLite%20npm包与后端接入说明.md) | 包契约与后端嵌入规范 |
| [docs/JSONSQLite 生产级实现大纲.md](./docs/JSONSQLite%20生产级实现大纲.md) | 能力大纲 |
| [docs/JSONSQLite vs SQLite - 超越的可能性.md](./docs/JSONSQLite%20vs%20SQLite%20-%20超越的可能性.md) | 差异化方向 |

---

## License

MIT — 见 [LICENSE](./LICENSE)。
