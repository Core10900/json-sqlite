# JSONSQLite CLI / CLI-API 演进计划（1.7 → 3.4）

> 基线：根目录 [`CLI-API.md`](../../CLI-API.md)（**1.5.5 命令面**，随 **1.6 LTS-1** 冻结）  
> 原则：**不回改** `v1.6.0/` 计划；新增与适配一律进对应 MINOR/MAJOR，并回写根 `CLI-API.md` 增补/改版节  
> 配套：[ROADMAP.md](./ROADMAP.md) · [FEATURE-MATRIX.md](./FEATURE-MATRIX.md)

---

## 1. 契约策略

| 版本线 | CLI 策略 |
|--------|----------|
| **1.6.x LTS-1** | **冻结**：不删不改稳定子命令语义；不新增命令 |
| **1.7 / 1.8** | **扩展**：新增命令/flags；旧命令兼容 |
| **2.0** | **可破坏**：`migrate` 与恢复命令；须迁移说明。本版不加 plugin / replica / cluster |
| **2.1** | 备份类型、prune、tune、audit |
| **2.2 LTS-2** | **冻结**单机生产命令面；PATCH 不扩命令 |
| **2.3** | `plugin`、`index compact`、可选 geo；不破坏 2.2 稳定集 |
| **2.4** | `--writers`。默认 single |
| **2.5 LTS-3** | **冻结**含多写者 flag 的命令面 |
| **3.0 / 3.1** | `replica`。没有 `cluster`，没有自动 failover 命令 |
| **3.2 LTS-4** | **冻结**复制命令面 |
| **3.3** | `db`、GraphQL 入口；可在子包 bin |
| **3.4** | `cluster` 仅实验。未通过混沌的子命令不写入稳定文档，本版不冻结为 LTS |

全局 flags（`-p/-y/--json/-q/-h`）与 exit `0/1/2/3`：**尽量保持**；2.0+ 仅可 **新增** exit 含义或可选字段，删除须 MAJOR 并文档化。

---

## 2. 按版本：建议命令 / 改动

### 1.7.0 — 体验与诊断对齐

| 命令 / 改动 | 适配能力 | 优先级 |
|-------------|----------|--------|
| `admin serve`（或 `admin start`） | Admin Web / HTTP | P0 |
| `advise '<sql\|json>'` | QueryAdvisor（可与 `explain` 并存；`explain` 保留） | P0 |
| `index create … --type composite --fields a,b` | CompositeIndex | P0 |
| `aggregate '<pipeline-json>'` | unwind / lookup 管道 | P1 |
| `watch` / `subscribe`（TTY 或 `--once`） | dataChanged / 流式观察 | P1 |
| `compat` 或 `version --json` | `getCompatibilityInfo()` | P0 |
| `stream …`（可选，薄封装 StreamProcessor） | StreamProcessor | P2 |
| help 分级补全上述子树 | 发现性 | P0 |
| `CLI-API.md` §「1.7 增补」 | 文档 | P0 |

**优化（非新命令）**：`explain` 输出与 Advisor 字段对齐；`doctor` 提示可链到 `advise`；`--json` 成功包络对新增命令统一 `ok: true`。

### 1.8.0 — 性能 / 存储预备

| 命令 / 改动 | 适配能力 | 优先级 |
|-------------|----------|--------|
| `index rebuild [table]` | 索引落盘损坏重建 | P0 |
| `doctor` 检查项扩展 | 落盘索引 / 压缩状态 | P0 |
| `vacuum --compress`（或配置透传 flag） | 压缩 | P1 |
| `stats` 增加 cache/L2、tier 字段（`--json`） | L2 / 热冷 | P1 |
| `bench`（可选，调 `apps/bench` 或内置冒烟） | 性能门槛 | P2 |

### 2.0.0 — 单机正确性（迁移与恢复）

| 命令 / 改动 | 适配能力 | 优先级 |
|-------------|----------|--------|
| **`migrate --from … --to …`** | 1.8 → 2.0 分页格式 | P0 |
| `backup restore --type full\|incremental` | 备份链可恢复 | P0 |
| `backup restore --collection` | 部分恢复 | P0 |
| `doctor` 区分尾部撕裂与中间坏 WAL | 失败关闭 | P0 |
| 根 `CLI-API.md` 2.0 破坏清单 | 权威文档 | P0 |
| 本版**不**加 `plugin` / `replica` / `cluster` / `--writers multi` | 范围 | P0 |

