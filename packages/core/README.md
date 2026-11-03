# @webofcat/jsonsqlite

**版本：2.3.0** · **非 LTS** · 单写者 · Node.js ≥ 20 · 作者：hanlin

生产环境请继续 pin **2.2**（LTS-2）：

```bash
npm install @webofcat/jsonsqlite@2.2
# 或
npm install @webofcat/jsonsqlite@lts
```

只有需要本版的列存、热/温/冷分层或插件时才安装 2.3。`npm install @webofcat/jsonsqlite`（`latest`）会装到 2.3.0。`lts` 仍指向 2.2，不要把 2.3 当成更稳定的替代。

2.3 不改变默认路径。不传新选项时，`open` 可以打开 2.2 的库（`formatVersion` 仍是 2，不用迁移），查询、索引、备份和 CLI 的稳定命令与 LTS-2 一致。列存、分层、智能压缩、插件、大值缓存压缩、热页预取、chunk 执行、Geo 索引、中文分词**全部默认关闭**。

```ts
import { getCompatibilityInfo, open } from '@webofcat/jsonsqlite';

const info = getCompatibilityInfo();
// {
//   version: '2.3.0',    // 本包版本。这不是 LTS 包
//   formatVersion: 2,    // 与 2.2 相同，旧的 2.2 目录可以直接 open
//   lts: false,          // 本二进制不是长期支持线
//   ltsLine: '2.2',      // 建议 pin 的生产 LTS 线。不要把它读成「本包属于 2.2」
//   writers: 'single',   // 仍然是单写者。多写者在 2.5
//   cliSurface: '2.3.0', // 在 2.2 命令之外增加了 plugin 与 index compact
// }
```

| 字段 | 含义 |
|------|------|
| `lts: false` | 这个 2.3.0 包不是长期支持版本。需要稳定契约时 pin 2.2。 |
| `ltsLine: '2.2'` | 当前建议生产使用的 LTS 线。2.3 发布后这个字段仍是 `'2.2'`。 |
| `writers: 'single'` | 第二个进程 `open` 同一目录会得到 `LOCK_FAILED`。 |
| `cliSurface: '2.3.0'` | 2.2 的子命令都还在，并且可以多出 `plugin` 和 `index compact`。 |

默认隔离级别仍是 `READ_COMMITTED`。另一种可用级别是 `REPEATABLE_READ`。`READ_UNCOMMITTED` 和 `SERIALIZABLE` 会拒绝。LTS-1（1.6.x）继续收安全补丁，并行窗口不少于 12 个月，或到 LTS-3（2.5）发布后 6 个月。`@webofcat/jsonsqlite@2.2.0` 是这条 LTS-2 的首个版本。

---

## 默认路径，以及按表打开列存

什么都不开：

```ts
const db = await open({ storagePath: './data' });
await db.insert('orders', { _id: 'o1', sku: 'A', qty: 2 });
const rows = await db.query({ collection: 'orders', projection: ['sku'] });
// lastPlan().source === 'document'
// columnStoreStatus('orders').enabled === false
await db.close();
```

文档仍写在分页文件里，查询会读文档页。这和 LTS-2 相同。

按表打开列存（两种方式等价，都要指名表）：

```ts
const db = await open({
  storagePath: './data',
  columnCollections: ['orders'],
});
// 或者在已经 open 的库上：
await db.enableColumnStore('orders');
await db.flushColumnStore('orders'); // 等到这一代表重建结束

const rows = await db.query({
  collection: 'orders',
  projection: ['sku'],
});
// rows 与 { column: false } 的投影结果相同
// lastPlan().source === 'column'
await db.close();
```

- 写入仍先落到 WAL，再进入页文件。列存是派生物，不是提交事实来源。
- `enableColumnStore` 立刻返回，重建在后台进行。重建期间 `columnStoreStatus(table).ready` 为 false，查询自动改走文档页，结果仍然正确。
- `flushColumnStore(table)` 等到当前这一轮重建结束。
- 投影查询只读用到的列，加上行键文件 `rowkey.json`（`_id`、`_version`、`_createdAt`、`_updatedAt`）。过滤和排序用到的字段也会读，返回前再按 `projection` 裁掉。
- 列文件还没就绪、校验和不符、或某个字段不在清单里时，这次查询退回文档页。退回不是错误。

