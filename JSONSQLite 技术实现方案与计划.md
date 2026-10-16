# JSONSQLite 技术实现方案与计划

> 文档版本：v1.1  
> 基于：《JSONSQLite 生产级实现大纲》《JSONSQLite vs SQLite - 超越的可能性》  
> 目标：在本仓库落地一套「JSON 原生存储 + SQLite 级可靠性 + 现代运维能力」的嵌入式/单机优先数据库引擎。  
> 交付形态：以 **npm 库** 为主，供 Node.js 后端 `npm install` 后进程内嵌入使用（详见《JSONSQLite npm包与后端接入说明》）。

---

## 0. 文档目的与阅读指引

本文是**可执行的工程方案**，不是概念白皮书。它回答：

1. 要做什么、不做什么（产品边界）
2. **如何以 npm 包交付并接入 Node.js 后端**（§1.5；完整规范见配套文档）
3. 怎么分层、怎么拆模块（技术架构）
4. 每层怎么实现、关键算法与数据格式（详细设计）
5. 按什么顺序交付、如何验收（实施计划）

| 角色 | 建议阅读章节 |
|------|--------------|
| 决策 / 产品 | §1、§1.5、§2、§10 |
| 后端接入方 / 发布负责人 | §1.5 + 《npm包与后端接入说明》全文 |
| 架构 / 核心开发 | §3–§8、§11 |
| 测试 / 运维 / npm 发布 | §9、§12–§14 +《npm包与后端接入说明》§8–§9 |

---

## 1. 产品定位与目标

### 1.1 一句话定位

**JSONSQLite** = 以 JSON 为第一公民的本地数据库引擎：提供文档/半结构化数据的原生查询与动态 Schema，同时具备 WAL、事务、索引、备份恢复与可观测性；在「SQLite 做不好或不方便做」的开发体验与运维侧能力上形成差异化。

**对 Node.js 后端而言**：它首先是一个可通过 npm 安装的**嵌入式库**（类似 better-sqlite3 / Level 的依赖角色），业务进程 `import` 后打开本地数据目录即可读写；不是默认必须单独部署的网络数据库服务。

### 1.2 明确不做（初期边界）

为避免范围失控，**v1.0 生产就绪前**明确排除或降级：

| 能力 | 处理策略 |
|------|----------|
| 完整 SQL 方言兼容（全部 SQLite SQL） | 仅做子集 + JSON/JSONPath 主查询语言 |
| 多机 Raft 集群 / 强一致分片 | 放在 Phase 5；v1 只做单机 + 可选主从异步复制原型 |
| 替代 Elasticsearch / 向量库 | 全文倒排做基础版；向量索引以插件预留 |
| 替换生产级 OLAP（ClickHouse 等） | 列存仅用于热表分析加速，不做通用数仓 |
| 浏览器端完整引擎 | 可选 WASM 延后；优先 Node.js / 服务端嵌入 |
| 强绑 Express / Nest 等 Web 框架 | 核心包框架无关；适配放示例或后续可选包 |

### 1.3 成功标准（v1.0）

- **正确性**：崩溃恢复后数据与已提交事务一致；ACID 在声明的隔离级别下可验证
- **性能（单机，SSD，100 万文档量级）**：
  - 等值点查（有索引）：P99 ≤ 1ms
  - 简单过滤扫描（10 万级结果集）：P95 ≤ 50ms
  - 批量写入 10 万条：≤ 3s（不开加密）
- **可用性**：内置指标、健康检查、增量备份与时间点恢复（PITR）可用
- **体验**：JSON/JSONPath 查询、CLI、HTTP Admin API；可选简易 Web 管理页
- **可安装性**：能以 npm 包安装进任意 Node.js ≥ 20 后端；提供 ESM + CJS + `.d.ts`；`npm pack` 冒烟通过

### 1.4 推荐技术栈（锁定）

| 层级 | 选择 | 理由 |
|------|------|------|
| 运行时 | Node.js ≥ 20（ESM） | 与大纲一致；JSON/JIT/生态成熟 |
| 语言 | TypeScript（strict） | 生产级类型安全、可维护 |
| 构建发布 | tsup/unbuild 等产出 ESM+CJS+dts | 满足 `npm i` 后双模块消费者 |
| 测试 | Vitest + 属性测试（可选 fast-check） | 快、与 ESM 友好 |
| 压测 | 自研 benchmark + Clinic.js | 对齐大纲场景 |
| 包管理 | pnpm（workspace） | 仓库整洁；root private，仅子包 publish |
| 可选 L3 缓存 | Redis（optionalDependency） | 缺省不影响主路径安装 |

### 1.5 交付形态：npm 库优先（后端嵌入）

> 完整字段级规范、Express/Nest 示例、发布清单见：**《JSONSQLite npm包与后端接入说明》**。此处为方案级摘要，实现与评审以该文档为准。

#### 1.5.1 主路径心智模型

```text
业务后端工程
  pnpm/npm/yarn add @jsonsqlite/core
       ↓
  import { open } from '@jsonsqlite/core'
       ↓
  await open({ storagePath: './data' })   // 进程内引擎 + 本地目录
       ↓
  业务 API / Worker 直接调用 db.query / db.insert
       ↓
  SIGTERM → await db.close()
```

