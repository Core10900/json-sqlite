# JSONSQLite：npm 包与 Node.js 后端接入说明

> 文档版本：v1.0  
> 配套：《JSONSQLite 技术实现方案与计划》§1.5、§3  
> 目标：明确未来以 **`npm install`** 方式嵌入 Node.js 后端工程时的包形态、API 契约、工程约束与发布流程。  
> 状态：实现前规范（包名等以首次发布前最终确认值为准）。

---

## 1. 交付形态总览

JSONSQLite 的**主交付物**是一个可安装的 **Node.js 库（Library）**，而不是必须独立部署的数据库服务。

| 形态 | 说明 | 是否 v1 必达 |
|------|------|--------------|
| **npm 库（嵌入式）** | `import { JSONSQLite } from '...'`，进程内打开本地数据目录 | ✅ 主路径 |
| **CLI 二进制** | 随包提供 `jsql`（`bin` 字段），便于运维与调试 | ✅ 建议同包或同 scope 子包 |
| **可选 HTTP/Admin** | 由业务进程调用 `db.startServer()` 或单独 `jsonsqlite-server` | ⚪ 可选，默认不监听端口 |
| **独立守护进程** | 类似 mongod 的长驻服务 | ❌ 非 v1 目标 |

与 better-sqlite3 / lowdb / Level 类似：**装进业务后端 → 在进程内读写磁盘上的数据目录**。

```
┌─────────────────────────────────────┐
│  你的 Node.js 后端（Express/Nest/…） │
│  ┌───────────────────────────────┐  │
│  │  jsonsqlite（npm 依赖）        │  │
│  │  内存引擎 + 本地 data/ 目录    │  │
│  └───────────────────────────────┘  │
└─────────────────────────────────────┘
```

---

## 2. 包命名与仓库策略

### 2.1 推荐包名（发布前需在 npm 确认可用性）

| 候选 | 说明 |
|------|------|
| `@jsonsqlite/core` | **推荐**：scoped，主库；后续可加 `@jsonsqlite/cli`、`@jsonsqlite/server` |
| `jsonsqlite` | 短名，若未被占用可作「聚合/便捷包」re-export core |
| `json-sqlite` | 与当前仓库名一致；注意与已有包冲突风险 |

**约定（方案锁定建议）**：

- 对外主包名：**`@jsonsqlite/core`**（实现阶段可先用，发布前再最终确认）
- 仓库名可继续为 `json-sqlite`
- 若提供无 scope 便捷包 `jsonsqlite`，其内容仅为：

```ts
export * from '@jsonsqlite/core';
```

### 2.2 Monorepo 与「谁被 publish」

```
json-sqlite/                          # Git 仓库（不必整体 publish）
├── packages/
│   └── core/                         # ✅ npm publish → @jsonsqlite/core
│       ├── package.json              # name/version/exports/files
│       ├── src/                      # 源码（一般不进 npm，除非走 exports 源码方案）
│       └── dist/                     # ✅ 发布产物
├── apps/
│   ├── cli/                          # 可合并进 core 的 bin，或单独 @jsonsqlite/cli
│   └── bench/                        # ❌ private，不发布
├── docs / *.md                       # ❌ 不随包发布（README 除外）
└── package.json                      # private: true（workspace root）
```

**原则**：

- Workspace **root 必须** `"private": true`，防止误发整个 monorepo
- 只有 `packages/core`（及后续明确标记的包）执行 `pnpm publish`
- 测试、基准、设计文档、示例应用默认不进 tarball

### 2.3 初期亦可「单包仓库」

若早期不想上 monorepo，可采用：

```
json-sqlite/
├── package.json          # name: @jsonsqlite/core，可直接 publish
├── src/
├── dist/
└── ...
```

与最终目标兼容：单包阶段就把 `name` / `exports` / `files` 按生产库标准写好，日后迁到 `packages/core` 时改 path 即可。

---

## 3. 安装与运行时要求

### 3.1 消费者安装

```bash
# npm
npm install @jsonsqlite/core

# pnpm
pnpm add @jsonsqlite/core

# yarn
yarn add @jsonsqlite/core
```

开发期未发布到 npm 时，可用本地/ Git 依赖：

```bash
# 本地路径（联调）
pnpm add @jsonsqlite/core@link:../json-sqlite/packages/core

# Git（示例）
pnpm add github:your-org/json-sqlite#path:packages/core
```

### 3.2 engines 约束

