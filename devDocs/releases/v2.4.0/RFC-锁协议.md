# RFC：单机多写者锁协议（v2.4）

> 状态：随 2.4.0 实现冻结  
> 本文件是发版门禁 FT-V24-GATE-01。崩溃后谁持有锁，以这里为准。  
> 范围：同一台机器上的多个进程。没有跨机锁、复制、选主。

## 模式

- `writers: 'single'`（默认）。`meta/.lock` 用 `O_EXCL` 独占。第二个进程 `open` 得到 `LOCK_FAILED`，`details.retryable` 不是 `true`。这和 LTS-2 相同。不写 `writers` 不会变成多写者。
- `writers: 'multi'`。每个进程写 `meta/holders/<pid>.json`。不创建独占的 `.lock`。已有活着的 single 进程时，multi 的 `open` 得到 `LOCK_FAILED`（不可重试）。已有活着的 multi 进程时，single 的 `open` 同样得到 `LOCK_FAILED`。

## 锁粒度与顺序

两把锁，顺序固定，禁止反过来：

1. **文档锁** `meta/doclocks/<key>.json`。键是 `集合名 + NUL + _id`。一个事务要写的文档，在提交时按键的字典序获取还没拿到的锁。`acquireDocLock(collection, id)` 按调用顺序立刻获取，用来构造可复现的等待环。
2. **提交锁** `meta/commit.lock`。只在全部文档锁都拿到之后获取，包住「读盘上的版本、写页、fsync」。持有提交锁时不再去等文档锁。

没有页锁，也没有锁升级。页文件只在提交锁内整页原子替换（临时文件写完再 rename）。

## 崩溃后谁持有锁

锁文件里只有 pid。进程死了（`pid` 已不存在），这把锁**无人持有**。下一个需要它的进程删掉过期文件，自己再获取。锁不会过继给别的进程，也不会留给已经退出的 pid。

同样的规则用于：

- single 的 `meta/.lock`
- multi 的 `meta/holders/<pid>.json`
- 文档锁
- 提交锁

已 fsync 的提交留在页文件（或尚未套用到页上的完整 WAL 行）里，跟锁归谁无关。没 fsync 的修改随进程一起消失。

## 提交与 fsync

自动提交和显式 `commit` 在 multi 下都走同一条路径：

1. 拿到文档锁，再拿到提交锁。
2. 从磁盘读 `_version`（页文件，再加上尚未截断的已提交 WAL）。内存里的脏数据不算。
3. 磁盘版本等于本事务开始时的版本才写入。写入是整页 rename，不是改半行。
4. 页 fsync 完成之后才释放提交锁，然后释放文档锁。

fsync 之前进程被杀死：要么磁盘上没有这条新记录，要么 WAL 末尾是没有换行的撕裂尾巴。打开时丢弃撕裂尾巴。不会留下半个文档。fsync 之后被杀死：这次提交还在，同一事务里没有 `commit` 的修改不在。索引按页上的已提交文档重建，不把未提交的修改算进去。

## 冲突、死锁、可重试

| 错误码 | 何时 | 可重试 |
|--------|------|--------|
| `WRITE_CONFLICT` | 同一 `_id` 的磁盘版本已经不是本事务起算的版本。一方提交成功，另一方得到这个错误。成功的那份文档还在 | 是。重新 `open` 着的进程应重新读取再提交 |
| `SERIALIZABLE_CONFLICT` | 只在 multi 的 `SERIALIZABLE` 事务里。读过的文档版本变了 | 是 |
| `DEADLOCK` | 等待图成环。**pid 较大的一方**是牺牲者：回滚整个事务，释放自己的文档锁。pid 较小的一方继续等，然后拿到锁 | 是。检测看的是等待图，不是超时 |
| `LOCK_FAILED` | 活着的进程持有另一种模式的开库锁，或 single 的独占锁 | 否。等对方 `close` |
| `ISOLATION_UNSUPPORTED` | single 模式请求 `SERIALIZABLE` | 否。换成隔离级别不会打开多写者 |

`details.retryable === true` 只出现在前三个错误码上。
