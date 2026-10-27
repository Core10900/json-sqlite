# JSONSQLite 内部文档（devDocs）

本目录存放设计方案、版本开发计划与功能测试计划。按 **主题** 与 **版本** 分类。

## 目录结构

```text
devDocs/
├── README.md
├── design/                         ← 跨版本设计
└── releases/
    ├── ROADMAP.md                  ← 完整路线（至 3.0）+ LTS 标注
    ├── FEATURE-MATRIX.md           ← 大纲能力 ↔ 版本勾选真源
    ├── CLI-EVOLUTION.md            ← 1.7→3.0 CLI / CLI-API 适配
    ├── v1.0/ … v1.6.0/             ← 已交付（LTS-1 = 1.6.x）
    ├── v1.7.0/ v1.8.0/             ← 已交付（非 LTS）
    ├── v2.0/ v2.1.0/               ← 规划（非 LTS）
    ├── v2.2.0/                     ← 规划 ★ LTS-2
    ├── v2.3.0/                     ← 规划（非 LTS）
    └── v3.0.0/                     ← 规划 ★ LTS-3 / Vision Complete
```

## LTS 速查

| 代号 | 版本 | 状态 | 含义 |
|------|------|------|------|
| **LTS-1** | `1.6.x` | ✅ 当前 | 单写者嵌入式契约冻结 |
| **LTS-2** | `2.2.x` | 规划 | 2.x 首个推荐长期 pin |
| **LTS-3** | `3.0.x` | 规划 | 设计采纳能力完工 + 主推荐 pin |

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
| **v3.0.0** | **LTS-3** | [开发计划](./releases/v3.0.0/开发计划.md) | [功能测试](./releases/v3.0.0/功能测试计划.md) |