对照（功能测试 `FT-V23-COL-01`，不是生产耗时承诺）：`pageSize: 4`、16 条文档、只投影一个用户字段。列存读 2 个列文件（行键 + 该字段），文档模式读 4 个数据页。同一组结果深度相等。没有单独的毫秒基准。

列存重建被打断时，已提交的数据以 WAL 为准。把 `collections/<表>/columns/manifest.json` 写成 `ready: false` 或截断列文件后再次 `open`，查询仍返回 WAL 重放出来的文档，不会采用半截列文件。`FT-V23-COL-02` 覆盖了「WAL 已写入、页文件还没刷盘、列清单被拆掉」这一种崩溃。

---

## 热 / 温 / 冷

1.8 的 `tiering: true` 仍是实验旗标：只在 `close()` 时把低访问文档扫进 `cold.jsonl`。2.3 **默认保持 `tiering: false`**。新布局是另一个开关。

| 1.8 / 2.2 | 2.3 |
|-----------|-----|
| `tiering: true` | 保持 `false`，除非你还要旧的 close 扫冷行为 |
| `tierColdAfter` | 改填 `coldAfter`（默认 0） |
| 没有温层 | `warmAfter`（默认 1）。访问次数 `<= coldAfter` 进冷层；高于冷层且 `<= warmAfter` 进温层；更高的留在热层（页缓存） |

从带 `cold.jsonl` 的 1.8 库迁到这个布局：