| 项 | 要求 | 说明 |
|----|------|------|
| Node.js | `>=20` | 与方案一致；用 `engines.node` 声明 |
| 模块系统 | **ESM 优先** | `"type": "module"`；另见双格式导出 |
| 原生插件 | **默认无** | 纯 JS/TS 编译产物，降低安装失败率 |
| 可选依赖 | Redis 等 | 标为 `optionalDependencies` 或 peerOptional，缺省不影响主路径 |

```json
{
  "engines": {
    "node": ">=20"
  }
}
```

### 3.3 依赖分级（发布包）

| 类型 | 放什么 | 示例 |
|------|--------|------|
| `dependencies` | 运行必需且体积可控 | 自研无重依赖为佳；确需则锁定小库 |
| `optionalDependencies` | L3 Redis 客户端等 | 装不上也不阻断 install |
| `peerDependencies` | 无强绑定框架 | **不要**强绑 Express/Nest |
| `devDependencies` | 仅开发/构建/测试 | **不得**出现在消费者 `node_modules` 运行链上 |

**禁止**：把 Vitest、ESLint、TypeScript（若仅作编译器）打进 runtime dependencies。

---

## 4. package.json 发布契约（核心字段）

以下为 **`packages/core/package.json` 目标形态**（字段级规范，实现时照此落地）：

```json
{
  "name": "@jsonsqlite/core",
  "version": "0.1.0",
  "description": "JSON-native embedded database for Node.js with WAL, indexes, and ops tooling",
  "license": "MIT",
  "author": "",
  "repository": {
    "type": "git",
    "url": "git+https://github.com/<org>/json-sqlite.git",
    "directory": "packages/core"
  },
  "homepage": "https://github.com/<org>/json-sqlite#readme",
  "bugs": {
    "url": "https://github.com/<org>/json-sqlite/issues"
  },
  "keywords": [
    "database",
    "json",
    "embedded",
    "sqlite",
    "document-store",
    "nodejs",
    "wal"
  ],
  "type": "module",
  "main": "./dist/index.cjs",
  "module": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js",
      "require": "./dist/index.cjs"
    },
    "./package.json": "./package.json"
  },
  "bin": {
    "jsql": "./dist/cli.js"
  },
  "files": [
    "dist",
    "LICENSE",
    "README.md"
  ],
  "sideEffects": false,
  "engines": {
    "node": ">=20"
  },
  "publishConfig": {
    "access": "public"
  },
  "scripts": {
    "build": "tsup src/index.ts --format esm,cjs --dts --clean",
    "prepublishOnly": "pnpm run build && pnpm test"
  }
}
```

### 4.1 字段要点说明

| 字段 | 要求 |
|------|------|
| `exports` | **唯一入口真相**；禁止消费者深路径 `import '.../dist/foo'`（除非显式开放子路径） |
| `files` | 白名单；确保 `src/`、`test/`、`.ts` 源码、设计 md 默认不进包 |
| `types` / `exports.types` | 必须带 `.d.ts`，TS 后端开箱有类型 |
| ESM + CJS | 双构建，兼容 `"type":"commonjs"` 的老项目 `require()` |
| `bin` | CLI 可选；若拆包则 core 可不带 bin |
| `sideEffects: false` | 利于 bundler tree-shaking（若有人打包进工具链） |
| `prepublishOnly` | 发布前强制 build + test，防止发空包 |

### 4.2 明确不导出的内容

- 内部模块：`storage/*`、`concurrency/*` 等默认 **不** 进 public exports  
- 若需要高级扩展（插件作者），另开稳定子路径，例如：

```json
"exports": {
  ".": { "...": "..." },
  "./plugin": {
    "types": "./dist/plugin/index.d.ts",
    "import": "./dist/plugin/index.js",
    "require": "./dist/plugin/index.cjs"
  }
}
```

子路径一经发布即视为 **semver 公共 API**，需谨慎增加。

---

## 5. 公共 API 表面（消费者能用什么）

### 5.1 推荐默认导入

```ts
import { JSONSQLite, open } from '@jsonsqlite/core';
import type { JSONSQLiteOptions, Document, QueryResult } from '@jsonsqlite/core';
```

### 5.2 最小稳定 API（v0.1 / v1.0 承诺方向）