| 形态 | v1 定位 |
|------|---------|
| `@jsonsqlite/core` 嵌入式库 | **主交付物** |
| `jsql` CLI（bin） | 同包或 `@jsonsqlite/cli`，运维辅助 |
| 进程内 HTTP/Admin | 可选开启，默认不监听 |
| 独立守护进程 / 多语言 TCP 协议 | 非 v1 目标 |

#### 1.5.2 包名与发布边界

| 项 | 约定 |
|----|------|
| 推荐包名 | `@jsonsqlite/core`（发布前确认 npm 可用性；可选短名 `jsonsqlite` 做 re-export） |
| Git 仓库 | `json-sqlite`；workspace root `"private": true` |
| 可 publish | 仅 `packages/core`（及后续显式声明的包） |
| 不 publish | bench、内部 apps、设计 md、测试、本地 `data/` |

#### 1.5.3 对「库 API」的硬性要求

1. **单一公共入口**：`exports["."]` → `dist`；内部模块默认不深路径导出  
2. **双格式 + 类型**：`import` / `require` / `types` 齐全  
3. **零原生编译（默认）**：纯 JS 产物，降低 Windows/CI 安装失败率  
4. **无框架绑架**：不 peer 依赖 Express/Nest；框架适配放可选包或示例  
5. **显式生命周期**：`open` / `close` 由宿主应用托管；文档强调单写者与数据目录持久化  
6. **semver + 磁盘 `formatVersion`**：破坏性 API/格式走 MAJOR  

#### 1.5.4 与架构分层的关系

应用接口层中的 **Library API** 是 npm 消费者的唯一稳定面；HTTP/WebSocket/Admin 是库上的可选能力，不改变「先能 `npm i` 嵌入」的优先级。Phase 0 验收必须包含 `pnpm pack` + 临时目录安装冒烟，而不仅是仓库内单测。

---

## 2. 总体架构

### 2.1 分层架构（落地版）

```
┌──────────────────────────────────────────────────────────────┐
│ Application API（Library API = npm 公共稳定面）               │
│  Library API · CLI · HTTP/REST · WebSocket · Admin UI        │
└────────────────────────────┬─────────────────────────────────┘
                             │
┌────────────────────────────▼─────────────────────────────────┐
│ Query Engine                                                 │
│  Parser · Planner/Optimizer · Executor · Advisor · Profiler  │
└────────────────────────────┬─────────────────────────────────┘
                             │
┌────────────────────────────▼─────────────────────────────────┐
│ Index · Cache · Transaction · Lock (MVCC)                    │
└────────────────────────────┬─────────────────────────────────┘
                             │
┌────────────────────────────▼─────────────────────────────────┐
│ Storage                                                      │
│  Document/Columnar/Hybrid · Delta · WAL · Tiering · Crypto   │
└────────────────────────────┬─────────────────────────────────┘
                             │
┌────────────────────────────▼─────────────────────────────────┐
│ Ops                                                          │
│  Monitor · Backup/Restore · Health · AutoTune · Plugins      │
└──────────────────────────────────────────────────────────────┘
```

### 2.2 读写数据流

**写路径**

```
API → TransactionManager → LockManager(写)
    → Storage.apply(+version)
    → IndexManager.update
    → WAL.append → (async) Checkpoint
    → Cache.invalidate → EventBus(dataChanged)
```

**读路径**

```
API → Cache.get?
    → QueryEngine.parse → Optimizer → LockManager(读/快照)
    → Index 定位 or Scan → Storage.load
    → Cache.set → 返回
```

### 2.3 设计原则

1. **单机正确性优先于分布式炫技**——先把 WAL/Checkpoint/MVCC 做对
2. **JSON 为存储与查询中心**——SQL 仅为兼容层
3. **组件可替换**——Storage / Index / Cache 通过接口注入（插件化）
4. **可观测默认开启**——每个查询阶段可打点，不依赖外部 APM
5. **渐进增强**——L1 缓存默认；L2/L3、加密、列存、集群按 Phase 打开
6. **库优先、可 npm 安装**——公共 API 稳定面服务于 `import`；服务端/Admin 为可选增强，不阻断嵌入式主路径

---

## 3. 仓库与模块划分

### 3.1 推荐目录结构

