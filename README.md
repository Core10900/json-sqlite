# JSONSQLite

**版本：2.1.0**（非 LTS） · **LTS pin：1.6.x** · **运行时：Node.js ≥ 20** · **包名：`@webofcat/jsonsqlite`**

JSONSQLite 是一个面向 Node.js 后端的 **JSON 原生嵌入式数据库**：以 JSON/JSONL 文件为存储载体，提供文档 CRUD、查询、索引、事务、WAL 崩溃恢复、备份与运维能力。既可 `npm install` 嵌入业务进程，也可 **`npm i -g` 全局安装**，用 `jsonsqlite` 管理表 / 跑 SQL。

### 权威文档（1.6 LTS）

| 文档 | 受众 |
|------|------|
| **[`API.md`](./API.md)** | Node 后端：全部稳定 `import` API |
| **[`CLI-API.md`](./CLI-API.md)** | CLI / 运维：命令面冻结自 **1.5.5** |

**LTS 政策（摘要）**

| 线 | 版本 | 说明 |
|----|------|------|
| **LTS-1** | `1.6.x`（当前） | 单写者契约冻结；仅安全/正确性补丁；不扩张 CLI |
| **LTS-2** | `2.2.x`（规划） | 2.x 首个推荐长期 pin |
| **LTS-3** | `3.0.x`（规划） | 设计采纳能力完工（Vision Complete） |

完整路线与能力勾选见 [ROADMAP](./devDocs/releases/ROADMAP.md) / [FEATURE-MATRIX](./devDocs/releases/FEATURE-MATRIX.md)。

```text
# 嵌入业务
业务后端 ── npm i @webofcat/jsonsqlite ──► import { open, create, init }; db.run(sql)

# 全局 CLI
npm i -g @webofcat/jsonsqlite
jsonsqlite --version
jsonsqlite table create --path ./my-db    # 对话式建表
jsonsqlite run "SELECT * FROM users" --path ./my-db
```

---

## 目录