| API | 职责 |
|-----|------|
| `open(options)` / `new JSONSQLite(options).open()` | 打开/创建数据目录，完成 WAL 恢复 |
| `db.close()` | 优雅关闭 |
| `db.collection(name)` 或 `db.table(name)` | 集合句柄 |
| `insert` / `update` / `delete` / `upsert` | 写入 |
| `find` / `query` | 查询（JSON Query / JSONPath / SQL 子集） |
| `beginTransaction` / `commit` / `rollback` | 事务 |
| `createIndex` / `listIndexes` | 索引 |
| `backup` / `restore` | 备份恢复（可阶段性开放） |
| 事件：`ready` / `error` / `dataChanged` / `metrics` | 可观测与实时 |

**稳定 API 白名单**应维护在 `packages/core/src/index.ts` 的显式 export 列表中；未导出即非公共约定。

### 5.3 后端嵌入示例（目标用法，非当前已实现代码）

**Express**

```ts
import express from 'express';
import { open } from '@jsonsqlite/core';

const app = express();
app.use(express.json());

const db = await open({
  storagePath: process.env.JSONSQLITE_PATH ?? './data/jsonsqlite',
  walMode: true,
});

app.post('/users', async (req, res) => {
  const user = await db.insert('users', req.body);
  res.status(201).json(user);
});

app.get('/users', async (req, res) => {
  const rows = await db.query({
    collection: 'users',
    filter: req.query.q ? { name: { $contains: String(req.query.q) } } : {},
    limit: 50,
  });
  res.json(rows);
});

process.on('SIGINT', async () => {
  await db.close();
  process.exit(0);
});

app.listen(3000);
```

**NestJS（Provider 注入）**

```ts
// jsonsqlite.module.ts（业务侧自行封装）
import { Global, Module, OnModuleDestroy } from '@nestjs/common';
import { open, type JSONSQLite } from '@jsonsqlite/core';

export const DB = Symbol('JSONSQLITE');

@Global()
@Module({
  providers: [
    {
      provide: DB,
      useFactory: async () =>
        open({ storagePath: process.env.JSONSQLITE_PATH ?? './data' }),
    },
  ],
  exports: [DB],
})
export class JsonSqliteModule implements OnModuleDestroy {
  constructor(private readonly db: JSONSQLite) {}
  async onModuleDestroy() {
    await this.db.close();
  }
}
```

> 官方可在后续提供 `@jsonsqlite/nestjs` 可选包；**v1 不强制**，避免 peer 依赖绑架框架。

### 5.4 进程生命周期约定（后端必读）

1. **单进程单库路径**：同一 `storagePath` 同一时刻只应有一个写者进程（v1 用文件锁拒绝第二个）  
2. **启动**：`await open()` 完成后再接流量  
3. **关闭**：在 `SIGINT` / `SIGTERM` / 框架 shutdown hook 中 `await db.close()`，确保 WAL flush  
4. **数据目录**：应落在持久卷（容器需 mount volume）；不要把 `data/` 打进镜像可写层当唯一存储  
5. **多实例水平扩展**：嵌入式库 ≠ 共享磁盘多写；多副本需外部策略或未来复制功能（见实现方案 Phase 5）

---

## 6. 与「服务端模式」的边界

| 模式 | 用法 | 适用 |
|------|------|------|
| **嵌入式（默认）** | 业务 `npm i` 后进程内调用 | 绝大多数 Node 后端、单机、边车同机 |
| **同进程 HTTP** | `await db.serve({ port: 3001 })` | 本地 Admin、多语言客户端偶发访问 |
| **独立 Server 包** | `@jsonsqlite/server` 另进程 | 多语言共享、运维隔离（后置） |

文档与 README 必须写清：**默认不是网络数据库**；误当成 Redis/Postgres 多实例直连会导致数据损坏风险。

---

## 7. TypeScript 与双模块格式

### 7.1 类型发布

- 构建生成 `dist/**/*.d.ts`（或打包后的单一 `index.d.ts`）  
- `exports["."].types` 指向类型入口  
- 公共类型：`JSONSQLiteOptions`、`Document`、`IsolationLevel`、错误类等一并导出  

### 7.2 ESM / CJS

| 消费者 | 解析到 |
|--------|--------|
| `import`（ESM） | `dist/index.js` |
| `require`（CJS） | `dist/index.cjs` |

构建工具建议：`tsup` / `unbuild` / `rollup`，一次产出 esm+cjs+dts。

### 7.3 避免的陷阱

- 不要只发 `.ts` 源码让消费者跑 ts-node（安装体验差）  
- 不要使用裸 `exports: "./src/index.ts"` 作为生产默认  
- `package.json` 的 `imports` 内部别名不得泄漏为消费者必配条件  

---

## 8. 版本与兼容性策略