```
json-sqlite/                         # Git 仓库；root private，禁止整体 npm publish
├── packages/
│   └── core/                        # ✅ 唯一主发布包 → @jsonsqlite/core
│       ├── src/
│       │   ├── index.ts             # 公共 API 白名单（唯一对外 export）
│       │   ├── engine/
│       │   │   └── JSONSQLite.ts    # 主引擎、生命周期
│       │   ├── storage/
│       │   │   ├── AdaptiveStorage.ts
│       │   │   ├── wal/
│       │   │   ├── delta/
│       │   │   ├── columnar/
│       │   │   ├── tiered/
│       │   │   └── crypto/
│       │   ├── query/
│       │   │   ├── QueryEngine.ts
│       │   │   ├── parser/          # JSON / JSONPath / SQL 子集
│       │   │   ├── compiler/        # 原生函数编译
│       │   │   ├── planner/
│       │   │   ├── executor/
│       │   │   └── aggregate/
│       │   ├── index/
│       │   │   ├── IndexManager.ts
│       │   │   ├── ObjectIndex.ts
│       │   │   ├── TreeIndex.ts     # B+Tree
│       │   │   ├── InvertedIndex.ts
│       │   │   ├── CompositeIndex.ts
│       │   │   └── GeoIndex.ts      # Phase 后置
│       │   ├── cache/
│       │   │   └── MultiLevelCache.ts
│       │   ├── concurrency/
│       │   │   ├── LockManager.ts
│       │   │   ├── DeadlockDetector.ts
│       │   │   └── MVCC.ts
│       │   ├── transaction/
│       │   │   └── TransactionManager.ts
│       │   ├── backup/
│       │   │   └── BackupManager.ts
│       │   ├── monitor/
│       │   │   ├── Monitor.ts
│       │   │   ├── Profiler.ts
│       │   │   ├── HealthCheck.ts
│       │   │   └── AutoOptimizer.ts
│       │   ├── features/            # 差异化能力
│       │   │   ├── TimeTravel.ts
│       │   │   ├── StreamProcessor.ts
│       │   │   ├── DataQuality.ts
│       │   │   ├── QueryAdvisor.ts
│       │   │   └── AutoTuning.ts
│       │   ├── cluster/             # Phase 5
│       │   ├── plugin/
│       │   │   └── PluginSystem.ts
│       │   ├── api/
│       │   │   ├── http/
│       │   │   └── ws/
│       │   ├── admin/               # 管理面板静态资源/SSR
│       │   ├── config/
│       │   │   └── defaults.ts
│       │   └── types/
│       ├── dist/                    # ✅ build 产物（进 npm tarball）
│       ├── test/
│       ├── README.md                # ✅ npm 用户文档（安装/快速开始/限制）
│       ├── package.json             # name/exports/files/engines/publishConfig
│       └── tsconfig.json
├── apps/
│   ├── cli/                         # 可并入 core bin，或日后 @jsonsqlite/cli
│   ├── examples/                    # ❌ private：Express/Nest 接入示例（不发布）
│   └── bench/                       # ❌ private：基准测试套件
├── docs/                            # ❌ 设计笔记（不进 npm）
├── config.example.json
├── package.json                     # private: true
├── pnpm-workspace.yaml
└── README.md                        # 仓库总览 + 链到方案与 npm 接入说明
```

初期若希望更轻量，可先**单包**仓库结构（根目录即 `@jsonsqlite/core`），但必须一开始就按可发布库配置 `exports` / `files` / `engines`；日后再迁入 `packages/core`。

### 3.2 核心类型（契约草案）

```ts
/** 集合（表）中的一条文档 */
interface Document {
  _id: string;
  _version: number;
  _createdAt: number;
  _updatedAt: number;
  [field: string]: unknown;
}

type IsolationLevel =
  | 'READ_UNCOMMITTED'
  | 'READ_COMMITTED'
  | 'REPEATABLE_READ'
  | 'SERIALIZABLE';

interface QueryRequest {
  /** JSON 查询对象 | JSONPath 字符串 | SQL 子集 */
  source: string | Record<string, unknown>;
  params?: Record<string, unknown>;
  timeoutMs?: number;
}

interface WriteOp {
  op: 'insert' | 'update' | 'delete' | 'upsert';
  collection: string;
  data?: Record<string, unknown> | Record<string, unknown>[];
  filter?: Record<string, unknown>;
}
```

### 3.3 公共导出清单（npm 稳定面）

```ts
// packages/core/src/index.ts — 唯一对外出口（示例）
export { JSONSQLite, open } from './engine/JSONSQLite.js';
export type {
  JSONSQLiteOptions,
  Document,
  QueryRequest,
  WriteOp,
  IsolationLevel,
} from './types/index.js';
export { JSONSQLiteError, ErrorCode } from './errors.js';
```

规则：

- 未在此文件导出的符号 **不构成** semver 公共 API  
- 消费者不得依赖 `@jsonsqlite/core/dist/...` 深路径  
- 插件作者若需要扩展点，使用显式 subpath（如 `./plugin`），见《npm包与后端接入说明》§4.2、§5

### 3.4 主引擎生命周期

1. `new JSONSQLite(config)` → 仅合并配置，不阻塞
2. `await db.open()` / 推荐工厂 `await open(config)` → 目录、元数据、WAL 恢复、索引加载、后台任务
3. 就绪后 `ready` 事件；拒绝在 `isReady=false` 时执行查询
4. `await db.close()` → 停定时器、flush WAL、释放锁、落盘元数据

后台任务（可配置开关）：Checkpoint、自动备份、缓存清理、统计更新、索引建议扫描、指标上报。

后端框架对接要点：将 `open`/`close` 挂到应用生命周期（Nest `onModuleInit/Destroy`、Fastify `onClose` 等）；容器部署时 `storagePath` 必须落在 volume 上。更多示例见《npm包与后端接入说明》§5。

---

## 4. 存储层详细设计

