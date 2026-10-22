# JSONSQLite CLI 命令清单（1.5.5 → 1.6 CLI-API 底稿）

> 包：`@webofcat/jsonsqlite` · 二进制：`jsonsqlite` / `jsql` · 版本：1.5.5

## 全局 flags

| Flag | 说明 |
|------|------|
| `-p, --path <dir>` | 数据目录（默认 `./data` 或 `$JSONSQLITE_PATH`） |
| `-y, --yes` | 跳过确认 |
| `--json` | JSON 输出；失败为 `{ ok:false, code, message }` |
| `-q, --quiet` | 减少人类可读输出 |
| `-h, --help` | 当前层级帮助 |

## Exit codes

| Code | 含义 |
|------|------|
| 0 | 成功 |
| 1 | 用法 / 业务错误 |
| 2 | 系统 / IO |
| 3 | 文件锁失败 |

## 命令表

| 命令 | 非交互 | 危险确认 | 说明 |
|------|--------|----------|------|
| `version` / `--version` | ✅ | — | 打印版本 |
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

## 环境变量

- `JSONSQLITE_PATH` — 默认路径
- `JSONSQLITE_KEY` — 加密密钥
- `NO_COLOR` — 禁用 ANSI

## 分级 help

- `jsonsqlite help`
- `jsonsqlite table --help`
- `jsonsqlite table create --help`
- `jsonsqlite insert|update|delete|index|sql --help`
