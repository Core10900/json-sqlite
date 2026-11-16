# RFC：集群选主、分区、分片与跨机锁（v3.5）

> 状态：随 3.5.0 实现冻结（**非 LTS**，禁止宣布设计完工 / Vision Complete）  
> 本文件是发版门禁 FT-V35-GATE-01。  
> 范围：共享文件系统上的多节点协调（单机多 `storagePath` 可测）。不是完整 Raft 库，不提供多语言 TCP。

## 1. 默认与开关

- 集群**默认关闭**。`config.example.json` 里 `cluster` 为 `false`，`wasm` 为 `false`。
- 关闭时行为与 **3.4** 的单机、异步复制路径一致。`open` 不自动加入集群。
- 配置键 `cluster` / `wasm` 移出危险键；可为 `false`，或对象。顶层 `raft` / `shard` / `sharding` / `quorum` 仍拒绝。
- 打开集群：`open({ cluster: { clusterRoot, nodeId?, leaseMs? } })`，再通过 CLI / API `cluster join`。

## 2. 控制平面布局

共享目录 `clusterRoot`：

| 路径 | 内容 |
|------|------|
| `meta/cluster.json` | `{ clusterId, members: [{ nodeId, storagePath }], shardVersion }` |
| `meta/election.json` | `{ term, leaderId, leaseUntil, voters: string[] }` |
| `meta/shards.json` | `{ version, migrating?: boolean, shards: [{ id, ownerId, collection? }] }` |
| `votes/<term>/<nodeId>.json` | 该任期的选票 |
| `locks/<key>.json` | `{ holderId, scope, leaseUntil }` |
| `heartbeats/<nodeId>.json` | `{ nodeId, term, at }` |

每个成员库目录：

| 路径 | 内容 |
|------|------|
| `meta/cluster-member.json` | `{ enabled, nodeId, clusterRoot, role }` |

## 3. 选主（租约 + 多数票）

1. 节点定时写入 `heartbeats/<nodeId>.json`，并在持有领导权时刷新 `election.leaseUntil`。
2. 无有效领导（`leaseUntil < now` 或文件缺失）时，发起选举：`term += 1`，向 `votes/<term>/` 写自己的票。
3. 获得 **⌊N/2⌋+1** 票且租约未过期的节点成为唯一主（`role: 'leader'`）。其余为 `follower`。
4. **只有** `leaderId === self` 且 `leaseUntil >= now` 的节点接受写入。否则抛 `NOT_PRIMARY`。
5. 杀死主：停止心跳 / 关闭进程 → 租约过期 → 其余节点按上式重选。已提交到原主本地且已复制到多数成员数据目录的文档，在新主上仍可按 `_id` 读到（成员间通过共享文档目录或同步拷贝保持可见；见实现的 `ClusterCoordinator`）。

### 状态字段（`cluster status`）

| 字段 | 含义 |
|------|------|
| `enabled` | 是否已 join |
| `nodeId` | 本节点 id |
| `role` | `none` / `leader` / `follower` |
| `leaderId` | 当前主；无主时为 `null` |
| `term` | 选举任期 |
| `leaseUntil` | 主租约截止 epoch ms |
| `members` | 成员列表 |
| `shardVersion` | 分片图版本 |
| `migrating` | 是否正在 rebalance |

## 4. 网络分区：禁止双主写

- 测试中的「分区」：协调器可对节点调用 `setPartitioned(true)`，使其无法读/写 `clusterRoot` 的选举与选票，或无法形成多数。
- 少数派无法刷新租约、无法凑齐多数票，**不能**成为接受写入的主。
- 少数派写入失败错误码：`CLUSTER_PARTITION`（若已知处于分区）或 `NOT_PRIMARY`。
- 任意时刻，成功的写操作只能来自持有当前有效租约的**一个** `leaderId`。

## 5. 自动分片与 rebalance

- 文档映射：`shardIndex = hash(collection + '\0' + _id) % shardCount`（稳定字符串哈希）。
- `shards.json` 记录每个分片的 `ownerId`。`cluster rebalance` 显式触发迁移。
- 迁移中：`migrating: true`。查询要么返回完整可见结果，要么抛 `SHARD_MOVING`（稳定、可重试语义由调用方决定是否停写）。**不得**在无错误的情况下静默少文档。
- Advisor 可以输出数据倾斜建议（`type: 'structure'` 或 `info`），**不得**自动调用 `rebalance`。

## 6. 跨机锁

- 范围：`collection` 或 `collection/_id`（`scope` 字符串）。
- 文件：`locks/<encode(scope)>.json`，含 `holderId`、`leaseUntil`。
- 冲突：另一节点持有未过期租约时抛 `CLUSTER_LOCK_CONFLICT`；`details` 含 `scope`、`holderId`。
- 持有方已提交的写入不得因冲突方失败而回滚消失。

## 7. 错误码

| 码 | 场景 |
|----|------|
| `NOT_PRIMARY` | 非领导节点拒绝写 |
| `CLUSTER_PARTITION` | 分区/无法联系多数，拒绝写 |
| `SHARD_MOVING` | rebalance 迁移中，本查询不能安全完成 |
| `CLUSTER_LOCK_CONFLICT` | 跨机锁冲突 |

## 8. CLI

仅在集群已启用（join 成功）后，稳定帮助与命令包含：

```text
jsonsqlite cluster status|join|leave|rebalance
```

集群关闭时，根帮助**不**把 `cluster` 写成默认可用命令。

## 9. WASM

- 独立包 `@webofcat/jsonsqlite-wasm`：experimental、只读。
- 主 bin / 核心帮助不含 WASM 入口。
- 写路径不进入 3.6 的写入承诺。

## 10. 明确不做

完整 Raft 日志复制协议库、自动跨机 TCP、多语言协议、在 3.5 宣布 LTS-4、把 WASM 写进主 bin。