### 4.1 磁盘布局

```
{storagePath}/
├── meta/
│   ├── catalog.json          # 集合、字段统计、配置快照
│   └── indexes.json          # 索引元数据
├── collections/
│   └── {name}/
│       ├── manifest.json     # 存储模式、分片/文件列表
│       ├── docs/             # 文档模式：分片 JSONL 或分段 JSON
│       ├── columnar/         # 列存：{field}.col + 字典
│       └── snapshots/        # 集合级快照
├── wal/
│   └── {name}.wal            # 按序追加的 WAL 段（可轮转）
├── deltas/
│   └── {name}.delta          # 增量变更流（支撑时间旅行/PITR）
├── tiers/
│   └── {name}/{hot|warm|cold}/
└── backups/
    ├── full_*.json.gz
    ├── inc_*.delta
    └── manifest.json
```

### 4.2 存储模式选择（Adaptive）

| 模式 | 触发条件（启发式） | 用途 |
|------|-------------------|------|
| `document` | 默认；Schema 不稳定、嵌套深 | CRUD、点查 |
| `columnar` | 字段稳定、分析/聚合多、行数大 | 聚合、投影剪枝 |
| `hybrid` | 热字段列存 + 冷嵌套文档存 | 平衡 |
| `compressed` | 单对象或块 > compressionThreshold | 冷数据 |

实现要点：

- `chooseStorageType(table, sample)` 基于字段基数、嵌套深度、查询直方图（Monitor 反馈）
- **写入始终先保证 WAL/Delta 正确**；列存可异步重建，避免写路径过重
- 文档主键 `_id`（ULID/UUID），乐观锁依赖 `_version`

### 4.3 WAL 与 Checkpoint

**WAL 条目字段**：`seq, ts, txId, op, collection, payload, checksum`

| 规则 | 说明 |
|------|------|
| 提交边界 | 事务 commit 时 fsync 对应 WAL 段（或配置 `sync: 'batch'`） |
| 缓冲 | 每表 buffer，满 N 条或超时 flush |
| 恢复 | 启动时扫描未 checkpoint 的 WAL，重放已提交、丢弃未提交 |
| Checkpoint | 将已提交变更合并进主存文件，裁剪旧 WAL；间隔默认 30s |

Checksum 使用 CRC32 或 BLAKE3（实现时二选一，全库统一）。

### 4.4 Delta / 快照

- 每次变更追加最小化 Delta（只存变更字段 + op）
- Delta 条数 ≥ 阈值（默认 1000）→ 打 Snapshot → 清理过旧 Delta（保留策略服务 TimeTravel）
- Snapshot 含：文档全集或列存文件清单 + 校验和

### 4.5 分层存储（热/温/冷）

| 层级 | 访问频率启发式 | 策略 |
|------|----------------|------|
| hot | 高频 | 无压缩 / L1 常驻 |
| warm | 中频 | 轻量压缩（字典 / delta） |
| cold | 低频 | gzip/zstd + 可迁外部目录 |

访问计数来自 Cache/Monitor；迁移在后台任务执行，避免阻塞写路径。

### 4.6 压缩策略

对齐大纲与「智能压缩」差异化：

| 数据类型 | 算法 |
|----------|------|
| 数值序列 | 差分 + 变长整数 |
| 低基数字符串 | 字典编码 |
| 长串重复 | RLE / front-coding |
| 通用 | zstd 或 gzip |

提供 `IntelligentCompression.autoCompress(data)`：采样窗口评估压缩比后选定算法，并写入块头 `algo` 字段便于解压。

### 4.7 加密（可选）

- 算法：AES-256-GCM
- 存储：`{ iv, tag, ciphertext }`；密钥仅来自配置/环境变量，**禁止写入仓库**
- 粒度：集合级或备份文件级；热路径默认关闭

---

## 5. 查询引擎详细设计

### 5.1 查询语言优先级

1. **JSON Query（主）** — 结构化、易生成、易优化  
2. **JSONPath** — 嵌套路径、过滤  
3. **SQL 子集（兼容）** — `SELECT/WHERE/ORDER BY/LIMIT`、简单 JOIN

JSON Query 形态示例：

```json
{
  "collection": "users",
  "filter": { "age": { "$gt": 25 }, "tags": { "$contains": "vip" } },
  "projection": ["name", "age"],
  "orderBy": [{ "age": "desc" }],
  "limit": 50,
  "offset": 0
}
```

聚合管道阶段：`match → group → sort → limit → project → unwind → lookup`（与大纲一致）。

### 5.2 解析 → 计划 → 执行

```
source → AST → LogicalPlan → Optimizer → PhysicalPlan → Executor → Result
```

**Optimizer 规则（v1 最小集）**

- 谓词下推
- 投影裁剪（列存时跳过无用列）
- 索引选择（代价：选择率 × 索引类型权重）
- 常量折叠 / 参数绑定
- 限制 LIMIT 早停

### 5.3 JSONPath 原生编译

1. Tokenize → PathTree  
2. `generateNativeFunction`：`new Function('doc','params', body)`（或预编译为闭包树，避免字符串注入）  
3. 编译结果 LRU 缓存  
4. **安全**：禁止用户输入直接拼进 Function；仅允许引擎生成的白名单操作符