### 8.1 SemVer

| 变更 | 版本 |
|------|------|
| 破坏性 API / 磁盘格式不兼容且无自动迁移 | **MAJOR** |
| 新增 API、新索引类型、向后兼容磁盘扩展 | **MINOR** |
| 修复、性能、文档 | **PATCH** |

### 8.2 磁盘格式版本

- `meta/catalog.json` 中增加 `formatVersion`  
- 新版本引擎打开旧数据：能自动迁移则静默或打日志；不能则明确报错并给出迁移 CLI  
- **格式破坏 = MAJOR**，并在 CHANGELOG / README 置顶说明  

### 8.3 预发布通道

```
0.1.0-alpha.x  →  API 不稳定，磁盘可重置
0.x.x          →  嵌入式可用，API 仍可能微调（跟 CHANGELOG）
1.0.0          →  公共 API + 磁盘格式稳定性承诺
```

---

## 9. 发布流水线（实现阶段验收项）

### 9.1 本地发布检查清单

- [ ] `pnpm build` 产出 `dist` 含 esm/cjs/dts  
- [ ] `npm pack --dry-run` / `pnpm pack` 检查 tarball **仅含** `dist`、LICENSE、README  
- [ ] 在空目录 `npm init -y && npm i ./jsonsqlite-core-x.tgz` 后 `node -e "import('@jsonsqlite/core')"` 成功  
- [ ] CJS 工程 `require('@jsonsqlite/core')` 成功  
- [ ] `engines` 与 README 安装说明一致  
- [ ] README 含：安装、最小示例、数据目录、关闭进程、限制说明  

### 9.2 CI 建议

```text
test → build → pack 产物冒烟 → (tag) npm publish
```

- 仅 `v*` tag 或手动 approval 触发 publish  
- `NPM_TOKEN` 仅存在于 CI secrets  
- scoped 包：`publishConfig.access = public`（若用付费 org 再改）  

### 9.3 发布物内容（允许 / 禁止）

| 允许 | 禁止 |
|------|------|
| `dist/**` | `src/**`（默认） |
| `README.md` / `LICENSE` | 内部设计长文、benchmark 原始数据 |
| 精简 `CHANGELOG.md`（可选） | `.env`、密钥、本地 `data/` |
| | `node_modules`、测试快照私货 |

---

## 10. README（面向 npm 用户）应具备的章节

发布到 npm 的 `packages/core/README.md` 建议结构：

1. 一句话介绍 + Badge（npm version / node engines）  
2. `npm install @jsonsqlite/core`  
3. 30 秒快速开始（open → insert → query → close）  
4. 配置项摘要（链到完整文档）  
5. 与 SQLite / 其他嵌入式库的定位差异（短）  
6. **限制**：单写者、非多实例共享写、Node only  
7. 版本与数据目录兼容性  
8. License  

仓库根 README 可指向：设计方案、npm 接入说明、贡献指南。

---

## 11. 安全与供应链

- 最小依赖；依赖升级进 CHANGELOG  
- 启用 `npm audit`（CI 可 warn/fail 策略另定）  
- 不在包内读未文档化的环境变量写回盘（加密密钥仅文档约定的 `JSONSQLITE_KEY` 等）  
- Admin HTTP 默认 `127.0.0.1`，文档强调生产鉴权  

---

## 12. 与实施计划的衔接

| 阶段 | npm 相关交付 |
|------|----------------|
| **Phase 0** | 定名、`package.json` exports/files、build 出 dist、pack 冒烟 |
| **Phase 1** | 可 `npm pack` 本地安装并完成 CRUD 示例后端 |
| **Phase 2+** | API 稳定化、类型完善 |
| **v0.1 首次 npm 发布** | 建议在 Phase 1 验收后发 alpha/public |
| **v1.0** | API + 磁盘格式 semver 承诺、完整 README |

详细引擎设计见：《JSONSQLite 技术实现方案与计划》。

---

## 13. 结论

JSONSQLite 从第一天就应按 **「可发布的 Node.js 嵌入式库」** 设计：

1. 消费者：`npm i @jsonsqlite/core` → `import { open } from '...'`  
2. 产物：双格式 + TypeScript 类型 + 精简 `files`  
3. 运行：进程内、本地目录、生命周期由业务框架托管  
4. 可选：CLI / HTTP Admin，不改变「库优先」的默认心智  

这样与 better-sqlite3 同属后端依赖生态，同时保留 JSON 原生与运维向差异化能力的扩展空间。
