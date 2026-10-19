# Changelog

## 1.0.0

### Added
- Embedded JSON document store with WAL recovery and single-writer file lock
- CRUD, JSON Query, transactions (single-level)
- Indexes: object / tree / inverted + query planner
- L1 LRU query cache
- Aggregation pipeline (match/group/sort/limit/project)
- Safe JSONPath subset
- Full/incremental backup + restore; optional AES-GCM
- Change log powered TimeTravel (`queryAtTime` / `diff` / `rollbackToTime`)
- Monitor metrics, `health()`, QueryAdvisor, DataQuality
- HTTP Admin (`startServer`) + `jsql` CLI
- Event subscribe (`dataChanged`)

### Notes
- Disk `formatVersion` = 1
- Single writer per `storagePath`; not a multi-instance shared database