> 实现注意：大纲中的 `new Function` 有注入风险，生产实现应改为**安全的表达式树解释器 + 可选 AOT 到受控函数**，性能用基准验证后再放开 JIT。

### 5.4 执行器能力清单

| 能力 | Phase |
|------|-------|
| 过滤 / 投影 / 排序 / 分页 | P1 |
| group 聚合（sum/avg/min/max/count/push） | P1 |
| unwind 数组 | P2 |
| lookup 联接（内存哈希索引） | P2 |
| 向量化批处理（按 chunk） | P3 |
| 查询超时与取消 | P1 |

### 5.5 Query Advisor 与 Profiler（超越 EXPLAIN）

- **Profiler**：parse / optimize / indexScan / dataLoad / execute 分段耗时 + 内存增量  
- **Advisor**：索引建议、结构改写、替代 JSONPath、预估代价；结果可写入 Monitor 供 AutoTune 使用  
- Admin API：`POST /advise`、`POST /profile`

---

## 6. 索引层详细设计

### 6.1 索引类型与选型

| 类型 | 适用 | 复杂度目标 |
|------|------|------------|
| ObjectIndex (Map) | 低基数等值 | O(1) 等值 |
| TreeIndex (B+Tree) | 有序数值/范围 | O(log n) |
| InvertedIndex | 文本检索 | 相关度排序 |
| CompositeIndex | 多字段联合过滤 | 前缀匹配 |
| GeoIndex | GeoJSON | Phase 4 |
| AutoIndex | 包装上述自动选择 | — |

`autoSelectIndexType`：用字段统计（distinct、是否数值、平均长度、是否 geo）决策。

### 6.2 索引生命周期

- 创建：全表 build → 写 `indexes.json` → 内存挂载  
- 更新：随写路径增量更新（同一事务内与数据同成败）  
- 删除：标记 + 后台清理  
- 优化：合并碎片、重建过大索引；可由 AutoOptimizer 触发  

慢查询驱动：Monitor 收集 duration > threshold 的查询字段 → `optimizeIndexes` 推荐或自动创建（需配置 `autoIndex: true`）。

### 6.3 B+Tree 实现要点

- order 默认 128（可配置）  
- 存 `key → _id[]`，回表取文档  
- 支持 `search` / `rangeSearch`  
- 持久化：Phase 1 可仅内存 + 启动重建；Phase 2 落盘分段以加速大表启动

### 6.4 倒排索引要点

- 分词：空白/标点；中文可后续接 jieba 类插件  
- 停用词表可配置  
- TF-IDF 或仅 IDF 打分；`limit` 截断  
- 批量 `IN (_id…)` 回表

---

## 7. 缓存、并发与事务

### 7.1 多级缓存

| 级 | 实现 | 默认 |
|----|------|------|
| L1 | 进程内 Map + LRU | 开 |
| L2 | 更大内存区或 mmap 映射热块 | 开（可与 L1 合并为两档） |
| L3 | Redis 等 | 关（可选依赖） |

策略：命中提升；写入/更新按 collection 模式失效；热 key 访问计数；大 value 可压缩。  
**一致性**：任何写成功后必须 invalidate 相关 key，禁止脏读缓存（在 READ_COMMITTED 及以上）。

### 7.2 锁与 MVCC

- 资源粒度：collection → document（渐进细化）  
- 读多写少：读写锁；写互斥  
- **MVCC 快照**：事务开始记录 `snapshotTs` / 活跃 tx 集合；读只见已提交且对快照可见的版本  
- 乐观锁：更新时校验 `_version`，冲突抛可重试错误  
- 死锁：等待图环检测；牺牲者回滚并返回明确错误码  

隔离级别映射：

| 级别 | 行为（v1） |
|------|------------|
| READ_UNCOMMITTED | 可读未提交（默认不推荐，仅调试） |
| READ_COMMITTED | 默认；每次读最新已提交 |
| REPEATABLE_READ | 快照读 |
| SERIALIZABLE | 范围锁或冲突检测升级（Phase 3 完善） |

### 7.3 事务管理

API：`begin` / `commit` / `rollback`；支持嵌套则要么禁止要么 savepoint（v1 **禁止嵌套**，简化）。

Commit 流程：

1. `validateTransaction`（版本与约束）  
2. `applyChange` 写存储  
3. `writeTransactionWAL` + fsync（按配置）  
4. 更新索引、失效缓存  
5. 释放锁、清理 tx  

Rollback：逆序 revert；或丢弃未落主存的意图日志。

---

## 8. 运维、备份与差异化能力

### 8.1 备份与恢复

| 类型 | 内容 | 用途 |
|------|------|------|
| full | 全量导出 + 压缩(+可选加密) | 基线 |
| incremental | 自上次备份以来的 changes | 日常 |
| differential | 自上次 full 以来的 changes | 折中 |

恢复：完整恢复 / 按表 partial / **PITR**（full + 顺序应用 delta 至目标时间）。  
保留策略：`keepDays`、最大份数；备份 manifest 含 checksum。