1. 停掉占用该目录的进程，复制一份备份。
2. 若当时开过 `tiering: true`，先用 **1.8** 的程序执行 `open({ storagePath, tiering: false })` 然后 `close()`，让 `cold.jsonl` 回到热数据。2.3 对 `formatVersion: 1` 会抛 `MIGRATION_REQUIRED`，不能用来做这一步。
3. 按 [2.2 迁移指南](https://github.com/Core10900/json-sqlite/blob/main/devDocs/releases/v2.2.0/迁移指南.md) 把库迁到 format 2。
4. 用 2.3 打开，并显式加上新开关：

```ts
const db = await open({
  storagePath: './data-v2',
  tiering: false,
  storageTiers: true,
  coldAfter: 0,
  warmAfter: 1,
});
```

后台定时器约每秒跑一轮迁移，`insert` / `update` / `delete` **不会等待**这一轮。需要当场做完时调用 `await db.migrateTiersOnce()`。`FT-V23-TIER-01` 在冷层钩子被挡住时仍能完成一次 `insert`。

没有存储插件时，冷、温副本写在：

```text
collections/<表>/tiers/cold.jsonl
collections/<表>/tiers/warm.jsonl
```

库若开了 `encryptionKey`，这两份文件用同一把密钥加密。

冷层接到存储插件：注册一个 `kind: 'storage'` 且带 `putCold` 的插件。迁移时会调用它。插件抛错只记入 `pluginErrors()`，文档仍写入本地冷文件，查询继续。读的时候，若冷/温副本的 `_version` 不低于页里的文档，`findById` 返回副本，并在 `tierSummary().coldReads` / `warmReads` 上计数。更新过的文档以页里的新版本为准。

```ts
db.registerPlugin({
  kind: 'storage',
  name: 'cold-disk',
  version: '1.0.0',
  async putCold(collection, doc) {
    // 这里接你自己的冷存储。抛错不会让 insert 失败。
  },
});
await db.migrateTiersOnce();
const summary = db.tierSummary();
// summary.enabled === true，summary.cold 是本轮放进冷层的文档数
```

`storageTiers` 关闭时调用 `migrateTiersOnce()` 会抛 `INVALID_CONFIG`。

---

## 智能压缩

默认关闭。2.2 的 `compression: true` 仍是「超过 `compressionThreshold` 就 gzip」，行为不变。2.3 的多算法开关是 `smartCompression: true`（不要两个同时当同一条策略用；同时打开时智能压缩优先）。

| 算法 | 用在什么数据上 | 块头 |
|------|----------------|------|
| `delta` | 长度至少 4 的有限数字数组 | `JSQB1\|delta\|` |
| `dict` | 字符串数组，且不同值不超过长度的 25% | `JSQB1\|dict\|` |
| `rle` | 字符串数组里有长串重复，但基数又不够进字典 | `JSQB1\|rle\|` |
| `gzip` | 普通对象、长文本，以及上面三种还原失败时的退路 | `JSQB1\|gzip\|` |

选择由值的形状决定，调用方不用指定算法。块头里的算法名会在下次打开时被认出来：看到 `JSQB1|` 就按竖线后的名字还原，不以「这次 open 有没有打开 smartCompression」为准。

和加密叠在一起时的顺序是：**先压缩，再加密**。读取时先解密，再按块头解压。这和 2.2「先 gzip 再 AES」的顺序一致。

```ts
const db = await open({
  storagePath: './data',
  smartCompression: true,
  encryptionKey: 'secret',
});
await db.insert('docs', { _id: 'e', name: '密文', values: [1, 2, 3, 4, 5] });
await db.close();

const again = await open({
  storagePath: './data',
  smartCompression: true,
  encryptionKey: 'secret',
});
await again.findById('docs', 'e'); // name 仍是「密文」
```

往返失败时调用方看到的是 `JSONSQLiteError`：

- 写入前会自己还原一次。首选算法对不上原始字节时改用 gzip。gzip 仍失败则抛 `DATA_CORRUPT`，坏块不会落盘。
- 读到块头合法但载荷还原失败（或页里被改坏）时抛 `DATA_CORRUPT`。`open` 的页校验会因此拒绝打开，不会把坏行当成空文档。
- 密文本身损坏或密钥不对，抛的是 `ENCRYPTION`，不是 `DATA_CORRUPT`。

`FT-V23-CMP-01` 覆盖四种算法的字节级还原，以及加密开、关两条存储往返。

---

## 索引合并

`index compact` 合并的是**分段文件**，不是删索引。合并后内存里的倒排表还在，查询结果不变；再次 `open` 会命中带 `merged: true` 的那一个分段。

默认仍是 2.2 的单文件分段（`indexDeltaSegments: false`）。要让更新追加分段而不是覆盖同一个文件，打开：

```ts
const db = await open({ storagePath: './data', indexDeltaSegments: true });
await db.createIndex('users', 'name', 'object');
const merged = await db.compactIndexes('users');
// merged.indexes 含 'users:name'，merged.partsMerged 是合并前的分段数
```

命令行（非 TTY 可以直接跑，不提问）：

```bash
jsonsqlite index create users name --type object -p ./data
jsonsqlite index compact users -p ./data --json
```

省略表名时合并当前库里的全部分段。`index rebuild` 仍然是按文档重建，和 compact 不是一回事。

---

## 缓存与热页预取

大缓存值压缩默认关闭。打开后，JSON 字节数达到 `cacheCompressionThreshold`（默认 4096）的查询结果会 gzip 后再放进 L1。命中时返回原来的文档，不是压缩包。

```ts
const db = await open({
  storagePath: './data',
  cacheCompression: true,
  cacheCompressionThreshold: 4096,
});
await db.insert('docs', { _id: 'a', blob: '寒'.repeat(5000) });
await db.query({ collection: 'docs' });
const again = await db.query({ collection: 'docs' });
// again[0].blob 与写入的字符串相同
db.getMetrics().cacheCompression;
// { enabled: true, threshold: 4096, compressedSets: 1 }
// 第二次查询 lastPlan().source === 'cache'
```

压缩自检失败时抛 `DATA_CORRUPT`，这次查询不会返回半截文档。

热页预取默认关闭。`prefetchPages: true` 时，一次页缺失会尝试把下一页读进缓存。计数在 `prefetchStats()`：

```ts
db.prefetchStats();
// { enabled: true, hits: 0, fallbacks: 0 }
```

- `hits`：后来的按需读用上了刚才预取进缓存的页。
- `fallbacks`：下一页不在目录里，或预取读失败。
- 预取失败**不是错误**。当前这次 `findById` / 查询照常返回，之后的页仍按需读。

---

## 插件

五类：`index`、`storage`、`compression`、`backup`、`queryLanguage`。注册在进程内完成，不从网络安装。

```ts
db.registerPlugin({
  kind: 'queryLanguage',
  name: 'boom',
  version: '1.0.0',
  onQuery() {
    throw new Error('plugin exploded');
  },
});
const rows = await db.query({ collection: 'users' });
// rows 仍是原来的文档
db.pluginErrors();
// [{ name: 'boom', kind: 'queryLanguage', message: 'plugin exploded', at: ... }]
```

名称必须匹配 `^[a-z][a-z0-9_-]{0,63}$`，版本必须是 `主.次.补`（可带 semver 的预发布后缀）。名字、版本或 `kind` 不合法时 `registerPlugin` 抛 `INVALID_CONFIG`，插件不会登记，已经 open 的库继续能查。重复登记同一个 `kind + name` 同样抛 `INVALID_CONFIG`。

钩子抛错被隔离：记入 `pluginErrors()`，不会变成查询失败。上面的 `onQuery` 就是隔离之后的调用方式。

vector 和 S3 **只是可调用的 stub**，不是可用实现。可用的向量检索计划在 **3.3**，可用的 S3 冷存储计划在 **3.1**。

```ts
import { createS3Stub, createVectorStub } from '@webofcat/jsonsqlite';

const vector = createVectorStub();
const s3 = createS3Stub();
db.registerPlugin(vector);
db.registerPlugin(s3);

const found = await db.vectorSearch('docs', [0.1, 0.2]);
// { hits: [], stub: true, availableIn: '3.3', called: true, collection: 'docs' }
// vector.calls === 1。hits 永远是空的，不能用来做近邻检索。

await db.migrateTiersOnce();
// s3.calls 增加。putCold 只计数，不会上传对象。文档仍在本地冷文件里。
```

没注册就调用 `vectorSearch` 会抛 `INVALID_CONFIG`，文案会说明 stub 不是可用向量索引。

命令只查看内置目录，不会远程安装：

```bash
jsonsqlite plugin list --json
jsonsqlite plugin info vector --json
jsonsqlite plugin info s3 --json
```

`plugin info vector` 的 `stub` 为 true，`availableIn` 为 `"3.3"`。`s3` 的 `availableIn` 为 `"3.1"`。

---

## 大结果的 chunk 执行

`queryChunkSize` 默认 **0**：整表一次过滤、排序、分页、投影，和 2.2 相同。

设为大于 0 的整数后，**没有走索引的扫描**会按这个大小分块过滤，再对合在一起的命中做一次排序、分页和投影。索引已经把候选 id 收窄时，不再拆块。

```ts
const once = await db.query({ collection: 'nums', orderBy: { n: 'asc' }, projection: ['n'] });
const chunked = await db.query(
  { collection: 'nums', orderBy: { n: 'asc' }, projection: ['n'] },
  { chunkSize: 2 },
);
// chunked 与 once 深度相等
// lastPlan().chunked === true，lastPlan().chunks 是块数
```

单次选项 `chunkSize: 0` 强制走整表一次，不受 open 时的 `queryChunkSize` 影响。文档数不超过块大小时 `chunked` 为 false，因为实际只跑了一块。`FT-V23-EXE-01` 用 5 条文档和 `chunkSize: 2`，得到 3 块，结果与非 chunk 相同。

---

## GeoIndex 与中文分词

两者都是可选的。默认 `open` 不会加载 Geo 专用逻辑以外的索引，也不会加载任何分词依赖。

点可以写成 `{ lat, lon }`、`{ latitude, longitude }`、GeoJSON `{ type: 'Point', coordinates: [lon, lat] }`，或裸数组 `[lon, lat]`（GeoJSON 顺序，经度在前）。

没建索引时，`$geoWithin` 扫描全表，结果与建了索引之后相同。`lastPlan().usedIndex` 为空说明这次是扫描。框不合法（缺边或不是有限数字）抛 `INVALID_CONFIG`。

```ts
await db.insert('places', { _id: 'in', loc: { lat: 31.2, lon: 121.5 } });
await db.insert('places', { _id: 'out', loc: { lat: 39.9, lon: 116.4 } });

const box = { minLat: 30, minLon: 120, maxLat: 32, maxLon: 122 };
await db.query({ collection: 'places', filter: { loc: { $geoWithin: box } } });
// 只有 _id === 'in'。此时没有索引。

await db.createIndex('places', 'loc', 'geo');
await db.query({ collection: 'places', filter: { loc: { $geoWithin: box } } });
// 仍然只有 'in'。lastPlan().usedIndex === 'geo:loc'
```

```bash
jsonsqlite index create places loc --type geo -p ./data --json
```

中文分词默认关闭（`chineseTokenizer: 'none'`）。不传 `tokenizerModule` 时，`open` 不会去 `import` 任何分词包。

缺依赖时打开仍然成功。下面这个包并不存在：

```ts
const db = await open({
  storagePath: './data',
  tokenizerModule: 'jsonsqlite-cjk-tokenizer-missing',
});
db.tokenizerStatus();
// { available: false, name: null, reason: 'module-not-found' }
await db.query({ collection: 'users', filter: { name: '寒' } });
// 等值查询可用。不可用的是依赖分词器的全文切分。
```

内置 bigram 不需要额外依赖，必须显式打开。它把连续汉字切成两字词，英文单词保持整词：

```ts
import { createBigramTokenizer } from '@webofcat/jsonsqlite';

const db = await open({
  storagePath: './data',
  chineseTokenizer: 'bigram',
});
// 也可以：await db.registerTokenizer(createBigramTokenizer())
await db.insert('notes', { _id: 'n1', text: '欢迎使用数据库引擎' });
await db.createIndex('notes', 'text', 'inverted');
await db.query({ collection: 'notes', filter: { text: { $contains: '数据库' } } });
// 命中 n1。默认分词器不会把这句切词，同样的查询命中为空。
```

分词器名字和版本用与插件相同的规则校验。校验失败抛 `INVALID_CONFIG`，库仍然开着。

---

## CLI

2.2 的稳定命令没有改名，也没有删掉。全局 flag 仍是 `-p/--path`、`-y/--yes`、`--json`、`-q/--quiet`、`-h/--help`。退出码仍是 `0` 成功、`1` 用法或业务、`2` 系统/IO、`3` 锁失败。`backup`、`doctor`、`migrate`、`config validate`、`index rebuild` 的语义与 2.2 相同。

本版新命令：

```bash
jsonsqlite version --json
# version 2.3.0，lts false，ltsLine "2.2"，writers "single"

jsonsqlite plugin list --json
jsonsqlite plugin info vector --json
jsonsqlite plugin info s3 --json

jsonsqlite index create places loc --type geo -p ./data --json
jsonsqlite index compact places -p ./data --json
```

这些命令在非 TTY 下不提问。`plugin list` / `plugin info` 不打开数据库，也不安装远程插件。

`config validate --file` 仍接受 `config.example.json` 里的 2.2 字段。2.3 的可选字段（`columnStore`、`columnCollections`、`storageTiers`、`coldAfter`、`warmAfter`、`smartCompression`、`indexDeltaSegments`、`cacheCompression`、`cacheCompressionThreshold`、`prefetchPages`、`queryChunkSize`、`chineseTokenizer`、`tokenizerModule`）可以出现，默认都是关闭。`cluster`、`replica`、`raft`、`writers`、`l3`、`redis`、`cache`（嵌套对象；冻结字段是 `cacheSize`）、`savepoint`、`graphql`、`wasm` 仍会拒绝且不生效，退出码 1，`INVALID_CONFIG`。

---

## 这一版没有的东西

- **savepoint**：放到 2.4 的事务模型里做。配置里写 `savepoint` 会被拒绝。
- 多写者、复制、自动选主。稳定的多写者线是 **2.5**。
- GraphQL、Raft、WASM。
- 可用的向量检索。`vectorSearch` 和 `createVectorStub()` 只证明钩子能被调用，命中列表为空。可用实现在 3.3。
- 可用的 S3 上传。`createS3Stub()` 只计数，不传对象。可用实现在 3.1。

## 许可

MIT
