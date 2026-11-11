# RFC：异步主从复制雏形（v3.3）

> 状态：随 3.3.0 实现冻结（非 LTS，非设计完工）  
> 本文件是发版门禁 FT-V33-GATE-01。  
> 范围：单机或共享文件系统上的一个主、一个或多个从。没有 Quorum、没有自动选主、没有跨机锁。

## 1. 默认与开关

- 复制**默认关闭**。`config.example.json` 里 `replica` 为 `false`。关闭时行为与 3.2 默认单写者一致，可直接打开 2.5 / 3.2 库。
- 开启复制不是 `open` 的副作用。角色由显式命令 `replica init` 写入 `meta/replica.json`。
- 配置键 `replica` 已移出危险键：可为 `false`，或对象（如 `syncIntervalMs`）。`cluster` / `graphql` / `wasm` 仍拒绝。

## 2. 拓扑与可见性

- 拓扑：一个 **primary**，零个或多个 **secondary**。
- 主库本地提交成功只表示主库已提交，**不**表示从库已经收到或已经应用。
- 从库通过异步拉取主库的复制日志达到**最终可见**。没有同步确认、没有法定人数。

## 3. 复制日志格式（相对 3.2 为 MAJOR）

主库目录下：

| 路径 | 内容 |
|------|------|
| `replication/meta.json` | `{ "formatVersion": 1, "lastLsn": N }` |
| `replication/log.jsonl` | 每行一条已提交变更 |

日志行字段：

```json
{
  "v": 1,
  "lsn": 1,
  "ts": 1730000000000,
  "op": "insert",
  "collection": "users",
  "id": "a",
  "before": null,
  "after": { "_id": "a", "name": "ann" },
  "patch": false
}
```

- `lsn`：主库单调递增的日志序号（从 1 起）。
- `ts`：主库写入该条时的 epoch 毫秒。
- `v` / `formatVersion`：本版为 `1`。后续不兼容变更须升版本。

从库状态在 `meta/replica.json`：

```json
{
  "enabled": true,
  "role": "secondary",
  "primaryPath": "/abs/path/to/primary",
  "appliedLsn": 0,
  "appliedTs": 0,
  "promotedAt": null
}
```

## 4. 滞后（单位写死）

下列三处使用**同一套字段与单位**：

- `replica status`（含 `--json`）
- `getMetrics()` / 监控指标
- `doctor` 的 `replica` 检查，以及 `/health` 在复制开启时的扩展字段

| 字段 | 单位 | 含义 |
|------|------|------|
| `role` | 枚举 | `none` / `primary` / `secondary` |
| `enabled` | 布尔 | 是否已 `replica init` |
| `appliedLsn` | 整数 LSN | 从库已应用的最大 LSN；主库等于 `lastLsn` |
| `lastLsn` | 整数 LSN | 主库日志尖端（从库在上次成功同步时读到的尖端） |
| `lagEntries` | **条数** | `max(0, lastLsn - appliedLsn)` |
| `lagMs` | **毫秒** | `max(0, lastTs - appliedTs)`；无数据时为 `0` |
| `replicatedPrefix` | 整数 LSN | 已安全应用的前缀，等于 `appliedLsn` |

滞后变大时第一步：看 `replica status` 的 `lagEntries` / `lagMs`，确认从库进程仍在、`primaryPath` 可读、主库 `replication/log.jsonl` 在增长。

## 5. 主宕机：不自动选主

1. 主进程退出或被杀死后，**不会**有任何自动提升。
2. 从库停在已复制前缀（`appliedLsn`），继续拒绝写入。
3. 错误码：`REPLICA_READONLY`。没有 `replica promote` 时，从库保持只读前缀。
4. 唯一允许从库变可写的命令：`replica promote`（建议加 `--yes`）。
5. 提升之后：原从库角色变为 `primary`，停止拉取旧主，开始写自己的复制日志；**不会**通知其他从库改指向——运维须显式处理。

### 提升步骤（运维）

1. 确认旧主不再写入（进程已停，或已隔离）。
2. 在目标从库上查看 `replica status`，记录 `appliedLsn` / `lagEntries`。
3. 接受数据停在已复制前缀（未复制的主库尾部不会自动追回，除非另行拷贝日志）。
4. 执行：`jsonsqlite replica promote --yes -p ./secondary`
5. 提升成功后该节点可写；其他仍指向旧主的从库不会自动跟随。

禁止在文档与稳定帮助中出现自动故障切换、自动选主、或 `cluster` 命令。

## 6. 分片

本版**不**实现 hash/range 分片路由器。稳定 CLI 与帮助中不出现分片命令。默认请求路径不经过路由器。

## 7. 健康检查

- 复制关闭：`/health` 成功，不因「没有从库」而失败，也不报告复制失败。
- 复制开启：`/health` 含 `role`、`lagEntries`、`lagMs`、`appliedLsn`、`lastLsn`，单位与 `replica status` 相同。从库滞后本身不把状态强制标为失败（可观测，不是仲裁）。
