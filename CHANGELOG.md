# Changelog

## 1.0.0 — 2026-10-19

### Added
- **P0/P1**: Embedded library `@webofcat/jsonsqlite` with open/close, JSONL storage, WAL recovery, file lock, CRUD, JSON Query, transactions
- **P2**: Object / Tree / Inverted indexes, query planner, L1 LRU cache, aggregation pipeline, JSONPath subset, `apps/bench`
- **P3**: Full/incremental backup (+ optional AES-GCM), health/metrics, ChangeLog, CLI `jsql`, HTTP Admin API (`startServer`)
- **P4**: Time travel (`queryAtTime` / `diffBetweenTimes` / `rollbackToTime`), QueryAdvisor, DataQuality, Admin dashboard HTML, `subscribe` stream hooks

### Notes
- Single-writer per `storagePath` (v1)
- Disk `formatVersion` = 1
- Node.js ≥ 20; ESM + CJS + TypeScript types