### 8.2 时间旅行（TimeTravel）

依赖 Delta + Snapshot：

- `queryAtTime(collection, ts, query)`  
- `diffBetweenTimes(from, to)` → added/removed/modified  
- `rollbackToTime`（危险操作，需显式确认 + 审计日志）  

保留窗口默认 7 天，与备份策略协调。

### 8.3 监控、健康检查、自动调优

**Monitor 指标**：QPS、延迟分布、缓存命中、锁等待、WAL 长度、错误率、表/索引统计。  

**告警规则（可配置）**：缓存命中 < 0.7、P99 延迟、错误率等。  

**HealthCheck**：storage 可写、内存水位、缓存、连接/锁数量、复制状态（若启用）。  

**AutoTuning / AutoOptimizer**：

1. 对比 baseline  
2. 识别瓶颈（cache / query / storage）  
3. 生成计划（扩缓存、建索引、压缩策略）  
4. 灰度应用 + 验证；失败回滚  
5. 记录 tuningHistory  

### 8.4 流处理与数据质量

- **StreamProcessor**：订阅 `dataChanged`，滑动窗口聚合，WebSocket 推送  
- **DataQualityAnalyzer**：完整度/一致性/唯一性等评分 + 建议；自动修复默认关闭，仅提供 API

### 8.5 Admin 与 API

| 端点/能力 | 说明 |
|-----------|------|
| REST CRUD / query | 应用接入 |
| WS `/stream` | 变更与指标推送 |
| `/admin/*` | 仪表盘、查询台、表管理、备份、设置 |
| CLI `jsql` | open / query / backup / restore / doctor |

安全：Admin 默认绑定 localhost；生产必须 Token/TLS。

### 8.6 插件系统

扩展点：`index` | `storage` | `queryLanguage` | `compression` | `backup`。  
`registerPlugin` 校验名称、版本与钩子；错误隔离，避免拖垮引擎。

---

## 9. 配置模型

以 `config.example.json` 为模板（与大纲对齐并补全实现所需字段）：

```json
{
  "storagePath": "./data",
  "walMode": true,
  "checkpointInterval": 30000,
  "sync": "fsync",
  "cache": {
    "l1Size": 1000,
    "l2Size": 10000,
    "l3": { "enabled": false, "type": "redis", "host": "127.0.0.1", "port": 6379 }
  },
  "autoIndex": false,
  "autoIndexThreshold": 1000,
  "compressionThreshold": 1048576,
  "encryptionKeyEnv": "JSONSQLITE_KEY",
  "queryTimeout": 30000,
  "transaction": {
    "defaultIsolation": "READ_COMMITTED",
    "timeoutMs": 30000
  },
  "backup": {
    "enabled": true,
    "interval": 3600000,
    "keepDays": 30,
    "compression": true,
    "encryption": false
  },
  "monitoring": {
    "enabled": true,
    "metricsInterval": 60000,
    "slowQueryThreshold": 100,
    "alerts": {
      "cacheHitRate": 0.7,
      "responseTime": 1000,
      "errorRate": 0.05
    }
  },
  "optimization": {
    "autoOptimize": false,
    "optimizeInterval": 300000
  },
  "timeTravel": {
    "enabled": true,
    "retentionMs": 604800000
  },
  "http": {
    "enabled": false,
    "host": "127.0.0.1",
    "port": 3000,
    "adminToken": null
  }
}
```

---

## 10. 分阶段实施计划

### 总览甘特（逻辑周，可按人力伸缩）

| Phase | 名称 | 目标周期 | 交付物 |
|-------|------|----------|--------|
| **P0** | 工程基线 | 1 周 | TS 工程、可 publish 的 package 契约、CI、空引擎 + pack 冒烟 |
| **P1** | 最小可用库 | 3–4 周 | 文档存储、CRUD、JSON 查询、WAL、基础事务；可本地 `npm pack` 装进示例后端 |
| **P2** | 性能与索引 | 3 周 | 多类索引、缓存、优化器、聚合、基准 |
| **P3** | 生产加固 | 3 周 | 备份恢复、监控、健康检查、加密、CLI/HTTP |
| **P4** | 差异化体验 | 3 周 | Admin UI、Advisor、TimeTravel、流式、质量分析 |
| **P5** | 扩展与分布式雏形 | 4+ 周 | 列存/分层、插件完善、异步复制/分片原型 |

---

### Phase 0 — 工程基线

**任务**

- [ ] 初始化 TypeScript ESM、ESLint、Vitest、pnpm  
- [ ] 目录骨架与 `JSONSQLite` 空壳（EventEmitter 生命周期）  
- [ ] **按可发布库配置** `package.json`：`name`、`exports`、`files`、`engines`、`publishConfig`  
- [ ] 构建链路：产出 `dist` 的 ESM + CJS + `.d.ts`  
- [ ] `config` 加载与校验（zod 或类似）  
- [ ] CI：lint + test + build  
- [ ] 编码规范与错误码枚举  
- [ ] 公共 API 仅从 `src/index.ts` 导出（白名单）  

**验收**：

