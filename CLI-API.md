# JSONSQLite CLI API

> **适用于 `@webofcat/jsonsqlite` 1.6.x LTS**  
> **CLI 命令面冻结自 1.5.5**（本文件为权威契约；1.6.x 不扩张子命令）  
> 二进制：`jsonsqlite` / `jsql` · 包：`@webofcat/jsonsqlite`

库 API 见根目录 [`API.md`](./API.md)。命令底稿来源：[`devDocs/releases/v1.5.5/cli-command-inventory.md`](./devDocs/releases/v1.5.5/cli-command-inventory.md)。

---

## 1. 安装与版本

```bash
npm install -g @webofcat/jsonsqlite
jsonsqlite --version    # => 2.0.0（非 LTS；1.6.x 仍是当前 LTS pin。见 §15）
jsql --version          # 同入口别名
```

---

## 2. 全局契约（1.5.5 定稿）

### 2.1 Flags

| Flag | 说明 |
|------|------|
| `-p, --path <dir>` | 数据目录（默认 `./data` 或 `$JSONSQLITE_PATH`） |
| `-y, --yes` | 跳过确认 |
| `--json` | JSON 输出 |
| `-q, --quiet` | 减少人类可读输出 |
| `-h, --help` | 当前层级帮助 |

Flags 可出现在 argv 任意位置。

### 2.2 Exit codes

| Code | 含义 |
|------|------|
| `0` | 成功 |
| `1` | 用法 / 业务错误 |
| `2` | 系统 / IO |
| `3` | 文件锁失败（`LOCK_FAILED`） |

### 2.3 `--json` 包络

- **成功**：对象含业务字段；多数写操作为 `{ ok: true, ... }`
- **失败**：`{ ok: false, code: string, message: string }`（可出现在 stdout 或 stderr）

### 2.4 TTY vs 非交互

- 需要对话的命令（如无 flags 的 `table create`、`table alter`、`sql` REPL）：**非 TTY 立即失败**，提示等价 flags；禁止挂起
- 破坏性操作：TTY 二次确认，或 `--yes` / `-y` 跳过
- `NO_COLOR=1`：禁用 ANSI 颜色

### 2.5 环境变量

| 变量 | 说明 |
|------|------|
| `JSONSQLITE_PATH` | 默认数据目录 |
| `JSONSQLITE_KEY` | 加密密钥 |
| `NO_COLOR` | 禁用颜色 |

---

## 3. 数据库生命周期

```bash
jsonsqlite create ./data [--force] [--json]
jsonsqlite init ./data [--json]
```

- `create`：新建；已存在且无 `--force` → 失败  
- `init`：幂等初始化（不存在则创建）

---

## 4. 表命令

```bash
jsonsqlite tables -p ./data [--json]
jsonsqlite collections -p ./data          # 同 tables
jsonsqlite table list -p ./data

jsonsqlite table create -p ./data         # TTY 对话
jsonsqlite table create --name users --field name:string --field age:number -p ./data --json
jsonsqlite table drop users --yes -p ./data
jsonsqlite table alter users -p ./data    # TTY
jsonsqlite table show users --page 1 --size 20 -p ./data [--json] [-i]
jsonsqlite table describe users -p ./data
jsonsqlite table export users --file out.jsonl -p ./data
jsonsqlite table import users --file in.jsonl --mode append|replace -p ./data
```

字段类型：`string` | `number` | `boolean` | `json` | `any`。

---

## 5. 行级命令（1.5.5）

```bash
jsonsqlite insert users --data '{"name":"寒","age":30}' -p ./data --json
jsonsqlite insert users --field name=寒 --field age=30 -p ./data
jsonsqlite insert users --file rows.jsonl -p ./data --json

jsonsqlite get users --id <id> -p ./data --json
jsonsqlite update users --id <id> --set age=31 -p ./data
jsonsqlite update users --where '{"age":{"$lt":18}}' --set active=false -p ./data
jsonsqlite update users --set tag=all -p ./data --yes   # 无过滤必须 --yes

jsonsqlite delete users --id <id> --yes -p ./data
jsonsqlite delete users --where '{"name":"x"}' --yes -p ./data

jsonsqlite count users -p ./data --json
jsonsqlite count users --where '{"age":{"$gt":18}}' -p ./data --json
```

