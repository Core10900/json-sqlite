# json-sqlite（JSONSQLite）

基于 JSON 文件的嵌入式数据库引擎，面向 **Node.js 后端**：`npm i @jsonsqlite/core` 后在进程内打开本地数据目录使用。

## 状态

**v1.0.0** — P0–P4 核心能力已落地（单写者嵌入式库）。

| 阶段 | 状态 |
|------|------|
| P0 工程基线 | ✅ |
| P1 MVP（CRUD / WAL / 事务） | ✅ |
| P2 索引 / 缓存 / 聚合 / bench | ✅ |
| P3 备份 / 监控 / CLI / HTTP | ✅ |
| P4 TimeTravel / Advisor / Admin | ✅ |

## 开发

```bash
pnpm install
pnpm test
pnpm build
pnpm --filter @jsonsqlite/bench start
pnpm --filter @jsonsqlite/example-basic start
```

## 快速使用

```ts
import { open } from '@jsonsqlite/core';

const db = await open({ storagePath: './data' });
await db.insert('users', { name: '寒', age: 30 });
await db.createIndex('users', 'age', 'tree');
const rows = await db.query({
  collection: 'users',
  filter: { age: { $gte: 18 } },
});
await db.close();
```

包文档见 [`packages/core/README.md`](./packages/core/README.md)。

## 文档

| 文档 | 内容 |
|------|------|
| [docs/v1.0 开发计划.md](./docs/v1.0%20开发计划.md) | v1.0 开发计划 |
| [docs/v1.0 功能测试计划.md](./docs/v1.0%20功能测试计划.md) | 功能测试计划 |
| [docs/JSONSQLite 技术实现方案与计划.md](./docs/JSONSQLite%20技术实现方案与计划.md) | 架构方案 |
| [docs/JSONSQLite npm包与后端接入说明.md](./docs/JSONSQLite%20npm包与后端接入说明.md) | npm 接入 |
| [CHANGELOG.md](./CHANGELOG.md) | 变更记录 |

## License

MIT — 见 [LICENSE](./LICENSE)。