- [1. 能做什么](#1-能做什么)
- [2. 环境与安装](#2-环境与安装)
- [2.1 全局 CLI 安装](#21-全局-cli-安装)
- [3. 快速开始](#3-快速开始)
- [3.1 create / init API](#31-create--init-api)
- [3.2 表管理与 SQL（`run`）](#32-表管理与-sqlrun)
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
- [14. CLI：`jsonsqlite`](#14-clijsonsqlite)
- [15. 配置项](#15-配置项)
- [16. 数据目录结构](#16-数据目录结构)
- [17. 使用限制与最佳实践](#17-使用限制与最佳实践)
- [18. 本仓库开发](#18-本仓库开发)
- [19. 更多文档](#19-更多文档)
- [License](#license)

---

## 1. 能做什么

| 能力           | 说明                                                        |
| -------------- | ----------------------------------------------------------- |
| **嵌入式库**   | `import { open } from '@webofcat/jsonsqlite'`，无需独立 DB 进程 |
| **文档存储**   | 动态 Schema，集合（collection）即「表」                     |
| **JSON Query** | 过滤 / 投影 / 排序 / 分页                                   |
| **三类索引**   | 等值（object）、范围（tree）、全文（inverted）              |
| **查询规划**   | 有索引时优先走索引，写路径增量维护                          |
| **L1 缓存**    | 查询结果 LRU 缓存，写入自动失效                             |
| **WAL**        | 预写日志 + 启动重放，支撑崩溃恢复                           |
| **事务**       | 单层 begin / commit / rollback（默认 READ_COMMITTED）       |
| **聚合管道**   | match / group / sort / limit / project                      |
| **JSONPath**   | 安全子集（如 `$.field`）                                    |
| **备份**       | 全量 / 增量；可选 AES-256-GCM                               |
| **时间旅行**   | 按时间点查询、差异对比、回滚                                |
| **可观测**     | health、metrics、慢查询记录、QueryAdvisor                   |
| **运维入口**   | 全局 CLI `jsonsqlite`（建库 / 表·行 CRUD / 索引 / SQL / vacuum·rekey·doctor）、可选 HTTP Admin |
| **本地建库**   | 库 API / CLI：`create` 新建、`init` 幂等初始化                |
| **表管理**     | `listTables` / `createTable` / `dropTable` / `alterTable`；CLI 对话建表、二次确认删改 |
| **SQL 子集**   | `db.run(sql)` / `jsonsqlite run`：SELECT/INSERT/UPDATE/DELETE/DDL |

**相对传统 SQLite 的定位差异（不是性能全面替代）**：JSON 第一公民、动态 Schema、内置监控/Admin/时间旅行等开发与运维体验；适合中小型后端、配置中心、本地工具、快速迭代场景。

---

## 2. 环境与安装

### 要求

- Node.js **≥ 20**
- 支持 ESM `import` 与 CJS `require`（双格式发布）
- TypeScript 类型开箱即用（附带 `.d.ts`）

### 安装（业务项目）

```bash
npm install @webofcat/jsonsqlite
# 或
pnpm add @webofcat/jsonsqlite
# 或
yarn add @webofcat/jsonsqlite
```

### 2.1 全局 CLI 安装

```bash
npm install -g @webofcat/jsonsqlite

jsonsqlite --version          # => 1.8.0
jsonsqlite create ./my-db     # 新建数据库目录
jsonsqlite init ./my-db       # 幂等初始化（已存在则跳过创建）
jsonsqlite tables -p ./my-db --json
jsonsqlite insert users --data '{"name":"寒"}' -p ./my-db
jsonsqlite run "SHOW TABLES" -p ./my-db
jsonsqlite doctor --deep -p ./my-db
jsonsqlite help
```

命令别名：`jsql`（与 `jsonsqlite` 相同入口）。

本仓库本地联调 / 全局安装：

```bash
pnpm install && pnpm build
npm install -g ./packages/core
jsonsqlite --version
```

---

## 3. 快速开始

```ts
import { open } from "@webofcat/jsonsqlite";

const db = await open({ storagePath: "./data" });

// 写入
await db.insert("users", { name: "寒", age: 30, tags: ["vip"] });

// 建索引（可选，加速过滤）
await db.createIndex("users", "age", "tree");

// 查询
const rows = await db.query({
  collection: "users",
  filter: { age: { $gte: 18 } },
  orderBy: { age: "desc" },
  limit: 20,
});

console.log(rows);

// 进程退出前务必关闭
await db.close();
```

CommonJS：

```js
const { open } = require("@webofcat/jsonsqlite");

(async () => {
  const db = await open({ storagePath: "./data" });
  // ...
  await db.close();
})();
```

### 3.1 create / init API

```ts
import { create, init, getVersion, open } from "@webofcat/jsonsqlite";

console.log(getVersion()); // "1.8.0"

// 创建新库（若已存在会抛 DB_EXISTS；force: true 可强制重建）
await create({ storagePath: "./my-db" });

// 幂等初始化：不存在则创建，已存在则补齐目录结构
await init({ storagePath: "./my-db" });

// 再 open 进行读写
const db = await open({ storagePath: "./my-db" });
await db.close();
```

| API | 行为 |
|-----|------|
| `create(options)` | 新建数据目录；已存在且未 `force` → `ErrorCode.DB_EXISTS` |
| `init(options)` | 不存在则创建，存在则确保骨架完整（不删数据） |
| `getVersion()` | 返回包版本字符串 |
| `open(options)` | 打开库并持锁，用于 CRUD |

推荐流程：`create` 或 `init` → 业务中 `open` → 用完 `close`。

### 3.2 表管理与 SQL（`run`）

集合即「表」。可声明软 Schema（字段元数据，不强制校验写入）。

```ts
import { open } from "@webofcat/jsonsqlite";

const db = await open({ storagePath: "./data" });

await db.createTable("users", {
  fields: [
    { name: "name", type: "string" },
    { name: "age", type: "number" },
  ],
});

await db.run("INSERT INTO users (name, age) VALUES ('寒', 30)");
const result = await db.run(
  "SELECT name, age FROM users WHERE age >= 18 ORDER BY age DESC LIMIT 10",
);
console.log(result); // { type: 'rows', rows, columns, rowCount, total }

await db.alterTable("users", { addFields: [{ name: "city", type: "string" }] });
// await db.dropTable("users");

await db.close();
```

| API | 说明 |
|-----|------|
| `listTables()` / `describeTable(name)` | 列表 / 结构 |
| `createTable(name, { fields? })` | 建表（软 Schema） |
| `dropTable(name)` | 删表并清理磁盘 |
| `alterTable(name, { renameTo?, addFields?, dropFields? })` | 改名 / 增减字段定义 |
| `count(name, filter?)` | 计数（分页用） |
| `run(sql)` | 执行 SQL 子集 |
| `exportCollection(name)` / `importCollection(name, docs, { mode? })` | 导出 / 导入（`append` 按 `_id` upsert；`replace` 整表替换） |
| `queryCursor({ collection, filter?, orderBy?, cursor?, limit? })` | 游标分页（默认按 `_id`） |
| `vacuum({ collection? })` / `doctor({ deep? })` / `rekey({…})` | 运维：压缩、深度诊断、离线换钥 |

**SQL 支持**：`SELECT`（含 **`LIKE` / `NOT LIKE`**、**`COUNT(*)`**、单表等值 **`INNER`/`LEFT JOIN`**）/ `INSERT` / `UPDATE` / `DELETE` / DDL / `SHOW` / `DESCRIBE`。

**不支持（稳定 ErrorCode）**：多表链式 JOIN、子查询、`FULL`/`RIGHT OUTER`、无 `ON` 的笛卡尔积、`ESCAPE` 子句。`LIKE` 中 `\` 可转义下一个字符。

JOIN 结果列使用 `alias.field`（或表名）前缀。`COUNT(*)` 返回一行 `{ count: N }`（与 `count()` API 一致）。

---

## 4. 打开与关闭

### `open(options)` / `new JSONSQLite(options).open()`

```ts
import { open, JSONSQLite } from "@webofcat/jsonsqlite";

const db = await open({
  storagePath: "./data", // 必填：数据目录
  walMode: true, // 默认 true
  cacheSize: 1000, // L1 缓存条目数
});

// 或分步：
const db2 = new JSONSQLite({ storagePath: "./data" });
await db2.open();
```

打开时会：创建目录结构 → 获取文件锁 → 加载 catalog → 重放 WAL → 加载索引元数据。

### `close(opts?)`

```ts
await db.close(); // 刷盘快照后释放锁
await db.close({ flush: false }); // 仅测试/模拟崩溃用，生产勿用
```

建议挂到框架生命周期：

```ts
process.on("SIGINT", async () => {
  await db.close();
  process.exit(0);
});
```

### 事件

```ts
db.on("ready", () => console.log("ready"));
db.on("close", () => console.log("closed"));
db.on("dataChanged", (e) => console.log("changed", e));
```

---

## 5. 集合与文档 CRUD

集合名在首次写入时会自动创建，也可显式管理：

```ts
await db.createCollection("orders");
const list = await db.listCollections();
```

### 系统字段

每条文档自动包含：

| 字段                        | 说明                         |
| --------------------------- | ---------------------------- |
| `_id`                       | 主键（可自带；否则自动生成） |
| `_version`                  | 乐观锁版本，从 1 递增        |
| `_createdAt` / `_updatedAt` | 毫秒时间戳                   |

### 写入 API

```ts
// 单条 / 批量插入
const doc = await db.insert("users", { name: "Alice", age: 22 });
const docs = await db.insert("users", [
  { name: "Bob", age: 35 },
  { name: "Carol", age: 28 },
]);

// 按 _id 更新（可选期望版本）
await db.update("users", doc._id, { age: 23 });
await db.update("users", doc._id, { age: 24 }, { expectedVersion: 2 });

// 删除
await db.delete("users", doc._id);

// 存在则更新，否则插入（需提供 _id 才能命中更新）
await db.upsert("users", { _id: doc._id, name: "Alice", age: 25 });

// 点查
const one = await db.findById("users", doc._id);
```

版本冲突时抛出 `JSONSQLiteError`，`code === 'VERSION_CONFLICT'`。

---

## 6. JSON 查询

```ts
import type { JsonQuery } from "@webofcat/jsonsqlite";

const q: JsonQuery = {
  collection: "users",
  filter: {
    age: { $gte: 18, $lte: 40 },
    name: { $contains: "A" },
  },
  projection: ["name", "age"], // 另会保留系统字段
  orderBy: { age: "desc" },
  limit: 50,
  offset: 0,
};

const rows = await db.query(q);
```

### 过滤器运算符

| 运算符                    | 含义                         |
| ------------------------- | ---------------------------- |
| 直接等值 / `$eq`          | 相等                         |
| `$ne`                     | 不等                         |
| `$gt` `$gte` `$lt` `$lte` | 比较                         |
| `$in` `$nin`              | 属于 / 不属于集合            |
| `$contains`               | 字符串包含（可配合倒排索引） |
| `$exists`                 | 字段是否存在                 |
| `$and` `$or`              | 逻辑组合                     |

嵌套字段可用点路径，例如：`filter: { 'profile.city': 'SH' }`。

---

## 7. 索引

```ts
// type: 'object' | 'tree' | 'inverted'
await db.createIndex("users", "city", "object"); // 等值
await db.createIndex("users", "age", "tree"); // 范围
await db.createIndex("posts", "title", "inverted"); // 全文分词

console.log(await db.listIndexes());
await db.dropIndex("users", "city");
```

| 类型       | 适合场景            | 查询形态                 |
| ---------- | ------------------- | ------------------------ |
| `object`   | 低基数字段等值      | `{ city: 'SH' }` / `$eq` |
| `tree`     | 有序数值/字符串范围 | `$gte` / `$lte` 等       |
| `inverted` | 文本检索            | `$contains`              |

查询规划器会在「单字段过滤」且存在对应索引时优先走索引，再套用其余 filter / sort / limit。

---

## 8. 聚合与 JSONPath

### 聚合管道

```ts
const result = await db.aggregate("orders", [
  { type: "match", filter: { amount: { $gte: 10 } } },
  {
    type: "group",
    by: "city",
    fields: {
      total: { op: "sum", field: "amount" },
      n: { op: "count" },
      avg: { op: "avg", field: "amount" },
    },
  },
  { type: "sort", orderBy: { total: "desc" } },
  { type: "limit", limit: 10 },
]);
```

支持的 stage：`match` | `group` | `sort` | `limit` | `project`  
聚合算子：`sum` | `avg` | `min` | `max` | `count` | `push`

### JSONPath（安全子集）

```ts
const names = await db.jsonPath("users", "$.name");
const ages = await db.jsonPath("users", "$[*].age");
```

不支持脚本表达式与 `..` 递归，以避免注入风险。

---

## 9. 事务

```ts
const txId = await db.beginTransaction(); // 默认 READ_COMMITTED
try {
  await db.insert("accounts", { name: "A", balance: 100 });
  await db.insert("accounts", { name: "B", balance: 0 });
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

### 主存储加密与 rekey（1.4 / 1.5）

对新的空库传入 `encryptionKey`（或 `JSONSQLITE_KEY`）时，集合 JSONL 与 WAL 按行 AES-256-GCM 落盘；`catalog.json` 标记 `encryption: true`。

**离线换钥（1.5，推荐写出新路径）**：

```bash
jsonsqlite rekey --path ./data --out ./data-new --from-key OLD --to-key NEW
# 或原地（需 --yes；有 journal 崩溃恢复）
jsonsqlite rekey --path ./data --in-place --yes --from-key OLD --to-key NEW
```

```ts
import { rekeyDatabase } from "@webofcat/jsonsqlite";
await rekeyDatabase({
  storagePath: "./data",
  fromKey: "old",
  toKey: "new",
  targetPath: "./data-v2",
});
```

> 大表仍是**内存模型**。1.5 默认 **`lazyCollections: true`**（open 不预加载全部表；首次访问再加载）。需要 1.4 行为时设 `lazyCollections: false`，或用 `prefetchCollections: ['hot']` 预热。

### 1.4 → 1.5 迁移

1. 依赖升到 `1.6.0`
2. 确认懒加载默认可接受；热点表可 `prefetchCollections`
3. 加密库换钥用 `rekey`（不要手工改文件）
4. CI 可加：`jsonsqlite doctor --deep --path …`、`jsonsqlite vacuum --path …`

---

## 11. 时间旅行

依赖写入时追加的 ChangeLog（`deltas/`）：

```ts
const t0 = Date.now();
await db.insert("users", { name: "v1" });
// ... 后续更新 ...

// 查询某一时刻的数据视图
const past = await db.queryAtTime("users", t0, {
  filter: { name: { $exists: true } },
});

// 两个时间点之间的差异
const diff = await db.diffBetweenTimes("users", t0, Date.now());
// { added, removed, modified }

// 危险：将集合回滚到历史时间点（会改写当前数据）
await db.rollbackToTime("users", t0);
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
  collection: "users",
  filter: { age: { $gte: 18 } },
});

// 数据质量（完整度等）
const quality = await db.analyzeQuality("users", ["name", "age"]);
```

错误类型：

```ts
import { JSONSQLiteError, ErrorCode } from "@webofcat/jsonsqlite";

try {
  await db.update("users", "missing", { x: 1 });
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
  host: "127.0.0.1",
  port: 3000,
  adminToken: "change-me", // 建议生产必填
});
```

| 路径                 | 说明                        |
| -------------------- | --------------------------- |
| `GET /health`        | 健康检查                    |
| `GET /admin`         | 简易管理页（指标 + 查询台） |
| `GET /admin/metrics` | 指标 JSON                   |
| `POST /query`        | body 为 JsonQuery           |

带 Token 时请求头：`Authorization: Bearer <token>`。

### 变更订阅

```ts
const unsubscribe = db.subscribe((event) => {
  console.log("dataChanged", event);
});
// ...
unsubscribe();
```

---

## 14. CLI：`jsonsqlite`

全局 flags（1.5.5）：`-p/--path`、`-y/--yes`、`--json`、`-q/--quiet`、`-h/--help`。  
Exit：`0` 成功 · `1` 用法/业务 · `2` IO · `3` 锁失败。失败且 `--json` 时：`{ ok:false, code, message }`。

```bash
npm i -g @webofcat/jsonsqlite

jsonsqlite --version
jsonsqlite create ./data
jsonsqlite init ./data

# 表管理
jsonsqlite tables -p ./data --json
jsonsqlite table create -p ./data                  # 对话式建表（需 TTY）
jsonsqlite table create --name users --field name:string --field age:number -p ./data
jsonsqlite table drop users -p ./data              # 二次确认；CI 加 --yes
jsonsqlite table alter users -p ./data             # 对话修改 + 二次确认（需 TTY）
jsonsqlite table show users -p ./data --page 1 --size 20 --json
jsonsqlite table describe users -p ./data

# 行 CRUD / 索引 / 统计（1.5.5）
jsonsqlite insert users --data '{"name":"寒","age":30}' -p ./data --json
jsonsqlite get users --id <id> -p ./data --json
jsonsqlite update users --id <id> --set age=31 -p ./data
jsonsqlite delete users --id <id> --yes -p ./data
jsonsqlite count users --where '{"age":{"$gt":18}}' -p ./data --json
jsonsqlite index create users age --type tree -p ./data
jsonsqlite stats -p ./data --json
jsonsqlite explain "SELECT * FROM users WHERE age > 18" -p ./data

# SQL
jsonsqlite run "SHOW TABLES" -p ./data
jsonsqlite run "SELECT * FROM users WHERE age > 18 LIMIT 10" -p ./data
jsonsqlite sql -p ./data                           # TTY REPL（.tables / .quit）

jsonsqlite doctor --deep -p ./data
jsonsqlite vacuum -y -p ./data
jsonsqlite backup -p ./data
```

环境变量：`JSONSQLITE_PATH`（默认数据目录）、`JSONSQLITE_KEY`、`NO_COLOR`。

| 命令 | 作用 |
|------|------|
| `--version` / `-V` / `version` | 打印版本号 |
| `create` / `init` | 建库 / 幂等初始化 |
| `tables` | 列出所有表 |
| `table create` | 对话建表，或 `--name` + `--field` 非交互 |
| `table drop <name>` | 删除表（二次确认；`--yes` 跳过） |
| `table alter <name>` | 修改表（对话 + 二次确认，需 TTY） |
| `table show <name>` | 分页表格查看数据（`-i` 交互翻页） |
| `table describe <name>` | 查看软 Schema |
| `table export <name> --file out.jsonl` | 导出 JSONL |
| `table import <name> --file in.jsonl [--mode append\|replace]` | 导入 JSONL |
| `insert` / `update` / `delete` / `get` / `count` | 行级 CRUD 与计数 |
| `index list\|create\|drop` | 索引管理 |
| `stats` / `explain` | 库统计 / 查询建议 |
| `run "<sql>"` | 执行 SQL 子集（单语句） |
| `sql` | TTY 交互 REPL |
| `vacuum [--collection name]` | 重写 JSONL / 截断 WAL |
| `rekey --out …` / `--in-place --yes` | 离线换钥 |
| `doctor [--deep]` | 健康检查；`--deep` 一致性 |
| `query` / `backup` / `collections` | JSON 查询 / 备份 |
| `help` | 分级帮助（`table --help` 等） |

完整命令契约见根目录 **[CLI-API.md](./CLI-API.md)**（底稿：[cli-command-inventory.md](./devDocs/releases/v1.5.5/cli-command-inventory.md)）。

别名：`jsql` ≡ `jsonsqlite`。

---

## 15. 配置项

```ts
interface JSONSQLiteOptions {
  storagePath: string; // 必填
  walMode?: boolean; // 默认 true
  defaultIsolation?: IsolationLevel; // 仅 READ_COMMITTED 真正实现；其它会降级
  queryTimeout?: number; // 默认 30000；0 关闭
  cacheSize?: number; // 默认 1000
  encryptionKey?: string | null; // 空库启用主存加密；亦用于备份 AES；或 JSONSQLITE_KEY
  syncMode?: 'none' | 'normal' | 'full'; // 默认 normal（fsync）
  schemaMode?: 'off' | 'warn' | 'strict'; // 默认 off（软 Schema）
  lazyCollections?: boolean; // 默认 true（1.5+）
  prefetchCollections?: string[]; // open 时预热
}
```

Admin：`startServer({ host, port, adminToken })` — 绑定非 loopback 时**必须**提供 `adminToken`；本机无 token 启动会向 stderr 告警。

**弃用**：`dropCollection` → 请用 `dropTable`（1.5 仍可用，1.6 冻结前保留）。

---

## 16. 数据目录结构

打开 `storagePath` 后大致布局：

```text
data/
├── meta/
│   ├── catalog.json      # 集合目录
│   ├── indexes.json      # 索引元数据 + 段校验
│   ├── idx/*.seg.json    # 索引 postings（1.8，可重建）
│   └── .lock             # 单写者文件锁
├── collections/
│   └── {name}/docs/
│       ├── data.jsonl
│       └── cold.jsonl    # 仅 tiering 实验旗标
├── wal/                  # 预写日志
├── deltas/               # 变更日志（备份增量 / 时间旅行）
└── backups/              # 备份文件与 manifest
```

容器部署时请将 `storagePath` 挂到**持久卷**，不要只写在可丢弃的容器层。

---

## 17. 使用限制与最佳实践

1. **单写者**：同一 `storagePath` 同时只能有一个进程持有写锁；第二进程 `open` 会得到 `LOCK_FAILED`。
2. **不是共享网络库**：多实例水平扩展不要多进程直连同一目录写；需要共享请自建单写者服务或等待后续复制能力。
3. **进程退出要 `close()`**：确保刷盘与释放锁。默认 `syncMode: 'normal'` 会对 WAL/快照做 fsync；极端性能场景可改 `none`（掉电风险自负）。
4. **事务不嵌套**：一次只开一个事务；隔离级别仅 **READ_COMMITTED** 真正实现。
5. **软 Schema**：默认不强制校验；需要约束时设 `schemaMode: 'strict'`。
6. **Admin 默认绑定 127.0.0.1**：公网暴露必须加 Token / 反代鉴权。
7. **磁盘格式**：当前 `formatVersion = 1`（已具备迁移钩子）；破坏性变更将走 major 或迁移升级。
8. **内存模型**：默认把已加载集合放在进程内存。`tiering: true` 是实验旗标（默认关），冷文档按需加载；不要在生产依赖这份冷文件布局。

---

## 17.1 性能与存储选项（1.8）

默认查询结果与 1.7 相同。`persistIndexes` 默认开启，只影响重启时是否重放索引；L2、压缩、热冷都要显式打开。

| 选项 | 默认 | 何时开 | 风险 |
|------|------|--------|------|
| `persistIndexes` | `true` | 大表重启希望跳过索引 rebuild | 段损坏会自动 rebuild；`doctor` 能看到 `index-segments` |
| `l2Cache` | `false` | 同一进程里重复查询、L1 太小 | 只在本进程；写入会失效。看 `getMetrics().l2` |
| `compression` | `false` | 单条 JSON 经常超过 `compressionThreshold`（默认 1024） | 与加密叠加时先 gzip 再 AES；小文档不会变大 |
| `tiering` | `false` | 想把几乎不读的文档挪出热 JSONL | **实验**。默认关。`close()` 才扫冷热。全表 `query` 会把冷文档拉回内存 |

```ts
const db = await open({
  storagePath: './data',
  l2Cache: true,
  compression: true,
  compressionThreshold: 1024,
  // tiering: true, // 实验，生产先不要开
});
```

```bash
jsonsqlite index rebuild users -p ./data --json
jsonsqlite vacuum --compress -p ./data
jsonsqlite doctor -p ./data --json          # indexSegments / compression / tiering / l2
jsonsqlite stats -p ./data --json           # l2 / tiers / compression
pnpm --filter @jsonsqlite/bench start       # 报告含 threshold；BENCH_SKIP_THRESHOLD=1 可跳过
```

阈值在 `apps/bench/thresholds.json`，对照 `apps/bench/baseline.json`（仅当 `N` 相同）。数字是回归上限，不是对外性能承诺。

---

## 18. 本仓库开发

本仓库为 pnpm monorepo：

```text
packages/core     → 可发布的 @webofcat/jsonsqlite
apps/examples     → 示例
apps/bench        → 基准
devDocs/          → 设计与版本计划（design / releases）
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

**权威契约（置顶）**：[API.md](./API.md) · [CLI-API.md](./CLI-API.md)

完整索引见 [devDocs/README.md](./devDocs/README.md)。

| 文档 | 内容 |
|------|------|
| [API.md](./API.md) | **1.6 LTS** 库 API 权威手册 |
| [CLI-API.md](./CLI-API.md) | **1.6 LTS** CLI 权威手册（冻结自 1.5.5） |
| [devDocs/releases/ROADMAP.md](./devDocs/releases/ROADMAP.md) | **完整路线至 3.0** + **LTS-1/2/3** 标注 |
| [devDocs/releases/FEATURE-MATRIX.md](./devDocs/releases/FEATURE-MATRIX.md) | 设计能力采纳矩阵（完工勾选真源） |
| [devDocs/releases/CLI-EVOLUTION.md](./devDocs/releases/CLI-EVOLUTION.md) | 1.7→3.0 **CLI / CLI-API** 适配与再冻结点 |
| [devDocs/releases/v1.6.0/开发计划.md](./devDocs/releases/v1.6.0/开发计划.md) | **LTS-1** `1.6.x`（已发布） |
| [devDocs/releases/v1.7.0/开发计划.md](./devDocs/releases/v1.7.0/开发计划.md) | v1.7 体验补齐（非 LTS） |
| [devDocs/releases/v1.8.0/开发计划.md](./devDocs/releases/v1.8.0/开发计划.md) | v1.8 性能预备（非 LTS） |
| [devDocs/releases/v2.0/开发计划.md](./devDocs/releases/v2.0/开发计划.md) | v2.0 破坏性一代（非 LTS） |
| [devDocs/releases/v2.1.0/开发计划.md](./devDocs/releases/v2.1.0/开发计划.md) | v2.1 硬化（非 LTS） |
| [devDocs/releases/v2.2.0/开发计划.md](./devDocs/releases/v2.2.0/开发计划.md) | **LTS-2** `2.2.x`（规划） |
| [devDocs/releases/v2.3.0/开发计划.md](./devDocs/releases/v2.3.0/开发计划.md) | v2.3 适配器（非 LTS） |
| [devDocs/releases/v3.0.0/开发计划.md](./devDocs/releases/v3.0.0/开发计划.md) | **LTS-3 / Vision Complete**（规划） |
| [devDocs/releases/v1.5.5/开发计划.md](./devDocs/releases/v1.5.5/开发计划.md) | v1.5.5 **CLI LTS 化**（命令扩展 / 交互与脚本契约） |
| [devDocs/releases/v1.5.0/开发计划.md](./devDocs/releases/v1.5.0/开发计划.md) | v1.5.0 生产就绪（rekey / vacuum / 压测） |
| [devDocs/releases/v1.4.0/开发计划.md](./devDocs/releases/v1.4.0/开发计划.md) | v1.4.0 加密主存 / LIKE·JOIN / 导入导出 |
| [devDocs/releases/v1.3.0/开发计划.md](./devDocs/releases/v1.3.0/开发计划.md) | v1.3.0 硬化（耐久 / DDL / CLI） |
| [devDocs/releases/v1.2.0/开发计划.md](./devDocs/releases/v1.2.0/开发计划.md) | v1.2.0 表管理 / SQL |
| [devDocs/releases/v1.1.0/开发计划.md](./devDocs/releases/v1.1.0/开发计划.md) | v1.1.0 CLI / create / init |
| [devDocs/releases/v1.0/开发计划.md](./devDocs/releases/v1.0/开发计划.md) | v1.0 开发计划 |
| [devDocs/design/JSONSQLite 技术实现方案与计划.md](./devDocs/design/JSONSQLite%20技术实现方案与计划.md) | 架构方案 |
| [packages/core/README.md](./packages/core/README.md) | npm 包简版说明 |
| [CHANGELOG.md](./CHANGELOG.md) | 版本变更 |

---

## License

MIT — 见 [LICENSE](./LICENSE)。