- `pnpm test` 通过；`await open(...)` / `new JSONSQLite().open()` 可创建数据目录  
- `pnpm pack` 后在临时目录安装 tarball，ESM `import` 与 CJS `require` 均成功（见《npm包与后端接入说明》§9）

---

### Phase 1 — 最小可用（MVP）

**任务**

- [ ] Catalog：创建/列出/删除 collection  
- [ ] Document 存储（JSONL 分片）+ `_id`/`_version`  
- [ ] `insert/update/delete/find` Library API  
- [ ] JSON Query 解析与内存过滤执行  
- [ ] WAL append + 启动恢复  
- [ ] 单写者事务（BEGIN/COMMIT/ROLLBACK）+ READ_COMMITTED  
- [ ] 简单文件锁（防多进程误开同一库，先拒绝后进阶）  
- [ ] `apps/examples`：最少一个 Express（或原生 http）示例，依赖本地 pack/`workspace:` 的 core  
- [ ] 包内 `README.md` 初稿：安装命令、30 秒快速开始、单写者限制  

**验收**

- 崩溃注入测试：kill -9 后重启，已提交数据在、未提交不在  
- 单测覆盖 CRUD + 基础 filter  
- 示例脚本可跑通  
- 在**全新空目录**安装 `pnpm pack` 产物后，示例后端可完成 insert/query（模拟真实 `npm i`）  

**非目标**：索引、HTTP Admin、列存、集群、正式 npm 公网发布（公网可在本阶段末发 alpha）。

---

### Phase 2 — 索引与查询性能

**任务**

- [ ] ObjectIndex / TreeIndex / InvertedIndex（基础）  
- [ ] IndexManager + 写路径增量更新  
- [ ] L1/L2 缓存 + 失效  
- [ ] Planner：索引选择、LIMIT 早停  
- [ ] 聚合管道 match/group/sort/limit/project  
- [ ] JSONPath 安全执行器  
- [ ] `apps/bench`：点查、范围、写入、并发读  

**验收**：达到 §1.3 中点查与批量写入的阶段性指标（可先以 10 万行为门槛，再扩到 100 万）。

---

### Phase 3 — 生产加固

**任务**

- [ ] MVCC 快照读 + 死锁检测  
- [ ] 乐观锁冲突错误码与重试文档  
- [ ] BackupManager：full / incremental / PITR  
- [ ] Monitor + HealthCheck + 慢查询日志  
- [ ] 可选 AES-GCM  
- [ ] CLI：doctor / backup / restore / query  
- [ ] HTTP API（localhost）+ 基础鉴权  
- [ ] 故障手册（docs）  

**验收**

- 备份恢复演练通过  
- `/health` 可用于编排探活  
- 并发测试：多读者 + 单/多写者压力下无损坏  

---

### Phase 4 — 超越 SQLite 的体验能力

**任务**

- [ ] Admin Web：指标卡、实时查询、慢查询、索引建议、备份页  
- [ ] WebSocket 指标与 dataChanged 推送  
- [ ] QueryAdvisor + Profiler API  
- [ ] TimeTravel API  
- [ ] StreamProcessor 滑动窗口示例  
- [ ] DataQuality 分析报告  
- [ ] AutoTuning（默认关闭，文档说明风险）  

**验收**：演示脚本 10 分钟内展示「监控 → 慢查询 → 建索引建议 → 备份恢复 → 时间点查询」。

---

### Phase 5 — 扩展与分布式雏形

**任务**

- [ ] 列存写路径/读投影、分层 hot/warm/cold  
- [ ] 插件：自定义索引（含 vector 占位）、S3 冷存储示例  
- [ ] 异步主从复制 + Quorum 可配置（弱一致文档化）  
- [ ] 分片路由原型（hash/range）  
- [ ] GeoIndex（可选）  
- [ ] SQL 子集扩大与更好的错误提示  

**验收**：三节点异步复制 demo；列存聚合对比文档模式有可测加速。

---

## 11. 关键实现顺序（开发依赖图）

```
Config/Types
    → Storage(Document) → WAL/Recovery
        → Transaction(粗粒度锁)
            → Query(JSON filter)
                → IndexManager
                    → Cache + Optimizer
                        → Monitor/Backup
                            → HTTP/CLI/Admin
                                → TimeTravel/Stream/Advisor
                                    → Columnar/Cluster/Plugins
```

并行建议：

- A：存储 + WAL  
- B：查询解析（用内存 fixture）  
- A+B 合并后接事务  
- 其后索引与缓存可两人并行  

---

## 12. 测试与质量策略

### 12.1 测试金字塔

| 类型 | 内容 |
|------|------|
| 单元 | 压缩、分词、B+Tree、解析器、锁图环检测 |
| 集成 | 开库→写→杀进程→恢复；事务冲突；缓存失效 |
| 属性/模糊 | 随机文档 + 随机查询与过滤等价性 |
| 性能 | bench 套件入 CI（阈值阈值，防回退） |
| 包装烟 | `pnpm pack` → 空项目安装 → ESM/CJS 调用；防发错包 |
| 混沌 | WAL 截断、磁盘满、权限错误 |

### 12.2 正确性红线

