# json-sqlite（JSONSQLite）

基于 JSON 文件的嵌入式数据库引擎，面向 **Node.js 后端**：未来通过 npm 安装进业务工程，在进程内打开本地数据目录使用（类似 better-sqlite3 的依赖角色，而非默认独立部署的网络数据库）。

> 当前仓库处于**方案与设计阶段**，实现代码尚未落地。请先阅读下列文档。

## 文档索引

| 文档 | 内容 |
|------|------|
| [JSONSQLite 技术实现方案与计划.md](./JSONSQLite%20技术实现方案与计划.md) | 架构、模块、分阶段实施与验收 |
| [JSONSQLite npm包与后端接入说明.md](./JSONSQLite%20npm包与后端接入说明.md) | **`npm i` 交付形态**、包契约、后端嵌入、发布清单 |
| [JSONSQLite 生产级实现大纲.md](./JSONSQLite%20生产级实现大纲.md) | 原始能力大纲与组件草图 |
| [JSONSQLite vs SQLite - 超越的可能性.md](./JSONSQLite%20vs%20SQLite%20-%20超越的可能性.md) | 相对 SQLite 的差异化方向 |

## 目标用法（实现后）

```bash
npm install @jsonsqlite/core
# 包名以发布前确认为准，方案中推荐 @jsonsqlite/core
```

```ts
import { open } from '@jsonsqlite/core';

const db = await open({ storagePath: './data' });
await db.insert('users', { name: '寒', age: 30 });
const rows = await db.query({
  collection: 'users',
  filter: { age: { $gte: 18 } },
});
await db.close();
```

要点：

- **嵌入式**：装进 Express / Nest / Fastify 等后端即可，无需先起独立 DB 进程  
- **本地目录**：数据落在 `storagePath`；容器需挂载持久卷  
- **单写者（v1）**：同一数据目录同一时刻仅一个写进程  

完整约定见《npm包与后端接入说明》。

## 路线图（摘要）

1. **P0** — 工程基线 + 可 `pnpm pack` 的包契约  
2. **P1** — WAL + CRUD + JSON Query（可被示例后端本地安装）  
3. **P2** — 索引 / 缓存 / 聚合  
4. **P3** — 备份、监控、CLI/HTTP → 生产候选  
5. **P4+** — Admin、时间旅行等体验能力；其后分布式雏形  

## License

见 [LICENSE](./LICENSE)。
