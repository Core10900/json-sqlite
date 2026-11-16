# @webofcat/jsonsqlite-wasm

**experimental · read-only · 3.5.0**

这是 JSONSQLite **3.5** 的可选包：Node 侧只读适配器。包名保留 `@webofcat/jsonsqlite-wasm`，本版**不**提供浏览器 WASM 编译产物；实现为纯 JS，依赖核心包打开已有库目录。

## 重要说明

- **experimental**：实验能力，接口与行为可能调整。
- **只读**：仅支持查询 / 按 id 读取；`insert` / `update` / `delete` 会抛出明确的只读错误。
- **不进入 LTS 写入承诺**：写路径未做与服务端同等的崩溃测试，**不会**进入 3.6 的写入承诺，也不要当作生产写入方案。
- **不进入主 bin**：不会作为 `@webofcat/jsonsqlite` 的 CLI / bin 入口；核心包帮助里没有 wasm 命令。
- **不是** `@webofcat/jsonsqlite` 的 `lts` / `latest` 标签；本包有自己的 npm 包名与版本。

## 安装

```bash
npm i @webofcat/jsonsqlite-wasm
```

需同时安装（或由 peer 拉取）核心包 `@webofcat/jsonsqlite`。

## 用法

```ts
import { openReadonly, meta } from '@webofcat/jsonsqlite-wasm';

console.log(meta);
// { experimental: true, readOnly: true, version: '3.5.0' }

const db = await openReadonly({ storagePath: './data' });

const rows = await db.query({ collection: 'users', filter: { age: { $gte: 18 } } });
const one = await db.findById('users', rows[0]!._id);

// 写入会失败
await db.insert('users', { name: 'x' }); // throws ExperimentalReadonlyError

await db.close();
```

## API

| 导出 | 说明 |
|------|------|
| `openReadonly({ storagePath })` | 打开已有库目录，返回只读门面 |
| `ReadonlyDb.findById` / `query` / `close` | 只读读取与关闭 |
| `ReadonlyDb.insert` / `update` / `delete` | 抛出 `ExperimentalReadonlyError` |
| `meta` | `{ experimental: true, readOnly: true, version: '3.5.0' }` |

## 发布

在 `packages/wasm` 下（仓库根为 private，不能在根目录 publish）：

```bash
pnpm --filter @webofcat/jsonsqlite-wasm publish --access public
```

不要把本包标到 `@webofcat/jsonsqlite` 的 dist-tag。`prepublishOnly` 会先 build 再跑测试。