### 2.1.0 — 单机运维

| 命令 / 改动 | 适配能力 | 优先级 |
|-------------|----------|--------|
| `backup --type full\|incremental\|differential` | 三类备份 | P0 |
| `backup prune` / `--keep-days` | 保留策略 | P0 |
| `tune --dry-run` | AutoTune 不改库 | P0 |
| `audit list` | 审计 | P0 |
| `doctor` 区分可自愈索引与拒绝打开的数据损坏 | 自动恢复 | P0 |

### 2.2.0 — LTS-2 冻结

| 命令 / 改动 | 适配能力 | 优先级 |
|-------------|----------|--------|
| `compat` / `version --json` 含 LTS-2 | 可探测 | P0 |
| `config validate --file` | example 对齐已冻结字段 | P0 |
| **冻结** `CLI-API.md` 2.2 命令面 | LTS-2 | P0 |

### 2.3.0 — 存储增强

| 命令 / 改动 | 适配能力 | 优先级 |
|-------------|----------|--------|
| `plugin list\|info` | 插件面 | P0 |
| `index compact` | 分段合并 | P0 |
| `index create --type geo` | 可选 Geo | P1 |
| 2.2 稳定命令保持 | LTS-2 回归 | P0 |

### 2.4.0 — 多写者浸泡

| 命令 / 改动 | 适配能力 | 优先级 |
|-------------|----------|--------|
| `--writers single\|multi` | 默认 single | P0 |
| `doctor` 报告写者模式 | 可观测 | P0 |

### 2.5.0 — LTS-3 冻结

| 命令 / 改动 | 适配能力 | 优先级 |
|-------------|----------|--------|
| `version --json` 含 `ltsLine: 2.5` | LTS-3 | P0 |
| **冻结**含 `--writers` 的命令面 | LTS-3 | P0 |

### 3.0.0 / 3.1.0 — 异步复制（非 LTS）

| 命令 / 改动 | 适配能力 | 优先级 |
|-------------|----------|--------|
| `replica init\|status` | 复制雏形；status 含滞后 | P0 |
| 3.1：`replica status` 含 quorum 与角色 | 读写分离 | P0 |
| **不**提供 `cluster`，**不**提供自动 failover | 禁止假装选主 | P0 |

### 3.2.0 — LTS-4 冻结

| 命令 / 改动 | 适配能力 | 优先级 |
|-------------|----------|--------|
| 冻结 `replica` 字段 | LTS-4 | P0 |
| `version --json` 含 `ltsLine: 3.2` | 可探测 | P0 |

### 3.3.0 — 适配器

| 命令 / 改动 | 适配能力 | 优先级 |
|-------------|----------|--------|
| `db list\|register\|use\|unregister` | 多库 | P0 |
| `serve graphql` 或子包 bin 文档 | GraphQL | P1 |
| `plugin` 可指向 vector 示例 | 可选插件 | P1 |

### 3.4.0 — 集群实验（禁止 LTS）

| 命令 / 改动 | 适配能力 | 优先级 |
|-------------|----------|--------|
| `cluster status\|join\|leave\|rebalance` | 仅实验开关打开且混沌通过的子命令 | P0 |
| 未通过的子命令不写入稳定 CLI-API | 不把失败写成支持 | P0 |
| WASM 文档指向可选包 | 不塞进主 bin | P2 |

---

## 3. 文档与测试约定

1. 每版发版前：根 `CLI-API.md` 更新速查表；旧命令标「自 x.y」  
2. 契约测：`help` ⊆ `CLI-API.md`；新增命令至少 1 条非 TTY spawn（`--json` / `--yes`）  
3. LTS 发版（2.2 / 2.5 / 3.2）：单独 FT「CLI 面快照」防止漂移。3.4 不做这项冻结  
4. **禁止**在未改 `CLI-API.md` 的情况下合并新子命令  

---

## 4. 与各版开发计划的关系

各 `v*/开发计划.md` 中的 **「CLI-API 适配」** 小节为本文件对应版本的执行清单；有冲突时以该版开发计划当迭代为准，并回写本文。
