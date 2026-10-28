# RFC：恢复、分页与快照（v2.0）

> 状态：随 2.0.0 实现合并  
> 本文件是发版门禁 FT-V20-GATE-01。页大小与文件名以这里为准。

## 页

- `formatVersion` **2**。1.x 的 `formatVersion` 1 不能被 `open` 直接升级，必须走 `migrate`。
- 每个集合：
  - `collections/<name>/docs/pages.json`：`pageSize`、`nextPageId`、`pages[]`、`idToPage`、`docCount`、`revisionSum`
  - `collections/<name>/docs/pages/pNNNNNN.jsonl`：该页的文档，一行一个，编码顺序仍是压缩再加密
- 默认 `pageSize = 32`（文档数），`maxResidentDocs = 256`，且 `maxResidentDocs >= pageSize`。
- 打开集合只读目录。点查按 `idToPage` 读一页。扫描可以逐页读，但页缓存按 LRU 淘汰到预算；脏页先落盘再淘汰。
- 目录（id → 页号）常驻，不计入文档预算。索引段的 `docCount` / `revisionSum` 与目录一致时，reopen 不把整表载入堆。

## 坏 WAL

一行是完整记录，当且仅当它以 `\n` 结束。

- 文件末尾没有换行的残片是**尾部撕裂**：丢弃，已提交的完整前缀可以恢复。
- 任何已换行的行若 JSON 解析失败或 checksum 不符，是**中间损坏**：`open` 抛 `WAL_CORRUPT`，不跳过该行，也不套用它后面的记录。
- `doctor` 用 `torn-tail` 与 `middle` 区分这两种情况。

## 快照与写事务

- 默认 `READ_COMMITTED`。`REPEATABLE_READ` 在 `begin` 复制当时已提交的文档。
- 只读快照可以与至多一个写事务同时存在。快照读（`query` / `findById` 的 `txId`）看不见 begin 之后的提交。
- `SERIALIZABLE` 与 `READ_UNCOMMITTED` 不实现。`begin` 抛 `ISOLATION_UNSUPPORTED`。把它们写成 `defaultIsolation` 抛 `INVALID_CONFIG`。不降级。

## 备份链

- manifest 里的 checksum 是备份文件字节的 sha256。
- 恢复前先校验。不符则抛 `BACKUP_CHECKSUM`，不写目标库。
- `incremental` 恢复 = 最近的全量 + 按 `baseTimestamp` 接上的增量。没有全量基线则抛 `BACKUP_BASELINE`，不部分套用。
- `--collection` 只替换该集合，其它集合保持恢复前的内容。