- 已提交事务崩溃后必须可恢复  
- 同一 `_id` 版本单调递增  
- 索引与主数据最终一致（提交后立即一致）  
- 备份 checksum 校验失败则拒绝恢复  

### 12.3 对标基准场景（对齐大纲）

实现 `apps/bench`，输出可比表格（自身版本对比 + 可选 better-sqlite3）：

1. 点查询 100 万  
2. 范围查询  
3. 全文搜索 10 万  
4. 批量插入 10 万  
5. 并发读 100  
6. 并发写 100  

**说明**：大纲中的绝对数字仅作方向参考；以本机基准与回归阈值为准，避免虚假宣传。

---

## 13. 风险、权衡与缓解

| 风险 | 影响 | 缓解 |
|------|------|------|
| 用 JS 追求「全面超越 SQLite 性能」不现实 | 预期落差 | 对外强调体验/JSON/运维优势；性能对标「同场景文档库」 |
| `new Function` 安全问题 | RCE | 安全 AST 执行；JIT 仅内部白名单 |
| 功能范围过大 | 无法交付 | 严格按 Phase；P5 不阻塞 v1.0 |
| JSON 全表可读带来的敏感数据暴露 | 安全 | 加密、文件权限、Admin 鉴权 |
| 多进程写 | 损坏 | v1 单进程写 + 文件锁；分布式锁放 P5 |
| 自动建索引/自动调优误伤 | 写放大 | 默认关闭；仅建议；需显式开启 auto |
| 误 publish 整个 monorepo / 打进 data、密钥 | 供应链事故 | root `private`；`files` 白名单；CI pack 审查 |
| 用户把嵌入式库当多实例共享 DB | 数据损坏 | README/限制说明置顶；文件锁拒绝第二写者 |

---

## 14. 里程碑定义（发布标签）

| Tag | 含义 | npm |
|-----|------|-----|
| `v0.1.0-alpha.x` | P1 可 pack 嵌入试用 | 可选 publish（tag `alpha`） |
| `v0.1.0` | P1 MVP：可嵌入的 JSON 文档库 + WAL | 可正式 `0.x` 发布 |
| `v0.2.0` | P2：索引 + 缓存 + 聚合 + bench | MINOR |
| `v0.3.0` | P3：备份/监控/HTTP/CLI → **生产可用候选** | MINOR |
| `v1.0.0` | P3 稳定 + P4 核心体验（Admin + PITR + Advisor） | **稳定 API + 磁盘格式承诺** |
| `v1.x` | P5 增量：列存、插件、复制 | MINOR / 必要时 MAJOR |

发布流程与 tarball 检查清单见《npm包与后端接入说明》§8–§9。

---

## 15. 近期立即执行的 Checklist（本周可开工）

1. 搭建 TypeScript 包骨架与 Vitest（单包或 `packages/core`）  
2. 写好可发布的 `package.json`（`exports` / `files` / `engines`）与 build（esm+cjs+dts）  
3. `pnpm pack` + 临时目录安装冒烟（先于业务功能）  
4. 实现 `storagePath` 目录约定与 `catalog.json`  
5. 实现 JSONL 文档存储 + 内存 `find`  
6. 实现 WAL 与崩溃恢复最小闭环  
7. 编写第一个集成测试：`insert → kill 模拟 → recover → assert`  
8. 维护根 README + 包内 README，并链到本方案与《npm包与后端接入说明》  

---

## 16. 与源文档的映射

| 源文档主题 | 本方案落点 |
|------------|------------|
| 七层架构 | §2、§3 |
| AdaptiveStorage / WAL / 压缩 / 加密 | §4 |
| QueryEngine / JSONPath / 聚合 | §5 |
| IndexManager 多索引 | §6 |
| MultiLevelCache / Lock / MVCC / Tx | §7 |
| Backup / Monitor / AutoOptimizer | §8 |
| 配置与启动 | §9、§3.4 |
| 基准与场景 | §1.3、§12.3 |
| Admin / Advisor / AutoTune | §5.5、§8.3–§8.5、P4 |
| 分布式 / 时间旅行 / 流 / 质量 | §8.2–§8.4、P4–P5 |
| 插件系统 | §8.6、P5 |
| **npm 安装 / 后端嵌入 / 发布** | **§1.5、§3.1、§3.3 +《npm包与后端接入说明》** |

---

## 17. 结论

本方案将愿景收敛为：

1. **交付上**：做成可 `npm install` 的 Node.js 嵌入式库（`@jsonsqlite/core`），业务后端进程内使用  
2. **引擎上**：先做对单机正确性与可运维性，再叠加索引与查询性能  
3. **体验上**：再交付相对 SQLite 的差异化（Admin、Advisor、TimeTravel 等）  
4. **规模上**：分布式仅作后续演进  

建议第一个对外可感知里程碑 = **Phase 1 功能 + 本地 pack 可被示例后端安装**；正式公网 npm 可在 alpha → `0.1.0` 节奏推进。避免并行铺开集群与列存导致核心路径与包契约长期不稳定。

---

*文档维护：随实现进展更新 Phase 勾选状态与基准数字；重大架构变更需同步修订 §4–§7；包名/exports/发布流程变更需同步《npm包与后端接入说明》。*
