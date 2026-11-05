# JSONSQLite 内部文档（devDocs）

本目录存放设计方案、版本开发计划与功能测试计划。按 **主题** 与 **版本** 分类。

## 目录结构

```text
devDocs/
├── README.md
├── design/                         ← 跨版本设计
└── releases/
    ├── ROADMAP.md                  ← 生产 pin 与 LTS 资格
    ├── FEATURE-MATRIX.md           ← 能力 ↔ 版本
    ├── CLI-EVOLUTION.md            ← 1.7→3.6 CLI / CLI-API
    ├── v1.0/ … v1.6.0/             ← 已交付（LTS-1 = 1.6.x）
    ├── v1.7.0/ v1.8.0/             ← 已交付（非 LTS）
    ├── v2.0/ v2.1.0/               ← 单机正确性浸泡（非 LTS，已交付）
    ├── v2.2.0/                     ← 已交付 ★ LTS-2 主推荐（至 3.6 宣布前）
    ├── v2.3.0/                     ← 已交付（非 LTS，存储增强）
    ├── v2.4.0/                     ← 已交付（非 LTS，多写者浸泡）
    ├── v2.5.0/                     ← 已交付 ★ LTS-3 多写者
    ├── v3.0.0/                     ← 规划：查询引擎补齐
    ├── v3.1.0/                     ← 规划：索引与存储算法
    ├── v3.2.0/                     ← 规划：单机运维收口
    ├── v3.3.0/                     ← 规划：异步复制雏形
    ├── v3.4.0/                     ← 规划：复制硬化与接入层
    ├── v3.5.0/                     ← 规划：集群浸泡（禁止当版宣布 LTS）
    └── v3.6.0/                     ← 规划 ★ LTS-4 设计完工冻结
```

## LTS 速查

一条版本要同时满足：本版不引入新子系统、该契约的正确性红线全绿、此后 PATCH 不加功能、有上一档迁移指南。详见 [releases/ROADMAP.md](./releases/ROADMAP.md)。

| 代号 | 版本 | 状态 | 含义 |
|------|------|------|------|
| **LTS-1** | `1.6.x` | ✅ 当前 | 旧单写者契约 |
| **LTS-2** | `2.2.x` | ✅ 当前 | **3.6 宣布前的主推荐**：分页、可恢复备份、诚实隔离 |
| **LTS-3** | `2.5.x` | ✅ 当前 | 单机多写者 opt-in。默认仍单写者。需要多写者才升级 |
| — | `3.0`–`3.4` | 规划 | 设计补齐、复制、接入层。默认不改变 2.5 |
| — | `3.5.x` | 规划，禁止当版 LTS | 集群浸泡。混沌三项全绿才发版 |
| **LTS-4** | `3.6.x` | 规划 | 设计功能完工后的长期稳定线。默认仍单写者，复制和集群关闭 |

详情：[releases/ROADMAP.md](./releases/ROADMAP.md) · [releases/FEATURE-MATRIX.md](./releases/FEATURE-MATRIX.md) · [releases/CLI-EVOLUTION.md](./releases/CLI-EVOLUTION.md)

## 索引

### design/

| 文档 | 说明 |
|------|------|
| [技术实现方案与计划](./design/JSONSQLite%20技术实现方案与计划.md) | 总体架构与实现方案 |
| [生产级实现大纲](./design/JSONSQLite%20生产级实现大纲.md) | 生产能力与里程碑大纲 |
| [vs SQLite](./design/JSONSQLite%20vs%20SQLite%20-%20超越的可能性.md) | 定位与差异分析 |
| [npm 包与后端接入](./design/JSONSQLite%20npm包与后端接入说明.md) | 包契约与接入说明 |

### releases/

| 版本 | LTS | 开发计划 | 功能测试 / 其它 |
|------|-----|----------|-----------------|
| 总览 | — | [ROADMAP](./releases/ROADMAP.md) | [FEATURE-MATRIX](./releases/FEATURE-MATRIX.md) |
| v1.0–v1.5.5 | — | 见各目录 | 已交付 |
| **v1.6.0** | **LTS-1** | [开发计划](./releases/v1.6.0/开发计划.md) | [功能测试](./releases/v1.6.0/功能测试计划.md) · [准入](./releases/v1.6.0/LTS准入检查表.md) |
| v1.7.0 | 否 | [开发计划](./releases/v1.7.0/开发计划.md) | [功能测试](./releases/v1.7.0/功能测试计划.md) |
| v1.8.0 | 否 | [开发计划](./releases/v1.8.0/开发计划.md) | [功能测试](./releases/v1.8.0/功能测试计划.md) |
| v2.0 | 否 | [开发计划](./releases/v2.0/开发计划.md) | [功能测试](./releases/v2.0/功能测试计划.md) |
| v2.1.0 | 否 | [开发计划](./releases/v2.1.0/开发计划.md) | [功能测试](./releases/v2.1.0/功能测试计划.md) |
| **v2.2.0** | **LTS-2** | [开发计划](./releases/v2.2.0/开发计划.md) | [功能测试](./releases/v2.2.0/功能测试计划.md) |
| v2.3.0 | 否 | [开发计划](./releases/v2.3.0/开发计划.md) | [功能测试](./releases/v2.3.0/功能测试计划.md) |
| v2.4.0 | 否 | [开发计划](./releases/v2.4.0/开发计划.md) | [功能测试](./releases/v2.4.0/功能测试计划.md) |
| **v2.5.0** | **LTS-3** | [开发计划](./releases/v2.5.0/开发计划.md) | [功能测试](./releases/v2.5.0/功能测试计划.md) |
| v3.0.0 | 否 | [开发计划](./releases/v3.0.0/开发计划.md) | [功能测试](./releases/v3.0.0/功能测试计划.md) · [发布说明](./releases/v3.0.0/发布说明.md) |
| v3.1.0 | 否 | [开发计划](./releases/v3.1.0/开发计划.md) | [功能测试](./releases/v3.1.0/功能测试计划.md) · [发布说明](./releases/v3.1.0/发布说明.md) |
| v3.2.0 | 否 | [开发计划](./releases/v3.2.0/开发计划.md) | [功能测试](./releases/v3.2.0/功能测试计划.md) · [发布说明](./releases/v3.2.0/发布说明.md) |
| v3.3.0 | 否 | [开发计划](./releases/v3.3.0/开发计划.md) | [功能测试](./releases/v3.3.0/功能测试计划.md) · [发布说明](./releases/v3.3.0/发布说明.md) |
| v3.4.0 | 否 | [开发计划](./releases/v3.4.0/开发计划.md) | [功能测试](./releases/v3.4.0/功能测试计划.md) · [发布说明](./releases/v3.4.0/发布说明.md) |
| v3.5.0 | 禁止当版宣布 | [开发计划](./releases/v3.5.0/开发计划.md) | [功能测试](./releases/v3.5.0/功能测试计划.md) · [发布说明](./releases/v3.5.0/发布说明.md) |
| **v3.6.0** | **LTS-4** | [开发计划](./releases/v3.6.0/开发计划.md) | [功能测试](./releases/v3.6.0/功能测试计划.md) · [迁移](./releases/v3.6.0/迁移指南.md) · [发布说明](./releases/v3.6.0/发布说明.md) |