---

## 6. 索引与诊断

```bash
jsonsqlite index list -p ./data [--json]
jsonsqlite index create users age --type object|tree|inverted -p ./data
jsonsqlite index drop users age -p ./data

jsonsqlite stats [-p ./data] [--table users] [--json]
jsonsqlite explain "SELECT * FROM users WHERE age > 18" -p ./data [--json]
jsonsqlite explain '{"collection":"users","filter":{"age":{"$gt":18}}}' -p ./data
```

---

## 7. SQL

```bash
jsonsqlite run "SHOW TABLES" -p ./data
jsonsqlite run "SELECT * FROM users WHERE age > 18 LIMIT 10" -p ./data [--json] [--limit N]
jsonsqlite sql -p ./data                  # 仅 TTY REPL
```

REPL meta：`.tables` · `.schema [table]` · `.quit`  
非 TTY：`sql` 失败，请用 `run`。

SQL 子集细节见 [`API.md`](./API.md#8-sql)。

---

## 8. 运维

```bash
jsonsqlite query '{"collection":"users","filter":{"age":{"$gte":18}}}' -p ./data
jsonsqlite backup -p ./data
jsonsqlite vacuum [-y] [--collection name] -p ./data [--json]
jsonsqlite rekey -p ./data --out ./data-v2 --from-key OLD --to-key NEW [--json]
jsonsqlite rekey -p ./data --in-place --yes --from-key OLD --to-key NEW
jsonsqlite doctor [--deep] -p ./data [--json]   # unhealthy → exit ≠ 0
```

---

## 9. 帮助

```bash
jsonsqlite help
jsonsqlite --help
jsonsqlite table --help
jsonsqlite table create --help
jsonsqlite insert|update|delete|index|sql --help
```

---

## 10. 完整命令速查表

| 命令 | 非交互 | 危险确认 | 说明 |
|------|--------|----------|------|
| `version` / `--version` / `-V` | ✅ | — | 打印版本 |
| `help` / `--help` | ✅ | — | 根帮助 |
| `create [path] [--force]` | ✅ | force 破坏性 | 建库目录 |
| `init [path]` | ✅ | — | 幂等初始化 |
| `tables` / `collections` | ✅ | — | 列表 |
| `table list` | ✅ | — | 同 tables |
| `table create` | `--name/--field` 或 TTY | 对话确认 | 建表 |
| `table drop <name>` | `--yes` | 二次确认 | 删表 |
| `table alter <name>` | TTY | 二次确认 | 改表 |
| `table show <name>` | `--page/--size/--json`；`-i` TTY | — | 浏览 |
| `table describe <name>` | ✅ | — | 软 Schema |
| `table export <name> --file` | ✅ | — | JSONL 导出 |
| `table import <name> --file` | `--mode append\|replace` | — | JSONL 导入 |
| `insert <table>` | `--data` / `--field` / `--file` | — | 插入 |
| `update <table>` | `--set` + `--id`/`--where`；无过滤需 `--yes` | 全表需 yes | 更新 |
| `delete <table>` | `--id`/`--where` + `--yes`（非 TTY） | 确认或 yes | 删除 |
| `get <table> --id` | ✅ | — | 单行 |
| `count <table> [--where]` | ✅ | — | 计数 |
| `run "<sql>"` | ✅；单语句；`--limit` | — | SQL |
| `sql` | **仅 TTY** REPL | — | `.tables` `.schema` `.quit` |
| `query '{...}'` | ✅ | — | JsonQuery |
| `index list\|create\|drop` | ✅ | — | 索引 |
| `stats [--table]` | ✅ | — | 统计 |
| `explain "<sql\|json>"` | ✅ | — | 建议/计划 |
| `backup` | ✅ | — | 全量备份 |
| `vacuum [--collection]` | ✅ | — | 重写 JSONL |
| `rekey --out` / `--in-place --yes` | ✅ | inplace 需 yes | 离线换钥 |
| `doctor [--deep]` | ✅；unhealthy ≠ 0 | — | 诊断 |

---

## 11. 变更策略（1.6.x）

1. **不得无说明删除** 上表已发布的稳定子命令  
2. 全局 flags / exit code / `--json` 失败包络字段保持兼容（可新增字段）  
3. **新增子命令不属于 1.6.x**（进 1.7+ 或 2.0）  
4. 仅允许：安全修复、正确性修复、文档/help 勘误  

---

## 12. LTS 支持政策

- **1.6.x**：安全与正确性补丁；CLI **不扩张**功能面  
- **1.7+**：可选新功能（含新 CLI 命令）  
- **2.0**：允许破坏兼容（多写者、硬 Schema 默认等）  

---

## 13. 1.7 增补（命令面扩展）

> 以下命令在 **1.7.0+** 可用；**不删除** §10 既有 1.5.5/1.6 命令。  
> 演进总览见 [`devDocs/releases/CLI-EVOLUTION.md`](./devDocs/releases/CLI-EVOLUTION.md)。

### 速查

| 命令 | 非交互 | 说明 |
|------|--------|------|
| `admin serve [--host] [--port] [--token] [--once]` | ✅；非 loopback 强制 token | Admin HTTP + SSE |
| `advise '<sql\|json>'` | ✅ | Advisor（字段对齐 explain） |
| `aggregate <table> '<pipeline-json>'` | ✅ | 含 unwind / lookup |
| `index create … --type composite --fields a,b` | ✅ | 复合索引 |
| `compat` / `version --json` | ✅ | `getCompatibilityInfo()` |
| `watch [--once\|--timeout ms]` | 非 TTY 须 once/timeout | 订阅 dataChanged |

### Help 要点

- `jsonsqlite admin serve --help` 含 host / port  
- `jsonsqlite index --help` 含 `composite` / `--fields`  
- 根 help 列出 advise / aggregate / admin / watch / compat

---

## 14. 1.8 增补（性能 / 存储）

> 以下在 **1.8.0+** 可用；不删除 §10 / §13 命令。

| 命令 | 非交互 | 说明 |
|------|--------|------|
| `index rebuild [table]` | ✅ | 从文档重建 postings 并重写落盘段。省略 table 则全部表 |
| `vacuum --compress` | ✅ | 按压缩阈值重写 JSONL（`JSQC1:`；加密库先压缩再加密） |
| `doctor --json` | ✅ | 增加 `indexSegments`、`compression`、`tiering`、`l2` |
| `stats --json` | ✅ | 增加 `l2`、`tiers`、`compression` |

`index --help` 含 `index rebuild [table]`。损坏段时 `doctor` 的 `index-segments` 检查为失败，数据仍可按 rebuild 恢复。

---

## 15. 2.0 破坏清单（迁移与恢复）

> **2.0.0 非 LTS，仍是单写者。** 本版**不**加入 `plugin`、`replica`、`cluster` 命令。

| 命令 | 非交互 | 说明 |
|------|--------|------|
| `migrate --from <db> --to <new> --yes` | 必须 `--yes`，否则 exit 1 | 1.x → formatVersion 2。成功 exit 0。失败不留半成品目标。再次执行时，无 `--yes` 拒绝覆盖 |
| `backup restore --type full\|incremental` | ✅ | 与库 `restoreChain` 同一条路径。checksum 不符 exit 1，目标不变 |
| `backup restore --collection <name>` | ✅ | 只恢复该集合 |
| `doctor` | ✅ | 尾部撕裂（`torn-tail`）与中间损坏（`middle`）分开报告。中间损坏时不打开库，exit 非 0 |
| `admin serve --host <non-loopback> --token --cert --key` | 缺 token 或 TLS 则 exit 1 | loopback 仍可省略 token，并打印警告 |

相对 1.8：`SERIALIZABLE` / `READ_UNCOMMITTED` 不再降级；分页布局见 API.md「2.0」。
  
